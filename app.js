/* ============================================================================
   모임 총무 보드 — 회차별 정산 (모바일 우선)
   운영 방식: 월 회비 없이, 모임 회차마다 모여 일차별로(1일차 숙소·1차·2차, 2일차 점심…)
   쓴 돈을 결제한 사람과 함께한 사람끼리 나눈다.

   나중에 Vite + React + Supabase로 옮길 때 아래 세 덩어리를 그대로 나눠 가져간다.
   1) Store  (데이터 저장소 어댑터)  → src/store/artifactStore.js / supabaseStore.js
   2) Ledger (돈·상태 계산, 순수 함수) → src/lib/ledger.js (수정 없이 이동)
   3) UI     (화면)                   → 탭별 React 컴포넌트

   데이터 모델 (컬렉션 = 테이블, 필드 camelCase ↔ 컬럼 snake_case 1:1)
   ─ settings  단일 행 id="main": groupName
   ─ members   id, name, joinedAt, self, manual, leftAt(null=활동)   + 전환 시 pinHash
   ─ notices   id, title, body, pinned, createdAt, createdBy          (모든 멤버 작성)
   ─ rounds    id, no(자동 번호), title, startDate, endDate, rsvpDue, memo, rates{통화:원},
               createdAt, createdBy                                    (모든 멤버 작성)
   ─ rsvps     지금: 문서 id=memberId, ev{roundId:{s:"yes"|"no"|"unknown", reason, until, at, by}}
               전환 시: rsvps(round_id, member_id, status, reason, until, updated_at, updated_by)
   ─ expenses  id, roundId, date, seq, title, amount, currency, rate, krw, payer, parts[],
               receipts[{id,type,name}], memo, createdAt, updatedAt     (총무만 작성)
   ─ marks     지금: marksSelf(id=memberId){sent{key:at}, got{key:at}} + marksRound(id=roundId){done{key:at}}
               전환 시: transfer_marks(round_id, from_id, to_id, amount, sent_at, received_at, confirmed_at)
   ─ log       id, at, by, action, detail
   ─ 영수증 파일 → 지금: 아티팩트 assets / 전환 시: Storage 버킷 "receipts"
   권한: Supabase RLS (schema.sql). 이름+PIN 로그인, 총무는 총무 PIN으로.
   ========================================================================== */

/* 1) Store 는 store.js (Supabase) 에 있다 */

/* ============================== 2) Ledger ================================= */
const Ledger = {
  diffDays(a, b){ return Math.round((new Date(b+"T00:00") - new Date(a+"T00:00")) / 86400000); },
  addDays(s, n){ const d=new Date(s+"T00:00"); d.setDate(d.getDate()+n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; },
  daysOf(round){
    if(!round?.startDate) return [];
    const end = round.endDate && round.endDate>=round.startDate ? round.endDate : round.startDate;
    const n = Math.min(Ledger.diffDays(round.startDate, end), 13) + 1;
    return Array.from({length:n}, (_,i)=>({n:i+1, date:Ledger.addDays(round.startDate, i)}));
  },
  endOf(round){ const d=Ledger.daysOf(round); return d.length ? d[d.length-1].date : round?.startDate; },
  dayNo(round, date){ if(!round?.startDate || !date) return null; const n=Ledger.diffDays(round.startDate, date)+1; return n>=1 ? n : null; },
  nightsLabel(round){ const d=Ledger.daysOf(round).length; return d<=1 ? "당일" : `${d-1}박 ${d}일`; },
  toKrw(amount, currency, rate){ return Math.round((+amount||0) * (currency==="KRW" ? 1 : (+rate||0))); },
  total(expenses, roundId){ return expenses.filter(e=>e.roundId===roundId).reduce((a,e)=>a+(+e.krw||0),0); },
  settle(expenses, roundId){
    const paid={}, owe={};
    expenses.filter(e=>e.roundId===roundId && (e.parts||[]).length).forEach(e=>{
      const k=+e.krw||0; paid[e.payer]=(paid[e.payer]||0)+k;
      const share=k/e.parts.length; e.parts.forEach(id=>owe[id]=(owe[id]||0)+share);
    });
    const ids=[...new Set([...Object.keys(paid), ...Object.keys(owe)])];
    const rows=ids.map(id=>({id, paid:paid[id]||0, owe:owe[id]||0, bal:Math.round((paid[id]||0)-(owe[id]||0))})).sort((a,b)=>b.bal-a.bal);
    const cred=rows.filter(r=>r.bal>0).map(r=>({id:r.id,v:r.bal})), debt=rows.filter(r=>r.bal<0).map(r=>({id:r.id,v:-r.bal}));
    const transfers=[]; let i=0, j=0;
    while(i<debt.length && j<cred.length){
      const v=Math.min(debt[i].v, cred[j].v), amt=Math.round(v);
      if(amt>=1) transfers.push({from:debt[i].id, to:cred[j].id, amt, key:`${debt[i].id}_${cred[j].id}_${amt}`});
      debt[i].v-=v; cred[j].v-=v; if(debt[i].v<1) i++; if(cred[j].v<1) j++;
    }
    return {rows, transfers};
  },
  sharesByDay(expenses, roundId){
    const out={};
    expenses.filter(e=>e.roundId===roundId && (e.parts||[]).length).forEach(e=>{
      const share=(+e.krw||0)/e.parts.length;
      e.parts.forEach(id=>{ out[id]=out[id]||{}; out[id][e.date]=(out[id][e.date]||0)+share; });
    });
    return out;
  },
  transferStatus(marksSelf, marksRound, roundId, t){
    const doneAt = marksRound[roundId]?.done?.[t.key] || marksSelf[t.to]?.got?.[t.key] || null;
    return {done:!!doneAt, doneAt, sent:!!marksSelf[t.from]?.sent?.[t.key]};
  },
  /** settling=true 이면 '회차 정산'에, key=done 이면 '정산 이력'에 보인다 */
  roundStatus(round, today, hasExp, openCount){
    const end=Ledger.endOf(round);
    if(round.startDate>today) return hasExp ? {key:"soon", label:"예정 · 미리 낸 돈 있음", settling:true} : {key:"soon", label:"예정"};
    if(end>=today) return {key:"now", label:"진행 중", settling:true};
    if(!hasExp) return {key:"empty", label:"지출 기록 없음"};
    return openCount ? {key:"open", label:`정산 중 · 미정산 ${openCount}건`, settling:true} : {key:"done", label:"정산 완료"};
  },
  /** 참석 응답 정리. 예전 문자열 값("yes"/"no"/"maybe")도 읽는다 */
  normResp(v){
    if(!v) return null;
    if(typeof v==="string") return {s: v==="maybe" ? "unknown" : v};
    return v.s ? v : null;
  }
};

/* ================================ 3) UI =================================== */
const Store = createSupabaseStore(window.APP_CONFIG);
const $ = s => document.querySelector(s);
const S = {settings:{}, members:{}, notices:[], rounds:[], rsvps:{}, expenses:[], marksSelf:{}, marksRound:{}, log:[]};
const ME = {id:null, admin:false};
const UI = {tab:"home", round:null, rFilter:"all", edit:null, editRound:null, parts:new Set(), keep:[], partsTouched:false,
  draft:{}, doneOpen:new Set(), focusRound:null};
const extraNames = {};

/* ---------- utils ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const won = n => Math.round(n||0).toLocaleString("ko-KR") + "원";
const today = () => { const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
const nowISO = () => new Date().toISOString();
const fmtDT = iso => { if(!iso) return ""; const d=new Date(iso); return `${d.getMonth()+1}.${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
const wd = s => "일월화수목금토"[new Date(s+"T00:00").getDay()];
const md = s => s ? `${+s.slice(5,7)}.${+s.slice(8,10)}(${wd(s)})` : "";
const nameOf = id => S.members[id]?.name || extraNames[id] || "(알 수 없음)";
const byJoined = (a,b)=>(a.joinedAt||"").localeCompare(b.joinedAt||"");
const activeIds = () => Object.values(S.members).filter(m=>!m.leftAt).sort(byJoined).map(m=>m.id);
const leftIds = () => Object.values(S.members).filter(m=>m.leftAt).sort(byJoined).map(m=>m.id);
const roundById = id => S.rounds.find(r=>r.id===id);
const dayLabel = (r, date) => { const n=Ledger.dayNo(r, date); return n ? `${n}일차` : md(date); };
const whenOf = r => { const e=Ledger.endOf(r); return `${md(r.startDate)}${e&&e!==r.startDate?` ~ ${md(e)}`:""} · ${Ledger.nightsLabel(r)}`; };
const respOf = (mid, rid) => Ledger.normResp(S.rsvps[mid]?.[rid]);
const attendees = r => activeIds().filter(id=>respOf(id, r.id)?.s==="yes");
const isMember = () => !!(ME.id && S.members[ME.id] && !S.members[ME.id].leftAt);
const canPost = () => ME.admin || isMember();
const canEditRound = r => ME.admin || (r.createdBy && r.createdBy===ME.id);
const isPastRound = r => Ledger.endOf(r) < today();
let toastT;
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true,3200); }
function errMsg(e){ if(Store.isPermissionError(e)) return "권한이 없어요. 총무에게 '참여' 이상 권한을 요청하세요."; return "저장하지 못했어요: " + (e?.message||e?.code||"알 수 없는 오류"); }
async function run(fn, okMsg){ try{ await fn(); if(okMsg) toast(okMsg); return true; }catch(e){ console.error(e); toast(errMsg(e)); return false; } }
async function log(action, detail){ try{ await Store.insert("log", {at:nowISO(), by:ME.id, action, detail}); }catch(e){ console.warn(e); } }
function arm(btn, fn, label="한 번 더 누르면 삭제"){
  if(btn.classList.contains("armed")){ fn(); return; }
  btn.classList.add("armed"); const old=btn.textContent; btn.textContent=label;
  setTimeout(()=>{ btn.classList.remove("armed"); btn.textContent=old; }, 3000);
}

/* ---------- boot ---------- */
(async function boot(){
  const r = await Store.init();
  if(!r.ok){
    gate("장부에 연결하지 못했어요. 잠시 후 새로고침해 주세요. ("+(r.message||"연결 오류")+")");
    return;
  }
  ME.id = r.me.id; ME.admin = r.me.canManage;
  $("#gate").hidden = true; $("#app").hidden = false;
  document.querySelectorAll("[data-admin]").forEach(el => el.hidden = !ME.admin);
  bindForms(); route(); subscribe();
})();
function gate(msg){ $("#gate").hidden=false; $("#gate").textContent=msg; $("#app").hidden=true; $("#role").textContent="—"; }

function subscribe(){
  const onErr = t => e => toast(`불러오기 실패(${t}): ${e.message||e.code}`);
  const w = (t, fn) => Store.watch(t, rows => { fn(rows); sched(); }, onErr(t));
  const asMap = rows => Object.fromEntries(rows.map(r=>[r.id, r]));
  w("members", rows => S.members = asMap(rows));
  w("notices", rows => S.notices = rows);
  w("rounds", rows => S.rounds = rows.sort((a,b)=>(b.startDate||"").localeCompare(a.startDate||"") || (b.no||0)-(a.no||0)));
  w("rsvps", rows => S.rsvps = Object.fromEntries(rows.map(r=>[r.id, r.ev||{}])));
  w("expenses", rows => S.expenses = rows);
  w("marksSelf", rows => S.marksSelf = asMap(rows));
  w("marksRound", rows => S.marksRound = asMap(rows));
  w("log", rows => S.log = rows);
  Store.watchOne("settings", "main", row => { S.settings = row || {}; if(document.activeElement?.id!=="sName") $("#sName").value=S.settings.groupName||""; sched(); }, onErr("settings"));
}
let raf=0; function sched(){ if(!raf) raf=requestAnimationFrame(()=>{ raf=0; render(); }); }

/* ---------- routing ---------- */
const TABS=["home","attend","settle","done","receipts","members","history"];
function route(){
  const h=location.hash.slice(1); UI.tab = TABS.includes(h)?h:"home";
  TABS.forEach(t => { $("#t-"+t).hidden = t!==UI.tab; const a=document.querySelector(`[data-t="${t}"]`); if(t===UI.tab){ a.setAttribute("aria-current","page"); a.scrollIntoView({block:"nearest", inline:"center"}); } else a.removeAttribute("aria-current"); });
  if(UI.focusRound){ const el=document.getElementById(`${UI.tab==="attend"?"att":"rc"}-${UI.focusRound}`); UI.focusRound=null; if(el) setTimeout(()=>el.scrollIntoView({behavior:"smooth", block:"start"}), 60); }
  else window.scrollTo({top:0});
}
window.addEventListener("hashchange", route);
function go(tab, roundId){ if(roundId) UI.focusRound=roundId; if(location.hash==="#"+tab) route(); else location.hash="#"+tab; }

/* ---------- derived ---------- */
const settleOf = rid => Ledger.settle(S.expenses, rid);
const statusOf = (rid, t) => Ledger.transferStatus(S.marksSelf, S.marksRound, rid, t);
function statusOfRound(r){
  const hasExp=S.expenses.some(e=>e.roundId===r.id);
  const open=hasExp ? settleOf(r.id).transfers.filter(t=>!statusOf(r.id,t).done).length : 0;
  return Ledger.roundStatus(r, today(), hasExp, open);
}
const settlingRounds = () => S.rounds.filter(r=>statusOfRound(r).settling);
const doneRounds = () => S.rounds.filter(r=>statusOfRound(r).key==="done");
function openTransfers(){ let n=0; settlingRounds().forEach(r=>settleOf(r.id).transfers.forEach(t=>{ if(!statusOf(r.id,t).done) n++; })); return n; }
function curRound(){
  const list=settlingRounds(), extra=ME.admin ? S.rounds.filter(r=>!list.includes(r) && statusOfRound(r).key!=="done") : [];
  const ok=[...list, ...extra];
  if(!ok.find(r=>r.id===UI.round)) UI.round = (list.find(r=>statusOfRound(r).key==="now") || list[0] || extra[0])?.id || null;
  return roundById(UI.round) || null;
}

/* ---------- render ---------- */
function render(){
  $("#gname").textContent = S.settings.groupName || "모임 총무 보드";
  const mine = ME.id && S.members[ME.id];
  $("#role").textContent = ME.admin ? "총무" : mine && !mine.leftAt ? "멤버" : mine ? "탈퇴 처리됨" : "미등록";
  $("#role").className = "chip " + (ME.admin ? "acc" : mine && !mine.leftAt ? "good" : "warn");
  document.querySelectorAll("[data-poster]").forEach(el => el.hidden = !canPost());
  renderReg(); renderSummary(); renderTabsBadges();
  renderHome(); renderAttend(); renderSettle(); renderDone(); renderReceipts(); renderMembers(); renderLog(); renderAccount();
  fillMemberControls();
}

function renderReg(){
  const el=$("#regbar"), mine = ME.id && S.members[ME.id];
  if(mine && !mine.leftAt){ el.innerHTML=""; el.dataset.mode=""; return; }
  if(mine && mine.leftAt){
    if(el.dataset.mode==="left") return; el.dataset.mode="left";
    el.innerHTML = `<div class="banner"><h2>${esc(mine.name)} 님은 탈퇴 처리된 상태예요</h2><p class="small" style="margin:0">지난 기록은 그대로 남아 있어요.</p><button class="pri block" type="button" id="rejoinBtn">다시 참여</button></div>`;
    $("#rejoinBtn").onclick = () => run(()=>Store.put("members", ME.id, {...mine, leftAt:null}), "다시 참여했어요");
    return;
  }
  if(el.dataset.mode==="reg") return; el.dataset.mode="reg";
  let mode="join";
  el.innerHTML = `<div class="banner">
    <div class="seg" style="grid-template-columns:1fr 1fr" role="tablist"><button type="button" class="on" data-regmode="join">처음이에요 · 가입</button><button type="button" data-regmode="login">이미 가입했어요</button></div>
    <h2 id="regTitle">모임에 가입해 주세요</h2>
    <p class="small" style="margin:0" id="regMsg">이름과 PIN(숫자 4~8자리)을 정하면 바로 멤버가 돼요. 다른 기기에서는 같은 이름과 PIN으로 들어와요.</p>
    <form id="regForm" class="stack">
      <input id="regName" placeholder="이름 (실명)" required maxlength="20" autocomplete="name">
      <input id="regPin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" placeholder="PIN 숫자 4~8자리" required maxlength="8" autocomplete="current-password">
      <button class="pri block" type="submit" id="regBtn">가입하기</button>
    </form></div>`;
  const style = () => { el.querySelectorAll("[data-regmode]").forEach(b=>b.classList.toggle("on", b.dataset.regmode===mode));
    $("#regTitle").textContent = mode==="join" ? "모임에 가입해 주세요" : "다시 들어오기";
    $("#regMsg").textContent = mode==="join" ? "이름과 PIN(숫자 4~8자리)을 정하면 바로 멤버가 돼요. 다른 기기에서는 같은 이름과 PIN으로 들어와요." : "가입할 때 쓴 이름과 PIN을 넣어 주세요. 총무가 대신 추가한 분은 처음 넣는 PIN이 내 PIN이 돼요.";
    $("#regBtn").textContent = mode==="join" ? "가입하기" : "들어가기"; };
  el.querySelectorAll("[data-regmode]").forEach(b=>b.onclick=()=>{ mode=b.dataset.regmode; style(); });
  $("#regForm").onsubmit = async ev => { ev.preventDefault();
    const name=$("#regName").value.trim(), pin=$("#regPin").value.trim();
    if(!/^[0-9]{4,8}$/.test(pin)){ toast("PIN은 숫자 4~8자리예요"); return; }
    const btn=$("#regBtn"); btn.disabled=true;
    try{ mode==="join" ? await Store.join(name, pin) : await Store.login(name, pin); toast(mode==="join"?`${name} 님, 가입됐어요`:`${name} 님, 반가워요`); setTimeout(()=>location.reload(), 600); }
    catch(e){ toast(e?.message||"다시 시도해 주세요"); btn.disabled=false; }
  };
}
function renderSummary(){
  const t=today();
  const next=[...S.rounds].filter(r=>Ledger.endOf(r)>=t).sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""))[0];
  const last=S.rounds.filter(r=>r.startDate<=t).sort((a,b)=>(b.startDate||"").localeCompare(a.startDate||""))[0];
  const lastN=last ? S.expenses.filter(e=>e.roundId===last.id).length : 0;
  const ot=openTransfers(), sc=settlingRounds().filter(r=>S.expenses.some(e=>e.roundId===r.id)).length;
  $("#summary").innerHTML = `
    <button type="button" data-goto="attend" data-rid="${next?.id||""}"><span class="k">예정모임</span><span class="v">${next?esc(next.title):"없음"}</span><span class="s">${next?`${md(next.startDate)} · 참석 ${attendees(next).length}명`:"등록된 모임 없음"}</span></button>
    <button type="button" data-goto="${last && statusOfRound(last).key==="done"?"done":"settle"}" data-rid="${last?.id||""}"><span class="k">최근 회차 지출</span><span class="v num">총 ${lastN}건</span><span class="s">${last?`${esc(last.title)} · ${won(Ledger.total(S.expenses,last.id))}`:"아직 회차가 없어요"}</span></button>
    <button type="button" data-goto="settle"><span class="k">미정산</span><span class="v num ${ot?"neg":""}">${ot}건</span><span class="s">${ot?`정산 중 모임 ${sc}개`:"모두 정산 완료"}</span></button>`;
}

function renderTabsBadges(){
  const pending = isMember() ? S.rounds.filter(r=>!isPastRound(r) && !respOf(ME.id, r.id)).length : 0;
  const set = (t, label, n, cls="warn") => { const a=document.querySelector(`[data-t="${t}"]`); a.innerHTML = esc(label) + (n?` <span class="chip ${cls}">${n}</span>`:""); };
  set("attend", "참석 여부", pending);
  set("settle", "회차 정산", settlingRounds().length, "acc");
  set("done", "정산 이력", doneRounds().length, "");
}

/* --- 참석 명단 (홈 카드·참석 탭 공용) --- */
function rosterHtml(r, {detail=false}={}){
  const g={yes:[], no:[], unknown:[], none:[]};
  activeIds().forEach(id=>{ const v=respOf(id, r.id); g[v?.s||"none"]?.push({id, v}); });
  const t=today();
  const nm = (x, cls) => {
    let extra="";
    if(cls==="unknown" && x.v?.until){ const late=x.v.until<t; extra=` <small>${late?"기한 지남 ":"~"}${md(x.v.until)}</small>`; }
    if(detail && cls==="no" && x.v?.reason) extra=` <small>· ${esc(x.v.reason)}</small>`;
    return `<span class="name ${cls} ${x.id===ME.id?"me":""}">${esc(nameOf(x.id))}${extra}</span>`;
  };
  const grp = (k, label) => `<div class="grp"><span class="lbl ${k}">${label} ${g[k].length}</span><div class="names">${g[k].length?g[k].map(x=>nm(x,k)).join(""):'<span class="small muted" style="padding-top:4px">—</span>'}</div></div>`;
  return `<div class="roster">${grp("yes","참석")}${grp("no","불참")}${grp("unknown","모름")}${g.none.length?grp("none","미응답"):""}</div>`;
}

function roundCard(r){
  const st=statusOfRound(r);
  const chip={soon:"",now:"acc",empty:"",open:"warn",done:"good"}[st.key];
  const n=S.expenses.filter(e=>e.roundId===r.id).length;
  const mine=isMember()?respOf(ME.id, r.id):null;
  const past=isPastRound(r);
  return `<article class="round ${st.key==="now"?"now":""}" id="rc-${r.id}">
    <div class="spread"><span class="chip ink num">${r.no?r.no+"회차":"모임"}</span><span class="chip ${chip}">${esc(st.label)}</span></div>
    <div class="ttl">${esc(r.title)}</div>
    <div class="when num">${whenOf(r)}</div>
    ${r.memo?`<div class="small muted pre">${esc(r.memo)}</div>`:""}
    ${r.rsvpDue&&!past?`<div class="small ${r.rsvpDue<today()?"neg":""}">참석 여부 마감 ${md(r.rsvpDue)}</div>`:""}
    ${rosterHtml(r)}
    ${n?`<div class="small num muted">지출 ${n}건 · ${won(Ledger.total(S.expenses,r.id))}</div>`:""}
    <div class="grid2">
      ${!past&&isMember()?`<button type="button" class="${mine?"":"pri"}" data-goto="attend" data-rid="${r.id}">${mine?"내 응답 바꾸기":"참석 여부 응답"}</button>`:`<button type="button" data-goto="attend" data-rid="${r.id}">참석 명단</button>`}
      ${st.settling?`<button type="button" data-goto="settle" data-rid="${r.id}">정산 보기</button>`:st.key==="done"?`<button type="button" data-goto="done" data-rid="${r.id}">정산 이력</button>`:`<span></span>`}
    </div>
    ${canEditRound(r)?`<div class="row" style="justify-content:flex-end"><button class="ghost sm" data-editround="${r.id}">수정</button><button class="ghost sm danger" data-delround="${r.id}">삭제</button></div>`:""}
  </article>`;
}

function renderHome(){
  const ns=[...S.notices].sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0) || (b.createdAt||"").localeCompare(a.createdAt||""));
  $("#noticeCount").textContent = ns.length+"개";
  $("#noticeList").innerHTML = ns.length ? ns.map(n=>{ const mineN = ME.admin || (n.createdBy && n.createdBy===ME.id);
    return `<div class="notice ${n.pinned?"pinned":""}">
      <div class="row">${n.pinned?'<span class="chip acc">고정</span>':""}<h3 style="overflow-wrap:anywhere">${esc(n.title)}</h3></div>
      ${n.body?`<div class="pre">${esc(n.body)}</div>`:""}
      <div class="spread"><span class="xs muted">${fmtDT(n.createdAt)}${n.createdBy?` · ${esc(nameOf(n.createdBy))}`:""}</span>
      ${mineN?`<span class="row" style="gap:0"><button class="ghost sm" data-pin="${n.id}">${n.pinned?"고정 해제":"고정"}</button><button class="ghost sm danger" data-delnotice="${n.id}">삭제</button></span>`:""}</div></div>`; }).join("")
    : `<div class="empty">아직 공지가 없어요.${canPost()?" 아래 '공지 올리기'에서 올릴 수 있어요.":""}</div>`;

  const t=today();
  const up=[...S.rounds].filter(r=>!isPastRound(r)).sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));
  const past=S.rounds.filter(isPastRound);
  const openPast=past.filter(r=>statusOfRound(r).settling), rest=past.filter(r=>!statusOfRound(r).settling);
  const top=[...up, ...openPast];
  $("#roundList").innerHTML = top.length ? top.map(roundCard).join("")
    : `<div class="empty">${S.rounds.length?"예정된 모임이 없어요.":"아직 등록된 모임이 없어요."}${canPost()?" 아래 '새 모임 등록'에서 만들 수 있어요.":""}</div>`;
  $("#pastWrap").hidden = !rest.length; $("#pastSum").textContent=`지난 모임 ${rest.length}개`;
  $("#pastList").innerHTML = rest.map(roundCard).join("");
}

/* --- 참석 여부 탭 --- */
let attendDirty=false;
function renderAttend(){
  const box=$("#attendList");
  if(box.contains(document.activeElement) && document.activeElement.matches("input,textarea")){ attendDirty=true; return; }
  attendDirty=false;
  const up=[...S.rounds].filter(r=>!isPastRound(r)).sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));
  box.innerHTML = up.length ? up.map(attendCard).join("") : `<div class="empty">응답할 예정 모임이 없어요.</div>`;
  const past=S.rounds.filter(isPastRound).slice(0,12);
  $("#attendPastWrap").hidden=!past.length; $("#attendPastSum").textContent=`지난 모임 참석 기록 ${past.length}개`;
  $("#attendPast").innerHTML = past.map(r=>`<article class="round" id="att-${r.id}"><div class="ttl" style="font-size:18px">${esc(r.title)}</div><div class="small num muted">${whenOf(r)}</div>${rosterHtml(r,{detail:true})}</article>`).join("");
}
function attendCard(r){
  const canAnswer = isMember() || ME.admin;
  const ids=activeIds();
  const d = UI.draft[r.id] || {};
  const target = d.target && ids.includes(d.target) ? d.target : (isMember() ? ME.id : ids[0]);
  const cur = respOf(target, r.id) || {};
  const s = d.s ?? cur.s ?? "";
  const reason = d.reason ?? cur.reason ?? "", until = d.until ?? cur.until ?? "";
  const g={yes:[],no:[],unknown:[],none:[]}; ids.forEach(id=>{ const v=respOf(id,r.id); g[v?.s||"none"].push({id,v}); });
  const t=today();
  const respRows = [
    ...g.no.map(x=>`<div class="r"><strong class="neg">${esc(nameOf(x.id))}</strong><span>${x.v.reason?esc(x.v.reason):'<span class="muted">사유 없음</span>'}</span></div>`),
    ...g.unknown.map(x=>`<div class="r"><strong style="color:var(--warn)">${esc(nameOf(x.id))}</strong><span>${x.v.until?`${md(x.v.until)}까지 알려줄게요`:"언제 알려줄지 미정"}${x.v.until&&x.v.until<t?' <span class="chip bad">기한 지남</span>':""}${x.v.reason?` · ${esc(x.v.reason)}`:""}</span></div>`)
  ].join("");
  return `<article class="round ${statusOfRound(r).key==="now"?"now":""}" id="att-${r.id}" data-round="${r.id}">
    <div class="spread"><span class="chip ink num">${r.no?r.no+"회차":"모임"}</span>${r.rsvpDue?`<span class="chip ${r.rsvpDue<t?"bad":"warn"}">마감 ${md(r.rsvpDue)}</span>`:""}</div>
    <div class="ttl">${esc(r.title)}</div>
    <div class="when num">${whenOf(r)}</div>
    ${rosterHtml(r)}
    ${respRows?`<div class="resp"><div class="small muted" style="font-weight:700">불참 사유 · 모름 답변</div>${respRows}</div>`:""}
    ${canAnswer && ids.length ? `<form class="stack" data-rsvpform="${r.id}" style="border-top:1px solid var(--line);padding-top:12px">
      ${ME.admin?`<label class="f">누구의 응답인가요<select data-k="target">${ids.map(id=>`<option value="${id}" ${id===target?"selected":""}>${esc(nameOf(id))}${id===ME.id?" (나)":""}${respOf(id,r.id)?"":" · 미응답"}</option>`).join("")}</select></label>`
        :`<div class="small" style="font-weight:700">내 응답${cur.at?` <span class="muted" style="font-weight:400">· ${fmtDT(cur.at)} 저장</span>`:""}</div>`}
      <div class="seg" role="group" aria-label="참석 여부">${[["yes","참석"],["no","불참"],["unknown","모름"]].map(([v,l])=>`<button type="button" class="${s===v?"on":""}" data-v="${v}" data-pick="${r.id}">${l}</button>`).join("")}</div>
      ${s==="no"?`<label class="f">불참 사유<input data-k="reason" value="${esc(reason)}" placeholder="예: 가족 행사가 있어요" maxlength="80" required></label>`:""}
      ${s==="unknown"?`<label class="f">언제까지 알려줄게요<input data-k="until" type="date" value="${esc(until)}" required ${r.startDate?`max="${r.startDate}"`:""}></label><label class="f">메모 (선택)<input data-k="reason" value="${esc(reason)}" placeholder="예: 출장 일정 확인 중" maxlength="80"></label>`:""}
      ${s?`<button class="pri block" type="submit">응답 저장</button>`:`<p class="small muted" style="margin:0">위에서 하나를 골라 주세요.</p>`}
    </form>` : !ME.id ? "" : `<p class="small muted" style="margin:0">멤버로 등록하면 응답할 수 있어요.</p>`}
  </article>`;
}
async function saveRsvp(rid, form){
  const d=UI.draft[rid]||{}, ids=activeIds();
  const target = d.target && ids.includes(d.target) ? d.target : (isMember()?ME.id:ids[0]);
  const cur=respOf(target, rid)||{};
  const s=d.s ?? cur.s; if(!s){ toast("참석·불참·모름 중 하나를 골라 주세요"); return; }
  const reason=(form.querySelector('[data-k="reason"]')?.value||"").trim();
  const until=form.querySelector('[data-k="until"]')?.value||"";
  if(s==="no" && !reason){ toast("불참 사유를 적어 주세요"); return; }
  if(s==="unknown" && !until){ toast("언제까지 알려줄지 날짜를 골라 주세요"); return; }
  const val={s, reason: s==="yes"?"":reason, until: s==="unknown"?until:"", at:nowISO(), by:ME.id};
  const r=roundById(rid);
  const ok=await run(async()=>{
    await Store.put("rsvps", target, {ev:{...(S.rsvps[target]||{}), [rid]:val}});
    if(target!==ME.id) await log("참석 대신 입력", `${r?.title}: ${nameOf(target)} ${({yes:"참석",no:"불참",unknown:"모름"})[s]}`);
  }, target===ME.id?"응답을 저장했어요":`${nameOf(target)} 님 응답을 저장했어요`);
  if(ok){ delete UI.draft[rid]; document.activeElement?.blur?.(); attendDirty=false; sched(); }
}

/* --- 송금 링크 · 카톡 문구 --- */
const tossUrl = (id, amt) => `https://toss.me/${encodeURIComponent(id)}${amt?"/"+amt:""}`;
const kakaoOk = u => /^https:\/\/qr\.kakaopay\.com\/[A-Za-z0-9_-]+\/?$/.test(u||"");
function payKinds(m){ const k=[]; if(kakaoOk(m?.kakaoLink)) k.push("카카오페이"); if(m?.tossId) k.push("토스"); if(m?.account) k.push("계좌"); return k; }
function payHtml(t){
  const m=S.members[t.to]||{}, b=[];
  if(kakaoOk(m.kakaoLink)) b.push(`<a class="payb kakao" href="${esc(m.kakaoLink)}" target="_blank" rel="noopener" data-copyamt="${t.amt}">카카오페이</a>`);
  if(m.tossId) b.push(`<a class="payb toss" href="${esc(tossUrl(m.tossId, t.amt))}" target="_blank" rel="noopener">토스</a>`);
  if(m.account) b.push(`<button type="button" data-copyacct="${t.to}" data-amt="${t.amt}">계좌 복사</button>`);
  if(!b.length) return `<div class="payinfo">${esc(nameOf(t.to))} 님이 아직 송금 받을 곳을 넣지 않았어요. (멤버 탭 → 내 송금 받을 곳)</div>`;
  return `<div class="paybtns">${b.join("")}</div>${m.account?`<div class="payinfo">${esc(m.bank||"")} ${esc(m.account)} (${esc(nameOf(t.to))})</div>`:""}`;
}
function copyText(text, okMsg){
  const fallback = () => { $("#copyText").value=text; $("#copyBox").hidden=false; setTimeout(()=>{ $("#copyText").focus(); $("#copyText").select(); },50); };
  try{ if(!navigator.clipboard?.writeText) return fallback(); navigator.clipboard.writeText(text).then(()=>toast(okMsg), fallback); }catch{ fallback(); }
}
function kakaoText(r){
  const ex=S.expenses.filter(e=>e.roundId===r.id).sort((a,b)=>(a.date||"").localeCompare(b.date||"")||(a.createdAt||"").localeCompare(b.createdAt||""));
  const {rows, transfers}=settleOf(r.id), total=Ledger.total(S.expenses, r.id);
  const L=[];
  L.push(`[${S.settings.groupName?S.settings.groupName+" · ":""}${r.title} 정산]`);
  L.push(whenOf(r));
  L.push(`총 ${won(total)} · ${rows.length}명 · 1인 평균 ${rows.length?won(total/rows.length):"-"}`);
  L.push("");
  L.push("■ 보낼 돈");
  if(!transfers.length) L.push("주고받을 돈이 없어요.");
  transfers.forEach(t=>{ const st=statusOf(r.id,t), m=S.members[t.to]||{};
    L.push(`${st.done?"✅":"▶"} ${nameOf(t.from)} → ${nameOf(t.to)} ${won(t.amt)}${st.done?" (완료)":""}`);
    if(!st.done){
      if(kakaoOk(m.kakaoLink)) L.push(`   카카오페이 ${m.kakaoLink}`);
      if(m.tossId) L.push(`   토스 ${tossUrl(m.tossId, t.amt)}`);
      if(m.account) L.push(`   ${m.bank||"계좌"} ${m.account} (${nameOf(t.to)})`);
    }
  });
  L.push("");
  L.push("■ 사람별");
  rows.forEach(x=>L.push(`${nameOf(x.id)}: 낸 돈 ${won(x.paid)} / 몫 ${won(x.owe)} / ${x.bal>0?"받을 돈 "+won(x.bal):x.bal<0?"보낼 돈 "+won(-x.bal):"정산 끝"}`));
  L.push("");
  L.push("■ 지출 내역");
  ex.forEach(e=>L.push(`${dayLabel(r,e.date)} ${e.seq||""} ${e.title} ${won(e.krw)} (${nameOf(e.payer)} 결제, ${(e.parts||[]).length}명)`));
  L.push("");
  L.push("보낸 뒤 장부에서 '보냈어요'를 눌러 주세요. 영수증은 장부 '영수증' 탭에 있어요.");
  return L.join("\n");
}

/* --- 정산 화면 (회차 정산·정산 이력 공용) --- */
function settlementHtml(r, {readonly=false}={}){
  const ex=S.expenses.filter(e=>e.roundId===r.id).sort((a,b)=>(a.date||"").localeCompare(b.date||"")||(a.createdAt||"").localeCompare(b.createdAt||""));
  const total=Ledger.total(S.expenses, r.id);
  const {rows, transfers} = settleOf(r.id);
  const days=[...new Set([...Ledger.daysOf(r).map(d=>d.date), ...ex.map(e=>e.date)])].sort();
  const shares=Ledger.sharesByDay(S.expenses, r.id);
  const people=rows.length;
  const balChip = b => `<span class="chip ${b>0?"good":b<0?"bad":""}">${b>0?"받을 돈":b<0?"보낼 돈":"끝"}</span>`;
  const balTxt = b => `${b>0?"+":""}${won(b)}`;
  const cards = rows.map(x=>`<div class="pcard"><span class="nm">${esc(nameOf(x.id))}${x.id===ME.id?' <span class="chip acc">나</span>':""}</span>
      <span class="bal num ${x.bal>0?"pos":x.bal<0?"neg":""}">${balTxt(x.bal)}</span>
      <span class="meta num">낸 돈 ${won(x.paid)} · 몫 ${won(x.owe)} ${balChip(x.bal)}</span>
      ${days.length>1?`<span class="meta num">${days.map(d=>`${dayLabel(r,d)} ${shares[x.id]?.[d]?won(shares[x.id][d]):"—"}`).join(" · ")}</span>`:""}</div>`).join("");
  const dayTotals=days.map(d=>ex.filter(e=>e.date===d).reduce((a,e)=>a+(+e.krw||0),0));
  const table = `<div class="tbl"><table><thead><tr><th>이름</th>${days.map(d=>`<th class="r">${dayLabel(r,d)}<div class="xs" style="font-weight:400">${md(d)}</div></th>`).join("")}<th class="r">부담할 몫</th><th class="r">낸 돈</th><th class="r">차액</th></tr></thead><tbody>
    ${rows.map(x=>`<tr><td><strong>${esc(nameOf(x.id))}</strong></td>${days.map(d=>`<td class="r num ${shares[x.id]?.[d]?"":"muted"}">${shares[x.id]?.[d]?won(shares[x.id][d]):"—"}</td>`).join("")}
      <td class="r num">${won(x.owe)}</td><td class="r num">${won(x.paid)}</td><td class="r num ${x.bal>0?"pos":x.bal<0?"neg":""}">${balTxt(x.bal)} ${balChip(x.bal)}</td></tr>`).join("")}
    <tr><td class="muted">일차 합계</td>${dayTotals.map(v=>`<td class="r num muted">${won(v)}</td>`).join("")}<td class="r num"><strong>${won(total)}</strong></td><td></td><td></td></tr></tbody></table></div>`;
  const doneN = transfers.filter(t=>statusOf(r.id,t).done).length;
  const xHtml = transfers.length ? transfers.map(t=>{ const s=statusOf(r.id,t), btns=[];
      if(!s.done){
        if(ME.id===t.from && !s.sent) btns.push(`<button class="pri" data-xsent="${t.key}" data-r="${r.id}">보냈어요</button>`);
        if(ME.id===t.from && s.sent) btns.push(`<button data-xunsent="${t.key}" data-r="${r.id}">보냄 취소</button>`);
        if(ME.id===t.to) btns.push(`<button class="pri" data-xgot="${t.key}" data-r="${r.id}">받았어요</button>`);
        if(ME.admin && ME.id!==t.to) btns.push(`<button data-xconfirm="${t.key}" data-r="${r.id}">입금 확인</button>`);
      } else if(ME.admin || ME.id===t.to) btns.push(`<button class="ghost" data-xundo="${t.key}" data-r="${r.id}">완료 취소</button>`);
      return `<div class="xfer ${s.done?"done":""}"><div class="line"><span class="who">${esc(nameOf(t.from))} → ${esc(nameOf(t.to))}</span><span class="amt num">${won(t.amt)}</span></div>
        <div class="xs">${s.done?`<span class="chip good">완료 ${fmtDT(s.doneAt)}</span>`:s.sent?'<span class="chip warn">보냈다고 표시함 · 받는 사람 확인 대기</span>':'<span class="chip">보내기 전</span>'}</div>
        ${!s.done && (ME.id===t.from || ME.admin) ? payHtml(t) : ""}
        ${btns.length?`<div class="acts">${btns.join("")}</div>`:""}</div>`; }).join("")
    : `<div class="empty">${ex.length?"서로 주고받을 돈이 없어요.":"지출을 등록하면 누가 누구에게 얼마 보낼지 자동으로 계산돼요."}</div>`;
  return `<div class="stack" style="gap:14px">
    <div class="kv"><div><div class="k">총 지출</div><div class="v num">${won(total)}</div></div>
      <div><div class="k">함께한 사람</div><div class="v num">${people}명</div></div>
      <div><div class="k">1인 평균</div><div class="v num">${people?won(total/people):"—"}</div></div>
      <div><div class="k">지출</div><div class="v num">${ex.length}건</div></div></div>
    ${rows.length?`<div class="only-narrow stack" style="gap:8px">${cards}</div><div class="only-wide">${table}</div>`:""}
    <div class="spread"><h3>송금 정리</h3>${transfers.length?`<span class="chip ${doneN===transfers.length?"good":""}">${doneN}/${transfers.length} 완료</span>`:""}</div>
    ${ex.length?`<button type="button" class="block" data-kakaotext="${r.id}" style="background:#FEE500;color:#191600;border-color:#FEE500;font-weight:700">카톡방에 올릴 정산 문구 복사</button>`:""}
    ${!readonly&&transfers.length?`<p class="xs muted" style="margin:-8px 0 0">가장 적은 횟수로 맞췄어요. 지출이 바뀌면 금액과 체크가 다시 계산돼요.</p>`:""}
    <div class="stack" style="gap:8px">${xHtml}</div>
    ${readonly?`<details class="sub"><summary>지출 내역 ${ex.length}건 보기</summary><div class="stack" style="gap:10px;margin-top:8px">${expensesHtml(r, ex, true)}</div></details>`:""}
  </div>`;
}
function expensesHtml(r, ex, readonly){
  const all=activeIds();
  const days=[...new Set(ex.map(e=>e.date))].sort();
  return days.map(d=>{ const list=ex.filter(e=>e.date===d), sum=list.reduce((a,e)=>a+(+e.krw||0),0);
    return `<div class="day"><div class="dh"><span>${dayLabel(r,d)} · ${md(d)}</span><span class="num">${won(sum)}</span></div>
    ${list.map(e=>{ const parts=e.parts||[]; const isAll=parts.length===all.length && all.every(id=>parts.includes(id));
      return `<div class="exp"><div class="t"><span class="chip acc">${esc(e.seq||"기타")}</span><strong>${esc(e.title)}</strong>${e.memo?`<div class="small muted">${esc(e.memo)}</div>`:""}</div>
        <div class="amt num">${won(e.krw)}${e.currency&&e.currency!=="KRW"?`<div class="xs muted" style="font-weight:400">${(+e.amount).toLocaleString("ko-KR")} ${esc(e.currency)}</div>`:""}</div>
        <div class="sub"><span>${esc(nameOf(e.payer))} 결제</span><span title="${esc(parts.map(nameOf).join(", "))}">· ${isAll?"전원":parts.map(nameOf).map(esc).join(", ")} · 1인 ${won((+e.krw||0)/(parts.length||1))}</span>
          ${(e.receipts||[]).length?`<button class="ghost sm" data-showr="${e.roundId}">영수증 ${e.receipts.length}장</button>`:'<span class="chip warn">영수증 없음</span>'}
          ${e.updatedAt?'<span class="chip">수정됨</span>':""}
          ${!readonly&&ME.admin?`<span style="margin-left:auto" class="row" ><button class="ghost sm" data-editexp="${e.id}">수정</button><button class="ghost sm danger" data-delexp="${e.id}">삭제</button></span>`:""}</div>
      </div>`; }).join("")}</div>`; }).join("");
}

function renderSettle(){
  const r=curRound(), sel=$("#roundSel"), list=settlingRounds();
  const extra=ME.admin ? S.rounds.filter(x=>!list.includes(x) && statusOfRound(x).key!=="done") : [];
  const opt = x => `<option value="${x.id}" ${x.id===UI.round?"selected":""}>${esc(x.title)} · ${esc(statusOfRound(x).label)}</option>`;
  sel.innerHTML = (list.length||extra.length) ? (list.map(opt).join("") + (extra.length?`<optgroup label="지출 기록 시작 (총무)">${extra.map(opt).join("")}</optgroup>`:"")) : `<option>정산 중인 모임 없음</option>`;
  sel.disabled = !(list.length||extra.length);
  $("#settleCount").textContent = `정산 중 ${list.length}개`;
  $("#xSubmit").disabled = !r; $("#fab").hidden = !ME.admin || !r;
  fillDays(r); fillCurrency(r);
  if(!r){
    $("#roundMeta").textContent=""; $("#expCount").textContent="0건";
    $("#settleBody").innerHTML = `<div class="empty">정산 중인 모임이 없어요. 송금까지 끝난 모임은 '정산 이력'에 있어요.</div>`;
    $("#expList").innerHTML=""; $("#rateBox").innerHTML=""; return;
  }
  const ex=S.expenses.filter(e=>e.roundId===r.id).sort((a,b)=>(a.date||"").localeCompare(b.date||"")||(a.createdAt||"").localeCompare(b.createdAt||""));
  $("#roundMeta").textContent = whenOf(r);
  $("#expCount").textContent = ex.length+"건";
  $("#settleBody").innerHTML = settlementHtml(r);
  $("#expList").innerHTML = ex.length ? expensesHtml(r, ex, false) : `<div class="empty">아직 지출이 없어요.${ME.admin?" '지출 추가'에서 일차와 구분(숙소, 1차, 2차…)을 골라 등록해 주세요.":""}</div>`;
  if(ME.admin){
    const rates=r.rates||{};
    $("#rateBox").innerHTML = `<p class="small muted" style="margin:0">해외 모임일 때만 쓰세요. 등록된 지출은 그때 환율로 고정돼요.</p>
      ${Object.keys(rates).length?`<div class="row">${Object.entries(rates).map(([c,v])=>`<span class="chip acc num">1 ${esc(c)} = ${(+v).toLocaleString("ko-KR")}원 <button class="ghost sm" style="min-height:28px;padding:0 6px" data-delrate="${esc(c)}" aria-label="${esc(c)} 삭제">✕</button></span>`).join("")}</div>`:""}
      <form id="rateForm" class="stack"><div class="grid2"><select id="rCur">${["USD","JPY","EUR","CNY","THB","VND","TWD","PHP","HKD","SGD","GBP","AUD"].map(c=>`<option>${c}</option>`).join("")}</select><input id="rVal" type="number" inputmode="decimal" step="any" min="0" placeholder="1단위당 원" required></div><button type="submit" class="block">환율 추가</button></form>`;
    $("#rateForm").onsubmit = async ev => { ev.preventDefault(); const c=$("#rCur").value, v=+$("#rVal").value; if(!(v>0)) return;
      await run(async()=>{ await Store.put("rounds", r.id, {...r, rates:{...rates,[c]:v}}); await log("환율 설정", `${r.title}: 1 ${c} = ${v}원`); }, "환율을 저장했어요"); };
  }
}

function renderDone(){
  const list=doneRounds();
  $("#doneList").innerHTML = list.length ? list.map(r=>{
    const {rows, transfers}=settleOf(r.id), total=Ledger.total(S.expenses, r.id);
    const doneAt=transfers.map(t=>statusOf(r.id,t).doneAt).filter(Boolean).sort().pop();
    const open=UI.doneOpen.has(r.id);
    return `<article class="hist" id="dn-${r.id}">
      <div class="spread"><span class="chip good">정산 완료${doneAt?` · ${fmtDT(doneAt)}`:""}</span><span class="small muted num">${r.no?r.no+"회차":""}</span></div>
      <div class="ttl" style="font-size:19px;font-weight:700">${esc(r.title)}</div>
      <div class="small num muted">${whenOf(r)}</div>
      <div class="kv"><div><div class="k">총 지출</div><div class="v num">${won(total)}</div></div><div><div class="k">1인 평균</div><div class="v num">${rows.length?won(total/rows.length):"—"}</div></div></div>
      <button type="button" data-doneopen="${r.id}" class="block">${open?"접기":"정산 내역 자세히"}</button>
      ${open?settlementHtml(r,{readonly:true}):""}
    </article>`; }).join("")
    : `<div class="empty">아직 정산이 끝난 모임이 없어요. 모든 송금이 '완료'되면 여기로 옮겨져요.</div>`;
}

function renderReceipts(){
  const f=$("#rFilter");
  if(UI.rFilter!=="all" && !roundById(UI.rFilter)) UI.rFilter="all";
  f.innerHTML = `<option value="all">전체 모임</option>` + S.rounds.map(x=>`<option value="${x.id}" ${UI.rFilter===x.id?"selected":""}>${esc(x.title)}</option>`).join("");
  const order = e => `${roundById(e.roundId)?.startDate||""}|${e.date||""}|${e.createdAt||""}`;
  const ex=S.expenses.filter(e=>UI.rFilter==="all"||e.roundId===UI.rFilter).sort((a,b)=>order(a).localeCompare(order(b)));
  const cards=[]; let n=0;
  ex.forEach(e=>(e.receipts||[]).forEach(rc=>{ n++;
    const r=roundById(e.roundId), isImg=(rc.type||"").startsWith("image/"), url=Store.fileUrl(rc.id);
    const meta=`<div class="meta"><span class="xs muted num">#${String(n).padStart(3,"0")} · ${esc(dayLabel(r,e.date))} ${esc(e.seq||"")}</span><strong>${esc(e.title)}</strong><span class="num">${won(e.krw)}</span><span class="xs muted">${esc(r?.title||"")} · ${esc(nameOf(e.payer))} 결제</span></div>`;
    cards.push(isImg
      ? `<button type="button" class="rcard" data-lb="${rc.id}" data-cap="${esc(`${r?.title||""} ${dayLabel(r,e.date)} ${e.seq||""} · ${e.title} · ${won(e.krw)}`)}"><div class="th"><img src="${url}" alt="${esc(e.title)} 영수증" loading="lazy"></div>${meta}</button>`
      : `<a class="rcard" href="${url}" target="_blank" rel="noopener"><div class="th">PDF · ${esc(rc.name||"문서")}</div>${meta}</a>`);
  }));
  const missing = ex.filter(e=>!(e.receipts||[]).length);
  $("#rGrid").innerHTML = (cards.length?`<div class="rgrid">${cards.join("")}</div>`:`<div class="empty">아직 올라온 영수증이 없어요. 총무가 지출을 등록할 때 사진을 함께 올리면 여기에 모여요.</div>`)
    + (missing.length?`<p class="small" style="margin:12px 0 0"><span class="chip warn">영수증 없는 지출 ${missing.length}건</span> <span class="muted">${missing.slice(0,8).map(e=>esc(e.title)).join(", ")}${missing.length>8?" 외":""}</span></p>`:"");
}

function renderMembers(){
  const box=$("#memberList");
  if(box.contains(document.activeElement) && document.activeElement.matches("input")) return;
  const ids=activeIds(), left=leftIds(); $("#memberCount").textContent = ids.length+"명";
  const mItem = (id, isLeft) => { const m=S.members[id]; const isMe=id===ME.id; const canRename=(isMe&&!isLeft)||(ME.admin&&m.manual);
    const cnt=S.rounds.filter(r=>respOf(id,r.id)?.s==="yes").length;
    return `<div class="item"><div class="body"><div class="row"><strong style="font-size:17px">${esc(m.name)}</strong>${isMe?'<span class="chip acc">나</span>':""}${m.manual?'<span class="chip">총무가 추가</span>':""}${isLeft?'<span class="chip">탈퇴</span>':""}</div>
      <div class="xs muted">${fmtDT(m.joinedAt)} 등록${isLeft?` · ${fmtDT(m.leftAt)} 탈퇴`:""} · 참석 ${cnt}회</div>
      ${payKinds(m).length?`<div class="row" style="gap:4px;margin-top:4px">${payKinds(m).map(k=>`<span class="chip">${k}</span>`).join("")}</div>`:""}
      ${canRename?`<form class="row" data-rename="${id}" style="margin-top:8px" hidden><input value="${esc(m.name)}" maxlength="20" style="flex:1"><button class="sm pri" type="submit">저장</button></form>`:""}</div>
      <div class="row" style="gap:0">${canRename?`<button class="ghost sm" data-renamebtn>이름 변경</button>`:""}${ME.admin&&!isMe&&!isLeft?`<button class="ghost sm" data-resetpin="${id}">PIN 초기화</button>`:""}${ME.admin&&!isMe?(isLeft?`<button class="ghost sm" data-restore="${id}">복구</button>`:`<button class="ghost sm danger" data-leave="${id}">탈퇴 처리</button>`):""}</div></div>`; };
  box.innerHTML = ids.length ? ids.map(id=>mItem(id,false)).join("") : `<div class="empty">아직 등록한 멤버가 없어요. 이 페이지 링크를 카톡방에 올려 각자 등록하게 해 주세요.</div>`;
  $("#leftWrap").hidden=!left.length; $("#leftSum").textContent=`탈퇴한 멤버 ${left.length}명`;
  $("#leftList").innerHTML = left.map(id=>mItem(id,true)).join("");
}

function renderLog(){
  const joins = Object.values(S.members).filter(m=>m.self&&m.joinedAt).map(m=>({at:m.joinedAt, by:m.id, action:"멤버 등록", detail:`${m.name} 님이 직접 등록`}));
  const all=[...S.log, ...joins].sort((a,b)=>(b.at||"").localeCompare(a.at||"")).slice(0,200);
  const unknown=[...new Set(all.map(l=>l.by).filter(id=>id && !S.members[id] && !(id in extraNames)))];
  if(unknown.length){ unknown.forEach(id=>extraNames[id]=""); Store.names(unknown).then(o=>{ Object.assign(extraNames,o); sched(); }); }
  $("#logList").innerHTML = all.length ? all.map(l=>`<div class="item"><div class="body"><div class="row"><span class="chip ${/삭제|취소|탈퇴/.test(l.action)?"bad":/수정|변경|대신/.test(l.action)?"warn":"acc"}">${esc(l.action)}</span></div>
      <div style="margin-top:4px">${esc(l.detail)}</div>
      <div class="xs muted">${fmtDT(l.at)} · ${esc(l.by?(S.members[l.by]?.name||extraNames[l.by]||"편집자"):"—")}</div></div></div>`).join("")
    : `<div class="empty">아직 기록이 없어요.</div>`;
}

/* ---------- 지출 입력 ---------- */
function fillMemberControls(){
  const ids=activeIds(), r=curRound();
  const xp=$("#xPayer"), xv=xp.value;
  const payerIds = UI.edit && !ids.includes(UI.edit.payer) ? [...ids, UI.edit.payer] : ids;
  xp.innerHTML = payerIds.map(id=>`<option value="${id}">${esc(nameOf(id))}</option>`).join("") || `<option value="">멤버 없음</option>`;
  if(xv && payerIds.includes(xv)) xp.value=xv;
  const att=r?attendees(r):[];
  if(!UI.partsTouched && !UI.edit) UI.parts=new Set(att.length?att:ids);
  const shown=[...new Set([...ids, ...UI.parts])].filter(id=>S.members[id]);
  const attSet=new Set(att);
  $("#xParts").innerHTML = shown.map(id=>`<label><input type="checkbox" value="${id}" ${UI.parts.has(id)?"checked":""}>${esc(nameOf(id))}${S.members[id].leftAt?" (탈퇴)":attSet.size&&!attSet.has(id)?" · 불참":""}</label>`).join("") || `<span class="small muted">등록된 멤버가 없어요</span>`;
  calcKrw();
}
function fillDays(r){
  const sel=$("#xDay"), v=sel.value;
  const days=Ledger.daysOf(r).map(d=>d.date);
  if(UI.edit?.date && !days.includes(UI.edit.date)) days.push(UI.edit.date);
  days.sort();
  sel.innerHTML = days.map(d=>`<option value="${d}">${dayLabel(r,d)} · ${md(d)}</option>`).join("") || `<option value="">모임을 먼저 골라 주세요</option>`;
  if(days.includes(v)) sel.value=v; else { const t=today(); sel.value = days.includes(t) ? t : (days[0]||""); }
}
function fillCurrency(r){
  const sel=$("#xCur"), v=sel.value||"KRW";
  const curs=["KRW", ...Object.keys(r?.rates||{})];
  if(UI.edit?.currency && !curs.includes(UI.edit.currency)) curs.push(UI.edit.currency);
  sel.innerHTML = curs.map(c=>`<option>${c}</option>`).join("");
  sel.value = curs.includes(v)?v:"KRW";
  $("#xRateWrap").hidden = sel.value==="KRW";
}
function calcKrw(){
  const c=$("#xCur").value, k=Ledger.toKrw($("#xAmount").value, c, $("#xRate").value), n=UI.parts.size;
  $("#xKrw").textContent = +$("#xAmount").value ? `원화 ${won(k)}${n?` · ${n}명이면 1인 ${won(k/n)}`:""}` : "";
}
function renderKeep(){ $("#xKeep").innerHTML = UI.keep.map((r,i)=>`<span>${(r.type||"").startsWith("image/")?"사진":"PDF"} ${esc(r.name||"")}<button type="button" class="ghost sm" style="min-height:30px;padding:0 8px" data-unkeep="${i}" aria-label="영수증 빼기">✕</button></span>`).join(""); }
function resetExp(){
  const keepDay=$("#xDay").value, keepSeq=$("#xSeq").value, keepPayer=$("#xPayer").value;
  UI.edit=null; UI.keep=[]; UI.partsTouched=false;
  $("#expForm").reset(); $("#xRate").value=1; $("#xCur").value="KRW"; $("#xRateWrap").hidden=true;
  $("#expTag").textContent="지출 추가 (총무)"; $("#xSubmit").textContent="지출 등록"; $("#xCancel").hidden=true;
  renderKeep(); fillDays(curRound()); fillMemberControls();
  if(keepDay) $("#xDay").value=keepDay; if(keepPayer) $("#xPayer").value=keepPayer;
  const seqs=[...$("#xSeq").options].map(o=>o.value), m=/^(\d)차$/.exec(keepSeq);
  $("#xSeq").value = m && seqs.includes(`${+m[1]+1}차`) ? `${+m[1]+1}차` : keepSeq==="숙소" ? "1차" : (keepSeq||"숙소");
}
function nextRoundNo(){ return (Math.max(0, ...S.rounds.map(r=>+r.no||0)))+1; }
function resetRoundForm(){
  UI.editRound=null; $("#roundForm").reset();
  $("#roundTag").textContent="새 모임 등록"; $("#rSubmit").textContent="모임 등록"; $("#rCancel").hidden=true;
}

/* ---------- actions ---------- */
const Actions = {
  async saveRound(){
    const d={title:$("#rTitle").value.trim(), startDate:$("#rStart").value, endDate:$("#rEnd").value||$("#rStart").value, rsvpDue:$("#rDue").value||"", memo:$("#rMemo").value.trim()};
    if(d.endDate<d.startDate){ toast("마지막 날이 시작일보다 빨라요"); return; }
    if(Ledger.diffDays(d.startDate, d.endDate)>13){ toast("한 모임은 최대 14일까지 만들 수 있어요"); return; }
    if(UI.editRound){
      const o=UI.editRound, ch=[];
      if(o.title!==d.title) ch.push(`이름 '${o.title}'→'${d.title}'`);
      if(o.startDate!==d.startDate||o.endDate!==d.endDate) ch.push(`날짜 ${o.startDate}~${o.endDate} → ${d.startDate}~${d.endDate}`);
      if((o.rsvpDue||"")!==d.rsvpDue) ch.push(`참석 마감 → ${d.rsvpDue||"없음"}`);
      if(await run(async()=>{ await Store.put("rounds", o.id, {...o, ...d}); await log("모임 수정", `${d.title}: ${ch.join(", ")||"메모 수정"}`); }, "모임을 수정했어요")){ resetRoundForm(); $("#roundFormBox").open=false; }
    } else {
      const no=nextRoundNo();
      if(await run(async()=>{ await Store.insert("rounds", {...d, no, rates:{}, createdAt:nowISO(), createdBy:ME.id}); await log("모임 등록", `${no}회차 ${d.title} (${d.startDate}~${d.endDate})`); }, `'${d.title}' 모임을 등록했어요`)){ resetRoundForm(); $("#roundFormBox").open=false; }
    }
  },
  editRound(id){
    const r=roundById(id); if(!r) return; UI.editRound=r;
    if(location.hash!=="#home") location.hash="#home";
    $("#rTitle").value=r.title; $("#rStart").value=r.startDate; $("#rEnd").value=r.endDate||""; $("#rDue").value=r.rsvpDue||""; $("#rMemo").value=r.memo||"";
    $("#roundTag").textContent=`모임 수정 · ${r.title}`; $("#rSubmit").textContent="수정 저장"; $("#rCancel").hidden=false;
    $("#roundFormBox").open=true; setTimeout(()=>$("#roundFormBox").scrollIntoView({behavior:"smooth", block:"start"}),60);
  },
  async saveExpense(){
    const r=curRound(); if(!r) return;
    const parts=[...UI.parts].filter(id=>S.members[id]);
    const payer=$("#xPayer").value;
    if(!payer){ toast("결제한 사람을 골라 주세요"); return; }
    if(!parts.length){ toast("함께한 사람을 한 명 이상 골라 주세요"); return; }
    const cur=$("#xCur").value, amount=+$("#xAmount").value, rate=cur==="KRW"?1:+$("#xRate").value;
    if(!(amount>0)){ toast("금액을 입력해 주세요"); return; }
    if(!(rate>0)){ toast("환율을 입력해 주세요"); return; }
    const btn=$("#xSubmit"); btn.disabled=true;
    const files=[...$("#xFiles").files], receipts=[...UI.keep];
    try{
      if(files.length){
        if(!Store.canUpload()) toast("영수증 업로드 권한이 없어 사진 없이 저장해요");
        else for(let i=0;i<files.length;i++){ btn.textContent=`영수증 올리는 중 ${i+1}/${files.length}`; receipts.push(await Store.upload(files[i])); }
      }
      btn.textContent="저장 중…";
      const d={roundId:r.id, date:$("#xDay").value, seq:$("#xSeq").value, title:$("#xTitle").value.trim(), amount, currency:cur, rate, krw:Ledger.toKrw(amount,cur,rate), payer, parts, receipts, memo:$("#xMemo").value.trim()};
      const where=`[${r.title} ${dayLabel(r,d.date)} ${d.seq}]`;
      if(UI.edit){
        const o=UI.edit, ch=[];
        if(o.title!==d.title) ch.push(`내용 '${o.title}'→'${d.title}'`);
        if(o.krw!==d.krw) ch.push(`금액 ${won(o.krw)}→${won(d.krw)}`);
        if(o.payer!==d.payer) ch.push(`결제자 ${nameOf(o.payer)}→${nameOf(d.payer)}`);
        if((o.parts||[]).slice().sort().join()!==parts.slice().sort().join()) ch.push(`함께한 사람 ${(o.parts||[]).length}명→${parts.length}명`);
        if(o.date!==d.date) ch.push(`일차 ${dayLabel(r,o.date)}→${dayLabel(r,d.date)}`);
        if(o.seq!==d.seq) ch.push(`구분 ${o.seq}→${d.seq}`);
        if((o.receipts||[]).length!==receipts.length) ch.push(`영수증 ${(o.receipts||[]).length}장→${receipts.length}장`);
        await Store.put("expenses", o.id, {...d, createdAt:o.createdAt||nowISO(), updatedAt:nowISO()});
        for(const x of (o.receipts||[]).filter(x=>!receipts.find(k=>k.id===x.id))) await Store.deleteFile(x.id);
        await log("지출 수정", `${where} ${d.title}: ${ch.join(", ")||"세부 내용 수정"}`);
        toast("지출을 수정했어요");
      } else {
        await Store.insert("expenses", {...d, createdAt:nowISO()});
        await log("지출 등록", `${where} ${d.title} ${won(d.krw)} · ${nameOf(payer)} 결제 · ${parts.length}명`);
        toast("지출을 등록했어요");
      }
      resetExp();
    }catch(e){ console.error(e); toast(errMsg(e)); }
    finally{ btn.disabled=false; btn.textContent=UI.edit?"수정 저장":"지출 등록"; }
  },
  editExpense(id){
    const x=S.expenses.find(v=>v.id===id); if(!x) return;
    UI.edit=x; UI.keep=[...(x.receipts||[])]; UI.parts=new Set(x.parts||[]); UI.partsTouched=true;
    const r=curRound(); fillDays(r); fillCurrency(r); fillMemberControls();
    $("#xDay").value=x.date||""; $("#xSeq").value=x.seq||"기타"; $("#xTitle").value=x.title||""; $("#xAmount").value=x.amount; $("#xCur").value=x.currency||"KRW"; $("#xRateWrap").hidden=$("#xCur").value==="KRW"; $("#xRate").value=x.rate||1; $("#xPayer").value=x.payer; $("#xMemo").value=x.memo||""; $("#xFiles").value="";
    $("#expTag").textContent="지출 수정 (총무)"; $("#xSubmit").textContent="수정 저장"; $("#xCancel").hidden=false; renderKeep(); calcKrw();
    $("#expBox").open=true; $("#expBox").scrollIntoView({behavior:"smooth", block:"start"});
  },
  deleteExpense(id){
    const x=S.expenses.find(v=>v.id===id), r=roundById(x?.roundId); if(!x) return;
    return run(async()=>{ await Store.remove("expenses", x.id); for(const rc of (x.receipts||[])) await Store.deleteFile(rc.id);
      await log("지출 삭제", `[${r?.title||""} ${dayLabel(r,x.date)} ${x.seq||""}] ${x.title} ${won(x.krw)}`); if(UI.edit?.id===x.id) resetExp(); }, "삭제했어요");
  },
  setMark(memberId, kind, key, on){
    const rec=S.marksSelf[memberId]||{}; const m={...(rec[kind]||{})};
    if(on) m[key]=nowISO(); else delete m[key];
    return Store.put("marksSelf", memberId, {...rec, [kind]:m});
  },
  setConfirm(roundId, key, on){
    const d={...(S.marksRound[roundId]?.done||{})}; if(on) d[key]=nowISO(); else delete d[key];
    return Store.put("marksRound", roundId, {done:d});
  }
};

/* ---------- bindings ---------- */
function bindForms(){
  $("#copyClose").onclick = () => $("#copyBox").hidden=true;
  $("#copyBox").onclick = e => { if(e.target.id==="copyBox") $("#copyBox").hidden=true; };
  $("#payFormBox").addEventListener("toggle", () => { if(!$("#payFormBox").open) return; const m=S.members[ME.id]||{};
    $("#pfKakao").value=m.kakaoLink||""; $("#pfToss").value=m.tossId||""; $("#pfBank").value=m.bank||""; $("#pfAcct").value=m.account||""; });
  $("#payForm").onsubmit = async ev => { ev.preventDefault(); const m=S.members[ME.id]; if(!m){ toast("먼저 가입해 주세요"); return; }
    const kakaoLink=$("#pfKakao").value.trim().replace(/^http:\/\//,"https://");
    if(kakaoLink && !kakaoOk(kakaoLink)){ toast("카카오페이 송금 링크는 https://qr.kakaopay.com/ 으로 시작해요"); return; }
    const tossId=$("#pfToss").value.trim().replace(/^https?:\/\//,"").replace(/^toss\.me\//,"").replace(/\/.*$/,"");
    if(tossId && !/^[A-Za-z0-9_.-]{2,40}$/.test(tossId)){ toast("토스 아이디를 확인해 주세요"); return; }
    const bank=$("#pfBank").value.trim(), account=$("#pfAcct").value.replace(/[^0-9-]/g,"");
    if(await run(()=>Store.put("members", ME.id, {...m, kakaoLink, tossId, bank, account}), "송금 받을 곳을 저장했어요")) $("#payFormBox").open=false; };
  $("#rStart").addEventListener("change", ()=>{ if(!$("#rEnd").value || $("#rEnd").value<$("#rStart").value) $("#rEnd").value=Ledger.addDays($("#rStart").value,1); });
  $("#roundForm").onsubmit = ev => { ev.preventDefault(); Actions.saveRound(); };
  $("#rCancel").onclick = () => { resetRoundForm(); $("#roundFormBox").open=false; };
  $("#noticeForm").onsubmit = async ev => { ev.preventDefault();
    const d={title:$("#nTitle").value.trim(), body:$("#nBody").value.trim(), pinned:$("#nPin").checked, createdAt:nowISO(), createdBy:ME.id};
    if(await run(async()=>{ await Store.insert("notices", d); await log("공지 등록", d.title); }, "공지를 올렸어요")){ ev.target.reset(); $("#noticeFormBox").open=false; window.scrollTo({top:0, behavior:"smooth"}); } };
  $("#addMemberForm").onsubmit = async ev => { ev.preventDefault(); const name=$("#amName").value.trim(); if(!name) return;
    if(activeIds().some(id=>S.members[id].name===name)){ toast(`'${name}' 이름이 이미 있어요`); return; }
    if(await run(async()=>{ await Store.insert("members", {name, joinedAt:nowISO(), manual:true, leftAt:null}); await log("멤버 추가", `${name} (총무가 대신 등록)`); }, `${name} 님을 추가했어요`)) ev.target.reset(); };
  $("#setForm").onsubmit = async ev => { ev.preventDefault(); const groupName=$("#sName").value.trim();
    await run(async()=>{ await Store.put("settings", "main", {...S.settings, groupName}); if(groupName!==(S.settings.groupName||"")) await log("설정 변경", `모임 이름 → ${groupName}`); }, "모임 이름을 저장했어요"); };
  $("#roundSel").onchange = e => { UI.round=e.target.value; resetExp(); sched(); };
  $("#rFilter").onchange = e => { UI.rFilter=e.target.value; sched(); };
  $("#fab").onclick = () => { $("#expBox").open=true; $("#expBox").scrollIntoView({behavior:"smooth", block:"start"}); setTimeout(()=>$("#xTitle").focus({preventScroll:true}),350); };

  // 참석 응답 폼 (위임)
  const att=$("#t-attend");
  att.addEventListener("input", e => { const f=e.target.closest("[data-rsvpform]"); if(!f) return; const rid=f.dataset.rsvpform; const k=e.target.dataset.k; if(!k) return;
    if(k==="target") return; UI.draft[rid]={...(UI.draft[rid]||{}), [k]:e.target.value}; });
  att.addEventListener("change", e => { const f=e.target.closest("[data-rsvpform]"); if(f && e.target.dataset.k==="target"){ UI.draft[f.dataset.rsvpform]={target:e.target.value}; attendDirty=false; document.activeElement.blur(); renderAttend(); } });
  att.addEventListener("submit", e => { const f=e.target.closest("[data-rsvpform]"); if(!f) return; e.preventDefault(); saveRsvp(f.dataset.rsvpform, f); });
  att.addEventListener("focusout", () => setTimeout(()=>{ if(attendDirty && !att.contains(document.activeElement)) renderAttend(); }, 0));

  $("#xCur").onchange = () => { const r=curRound(), c=$("#xCur").value; $("#xRate").value = c==="KRW"?1:(r?.rates?.[c]||""); $("#xRateWrap").hidden=c==="KRW"; calcKrw(); };
  $("#xAmount").oninput=calcKrw; $("#xRate").oninput=calcKrw;
  $("#xParts").addEventListener("change", e => { if(e.target.type!=="checkbox") return; UI.partsTouched=true; e.target.checked?UI.parts.add(e.target.value):UI.parts.delete(e.target.value); calcKrw(); });
  $("#xAtt").onclick = () => { const r=curRound(), a=r?attendees(r):[]; if(!a.length){ toast("이 모임에 '참석'으로 응답한 사람이 아직 없어요"); return; } UI.partsTouched=true; UI.parts=new Set(a); fillMemberControls(); };
  $("#xAll").onclick = () => { UI.partsTouched=true; UI.parts=new Set(activeIds()); fillMemberControls(); };
  $("#xNone").onclick = () => { UI.partsTouched=true; UI.parts=new Set(); fillMemberControls(); };
  $("#xCancel").onclick = () => { resetExp(); $("#expBox").open=false; };
  $("#xKeep").addEventListener("click", e => { const b=e.target.closest("[data-unkeep]"); if(!b) return; UI.keep.splice(+b.dataset.unkeep,1); renderKeep(); });
  $("#expForm").onsubmit = ev => { ev.preventDefault(); Actions.saveExpense(); };

  document.addEventListener("click", async e => {
    const b=e.target.closest("button,[data-lb],a[data-copyamt]"); if(!b) return; const ds=b.dataset;
    if(ds.copyamt){ copyText(String(ds.copyamt), `금액 ${won(+ds.copyamt)}을 복사했어요. 카카오페이에서 붙여넣어 주세요.`); return; }
    if(ds.copyacct){ const m=S.members[ds.copyacct]||{}; copyText(`${m.bank||""} ${m.account}`.trim(), `계좌를 복사했어요 · 보낼 금액 ${won(+ds.amt)}`); return; }
    if(ds.kakaotext){ const r=roundById(ds.kakaotext); if(r) copyText(kakaoText(r), "정산 문구를 복사했어요. 카톡방에 붙여넣어 주세요."); return; }
    if(ds.goto){ if(ds.goto==="settle" && ds.rid){ UI.round=ds.rid; resetExp(); } if(ds.goto==="done" && ds.rid) UI.doneOpen.add(ds.rid); go(ds.goto, ds.rid||null); sched(); return; }
    if(ds.pick){ const rid=ds.pick; UI.draft[rid]={...(UI.draft[rid]||{}), s:ds.v}; const f=b.closest("form"); f?.querySelectorAll("input[data-k]").forEach(i=>UI.draft[rid][i.dataset.k]=i.value); attendDirty=false; renderAttend();
      const nf=document.querySelector(`[data-rsvpform="${rid}"] input[data-k]`); if(nf && ds.v!=="yes") nf.focus(); return; }
    if(ds.doneopen){ UI.doneOpen.has(ds.doneopen)?UI.doneOpen.delete(ds.doneopen):UI.doneOpen.add(ds.doneopen); sched(); return; }
    if(ds.editround) return Actions.editRound(ds.editround);
    if(ds.delround) return arm(b, ()=>{ const r=roundById(ds.delround); const n=S.expenses.filter(x=>x.roundId===r.id).length;
      if(n){ toast(`지출 ${n}건이 남아 있어요. 지출을 먼저 지워야 모임을 삭제할 수 있어요.`); return; }
      run(async()=>{ await Store.remove("rounds", r.id); await log("모임 삭제", r.title); }, "삭제했어요"); });
    if(ds.pin){ const n=S.notices.find(x=>x.id===ds.pin); await run(()=>Store.put("notices", n.id, {...n, pinned:!n.pinned})); return; }
    if(ds.delnotice) return arm(b, ()=>{ const n=S.notices.find(x=>x.id===ds.delnotice); run(async()=>{ await Store.remove("notices", n.id); await log("공지 삭제", n.title); }, "삭제했어요"); });
    if(ds.leave) return arm(b, ()=>{ const m=S.members[ds.leave]; run(async()=>{ await Store.put("members", m.id, {...m, leftAt:nowISO()}); await log("멤버 탈퇴 처리", m.name); }, `${m.name} 님을 탈퇴 처리했어요`); }, "한 번 더 누르면 탈퇴");
    if(ds.resetpin) return arm(b, ()=>{ const m=S.members[ds.resetpin]; Store.resetPin(m.id).then(()=>{ toast(`${m.name} 님 PIN을 지웠어요. 다음 로그인 때 새 PIN을 정해요`); log("PIN 초기화", m.name); }).catch(e=>toast(e?.message||"실패했어요")); }, "한 번 더 누르면 초기화");
    if(ds.restore){ const m=S.members[ds.restore]; await run(async()=>{ await Store.put("members", m.id, {...m, leftAt:null}); await log("멤버 복구", m.name); }, `${m.name} 님을 복구했어요`); return; }
    if("renamebtn" in ds){ const f=b.closest(".item").querySelector("[data-rename]"); f.hidden=!f.hidden; if(!f.hidden) f.querySelector("input").focus();
      f.onsubmit=async ev=>{ ev.preventDefault(); const id=f.dataset.rename, m=S.members[id], name=f.querySelector("input").value.trim(); if(!name||name===m.name) return;
        f.querySelector("input").blur(); await run(async()=>{ await Store.put("members", id, {...m, name}); if(id!==ME.id) await log("멤버 이름 변경", `${m.name} → ${name}`); }, "이름을 바꿨어요"); }; return; }
    if(ds.delrate){ const r=curRound(); const x={...(r.rates||{})}; delete x[ds.delrate]; await run(async()=>{ await Store.put("rounds", r.id, {...r, rates:x}); await log("환율 삭제", `${r.title}: ${ds.delrate}`); }); return; }
    if(ds.editexp) return Actions.editExpense(ds.editexp);
    if(ds.delexp) return arm(b, ()=>Actions.deleteExpense(ds.delexp));
    if(ds.showr){ UI.rFilter=ds.showr; go("receipts"); sched(); return; }
    if(ds.lb){ $("#lbImg").src=Store.fileUrl(ds.lb); $("#lbCap").textContent=ds.cap||""; $("#lb").hidden=false; return; }
    const k=ds.xsent||ds.xunsent||ds.xgot||ds.xconfirm||ds.xundo; if(!k) return;
    const r=roundById(ds.r); if(!r) return;
    const t=settleOf(r.id).transfers.find(v=>v.key===k); if(!t) return;
    const label=`[${r.title}] ${nameOf(t.from)} → ${nameOf(t.to)} ${won(t.amt)}`;
    if(ds.xsent) return run(()=>Actions.setMark(ME.id, "sent", t.key, true), "보냈다고 표시했어요");
    if(ds.xunsent) return run(()=>Actions.setMark(ME.id, "sent", t.key, false));
    if(ds.xgot) return run(async()=>{ await Actions.setMark(ME.id, "got", t.key, true); await log("송금 받음", label); }, "받았다고 표시했어요");
    if(ds.xconfirm) return run(async()=>{ await Actions.setConfirm(r.id, t.key, true); await log("송금 확인", label); }, "입금을 확인했어요");
    if(ds.xundo) return run(async()=>{
      if(ME.admin && S.marksRound[r.id]?.done?.[t.key]){ await Actions.setConfirm(r.id, t.key, false); await log("송금 확인 취소", label); }
      if(S.marksSelf[t.to]?.got?.[t.key] && (ME.id===t.to || ME.admin)){ await Actions.setMark(t.to, "got", t.key, false); await log("송금 받음 취소", label); }
    });
  });
  $("#lb").onclick = e => { if(e.target.id!=="lbImg") $("#lb").hidden=true; };
  document.addEventListener("keydown", e => { if(e.key==="Escape") $("#lb").hidden=true; });
  $("#exportBtn").onclick = exportXlsx;
}

/* ---------- export ---------- */
function buildSheets(){
  const rs=[...S.rounds].sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));
  const order = e => `${roundById(e.roundId)?.startDate||""}|${e.date||""}|${e.createdAt||""}`;
  const S_ = {yes:"참석", no:"불참", unknown:"모름"};
  return {
    "모임 요약": [["회차","모임","시작일","마지막 날","참석","총 지출","1인 평균","상태"], ...rs.map(r=>{ const {rows}=settleOf(r.id), tot=Ledger.total(S.expenses,r.id); return [r.no||"",r.title,r.startDate,r.endDate,attendees(r).length,tot,rows.length?Math.round(tot/rows.length):0,statusOfRound(r).label]; })],
    "참석 여부": [["모임","이름","응답","불참 사유·메모","알려줄 날짜","응답 시각"], ...rs.flatMap(r=>activeIds().map(id=>{ const v=respOf(id,r.id); return [r.title,nameOf(id),v?S_[v.s]:"미응답",v?.reason||"",v?.until||"",v?.at?fmtDT(v.at):""]; }))],
    "지출": [["모임","일차","날짜","구분","가게·내용","금액","통화","환율","원화","결제","인원","함께한 사람","1인","영수증 수","메모"],
      ...[...S.expenses].sort((a,b)=>order(a).localeCompare(order(b))).map(e=>{ const r=roundById(e.roundId), n=(e.parts||[]).length||1;
        return [r?.title||"",dayLabel(r,e.date),e.date,e.seq,e.title,+e.amount,e.currency,+e.rate,+e.krw,nameOf(e.payer),(e.parts||[]).length,(e.parts||[]).map(nameOf).join(", "),Math.round((+e.krw||0)/n),(e.receipts||[]).length,e.memo||""]; })],
    "사람별 정산": [["모임","이름","낸 돈","부담할 몫","차액"], ...rs.flatMap(r=>settleOf(r.id).rows.map(x=>[r.title,nameOf(x.id),Math.round(x.paid),Math.round(x.owe),x.bal]))],
    "송금 정리": [["모임","보내는 사람","받는 사람","금액","상태"], ...rs.flatMap(r=>settleOf(r.id).transfers.map(t=>{ const s=statusOf(r.id,t); return [r.title,nameOf(t.from),nameOf(t.to),t.amt,s.done?"완료":s.sent?"보냄(확인 대기)":"보내기 전"]; }))],
    "멤버": [["이름","등록일","방식","상태"], ...[...activeIds(), ...leftIds()].map(id=>{ const m=S.members[id]; return [m.name,(m.joinedAt||"").slice(0,10),m.manual?"총무 추가":"직접 등록",m.leftAt?`탈퇴(${m.leftAt.slice(0,10)})`:"활동"]; })],
    "변경 이력": [["시각","작업","내용"], ...[...S.log].sort((a,b)=>(a.at||"").localeCompare(b.at||"")).map(l=>[(l.at||"").replace("T"," ").slice(0,16),l.action,l.detail])]
  };
}
async function exportXlsx(){
  const sheets=buildSheets();
  const fname=`${(S.settings.groupName||"모임").replace(/[\\/:*?"<>|]/g,"")}_정산장부_${today()}`;
  try{
    if(window.XLSX){
      const wb=XLSX.utils.book_new();
      for(const [n,rows] of Object.entries(sheets)){ const ws=XLSX.utils.aoa_to_sheet(rows); ws["!cols"]=rows[0].map(()=>({wch:14})); XLSX.utils.book_append_sheet(wb,ws,n); }
      const buf=XLSX.write(wb,{type:"array",bookType:"xlsx"});
      await Store.saveFile(fname+".xlsx", new Blob([buf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
    } else {
      const csv="﻿"+sheets["지출"].map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
      await Store.saveFile(fname+".csv", new Blob([csv],{type:"text/csv"}));
    }
  }catch(e){ if(e?.code!=="declined") toast("파일을 저장하지 못했어요: "+(e?.message||e?.code)); }
}


/* ---------- 내 계정 (로그아웃 · PIN · 총무 권한) ---------- */
function renderAccount(){
  const box=$("#accountBox"); if(!box) return;
  if(box.contains(document.activeElement) && document.activeElement.matches("input")) return;
  const m=ME.id && S.members[ME.id], info=Store.me();
  box.innerHTML = !ME.id ? `<p class="small muted" style="margin:0">가입하거나 로그인하면 여기서 내 계정을 관리할 수 있어요.</p>` : `
    <div class="spread"><span><strong>${esc(m?.name||"")}</strong> 님으로 로그인됨</span><span class="chip ${ME.admin?"acc":"good"}">${ME.admin?"총무":"멤버"}</span></div>
    <details class="sub"><summary>PIN 바꾸기</summary><form id="pinForm" class="stack" style="margin-top:8px">
      <input id="pinOld" type="password" inputmode="numeric" placeholder="지금 PIN" maxlength="8" autocomplete="current-password">
      <input id="pinNew" type="password" inputmode="numeric" placeholder="새 PIN (숫자 4~8자리)" maxlength="8" required autocomplete="new-password">
      <button class="block" type="submit">PIN 바꾸기</button></form></details>
    ${ME.admin ? `<button type="button" class="block" id="leaveAdminBtn">총무 권한 내려놓기</button>` : `
    <details class="sub"><summary>${info.hasAdminPin?"총무 PIN으로 총무 되기":"처음 총무 정하기 (총무 PIN 만들기)"}</summary><form id="adminForm" class="stack" style="margin-top:8px">
      <p class="xs muted" style="margin:0">${info.hasAdminPin?"총무에게 받은 총무 PIN을 넣으면 지출·영수증을 기록할 수 있어요.":"아직 총무가 없어요. 총무 PIN(숫자 6~12자리)을 정하면 내가 첫 총무가 돼요. 이 PIN을 함께 정산할 사람에게만 알려 주세요."}</p>
      <input id="adminPin" type="password" inputmode="numeric" placeholder="총무 PIN 숫자 6~12자리" maxlength="12" required autocomplete="off">
      <button class="pri block" type="submit">${info.hasAdminPin?"총무 되기":"총무 PIN 만들고 총무 되기"}</button></form></details>`}
    <button type="button" class="ghost block" id="logoutBtn">이 기기에서 로그아웃</button>`;
  $("#pinForm")?.addEventListener("submit", async ev => { ev.preventDefault();
    try{ await Store.changePin($("#pinOld").value.trim(), $("#pinNew").value.trim()); toast("PIN을 바꿨어요"); ev.target.reset(); }catch(e){ toast(e?.message||"다시 시도해 주세요"); } });
  $("#adminForm")?.addEventListener("submit", async ev => { ev.preventDefault();
    try{ await Store.claimAdmin($("#adminPin").value.trim()); await log("총무 권한 받음", nameOf(ME.id)); toast("총무가 됐어요"); setTimeout(()=>location.reload(), 600); }catch(e){ toast(e?.message||"다시 시도해 주세요"); } });
  $("#leaveAdminBtn")?.addEventListener("click", e => arm(e.currentTarget, async ()=>{ try{ await log("총무 권한 내려놓음", nameOf(ME.id)); await Store.leaveAdmin(); setTimeout(()=>location.reload(), 300); }catch(err){ toast(err?.message||"다시 시도해 주세요"); } }, "한 번 더 누르면 내려놓기"));
  $("#logoutBtn")?.addEventListener("click", e => arm(e.currentTarget, async ()=>{ try{ await Store.logout(); location.reload(); }catch(err){ toast(err?.message||"다시 시도해 주세요"); } }, "한 번 더 누르면 로그아웃"));
}
