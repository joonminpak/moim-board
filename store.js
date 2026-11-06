/* 모임 총무 보드 · Supabase 저장소 어댑터
   화면 코드(app.js)는 이 Store 함수만 부른다. (예전 claude.ai 아티팩트 어댑터와 같은 함수 이름)
   로그인: 브라우저마다 Supabase 익명 세션 → 이름+PIN으로 멤버와 연결 (schema.sql 참고) */
function createSupabaseStore(cfg){
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {auth:{persistSession:true, autoRefreshToken:true}});
  const COL = {settings:"settings", members:"members", notices:"notices", rounds:"rounds", rsvps:"rsvp",
    expenses:"expenses", marksSelf:"sent", marksRound:"settle", log:"log"};
  const col = t => { if(!COL[t]) throw new Error("unknown table "+t); return COL[t]; };
  const cache = {};            // collection -> Map(id -> data)
  const subs = {};             // collection -> Set(cb)
  const oneSubs = {};          // "collection/id" -> Set(cb)
  let me = {id:null, canManage:false, hasAdminPin:false}, loaded=false;
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b=>b.toString(36).padStart(2,"0")).join("").slice(0,20);
  const rowsOf = c => [...(cache[c]||new Map()).entries()].map(([id,data])=>({id, ...data}));
  function emit(c, id){
    (subs[c]||[]).forEach(cb=>cb(rowsOf(c)));
    if(id!=null){ const d=cache[c]?.get(id); (oneSubs[`${c}/${id}`]||[]).forEach(cb=>cb(d?{id,...d}:null)); }
  }
  function setLocal(c, id, data){ (cache[c] ||= new Map()); if(data==null) cache[c].delete(id); else cache[c].set(id, data); emit(c, id); }
  async function loadAll(){
    const all=[]; let from=0;
    for(;;){ const {data, error} = await sb.from("docs").select("collection,id,data").range(from, from+999); if(error) throw error; all.push(...data); if(data.length<1000) break; from+=1000; }
    Object.keys(cache).forEach(k=>cache[k]=new Map());
    all.forEach(r=>{ (cache[r.collection] ||= new Map()).set(r.id, r.data); });
    loaded=true;
    Object.keys(subs).forEach(c=>emit(c));
    Object.keys(oneSubs).forEach(k=>{ const [c,id]=k.split("/"); emit(c,id); });
  }
  async function refreshMe(){
    const {data, error} = await sb.rpc("whoami"); if(error) throw error;
    me = {id:data.member_id || null, canManage:!!data.is_admin, hasAdminPin:!!data.has_admin_pin};
    return me;
  }
  const rpc = async (fn, args) => { const {data, error} = await sb.rpc(fn, args||{}); if(error) throw error; return data; };
  return {
    mode:"pin",
    async init(){
      try{
        let {data:{session}} = await sb.auth.getSession();
        if(!session){ const {error} = await sb.auth.signInAnonymously(); if(error) throw error; }
        await refreshMe();
        await loadAll();
        sb.channel("docs-all").on("postgres_changes", {event:"*", schema:"public", table:"docs"}, p => {
          const row = (p.new && p.new.collection) ? p.new : p.old;
          if(!row?.collection) return;
          setLocal(row.collection, row.id, p.eventType==="DELETE" ? null : p.new.data);
        }).subscribe();
        document.addEventListener("visibilitychange", () => { if(document.visibilityState==="visible") loadAll().catch(()=>{}); });
        return {ok:true, me};
      }catch(e){ console.error(e); return {ok:false, reason:"error", message:e?.message||String(e)}; }
    },
    me(){ return me; },
    watch(table, cb){ const c=col(table); (subs[c] ||= new Set()).add(cb); if(loaded) cb(rowsOf(c)); return ()=>subs[c].delete(cb); },
    watchOne(table, id, cb){ const k=`${col(table)}/${id}`; (oneSubs[k] ||= new Set()).add(cb); if(loaded){ const d=cache[col(table)]?.get(id); cb(d?{id,...d}:null); } return ()=>oneSubs[k].delete(cb); },
    async insert(table, row){ const c=col(table), id=rid(); const {id:_, ...data}=row;
      const {error} = await sb.from("docs").insert({collection:c, id, data}); if(error) throw error; setLocal(c, id, data); return id; },
    async put(table, id, row){ const c=col(table); const {id:_, ...data}=row;
      const {error} = await sb.from("docs").upsert({collection:c, id, data, updated_at:new Date().toISOString()}); if(error) throw error; setLocal(c, id, data); },
    async remove(table, id){ const c=col(table);
      const {error, count} = await sb.from("docs").delete({count:"exact"}).eq("collection", c).eq("id", id); if(error) throw error;
      if(count===0) throw {code:"42501", message:"row-level security"}; setLocal(c, id, null); },
    canUpload(){ return me.canManage; },
    async upload(file){
      const ext=(file.name.split(".").pop()||"bin").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,5)||"bin";
      const path=`${new Date().toISOString().slice(0,10)}/${rid()}.${ext}`;
      const {error} = await sb.storage.from("receipts").upload(path, file, {contentType:file.type||undefined, upsert:false}); if(error) throw error;
      return {id:path, type:file.type, name:file.name};
    },
    fileUrl(id){ return sb.storage.from("receipts").getPublicUrl(id).data.publicUrl; },
    async deleteFile(id){ try{ await sb.storage.from("receipts").remove([id]); }catch{} },
    async names(){ return {}; },
    async suggestedName(){ return ""; },
    async saveFile(filename, blob){
      const url=URL.createObjectURL(blob), a=document.createElement("a");
      a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 4000); return {status:"saved"};
    },
    isPermissionError(e){ return e?.code==="42501" || /row-level security|permission denied/i.test(e?.message||""); },
    // 이름 + PIN
    async join(name, pin){ await rpc("join_group", {p_name:name, p_pin:pin}); return refreshMe(); },
    async login(name, pin){ await rpc("login_member", {p_name:name, p_pin:pin}); return refreshMe(); },
    async logout(){ await rpc("logout_member"); return refreshMe(); },
    async changePin(oldPin, newPin){ await rpc("change_pin", {p_old:oldPin, p_new:newPin}); },
    async claimAdmin(pin){ await rpc("claim_admin", {p_admin_pin:pin}); return refreshMe(); },
    async leaveAdmin(){ await rpc("leave_admin"); return refreshMe(); },
    async resetPin(memberId){ await rpc("reset_member_pin", {p_member:memberId}); }
  };
}
