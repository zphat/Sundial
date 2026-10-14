/* Desktop bridge. Present only inside the Tauri shell (window.__TAURI__); the browser build never sees it.
   Everything the UI needs from the native side goes through window.SundialDesktop. */
(function(){
  const T=window.__TAURI__;if(!T||!T.core||!T.event)return;
  const invoke=T.core.invoke,listen=T.event.listen;
  let timer=null,pending=null;
  const flush=()=>{if(pending==null)return Promise.resolve();const j=pending;pending=null;clearTimeout(timer);timer=null;return invoke('save_db',{json:j}).catch(e=>console.error('save failed',e))};
  window.SundialDesktop={
    available:true,
    load:()=>invoke('load_db'),
    // writes are coalesced; a burst of edits becomes one file write
    save:json=>{pending=json;clearTimeout(timer);timer=setTimeout(flush,250)},
    flush,
    dataPath:()=>invoke('data_path'),
    reveal:()=>invoke('reveal_data'),
    openUrl:url=>invoke('open_url',{url}),
    notify:(title,body)=>invoke('notify',{title,body}),
    setHotkeys:spec=>invoke('set_hotkeys',{spec}),
    autostart:{get:()=>invoke('autostart_get'),set:on=>invoke('autostart_set',{on})},
    secret:{get:name=>invoke('secret_get',{name}),set:(name,value)=>invoke('secret_set',{name,value}),del:name=>invoke('secret_delete',{name})},
    aiParse:req=>invoke('ai_parse',{req}),
    appVersion:()=>invoke('app_version'),
    // corner toast window; actions come back through the 'sundial://toast-action' event
    toastShow:payload=>invoke('toast_show',{payload}),
    updateCheck:()=>invoke('update_check'),
    updateInstall:()=>invoke('update_install'),
    // sundial://… link that opened or poked the app (see deepLink in ui.js)
    deepLinkPending:()=>invoke('deep_link_pending'),
    on:(name,cb)=>listen(name,cb),
  };
  window.addEventListener('beforeunload',flush);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)flush()});
})();
