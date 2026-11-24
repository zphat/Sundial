/* The corner toast's page (toast.html, desktop shell only). A file of its own, not an inline script: the shell's
   Content-Security-Policy lets scripts come from the app's own files and from nowhere else. */
(async()=>{
  const T=window.__TAURI__;if(!T||!T.core)return;
  const invoke=T.core.invoke;
  const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let p=null;try{p=await invoke('toast_payload')}catch(e){}
  // Nothing to show: this window's toast has already gone. seq 0 is no toast's, so this only asks the shell to tidy up
  // the window and can never dismiss the toast that comes next.
  if(!p){try{await invoke('toast_action',{action:'timeout',seq:0})}catch(e){}return}
  const card=document.getElementById('card');
  const corner=p.corner||'bottom-left';
  card.className='card '+(p.kind||'remind')+(corner.endsWith('right')?' right':' left');
  const icon=p.kind==='update'?'↻':p.kind==='start'?'☉':p.kind==='pair'?'⇄':'◔';
  const acts=(p.actions||[{id:'ok',label:'OK',primary:true}]);
  card.innerHTML=`<div class="stripe"></div><div class="ic">${icon}</div><div class="tx"><span class="k">${esc(p.label||'')}</span><b title="${esc(p.title)}">${esc(p.title)}</b>${p.meta?`<small>${esc(p.meta)}</small>`:''}</div>
    <div class="bt">${acts.map(a=>`<button data-a="${esc(a.id)}" class="${a.primary?'primary':''}">${esc(a.label)}</button>`).join('')}</div>
    <button class="x" data-a="dismiss" title="Dismiss">×</button>${p.sticky?'':`<div class="bar" style="--secs:${Math.max(3,+p.secs||30)}s"></div>`}<span class="brandmark">SUNDIAL</span>`;
  card.hidden=false;
  let done=false;
  // toastSeq says which toast this page showed, so the answer can never land on the one after it
  const finish=async(action)=>{if(done)return;done=true;card.classList.add('out');setTimeout(()=>invoke('toast_action',{action,seq:p.toastSeq}).catch(()=>{}),200)};
  card.addEventListener('click',e=>{const b=e.target.closest('[data-a]');if(b)finish(b.dataset.a)});
  const bar=card.querySelector('.bar');
  if(bar){bar.addEventListener('animationend',()=>finish('timeout'));
    // belt and braces: if the animation never ends (hidden window), still go away
    const secs=Math.max(3,+p.secs||30);const arm=ms=>setTimeout(()=>{if(done)return;if(card.matches(':hover'))arm(1000);else finish('timeout')},ms);arm(secs*1000+1500)}
  document.addEventListener('contextmenu',e=>e.preventDefault());
  document.addEventListener('keydown',e=>{if(e.key==='Escape')finish('dismiss')});
})();
