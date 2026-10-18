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
  let key=null,timer=null,running=false,queued=false,applying=false,gen=0,machine='';const listeners=[];
  let pairing=null,approvalTimer=null;const pairReqs={};const pairSeen={};const ownPairIds={};
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
  async function api(path,body,method,token,ctx){const s=st();const tk=token===undefined?s.token:token;let r;
    try{r=await fetch(s.server.replace(/\/+$/,'')+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json',...(tk?{authorization:'Bearer '+tk}:{})},body:body?JSON.stringify(body):undefined})}
    catch(e){const err=new Error(friendly(0,'',ctx));err.status=0;throw err}
    if(r.status===204)return null;const j=await r.json().catch(()=>({}));
    if(!r.ok){const err=new Error(friendly(r.status,j.error,ctx));err.status=r.status;throw err}return j}
  const pull=(cursor,docs)=>api('/v1/sync',{protocol:PROTO,device_id:state.device,cursor:cursor||0,docs:docs||[]},'POST',undefined,'sync');
  const findKeycheck=async()=>{let cursor=0;for(let i=0;i<40;i++){const res=await pull(cursor,[]);const kc=(res.docs||[]).find(d=>d.kind==='keycheck'&&d.id==='keycheck'&&!d.deleted);if(kc)return kc;if(!res.more)return null;cursor=res.cursor}return null};

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
    if(d.kind==='pair'){notePair(d);return false}
    if(d.kind==='keycheck'){if(d.deleted||d.id!=='keycheck')return false;   // the key lives at one id and is never withdrawn
      // another PC replaced the account's key under us (two first-time setups at once, or a reset): stop writing with the wrong key
      if(!(await keyOpens(key,d))){await lostKey('Another PC set this account up with a different key. Approve this PC from it, or enter its recovery code.')}
      return false}
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
  async function lostKey(msg){const s=st();await forgetKey(false);s.keyOk=false;s.lastError=msg;save();emit('lostkey',msg)}

  // ----- the sync itself -----
  async function syncNow(){const s=st();if(s.mode==='off'||!s.server||!s.token||!key)return false;
    if(running){queued=true;return false}running=true;emit('start');
    try{
      const snapshot={...s.dirty};const docs=[];
      for(const did in snapshot){const d=buildDoc(did);if(!d){delete s.dirty[did];continue}const e=d.deleted?{nonce:'',ct:''}:await enc(d.kind,d.id,d.body);docs.push({id:d.id,kind:d.kind,updated_at:d.updated_at,deleted:d.deleted,nonce:e.nonce,ct:e.ct})}
      let cursor=s.cursor||0,more=true,first=true,changed=false;
      while(more){const res=await pull(cursor,first?docs:[]);
        if(first){for(const r of res.rejected||[]){const did=(r.kind==='task'?'task:':r.kind==='note'?'note:':'')+r.id;s.rejected[did]=r.reason||'rejected'}}
        first=false;
        // The server was restored from a backup: forget our place in its history and offer everything again.
        if(res.epoch&&s.epoch&&res.epoch!==s.epoch){s.epoch=res.epoch;s.cursor=0;markAllDirty();save();running=false;return syncNow()}
        if(res.epoch)s.epoch=res.epoch;
        applying=true;try{for(const d of res.docs||[]){try{if(await applyDoc(d))changed=true}catch(e){console.warn('sync: could not apply',d.kind,d.id,e.message||e)}}}finally{applying=false}
        if(!key)return false;
        cursor=res.cursor;more=!!res.more}
      for(const did in snapshot)if(s.dirty[did]===snapshot[did])delete s.dirty[did];
      s.cursor=cursor;s.lastSync=Date.now();s.lastError='';save();
      if(changed&&typeof render==='function')render();
      emit('ok');return true;
    }catch(e){
      if(e.status===401){await signOutLocal('This PC was signed out of sync: the account was reset or removed. Your days are still here. Sign in again to resume.',false);emit('signedout');return false}
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
  // Does this account already have a key (a keycheck document)? Decides between "first PC" and "another PC".
  async function checkAccount(){const kc=await findKeycheck();return {existing:!!kc}}
  // Everything that follows a confirmed key: keep it, remember the code if we have one, offer this PC's days.
  async function adopt(k,code,joining){const s=st();await storeKey(k);if(code)await secretSet('sync:recovery',code);key=k;
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
  const PAIR_DONE='sundial-pair-done',REVEAL_CAP=5,REVEAL_WINDOW=60*60*1000,FIN_TTL=5*60*1000,PAIR_POLL=5000;
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
    if(d.deleted){if(kind==='req'&&pairReqs[id]){const r=pairReqs[id];pairSeen[id]=1;delete pairReqs[id];if(r.sas&&!r.done)emit('pairwithdrawn',r.name);emit('pair')}return}
    if(!key||pairing)return;
    const p=unplain(d.ct);if(!p)return;
    if(kind==='req'&&p.t==='req'&&typeof p.commit==='string'){
      if(pairSeen[id]||pairReqs[id])return;
      pairReqs[id]={id,name:cleanName(p.name),commitNew:p.commit,seenAt:Date.now(),reqAt:d.updated_at,sas:null,done:false,queuedOpen:null,revealed:false,acked:false,ackAt:0};
      watchApprovals()}
    if(kind==='ack'&&dev&&dev!==state.device){const r=pairReqs[id];if(r&&!r.sas&&!r.queuedOpen)r.otherAck=true}   // another of the user's PCs answered too; the new PC picks one
    if(kind==='open'&&p.t==='open'&&typeof p.pub==='string'){const r=pairReqs[id];if(!r||r.sas||r.queuedOpen)return;
      if(p.to!==state.device){r.done=true;delete pairReqs[id];emit('pair');return}   // addressed to another of the user's PCs (or to nobody)
      r.queuedOpen={pub:p.pub,at:d.updated_at};r.openSeenAt=Date.now();tryReveal()}
  }
  // Volunteer only when a prompt could be shown here; otherwise another of the user's PCs should take it.
  async function sendAck(r){if(r.acking||r.acked||!promptable())return;r.acking=true;
    try{if(!r.kp){r.kp=await ecdhKeys();r.pubOld=await ecdhPub(r.kp);r.commitOld=await commitOf(r.pubOld)}
      await pull(0,[pairDoc(r.id+':ack:'+state.device,{t:'ack',commit:r.commitOld})]);r.acked=true;r.ackAt=Date.now()}
    catch(e){}finally{r.acking=false}}
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
      r.queuedOpen=null;r.sas=code;r.promptedAt=Date.now();reveals.push(Date.now());emit('pair');
      try{await pull(0,[pairDoc(r.id+':reveal:'+state.device,{t:'reveal',pub:r.pubOld})]);r.revealed=true}catch(e){}
      r.revealing=false;watchApprovals()}).catch(()=>{r.revealing=false})}
  // While a request is open on this side: send or retry the ack, retry an unsent reveal, expire by this PC's own clock.
  function watchApprovals(){if(approvalTimer)return;approvalTimer=setInterval(()=>{let open=false;
    for(const r of Object.values(pairReqs)){
      if(r.done){if(r.fin&&Date.now()-r.finAt>FIN_TTL){delete pairReqs[r.id];emit('pair')}else open=true;continue}
      if(!r.acked){sendAck(r);if(Date.now()-r.seenAt>PAIR_TTL){delete pairReqs[r.id];pairSeen[r.id]=1}else open=true;continue}
      if(r.sas&&!r.revealed&&!r.revealBusy){r.revealBusy=true;pull(0,[pairDoc(r.id+':reveal:'+state.device,{t:'reveal',pub:r.pubOld})]).then(()=>{r.revealed=true}).catch(()=>{}).finally(()=>{r.revealBusy=false})}
      const limit=r.sas||r.queuedOpen?PAIR_TTL:PAIR_UNOPENED;const since=r.sas?r.promptedAt:(r.queuedOpen?r.openSeenAt:r.ackAt);
      if(Date.now()-since>limit){r.done=true;pairSeen[r.id]=1;delete pairReqs[r.id];if(!r.otherAck)pull(0,[pairDoc(r.id,null,true,r.reqAt)]).catch(()=>{});emit('pair')}else open=true}
    tryReveal();
    if(!open){clearInterval(approvalTimer);approvalTimer=null;return}schedule(0)},PAIR_POLL)}
  // New PC side. Handlers are awaited in order, so a reveal and a grant in one batch arrive in the right sequence.
  async function pairingSaw(d,kind,dev){const me=pairing;if(d.deleted){if(kind==='req'&&!me.grant&&!me.ready)failPairing(me.pubOld?'Your other PC did not approve this one. Try again there, or use the recovery code.':'Your other PC did not answer in time. Open Sundial there and try again, or use the recovery code.');return}
    const p=unplain(d.ct);if(!p)return;
    if(kind==='ack'&&dev&&p.t==='ack'&&typeof p.commit==='string'&&!me.commitOld){me.commitOld=p.commit;me.to=dev;me.ackAt=d.updated_at;await sendOpen(me)}
    if(kind==='reveal'&&dev===me.to&&p.t==='reveal'&&typeof p.pub==='string'&&me.commitOld&&!me.pubOld){me.revealAt=d.updated_at;
      if(await commitOf(p.pub)!==me.commitOld){failPairing("The other PC's answer was tampered with on the way. Try again.");return}
      me.pubOld=p.pub;me.code=await sas(me.id,me.pub,me.pubOld);emit('pairsas')}
    if(kind==='grant'&&dev===me.to&&p.t==='grant'&&p.iv&&p.wrapped&&me.pubOld&&!me.grant){me.grant=p;me.grantAt=d.updated_at}}
  async function sendOpen(me){if(me.openSent||me.opening)return;me.opening=true;try{await pull(0,[pairDoc(me.id+':open',{t:'open',pub:me.pub,to:me.to})]);me.openSent=true;me.openAt=Date.now()}catch(e){}finally{me.opening=false}}
  async function startPairing(){if(pairing)return {id:pairing.id,code:pairing.code};const kp=await ecdhKeys();const pub=await ecdhPub(kp);const id='pair:'+Math.random().toString(36).slice(2,12)+Date.now().toString(36);ownPairIds[id]=1;
    const commit=await commitOf(pub);
    const first=await pull(0,[pairDoc(id,{t:'req',commit,name:deviceName()})]);
    const rej=(first.rejected||[]).find(r=>r.id===id);
    if(rej){delete ownPairIds[id];throw new Error(rej.reason==='future'?"This PC's clock is wrong. Fix the date and time, then try again.":'This server does not support approving from another PC yet. Use the recovery code.')}
    pairing={id,kp,pub,commit,code:null,commitOld:null,to:null,pubOld:null,grant:null,ready:null,tries:0,cursor:first.cursor||0,since:Date.now()};pollPairing();return {id,code:null}}
  async function pollPairing(){if(!pairing)return;const me=pairing;
    try{const res=await pull(me.cursor,[]);me.cursor=res.cursor||me.cursor;for(const d of res.docs||[])if(d.kind==='pair'){try{await notePair(d)}catch(e){}}}catch(e){}
    if(pairing!==me)return;
    if(me.commitOld&&!me.openSent)await sendOpen(me);
    if(me.grant&&!me.ready){try{me.ready=await proveGrant(me);me.readyAt=Date.now();emit('pairready')}catch(e){await cancelPairing();emit('pairfail',e.message||String(e));return}}
    if(me.ready){if(Date.now()-me.readyAt>FIN_TTL){await cancelPairing();emit('pairfail','The finish code was not typed in time. Start again from the other PC.');return}}
    else if(Date.now()-me.since>PAIR_TTL){await cancelPairing();emit('pairfail','No approval arrived in 15 minutes. Try again, or use the recovery code.');return}
    me.timer=setTimeout(pollPairing,PAIR_POLL)}
  // The grant must decrypt under the handshake key, carry a 32-byte key, and that key must open the account's keycheck.
  async function proveGrant(me){let payload;
    try{const k0=await pairKey(me.kp.privateKey,me.pubOld,me.id,me.pub,me.pubOld);const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(me.grant.iv),additionalData:te.encode(me.id)},k0,unb64(me.grant.wrapped));payload=JSON.parse(td.decode(pt))}catch(e){throw new Error('The approval could not be read. Try again.')}
    if(!payload||typeof payload.k!=='string'||unb64(payload.k).length!==32)throw new Error('The approval could not be read. Try again.');
    const cand=await keyFromRaw(payload.k);
    if(!(await keyOpens(cand,await findKeycheck())))throw new Error('The approval did not come from a PC that holds your key. Try again.');
    // the carried recovery code is kept only if it really derives this key (a stale one on the approving PC must not spread)
    let rc=null;if(looksLikeCode(payload.rc||'')){try{if(await rawOf(await deriveKey(payload.rc,st().salt))===payload.k)rc=payload.rc}catch(e){}}
    return {cand,rc,fin:await finCode(me.id,payload.k,me.pub,me.pubOld)}}
  // The person types the finish code their other PC shows. Only the PC that really approved this exchange has it.
  async function finishPairing(typed){const me=pairing;if(!me||!me.ready)throw new Error('Nothing to finish yet');
    const t=String(typed||'').replace(/\D/g,'');if(t.length!==4)throw new Error('Type the four digits shown on your other PC');
    if(t!==me.ready.fin.replace(/\s/g,'')){me.tries++;if(me.tries>=3){await cancelPairing();emit('pairfail','That finish code did not match three times. Start again from the other PC.');throw new Error('Cancelled: the finish code did not match')}throw new Error('That is not the code your other PC shows. Check it and try again.')}
    clearTimeout(me.timer);pairing=null;
    await pull(0,[pairDoc(me.id,null,true,me.since),pairDoc(me.id+':open',null,true,me.openAt),pairDoc(me.id+':ack:'+me.to,null,true,me.ackAt),pairDoc(me.id+':reveal:'+me.to,null,true,me.revealAt),pairDoc(me.id+':grant:'+me.to,null,true,me.grantAt)]).catch(()=>{});
    await adopt(me.ready.cand,me.ready.rc,true);emit('paired')}
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
    r.done=true;pairSeen[id]=1;r.fin=await finCode(id,rawKey,r.pubNew,r.pubOld);r.finAt=Date.now();emit('pair');watchApprovals();return r.fin}
  async function denyPair(id){const r=pairReqs[id];pairSeen[id]=1;if(r)r.done=true;delete pairReqs[id];emit('pair');await pull(0,[pairDoc(id,null,true,r?r.reqAt:0)]).catch(()=>{})}
  // A person dismissing the "too many requests" note lifts the cap; it is their call.
  function liftPairCap(){reveals.length=0;warned=false;tryReveal()}
  function forgetPairs(){for(const k in pairReqs)delete pairReqs[k];if(approvalTimer){clearInterval(approvalTimer);approvalTimer=null}}

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
  const emit=(ev,arg)=>listeners.forEach(f=>{try{f(ev,arg)}catch(e){}});
  // A visible window checks every 30 seconds, so an approval request from a new PC shows up quickly; hidden, every minute.
  function start(){st();if(window.SundialDesktop&&window.SundialDesktop.machineName)window.SundialDesktop.machineName().then(n=>{if(n)machine=String(n).slice(0,40)}).catch(()=>{});
    loadKey().then(ok=>{const s=st();if(s.mode==='off')return;
      if(ok){schedule(1500);let n=0;setInterval(()=>{n++;if(!document.hidden||n%2===0)schedule(0)},30*1000);addEventListener('online',()=>schedule(0));
        // browsers freeze background tabs (phones especially): coming back, sync at once instead of waiting for the next tick
        if(!window.SundialDesktop)document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0)})}
      else if(s.keyOk){lostKey('This PC no longer has its sync key. Approve it again from another PC, or enter the recovery code.')}})}
  return {st,markDirty,markAllDirty,syncNow,schedule,health,requestCode,verifyCode,connectSelf,checkAccount,setPassphrase:unlockWith,unlockWith,setupFirst,recoveryCode,normalizeSecret,
    startPairing,cancelPairing,finishPairing,pendingPairs,finishing,approvePair,denyPair,liftPairCap,isPairing:()=>!!pairing,pairingCode:()=>pairing?pairing.code:null,pairingSince:()=>pairing?pairing.since:0,pairingReady:()=>!!(pairing&&pairing.ready),setPromptable:f=>{promptable=f},setPromptHook:f=>{promptHook=f},
    signOut,deleteAccount,start,HOSTED_URL,hasKey:()=>!!key,isRunning:()=>running,pending:()=>Object.keys(st().dirty).length,rejected:()=>Object.keys(st().rejected).length,on:f=>listeners.push(f)};
})();
