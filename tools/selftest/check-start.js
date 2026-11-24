// How the test copy started: where its state came from, what it shows, whether the shell answers.
//   deno run -A tools/selftest/cdp.js 9333 "=http://tauri.localhost/" tools/selftest/check-start.js
// bootSource is 'seed' on a first start, 'file' once the data file exists, 'storage' when the app went on from its own
// copy (a data file that could not be read is set aside, and a sticky note says so).
const D = window.SundialDesktop;
return {
  version: await D.appVersion(),
  dataPath: await D.dataPath(),
  bootSource,
  tasks: state.tasks.length,
  marked: state.tasks.filter(t => /selftest/i.test(t.title)).map(t => t.title + (t.notes ? ' | ' + t.notes : '')),
  unsavedFlag: D.unsaved(),
  notes: [...document.querySelectorAll('.banner')].map(n => n.innerText.replace(/\s+/g, ' ').slice(0, 200)),
  backups: await D.listBackups().catch(e => 'error: ' + e),
  quitReady: await window.__TAURI__.core.invoke('quit_ready').then(() => 'registered').catch(e => 'error: ' + e),
};
