// What the shell's Content-Security-Policy must stop and must allow, checked inside the test copy's main page:
//   deno run -A tools/selftest/cdp.js 9333 "=http://tauri.localhost/" tools/selftest/check-policy.js 800
// Makes no sound and opens no window. Read the result: remoteImg, remoteScript and eval must say blocked, the two
// *Ran flags must be false, and the IPC, style, font, fetch and save entries must have worked.
const out = {};
const viol = [];
document.addEventListener('securitypolicyviolation', e => viol.push(e.effectiveDirective + ' <- ' + String(e.blockedURI).slice(0, 60)));
out.url = location.href;
const head = await fetch(location.href, { cache: 'no-store' });
out.cspHeader = head.headers.get('content-security-policy');
out.cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null;
out.tauri = { global: typeof window.__TAURI__, core: typeof window.__TAURI__?.core?.invoke, bridge: !!window.SundialDesktop };
// IPC round trips
const D = window.SundialDesktop;
try { out.version = await D.appVersion(); } catch (e) { out.versionErr = String(e); }
try { out.dataPath = await D.dataPath(); } catch (e) { out.dataPathErr = String(e); }
try { const p = await D.platform(); out.platform = p && { os: p.os, install: p.install, tray: p.tray }; } catch (e) { out.platformErr = String(e); }
try { out.secretStore = await D.secretStore(); } catch (e) { out.secretStoreErr = String(e); }
// the page itself: scripts ran, styles and fonts applied
out.page = {
  scriptsRan: typeof render === 'function' && typeof Sync === 'object' && typeof cleanNote === 'function',
  bootSource: typeof bootSource === 'string' ? bootSource : null,
  tasks: state.tasks.length,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  styleSheets: document.styleSheets.length,
  fontSyne: document.fonts.check('12px Syne'),
  fontMono: document.fonts.check('12px "Space Mono"'),
  onboarding: !!document.querySelector('.ob-host'),
};
// inline style attributes (the app uses them everywhere) still apply
const probe = document.createElement('div'); probe.setAttribute('style', 'position:absolute;left:-999px;width:37px;--sw:rgb(1, 2, 3);background:var(--sw)'); document.body.appendChild(probe);
out.inlineStyle = { width: getComputedStyle(probe).width, bg: getComputedStyle(probe).backgroundColor };
probe.remove();
// what the policy must stop
const img = new Image(); const imgDone = new Promise(r => { img.onload = () => r('LOADED'); img.onerror = () => r('blocked'); setTimeout(() => r('timeout'), 4000); });
img.src = 'https://sundial.services/img/mark-64.png'; out.remoteImg = await imgDone;
const btn = document.createElement('button'); btn.setAttribute('onclick', 'window.__pwn1=1'); document.body.appendChild(btn); btn.click(); btn.remove(); out.inlineHandlerRan = !!window.__pwn1;
const sc = document.createElement('script'); sc.textContent = 'window.__pwn2=1'; document.body.appendChild(sc); sc.remove(); out.inlineScriptRan = !!window.__pwn2;
const sc2 = document.createElement('script'); sc2.src = 'https://sundial.services/nope.js'; const scDone = new Promise(r => { sc2.onload = () => r('LOADED'); sc2.onerror = () => r('blocked'); setTimeout(() => r('timeout'), 4000); }); document.body.appendChild(sc2); out.remoteScript = await scDone; sc2.remove();
try { out.eval = String((0, eval)('1+1')); } catch (e) { out.eval = 'blocked: ' + e.name; }
const fr = document.createElement('iframe'); fr.src = 'https://sundial.services/'; fr.style.display = 'none'; document.body.appendChild(fr); await new Promise(r => setTimeout(r, 600)); fr.remove();
// what the policy must allow
try { const r = await fetch('https://sync.sundial.services/v1/health'); out.httpsFetch = r.status + ' ' + JSON.stringify(await r.json()); } catch (e) { out.httpsFetch = 'FAILED ' + e; }
// a sync server on plain http (a self-hosted one on the LAN): a refusal here must be the network's, never the policy's
{ const before = viol.length; try { const r = await fetch('http://127.0.0.1:8768/v1/health'); out.httpLocalFetch = 'answered ' + r.status; } catch (e) { out.httpLocalFetch = viol.length > before ? 'BLOCKED BY THE POLICY' : 'allowed (nothing is listening there)'; } }
// data: images (the grain texture is one)
const di = new Image(); const diDone = new Promise(r => { di.onload = () => r('ok'); di.onerror = () => r('BLOCKED'); }); di.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='; out.dataImg = await diDone;
// save and read back through the shell
const t = addTask('selftest ' + Date.now() + ' 3pm', todayStr());
save(); await D.flush();
try { const j = await D.load(); out.saveRoundTrip = !!j && j.includes(t.title); } catch (e) { out.saveErr = String(e); }
await new Promise(r => setTimeout(r, 300));
out.violations = viol;
return out;
