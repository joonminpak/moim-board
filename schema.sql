-- 모임 총무 보드 · Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 Run.
-- 구조: 화면 코드와 1:1로 맞춘 문서형 테이블(docs) + 이름/PIN 로그인용 비공개 테이블.

create extension if not exists pgcrypto;

-- 1) 문서 테이블: collection(members, notices, rounds, rsvp, expenses, sent, settle, log, settings) + id + data
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.docs replica identity full;

-- 2) 로그인 연결 (브라우저 익명 세션 → 멤버), PIN, 총무
create table if not exists public.bindings (
  auth_uid  uuid primary key,
  member_id text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.member_secrets (
  member_id text primary key,
  pin_hash  text
);
create table if not exists public.admins (
  member_id text primary key,
  created_at timestamptz not null default now()
);
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);

alter table public.docs enable row level security;
alter table public.bindings enable row level security;
alter table public.member_secrets enable row level security;
alter table public.admins enable row level security;
alter table public.app_secrets enable row level security;
-- bindings / member_secrets / admins / app_secrets 는 정책 없음 = 직접 읽기·쓰기 불가 (아래 함수로만)

-- 권한(테이블 접근). 실제 허용 여부는 아래 RLS 정책이 정함
grant select, insert, update, delete on public.docs to authenticated;
revoke all on public.docs from anon;
revoke all on public.bindings, public.member_secrets, public.admins, public.app_secrets from anon, authenticated;

-- 3) 도우미 함수
create or replace function public.my_member_id() returns text
language sql stable security definer set search_path = public as $$
  select member_id from public.bindings where auth_uid = auth.uid()
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins a join public.bindings b on b.member_id = a.member_id where b.auth_uid = auth.uid())
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.bindings b join public.docs d on d.collection = 'members' and d.id = b.member_id
    where b.auth_uid = auth.uid() and coalesce(d.data->>'leftAt','') = '')
$$;

-- 4) 읽기: 로그인(익명 포함)한 사람 누구나
drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated using (true);

-- 5) 쓰기 규칙 (예전 claude.ai 규칙과 같음)
--    총무: 전부 / 멤버: 모임(rounds)·공지(notices)·이력(log) 작성, 자기 문서(members·rsvp·sent) 수정
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated with check (
  public.is_admin()
  or (public.is_member() and collection in ('rounds','notices','log'))
  or (collection in ('members','rsvp','sent') and id = public.my_member_id())
);
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated using (
  public.is_admin()
  or (public.is_member() and collection in ('rounds','notices'))
  or (collection in ('members','rsvp','sent') and id = public.my_member_id())
) with check (
  public.is_admin()
  or (public.is_member() and collection in ('rounds','notices'))
  or (collection in ('members','rsvp','sent') and id = public.my_member_id())
);
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (
  public.is_admin()
  or (public.is_member() and collection in ('rounds','notices'))
);

-- 6) 내 정보
create or replace function public.whoami() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'member_id', public.my_member_id(),
    'is_admin', public.is_admin(),
    'has_admin_pin', exists(select 1 from public.app_secrets where key = 'admin_pin')
  )
$$;

-- 7) 가입: 이름 + PIN (4~8자리 숫자)
create or replace function public.join_group(p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public as $$
declare v_id text; v_name text := btrim(p_name);
begin
  if auth.uid() is null then raise exception '로그인 세션이 없어요'; end if;
  if v_name = '' or length(v_name) > 20 then raise exception '이름을 1~20자로 적어 주세요'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN은 숫자 4~8자리예요'; end if;
  if exists(select 1 from docs where collection='members' and data->>'name' = v_name and coalesce(data->>'leftAt','') = '') then
    raise exception '이미 있는 이름이에요. 기존 멤버면 [이미 가입했어요]로 로그인해 주세요';
  end if;
  v_id := replace(gen_random_uuid()::text, '-', '');
  insert into docs(collection, id, data) values ('members', v_id,
    json_build_object('name', v_name, 'joinedAt', to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'self', true, 'leftAt', null)::jsonb);
  insert into member_secrets(member_id, pin_hash) values (v_id, crypt(p_pin, gen_salt('bf')));
  insert into bindings(auth_uid, member_id) values (auth.uid(), v_id)
    on conflict (auth_uid) do update set member_id = excluded.member_id, created_at = now();
  return v_id;
end $$;

-- 8) 다른 기기에서 로그인: 이름 + PIN. 총무가 추가한 멤버(PIN 없음)는 처음 로그인할 때 PIN이 정해짐
create or replace function public.login_member(p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public as $$
declare v_id text; v_hash text;
begin
  if auth.uid() is null then raise exception '로그인 세션이 없어요'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN은 숫자 4~8자리예요'; end if;
  select d.id, s.pin_hash into v_id, v_hash from docs d left join member_secrets s on s.member_id = d.id
   where d.collection='members' and d.data->>'name' = btrim(p_name)
   order by (coalesce(d.data->>'leftAt','') = '') desc limit 1;
  if v_id is null then raise exception '그 이름의 멤버가 없어요'; end if;
  if v_hash is null then
    insert into member_secrets(member_id, pin_hash) values (v_id, crypt(p_pin, gen_salt('bf')))
      on conflict (member_id) do update set pin_hash = excluded.pin_hash;
  elsif v_hash <> crypt(p_pin, v_hash) then
    raise exception 'PIN이 맞지 않아요';
  end if;
  insert into bindings(auth_uid, member_id) values (auth.uid(), v_id)
    on conflict (auth_uid) do update set member_id = excluded.member_id, created_at = now();
  return v_id;
end $$;

create or replace function public.logout_member() returns void
language sql security definer set search_path = public as $$
  delete from public.bindings where auth_uid = auth.uid()
$$;

create or replace function public.change_pin(p_old text, p_new text) returns void
language plpgsql security definer set search_path = public as $$
declare v_id text := public.my_member_id(); v_hash text;
begin
  if v_id is null then raise exception '먼저 로그인해 주세요'; end if;
  if p_new !~ '^[0-9]{4,8}$' then raise exception 'PIN은 숫자 4~8자리예요'; end if;
  select pin_hash into v_hash from member_secrets where member_id = v_id;
  if v_hash is not null and v_hash <> crypt(p_old, v_hash) then raise exception '지금 PIN이 맞지 않아요'; end if;
  insert into member_secrets(member_id, pin_hash) values (v_id, crypt(p_new, gen_salt('bf')))
    on conflict (member_id) do update set pin_hash = excluded.pin_hash;
end $$;

-- 9) 총무 권한: 처음 한 번 총무 PIN을 정하고, 이후 그 PIN을 아는 멤버가 총무가 됨
create or replace function public.claim_admin(p_admin_pin text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id text := public.my_member_id(); v_hash text;
begin
  if v_id is null then raise exception '먼저 멤버로 가입해 주세요'; end if;
  if p_admin_pin !~ '^[0-9]{6,12}$' then raise exception '총무 PIN은 숫자 6~12자리예요'; end if;
  select value into v_hash from app_secrets where key = 'admin_pin';
  if v_hash is null then
    insert into app_secrets(key, value) values ('admin_pin', crypt(p_admin_pin, gen_salt('bf')));
  elsif v_hash <> crypt(p_admin_pin, v_hash) then
    raise exception '총무 PIN이 맞지 않아요';
  end if;
  insert into admins(member_id) values (v_id) on conflict do nothing;
  return true;
end $$;

create or replace function public.leave_admin() returns void
language sql security definer set search_path = public as $$
  delete from public.admins where member_id = public.my_member_id()
$$;

-- 총무가 다른 멤버의 PIN을 지워 주기 (PIN을 잊었을 때 → 다음 로그인 때 새로 정함)
create or replace function public.reset_member_pin(p_member text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '총무만 할 수 있어요'; end if;
  delete from member_secrets where member_id = p_member;
end $$;

revoke all on function public.join_group(text,text), public.login_member(text,text), public.logout_member(),
  public.change_pin(text,text), public.claim_admin(text), public.leave_admin(), public.reset_member_pin(text), public.whoami() from public, anon;
grant execute on function public.join_group(text,text), public.login_member(text,text), public.logout_member(),
  public.change_pin(text,text), public.claim_admin(text), public.leave_admin(), public.reset_member_pin(text), public.whoami() to authenticated;

grant execute on function public.my_member_id(), public.is_admin(), public.is_member() to authenticated;

-- 10) 실시간 반영
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 11) 영수증 저장소 (공개 읽기, 총무만 올리기·지우기)
insert into storage.buckets (id, name, public) values ('receipts', 'receipts', true)
  on conflict (id) do update set public = true;
drop policy if exists receipts_read on storage.objects;
create policy receipts_read on storage.objects for select using (bucket_id = 'receipts');
drop policy if exists receipts_write on storage.objects;
create policy receipts_write on storage.objects for insert to authenticated with check (bucket_id = 'receipts' and public.is_admin());
drop policy if exists receipts_delete on storage.objects;
create policy receipts_delete on storage.objects for delete to authenticated using (bucket_id = 'receipts' and public.is_admin());
