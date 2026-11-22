/* Desktop bridge. Present only inside the Tauri shell (window.__TAURI__); the browser build never sees it.
   Everything the UI needs from the native side goes through window.SundialDesktop. */
(function(){
  const T=window.__TAURI__;if(!T||!T.core||!T.event)return;
  const invoke=T.core.invoke,listen=T.event.listen;
  // Nothing is written until the UI has read the data file and called ready(): a slow start can never write over a file
  // it has not seen, and a file that could not be read is never replaced.
  // A write that fails keeps its text and is tried again every 5 seconds; the UI hears about it through onSaveError and
  // onSaveOk. The "unsaved" mark in localStorage outlives the app, so the next start knows the file is the older copy.
  const FLAG='sundial.unsaved';
  let timer=null,retry=null,pending=null,ready=false,failing=false,flagged=false;
  try{flagged=localStorage.getItem(FLAG)==='1'}catch(_){}
  const setFlag=on=>{flagged=on;try{if(on)localStorage.setItem(FLAG,'1');else localStorage.removeItem(FLAG)}catch(_){}};
  const hook=(name,arg)=>{const f=window.SundialDesktop[name];if(typeof f==='function'){try{f(arg)}catch(e){console.error(e)}}};
  const flush=()=>{if(!ready||pending==null)return Promise.resolve();const j=pending;pending=null;clearTimeout(timer);timer=null;clearTimeout(retry);retry=null;
    return invoke('save_db',{json:j}).then(()=>{if(flagged)setFlag(false);if(failing){failing=false;hook('onSaveOk')}})
      .catch(e=>{console.error('save failed',e);if(pending==null)pending=j;if(!flagged)setFlag(true);failing=true;hook('onSaveError',e);clearTimeout(retry);retry=setTimeout(flush,5000)})};
  window.SundialDesktop={
    available:true,
    load:()=>invoke('load_db'),
    // writes are coalesced; a burst of edits becomes one file write
    save:json=>{pending=json;if(!ready)return;clearTimeout(timer);timer=setTimeout(flush,250)},
    flush,
    // the data file has been read (or there is none yet): writing may start
    ready:()=>{if(ready)return;ready=true;if(pending!=null){clearTimeout(timer);timer=setTimeout(flush,250)}},
    // the last session ended with a write that never reached the file
    unsaved:()=>flagged,
    // a data file that cannot be read is kept under another name (returned) instead of being written over
    setAside:()=>invoke('set_aside_db'),
    // the text of the newest daily backup that is a readable Sundial file, or null
    newestBackup:()=>invoke('newest_backup'),
    // Restore a backup (Settings): the list [{name,date,bytes,tasks}] newest first, one backup's text, and a copy of the data file as it is now
    listBackups:()=>invoke('list_backups'),
    readBackup:name=>invoke('read_backup',{name}),
    keepCopy:()=>invoke('keep_copy_db'),
    onSaveError:null,onSaveOk:null,
    dataPath:()=>invoke('data_path'),
    reveal:()=>invoke('reveal_data'),
    openUrl:url=>invoke('open_url',{url}),
    notify:(title,body)=>invoke('notify',{title,body}),
    setHotkeys:spec=>invoke('set_hotkeys',{spec}),
    autostart:{get:()=>invoke('autostart_get'),set:on=>invoke('autostart_set',{on})},
    secret:{get:name=>invoke('secret_get',{name}),set:(name,value)=>invoke('secret_set',{name,value}),del:name=>invoke('secret_delete',{name})},
    // which store answered the last secret call: 'credential-manager' | 'keychain' | 'secret-service' | 'file' | 'unknown' (secret_store in lib.rs)
    secretStore:()=>invoke('secret_store'),
    aiParse:req=>invoke('ai_parse',{req}),
    appVersion:()=>invoke('app_version'),
    // the PC's own name, so an approval prompt says which machine is asking
    machineName:()=>invoke('machine_name'),
    // os / session / install / tray of the shell (platform_info in lib.rs). Not cached: on Linux `tray` is asked over D-Bus at call
    // time and can turn from false to true after login (plasmashell registers its tray late), so Settings asks again while it is false.
    // Shape: {os:'windows'|'linux'|'macos', session:'x11'|'wayland'|null, install:'installer'|'appimage'|'package'|'dev', tray:true|false, desktop:'kde'|'gnome'|'xfce'|'x-cinnamon'|...|null}
    platform:()=>invoke('platform_info').catch(()=>null),
    // corner toast window; actions come back through the 'sundial://toast-action' event
    toastShow:payload=>invoke('toast_show',{payload}),
    toastCurrent:()=>invoke('toast_payload'),
    toastDismiss:()=>invoke('toast_action',{action:'dismiss'}),
    updateCheck:()=>invoke('update_check'),
    updateInstall:()=>invoke('update_install'),
    // sundial://… link that opened or poked the app (see deepLink in ui.js)
    deepLinkPending:()=>invoke('deep_link_pending'),
    on:(name,cb)=>listen(name,cb),
  };
  window.addEventListener('beforeunload',flush);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)flush()});
})();
