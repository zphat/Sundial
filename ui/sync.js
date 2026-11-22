/* Sundial Sync client (protocol v1, see docs/SYNC-PROTOCOL.md).
   Documents are encrypted here with AES-256-GCM under an account key the server never sees; the server only ever
   stores ciphertext. Last writer wins per document by updated_at; tombstones carry deletions.
   The account key comes from a secret the user holds: a recovery code the app invents on the first PC (or a
   passphrase they typed in older versions). A new PC gets the key either from that secret, or from an existing PC
   that approves it: a commit-then-reveal ECDH handshake relayed through the server as plaintext "pair" documents,
   confirmed by a short code the person compares on both screens. */
'use strict';
const Sync=(()=>{
  const PROTO=1;
  const HOSTED_URL='https://sync.sundial.services';
  const PAIR_TTL=15*60*1000,PAIR_UNOPENED=2*60*1000,PAIR_INFO='sundial-pair-1';
  let key=null,timer=null,running=false,queued=false,gen=0,machine='';const listeners=[];
  // Listening: a server that says `wait: true` holds an empty request until another device writes (25 s at most), so
  // a change made elsewhere arrives within a second instead of at the next 10-second check. canWait: the server said
  // so. listening: the request in flight is such a held one. listenOff: no listening before this time (a server that
  // answered a held request at once is not really holding). skew: the server's clock minus this device's, in ms.
  const WAIT_SECS=25;let canWait=false,listening=false,listenAbort=null,listenCancelled=false,listenT=null,listenOff=0,skew=null,lastSaved=0;
  // switching: an account change is under way, no sync may start. pendingServer: where a signed-in device asked for a code.
  let switching=false,pendingServer='';
  // slowUntil: after a 429 every pairing loop here runs at the slow cadence and the regular tick sits out until then.
  // kcCache: the account's keycheck document for the current sign-in (write-once at one id, so a copy stays true).
  let pairing=null,approvalTimer=null,slowUntil=0,kcCache=null;const pairReqs={};const pairSeen={};const ownPairIds={};
  const fresh=()=>({mode:'off',server:'',token:'',accountId:'',email:'',salt:'',cursor:0,dirty:{},lastSync:0,lastError:'',keyOk:false,epoch:0,rejected:{}});
  const st=()=>{if(!state.sync)state.sync=fresh();if(!state.sync.dirty)state.sync.dirty={};if(!state.sync.rejected)state.sync.rejected={};return state.sync};
  const te=new TextEncoder(),td=new TextDecoder();
  const b64=u8=>{let s='';for(const b of u8)s+=String.fromCharCode(b);return btoa(s)};
  const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const aad=(kind,id)=>te.encode(kind+':'+id);
  const sha256=async bytes=>new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const cat=(...parts)=>{const n=parts.reduce((a,p)=>a+p.length,0);const out=new Uint8Array(n);let o=0;for(const p of parts){out.set(p,o);o+=p.length}return out};

  // ----- the secret: recovery code or passphrase -----
  const RC_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  // 20 characters from an alphabet without look-alikes, shown as four groups: about 99 bits. Rejection-sampled, so every character is equally likely.
  function makeRecoveryCode(){let s='';while(s.length<20){for(const b of crypto.getRandomValues(new Uint8Array(32))){if(b<248&&s.length<20)s+=RC_ALPHABET[b%31]}}return s.match(/.{5}/g).join('-')}
  // A typed recovery code is forgiven its case, spaces and dashes. Anything else is a passphrase. (unlockWith also
  // tries the raw text, so a passphrase that happens to look like a code still works.)
  function normalizeSecret(s){const t=String(s||'').trim();const bare=t.toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(bare.length===20&&[...bare].every(c=>RC_ALPHABET.includes(c)))return bare.match(/.{5}/g).join('-');return t}
  const looksLikeCode=s=>/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(s);
  async function secretSet(name,value){if(window.SundialDesktop)await window.SundialDesktop.secret.set(name,value);else{st()[name.replace(':','_')]=value;save()}}
  async function secretGet(name){try{if(window.SundialDesktop)return await window.SundialDesktop.secret.get(name);return st()[name.replace(':','_')]||null}catch(e){return null}}
  async function secretDel(name){if(window.SundialDesktop)await window.SundialDesktop.secret.del(name).catch(()=>{});else{delete st()[name.replace(':','_')];save()}}

  // ----- key -----
  async function deriveKey(pass,saltB64){const base=await crypto.subtle.importKey('raw',te.encode(pass.normalize('NFKC')),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt:unb64(saltB64),iterations:600000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},true,['encrypt','decrypt'])}
  const rawOf=async k=>b64(new Uint8Array(await crypto.subtle.exportKey('raw',k)));
  const keyFromRaw=raw=>crypto.subtle.importKey('raw',unb64(raw),{name:'AES-GCM'},true,['encrypt','decrypt']);
  async function storeKey(k){await secretSet('sync:key',await rawOf(k))}
  async function loadKey(){try{const raw=await secretGet('sync:key');if(raw){key=await keyFromRaw(raw);return true}}catch(e){console.warn('sync: key load failed',e)}return false}
  // A plain sign-out keeps the recovery code on this PC, so signing back in here needs nothing; only leaving the
  // account for good (deletion, or the account being reset elsewhere) forgets it.
  async function forgetKey(all){key=null;await secretDel('sync:key');if(all)await secretDel('sync:recovery')}
  async function encWith(k,kind,id,obj){const nonce=crypto.getRandomValues(new Uint8Array(12));const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(kind,id)},k,te.encode(JSON.stringify(obj)));return {nonce:b64(nonce),ct:b64(new Uint8Array(ct))}}
  async function decWith(k,kind,id,nonceB,ctB){const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(nonceB),additionalData:aad(kind,id)},k,unb64(ctB));return JSON.parse(td.decode(pt))}
  const enc=(kind,id,obj)=>encWith(key,kind,id,obj);
  const dec=(kind,id,n,c)=>decWith(key,kind,id,n,c);
  // Does this key open the account? The keycheck document was written by whoever set the account up.
  async function keyOpens(k,kc){const s=st();if(!kc)return false;try{const v=await decWith(k,'keycheck','keycheck',kc.nonce,kc.ct);return !!(v&&v.ok&&v.account===s.accountId)}catch(e){return false}}

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
  // server: another base URL than the one signed in to (asking a code of, or signing out from, a server we are not on yet / any more).
  // A request gets 30 seconds, then counts as unreachable, so one that never answers cannot hold a sync open for good.
  // An answer that says 200 but is not JSON (a hotel Wi-Fi sign-in page) is unreachable too, never an empty success.
  async function api(path,body,method,token,ctx,server,opt){const s=st();const tk=token===undefined?s.token:token;let r,j;
    const unreachable=()=>{const err=new Error(friendly(0,'',ctx));err.status=0;return err};
    const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),(opt&&opt.timeout)||30000);if(opt&&opt.abortable)opt.abortable(ac);
    const text=body?JSON.stringify(body):undefined;
    try{
      try{r=await fetch(String(server||s.server).replace(/\/+$/,'')+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json',...(tk?{authorization:'Bearer '+tk}:{})},body:text,signal:ac.signal,
        // a phone freezes a page moments after it is hidden: a small request marked keepalive is allowed to finish
        keepalive:document.hidden&&!!text&&text.length<60000})}
      catch(e){throw unreachable()}
      if(r.status===204)return null;
      try{j=await r.json()}catch(e){if(r.ok)throw unreachable();j={}}
    }finally{clearTimeout(tm)}
    if(!j||typeof j!=='object')j={};
    if(!r.ok){const err=new Error(friendly(r.status,j.error,ctx));err.status=r.status;throw err}return j}
  // wait: seconds the server may hold the request while nothing is new (only sent when there is nothing to push)
  const pull=(cursor,docs,wait)=>api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor:cursor||0,docs:docs||[],...(wait?{wait}:{})},'POST',undefined,'sync',undefined,
      wait?{timeout:(wait+12)*1000,abortable:ac=>{listenAbort=ac}}:undefined)
    .then(res=>{if(!res||typeof res.cursor!=='number'||!Array.isArray(res.docs)){const e=new Error('The sync server sent an answer Sundial does not understand. Nothing was changed; it will retry.');e.status=0;throw e}return res});
  // The keycheck cannot be tombstoned or change kind (the server rejects exists/id/kind), so one found under this
  // server, account and token is cached for the sign-in: a new sign-in or a deleted account means a new token and a
  // miss. Only a found document is cached, never a null.
  const findKeycheck=async()=>{const s=st();const acct=s.server+'|'+s.accountId+'|'+s.token;if(kcCache&&kcCache.acct===acct)return kcCache.doc;
    let cursor=0;for(let i=0;i<40;i++){const res=await pull(cursor,[]);const kc=(res.docs||[]).find(d=>d.kind==='keycheck'&&d.id==='keycheck'&&!d.deleted);if(kc){kcCache={acct,doc:kc};return kc}if(!res.more)return null;cursor=res.cursor}return null};
  const slowOn=e=>{if(e&&e.status===429)slowUntil=Date.now()+SLOW_FOR};

  // ----- dirty tracking (called from data.js / ui.js on every local change) -----
  // Each mark carries a generation number, so an edit made while a request is in flight stays dirty afterwards.
  // (Nothing on the apply path calls this, so there is no "applying" guard: one would drop the user's own edits made
  // while pulled documents are being decrypted.)
  // (sent 0.6 s after the last change when the server pushes news to the other devices at once, 2 s otherwise)
  function markDirty(id){const s=st();s.dirty[id]=++gen;delete s.rejected[id];if(s.mode!=='off'&&key)schedule(canWait?600:2000)}
  // Only things this device actually has: untouched defaults (labels never renamed, no routines, no note) must never
  // travel, or a brand-new second PC would overwrite the first one's.
  function markAllDirty(){const s=st();for(const t of state.tasks){if(!t.example)s.dirty['task:'+t.id]=++gen}for(const id in state.tombstones)s.dirty['task:'+id]=++gen;
    for(const d in state.notes)if(state.notesTs[d]>0)s.dirty['note:'+d]=++gen;if(state.labelsTs>0)s.dirty.labels=++gen;if(state.routinesTs>0)s.dirty.routines=++gen}

  // ----- documents -----
  function buildDoc(did){
    if(did.startsWith('task:')){const id=did.slice(5);const t=get(id);if(t&&t.example)return null;if(t)return {kind:'task',id,updated_at:t.updatedAt||t.createdAt||0,deleted:false,body:t};const ts=state.tombstones[id];return ts?{kind:'task',id,updated_at:ts,deleted:true,body:null}:null}
    if(did.startsWith('note:')){const d=did.slice(5);const has=!!state.notes[d];const ts=state.notesTs[d]||0;if(!ts)return null;return {kind:'note',id:d,updated_at:ts,deleted:!has,body:has?{html:state.notes[d]}:null}}
    if(did==='labels'){if(!state.labelsTs)return null;return {kind:'labels',id:'labels',updated_at:state.labelsTs,deleted:false,body:state.labels}}
    if(did==='routines'){if(!state.routinesTs)return null;return {kind:'routines',id:'routines',updated_at:state.routinesTs,deleted:false,body:state.routines}}
    return null;
  }
  async function applyDoc(d){
    if(d.kind==='pair'){notePair(d);return false}
    if(d.kind==='keycheck'){if(d.deleted||d.id!=='keycheck')return false;   // the key lives at one id and is never withdrawn
      // another PC replaced the account's key under us (two first-time setups at once, or a reset): stop writing with the wrong key
      if(!(await keyOpens(key,d))){await lostKey('Another PC set this account up with a different key. Approve this PC from it, or enter its recovery code.')}
      return false}
    const body=d.deleted?null:await dec(d.kind,d.id,d.nonce,d.ct);
    // What another device wrote is held to the same shapes as an import (cleanTask, cleanNote): it goes into markup.
    // Every task changed here is noted for undo (noteRemote), so a later Ctrl+Z leaves it alone.
    if(d.kind==='task'){const loc=get(d.id);const tomb=state.tombstones[d.id]||0;
      if(d.deleted){if(loc){if((loc.updatedAt||0)>d.updated_at)return false;state.tasks=state.tasks.filter(t=>t.id!==d.id);state.tombstones[d.id]=d.updated_at;noteRemote(d.id);return true}if(tomb<d.updated_at){state.tombstones[d.id]=d.updated_at;return true}return false}
      if(tomb>d.updated_at)return false;
      const t=cleanTask(body);if(!t||t.id!==d.id)return false;
      if(!loc){state.tasks.push(t);delete state.tombstones[d.id];noteRemote(d.id);return true}
      if((loc.updatedAt||0)<d.updated_at){for(const k in loc)delete loc[k];Object.assign(loc,t);noteRemote(d.id);return true}
      return false}
    if(d.kind==='note'){if(!DATE_RE.test(d.id)||(state.notesTs[d.id]||0)>=d.updated_at)return false;if(d.deleted)delete state.notes[d.id];else{if(!body||typeof body.html!=='string')return false;state.notes[d.id]=typeof cleanNote==='function'?cleanNote(body.html):body.html}state.notesTs[d.id]=d.updated_at;return true}
    if(d.kind==='labels'){if((state.labelsTs||0)>=d.updated_at||!body||typeof body!=='object')return false;for(const [k] of COLORS){if(typeof body[k]==='string'&&body[k].trim())state.labels[k]=body[k].slice(0,40)}state.labelsTs=d.updated_at;return true}
    if(d.kind==='routines'){if((state.routinesTs||0)>=d.updated_at)return false;
      if(Array.isArray(body))state.routines=body.filter(r=>r&&typeof r==='object'&&typeof r.id==='string'&&ID_RE.test(r.id)).map(r=>({id:r.id,name:typeof r.name==='string'?r.name:'Routine',lines:(Array.isArray(r.lines)?r.lines:[]).filter(l=>typeof l==='string')}));
      state.routinesTs=d.updated_at;return true}
    return false;
  }
  async function lostKey(msg){const s=st();await forgetKey(false);s.keyOk=false;s.lastError=msg;save();emit('lostkey',msg)}

  // ----- the sync itself -----
  // listen: nothing to send, so ask the server to hold the request until there is news (see WAIT_SECS above).
  async function syncNow(listen){const s=st();if(switching||s.mode==='off'||!s.server||!s.token||!key)return false;
    // a sync that has something to do does not queue behind a request that is only listening: that one is let go
    if(running){if(listening&&!listen)stopListening();if(!listen)queued=true;return false}running=true;
    const wait=listen&&canWait&&!Object.keys(s.dirty).length?WAIT_SECS:0;listening=wait>0;listenCancelled=false;if(!listening)emit('start');
    const began=Date.now();let ok=false,news=false,after=null;
    try{
      const snapshot={...s.dirty};const docs=[];
      for(const did in snapshot){const d=buildDoc(did);if(!d){delete s.dirty[did];continue}const e=d.deleted?{nonce:'',ct:''}:await enc(d.kind,d.id,d.body);docs.push({id:d.id,kind:d.kind,updated_at:d.updated_at,deleted:d.deleted,nonce:e.nonce,ct:e.ct})}
      // One request carries about 2 MB of documents at most (the server takes 8), so a long spell offline still syncs.
      const batches=[];{let cur=[],size=0;for(const d of docs){const n=d.ct.length+300;if(cur.length&&(size+n>2e6||cur.length>=300)){batches.push(cur);cur=[];size=0}cur.push(d);size+=n}if(cur.length)batches.push(cur)}
      let cursor=s.cursor||0,more=true,bi=0,changed=false;
      while(more||bi<batches.length){const t0=Date.now();const res=await pull(cursor,batches[bi]||[],listening&&bi===0?wait:0);
        canWait=res.wait===true;
        // the server's clock against this one, from a request that was answered at once (a held one says nothing about latency)
        if(typeof res.now==='number'&&!listening)skew=res.now-(t0+Date.now())/2;
        if(bi<batches.length){for(const r of res.rejected||[]){const did=(r.kind==='task'?'task:':r.kind==='note'?'note:':'')+r.id;s.rejected[did]=r.reason||'rejected'}}
        bi++;
        // The server was restored from a backup: forget our place in its history and offer everything again.
        if(res.epoch&&s.epoch&&res.epoch!==s.epoch){s.epoch=res.epoch;s.cursor=0;kcCache=null;markAllDirty();save();running=false;return await syncNow()}
        if(res.epoch)s.epoch=res.epoch;
        for(const d of res.docs){try{if(await applyDoc(d))changed=true}catch(e){console.warn('sync: could not apply',d.kind,d.id,e.message||e)}}
        if(!key)return false;
        cursor=res.cursor;more=!!res.more}
      for(const did in snapshot)if(s.dirty[did]===snapshot[did])delete s.dirty[did];
      // A check that found nothing changes nothing worth writing: the state is saved when something moved, and
      // otherwise every five minutes so the "last synced" time on disk is never far behind.
      news=changed||cursor!==(s.cursor||0)||docs.length>0;const moved=news||!!s.lastError;
      s.cursor=cursor;s.lastSync=Date.now();s.lastError='';if(moved||Date.now()-lastSaved>300000){save();lastSaved=Date.now()}
      // not under a field someone is typing in: the redraw waits until they leave it (renderWhenIdle in ui.js)
      if(changed){if(typeof renderWhenIdle==='function')renderWhenIdle();else if(typeof render==='function')render()}
      ok=true;if(!listening||moved)after='ok';return true;
    }catch(e){
      if(listening&&listenCancelled)return false;   // let go on purpose: something here needs sending
      if(e.status===401){await signOutLocal('This '+(window.SundialDesktop?'PC':'device')+' was signed out of sync: from another device, or because the account was reset or removed. Your days are still here. Sign in again to resume.',false);emit('signedout');return false}
      slowOn(e);s.lastError=e.message||String(e);save();after='error';return false}
    finally{const was=listening;running=false;listening=false;listenAbort=null;
      // told only now, so whoever redraws the status line no longer sees a sync in flight
      if(after)emit(after);
      // a held request that came straight back with nothing: this server is not holding, so fall back to the 10-second check for a while
      if(was&&ok&&!news&&Date.now()-began<2000)listenOff=Date.now()+5*60000;
      if(queued){queued=false;schedule(was?0:800)}else if(ok)listenSoon(was?50:400)}
  }
  function schedule(ms){clearTimeout(timer);timer=setTimeout(()=>{timer=null;syncNow().catch(()=>{})},ms)}
  const shouldListen=()=>canWait&&ticking&&!!key&&!switching&&!document.hidden&&!approvalTimer&&!pairing&&navigator.onLine!==false&&Date.now()>=slowUntil&&Date.now()>=listenOff;
  // after every finished sync: listen again, unless something is waiting to be sent (its own timer is running)
  function listenSoon(ms){clearTimeout(listenT);listenT=setTimeout(()=>{listenT=null;if(shouldListen()&&!running&&timer==null&&!Object.keys(st().dirty).length)syncNow(true).catch(()=>{})},ms)}
  function stopListening(){if(listening&&listenAbort){listenCancelled=true;try{listenAbort.abort()}catch(e){}}}

  // ----- setup flows -----
  async function health(server){const s=st();const keep=s.server;s.server=server;try{return await api('/v1/health',null,'GET','')}finally{s.server=keep}}
  const trimUrl=u=>String(u||'').trim().replace(/\/+$/,'');
  const sameServer=(a,b)=>trimUrl(a).toLowerCase()===trimUrl(b).toLowerCase();
  // A device that is signed out takes the server at once. One that is signed in keeps its server and token until the
  // new sign-in has worked (signInByEmailKeepingKey), so a wrong code or a dead network leaves it as it was.
  async function requestCode(server,email){const s=st();const url=(server||HOSTED_URL).trim();
    if(s.mode==='off'){s.server=url;save();pendingServer=''}else pendingServer=sameServer(url,s.server)?'':url;
    await api('/v1/auth/request',{email},'POST','','code',url)}
  // The one verify request both sign-in paths send; the desktop's name is the machine name when the shell has told us it.
  const verifyRequest=(email,code,server)=>api('/v1/auth/verify',{email,code:String(code).replace(/\D/g,''),device:{id:state.device,name:deviceName(),platform:navigator.platform}},'POST','','code',server);
  async function verifyCode(email,code){const s=st();await ensureMachine();const server=pendingServer||s.server||HOSTED_URL;const r=await verifyRequest(email,code,server);
    Object.assign(s,{server,token:r.token,accountId:r.account_id,salt:r.salt,email,mode:'hosted',plan:r.plan||'beta',cursor:0,keyOk:false,lastError:'',epoch:0,rejected:{}});pendingServer='';save()}
  async function connectSelf(server,token){const s=st();s.server=server.trim();const r=await api('/v1/account',null,'GET',token.trim());
    Object.assign(s,{token:token.trim(),accountId:r.account_id,salt:r.salt,email:'',mode:'self',plan:r.plan||'',cursor:0,keyOk:false,lastError:'',epoch:0,rejected:{}});save()}
  // Does this account already have a key (a keycheck document)? Decides between "first PC" and "another PC".
  async function checkAccount(){const kc=await findKeycheck();return {existing:!!kc}}
  // Everything that follows a confirmed key: keep it, remember the code if we have one, offer this PC's days.
  async function adopt(k,code,joining){const s=st();await storeKey(k);if(code)await secretSet('sync:recovery',code);key=k;startTicking();
    if(joining)state.tasks=state.tasks.filter(t=>!t.example);
    s.keyOk=true;s.cursor=0;s.lastError='';markAllDirty();save();schedule(300)}
  // Unlock with the recovery code or a passphrase. The key is derived into a local and only kept once it has proven
  // itself; a failed attempt leaves nothing behind. On a brand-new account this creates the keycheck.
  async function unlockWith(secret){const s=st();await cancelPairing();const raw=String(secret||'');const pass=normalizeSecret(raw);
    if(!pass)throw new Error('Enter the recovery code first');if(pass.length<8)throw new Error('Use at least 8 characters');
    const kc=await findKeycheck();
    if(kc){let k=await deriveKey(pass,s.salt);let ok=await keyOpens(k,kc);
      if(!ok&&raw!==pass){k=await deriveKey(raw,s.salt);ok=await keyOpens(k,kc)}
      if(!ok)throw new Error('That is not the recovery code or passphrase for this account. Check it and try again.');
      await adopt(k,looksLikeCode(pass)?pass:null,true);return false}
    const k=await deriveKey(pass,s.salt);await createKeycheck(k);await adopt(k,looksLikeCode(pass)?pass:null,false);return true}
  async function createKeycheck(k){const e=await encWith(k,'keycheck','keycheck',{ok:true,account:st().accountId});
    const res=await pull(0,[{id:'keycheck',kind:'keycheck',updated_at:Date.now(),deleted:false,nonce:e.nonce,ct:e.ct}]);
    if((res.rejected||[]).some(r=>r.id==='keycheck')){const err=new Error('Another PC set this account up a moment ago. Approve this PC from it.');err.raced=true;throw err}}
  // First PC: invent the secret, prove the key, keep both, start syncing. Returns the code to show once.
  async function setupFirst(){const s=st();const code=makeRecoveryCode();const k=await deriveKey(code,s.salt);await createKeycheck(k);await adopt(k,code,false);return code}
  const recoveryCode=()=>secretGet('sync:recovery');

  // ----- signing in by email on a device that already holds a key -----
  // A PC that has synced with a static token (or with another email) signs in with an email and keeps what it has.
  // Three outcomes, told apart by the account's keycheck:
  //   'same'      it opens with the key this PC holds (the operator attached the email to the old account, or it is the
  //               same account): same days, same key; cursor 0 and everything dirty, so both sides merge in full.
  //   'new'       the account is brand new. This PC sets it up. The account's salt is new, and the key is PBKDF2(code,
  //               salt), so a key kept as it is would leave the recovery code this PC shows unable to open the account.
  //               So the key is derived again from the recovery code this PC holds when that code really derives the
  //               current key; failing that, a fresh code is invented and returned, to be shown once. The account is
  //               empty, so nothing on the server needs the old key; everything local is offered under the new one.
  //   'mismatch'  the account was set up elsewhere with another key. This PC is now a second device waiting for approval
  //               (keyOk false, key forgotten like a plain sign-out: the recovery code stays), and the usual UI takes over.
  //   'fresh'     no key was loaded; the ordinary sign-in ran instead.
  // Nothing changes until the new token has answered; a failure before that puts server, token and mode back. The old
  // token is signed out only once this PC syncs under the new one.
  const ACCOUNT_FIELDS=['server','token','accountId','salt','email','mode','plan','cursor','keyOk','epoch','rejected','lastError'];
  async function signInByEmailKeepingKey(email,code){const s=st();
    if(!key){await verifyCode(email,code);return {how:'fresh',code:null}}
    await ensureMachine();const server=pendingServer||s.server;
    const r=await verifyRequest(email,code,server);   // a wrong code or no network: nothing has changed yet
    const prev={};for(const f of ACCOUNT_FIELDS)prev[f]=s[f];
    // switching is held for the whole switch and released in the finally, whatever rejects: a secret-store call that
    // fails after the keycheck block must not leave every later syncNow() returning false until a restart.
    try{
      await quiesce();await cancelPairing();
      let how='mismatch',newCode=null,k2=null;
      try{
        Object.assign(s,{server,token:r.token,accountId:r.account_id,salt:r.salt,email,mode:'hosted',plan:r.plan||'beta',cursor:0,keyOk:false,lastError:'',epoch:0,rejected:{}});
        let kc=await findKeycheck();
        if(!kc){
          const rc=await secretGet('sync:recovery');
          if(looksLikeCode(rc||'')){try{if(await rawOf(await deriveKey(rc,prev.salt))===await rawOf(key))k2=await deriveKey(rc,r.salt)}catch(e){k2=null}}
          if(!k2){newCode=makeRecoveryCode();k2=await deriveKey(newCode,r.salt)}
          try{await createKeycheck(k2);how='new'}
          catch(e){if(!e.raced)throw e;k2=null;newCode=null;kc=await findKeycheck();if(!kc)throw e}}   // another device set it up in between: judge its key
        if(kc)how=(await keyOpens(key,kc))?'same':'mismatch';
      }catch(e){Object.assign(s,prev);save();logoutToken(server,r.token);schedule(0);throw e}   // back as it was; quiesce cleared the timer, so re-arm it
      forgetPairs();pendingServer='';
      if(how==='mismatch'){await forgetKey(false);s.keyOk=false;save();return {how,code:null}}
      if(how==='new'){await storeKey(k2);if(newCode)await secretSet('sync:recovery',newCode);key=k2}
      s.keyOk=true;s.cursor=0;s.lastError='';markAllDirty();save();
      if(prev.token&&prev.token!==s.token)logoutToken(prev.server,prev.token);   // only now: the new token has worked
      schedule(300);emit('ok');return {how,code:newCode}
    }finally{switching=false}}
  // Hold new syncs and let one in flight finish, so a change of account never races a request made against the old one.
  async function quiesce(){switching=true;clearTimeout(timer);timer=null;clearTimeout(listenT);queued=false;stopListening();for(let i=0;i<300&&running;i++)await new Promise(res=>setTimeout(res,100))}
  // Best effort: a static token comes back when the server restarts anyway, and a failure here changes nothing for the user.
  const logoutToken=(server,token)=>(!server||!token)?Promise.resolve():api('/v1/auth/logout',{},'POST',token,undefined,server).catch(()=>{});
  // The desktop that has synced with a static token against the hosted server since before email sign-in existed.
  const isSelfOnHosted=()=>{const s=st();return s.mode==='self'&&sameServer(s.server,HOSTED_URL)};

  // ----- approving another PC -----
  // Commit-then-reveal on both sides, prompts that cannot be harvested silently, and a finish code that only the real
  // PC can show. Messages are plaintext "pair" documents the server relays; responder documents carry the responder's
  // device id so several unlocked PCs cannot overwrite each other.
  //   1. new PC  -> pair:<id>              {t:'req',    commit: SHA-256(P_new), name}
  //   2. old PC  -> pair:<id>:ack:<dev>    {t:'ack',    commit: SHA-256(P_old)}   only a PC that can show a prompt volunteers
  //   3. new PC  -> pair:<id>:open         {t:'open',   pub: P_new, to: <dev>}    binds to the first ack it saw
  //   4. old PC <dev> checks the req commit, shows the prompt and, in the same breath, -> pair:<id>:reveal:<dev> {t:'reveal', pub: P_old}
  //      Both show SAS = SHA-256(info|id|P_new|P_old) mod 10000. One prompt at a time; later requests wait their turn.
  //   5. new PC checks the reveal against the ack commit, shows the code. The person types that code on the old PC to
  //      approve (or compares and clicks), then the old PC -> pair:<id>:grant:<dev> {t:'grant', iv, wrapped}:
  //      AES-GCM(HKDF(ECDH, info|id|P_new|P_old), aad 'pair:<id>') over {k: account key, rc: recovery code},
  //      and shows a finish code FIN = SHA-256('sundial-pair-done'|id|K|P_new|P_old) mod 10000.
  //   6. new PC unwraps, proves the key against the keycheck, computes FIN itself and asks the person to type the
  //      code their other PC shows. A match means the real PC approved this exact exchange; only then is the key kept.
  // Cadence. Both loops poll every PAIR_FAST only inside a bounded window, PAIR_POLL otherwise, and the server allows
  // 60 /v1/sync hits per minute per token+device (refused hits count too). Worst minute per device:
  //   approving PC, hot:   watch tick at 2 s = 30 syncs (one request per tick; the tick skips while a sync runs, and the
  //                        regular 10 s tick yields while the loop lives) + direct pushes ack, reveal, grant, deny = 34
  //   approving PC, slow:  12 + 4 = 16;  idle: 6 visible, 1 hidden
  //   asking PC, fast:     poll at 2 s after each completed poll = 30 at most + open 1 + tombstones 1 = 32 (35 with a
  //                        cold keycheck lookup); slow: 12; it has no key, so no regular sync runs beside it
  // Headroom of 25 or more under the cap; a 429 drops both sides to PAIR_POLL for SLOW_FOR.
  // FAST_FOR bounds the asker: two minutes from the start (covers the approver's 10 s poll and the walk to the other
  // PC) and two minutes from the moment the code is shown (the grant arrives in that window). HOT_FOR bounds the
  // approver to 90 s after each step the other side answers (ack, prompt, approval), so a prompt nobody acts on for
  // the full PAIR_TTL costs 45 fast requests, not 450.
  const PAIR_DONE='sundial-pair-done',REVEAL_CAP=5,REVEAL_WINDOW=60*60*1000,FIN_TTL=5*60*1000,PAIR_POLL=5000,PAIR_FAST=2000,FAST_FOR=2*60*1000,HOT_FOR=90*1000,SLOW_FOR=60*1000;
  const plain=obj=>b64(te.encode(JSON.stringify(obj)));
  const unplain=ct=>{try{return JSON.parse(td.decode(unb64(ct)))}catch(e){return null}};
  const ecdhKeys=()=>crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const ecdhPub=async kp=>b64(new Uint8Array(await crypto.subtle.exportKey('raw',kp.publicKey)));
  const commitOf=async pubB64=>b64(await sha256(unb64(pubB64)));
  const fourDigits=h=>{const n=new DataView(h.buffer).getUint32(0)%10000;return String(n).padStart(4,'0').replace(/(\d\d)(\d\d)/,'$1 $2')};
  async function sas(id,pubNew,pubOld){return fourDigits(await sha256(cat(te.encode(PAIR_INFO+'|'+id+'|'),unb64(pubNew),te.encode('|'),unb64(pubOld))))}
  async function finCode(id,rawKeyB64,pubNew,pubOld){return fourDigits(await sha256(cat(te.encode(PAIR_DONE+'|'+id+'|'),unb64(rawKeyB64),te.encode('|'),unb64(pubNew),te.encode('|'),unb64(pubOld))))}
  async function pairKey(myPriv,peerPubB64,id,pubNew,pubOld){const peer=await crypto.subtle.importKey('raw',unb64(peerPubB64),{name:'ECDH',namedCurve:'P-256'},true,[]);
    const bits=await crypto.subtle.deriveBits({name:'ECDH',public:peer},myPriv,256);
    const hk=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
    const info=cat(te.encode(PAIR_INFO+'|'+id+'|'),unb64(pubNew),te.encode('|'),unb64(pubOld));
    return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(0),info},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
  // Tombstones for another PC's document must sort after it, whatever that PC's clock said.
  const pairDoc=(id,obj,deleted,after)=>({id,kind:'pair',updated_at:Math.max(Date.now(),(after||0)+1),deleted:!!deleted,nonce:'',ct:deleted?'':plain(obj)});
  // pair:<id> | pair:<id>:open | pair:<id>:(ack|reveal|grant):<dev>
  function parsePairId(full){const m=/^(pair:[^:]+)(?::(open|ack|reveal|grant)(?::(.+))?)?$/.exec(full);return m?{id:m[1],kind:m[2]||'req',dev:m[3]||null}:null}
  // Names come from the other side: no digits (nothing may imitate a code), short, and shown small.
  const cleanName=n=>String(n||'').replace(/\d[\d\s]*/g,'').replace(/\s+/g,' ').trim().slice(0,40)||'another PC';
  let promptable=()=>true,promptHook=null;const reveals=[];let warned=false;
  const prompted=()=>Object.values(pairReqs).find(r=>r.sas&&!r.done);
  function notePair(d){
    const q=parsePairId(d.id);if(!q)return;const {id,kind,dev}=q;
    if(ownPairIds[id]){if(pairing&&pairing.id===id)return pairingSaw(d,kind,dev);return}
    if(d.deleted){if(kind==='req'&&pairReqs[id]){const r=pairReqs[id];pairSeen[id]=1;delete pairReqs[id];if(r.sas&&!r.done)emit('pairwithdrawn',r.name);else if(r.fin)emit('pairdone',r.name);emit('pair')}return}
    if(!key||pairing)return;
    const p=unplain(d.ct);if(!p)return;
    if(kind==='req'&&p.t==='req'&&typeof p.commit==='string'){
      if(pairSeen[id]||pairReqs[id])return;
      // ack at once (a commit only, still gated on promptable), not from the loop's first tick
      const r=pairReqs[id]={id,name:cleanName(p.name),commitNew:p.commit,seenAt:Date.now(),reqAt:d.updated_at,sas:null,done:false,queuedOpen:null,revealed:false,acked:false,ackAt:0};
      sendAck(r);watchApprovals()}
    if(kind==='ack'&&dev&&dev!==state.device){const r=pairReqs[id];if(r&&!r.sas&&!r.queuedOpen)r.otherAck=true}   // another of the user's PCs answered too; the new PC picks one
    if(kind==='open'&&p.t==='open'&&typeof p.pub==='string'){const r=pairReqs[id];if(!r||r.sas||r.queuedOpen)return;
      if(p.to!==state.device){r.done=true;delete pairReqs[id];emit('pair');return}   // addressed to another of the user's PCs (or to nobody)
      r.queuedOpen={pub:p.pub,at:d.updated_at};r.openSeenAt=Date.now();tryReveal()}
  }
  // Volunteer only when a prompt could be shown here; otherwise another of the user's PCs should take it.
  async function sendAck(r){if(r.acking||r.acked||!promptable())return;r.acking=true;
    try{if(!r.kp){r.kp=await ecdhKeys();r.pubOld=await ecdhPub(r.kp);r.commitOld=await commitOf(r.pubOld)}
      await pull(0,[pairDoc(r.id+':ack:'+state.device,{t:'ack',commit:r.commitOld})]);r.acked=true;r.ackAt=Date.now();heat(r)}
    catch(e){slowOn(e)}finally{r.acking=false}}
  // One prompt at a time, only when a person can see it, at most REVEAL_CAP an hour. Later requests wait their turn.
  function tryReveal(){if(prompted()||!promptable())return;
    const now=Date.now();while(reveals.length&&now-reveals[0]>REVEAL_WINDOW)reveals.shift();
    const r=Object.values(pairReqs).filter(r=>r.queuedOpen&&!r.sas&&!r.done&&r.pubOld&&!r.revealing).sort((a,b)=>a.seenAt-b.seenAt)[0];if(!r)return;
    if(reveals.length>=REVEAL_CAP){if(!warned){warned=true;emit('pairwarn')}return}
    const {pub,at}=r.queuedOpen;r.revealing=true;
    commitOf(pub).then(async c=>{if(pairReqs[r.id]!==r)return;
      if(c!==r.commitNew){r.queuedOpen=null;r.revealing=false;return}   // not the committed key: ignore it, the real open may still come
      r.pubNew=pub;r.openAt=at;const code=await sas(r.id,pub,r.pubOld);
      // the prompt must be on a screen somebody can see before the key leaves this PC
      try{if(promptHook)await promptHook({id:r.id,name:r.name,code})}catch(e){r.revealing=false;return}
      r.queuedOpen=null;r.sas=code;r.promptedAt=Date.now();heat(r);reveals.push(Date.now());emit('pair');
      try{await pull(0,[pairDoc(r.id+':reveal:'+state.device,{t:'reveal',pub:r.pubOld})]);r.revealed=true}catch(e){slowOn(e)}
      r.revealing=false;watchApprovals()}).catch(()=>{r.revealing=false})}
  // While a request is open on this side: send or retry the ack, retry an unsent reveal, expire by this PC's own clock.
  // The loop is a timeout chain whose period is decided per tick: PAIR_FAST only while a person can see this window
  // and some request is inside its hot window, PAIR_POLL otherwise, and it ends by itself once nothing is open.
  const period=()=>{const now=Date.now();return (now<slowUntil||!promptable()||!Object.values(pairReqs).some(r=>(r.hotUntil||0)>now))?PAIR_POLL:PAIR_FAST};
  // the other side is about to answer (ack sent, prompt shown, approved): poll fast for HOT_FOR, starting soon
  function heat(r){r.hotUntil=Date.now()+HOT_FOR;watchApprovals(PAIR_FAST)}
  // no argument: start the loop if it is not running (idempotent); with ms: re-arm the next tick at ms
  function watchApprovals(ms){if(approvalTimer){if(ms===undefined)return;clearTimeout(approvalTimer)}approvalTimer=setTimeout(watchTick,ms===undefined?period():ms)}
  function watchTick(){approvalTimer=null;let open=false;
    for(const r of Object.values(pairReqs)){
      if(r.done){if(r.fin&&Date.now()-r.finAt>FIN_TTL){delete pairReqs[r.id];emit('pair')}else open=true;continue}
      if(!r.acked){sendAck(r);if(Date.now()-r.seenAt>PAIR_TTL){delete pairReqs[r.id];pairSeen[r.id]=1}else open=true;continue}
      if(r.sas&&!r.revealed&&!r.revealBusy){r.revealBusy=true;pull(0,[pairDoc(r.id+':reveal:'+state.device,{t:'reveal',pub:r.pubOld})]).then(()=>{r.revealed=true}).catch(slowOn).finally(()=>{r.revealBusy=false})}
      const limit=r.sas||r.queuedOpen?PAIR_TTL:PAIR_UNOPENED;const since=r.sas?r.promptedAt:(r.queuedOpen?r.openSeenAt:r.ackAt);
      if(Date.now()-since>limit){r.done=true;pairSeen[r.id]=1;delete pairReqs[r.id];if(!r.otherAck)pull(0,[pairDoc(r.id,null,true,r.reqAt)]).catch(()=>{});emit('pair')}else open=true}
    tryReveal();
    if(!open)return;   // nothing open on this side: the loop ends here
    if(!running&&Date.now()>=slowUntil)schedule(0);   // one request per tick, never beside a sync already running
    watchApprovals(period())}
  // New PC side. Handlers are awaited in order, so a reveal and a grant in one batch arrive in the right sequence.
  async function pairingSaw(d,kind,dev){const me=pairing;if(d.deleted){if(kind==='req'&&!me.grant&&!me.ready)failPairing(me.pubOld?'Your other PC did not approve this one. Try again there, or use the recovery code.':'Your other PC did not answer in time. Open Sundial there and try again, or use the recovery code.');return}
    const p=unplain(d.ct);if(!p)return;
    if(kind==='ack'&&dev&&p.t==='ack'&&typeof p.commit==='string'&&!me.commitOld){me.commitOld=p.commit;me.to=dev;me.ackAt=d.updated_at;await sendOpen(me)}
    if(kind==='reveal'&&dev===me.to&&p.t==='reveal'&&typeof p.pub==='string'&&me.commitOld&&!me.pubOld){me.revealAt=d.updated_at;
      if(await commitOf(p.pub)!==me.commitOld){failPairing("The other PC's answer was tampered with on the way. Try again.");return}
      me.pubOld=p.pub;me.code=await sas(me.id,me.pub,me.pubOld);me.fastFrom=Date.now();emit('pairsas')}   // the grant comes next: poll fast again
    if(kind==='grant'&&dev===me.to&&p.t==='grant'&&p.iv&&p.wrapped&&me.pubOld&&!me.grant){me.grant=p;me.grantAt=d.updated_at}}
  async function sendOpen(me){if(me.openSent||me.opening)return;me.opening=true;try{await pull(0,[pairDoc(me.id+':open',{t:'open',pub:me.pub,to:me.to})]);me.openSent=true;me.openAt=Date.now()}catch(e){}finally{me.opening=false}}
  async function startPairing(){if(pairing)return {id:pairing.id,code:pairing.code};const kp=await ecdhKeys();const pub=await ecdhPub(kp);const id='pair:'+Math.random().toString(36).slice(2,12)+Date.now().toString(36);ownPairIds[id]=1;
    const commit=await commitOf(pub);
    const first=await pull(0,[pairDoc(id,{t:'req',commit,name:deviceName()})]);
    const rej=(first.rejected||[]).find(r=>r.id===id);
    if(rej){delete ownPairIds[id];throw new Error(rej.reason==='future'?"This PC's clock is wrong. Fix the date and time, then try again.":'This server does not support approving from another PC yet. Use the recovery code.')}
    pairing={id,kp,pub,commit,code:null,commitOld:null,to:null,pubOld:null,grant:null,ready:null,tries:0,cursor:first.cursor||0,since:Date.now(),fastFrom:Date.now()};pollPairing();return {id,code:null}}
  async function pollPairing(){if(!pairing)return;const me=pairing;
    if(!me.ready){try{const res=await pull(me.cursor,[]);me.cursor=res.cursor||me.cursor;for(const d of res.docs||[])if(d.kind==='pair'){try{await notePair(d)}catch(e){}}}
      catch(e){if(e.status===401){pairing=null;clearTimeout(me.timer);await signOutLocal('This PC was signed out of sync: the account was reset or removed. Sign in again to resume.',false);emit('signedout');return}if(e.status===429)me.slowUntil=Date.now()+SLOW_FOR}}
    if(pairing!==me)return;
    if(me.commitOld&&!me.openSent)await sendOpen(me);
    if(me.grant&&!me.ready){try{me.ready=await proveGrant(me);me.readyAt=Date.now();emit('pairready')}catch(e){await cancelPairing();emit('pairfail',e.message||String(e));return}}
    if(me.ready){if(Date.now()-me.readyAt>FIN_TTL){await cancelPairing();emit('pairfail','The finish code was not typed in time. Start again from the other PC.');return}}
    else if(Date.now()-me.since>PAIR_TTL){await cancelPairing();emit('pairfail','No approval arrived in 15 minutes. Try again, or use the recovery code.');return}
    // fast for FAST_FOR from the start and again from the moment the code is shown; once the finish field is up nothing
    // more arrives from the network, so PAIR_POLL until the person types it
    const now=Date.now(),fast=!me.ready&&now-me.fastFrom<FAST_FOR&&now>=(me.slowUntil||0);
    me.timer=setTimeout(pollPairing,fast?PAIR_FAST:PAIR_POLL)}
  // The grant must decrypt under the handshake key, carry a 32-byte key, and that key must open the account's keycheck.
  async function proveGrant(me){let payload;
    try{const k0=await pairKey(me.kp.privateKey,me.pubOld,me.id,me.pub,me.pubOld);const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(me.grant.iv),additionalData:te.encode(me.id)},k0,unb64(me.grant.wrapped));payload=JSON.parse(td.decode(pt))}catch(e){throw new Error('The approval could not be read. Try again.')}
    if(!payload||typeof payload.k!=='string'||unb64(payload.k).length!==32)throw new Error('The approval could not be read. Try again.');
    const cand=await keyFromRaw(payload.k);
    if(!(await keyOpens(cand,await findKeycheck())))throw new Error('The approval did not come from a PC that holds your key. Try again.');
    // the carried recovery code is judged in finishPairing, after the finish code matched: it only decides whether the
    // code is stored, and its PBKDF2 would otherwise sit between the grant and the finish field
    return {cand,fin:await finCode(me.id,payload.k,me.pub,me.pubOld),k:payload.k,rc:payload.rc}}
  // The person types the finish code their other PC shows. Only the PC that really approved this exchange has it.
  async function finishPairing(typed){const me=pairing;if(!me||!me.ready)throw new Error('Nothing to finish yet');
    const t=String(typed||'').replace(/\D/g,'');if(t.length!==4)throw new Error('Type the four digits shown on your other PC');
    if(t!==me.ready.fin.replace(/\s/g,'')){me.tries++;if(me.tries>=3){await cancelPairing();emit('pairfail','That finish code did not match three times. Start again from the other PC.');throw new Error('Cancelled: the finish code did not match')}throw new Error('That is not the code your other PC shows. Check it and try again.')}
    clearTimeout(me.timer);pairing=null;
    // the carried recovery code is kept only if it really derives this key (a stale one on the approving PC must not
    // spread); the check runs beside the tombstone push, so the other PC learns we are in without waiting for it
    const rcCheck=(async()=>{if(!looksLikeCode(me.ready.rc||''))return null;try{return (await rawOf(await deriveKey(me.ready.rc,st().salt)))===me.ready.k?me.ready.rc:null}catch(e){return null}})();
    await pull(0,[pairDoc(me.id,null,true,me.since),pairDoc(me.id+':open',null,true,me.openAt),pairDoc(me.id+':ack:'+me.to,null,true,me.ackAt),pairDoc(me.id+':reveal:'+me.to,null,true,me.revealAt),pairDoc(me.id+':grant:'+me.to,null,true,me.grantAt)]).catch(()=>{});
    await adopt(me.ready.cand,await rcCheck,true);emit('paired')}
  function failPairing(msg){const me=pairing;if(!me)return;clearTimeout(me.timer);pairing=null;pull(0,[pairDoc(me.id,null,true,me.since),pairDoc(me.id+':open',null,true,me.openAt)]).catch(()=>{});emit('pairfail',msg)}
  async function cancelPairing(){const me=pairing;pairing=null;if(!me)return;clearTimeout(me.timer);await pull(0,[pairDoc(me.id,null,true,me.since),pairDoc(me.id+':open',null,true,me.openAt)]).catch(()=>{})}
  // Existing PC side. Approving names the code that was shown, so a prompt can never approve a request that replaced it.
  const pendingPairs=()=>Object.values(pairReqs).filter(r=>r.sas&&!r.done&&Date.now()-r.promptedAt<PAIR_TTL).sort((a,b)=>a.seenAt-b.seenAt).map(r=>({id:r.id,name:r.name,code:r.sas,ts:r.promptedAt,tries:r.tries||0}));
  const finishing=()=>Object.values(pairReqs).filter(r=>r.fin&&Date.now()-r.finAt<FIN_TTL).map(r=>({id:r.id,name:r.name,fin:r.fin}));
  // code: what the person typed (or, on a compare-and-click prompt, the code that was shown). Three misses decline it.
  async function approvePair(id,code){const r=pairReqs[id];if(!r||!r.sas||r.done||!key)throw new Error('Nothing to approve');
    const typed=String(code||'').replace(/\D/g,'');
    if(typed!==r.sas.replace(/\s/g,'')){r.tries=(r.tries||0)+1;if(r.tries>=3){await denyPair(id);throw new Error('Three misses: that request has been declined. The other PC can try again.')}throw new Error("That is not the code the other PC shows. It's the big code on its screen.")}
    if(Date.now()-r.promptedAt>PAIR_TTL){r.done=true;pairSeen[id]=1;delete pairReqs[id];emit('pair');throw new Error('That request has expired. Ask the other PC to sign in again.')}
    const k0=await pairKey(r.kp.privateKey,r.pubNew,id,r.pubNew,r.pubOld);const iv=crypto.getRandomValues(new Uint8Array(12));const rawKey=await rawOf(key);
    const payload=te.encode(JSON.stringify({k:rawKey,rc:(await secretGet('sync:recovery'))||null}));
    const wrapped=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:te.encode(id)},k0,payload));
    const res=await pull(0,[pairDoc(id+':grant:'+state.device,{t:'grant',iv:b64(iv),wrapped:b64(wrapped)})]);
    if((res.rejected||[]).some(x=>x.id===id+':grant:'+state.device))throw new Error('The server refused the approval. Try again in a moment.');
    r.done=true;pairSeen[id]=1;r.fin=await finCode(id,rawKey,r.pubNew,r.pubOld);r.finAt=Date.now();emit('pair');heat(r);return r.fin}
  async function denyPair(id){const r=pairReqs[id];pairSeen[id]=1;if(r)r.done=true;delete pairReqs[id];emit('pair');await pull(0,[pairDoc(id,null,true,r?r.reqAt:0)]).catch(()=>{})}
  // A person dismissing the "too many requests" note lifts the cap; it is their call.
  function liftPairCap(){reveals.length=0;warned=false;tryReveal()}
  function forgetPairs(){for(const k in pairReqs)delete pairReqs[k];if(approvalTimer){clearTimeout(approvalTimer);approvalTimer=null}}

  async function signOutLocal(msg,forget){await cancelPairing();forgetPairs();await forgetKey(!!forget);const s=st();Object.assign(s,fresh(),{server:s.server,lastError:msg||''});save()}
  async function signOut(){const s=st();await cancelPairing();if(s.mode==='hosted'&&s.token){try{await api('/v1/auth/logout',{},'POST')}catch(e){}}await signOutLocal('',false);emit('ok')}
  // Erases the synced copy (every document, every device's access). Local data on every PC stays.
  async function deleteAccount(code){const s=st();await api('/v1/account',s.mode==='hosted'?{code:String(code||'').replace(/\D/g,'')}:null,'DELETE',undefined,'code');await signOutLocal('',true);emit('ok')}
  // "Chrome on Windows", "Safari on iPhone": what a browser calls itself in the approval prompt on the other device
  function browserName(){const ua=navigator.userAgent||'',d=navigator.userAgentData,br=(d&&d.brands||[]).map(b=>b.brand).join(' ');
    let os=(d&&d.platform)||'';if(!os)os=/iPhone/.test(ua)?'iPhone':/iPad/.test(ua)?'iPad':/Android/.test(ua)?'Android':/Windows/.test(ua)?'Windows':/Mac OS X/.test(ua)?'Mac':/CrOS/.test(ua)?'ChromeOS':/Linux/.test(ua)?'Linux':'';
    if(os==='macOS')os='Mac';if(os==='Mac'&&navigator.maxTouchPoints>1)os='iPad';   // iPadOS Safari claims to be a Mac
    const b=/Edge/.test(br)||/Edg\//.test(ua)?'Edge':/Opera/.test(br)||/OPR\//.test(ua)?'Opera':/Firefox\//.test(ua)?'Firefox':/Chrome/.test(br)||/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'Browser';
    return (os?b+' on '+os:b).slice(0,40)}
  function deviceName(){if(machine)return machine;if(window.SundialDesktop)return (navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||'this PC';return browserName()}
  // The desktop shell knows the machine name; asked once at start, and again right before a sign-in so the server's
  // device list and the approval prompt on other devices say "DANNY-PC", not "Win32".
  async function ensureMachine(){if(machine||!window.SundialDesktop||!window.SundialDesktop.machineName)return;try{const n=await window.SundialDesktop.machineName();if(n)machine=String(n).slice(0,40)}catch(e){}}
  const emit=(ev,arg)=>listeners.forEach(f=>{try{f(ev,arg)}catch(e){}});
  // What the account holds on the server, against its limit: {bytes, quota, docs}, or null from a server that does not say.
  const usage=async()=>{const r=await api('/v1/account',null,'GET');return r&&typeof r.bytes==='number'?{bytes:r.bytes,quota:r.quota||0,docs:r.docs||0}:null};
  // The devices signed in to this account: {list:[{id,name,platform,last_seen,created_at,current}], canRevoke}; null from a server without the list.
  const devices=async()=>{try{const r=await api('/v1/devices',null,'GET');return {list:Array.isArray(r.devices)?r.devices:[],canRevoke:!!r.can_revoke}}catch(e){if(e.status===404||e.status===405)return null;throw e}};
  // Signs another device out: its token stops working, what it holds stays on it.
  const revokeDevice=id=>api('/v1/devices/revoke',{id:String(id)},'POST');
  // A visible window checks every 10 seconds, so an approval request from a new PC shows up quickly; hidden, every
  // minute. The tick yields to the pairing loop while that is pulling anyway, and sits out a 429 backoff.
  // The regular tick: every 10 s while the window is visible, every 60 s hidden, never beside the pairing watch loop or
  // inside a 429 back-off. Started once, at launch when a key is already there or the moment this device gets one.
  let ticking=false;
  function startTicking(){if(ticking)return;ticking=true;let n=0;setInterval(()=>{n++;if(approvalTimer||Date.now()<slowUntil||running)return;if(!document.hidden||n%6===0)schedule(0)},10*1000);addEventListener('online',()=>schedule(0));
    // Coming back into view: sync at once (browsers freeze background tabs, phones especially), which also starts the
    // listening again. Going out of view: what is waiting to be sent goes now, not after the usual two seconds, because
    // a phone freezes the page before then and the other devices would not see the change until it is opened again.
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(!running||listening)schedule(0)}else if(Object.keys(st().dirty).length){clearTimeout(timer);timer=null;syncNow().catch(()=>{})}})}
  // The stored key, read without hiding a failure. ok: loaded. missing: the store answered and has no entry. Neither: the
  // store did not answer (a locked wallet, a keyring that is not up yet at sign-in), which says nothing about the key.
  async function readKey(){const D=window.SundialDesktop;
    try{const raw=D?await D.secret.get('sync:key'):(st().sync_key||null);if(raw){key=await keyFromRaw(raw);return {ok:true}}
      // Linux falls back to a file when the keyring fails, and that file has no entry for a key the keyring holds
      if(D&&D.secretStore){const kind=await D.secretStore().catch(()=>'unknown');if(kind==='file'||kind==='unknown')return {ok:false}}
      return {ok:false,missing:true}}
    catch(e){console.warn('sync: key read failed',e);return {ok:false}}}
  const KEYRING_MSG='Could not read the sync key from the system keyring. Unlock it; Sundial keeps trying.';
  // At launch a key that cannot be read is never deleted: the read is tried again (every 5 s at first, then every 30 s),
  // and only a store that plainly has no entry leads to the "approve this PC again" prompt.
  function start(){st();ensureMachine();let tries=0;
    const go=()=>readKey().then(r=>{const s=st();if(s.mode==='off')return;
      if(r.ok){if(s.lastError===KEYRING_MSG){s.lastError='';save()}schedule(1500);startTicking();if(tries)emit('ok');return}
      if(!s.keyOk)return;
      if(!r.missing){if(s.lastError!==KEYRING_MSG){s.lastError=KEYRING_MSG;save();emit('error')}if(tries++<240)setTimeout(go,tries<6?5000:30000);return}
      s.keyOk=false;s.lastError='This PC no longer has its sync key. Approve it again from another PC, or enter the recovery code.';save();emit('lostkey',s.lastError)});
    go()}
  return {st,markDirty,markAllDirty,syncNow,schedule,health,requestCode,verifyCode,signInByEmailKeepingKey,isSelfOnHosted,connectSelf,checkAccount,setPassphrase:unlockWith,unlockWith,setupFirst,recoveryCode,normalizeSecret,
    startPairing,cancelPairing,finishPairing,pendingPairs,finishing,approvePair,denyPair,liftPairCap,isPairing:()=>!!pairing,pairingCode:()=>pairing?pairing.code:null,pairingSince:()=>pairing?pairing.since:0,pairingReady:()=>!!(pairing&&pairing.ready),setPromptable:f=>{promptable=f},setPromptHook:f=>{promptHook=f},
    signOut,deleteAccount,start,HOSTED_URL,hasKey:()=>!!key,isRunning:()=>running&&!listening,isListening:()=>listening,canListen:()=>canWait,skew:()=>skew,usage,devices,revokeDevice,pending:()=>Object.keys(st().dirty).length,rejected:()=>Object.keys(st().rejected).length,on:f=>listeners.push(f)};
})();
