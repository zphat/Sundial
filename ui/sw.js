/* Sundial service worker (web app only; the desktop shell and the http dev preview never register it).
   Precaches the shell on install, answers same-origin GETs network-first with the cache as the fallback, and
   leaves every cross-origin request alone: sync, AI and user-chosen servers must never be answered from a cache.
   File names are not hashed, so Caddy sends Cache-Control: no-cache for the shell and the cache name carries the
   release version; old caches go on activate. */
'use strict';
const VERSION='__VERSION__';            // stamped by the web packaging
const CACHE='sundial-'+VERSION;
// What must be there for Sundial to start offline. A miss here fails the install, so only files this bundle ships.
const SHELL=['./','index.html','styles.css','fonts.css','desktop.js','data.js','audio.js','ai.js','sync.js','ui.js','manifest.webmanifest',
  'icons/icon-32.png','icons/icon-128.png','icons/icon-192.png','icons/icon-256.png','icons/icon-512.png','icons/icon-512-maskable.png','icons/apple-touch-icon.png'];
// The font files are whatever fonts.css points at; each is added on its own, so a missing one never blocks the install.
async function fontFiles(){try{const css=await (await fetch('fonts.css',{cache:'no-cache'})).text();const out=new Set();const re=/url\(\s*["']?([^"')]+)["']?\s*\)/g;let m;
  while((m=re.exec(css))){const u=m[1].trim();if(!/^(data:|https?:|\/\/)/i.test(u))out.add(u)}return [...out]}catch(e){return []}}
self.addEventListener('install',e=>{e.waitUntil((async()=>{const c=await caches.open(CACHE);await c.addAll(SHELL);
  for(const f of await fontFiles()){try{await c.add(f)}catch(err){}}
  await self.skipWaiting()})())});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('sundial-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const req=e.request;if(req.method!=='GET')return;
  let url;try{url=new URL(req.url)}catch(err){return}
  if(url.origin!==self.location.origin)return;   // sync, AI and user servers go straight to the network
  e.respondWith(fetch(req).then(res=>{
    // only clean 200s from this origin are kept; a page URL carrying a query (?code=) is not stored under that URL
    if(res.status===200&&res.type==='basic'&&!(req.mode==='navigate'&&url.search)){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{})}
    return res})
  .catch(()=>caches.match(req,{ignoreSearch:true}).then(hit=>hit||(req.mode==='navigate'?caches.match('index.html'):undefined)).then(hit=>hit||Response.error())))});
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting()});
