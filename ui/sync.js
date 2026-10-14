/* Sundial Sync client (protocol v1, see docs/SYNC-PROTOCOL.md).
   Documents are encrypted here with AES-256-GCM under a key derived from the user's passphrase; the server only
   ever stores ciphertext. Last writer wins per document by updated_at; tombstones carry deletions. */
'use strict';
const Sync=(()=>{
  const PROTO=1;
  const HOSTED_URL='https://sync.sundial.services';
  let key=null,timer=null,running=false,queued=false,applying=false;const listeners=[];
  const fresh=()=>({mode:'off',server:'',token:'',accountId:'',email:'',salt:'',cursor:0,dirty:{},lastSync:0,lastError:'',keyOk:false});
  const st=()=>{if(!state.sync)state.sync=fresh();if(!state.sync.dirty)state.sync.dirty={};return state.sync};
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
  async function api(path,body,method,token){const s=st();const tk=token===undefined?s.token:token;
    const r=await fetch(s.server.replace(/\/+$/,'')+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json',...(tk?{authorization:'Bearer '+tk}:{})},body:body?JSON.stringify(body):undefined});
    if(r.status===204)return null;const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}

  // ----- dirty tracking (called from data.js / ui.js on every local change) -----
  function markDirty(id){if(applying)return;const s=st();s.dirty[id]=1;if(s.mode!=='off'&&key)schedule(2000)}
  function markAllDirty(){const s=st();for(const t of state.tasks)s.dirty['task:'+t.id]=1;for(const id in state.tombstones)s.dirty['task:'+id]=1;for(const d in state.notes)s.dirty['note:'+d]=1;s.dirty.labels=1;s.dirty.routines=1}

  // ----- documents -----
  function buildDoc(did){
    if(did.startsWith('task:')){const id=did.slice(5);const t=get(id);if(t)return {kind:'task',id,updated_at:t.updatedAt||Date.now(),deleted:false,body:t};const ts=state.tombstones[id];return ts?{kind:'task',id,updated_at:ts,deleted:true,body:null}:null}
    if(did.startsWith('note:')){const d=did.slice(5);const has=!!state.notes[d];return {kind:'note',id:d,updated_at:state.notesTs[d]||Date.now(),deleted:!has,body:has?{html:state.notes[d]}:null}}
    if(did==='labels')return {kind:'labels',id:'labels',updated_at:state.labelsTs||Date.now(),deleted:false,body:state.labels};
    if(did==='routines')return {kind:'routines',id:'routines',updated_at:state.routinesTs||Date.now(),deleted:false,body:state.routines};
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
      const dirtyIds=Object.keys(s.dirty);const docs=[];
      for(const did of dirtyIds){const d=buildDoc(did);if(!d)continue;const e=d.deleted?{nonce:'',ct:''}:await enc(d.kind,d.id,d.body);docs.push({id:d.id,kind:d.kind,updated_at:d.updated_at,deleted:d.deleted,nonce:e.nonce,ct:e.ct})}
      let cursor=s.cursor||0,more=true,first=true,changed=false;
      while(more){const res=await api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor,docs:first?docs:[]});first=false;
        applying=true;try{for(const d of res.docs||[]){try{if(await applyDoc(d))changed=true}catch(e){console.warn('sync: could not apply',d.kind,d.id,e.message||e)}}}finally{applying=false}
        cursor=res.cursor;more=!!res.more}
      for(const did of dirtyIds)delete s.dirty[did];
      s.cursor=cursor;s.lastSync=Date.now();s.lastError='';save();
      if(changed&&typeof render==='function')render();
      emit('ok');return true;
    }catch(e){s.lastError=e.message||String(e);save();emit('error');return false}
    finally{running=false;if(queued){queued=false;schedule(800)}}
  }
  function schedule(ms){clearTimeout(timer);timer=setTimeout(()=>{syncNow().catch(()=>{})},ms)}

  // ----- setup flows -----
  async function health(server){const s=st();const keep=s.server;s.server=server;try{return await api('/v1/health',null,'GET','')}finally{s.server=keep}}
  async function requestCode(server,email){const s=st();s.server=(server||HOSTED_URL).trim();save();try{await api('/v1/auth/request',{email},'POST','')}catch(e){if(/self-hosted|HTTP 404/.test(e.message||''))throw new Error('Email sign-in is not switched on for this server yet');throw e}}
  async function verifyCode(email,code){const s=st();const r=await api('/v1/auth/verify',{email,code:String(code).trim(),device:{id:state.device,name:deviceName(),platform:navigator.platform}},'POST','');
    Object.assign(s,{token:r.token,accountId:r.account_id,salt:r.salt,email,mode:'hosted',plan:r.plan||'beta',cursor:0,keyOk:false,lastError:''});save()}
  async function connectSelf(server,token){const s=st();s.server=server.trim();const r=await api('/v1/account',null,'GET',token.trim());
    Object.assign(s,{token:token.trim(),accountId:r.account_id,salt:r.salt,email:'',mode:'self',plan:r.plan||'',cursor:0,keyOk:false,lastError:''});save()}
  // First device: creates the keycheck. Later devices: must decrypt it, or the passphrase is wrong.
  async function setPassphrase(pass){const s=st();if(!pass||pass.length<8)throw new Error('Use at least 8 characters');key=await deriveKey(pass,s.salt);
    const res=await api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor:0,docs:[]});const kc=(res.docs||[]).find(d=>d.kind==='keycheck');
    if(kc){let ok=false;try{const v=await dec('keycheck','keycheck',kc.nonce,kc.ct);ok=!!(v&&v.ok&&v.account===s.accountId)}catch(e){ok=false}if(!ok){key=null;throw new Error('That passphrase does not match this account')}}
    else{const e=await enc('keycheck','keycheck',{ok:true,account:s.accountId});await api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor:0,docs:[{id:'keycheck',kind:'keycheck',updated_at:Date.now(),deleted:false,nonce:e.nonce,ct:e.ct}]})}
    await storeKey();s.keyOk=true;markAllDirty();save();schedule(300);return !kc}
  async function signOut(){await forgetKey();const s=st();Object.assign(s,fresh(),{server:s.server});save();emit('ok')}
  async function deleteAccount(){await api('/v1/account',null,'DELETE');await signOut()}
  function deviceName(){return (navigator.userAgentData&&navigator.userAgentData.platform||navigator.platform||'device')+' · '+(window.SundialDesktop?'desktop':'browser')}
  const emit=ev=>listeners.forEach(f=>{try{f(ev)}catch(e){}});
  function start(){st();loadKey().then(ok=>{if(ok&&st().mode!=='off'){schedule(1500);setInterval(()=>schedule(0),5*60*1000);addEventListener('online',()=>schedule(0))}})}
  return {st,markDirty,markAllDirty,syncNow,schedule,health,requestCode,verifyCode,connectSelf,setPassphrase,signOut,deleteAccount,start,HOSTED_URL,
    hasKey:()=>!!key,isRunning:()=>running,pending:()=>Object.keys(st().dirty).length,on:f=>listeners.push(f)};
})();
