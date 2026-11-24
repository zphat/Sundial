// Save before quit: an edit that is still held back (600 ms in the page, 250 ms in the bridge) and then Quit at once.
//   deno run -A tools/selftest/cdp.js 9333 "=http://tauri.localhost/" tools/selftest/check-quit.js
// The process ends. The text returned as `typed` must then be in the data file (dataPath), and in the task after the
// next start (check-start.js lists it under `marked`).
const t = state.tasks.find(x => /selftest/i.test(x.title)) || addTask('selftest base 3pm', todayStr());
const typed = 'typed just before quit ' + Date.now();
upd(t.id, { notes: typed }, true);                       // silent, as typing in a field is: saveSoon holds it
const held = typeof saveT !== 'undefined' && saveT != null;
const dataPath = await window.SundialDesktop.dataPath();
window.__TAURI__.core.invoke('dev_quit');                 // not awaited: the process is about to end
return { task: t.id, typed, heldBackWhenQuitWasAsked: held, dataPath };
