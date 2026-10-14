/* Sundial UI: rendering, events, banners/takeover, settings, search, voice button. Depends on data.js + audio.js. */
'use strict';
let sel=todayStr(), view='day', openId=null, miniMonth=sel.slice(0,7), dragId=null, cursorId=null;
const anim={enter:null,pop:null,slide:null};
let lastDeleted=null, recordingHotkey=false, sheetTab='general';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const CHECK='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5l2.6 2.6L10 3.5"/></svg>';
const LOCK='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2" y="5.5" width="8" height="5.5" rx="1.2"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>';
const UNLOCK='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2" y="5.5" width="8" height="5.5" rx="1.2"/><path d="M4 5.5V4a2 2 0 0 1 4 0"/></svg>';
const HK={cal:'hc',board:'hb',tl:'ht'},PANE={cal:'#calPane',board:'#boardPane',tl:'#tlPane'};
const lockBtn=k=>`<button class="lk" data-lock="${k}" aria-label="Lock height"></button>`;
function syncLocks(){const L=state.layout.lock||{};document.querySelectorAll('[data-lock]').forEach(b=>{const on=!!L[b.dataset.lock];b.innerHTML=on?LOCK:UNLOCK;b.setAttribute('aria-pressed',String(on));b.title=on?'Height locked, scrolls inside. Click to let it grow to its content.':'Grows to its content, the column scrolls. Click to lock a height.'})}
const MIC='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2M5.5 14.5h5"/></svg>';
// "today" / "tomorrow" / "Fri 16" for toasts
const dayLabel=d=>{const r=relDay(d);return ['Today','Tomorrow','Yesterday'].includes(r)?r.toLowerCase():r+' '+fromYmd(d).getDate()};
// no motion when the user asked for none, or when the window is hidden (transitions don't advance there)
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches||document.hidden;

// ---------- theme / layout ----------
function applyTheme(){const t=S().theme;if(t==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',t)}
function applyDensity(){document.body.classList.toggle('compact',S().density==='compact')}
// Two arrangements: side by side (widths drag) or stacked (heights drag). Auto picks stacked for portrait screens and narrow windows.
function effectiveMode(){const m=state.layout.mode||'auto';if(m!=='auto')return m;return (innerHeight>innerWidth*1.05||innerWidth<760)?'column':'row'}
function applyLayout(){
  const L=state.layout,mode=effectiveMode();
  if(!L.sized){L.wl=Math.max(220,Math.min(440,Math.round(innerWidth*0.19)));L.wr=Math.max(300,Math.min(600,Math.round(innerWidth*0.26)));L.hc=Math.max(240,Math.min(460,Math.round(innerHeight*0.3)));L.ht=Math.max(260,Math.min(560,Math.round(innerHeight*0.3)));L.sized=true;save()}
  const cols=$('#cols'),cal=$('#calPane'),board=$('#boardPane'),tl=$('#tlPane'),gL=$('#gL'),gR=$('#gR'),gB=$('#gB');
  L.lock=L.lock||{cal:false,board:true,tl:true};if(!L.hb)L.hb=Math.max(360,Math.min(900,Math.round(innerHeight*0.5)));
  if(!L.cal&&!L.board&&!L.tl)L.board=true;
  cal.hidden=!L.cal;board.hidden=!L.board;tl.hidden=!L.tl;
  gL.hidden=!(L.cal&&(L.board||L.tl));gR.hidden=!(L.tl&&L.board);
  cols.classList.toggle('stack',mode==='column');
  document.querySelectorAll('.gutter').forEach(g=>g.classList.toggle('h',mode==='column'));
  [cal,board,tl].forEach(p=>{p.style.flex='';p.style.minHeight=''});
  if(mode==='row'){
    const c=[];
    if(L.cal)c.push(L.board?L.wl+'px':'minmax(0,1fr)');
    if(!gL.hidden)c.push('10px');
    if(L.board)c.push('minmax(0,1fr)');
    if(!gR.hidden)c.push('10px');
    if(L.tl)c.push(L.board?L.wr+'px':'minmax(0,1fr)');
    cols.style.gridTemplateColumns=c.join(' ');
  }else{
    cols.style.gridTemplateColumns='';
    // locked section: the height you gave it, scrolls inside. Free section: as tall as its content; the column scrolls.
    [['cal',cal],['board',board],['tl',tl]].forEach(([k,p])=>{if(!L[k])return;const locked=!!L.lock[k];p.classList.toggle('free',!locked);p.style.flex=locked?'0 0 '+L[HK[k]]+'px':'0 0 auto';p.style.minHeight='0'});
  }
  gB.hidden=mode!=='column'||!(L.cal||L.board||L.tl);
  if(mode!=='column')[cal,board,tl].forEach(p=>p.classList.remove('free'));
  syncLocks();
  cal.classList.toggle('wide',mode==='column'&&cal.getBoundingClientRect().width>560);
  document.querySelectorAll('#paneSeg button[data-pane]').forEach(b=>b.setAttribute('aria-pressed',String(!!L[b.dataset.pane])));
  const lb=$('#layoutBtn');if(lb){lb.textContent=mode==='column'?'⇆':'⇅';lb.title=mode==='column'?'Side by side':'Stacked';lb.setAttribute('aria-pressed',String(mode==='column'))}
}
function togglePane(k){state.layout[k]=!state.layout[k];save();applyLayout();render()}
function updateLogo(){const n=new Date();const a=((n.getHours()+n.getMinutes()/60)-12)/24*360;const s=$('#shadow');if(s)s.setAttribute('transform',`rotate(${a} 14 14)`)}

// ---------- render ----------
let prevRects={};
function snap(){prevRects={};document.querySelectorAll('.task[data-id]').forEach(el=>prevRects[el.dataset.id]=el.getBoundingClientRect().top)}
// FLIP without rAF: set the inverse transform, force a reflow, then let the CSS transition play it back.
function flip(){if(reduced())return;const moves=[];document.querySelectorAll('.task[data-id]').forEach(el=>{const p=prevRects[el.dataset.id];if(p==null)return;const dy=p-el.getBoundingClientRect().top;if(Math.abs(dy)<1)return;el.style.transition='none';el.style.transform=`translateY(${dy}px)`;moves.push(el)});
  if(!moves.length)return;void document.body.offsetHeight;moves.forEach(el=>{el.style.transition='';el.style.transform=''})}
function ringSvg(done,total){const r=8,c=2*Math.PI*r,f=total?done/total:0;return `<svg class="ring" viewBox="0 0 22 22" aria-label="${done} of ${total} done"><circle class="bg" cx="11" cy="11" r="${r}"/><circle class="fg" cx="11" cy="11" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c*(1-f)}" transform="rotate(-90 11 11)"/></svg>`}
function openDrawerEl(dr,instant){
  const h=dr.firstElementChild.scrollHeight;
  if(instant||reduced()){dr.classList.add('instant','on');dr.style.height='auto';void dr.offsetHeight;dr.classList.remove('instant');return}
  dr.style.height='0px';void dr.offsetHeight;
  dr.classList.add('on');dr.style.height=h+'px';
  const release=()=>{if(dr.classList.contains('on'))dr.style.height='auto'};
  dr.addEventListener('transitionend',release,{once:true});setTimeout(release,320);
}
function collapseDrawerEl(dr){dr.classList.add('instant');dr.style.height=dr.offsetHeight+'px';void dr.offsetHeight;dr.classList.remove('instant','on');dr.style.height='0px'}
let lastView=null,lastSel=null,sheetAnim=false;
function render(){
  snap();
  const wasOpen=document.querySelector('.drawer.on [data-drawer]')?.dataset.drawer;
  const bp=$('#boardPane');if(view!==lastView){bp.classList.remove('view-in');void bp.offsetWidth;bp.classList.add('view-in');lastView=view}
  if(sel!==lastSel){const te=$('#title');te.classList.remove('swap');void te.offsetWidth;te.classList.add('swap');lastSel=sel}
  const d=fromYmd(sel),ws=fromYmd(weekStart(sel));
  const ts=dayTasks(sel),done=ts.filter(x=>x.done).length;
  $('#title').innerHTML=view==='month'?`${MON[d.getMonth()]} <span class="y">${d.getFullYear()}</span>`
    :view==='week'?`Week of ${MON[ws.getMonth()].slice(0,3)} ${ws.getDate()} <span class="y">${d.getFullYear()}</span>`
    :`${relDay(sel)} <span class="y">${MON[d.getMonth()].slice(0,3)} ${d.getDate()}</span>${ts.length&&view==='day'?ringSvg(done,ts.length):''}`;
  document.querySelectorAll('.seg [data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  if(state.layout.cal){renderMini();renderUpnext();renderLegend()}
  if(state.layout.board){
    // keep what the user is typing in the quick-add across any re-render (minute ticks, completing a task)
    const q=$('#qa');const qs=q&&q.value?{v:q.value,s:q.selectionStart,e:q.selectionEnd,f:document.activeElement===q}:null;const qf=q&&document.activeElement===q;
    const sc=$('#list')?.scrollTop||0;if(view==='day')renderDay();else if(view==='week')renderWeek();else if(view==='month')renderMonth();else renderNotes();const l=$('#list');if(l&&!anim.slide)l.scrollTop=sc;
    const q2=$('#qa');if(q2&&qs){q2.value=qs.v;previewParse();if(qs.f){q2.focus();try{q2.setSelectionRange(qs.s,qs.e)}catch(e){}}}else if(q2&&qf)q2.focus();
  }
  if(state.layout.tl)renderSide();
  flip();
  const dr=document.querySelector('.drawer');if(dr)openDrawerEl(dr,wasOpen===openId);
  syncLocks();
  $('#footTip').innerHTML=['↵ add','← → days','T today','N new','/ search','J K move','␣ done','⌫ delete','Ctrl+Z undo','1-4 views','[ \\ ] panes','right-click a task'].map(x=>`<span>${x}</span>`).join('');
  anim.enter=null;anim.pop=null;anim.slide=null;
}
function renderMini(){
  const[y,m]=miniMonth.split('-').map(Number);$('#miniTitle').textContent=MON[m-1]+' '+y;
  const first=new Date(y,m-1,1);const start=weekStart(ymd(first));
  let h=dowLabels().map(x=>`<div class="dow">${x[0]}</div>`).join('');
  for(let i=0;i<42;i++){const ds=addDays(start,i);const dd=fromYmd(ds);const ts=dayTasks(ds).filter(x=>!x.done);const cols=[...new Set(ts.map(x=>x.color))].slice(0,3);
    h+=`<button class="d ${dd.getMonth()!==m-1?'out':''} ${ds===sel?'sel':''} ${ds===todayStr()?'today':''}" data-date="${ds}">${dd.getDate()}<span class="dots">${cols.map(c=>`<i style="--dot:var(--c-${c})"></i>`).join('')}</span></button>`}
  $('#mini').innerHTML=h;
}
function renderUpnext(){
  const t=todayStr(),m=nowMin();
  const up=state.tasks.filter(x=>!x.done&&x.time!=null&&(x.date>t||(x.date===t&&x.time>=m))).sort((a,b)=>a.date.localeCompare(b.date)||a.time-b.time).slice(0,4);
  $('#upnext').innerHTML=up.length?`<div class="eyebrow" style="margin-bottom:4px">Up next</div>`+up.map(x=>`<div class="u" data-id="${x.id}" data-act="open"><span class="when">${x.date===t?'':dowName(x.date)+' '}${fmtTime(x.time)}</span><span class="swatch" style="--sw:var(--c-${x.color})"></span><span>${esc(x.title)}</span></div>`).join(''):'';
}
function renderLegend(){
  $('#legend').innerHTML=`<div class="eyebrow" style="margin-bottom:4px">Colors</div>`+COLORS.map(([k])=>`<div class="row"><span class="swatch" style="--sw:var(--c-${k})"></span><input data-color="${k}" value="${esc(state.labels[k])}" aria-label="Label for ${k}"></div>`).join('')+
  `<div class="hint">Click a name to rename it. Type <code>#name</code> in a task line to use it.</div>`;
}
function taskRow(x){
  const open=x.id===openId,lead=remindLead(x);
  const bell=x.notify&&x.time!=null&&(lead||S().startStyle!=='off');
  return `<div class="item"><div class="task ${x.done?'done':''} ${open?'open':''} ${x.id===cursorId?'cursor':''} ${anim.enter===x.id?'enter':''} ${x.date<todayStr()&&!x.done?'overdue':''}" draggable="true" data-id="${x.id}">
    <span class="grip" aria-hidden="true">⋮⋮</span>
    <button class="dot" data-act="color" title="${esc(state.labels[x.color])} · click to recolor" style="--sw:var(--c-${x.color})"></button>
    <div class="body" data-act="open"><span class="t">${esc(x.title)}</span>
      ${x.time!=null||x.dur||x.repeat?`<span class="meta">${x.time!=null?fmtTime(x.time):''}${x.dur?' · '+fmtDur(x.dur):''}${bell?' <span class="al" title="${esc(fmtLead(lead))}">●</span>':''}${x.repeat?' <span class="rp" title="repeats '+x.repeat+'">↻</span>':''}</span>`:''}
      ${x.notes?`<span class="note-ind" title="has notes">≡</span>`:''}
    </div>
    <span class="acts"><button data-act="tomorrow" title="Move to tomorrow">→</button><button class="del" data-act="delete" title="Delete">×</button></span>
    <button class="check ${anim.pop===x.id?'pop':''}" data-act="done" aria-label="${x.done?'Mark not done':'Mark done'}">${CHECK}</button>
  </div>${open?drawer(x):''}</div>`;
}
function drawer(x){
  const rem=x.remind==null?'':String(x.remind);
  const opt=(v,l)=>`<option value="${v}" ${rem===v?'selected':''}>${l}</option>`;
  return `<div class="drawer"><div class="dw"><div class="in" data-drawer="${x.id}">
    <div class="dh"><span class="eyebrow">Editing · changes save as you type</span><button class="min" data-act="close" title="Minimize this task (Esc)">▴ Minimize</button></div>
    <input class="ttl" id="edTitle" value="${esc(x.title)}" aria-label="Title">
    <div class="fields">
      <div class="f"><label>Day</label><input id="edDate" type="date" value="${x.date}"></div>
      <div class="f"><label>Time</label><input id="edTime" type="time" value="${x.time!=null?pad(Math.floor(x.time/60))+':'+pad(x.time%60):''}"></div>
      <div class="f"><label>Length</label><input id="edDur" placeholder="45m, 1h30" value="${fmtDur(x.dur)}"></div>
      <div class="f"><label>Repeat</label><select id="edRepeat">${['','daily','weekdays','weekly','monthly'].map(v=>`<option value="${v}" ${(x.repeat||'')===v?'selected':''}>${v||'never'}</option>`).join('')}</select></div>
      <div class="f"><label>Remind</label><select id="edRemind">${opt('','default · '+fmtLead(S().defaultRemind))}${opt('-1','none')}${opt('5','5m before')}${opt('15','15m before')}${opt('30','30m before')}${opt('60','1h before')}${opt('120','2h before')}${opt('1440','1d before')}</select></div>
    </div>
    <div class="rowx"><div class="colors">${COLORS.map(([k])=>`<button data-setcolor="${k}" aria-pressed="${k===x.color}" style="--sw:var(--c-${k})" title="${esc(state.labels[k])}"></button>`).join('')}</div>
      <div class="al"><button class="tog" id="edNotify" role="switch" aria-checked="${!!x.notify}" aria-label="Notify"></button><span>Notify${x.time==null?' (needs a time)':''}</span></div></div>
    <textarea id="edNotes" placeholder="Notes. Links, the address, what you actually need to say.">${esc(x.notes||'')}</textarea>
    <div class="actions"><button class="primary" data-act="done">${x.done?'↺ Not done':'✓ Mark done'}</button><button data-act="tomorrow">Tomorrow →</button><button data-act="nextweek">+1 week</button><button data-act="dup">Duplicate</button><span class="saved" id="saved">saved</span><button class="del" data-act="delete" title="Delete this task (Undo appears afterwards)">Delete</button></div>
  </div></div></div>`;
}
function railHtml(){
  const ws=weekStart(sel),t=todayStr(),L=dowLabels();
  let rail=`<div class="rail"><button class="arrow" data-nav="-7" aria-label="Previous week">‹</button>`;
  for(let i=0;i<7;i++){const ds=addDays(ws,i);const n=dayTasks(ds).filter(x=>!x.done).length;const note=!!state.notes[ds];
    rail+=`<button data-date="${ds}" class="${ds===sel?'sel':''} ${ds===t?'today':''} ${ds<t?'past':''}"><span class="w">${L[i]}</span><span class="n">${fromYmd(ds).getDate()}</span><span class="cnt">${n?n:''}${note?' ≡':''}</span></button>`}
  return rail+`<button class="arrow" data-nav="7" aria-label="Next week">›</button>${lockBtn('board')}</div>`;
}
function nowStrip(){
  if(sel!==todayStr())return'';
  const m=nowMin(),ts=dayTasks(sel).filter(x=>!x.done);
  const cur=ts.find(x=>x.time!=null&&m>=x.time&&m<x.time+(x.dur||30));
  const nxt=ts.find(x=>x.time!=null&&x.time>m);
  const left=ts.length;
  if(!cur&&!nxt&&!left)return'';
  const mins=n=>n>=60?Math.floor(n/60)+'h '+(n%60?n%60+'m':''):n+'m';
  if(cur)return `<div class="now-strip" data-id="${cur.id}" data-act="open"><span class="sunglyph">☉</span><span>Now <b>${esc(cur.title)}</b></span>${nxt?`<span class="nx">· then ${esc(nxt.title)} ${fmtTime(nxt.time)}</span>`:''}<span class="cd">${mins(cur.time+(cur.dur||30)-m)} left</span></div>`;
  if(nxt)return `<div class="now-strip" data-id="${nxt.id}" data-act="open"><span class="sunglyph">☉</span><span>Next <b>${esc(nxt.title)}</b> at ${fmtTime(nxt.time)}</span><span class="cd">in ${mins(nxt.time-m)}</span></div>`;
  return `<div class="now-strip"><span class="sunglyph">☉</span><span>${left} left today, nothing timed</span></div>`;
}
function carryHtml(){
  if(sel!==todayStr()||state.carryDismissed===sel)return'';
  const u=undoneBefore(sel);if(!u.length)return'';
  return `<div class="carry"><span>${u.length} undone from earlier${u.length<4?': '+u.map(x=>esc(x.title)).join(', '):''}</span><span class="spacer"></span><button data-act="carry">Bring to today</button><button class="dis" data-act="carryDismiss">Leave</button></div>`;
}
function renderDay(){
  const ts=dayTasks(sel),open=ts.filter(x=>!x.done),done=ts.filter(x=>x.done);
  let list=open.map(taskRow).join('');
  if(!ts.length)list=`<div class="empty"><b>CLEAR SKIES</b>Nothing on ${sel===todayStr()?'today':'this day'}. Type above, or press N.</div>`;
  else if(!open.length)list=`<div class="empty clear"><div class="sunrise"></div><b>ALL CLEAR</b>${done.length} done. Go outside.</div>`;
  if(done.length)list+=`<div class="sect"><span>Done · ${done.length}</span><button data-act="clearDone">clear</button></div>`+done.map(taskRow).join('');
  const mic=S().voice.enabled?`<button class="mic" id="mic" title="Voice (${esc(S().voice.hotkey)})" aria-label="Voice input">${MIC}<canvas id="micViz" width="152" height="36"></canvas></button>`:'';
  const rb=S().routinesEnabled&&state.routines.length?`<button class="rbtn" data-act="routines" title="Add a routine to this day">routines ▾</button>`:'';
  $('#boardPane').innerHTML=railHtml()+nowStrip()+carryHtml()+`<div class="qa ${mic?'':'nomic'}" id="qaWrap"><span class="plus">+</span><input id="qa" placeholder="Add to ${sel===todayStr()?'today':dowName(sel)}…  “call Sam 3pm 20m #work”" autocomplete="off">${mic}<div class="parse-row"><div class="parse" id="parse"></div>${rb}</div></div><div class="list ${anim.slide||''}" id="list">${list}</div>`;
  if(Voice.isActive()&&mic){$('#mic').classList.add('live');$('#qaWrap').classList.add('listening')}
}
function renderWeek(){
  const ws=weekStart(sel),L=dowLabels();
  let h=`<div class="rail" style="padding-bottom:0"><button class="arrow" data-nav="-7" aria-label="Previous week">‹</button><span class="spacer"></span><button class="arrow" data-nav="7" aria-label="Next week">›</button>${lockBtn('board')}</div><div class="week">`;
  for(let i=0;i<7;i++){const ds=addDays(ws,i);const ts=dayTasks(ds);
    h+=`<div class="col ${ds===todayStr()?'today':''}" data-dropdate="${ds}"><div class="hd" data-date="${ds}" data-goto="day"><span class="n">${fromYmd(ds).getDate()}</span><span class="w">${L[i]}</span></div><div class="items">`+
    ts.map(x=>`<div class="mini-task ${x.done?'done':''} ${anim.enter===x.id?'enter':''}" draggable="true" data-id="${x.id}" data-act="open"><span class="swatch" style="--sw:var(--c-${x.color})"></span><span>${esc(x.title)}</span>${x.time!=null?`<span class="tm">${fmtTime(x.time)}</span>`:''}</div>`).join('')+
    `</div><div class="add"><input data-adddate="${ds}" placeholder="+" aria-label="Add task for ${ds}"></div></div>`}
  $('#boardPane').innerHTML=h+'</div>';
}
function renderMonth(){
  const d=fromYmd(sel);const first=new Date(d.getFullYear(),d.getMonth(),1);const start=weekStart(ymd(first));
  let h=`<div class="rail" style="padding-bottom:0"><button class="arrow" data-nav="month:-1" aria-label="Previous month">‹</button><span class="spacer"></span><button class="arrow" data-nav="month:1" aria-label="Next month">›</button>${lockBtn('board')}</div><div class="month"><div class="dows">${dowLabels().map(x=>`<div>${x}</div>`).join('')}</div><div class="cells">`;
  for(let i=0;i<42;i++){const ds=addDays(start,i);const dd=fromYmd(ds);const ts=dayTasks(ds);
    h+=`<button class="cell ${dd.getMonth()!==d.getMonth()?'out':''} ${ds===todayStr()?'today':''} ${ds===sel?'sel':''}" data-date="${ds}" data-goto="day" data-dropdate="${ds}"><span class="n">${dd.getDate()}</span>`+
    ts.slice(0,3).map(x=>`<span class="pill ${x.done?'done':''}"><span class="swatch" style="--sw:var(--c-${x.color})"></span><span>${esc(x.title)}</span></span>`).join('')+(ts.length>3?`<span class="more">+${ts.length-3}</span>`:'')+`</button>`}
  $('#boardPane').innerHTML=h+'</div></div>';
}
function renderNotes(){
  const words=(state.notes[sel]||'').replace(/<[^>]+>/g,' ').trim().split(/\s+/).filter(Boolean).length;
  $('#boardPane').innerHTML=railHtml()+`<div class="nb">
    <div class="daynav"><button class="arrow" data-nav="-1">‹</button><b>${relDay(sel)} · ${MON[fromYmd(sel).getMonth()].slice(0,3)} ${fromYmd(sel).getDate()}</b><button class="arrow" data-nav="1">›</button><span class="cnt">${words?words+' words':'empty page'}</span></div>
    <div class="tools">
      <button data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button><button data-cmd="italic" title="Italic"><i>I</i></button><button data-cmd="underline" title="Underline"><u>U</u></button><button data-cmd="strikeThrough" title="Strike"><s>S</s></button>
      <span class="sep"></span><button data-cmd="formatBlock" data-val="h2" title="Heading">H</button><button data-cmd="formatBlock" data-val="p" title="Body">¶</button><button data-cmd="insertUnorderedList" title="List">•</button>
      <span class="sep"></span><span class="lbl">HILITE</span>${COLORS.map(([k],i)=>`<button class="hl" data-hl="${k}" style="--sw:var(--c-${k})" title="${esc(state.labels[k])} (Ctrl+${i+1})"></button>`).join('')}<button data-hl="none" title="Remove highlight" style="font-weight:400">⌀</button>
      <span class="sep"></span><button data-cmd="removeFormat" title="Clear formatting" style="font-weight:400">Tx</button>
    </div>
    <div class="page" id="page" contenteditable="true" data-ph="Notes for ${relDay(sel).toLowerCase()}. Select text, hit a highlighter." spellcheck="true">${state.notes[sel]||''}</div></div>`;
}
function renderSide(){
  const side=$('#tlPane');const ts=dayTasks(sel);const timed=ts.filter(t=>t.time!=null),any=ts.filter(t=>t.time==null&&!t.done);
  const H0=0,H1=24,rows=H1-H0,hh=S().hh,m=nowMin(),today=sel===todayStr();
  let h=`<div class="pane-hd"><b>${relDay(sel)}${!today?' '+fromYmd(sel).getDate():''}</b><span class="eyebrow">${timed.length} timed · ${any.length} anytime</span><span class="hd-acts"><span class="zoom"><button data-zoom="-1" title="Zoom out">−</button><button data-zoom="1" title="Zoom in">+</button><button data-zoom="fit" title="Fit the whole day in view">⤢</button></span>${lockBtn('tl')}<button class="x" data-pane="tl" title="Hide pane">×</button></span></div><div class="tl">`;
  if(any.length)h+=`<div class="anytime">${any.map(x=>`<span class="chip" data-id="${x.id}" data-act="open"><span class="swatch" style="--sw:var(--c-${x.color})"></span>${esc(x.title)}</span>`).join('')}</div>`;
  h+=`<div class="hours" style="--rows:${rows};--hh:${hh}px">`;
  for(let i=0;i<rows;i++)h+=`<div class="h" data-hour="${H0+i}" style="top:${i*hh}px"><span>${fmtTime((H0+i)*60)}</span></div>`;
  for(const x of timed){const top=(x.time-H0*60)/60*hh;const hgt=Math.max(18,(x.dur||30)/60*hh-3);if(top<0||top>rows*hh)continue;const live=today&&!x.done&&m>=x.time&&m<x.time+(x.dur||30);
    h+=`<div class="blk ${x.done?'done':''} ${live?'live':''} ${x.id===openId?'editing':''}" data-id="${x.id}" data-act="open" draggable="true" style="--sw:var(--c-${x.color});top:${top}px;height:${hgt}px">${esc(x.title)}${hgt>30?`<small>${fmtTime(x.time)}${x.dur?' · '+fmtDur(x.dur):''}</small>`:''}</div>`}
  if(today&&m>=H0*60&&m<=H1*60)h+=`<div class="now" style="top:${(m-H0*60)/60*hh}px"><i>☉ ${fmtTime(m)}</i></div>`;
  const prev=side.querySelector('.tl');const keep=prev&&prev.dataset.date===sel&&prev.dataset.hh===String(hh)?prev.scrollTop:null;
  side.innerHTML=h+'</div></div>';
  const tl=side.querySelector('.tl');tl.dataset.date=sel;tl.dataset.hh=hh;
  const now=side.querySelector('.now');
  if(keep!=null)tl.scrollTop=keep;else if(now)tl.scrollTop=Math.max(0,parseFloat(now.style.top)-120);else{const first=side.querySelector('.blk');if(first)tl.scrollTop=Math.max(0,parseFloat(first.style.top)-60)}
}

// ---------- overlays ----------
let toastT=null;
function toast(msg,undoFn){
  document.querySelectorAll('.toast').forEach(x=>x.remove());clearTimeout(toastT);
  const el=document.createElement('div');el.className='toast';el.innerHTML=`<span>${esc(msg)}</span>${undoFn?'<button>Undo</button>':''}`;
  if(undoFn)el.querySelector('button').onclick=()=>{undoFn();el.remove()};
  document.body.appendChild(el);toastT=setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),260)},5000);
}
function closeMenu(){const m=$('.menu');if(m)m.remove()}
function menu(x,y,id){
  closeMenu();const t=get(id);if(!t)return;
  const el=document.createElement('div');el.className='menu';el.dataset.id=id;
  el.innerHTML=`<button data-act="open">Open<span class="k">↵</span></button><button data-act="done">${t.done?'Mark not done':'Mark done'}<span class="k">␣</span></button><div class="sep"></div>
  <button data-act="tomorrow">Move to tomorrow</button><button data-act="nextweek">Move +1 week</button><button data-act="dup">Duplicate</button><button data-act="notify">${t.notify?'Mute notifications':'Notify me'}</button><div class="sep"></div>
  <div class="cl">${COLORS.map(([k])=>`<button data-setcolor="${k}" data-id="${id}" style="--sw:var(--c-${k})" title="${esc(state.labels[k])}"></button>`).join('')}</div><div class="sep"></div>
  <button class="del" data-act="delete">Delete<span class="k">⌫</span></button>`;
  document.body.appendChild(el);
  const r=el.getBoundingClientRect();el.style.left=Math.min(x,innerWidth-r.width-8)+'px';el.style.top=Math.min(y,innerHeight-r.height-8)+'px';
}
function scrim(inner,cls){const s=document.createElement('div');s.className='scrim'+(cls==='search'?' search':'');s.innerHTML=`<div class="card ${cls}">${inner}</div>`;document.body.appendChild(s);if(cls!=='alarm')s.addEventListener('click',e=>{if(e.target===s)closeScrim(s)});return s}
// closes the topmost live scrim unless told which one; an alarm scrim also silences its repeating sound
function closeScrim(el){const all=document.querySelectorAll('.scrim:not(.out)');const s=el||all[all.length-1];if(!s)return;recordingHotkey=false;if(s.classList.contains('alarm-host'))SFX.stopRepeat();s.classList.add('out');setTimeout(()=>s.remove(),200)}

// ----- notifications: banners (drain bar) or takeover; sounds; repeat until Continue -----
function bannerHost(){let b=$('#banners');if(!b){b=document.createElement('div');b.id='banners';document.body.appendChild(b)}b.className='banners '+S().bannerPos;return b}
// The repeating start sound belongs to exactly one banner (or the takeover); only dismissing that one silences it.
function dismissBanner(el){if(!el||el.classList.contains('out'))return;el.classList.add('out');if(el._repeat)SFX.stopRepeat();setTimeout(()=>el.remove(),260)}
function snooze(t){if(t&&t.id){upd(t.id,{snoozeUntil:Date.now()+10*60000},true)}toast('Snoozed 10 minutes')}
function notify(ev,demo){
  const t=ev.task,st=S(),start=ev.kind==='start';
  const style=start?st.startStyle:st.remindStyle;const popup=style!=='off'||demo;
  if(!demo)markFired(ev.key);
  // sound and popup are independent switches; the sound only repeats when there is a Continue button to stop it
  let owner=null;
  if(st.sounds.enabled){const nm=start?'start.'+st.sounds.start:'remind.'+st.sounds.remind;SFX.play(nm);if(start&&st.sounds.repeat&&popup){document.querySelectorAll('.banner').forEach(b=>b._repeat=false);SFX.repeat(nm,st.sounds.repeat);owner=true}}
  const label=start?'Starting now':'In '+fmtLead(ev.lead||0).replace(' before','');
  const meta=(t.time!=null?fmtTime(t.time):'')+(t.dur?' · '+fmtDur(t.dur):'')+(t.notes?' · '+t.notes.slice(0,60):'');
  if(!popup)return;
  if(start&&style==='takeover'){takeover(t,demo,owner);return}
  // desktop: a corner toast window (Steam-style) instead of the in-app banner and the OS toast
  if(window.SundialDesktop&&st.toasts.enabled){
    window.SundialDesktop.toastShow({id:t.id||null,kind:start?'start':'remind',label:label+(demo?' · preview':''),title:t.title,meta,corner:st.toasts.corner,secs:st.bannerSecs,sticky:!!owner,
      actions:start?[{id:'snooze',label:'10m'},{id:'continue',label:'Continue',primary:true}]:[{id:'open',label:'Open'},{id:'ok',label:'OK',primary:true}]}).catch(e=>{console.error('toast failed',e);inAppBanner()});
    return;
  }
  try{const bg=document.hidden||!document.hasFocus();
    if(bg&&window.SundialDesktop)window.SundialDesktop.notify('Sundial · '+t.title,label+(t.time!=null?' · '+fmtTime(t.time):'')).catch(()=>{});
    else if(document.hidden&&'Notification'in window&&Notification.permission==='granted')new Notification('Sundial · '+t.title,{body:label})}catch(_){}
  inAppBanner();
  function inAppBanner(){
  const host=bannerHost();while(host.children.length>=3){const first=host.firstChild;if(first._repeat)SFX.stopRepeat();first.remove()}
  const sticky=!!owner;
  const el=document.createElement('div');el.className='banner '+(start?'start':'remind');el._repeat=sticky;
  el.innerHTML=`<div class="ic">${start?'☉':'◔'}</div><div class="tx"><span class="k">${start?'Starting now':'In '+fmtLead(ev.lead||0).replace(' before','')}${demo?' · preview':''}</span><b>${esc(t.title)}</b><small>${t.time!=null?fmtTime(t.time):''}${t.dur?' · '+fmtDur(t.dur):''}${t.notes?' · '+esc(t.notes.slice(0,60)):''}</small></div>
    <div class="bt">${start?'<button data-b="snooze">10m</button><button class="ok" data-b="ok">Continue</button>':'<button data-b="open">Open</button><button class="ok" data-b="ok">OK</button>'}</div>${sticky?'':`<div class="bar" style="--secs:${st.bannerSecs}s"></div>`}`;
  el.querySelector('[data-b="ok"]').onclick=()=>dismissBanner(el);
  const op=el.querySelector('[data-b="open"]');if(op)op.onclick=()=>{dismissBanner(el);if(t.id){view='day';goDay(t.date);openId=t.id;render()}};
  const sn=el.querySelector('[data-b="snooze"]');if(sn)sn.onclick=()=>{dismissBanner(el);snooze(t)};
  // auto-dismiss: the drain animation when it runs, a timer when it cannot (reduced motion, hidden window); hovering holds both
  const bar=el.querySelector('.bar');
  if(bar){const secs=st.bannerSecs*1000;let done=false;const fin=()=>{if(!done){done=true;dismissBanner(el)}};
    bar.addEventListener('animationend',fin);
    const arm=ms=>setTimeout(()=>{if(done)return;if(el.matches(':hover'))arm(1000);else fin()},ms);
    arm(reduced()?secs:secs+1500)}
  host.appendChild(el);
  }
}
// what the user pressed on a corner toast
function onToastAction(ev){const a=ev.action,p=ev.payload||{};const t=p.id?get(p.id):null;
  if(a==='continue'||a==='dismiss'||a==='timeout'||a==='ok'){if(p.kind==='start')SFX.stopRepeat();return}
  if(a==='snooze'){SFX.stopRepeat();if(t)snooze(t);return}
  if(a==='open'){if(t){view='day';goDay(t.date);openId=t.id;render();revealTask(t.id)}return}
  if(a==='install'){installUpdate(null);return}
  if(a==='later')return;
}
function takeover(x,demo){
  if($('.scrim.alarm-host'))return;
  const s=scrim(`<span class="eyebrow">▲ STARTING NOW${demo?' · PREVIEW':''}</span><h2>${esc(x.title)}</h2><div class="when">${fmtTime(x.time)}${x.dur?' · '+fmtDur(x.dur):''}${x.notes?'<br>'+esc(x.notes.slice(0,120)):''}</div><button class="go" id="toGo">Continue</button><button class="snooze" id="toSnooze">Remind me in 10 minutes</button>`,'alarm');
  s.classList.add('alarm-host');
  s.querySelector('#toGo').focus();s.querySelector('#toGo').onclick=()=>closeScrim(s);
  s.querySelector('#toSnooze').onclick=()=>{snooze(x);closeScrim(s)};
}
function previewNotify(kind){const t=dayTasks(sel).find(x=>x.time!=null)||{title:'Call the bank about the card',time:13*60,dur:15,notes:''};notify({task:t,kind,key:'demo',lead:S().defaultRemind},true)}

// ----- settings sheet -----
function settings(){
  if($('.scrim.sheet-host')){closeScrim($('.scrim.sheet-host'));return}
  const s=scrim(`<button class="x" data-close>×</button><h2>Settings</h2><div class="tabs" id="stabs"></div><div id="sbody"></div>`,'sheet');s.classList.add('sheet-host');
  s.querySelector('[data-close]').onclick=()=>closeScrim(s);sheetAnim=true;renderSheet();
  const D=window.SundialDesktop;if(D)D.autostart.get().then(v=>{autostartOn=!!v;if(sheetTab==='general')renderSheet()}).catch(()=>{});refreshAiKey();
}
function renderSheet(){
  const s=$('.sheet-host');if(!s)return;const st=S();const body=s.querySelector('#sbody');const sc=s.querySelector('.card').scrollTop;
  const TABS=[['general','General'],['notify','Notifications'],['sound','Sounds'],['voice','Voice'],['ai','AI parsing'],['routines','Routines'],['data','Data & sync']];
  s.querySelector('#stabs').innerHTML=TABS.map(([k,l])=>`<button data-tab="${k}" aria-pressed="${sheetTab===k}">${l}</button>`).join('');
  const seg=(key,opts)=>`<div class="seg">${opts.map(([v,l])=>`<button data-set="${key}" data-val="${v}" aria-pressed="${String(getPath(st,key))===String(v)}">${l}</button>`).join('')}</div>`;
  const tog=(key)=>`<button class="tog" role="switch" data-tog="${key}" aria-checked="${!!getPath(st,key)}"></button>`;
  const opt=(label,sub,ctl)=>`<div class="opt"><div>${label}${sub?`<small>${sub}</small>`:''}</div><div class="ctl">${ctl}</div></div>`;
  let h='';
  if(sheetTab==='general')h=opt('Theme','Follows the system by default.',seg('theme',[['system','system'],['light','light'],['dark','dark']]))
    +opt('Week starts on','',seg('weekStart',[['1','Mon'],['0','Sun']]))
    +opt('Time format','',seg('h24',[['false','1:30pm'],['true','13:30']]))
    +opt('Density','Compact fits more rows on screen.',seg('density',[['comfortable','comfortable'],['compact','compact']]))
    +`<div class="opt"><div>Layout<small>Auto stacks the panes on tall screens and narrow windows. Drag the bar between two panes to resize them either way; double-click it to reset.</small></div><div class="ctl"><div class="seg">${[['auto','auto'],['row','side by side'],['column','stacked']].map(([v,l])=>`<button data-set="layout.mode" data-val="${v}" aria-pressed="${(state.layout.mode||'auto')===v}">${l}</button>`).join('')}</div>${effectiveMode()==='column'?'<button class="btn" data-run="fitWindow">Fit to window</button>':''}</div></div>`
    +(effectiveMode()==='column'?`<div class="opt"><div>Stacked sections<small>Each box has a padlock by its ×. Locked: it keeps the height you gave it and scrolls inside. Unlocked: it grows to its content and the whole column scrolls. Drag a bar to set a height (locks it); double-click a bar to unlock.</small></div></div>`:'')
    +opt('Quick add from anywhere',`A floating add bar over whatever you are looking at; the + button does the same. System-wide in the desktop app. Style: <b>${hotkeyStyle()}</b>. Two modifiers plus a key stays out of games’ way; Pause or Scroll Lock alone also works. A system-wide shortcut cannot chord two regular keys.`,`<button class="key" data-run="recQuick">${esc(st.quick.hotkey)}</button><button class="btn" data-run="onboard">Choose a style</button>`)
    +opt('Clear example tasks','Removes only the seeded examples.','<button class="btn" data-run="clearEx">Clear</button>')
    +(window.SundialDesktop?desktopGeneralRows():'')
    +`<h3>Colors</h3><div class="opt" style="border:0;padding-top:0"><div><small>Six colors, your names. Type <code>#name</code> in a task line to pick one. The names are also editable right in the calendar pane.</small></div></div>`
    +COLORS.map(([k])=>`<div class="opt colorrow"><div class="rowx"><span class="swatch" style="--sw:var(--c-${k})"></span><input class="key" style="text-align:left;min-width:200px" data-color="${k}" value="${esc(state.labels[k])}" aria-label="Name for the ${k} color" spellcheck="false"></div><div class="ctl"><small class="mono">#${esc(state.labels[k].toLowerCase().replace(/\s+/g,''))}</small></div></div>`).join('');
  if(sheetTab==='notify')h=opt('Notify by default','New timed tasks get a reminder and a start alert. Per-task override lives in the task drawer.',tog('notifyDefault'))
    +opt('Default reminder','How far ahead the reminder fires.',`<select data-sel="defaultRemind">${[[5,'5m before'],[15,'15m before'],[30,'30m before'],[60,'1h before'],[120,'2h before'],[1440,'1 day before']].map(([v,l])=>`<option value="${v}" ${st.defaultRemind===v?'selected':''}>${l}</option>`).join('')}</select>`)
    +opt('Reminder style','',seg('remindStyle',[['banner','banner'],['off','off']]))
    +opt('Start alert style','Banner stays until Continue when the sound repeats; otherwise it drains like a reminder.',seg('startStyle',[['banner','banner'],['takeover','full window'],['off','off']]))
    +(window.SundialDesktop?opt('Corner notifications','Steam-style: a small Sundial window in a screen corner, over whatever you are doing, never taking focus. Off falls back to in-app banners and plain Windows toasts.',tog('toasts.enabled'))
      +(st.toasts.enabled?opt('Corner','',`<select data-sel="toasts.corner">${[['bottom-left','bottom left'],['bottom-right','bottom right'],['top-left','top left'],['top-right','top right']].map(([v,l])=>`<option value="${v}" ${st.toasts.corner===v?'selected':''}>${l}</option>`).join('')}</select>`):''):'')
    +opt('Banner position','In-app banners (browser, or corner notifications off).',seg('bannerPos',[['top','top'],['bottom','bottom']]))
    +opt('Banner stays for','Reminders dismiss themselves when the bar runs out. Hover pauses it.',`<input type="range" min="5" max="120" step="5" value="${st.bannerSecs}" data-range="bannerSecs"><span class="key" id="secsLbl">${st.bannerSecs}s</span>`)
    +opt('Preview','Hear and see both.','<button class="btn" data-run="prevRemind">Reminder</button><button class="btn" data-run="prevStart">Start</button>');
  if(sheetTab==='sound')h=opt('Sounds','',tog('sounds.enabled'))
    +opt('Volume','',`<input type="range" min="0" max="1" step=".05" value="${st.sounds.volume}" data-range="sounds.volume">`)
    +opt('Reminder sound','A wristwatch tick or a glass note, once or twice.',`<select data-sel="sounds.remind">${[['tick1','tick once'],['tick2','tick twice'],['glass1','glass once'],['glass2','glass twice']].map(([v,l])=>`<option value="${v}" ${st.sounds.remind===v?'selected':''}>${l}</option>`).join('')}</select><button class="btn icon" data-play="remind" title="Play">▶</button>`)
    +opt('Start sound','Marimba chord, music box, a theremin slide, or a felt piano.',`<select data-sel="sounds.start">${[['chord','marimba chord'],['musicbox','music box'],['theremin','theremin'],['felt','felt piano']].map(([v,l])=>`<option value="${v}" ${st.sounds.start===v?'selected':''}>${l}</option>`).join('')}</select><button class="btn icon" data-play="start" title="Play">▶</button>`)
    +opt('Repeat start sound','Until you press Continue.',`<select data-sel="sounds.repeat">${[[0,'off'],[15,'every 15s'],[30,'every 30s'],[45,'every 45s'],[60,'every 60s']].map(([v,l])=>`<option value="${v}" ${st.sounds.repeat===v?'selected':''}>${l}</option>`).join('')}</select>`)
    +opt('Little sounds','Completing a task climbs a marimba ladder; clearing the day resolves it.',tog('sounds.ui')+'<button class="btn icon" data-play="ui.done" title="Play">▶</button>');
  if(sheetTab==='voice')h=opt('Microphone','Off means Sundial never asks for or opens the microphone: the voice button is hidden and the hotkey does nothing. On, the mic is live only while the button is lit.',tog('voice.enabled'))
    +(st.voice.enabled?opt('Hotkey','Press it anywhere to start listening; press again to stop.',`<button class="key" id="hotkey" data-run="recHotkey">${esc(st.voice.hotkey)}</button>`)
    +opt('Add on finish','Add the task the moment you stop talking. Off leaves it in the field for a look first.',tog('voice.autoAdd'))
    +opt('Where the words come from',Voice.hasSR()?'In this browser, the browser’s own speech engine turns speech into text (Chrome sends audio to Google for that). The desktop build transcribes on your machine and sends nothing anywhere.':'No speech engine in this browser, so only the level meter runs here. The desktop build transcribes on your machine and sends nothing anywhere.','<span class="soon">'+(Voice.hasSR()?'BROWSER':'DESKTOP')+'</span>'):'');
  if(sheetTab==='routines'){h=opt('Routines','Sets of tasks you add in one click: a morning, a launch day, a weekly reset. One task per line, in the same words you would type into the add field.',tog('routinesEnabled'));
    if(st.routinesEnabled)h+=`<div class="routines">`+state.routines.map(r=>`<div class="rt"><div class="rt-hd"><input class="rt-name" data-rt-name="${r.id}" value="${esc(r.name)}" aria-label="Routine name"><button class="btn" data-rt-apply="${r.id}" data-to="${todayStr()}">Add to today</button>${sel!==todayStr()?`<button class="btn" data-rt-apply="${r.id}" data-to="${sel}">Add to ${esc(relDay(sel))} ${fromYmd(sel).getDate()}</button>`:''}<button class="x" data-rt-del="${r.id}" title="Delete routine">×</button></div><textarea data-rt-lines="${r.id}" spellcheck="false" placeholder="Coffee and plan the day 8am 15m #admin">${esc(r.lines.join('\n'))}</textarea></div>`).join('')
      +`</div><div class="ctl" style="gap:8px;padding-top:8px"><button class="btn" data-run="rtNew">New routine</button><button class="btn" data-run="rtReset">Reset to starter set</button></div>`}
  if(sheetTab==='ai')h=aiTab(st,opt,tog);
  if(sheetTab==='data')h=`<h3>Calendars</h3>`+opt('Apple / Google Calendar','Copies this day as .ics text. Paste into a file named day.ics and open it; both calendars import it, reminders included.','<button class="btn" data-run="icsDay">Copy day</button>')
    +opt('Everything as .ics','All tasks, all days, repeats as RRULEs.','<button class="btn" data-run="icsAll">Copy all</button>')
    +opt('Live two-way sync','CalDAV / Google Calendar API in the desktop build.','<span class="soon">PLANNED</span>')
    +syncRows(st,opt)
    +opt('Export JSON','Tasks, notes, labels, change log.','<button class="btn" data-run="expJson">Copy</button>')
    +opt('Import JSON','Paste a backup and press Import. Merges by id, newest wins.','<button class="btn" data-run="impJson">Import</button>')
    +`<textarea id="impBox" placeholder="{ &quot;tasks&quot;: [ … ] }"></textarea>`
    +`<h3>Input</h3>`+opt('AI parsing','“lunch with Kai next thursday, same place” → task with time and notes.','<span class="soon">PLANNED</span>');
  body.innerHTML=h;if(sheetAnim){sheetAnim=false;body.classList.add('tab-in');s.querySelector('.card').scrollTop=0}else{body.classList.remove('tab-in');s.querySelector('.card').scrollTop=sc}
}
const getPath=(o,p)=>p.split('.').reduce((a,k)=>a&&a[k],o);
const setPath=(o,p,v)=>{const ks=p.split('.');const last=ks.pop();const t=ks.reduce((a,k)=>a[k],o);t[last]=v};
function applySetting(key,val){
  if(key.startsWith('layout.')){setPath(state,key,val);save();applyLayout();render();renderSheet();return}
  const st=S();
  if(key==='weekStart')val=+val;else if(key==='h24')val=val==='true';else if(key==='defaultRemind'||key==='sounds.repeat'||key==='bannerSecs')val=+val;else if(key==='sounds.volume')val=+val;
  setPath(st,key,val);save();
  if(key==='theme')applyTheme();if(key==='density')applyDensity();if(key==='sounds.volume')SFX.setVolume(val);if(key==='bannerPos')bannerHost();
  if(key==='routinesEnabled'&&val)ensureRoutines();
  if(key==='voice.enabled'&&!val&&Voice.isActive()){Voice.stop();resetMicUi()}
  if(key==='voice.enabled')syncHotkeys();
  if(key==='ai.provider'||key==='ai.enabled')refreshAiKey();
  render();renderSheet();
}

// ----- search -----
function openSearch(){
  if($('.scrim'))closeScrim();
  const s=scrim(`<input id="sq" placeholder="Search tasks and notes…" autocomplete="off"><div class="res" id="sres"></div>`,'search');
  const q=s.querySelector('#sq');q.focus();
  const run=()=>{const v=q.value.trim().toLowerCase();const res=s.querySelector('#sres');if(!v){res.innerHTML='';return}
    const strip=h=>h.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    const tasks=state.tasks.filter(t=>t.title.toLowerCase().includes(v)||(t.notes||'').toLowerCase().includes(v)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20);
    const notes=Object.keys(state.notes).filter(d=>strip(state.notes[d]).toLowerCase().includes(v)).sort().reverse().slice(0,10);
    res.innerHTML=tasks.map(t=>`<button class="r" data-sid="${t.id}"><span class="when">${esc(relDay(t.date))} ${fromYmd(t.date).getDate()}</span><span class="swatch" style="--sw:var(--c-${t.color})"></span><span class="t">${esc(t.title)}</span><span class="kind">${t.done?'DONE':'TASK'}</span></button>`).join('')
      +notes.map(d=>`<button class="r" data-snote="${d}"><span class="when">${esc(relDay(d))} ${fromYmd(d).getDate()}</span><span class="t">${esc(strip(state.notes[d]).slice(0,80))}</span><span class="kind">NOTE</span></button>`).join('')
      +(!tasks.length&&!notes.length?'<div class="none">Nothing matches.</div>':'');
    const first=res.querySelector('.r');if(first)first.classList.add('cursor')};
  q.addEventListener('input',run);
  s.addEventListener('click',e=>{const r=e.target.closest('.r');if(!r)return;pick(r)});
  const pick=r=>{if(r.dataset.sid){const t=get(r.dataset.sid);view='day';goDay(t.date);openId=t.id}else{view='notes';goDay(r.dataset.snote)}closeScrim();render()};
  q.addEventListener('keydown',e=>{const rs=[...s.querySelectorAll('.r')];let i=rs.findIndex(x=>x.classList.contains('cursor'));
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!rs.length)return;rs[i]?.classList.remove('cursor');i=(i+(e.key==='ArrowDown'?1:-1)+rs.length)%rs.length;rs[i].classList.add('cursor');rs[i].scrollIntoView({block:'nearest'})}
    if(e.key==='Enter'&&rs[i])pick(rs[i])});
}

// ----- voice button -----
function drawViz(data){const c=$('#micViz');if(!c)return;const g=c.getContext('2d');const W=c.width,H=c.height;g.clearRect(0,0,W,H);g.fillStyle=getComputedStyle(c.parentElement).color;const n=18;
  for(let i=0;i<n;i++){const v=data[Math.floor(i*data.length/n/2)]/255;const h=Math.max(4,v*H*.95);const x=i*(W/n)+2,y=(H-h)/2,w=W/n-4;if(g.roundRect){g.beginPath();g.roundRect(x,y,w,h,3);g.fill()}else g.fillRect(x,y,w,h)}}
function voiceError(code){const msg={nomic:'No microphone is available in this window. The desktop build has it.',denied:'Microphone is blocked in this window (this preview can’t use it; the desktop build can).',nosr:'No speech engine in this browser, so the meter runs without words. The desktop build transcribes locally.',network:'Speech service unreachable; mic stays on, no words. The desktop build transcribes locally.','not-allowed':'Speech recognition is blocked here; mic stays on, no words.','service-not-allowed':'Speech recognition is blocked here; mic stays on, no words.','audio-capture':'No microphone found.'}[code]||('Voice: '+code);
  toast(msg);const m=$('#mic');if(m){m.classList.add('err');setTimeout(()=>m.classList.remove('err'),1200)}}
let voiceHeard=false;
async function toggleVoice(){
  if(Voice.isActive()){Voice.stop();voiceEnded();return}
  if(view!=='day'){view='day';render()}
  const qa=$('#qa');if(!qa)return;const base=qa.value.trim();voiceHeard=false;
  const ok=await Voice.start({
    onLevel:drawViz,
    onResult:(fin,inter)=>{const q=$('#qa');if(!q)return;if(fin||inter)voiceHeard=true;q.value=[base,fin,inter].filter(Boolean).join(' ');previewParse()},
    onError:code=>{voiceError(code);if(!Voice.isSoft(code)){Voice.stop();resetMicUi()}},
    onEnd:voiceEnded});
  if(ok){const m=$('#mic');if(m)m.classList.add('live');const w=$('#qaWrap');if(w)w.classList.add('listening');SFX.play('ui.voice.on');const q=$('#qa');if(q)q.focus()}
}
function resetMicUi(){const m=$('#mic');if(m)m.classList.remove('live');const w=$('#qaWrap');if(w)w.classList.remove('listening');SFX.play('ui.voice.off')}
function voiceEnded(){resetMicUi();
  const q=$('#qa');if(q&&q.value.trim()&&S().voice.autoAdd&&voiceHeard){const raw=q.value;const n=addTask(raw,sel);if(n){q.value='';previewParse();SFX.play('ui.add');if(n.date!==sel)goDay(n.date);render();toast('Added “'+n.title.slice(0,30)+'”');aiRefine(n,raw)}}else if(q)q.focus();voiceHeard=false}
const comboOf=e=>{if(['Control','Shift','Alt','Meta'].includes(e.key))return null;const p=[];if(e.ctrlKey)p.push('Ctrl');if(e.altKey)p.push('Alt');if(e.shiftKey)p.push('Shift');if(e.metaKey)p.push('Meta');p.push(e.key===' '?'Space':e.key.length===1?e.key.toUpperCase():e.key);return p.join('+')};

// ---------- events ----------
function revealTask(id){setTimeout(()=>{const el=document.querySelector('.task[data-id="'+id+'"]');if(!el)return;el.scrollIntoView({block:'center',behavior:reduced()?'auto':'smooth'});el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash')},40)}
function closeDrawer(){const dr=$('.drawer');if(dr&&!reduced()){collapseDrawerEl(dr);setTimeout(()=>{openId=null;render()},240)}else{openId=null;render()}}
function goDay(ds,dir){if(ds===sel)return;anim.slide=dir||(ds>sel?'slide-l':'slide-r');sel=ds;miniMonth=sel.slice(0,7);cursorId=null}
function removeTask(id,animate){
  const t=get(id);if(!t)return;
  const finish=()=>{lastDeleted=deleteTask(id);if(openId===id)openId=null;if(cursorId===id)cursorId=null;render();toast('Deleted “'+t.title.slice(0,28)+(t.title.length>28?'…':'')+'”',()=>{if(lastDeleted){restoreTask(lastDeleted);anim.enter=lastDeleted.id;lastDeleted=null;render()}})};
  const el=animate&&document.querySelector(`.task[data-id="${id}"]`);
  if(el&&!reduced()){const dr=el.parentElement.querySelector('.drawer');if(dr)collapseDrawerEl(dr);el.style.height=el.offsetHeight+'px';void el.offsetHeight;el.classList.add('gone');setTimeout(finish,240)}else finish();
}
function toggleDone(id){
  const x=get(id);if(!x)return;anim.pop=id;const spawned=completeTask(id,!x.done);
  if(!x.done){SFX.play('ui.undone')}
  else{const left=dayTasks(x.date).filter(t=>!t.done).length;if(!left)SFX.play('ui.clear');else SFX.play('ui.done');if(spawned)toast('Next one planted for '+relDay(spawned.date).toLowerCase()+' '+fromYmd(spawned.date).getDate())}
  render();
}
document.addEventListener('click',e=>{
  const inMenu=e.target.closest('.menu');if(!inMenu)closeMenu();
  const b=e.target.closest('button,[data-act],[data-date]');if(!b)return;
  if(b.dataset.view){view=b.dataset.view;openId=null;render();return}
  if(b.id==='layoutBtn'){state.layout.mode=effectiveMode()==='column'?'row':'column';save();applyLayout();render();return}
  if(b.dataset.lock){const L=state.layout,k=b.dataset.lock;L.lock=L.lock||{};if(!L.lock[k])L[HK[k]]=Math.round($(PANE[k]).getBoundingClientRect().height);L.lock[k]=!L.lock[k];save();applyLayout();return}
  if(b.dataset.pane){togglePane(b.dataset.pane);return}
  if(b.id==='todayBtn'){goDay(todayStr());render();return}
  if(b.id==='settingsBtn'){settings();return}
  if(b.id==='searchBtn'){openSearch();return}
  if(b.id==='quickBtn'){openQuickAdd();return}
  if(b.dataset.act==='routines'){const r=b.getBoundingClientRect();routinesMenu(r.left,r.bottom+4);return}
  if(b.dataset.rtApply){const n=applyRoutine(b.dataset.rtApply,b.dataset.to);closeMenu();SFX.play('ui.add');render();renderSheet();toast(n+' added to '+dayLabel(b.dataset.to),()=>{undo();render()});return}
  if(b.dataset.rtDel){deleteRoutine(b.dataset.rtDel);renderSheet();render();return}
  if(b.dataset.rtManage){closeMenu();sheetTab='routines';settings();return}
  if(b.id==='mic'){toggleVoice();return}
  if(b.id==='mPrev'||b.id==='mNext'){let[y,m]=miniMonth.split('-').map(Number);m+=b.id==='mNext'?1:-1;if(m<1){m=12;y--}if(m>12){m=1;y++}miniMonth=y+'-'+pad(m);renderMini();return}
  if(b.dataset.nav){const n=b.dataset.nav;let ds;if(n.startsWith('month:')){const d=fromYmd(sel);d.setDate(1);d.setMonth(d.getMonth()+(+n.slice(6)));ds=ymd(d)}else ds=addDays(sel,+n);goDay(ds,+n<0?'slide-r':'slide-l');render();return}
  if(b.dataset.zoom){if(b.dataset.zoom==='fit'){const tl=$('#tlPane .tl');S().hh=Math.max(20,Math.min(120,Math.floor(((tl?tl.clientHeight:600)-6)/24)))}else S().hh=Math.max(20,Math.min(120,S().hh+(+b.dataset.zoom)*12));save();renderSide();return}
  if(b.dataset.cmd){e.preventDefault();return}
  if(b.dataset.hl!=null)return;
  // settings sheet controls
  if(b.dataset.tab){sheetTab=b.dataset.tab;sheetAnim=true;renderSheet();return}
  if(b.dataset.set){applySetting(b.dataset.set,b.dataset.val);return}
  if(b.dataset.tog){applySetting(b.dataset.tog,!getPath(S(),b.dataset.tog));return}
  if(b.dataset.play){const st=S();const nm=b.dataset.play==='remind'?'remind.'+st.sounds.remind:b.dataset.play==='start'?'start.'+st.sounds.start:b.dataset.play;SFX.play(nm,true);return}
  if(b.dataset.autostart){const D=window.SundialDesktop;if(D)D.autostart.set(!autostartOn).then(()=>{autostartOn=!autostartOn;renderSheet()}).catch(e=>toast('Could not change: '+e));return}
  if(b.dataset.style){document.querySelectorAll('.ob-card').forEach(c=>c.setAttribute('aria-pressed',String(c===b)));return}
  if(b.dataset.syncmode){syncSetup.mode=b.dataset.syncmode;renderSheet();return}
  if(b.dataset.run){runSetting(b.dataset.run,b);return}
  const idSrc=e.target.closest('[data-id],[data-drawer]');const id=b.dataset.id||(idSrc&&(idSrc.dataset.id||idSrc.dataset.drawer))||(inMenu&&inMenu.dataset.id)||openId;
  if(b.dataset.setcolor){const tid=b.dataset.id||id;if(tid){upd(tid,{color:b.dataset.setcolor});closeMenu();render()}return}
  if(b.id==='edNotify'&&openId){upd(openId,{notify:!get(openId).notify});render();return}
  const act=b.dataset.act;
  if(act==='clearDone'){const gone=clearDone(sel);render();toast(gone.length+' done tasks cleared',()=>{gone.forEach(restoreTask);render()});return}
  if(act==='carry'){const n=carryAll(sel);render();toast(n+' brought to today',()=>{undo();render()});return}
  if(act==='carryDismiss'){state.carryDismissed=sel;save();render();return}
  if(!act){if(b.dataset.date){goDay(b.dataset.date);if(b.dataset.goto)view=b.dataset.goto;openId=null;render()}return}
  if(!id)return;closeMenu();
  if(act==='done'){toggleDone(id);return}
  if(act==='color'){const x=get(id);const i=COLORS.findIndex(c=>c[0]===x.color);upd(id,{color:COLORS[(i+1)%COLORS.length][0]});render();return}
  if(act==='open'){const x=get(id);if(!x)return;if(openId===id){closeDrawer();return}openId=id;cursorId=id;if(view!=='day')view='day';if(x.date!==sel)goDay(x.date);
    if(!state.layout.board){state.layout.board=true;save();applyLayout()}
    render();revealTask(id);return}
  if(act==='tomorrow'){moveTo(id,addDays(get(id).date,1));render();toast('Moved to '+relDay(get(id).date).toLowerCase());return}
  if(act==='nextweek'){moveTo(id,addDays(get(id).date,7));render();toast('Moved a week out');return}
  if(act==='dup'){duplicate(id);render();return}
  if(act==='notify'){upd(id,{notify:!get(id).notify});render();return}
  if(act==='delete'){removeTask(id,true);return}
  if(act==='close'){closeDrawer();return}
});
function runSetting(k,b){
  const s=$('.sheet-host');
  if(k==='clearEx'){const n=state.tasks.filter(t=>t.example).length;pushUndo();state.tasks=state.tasks.filter(t=>!t.example);save();render();toast(n+' example tasks removed',()=>{undo();render()})}
  if(k==='prevRemind'){previewNotify('remind')}
  if(k==='prevStart'){previewNotify('start')}
  if(k==='icsDay')copy(icsFor(dayTasks(sel)),'.ics for '+relDay(sel).toLowerCase());
  if(k==='icsAll')copy(icsFor(state.tasks),'.ics for all tasks');
  if(k==='expJson')copy(exportJSON(),'Backup JSON');
  if(k==='impJson'){try{const n=importJSON(s.querySelector('#impBox').value);render();toast(n+' tasks merged');closeScrim()}catch(e){toast('That is not valid JSON')}}
  if(k==='recHotkey'||k==='recQuick'){recordingHotkey=k==='recHotkey'?'voice.hotkey':'quick.hotkey';b.classList.add('rec');b.textContent='press keys…'}
  if(k==='rtNew'){newRoutine();renderSheet();const ta=[...document.querySelectorAll('.rt-name')].pop();if(ta){ta.focus();ta.select()}}
  if(k==='rtReset'){resetRoutines();renderSheet();render();toast('Starter routines restored')}
  if(k==='revealData'){window.SundialDesktop?.reveal().catch(e=>toast(String(e)))}
  if(k==='syncConnect'){const url=($('#syncUrl')?.value||'').trim(),tok=$('#syncToken')?.value||'';if(!url||!tok){toast('Server URL and token, please');return}b.textContent='…';Sync.connectSelf(url,tok).then(()=>{renderSheet();toast('Connected. Now set the passphrase.')}).catch(e=>{b.textContent='Connect';toast('Could not connect: '+(e.message||e))})}
  if(k==='syncCode'){const url=($('#syncUrl')?.value||'').trim(),em=($('#syncEmail')?.value||'').trim();if(!url||!em){toast('Server and email, please');return}syncSetup.url=url;syncSetup.email=em;b.textContent='…';Sync.requestCode(url,em).then(()=>{syncSetup.codeSent=true;renderSheet();toast('Code sent. Check your mail.')}).catch(e=>{b.textContent='Send code';toast('Could not send: '+(e.message||e))})}
  if(k==='syncVerify'){const code=$('#syncCodeIn')?.value||'';Sync.verifyCode(syncSetup.email,code).then(()=>{syncSetup.codeSent=false;renderSheet();toast('Signed in. Now set the passphrase.')}).catch(e=>toast(e.message||String(e)))}
  if(k==='syncPass'){const p=$('#syncPass')?.value||'';b.textContent='…';Sync.setPassphrase(p).then(created=>{renderSheet();toast(created?'Passphrase set. Syncing.':'Unlocked. Syncing.')}).catch(e=>{b.textContent='Unlock';toast(e.message||String(e))})}
  if(k==='syncNow'){b.textContent='…';Sync.syncNow().finally(()=>renderSheet())}
  if(k==='syncOut'){Sync.signOut().then(()=>{renderSheet();toast('Signed out of sync. Local data kept.')})}
  if(k==='obDone'){const pick=document.querySelector('.ob-card[aria-pressed="true"]')?.dataset.style||'quick';finishOnboarding(pick)}
  if(k==='obCustom'){S().onboarded=true;save();closeScrim();setTimeout(()=>{sheetTab='general';settings();setTimeout(()=>{const kb=document.querySelector('[data-run="recQuick"]');if(kb)kb.click()},250)},260)}
  if(k==='onboard'){closeScrim();setTimeout(onboarding,260)}
  if(k==='fitWindow'){closeScrim();setTimeout(fitToWindow,260)}
  if(k==='updateCheck'){b.textContent='Checking…';checkUpdates(true).finally(()=>{b.textContent='Check now'})}
  if(k==='updateInstall'){installUpdate(null)}
  if(k==='aiSaveKey'){const v=($('#aiKey')?.value||'').trim();if(!v){toast('Paste a key first');return}const D=window.SundialDesktop;
    if(D)D.secret.set('ai:'+S().ai.provider,v).then(()=>{aiKeySaved=true;renderSheet();toast('Key saved to Windows Credential Manager')}).catch(e=>toast('Could not save: '+e));
    else{S().ai.keyInBrowser=v;save();aiKeySaved=true;renderSheet();toast('Key saved in this browser')}}
  if(k==='aiRemoveKey'){const D=window.SundialDesktop;if(D)D.secret.del('ai:'+S().ai.provider).then(()=>{aiKeySaved=false;renderSheet();toast('Key removed')}).catch(e=>toast(String(e)));else{S().ai.keyInBrowser='';save();aiKeySaved=false;renderSheet();toast('Key removed')}}
  if(k==='aiTest'){b.textContent='…';AI.parse('lunch with Sam at the usual place next thursday, bring the contract',sel).then(r=>{b.textContent='Test';toast('AI understood: '+[r.title,r.date,r.time!=null?fmtTime(r.time):null,r.notes].filter(Boolean).join(' · ').slice(0,160))}).catch(e=>{b.textContent='Test';toast('AI: '+(e.message||e))})}
}
function copy(text,label){const done=()=>toast(label+' copied');(navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).then(done).catch(()=>{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');done()}catch(_){toast('Copy blocked here; select the text instead')}ta.remove()})}
document.addEventListener('contextmenu',e=>{const r=e.target.closest('[data-id]');if(!r||!get(r.dataset.id))return;e.preventDefault();menu(e.clientX,e.clientY,r.dataset.id)});
document.addEventListener('scroll',closeMenu,true);
document.addEventListener('mousedown',e=>{
  const b=e.target.closest('.nb .tools button');if(!b)return;e.preventDefault();
  if(b.dataset.cmd)document.execCommand(b.dataset.cmd,false,b.dataset.val||null);
  if(b.dataset.hl){document.execCommand('styleWithCSS',false,true);document.execCommand('hiliteColor',false,b.dataset.hl==='none'?'transparent':HL[b.dataset.hl])}
  const p=$('#page');if(p){state.notes[sel]=p.innerHTML;state.notesTs[sel]=Date.now();touch('note:'+sel);save()}
});
function chipsHtml(value){const p=parse(value,sel);return value.trim()?p.hits.map(h=>typeof h==='string'?`<span class="chip">${h}</span>`:`<span class="chip"><span class="swatch" style="--sw:var(--c-${h.sw})"></span>${esc(h.label)}</span>`).join('')+(p.hits.length?'':'<span class="chip ghost">try “3pm”, “45m”, “#work”, “tmrw”, “every mon”, “remind 1d”</span>'):''}
function previewParse(){const t=$('#qa'),box=$('#parse');if(!t||!box)return;const html=chipsHtml(t.value);if(box.innerHTML!==html)box.innerHTML=html}
// Quick add from anywhere: a floating bar over whatever view is showing. Adds to the selected day unless the line names another.
function openQuickAdd(){
  const open=$('.scrim.quick');if(open){closeScrim(open);return}
  if($('.scrim'))closeScrim();
  const s=scrim(`<input id="qq" placeholder="Add to ${relDay(sel).toLowerCase()}${sel!==todayStr()?' '+fromYmd(sel).getDate():''}… name a day to send it elsewhere" autocomplete="off"><div class="parse" id="qparse"></div>`,'search');s.classList.add('quick');
  const q=s.querySelector('#qq');q.focus();
  const prev=()=>{s.querySelector('#qparse').innerHTML=chipsHtml(q.value)};
  q.addEventListener('input',prev);q.addEventListener('keyup',prev);
  q.addEventListener('keydown',e=>{if(e.key!=='Enter')return;const raw=q.value;const n=addTask(raw,sel);if(!n)return;SFX.play('ui.add');anim.enter=n.id;render();toast('Added to '+dayLabel(n.date));q.value='';prev();aiRefine(n,raw)});
}
function routinesMenu(x,y){
  closeMenu();const el=document.createElement('div');el.className='menu';
  el.innerHTML=state.routines.map(r=>`<button data-rt-apply="${r.id}" data-to="${sel}">${esc(r.name)}<span class="k">${r.lines.filter(l=>l.trim()).length}</span></button>`).join('')+`<div class="sep"></div><button data-rt-manage="1">Edit routines…</button>`;
  document.body.appendChild(el);const r=el.getBoundingClientRect();el.style.left=Math.min(x,innerWidth-r.width-8)+'px';el.style.top=Math.min(y,innerHeight-r.height-8)+'px';
}
document.addEventListener('keyup',e=>{if(e.target.id==='qa')previewParse()});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.id==='qa'){previewParse();return}
  if(t.id==='page'){const html=t.innerHTML;if(html==='<br>'||(!t.textContent.trim()&&!html.includes('<mark')))delete state.notes[sel];else state.notes[sel]=html;state.notesTs[sel]=Date.now();touch('note:'+sel);save();return}
  if(t.dataset.color){state.labels[t.dataset.color]=t.value;state.labelsTs=Date.now();touch('labels');save();const tag=t.closest('.colorrow')?.querySelector('.mono');if(tag)tag.textContent='#'+t.value.toLowerCase().replace(/\s+/g,'');if(t.closest('.sheet')&&state.layout.cal)renderLegend();return}
  if(t.dataset.range){const v=+t.value;setPath(S(),t.dataset.range,v);save();if(t.dataset.range==='sounds.volume')SFX.setVolume(v);const l=$('#secsLbl');if(l&&t.dataset.range==='bannerSecs')l.textContent=v+'s';return}
  if(t.dataset.sel){applySetting(t.dataset.sel,t.value);return}
  if(t.dataset.ai){setPath(S(),'ai.'+t.dataset.ai,t.value.trim());save();return}
  if(t.dataset.rtName){const r=state.routines.find(x=>x.id===t.dataset.rtName);if(r){r.name=t.value;touchRoutines();save()}return}
  if(t.dataset.rtLines){const r=state.routines.find(x=>x.id===t.dataset.rtLines);if(r){r.lines=t.value.split('\n');touchRoutines();save()}return}
  if(t.id==='syncUrl')syncSetup.url=t.value;if(t.id==='syncEmail')syncSetup.email=t.value;
  if(!openId)return;const x=get(openId);if(!x)return;
  if(t.id==='edTitle'){upd(openId,{title:t.value},true);const row=document.querySelector(`.task[data-id="${openId}"] .t`);if(row)row.textContent=t.value}
  if(t.id==='edNotes')upd(openId,{notes:t.value},true);
  if(t.id==='edTime'){upd(openId,{time:t.value?(+t.value.slice(0,2))*60+(+t.value.slice(3,5)):null});if(state.layout.tl)renderSide()}
  if(t.id==='edDur'){upd(openId,{dur:parse(' '+t.value+' ','').dur});if(state.layout.tl)renderSide()}
  if(t.id==='edRepeat'){upd(openId,{repeat:t.value||null})}
  if(t.id==='edRemind'){upd(openId,{remind:t.value===''?null:+t.value})}
  if(t.id==='edDate'&&t.value){moveTo(openId,t.value);goDay(t.value);render()}
  const s=$('#saved');if(s){s.textContent='saved';s.style.color='var(--accent-ink)';setTimeout(()=>{s.style.color=''},400)}
});
document.addEventListener('keydown',e=>{
  const t=e.target;const typing=/INPUT|TEXTAREA|SELECT/.test(t.tagName)||t.isContentEditable;
  if(recordingHotkey){e.preventDefault();if(e.key==='Escape'){recordingHotkey=false;renderSheet();return}const c=comboOf(e);if(!c)return;
    // a bare letter would hijack typing; require a modifier or a function key
    if(!(e.ctrlKey||e.altKey||e.metaKey)&&!/^F\d{1,2}$/.test(e.key)&&!['Pause','ScrollLock'].includes(e.key)){toast('Use Ctrl, Alt or ⌘ with it, or a key on its own like F9, Pause or Scroll Lock');return}
    const other=recordingHotkey==='voice.hotkey'?S().quick.hotkey:S().voice.hotkey;if(c===other){toast('That one is taken by the other hotkey');return}
    setPath(S(),recordingHotkey,c);save();recordingHotkey=false;renderSheet();syncHotkeys();toast('Hotkey set: '+c);return}
  const combo=comboOf(e);
  if(!globalHotkeys){
    if(combo&&combo===S().quick.hotkey){e.preventDefault();openQuickAdd();return}
    if(combo&&S().voice.enabled&&combo===S().voice.hotkey){e.preventDefault();toggleVoice();return}}
  if(e.key==='Enter'&&t.id==='qa'){if(Voice.isActive()){Voice.stop();resetMicUi()}const raw=t.value;const n=addTask(raw,sel);if(n){t.value='';previewParse();SFX.play('ui.add');if(n.date!==sel)goDay(n.date);render();$('#qa').focus();aiRefine(n,raw)}return}
  if(e.key==='Enter'&&t.dataset.adddate){const n=addTask(t.value,t.dataset.adddate);if(n){SFX.play('ui.add');render();const i=document.querySelector(`[data-adddate="${n.date}"]`);if(i)i.focus()}return}
  if(e.key==='Escape'){if($('.menu')){closeMenu();return}if($('.scrim')){closeScrim();return}if(openId){closeDrawer();return}if(cursorId){cursorId=null;render();return}if(typing)t.blur();return}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();return}
  if((e.ctrlKey||e.metaKey)&&e.key===','){e.preventDefault();settings();return}
  if(typing){if(t.id==='page'&&(e.ctrlKey||e.metaKey)&&/^[1-6]$/.test(e.key)){e.preventDefault();document.execCommand('styleWithCSS',false,true);document.execCommand('hiliteColor',false,HL[COLORS[+e.key-1][0]])}
    if(t.id==='qa'&&e.key==='ArrowDown'&&!t.value){t.blur();moveCursor(1)}return}
  if($('.scrim'))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();const ok=e.shiftKey?redo():undo();if(ok){render();toast(e.shiftKey?'Redone':'Undone')}return}
  if(e.key==='/'){e.preventDefault();openSearch();return}
  if(e.key==='ArrowLeft'){goDay(addDays(sel,view==='month'?-30:view==='week'?-7:-1),'slide-r');render();return}
  if(e.key==='ArrowRight'){goDay(addDays(sel,view==='month'?30:view==='week'?7:1),'slide-l');render();return}
  if(e.key==='j'||e.key==='ArrowDown'){e.preventDefault();moveCursor(1);return}
  if(e.key==='k'||e.key==='ArrowUp'){e.preventDefault();moveCursor(-1);return}
  if(e.key===' '&&cursorId){e.preventDefault();toggleDone(cursorId);return}
  if(e.key==='Enter'&&cursorId){openId=openId===cursorId?null:cursorId;render();return}
  if((e.key==='Backspace'||e.key==='Delete')&&(openId||cursorId)){e.preventDefault();removeTask(openId||cursorId,true);return}
  if(e.key==='t'||e.key==='T'){goDay(todayStr());render()}
  if(e.key==='n'||e.key==='N'){e.preventDefault();if(!state.layout.board){openQuickAdd();return}view='day';render();const q=$('#qa');if(q)q.focus();else openQuickAdd()}
  if(e.key==='1')view='day',render();if(e.key==='2')view='week',render();if(e.key==='3')view='month',render();if(e.key==='4')view='notes',render();
  if(e.key==='[')togglePane('cal');if(e.key===']')togglePane('tl');if(e.key==='\\')togglePane('board');
});
function moveCursor(d){if(view!=='day'){view='day';render()}const ids=[...document.querySelectorAll('#list .task[data-id]')].map(x=>x.dataset.id);if(!ids.length)return;let i=ids.indexOf(cursorId);i=i<0?(d>0?0:ids.length-1):Math.max(0,Math.min(ids.length-1,i+d));cursorId=ids[i];document.querySelectorAll('#list .task').forEach(x=>x.classList.toggle('cursor',x.dataset.id===cursorId));document.querySelector(`.task[data-id="${cursorId}"]`)?.scrollIntoView({block:'nearest'})}

// drag: reorder within list, drop on a day to move, drop on a timeline hour to schedule
document.addEventListener('dragstart',e=>{const r=e.target.closest('[data-id]');if(!r||!get(r.dataset.id))return;dragId=r.dataset.id;r.classList.add('dragging');e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',dragId)}catch(_){}});
document.addEventListener('dragend',()=>{dragId=null;document.querySelectorAll('.dragging,.over,.drop-before').forEach(x=>x.classList.remove('dragging','over','drop-before'))});
document.addEventListener('dragover',e=>{if(!dragId)return;const day=e.target.closest('[data-date],[data-dropdate]');const row=e.target.closest('.task');const hr=e.target.closest('.hours');if(day||row||hr){e.preventDefault();e.dataTransfer.dropEffect='move'}
  document.querySelectorAll('.over,.drop-before').forEach(x=>x.classList.remove('over','drop-before'));
  if(row&&row.dataset.id!==dragId)row.classList.add('drop-before');else if(day)day.classList.add('over')});
document.addEventListener('drop',e=>{if(!dragId)return;e.preventDefault();const row=e.target.closest('.task');const day=e.target.closest('[data-date],[data-dropdate]');const hr=e.target.closest('.hours');
  if(row&&row.dataset.id!==dragId)reorder(dragId,row.dataset.id);
  else if(day)moveTo(dragId,day.dataset.date||day.dataset.dropdate);
  else if(hr){const y=e.clientY-hr.getBoundingClientRect().top;const mins=Math.round((y/S().hh*60)/15)*15;upd(dragId,{time:Math.max(0,Math.min(23*60+45,mins))});toast('Scheduled '+fmtTime(get(dragId).time))}
  dragId=null;render()});
// gutters: widths in side-by-side mode, heights in stacked mode
let gdrag=null;
// which section sits above a bar in stacked mode
function paneAbove(side){const L=state.layout;if(side==='l')return L.cal?'cal':null;if(side==='r')return L.board?'board':null;return L.tl?'tl':L.board?'board':L.cal?'cal':null}
document.querySelectorAll('.gutter').forEach(g=>{g.addEventListener('pointerdown',e=>{const L=state.layout;const mode=effectiveMode();let key=null,start=0;
    if(mode==='column'){key=paneAbove(g.dataset.side);if(!key)return;start=Math.round($(PANE[key]).getBoundingClientRect().height);L[HK[key]]=start;L.lock[key]=true}
    gdrag={side:g.dataset.side,mode,key,start,x:e.clientX,y:e.clientY,wl:L.wl,wr:L.wr};g.classList.add('on');try{g.setPointerCapture(e.pointerId)}catch(_){}document.body.style.cursor=mode==='column'?'row-resize':'col-resize';document.body.style.userSelect='none'});
  g.addEventListener('pointermove',e=>{if(!gdrag)return;const L=state.layout;
    if(gdrag.mode==='row'){const dx=e.clientX-gdrag.x;if(gdrag.side==='l')L.wl=Math.max(190,Math.min(innerWidth*0.45,gdrag.wl+dx));else L.wr=Math.max(240,Math.min(innerWidth*0.5,gdrag.wr-dx))}
    else if(gdrag.key){L[HK[gdrag.key]]=Math.max(90,gdrag.start+(e.clientY-gdrag.y))}
    applyLayout()});
  g.addEventListener('pointerup',()=>{if(!gdrag)return;gdrag=null;g.classList.remove('on');document.body.style.cursor='';document.body.style.userSelect='';save()});
  // double-click: side by side resets the width; stacked lets that section grow to its content again
  g.addEventListener('dblclick',()=>{const L=state.layout;if(effectiveMode()==='row'){if(g.dataset.side==='l')L.wl=240;else L.wr=320}else{const key=paneAbove(g.dataset.side);if(key)L.lock[key]=false}save();applyLayout()})});
// size all three sections to the window and lock them
function fitToWindow(){const L=state.layout;if(effectiveMode()!=='column')return;const cols=$('#cols');const vis=['cal','board','tl'].filter(k=>L[k]);let avail=cols.clientHeight-vis.length*10-2;
  if(L.cal){const natural=$('#calPane .calwrap').scrollHeight+46;L.hc=Math.max(90,vis.length===1?avail:Math.min(natural,Math.round(avail*0.42)));L.lock.cal=true;avail-=L.hc}
  const rest=vis.filter(k=>k!=='cal');
  if(rest.length===2){L.hb=Math.max(90,Math.round(avail*0.58));L.ht=Math.max(90,avail-L.hb);L.lock.board=true;L.lock.tl=true}else if(rest[0]==='board'){L.hb=Math.max(90,avail);L.lock.board=true}else if(rest[0]==='tl'){L.ht=Math.max(90,avail);L.lock.tl=true}
  save();applyLayout();toast('Fitted to the window')}
let rzTimer=null;addEventListener('resize',()=>{clearTimeout(rzTimer);rzTimer=setTimeout(applyLayout,120)});

// ---------- first-run setup: pick a hotkey style ----------
const HOTKEY_STYLES={quick:{quick:'Ctrl+Space',voice:'Ctrl+Shift+Space'},gaming:{quick:'Ctrl+Alt+/',voice:'Ctrl+Alt+.'}};
function hotkeyStyle(){const q=S().quick.hotkey,v=S().voice.hotkey;for(const k in HOTKEY_STYLES){if(HOTKEY_STYLES[k].quick===q&&HOTKEY_STYLES[k].voice===v)return k}return 'custom'}
function onboarding(){
  if($('.scrim'))closeScrim();
  const sel0=hotkeyStyle();
  const card=(k,title,sub,st)=>`<button class="ob-card" data-style="${k}" aria-pressed="${sel0===k}"><b>${title}</b><span class="combo">${esc(st.quick)}</span><small>${sub}<br>Voice: <span style="font-family:var(--f-mono)">${esc(st.voice)}</span></small></button>`;
  const s=scrim(`<div class="ob"><h2>Welcome to Sundial</h2><p>One choice to make: how you summon the quick-add bar from anywhere. You can change it any time in Settings.</p>
    <div class="ob-cards">${card('quick','Quick','Two keys. Best if you mostly type.',HOTKEY_STYLES.quick)}${card('gaming','Gaming','Three keys, out of the way of games.',HOTKEY_STYLES.gaming)}</div>
    <div class="ob-foot"><button class="btn" data-run="obCustom">Record my own…</button><span class="spacer"></span><button class="btn primary" data-run="obDone">Start</button></div></div>`,'sheet');
  s.classList.add('ob-host');
}
function finishOnboarding(style){const st=S();if(HOTKEY_STYLES[style]){st.quick.hotkey=HOTKEY_STYLES[style].quick;st.voice.hotkey=HOTKEY_STYLES[style].voice}st.onboarded=true;save();syncHotkeys();closeScrim();toast('Quick add: '+st.quick.hotkey)}

// ---------- sync settings ----------
const syncSetup={mode:'self',url:'',email:'',codeSent:false};
function syncRows(st,opt){const s=Sync.st();const D=window.SundialDesktop;let h=`<h3>Sync</h3>`;
  if(s.mode==='off'){
    h+=opt('Sync between devices','End-to-end encrypted: every task is sealed on this device before it leaves, and the server only ever stores ciphertext. Local data keeps working either way.',`<div class="seg">${[['self','My own server'],['hosted','Sundial Sync']].map(([v,l])=>`<button data-syncmode="${v}" aria-pressed="${syncSetup.mode===v}">${l}</button>`).join('')}</div>`);
    if(syncSetup.mode==='self')h+=opt('Your server','A Sundial Sync server you run (see server/README in the repo). The token is whatever you started it with.',`<input class="key" style="text-align:left;min-width:220px" id="syncUrl" placeholder="http://localhost:8768" value="${esc(syncSetup.url||s.server||'')}" spellcheck="false"><input class="key" style="text-align:left;min-width:150px" id="syncToken" type="password" placeholder="token" autocomplete="off"><button class="btn" data-run="syncConnect">Connect</button>`);
    else{h+=opt('Sundial Sync','Not live yet. When it is: your email, a six-digit code, done.',`<input class="key" style="text-align:left;min-width:200px" id="syncUrl" placeholder="https://sync.sundial.app" value="${esc(syncSetup.url||'')}" spellcheck="false"><input class="key" style="text-align:left;min-width:190px" id="syncEmail" type="email" placeholder="you@example.com" value="${esc(syncSetup.email||'')}"><button class="btn" data-run="syncCode">Send code</button>`);
      if(syncSetup.codeSent)h+=opt('Code from the email','',`<input class="key" style="min-width:110px" id="syncCodeIn" inputmode="numeric" placeholder="482913"><button class="btn" data-run="syncVerify">Sign in</button>`)}
    return h}
  h+=opt('Connected',`${s.mode==='hosted'?esc(s.email):'your server'} · <code>${esc(s.server)}</code> · this device <code>${esc(state.device)}</code>`,'<button class="btn" data-run="syncOut">Sign out</button>');
  if(!s.keyOk)h+=opt('Passphrase','Seals everything before it leaves this device. New account: choose one. Existing account: enter the one you already use. Lose it and the synced copy is unreadable; local data stays.',`<input class="key" style="text-align:left;min-width:220px" id="syncPass" type="password" placeholder="passphrase, 8+ characters" autocomplete="new-password"><button class="btn" data-run="syncPass">Unlock</button>`);
  else h+=opt('Status',`${s.lastError?'Last error: '+esc(s.lastError):(s.lastSync?'Last synced '+new Date(s.lastSync).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'Not synced yet')} · ${Sync.pending()} waiting${Sync.isRunning()?' · syncing…':''}${D?'':' · key kept in this browser'}`,`<button class="btn" data-run="syncNow">Sync now</button>`);
  return h}

// ---------- desktop + AI helpers ----------
let globalHotkeys=false,autostartOn=false,aiKeySaved=false,appVersion='',updateInfo=null;
// Updater: quiet unless something is actually ready. A failed check (offline, not configured yet) is silent unless the user asked.
async function checkUpdates(manual){const D=window.SundialDesktop;if(!D)return;if(!manual&&!S().updates.auto)return;
  try{const u=await D.updateCheck();if(u&&u.version){updateInfo=u;updateBanner(u);if($('.sheet-host'))renderSheet()}else if(manual)toast('You have the latest version')}
  catch(e){if(manual)toast('Update check failed: '+(e.message||e))}}
function updateBanner(u){const st=S();if(window.SundialDesktop&&st.toasts.enabled){window.SundialDesktop.toastShow({kind:'update',label:'Update ready',title:'Sundial '+u.version,meta:(u.notes||'').split('\n')[0].slice(0,80)||'Downloaded in the background. Restart whenever you like.',corner:st.toasts.corner,secs:45,sticky:false,actions:[{id:'later',label:'Later'},{id:'install',label:'Restart now',primary:true}]}).catch(()=>{});return}
  const host=bannerHost();if(host.querySelector('.banner.update'))return;const el=document.createElement('div');el.className='banner update start';
  el.innerHTML=`<div class="ic">↻</div><div class="tx"><span class="k">Update ready</span><b>Sundial ${esc(u.version)}</b><small>${esc((u.notes||'').split('\n')[0].slice(0,90))||'Downloaded in the background. Restart whenever you like.'}</small></div><div class="bt"><button data-b="later">Later</button><button class="ok" data-b="go">Restart now</button></div>`;
  el.querySelector('[data-b="later"]').onclick=()=>dismissBanner(el);el.querySelector('[data-b="go"]').onclick=()=>installUpdate(el);host.appendChild(el)}
async function installUpdate(el){const D=window.SundialDesktop;if(!D)return;const b=el?.querySelector('[data-b="go"]');if(b){b.textContent='Installing…';b.disabled=true}
  try{await D.flush();await D.updateInstall()}catch(e){toast('Update failed: '+(e.message||e));if(b){b.textContent='Restart now';b.disabled=false}}}
function syncHotkeys(){const D=window.SundialDesktop;if(!D)return;D.setHotkeys({quick:S().quick.hotkey,voice:S().voice.enabled?S().voice.hotkey:null}).then(failed=>{globalHotkeys=!(failed&&failed.length);if(failed&&failed.length)toast('Hotkey taken by another app: '+failed.join(', '))}).catch(()=>{globalHotkeys=false})}
function refreshAiKey(){const D=window.SundialDesktop;if(D)D.secret.get('ai:'+S().ai.provider).then(v=>{aiKeySaved=!!v;if(sheetTab==='ai')renderSheet()}).catch(()=>{});else aiKeySaved=!!S().ai.keyInBrowser}
function desktopGeneralRows(){return `<div class="opt"><div>Updates<small>Sundial ${esc(appVersion||'')}. Checks on launch and every six hours, downloads in the background, and asks before restarting.${updateInfo?' <b>'+esc(updateInfo.version)+' is ready.</b>':''}</small></div><div class="ctl"><button class="tog" role="switch" data-tog="updates.auto" aria-checked="${!!S().updates.auto}"></button>${updateInfo?'<button class="btn" data-run="updateInstall">Restart to update</button>':'<button class="btn" data-run="updateCheck">Check now</button>'}</div></div>`
  +`<div class="opt"><div>Start with Windows<small>Launches hidden in the tray at sign-in.</small></div><div class="ctl"><button class="tog" role="switch" data-autostart="1" aria-checked="${autostartOn}"></button></div></div>`
  +`<div class="opt"><div>Closing the window<small>Hides Sundial to the tray so reminders keep firing. Quit is in the tray icon menu.</small></div><div class="ctl"><span class="soon">TRAY</span></div></div>`
  +`<div class="opt"><div>Your data<small>One JSON file on this PC, plus a daily backup folder beside it.</small></div><div class="ctl"><button class="btn" data-run="revealData">Show folder</button></div></div>`}
function aiTab(st,opt,tog){const a=st.ai,D=window.SundialDesktop;
  let h=opt('AI parsing','Optional. The instant parse always runs first; then your own model reads the line and fills in what the rules missed: times in words, notes, the right color. Your key, your bill.',tog('ai.enabled'));
  if(!a.enabled)return h;
  h+=opt('Provider','',`<select data-sel="ai.provider">${[['anthropic','Anthropic (Claude)'],['openai','OpenAI'],['custom','OpenAI-compatible URL']].map(([v,l])=>`<option value="${v}" ${a.provider===v?'selected':''}>${l}</option>`).join('')}</select>`);
  h+=opt('Model',a.provider==='anthropic'?'claude-opus-5-5 by default; claude-haiku-5-5 is the fastest and cheapest.':'Type the model id your provider expects.',`<input class="key" style="min-width:210px;text-align:left" data-ai="model" value="${esc(a.model)}" placeholder="model id" spellcheck="false">`);
  if(a.provider==='custom')h+=opt('Base URL','Any server that speaks the OpenAI chat API (Ollama, LM Studio, OpenRouter…).',`<input class="key" style="min-width:230px;text-align:left" data-ai="baseUrl" value="${esc(a.baseUrl||'')}" placeholder="http://localhost:11434/v1" spellcheck="false">`);
  h+=opt('API key',D?'Kept in Windows Credential Manager, never in the data file.':'Kept in this browser only. Remove it before sharing this computer.',`<input class="key" style="min-width:200px;text-align:left" type="password" id="aiKey" placeholder="${aiKeySaved?'saved · paste to replace':'paste key'}" autocomplete="off"><button class="btn" data-run="aiSaveKey">Save</button>${aiKeySaved?'<button class="btn" data-run="aiRemoveKey">Remove</button>':''}`);
  h+=opt('Try it','Parses “lunch with Sam at the usual place next thursday, bring the contract”.','<button class="btn" data-run="aiTest">Test</button>');
  return h}
let aiBusy=0;
async function aiRefine(task,raw){
  if(!S().ai.enabled||!task||!raw||!raw.trim())return;
  const p0=parse(raw,'1970-01-05');const had={date:p0.date!=='1970-01-05',color:!!p0.color};
  aiBusy++;const box=$('#parse');if(box)box.insertAdjacentHTML('beforeend','<span class="chip ghost" id="aiChip">AI…</span>');
  try{const ai=await AI.parse(raw,task.date);const t=get(task.id);if(!t)return;const r=AI.refinePatch(t,ai,had);
    if(r){upd(t.id,r.patch);if(r.patch.date&&r.patch.date!==sel)goDay(r.patch.date);render();toast('AI: '+r.summary,()=>{undo();render()})}}
  catch(e){toast('AI parsing: '+(e.message||e))}
  finally{aiBusy--;$('#aiChip')?.remove()}
}

// ---------- scheduler ----------
let lastMinute=-1;
function tick(){
  const now=Date.now();
  for(const ev of dueEvents(now))notify(ev,false);
  const m=nowMin();if(m!==lastMinute){lastMinute=m;updateLogo();
    const nowEl=document.querySelector('.hours .now');if(nowEl&&sel===todayStr()){nowEl.style.top=(m/60*S().hh)+'px';nowEl.querySelector('i').textContent='☉ '+fmtTime(m)}
    if(view==='day'&&sel===todayStr()&&!openId&&!Voice.isActive()){const strip=$('.now-strip');const fresh=nowStrip();if((strip?strip.outerHTML:'')!==fresh)render()}}
}
async function init(){
  const D=window.SundialDesktop;
  if(D){try{const raw=await D.load();if(raw)hydrate(raw);else save()}catch(e){console.error('load failed',e)}
    D.on('sundial://quick-add',()=>openQuickAdd());D.on('sundial://voice',()=>{if(S().voice.enabled)toggleVoice()});D.on('sundial://toast-action',e=>{try{onToastAction(e.payload||{})}catch(err){console.error(err)}});syncHotkeys();
    D.appVersion().then(v=>{appVersion=v}).catch(()=>{});setTimeout(()=>checkUpdates(false),4000);setInterval(()=>checkUpdates(false),6*3600*1000)}
  applyTheme();applyDensity();applyLayout();SFX.setVolume(S().sounds.volume);render();updateLogo();
  Sync.on(()=>{if($('.sheet-host')&&sheetTab==='data')renderSheet()});Sync.start();
  if(!S().onboarded)setTimeout(onboarding,500);
  // first gesture: unlock audio and (browser only) ask once for OS notifications
  const unlock=()=>{SFX.unlock();try{if(!D&&'Notification'in window&&Notification.permission==='default')Notification.requestPermission().catch(()=>{})}catch(_){}};
  document.addEventListener('pointerdown',unlock,{once:true});document.addEventListener('keydown',unlock,{once:true});
  setInterval(tick,15000);setTimeout(tick,800);
}
init();
