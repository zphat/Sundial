/* Sundial Sync client (protocol v1, see docs/SYNC-PROTOCOL.md).
   Documents are encrypted here with AES-256-GCM under a key derived from the user's passphrase; the server only
   ever stores ciphertext. Last writer wins per document by updated_at; tombstones carry deletions. */
'use strict';
const Sync=(()=>{
  const PROTO=1;
  const HOSTED_URL='https://sync.sundial.services';
  let key=null,timer=null,running=false,queued=false,applying=false,gen=0;const listeners=[];
  const fresh=()=>({mode:'off',server:'',token:'',accountId:'',email:'',salt:'',cursor:0,dirty:{},lastSync:0,lastError:'',keyOk:false,epoch:0,rejected:{}});
  const st=()=>{if(!state.sync)state.sync=fresh();if(!state.sync.dirty)state.sync.dirty={};if(!state.sync.rejected)state.sync.rejected={};return state.sync};
  const te=new TextEncoder(),td=new TextDecoder();
  const b64=u8=>{let s='';for(const b of u8)s+=String.fromCharCode(b);return btoa(s)};
  const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const aad=(kind,id)=>te.encode(kind+':'+id);

  // ----- key -----
  async function deriveKey(pass,saltB64){const base=await crypto.subtle.importKey('raw',te.encode(pass.normalize('NFKC')),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt:unb64(saltB64),iterations:600000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},true,['encrypt','decrypt'])}
  async function storeKey(){const raw=b64(new Uint8Array(await crypto.subtle.exportKey('raw',key)));if(window.SundialDesktop)await window.SundialDesktop.secret.set('sync:key',raw);else{st().keyInBrowser=raw;save()}}
  async function loadKey(){try{const raw=window.SundialDesktop?await window.SundialDesktop.secret.get('sync:key'):(st().keyInBrowser||null);if(raw){key=await crypto.subtle.importKey('raw',unb64(raw),{name:'AES-GCM'},true,['encrypt','decrypt']);return true}}catch(e){console.warn('sync: key load failed',e)}return false}
  async function forgetKey(){key=null;if(window.SundialDesktop)await window.SundialDesktop.secret.del('sync:key').catch(()=>{});else{delete st().keyInBrowser;save()}}
  async function enc(kind,id,obj){const nonce=crypto.getRandomValues(new Uint8Array(12));const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(kind,id)},key,te.encode(JSON.stringify(obj)));return {nonce:b64(nonce),ct:b64(new Uint8Array(ct))}}
  async function dec(kind,id,nonceB,ctB){const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(nonceB),additionalData:aad(kind,id)},key,unb64(ctB));return JSON.parse(td.decode(pt))}

  // ----- http -----
  // Errors carry the HTTP status and a message a person can act on; raw server words never reach the screen.
  function friendly(status,serverMsg,ctx){
    if(status===0)return 'Cannot reach the sync server. Check your connection and try again.';
    if(status===401)return ctx==='code'?'That code did not work. Codes last 10 minutes and work once. Send a new one.':ctx==='sync'?'Signed out of sync. Sign in again to resume.':'Not signed in.';
    if(status===429)return ctx==='code'?'Too many attempts. Wait a while, then send a new code.':'The server asked us to slow down. It will retry in a minute.';
    if(status===404&&ctx==='code')return 'Email sign-in is not switched on for this server yet.';
    if(status===503)return serverMsg||'The server could not send the email right now. Try again in a few minutes.';
    if(status>=500)return 'The sync server had a problem (HTTP '+status+'). Nothing was lost; it will retry.';
    return serverMsg||('HTTP '+status);
  }
  async function api(path,body,method,token,ctx){const s=st();const tk=token===undefined?s.token:token;let r;
    try{r=await fetch(s.server.replace(/\/+$/,'')+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json',...(tk?{authorization:'Bearer '+tk}:{})},body:body?JSON.stringify(body):undefined})}
    catch(e){const err=new Error(friendly(0,'',ctx));err.status=0;throw err}
    if(r.status===204)return null;const j=await r.json().catch(()=>({}));
    if(!r.ok){const err=new Error(friendly(r.status,j.error,ctx));err.status=r.status;throw err}return j}

  // ----- dirty tracking (called from data.js / ui.js on every local change) -----
  // Each mark carries a generation number, so an edit made while a request is in flight stays dirty afterwards.
  function markDirty(id){if(applying)return;const s=st();s.dirty[id]=++gen;delete s.rejected[id];if(s.mode!=='off'&&key)schedule(2000)}
  // Only things this device actually has: untouched defaults (labels never renamed, no routines, no note) must never
  // travel, or a brand-new second PC would overwrite the first one's.
  function markAllDirty(){const s=st();for(const t of state.tasks)s.dirty['task:'+t.id]=++gen;for(const id in state.tombstones)s.dirty['task:'+id]=++gen;
    for(const d in state.notes)if(state.notesTs[d]>0)s.dirty['note:'+d]=++gen;if(state.labelsTs>0)s.dirty.labels=++gen;if(state.routinesTs>0)s.dirty.routines=++gen}

  // ----- documents -----
  function buildDoc(did){
    if(did.startsWith('task:')){const id=did.slice(5);const t=get(id);if(t)return {kind:'task',id,updated_at:t.updatedAt||t.createdAt||0,deleted:false,body:t};const ts=state.tombstones[id];return ts?{kind:'task',id,updated_at:ts,deleted:true,body:null}:null}
    if(did.startsWith('note:')){const d=did.slice(5);const has=!!state.notes[d];const ts=state.notesTs[d]||0;if(!ts)return null;return {kind:'note',id:d,updated_at:ts,deleted:!has,body:has?{html:state.notes[d]}:null}}
    if(did==='labels'){if(!state.labelsTs)return null;return {kind:'labels',id:'labels',updated_at:state.labelsTs,deleted:false,body:state.labels}}
    if(did==='routines'){if(!state.routinesTs)return null;return {kind:'routines',id:'routines',updated_at:state.routinesTs,deleted:false,body:state.routines}}
    return null;
  }
  async function applyDoc(d){
    const body=d.deleted?null:await dec(d.kind,d.id,d.nonce,d.ct);
    if(d.kind==='task'){const loc=get(d.id);const tomb=state.tombstones[d.id]||0;
      if(d.deleted){if(loc){if((loc.updatedAt||0)>d.updated_at)return false;state.tasks=state.tasks.filter(t=>t.id!==d.id);state.tombstones[d.id]=d.updated_at;return true}if(tomb<d.updated_at){state.tombstones[d.id]=d.updated_at;return true}return false}
      if(tomb>d.updated_at)return false;
      if(!body||typeof body!=='object'||!body.id)return false;
      if(!loc){state.tasks.push(body);delete state.tombstones[d.id];return true}
      if((loc.updatedAt||0)<d.updated_at){Object.assign(loc,body);return true}
      return false}
    if(d.kind==='note'){if((state.notesTs[d.id]||0)>=d.updated_at)return false;if(d.deleted)delete state.notes[d.id];else state.notes[d.id]=body.html;state.notesTs[d.id]=d.updated_at;return true}
    if(d.kind==='labels'){if((state.labelsTs||0)>=d.updated_at)return false;Object.assign(state.labels,body);state.labelsTs=d.updated_at;return true}
    if(d.kind==='routines'){if((state.routinesTs||0)>=d.updated_at)return false;if(Array.isArray(body))state.routines=body;state.routinesTs=d.updated_at;return true}
    return false;
  }

  // ----- the sync itself -----
  async function syncNow(){const s=st();if(s.mode==='off'||!s.server||!s.token||!key)return false;
    if(running){queued=true;return false}running=true;emit('start');
    try{
      const snapshot={...s.dirty};const docs=[];
      for(const did in snapshot){const d=buildDoc(did);if(!d){delete s.dirty[did];continue}const e=d.deleted?{nonce:'',ct:''}:await enc(d.kind,d.id,d.body);docs.push({id:d.id,kind:d.kind,updated_at:d.updated_at,deleted:d.deleted,nonce:e.nonce,ct:e.ct})}
      let cursor=s.cursor||0,more=true,first=true,changed=false;
      while(more){const res=await api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor,docs:first?docs:[]},'POST',undefined,'sync');
        if(first){for(const r of res.rejected||[]){const did=(r.kind==='task'?'task:':r.kind==='note'?'note:':'')+r.id;s.rejected[did]=r.reason||'rejected'}}
        first=false;
        // The server was restored from a backup: forget our place in its history and offer everything again.
        if(res.epoch&&s.epoch&&res.epoch!==s.epoch){s.epoch=res.epoch;s.cursor=0;markAllDirty();save();running=false;return syncNow()}
        if(res.epoch)s.epoch=res.epoch;
        applying=true;try{for(const d of res.docs||[]){try{if(await applyDoc(d))changed=true}catch(e){console.warn('sync: could not apply',d.kind,d.id,e.message||e)}}}finally{applying=false}
        cursor=res.cursor;more=!!res.more}
      for(const did in snapshot)if(s.dirty[did]===snapshot[did])delete s.dirty[did];
      s.cursor=cursor;s.lastSync=Date.now();s.lastError='';save();
      if(changed&&typeof render==='function')render();
      emit('ok');return true;
    }catch(e){
      if(e.status===401){await signOutLocal('This PC was signed out of sync: the account was reset or removed. Your days are still here. Sign in again to resume.');emit('signedout');return false}
      s.lastError=e.message||String(e);save();emit('error');return false}
    finally{running=false;if(queued){queued=false;schedule(800)}}
  }
  function schedule(ms){clearTimeout(timer);timer=setTimeout(()=>{syncNow().catch(()=>{})},ms)}

  // ----- setup flows -----
  async function health(server){const s=st();const keep=s.server;s.server=server;try{return await api('/v1/health',null,'GET','')}finally{s.server=keep}}
  async function requestCode(server,email){const s=st();s.server=(server||HOSTED_URL).trim();save();await api('/v1/auth/request',{email},'POST','','code')}
  async function verifyCode(email,code){const s=st();const r=await api('/v1/auth/verify',{email,code:String(code).replace(/\D/g,''),device:{id:state.device,name:deviceName(),platform:navigator.platform}},'POST','','code');
    Object.assign(s,{token:r.token,accountId:r.account_id,salt:r.salt,email,mode:'hosted',plan:r.plan||'beta',cursor:0,keyOk:false,lastError:'',epoch:0,rejected:{}});save()}
  async function connectSelf(server,token){const s=st();s.server=server.trim();const r=await api('/v1/account',null,'GET',token.trim());
    Object.assign(s,{token:token.trim(),accountId:r.account_id,salt:r.salt,email:'',mode:'self',plan:r.plan||'',cursor:0,keyOk:false,lastError:'',epoch:0,rejected:{}});save()}
  // Does this account already have a passphrase (a keycheck document)? Decides between "create" and "enter".
  async function checkAccount(){const res=await api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor:0,docs:[]},'POST',undefined,'sync');return {existing:!!(res.docs||[]).find(d=>d.kind==='keycheck'),docs:(res.docs||[]).length}}
  // First device: creates the keycheck. Later devices: must decrypt it, or the passphrase is wrong.
  async function setPassphrase(pass){const s=st();if(!pass||pass.length<8)throw new Error('Use at least 8 characters');key=await deriveKey(pass,s.salt);
    const res=await api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor:0,docs:[]},'POST',undefined,'sync');const kc=(res.docs||[]).find(d=>d.kind==='keycheck');
    if(kc){let ok=false;try{const v=await dec('keycheck','keycheck',kc.nonce,kc.ct);ok=!!(v&&v.ok&&v.account===s.accountId)}catch(e){ok=false}if(!ok){key=null;throw new Error('That is not the passphrase for this account. Check Caps Lock and try again.')}
      // Joining an account that already has days in it: the starter examples of a fresh install must not travel.
      state.tasks=state.tasks.filter(t=>!t.example);}
    else{const e=await enc('keycheck','keycheck',{ok:true,account:s.accountId});await api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor:0,docs:[{id:'keycheck',kind:'keycheck',updated_at:Date.now(),deleted:false,nonce:e.nonce,ct:e.ct}]},'POST',undefined,'sync')}
    await storeKey();s.keyOk=true;s.cursor=0;markAllDirty();save();schedule(300);return !kc}
  async function signOutLocal(msg){await forgetKey();const s=st();Object.assign(s,fresh(),{server:s.server,lastError:msg||''});save()}
  async function signOut(){const s=st();if(s.mode==='hosted'&&s.token){try{await api('/v1/auth/logout',{},'POST')}catch(e){}}await signOutLocal('');emit('ok')}
  // Erases the synced copy (every document, every device's access). Local data on every PC stays.
  async function deleteAccount(code){const s=st();await api('/v1/account',s.mode==='hosted'?{code:String(code||'').replace(/\D/g,'')}:null,'DELETE',undefined,'code');await signOutLocal('');emit('ok')}
  function deviceName(){return (navigator.userAgentData&&navigator.userAgentData.platform||navigator.platform||'device')+' · '+(window.SundialDesktop?'desktop':'browser')}
  const emit=ev=>listeners.forEach(f=>{try{f(ev)}catch(e){}});
  function start(){st();loadKey().then(ok=>{if(ok&&st().mode!=='off'){schedule(1500);setInterval(()=>schedule(0),5*60*1000);addEventListener('online',()=>schedule(0))}})}
  return {st,markDirty,markAllDirty,syncNow,schedule,health,requestCode,verifyCode,connectSelf,checkAccount,setPassphrase,signOut,deleteAccount,start,HOSTED_URL,
    hasKey:()=>!!key,isRunning:()=>running,pending:()=>Object.keys(st().dirty).length,rejected:()=>Object.keys(st().rejected).length,on:f=>listeners.push(f)};
})();
