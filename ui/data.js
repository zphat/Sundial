/* Sundial data layer: state, settings, dates, the one-line parser, mutations with undo + oplog,
   recurrence, reminder math, import/export. No DOM in this file. */
'use strict';
const COLORS=[['acid','Work'],['violet','Creative'],['tangerine','Errands'],['aqua','Health'],['cherry','Urgent'],['chalk','Admin']];
const HL={acid:'rgba(209,255,74,.45)',violet:'rgba(180,156,255,.42)',tangerine:'rgba(255,157,92,.45)',aqua:'rgba(94,230,208,.42)',cherry:'rgba(255,106,122,.4)',chalk:'rgba(201,195,178,.45)'};
const KEY='sundial.v3';
const SCHEMA=3;
const DEFAULT_SETTINGS={
  theme:'system', weekStart:1, h24:false, density:'comfortable',
  notifyDefault:true, defaultRemind:60,
  startStyle:'banner', remindStyle:'banner', bannerPos:'top', bannerSecs:30,
  sounds:{enabled:true, volume:.7, remind:'tick2', start:'chord', repeat:0, ui:true},
  voice:{enabled:true, hotkey:'Ctrl+Shift+Space', autoAdd:false},
  quick:{hotkey:'Ctrl+Space'},
  onboarded:false,
  routinesEnabled:false,
  ai:{enabled:false, provider:'anthropic', model:'claude-opus-5-5', baseUrl:'', keyInBrowser:''},
  updates:{auto:true},
  toasts:{enabled:true, corner:'bottom-left'},
  hh:44,
};
// Starter routines, written in the same one-line syntax as the quick-add. Users edit these; new users never see them unless they turn routines on.
const ROUTINE_TEMPLATE=[
  {name:'Morning',lines:['Coffee and plan the day 8am 15m #admin','Move: walk or gym 8:30am 45m #health','Inbox to zero 9:30am 30m #work']},
  {name:'Deep work',lines:['Deep work block 10am 2h #work silent','Lunch away from the desk 12:30pm 45m #health','Second block 2pm 90m #work']},
  {name:'Evening',lines:['Tidy the desk 6pm 10m #admin','Plan tomorrow 9pm 10m #admin','Screens off 10pm #health silent']},
];
let state={tasks:[],labels:Object.fromEntries(COLORS),notes:{},notesTs:{},labelsTs:0,routinesTs:0,tombstones:{},fired:{},oplog:[],routines:[],device:null,schema:SCHEMA,
  layout:{cal:true,board:true,tl:true,wl:240,wr:320,hc:300,hb:0,ht:320,mode:'auto',lock:{cal:false,board:true,tl:true}},settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),carryDismissed:null};
const uid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const save=()=>{const j=JSON.stringify(state);try{localStorage.setItem(KEY,j)}catch(e){}if(window.SundialDesktop)window.SundialDesktop.save(j)};
const deepMerge=(a,b)=>{for(const k in b){if(b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])){a[k]=deepMerge(a[k]&&typeof a[k]==='object'?a[k]:{},b[k])}else a[k]=b[k]}return a};
function bootState(rawJson){
  const COLOR_MAP={coral:'cherry',mango:'tangerine',lime:'acid',pool:'aqua',lilac:'violet',sand:'chalk',peach:'tangerine',seafoam:'aqua',fog:'chalk'};
  let raw=null,ver=3;
  if(rawJson){try{raw=JSON.parse(rawJson)}catch(e){}}
  if(!raw&&!rawJson){try{raw=JSON.parse(localStorage.getItem(KEY))}catch(e){}}
  if(!raw&&!rawJson){for(const [k,v] of [['sundial.v2',2],['sundial.v1',1]]){try{const s=JSON.parse(localStorage.getItem(k));if(s&&Array.isArray(s.tasks)){raw=s;ver=v;break}}catch(e){}}}
  if(raw&&Array.isArray(raw.tasks)){
    const s=deepMerge(JSON.parse(JSON.stringify(state)),raw);
    s.settings=deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),raw.settings||{});
    if(raw.theme&&!raw.settings)s.settings.theme=raw.theme;
    if(raw.hh&&!raw.settings)s.settings.hh=raw.hh;
    // sound sets were renamed in v3.2
    s.settings.sounds.remind=({ticks:'tick2',glass:'glass2',single:'glass1'})[s.settings.sounds.remind]||s.settings.sounds.remind;
    s.settings.sounds.start=({marimba:'chord',marimba3:'chord'})[s.settings.sounds.start]||s.settings.sounds.start;
    if(!Array.isArray(s.routines))s.routines=[];
    s.tasks=s.tasks.map(t=>{const n={...t};n.color=COLOR_MAP[n.color]||n.color;if(!COLORS.some(c=>c[0]===n.color))n.color='acid';
      if(ver<3){n.notify=!!t.alert;delete n.alert;if(n.remind===undefined)n.remind=null;if(n.repeat===undefined)n.repeat=null}return n});
    if(ver<3){const L={};for(const k in s.labels){L[COLOR_MAP[k]||k]=s.labels[k]}s.labels={...Object.fromEntries(COLORS),...L}}
    s.schema=SCHEMA;state=s;
  }
  if(!state.device)state.device='d_'+uid().slice(0,8);
  if(!raw){
    const t=todayStr();
    const ex=(title,date,extra)=>({id:uid(),title,date,time:null,dur:null,color:'acid',order:0,notes:'',done:false,notify:true,remind:null,repeat:null,createdAt:Date.now(),updatedAt:Date.now(),example:true,...extra});
    state.tasks=[
      ex('Script read-through',t,{time:9*60+30,dur:60,color:'violet',order:1}),
      ex('Call the bank about the card',t,{time:13*60,dur:15,color:'cherry',order:2}),
      ex('Gym',t,{time:18*60,dur:60,color:'aqua',order:3,repeat:'weekdays'}),
      ex('Reply to Sam',t,{color:'acid',order:4,notes:'Example. The note field is where the longer stuff goes: links, the address, what you actually need to say.'}),
      ex('Buy printer paper',t,{color:'tangerine',order:5,done:true}),
      ex('Dentist',addDays(t,1),{time:10*60+15,dur:45,color:'aqua',order:1,remind:1440}),
      ex('Edit episode 12',addDays(t,1),{time:14*60,dur:180,color:'violet',order:2}),
      ex('Rent',addDays(t,3),{color:'chalk',order:1,repeat:'monthly'}),
      ex('Dinner w/ Jess',addDays(t,4),{time:19*60,dur:120,color:'tangerine',order:1}),
      ex('Water the plants',addDays(t,-1),{color:'aqua',order:1}),
    ];
    state.notes[t]='<h2>Example day note</h2><p>This page is per day. Select text and hit a highlighter, or <b>B</b> / <i>I</i> / list.</p><ul><li>Call back about the <mark style="background:'+HL.acid+'">invoice</mark></li><li>Idea for ep. 13: <mark style="background:'+HL.violet+'">the subscription trap</mark></li></ul>';
  }
  save();
}
bootState(null);
// desktop: replace the in-memory state with the data file's contents (before the first render)
function hydrate(rawJson){state={tasks:[],labels:Object.fromEntries(COLORS),notes:{},notesTs:{},labelsTs:0,routinesTs:0,tombstones:{},fired:{},oplog:[],routines:[],device:null,schema:SCHEMA,layout:{cal:true,board:true,tl:true,wl:240,wr:320,hc:300,hb:0,ht:320,mode:'auto',lock:{cal:false,board:true,tl:true}},settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),carryDismissed:null};bootState(rawJson)}
const S=()=>state.settings;

// ---------- dates ----------
function pad(n){return String(n).padStart(2,'0')}
function ymd(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function fromYmd(s){const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)}
function addDays(s,n){const d=fromYmd(s);d.setDate(d.getDate()+n);return ymd(d)}
function todayStr(){return ymd(new Date())}
const MON=['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW_SUN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dowLabels=()=>{const w=S().weekStart;return [...DOW_SUN.slice(w),...DOW_SUN.slice(0,w)]};
const dowName=s=>DOW_SUN[fromYmd(s).getDay()];
const weekStart=s=>{const d=fromYmd(s);const k=(d.getDay()-S().weekStart+7)%7;d.setDate(d.getDate()-k);return ymd(d)};
const nowMin=()=>{const n=new Date();return n.getHours()*60+n.getMinutes()};
function fmtTime(m){if(m==null)return'';let h=Math.floor(m/60),mm=m%60;if(S().h24)return pad(h)+':'+pad(mm);const ap=h>=12?'pm':'am';h=h%12||12;return h+(mm?':'+pad(mm):'')+ap}
const fmtDur=m=>!m?'':m%60===0?(m/60)+'h':m>60?Math.floor(m/60)+'h'+(m%60)+'m':m+'m';
const fmtLead=m=>m==null||m<0?'none':m===0?'at start':m%1440===0?(m/1440)+'d before':m%60===0?(m/60)+'h before':m+'m before';
const relDay=s=>{const t=todayStr();return s===t?'Today':s===addDays(t,1)?'Tomorrow':s===addDays(t,-1)?'Yesterday':dowName(s)};
const epoch=(date,min)=>{const d=fromYmd(date);d.setMinutes(min||0);return d.getTime()};

// ---------- parser ----------
// "dentist 10:15am 45m #health tmrw every week remind 1h !"  -> fields + preview chips
function parse(raw,baseDate){
  let s=' '+raw+' ';const out={title:'',time:null,dur:null,color:null,date:baseDate,notify:null,repeat:null,remind:null,hits:[]};
  const take=(re,fn)=>{const m=s.match(re);if(m){fn(m);s=s.replace(re,' ')}};
  const MONRE='(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  take(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)\s/i,m=>{let h=+m[1]%12;if(/^p/i.test(m[3]))h+=12;out.time=h*60+(+(m[2]||0));out.hits.push('⏰ '+fmtTime(out.time))});
  if(out.time==null)take(/\s(\d{1,2}):(\d{2})\s/,m=>{out.time=(+m[1])*60+(+m[2]);out.hits.push('⏰ '+fmtTime(out.time))});
  if(out.time==null)take(/\sat\s(\d{1,2})\s/i,m=>{let h=+m[1];if(h<7)h+=12;out.time=h*60;out.hits.push('⏰ '+fmtTime(out.time))});
  take(/\sfor\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(m|min)?\s/i,m=>{out.dur=Math.round(+m[1]*60)+(+(m[3]||0));out.hits.push('⧗ '+fmtDur(out.dur))});
  if(out.dur==null)take(/\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(m|min)?\s/i,m=>{out.dur=Math.round(+m[1]*60)+(+(m[3]||0));out.hits.push('⧗ '+fmtDur(out.dur))});
  if(out.dur==null)take(/\s(?:for\s)?(\d{1,3})\s*(m|min|mins|minutes?)\s/i,m=>{out.dur=+m[1];out.hits.push('⧗ '+fmtDur(out.dur))});
  if(out.dur==null)take(/\s(?:for\s)?(half an hour|an hour|one hour|two hours)\s/i,m=>{out.dur={'half an hour':30,'an hour':60,'one hour':60,'two hours':120}[m[1].toLowerCase()];out.hits.push('⧗ '+fmtDur(out.dur))});
  take(/\s(?:remind|r)\s*(\d+)\s*(m|min|h|hr|d|day)s?\s*(?:before|ahead|early)?\s/i,m=>{const n=+m[1];const u=m[2][0].toLowerCase();out.remind=u==='h'?n*60:u==='d'?n*1440:n;out.hits.push('🔔 '+fmtLead(out.remind))});
  take(/\s#(\w+)\s/i,m=>{const w=m[1].toLowerCase();const c=COLORS.find(([k,l])=>k===w||(state.labels[k]||l).toLowerCase()===w);if(c){out.color=c[0];out.hits.push({sw:c[0],label:state.labels[c[0]]})}else s+=m[0]});
  take(/\s(every\s*day|daily)\s/i,()=>{out.repeat='daily';out.hits.push('↻ daily')});
  take(/\s(every\s*weekday|weekdays)\s/i,()=>{out.repeat='weekdays';out.hits.push('↻ weekdays')});
  take(/\s(every\s*week|weekly)\s/i,()=>{out.repeat='weekly';out.hits.push('↻ weekly')});
  take(/\s(every\s*month|monthly)\s/i,()=>{out.repeat='monthly';out.hits.push('↻ monthly')});
  take(/\s(today|tod|tonight)\s/i,m=>{out.date=todayStr();if(/tonight/i.test(m[1])&&out.time==null){out.time=19*60;out.hits.push('⏰ '+fmtTime(out.time))}out.hits.push('📅 today')});
  take(/\s(tomorrow|tmr|tmrw|tmw)\s/i,()=>{out.date=addDays(todayStr(),1);out.hits.push('📅 tomorrow')});
  take(/\snext\s*week\s/i,()=>{out.date=addDays(baseDate,7);out.hits.push('📅 '+dowName(out.date)+' '+fromYmd(out.date).getDate())});
  take(/\sin\s(\d{1,2})\s*(d|days?)\s/i,m=>{out.date=addDays(todayStr(),+m[1]);out.hits.push('📅 '+dowName(out.date)+' '+fromYmd(out.date).getDate())});
  take(new RegExp('\\s'+MONRE+'\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s','i'),m=>{const mi=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase());const n=new Date();let d=new Date(n.getFullYear(),mi,+m[2]);if(ymd(d)<todayStr())d.setFullYear(d.getFullYear()+1);out.date=ymd(d);out.hits.push('📅 '+MON[mi].slice(0,3)+' '+(+m[2]))});
  take(/\s(\d{1,2})\/(\d{1,2})\s/,m=>{const n=new Date();let d=new Date(n.getFullYear(),+m[1]-1,+m[2]);if(ymd(d)<todayStr())d.setFullYear(d.getFullYear()+1);out.date=ymd(d);out.hits.push('📅 '+MON[d.getMonth()].slice(0,3)+' '+d.getDate())});
  take(/\s(?:(every|next|on|this)\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\s/i,m=>{const i=DOW_SUN.findIndex(d=>d.toLowerCase()===m[2].toLowerCase().slice(0,3));let d=baseDate;for(let k=1;k<=7;k++){d=addDays(baseDate,k);if(fromYmd(d).getDay()===i)break}out.date=d;if(/^every$/i.test(m[1]||'')){out.repeat='weekly';out.hits.push('↻ every '+DOW_SUN[i])}else out.hits.push('📅 '+DOW_SUN[i]+' '+fromYmd(d).getDate())});
  take(/\s(silent|mute|muted|quiet|no\s*alert)\s/i,()=>{out.notify=false;out.hits.push('🔕 silent')});
  take(/\s!+\s/,()=>{out.notify=true;out.hits.push('🔔 notify')});
  out.title=s.replace(/\s+/g,' ').trim();
  return out;
}
function guessColor(title){
  const w=title.toLowerCase().split(/\W+/).filter(x=>x.length>3);
  const recent=[...state.tasks].sort((a,b)=>b.updatedAt-a.updatedAt);
  for(const t of recent){const tw=t.title.toLowerCase();if(w.some(x=>tw.includes(x)))return t.color}
  return 'acid';
}

// ---------- undo + oplog ----------
const history=[],future=[];
function pushUndo(){history.push(JSON.stringify(state.tasks));if(history.length>80)history.shift();future.length=0}
// Undo/redo swap the whole task list; tombstones for anything brought back are lifted, and the log notes the rewind so a sync layer re-diffs.
function swapTasks(nextJson,kind){const before=state.tasks,after=JSON.parse(nextJson),now=Date.now();const bm=new Map(before.map(t=>[t.id,t])),am=new Map(after.map(t=>[t.id,t]));
  for(const id of bm.keys()){if(!am.has(id)){state.tombstones[id]=now;touch('task:'+id)}}
  for(const [id,t] of am){const b=bm.get(id);if(!b||JSON.stringify(b)!==JSON.stringify(t)){t.updatedAt=now;touch('task:'+id)}delete state.tombstones[id]}
  state.tasks=after;op(kind,null,{tasks:after.length})}
function undo(){if(!history.length)return false;future.push(JSON.stringify(state.tasks));swapTasks(history.pop(),'undo');save();return true}
function redo(){if(!future.length)return false;history.push(JSON.stringify(state.tasks));swapTasks(future.pop(),'redo');save();return true}
// Append-only change log, one entry per mutation. This is what a sync layer ships between devices.
function op(kind,ref,patch){state.oplog.push({id:uid(),ts:Date.now(),dev:state.device,kind,ref,patch:patch||null});if(state.oplog.length>3000)state.oplog.splice(0,state.oplog.length-3000);
  if(kind==='add'||kind==='upd'||kind==='del')touch('task:'+ref);else if(kind==='reorder'&&Array.isArray(patch))patch.forEach(id=>touch('task:'+id))}
function touch(docId){if(typeof Sync!=='undefined')Sync.markDirty(docId)}
function touchRoutines(){state.routinesTs=Date.now();touch('routines')}

// ---------- mutations ----------
const get=id=>state.tasks.find(t=>t.id===id);
const dayTasks=d=>state.tasks.filter(t=>t.date===d).sort((a,b)=>(a.done-b.done)||((a.time??1e9)-(b.time??1e9))||(a.order-b.order));
const nextOrder=date=>{const same=state.tasks.filter(x=>x.date===date);return same.length?Math.max(...same.map(x=>x.order))+1:1};
function addTask(raw,date,extra,skipUndo){
  const p=parse(raw,date);if(!p.title)return null;if(!skipUndo)pushUndo();
  const t={id:uid(),title:p.title,date:p.date,time:p.time,dur:p.dur,color:p.color||guessColor(p.title),order:nextOrder(p.date),notes:'',done:false,
    notify:p.notify==null?S().notifyDefault:p.notify,remind:p.remind,repeat:p.repeat,createdAt:Date.now(),updatedAt:Date.now(),...(extra||{})};
  state.tasks.push(t);op('add',t.id,{...t});save();return t;
}
function upd(id,patch,silent){const t=get(id);if(!t)return;if(!silent)pushUndo();Object.assign(t,patch,{updatedAt:Date.now()});op('upd',id,patch);save()}
function deleteTask(id){const t=get(id);if(!t)return null;pushUndo();state.tasks=state.tasks.filter(x=>x.id!==id);state.tombstones[id]=Date.now();op('del',id);save();return {...t}}
function restoreTask(copy){pushUndo();delete state.tombstones[copy.id];state.tasks.push(copy);op('add',copy.id,{...copy});save()}
function moveTo(id,date){const t=get(id);if(!t||t.date===date)return;upd(id,{date,order:nextOrder(date)})}
function reorder(id,beforeId){const t=get(id);if(!t)return;pushUndo();const list=dayTasks(t.date).filter(x=>x.id!==id);const i=beforeId?list.findIndex(x=>x.id===beforeId):list.length;list.splice(i<0?list.length:i,0,t);list.forEach((x,k)=>{x.order=k+1;x.updatedAt=Date.now()});op('reorder',t.date,list.map(x=>x.id));save()}
function duplicate(id){const t=get(id);if(!t)return null;pushUndo();const c={...t,id:uid(),done:false,createdAt:Date.now(),updatedAt:Date.now(),order:t.order+0.5,spawned:false};state.tasks.push(c);op('add',c.id,{...c});save();return c}
function nextDate(date,repeat){
  if(repeat==='daily')return addDays(date,1);
  if(repeat==='weekly')return addDays(date,7);
  if(repeat==='weekdays'){let d=addDays(date,1);while([0,6].includes(fromYmd(d).getDay()))d=addDays(d,1);return d}
  if(repeat==='monthly'){const d=fromYmd(date);const day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+1);const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(day,last));return ymd(d)}
  return null;
}
// Completing a repeating task plants the next one. Un-completing leaves the next one alone (it's a real task now).
function completeTask(id,done){
  const t=get(id);if(!t)return null;pushUndo();
  Object.assign(t,{done,updatedAt:Date.now()});op('upd',id,{done});
  let spawned=null;
  if(done&&t.repeat&&!t.spawned){const nd=nextDate(t.date,t.repeat);spawned={...t,id:uid(),date:nd,done:false,spawned:false,order:nextOrder(nd),createdAt:Date.now(),updatedAt:Date.now(),seriesId:t.seriesId||t.id};t.spawned=true;state.tasks.push(spawned);op('add',spawned.id,{...spawned})}
  save();return spawned;
}
function clearDone(date){pushUndo();const gone=state.tasks.filter(x=>x.date===date&&x.done).map(x=>({...x}));state.tasks=state.tasks.filter(x=>!(x.date===date&&x.done));gone.forEach(x=>{state.tombstones[x.id]=Date.now();op('del',x.id)});save();return gone}
function undoneBefore(date){return state.tasks.filter(t=>!t.done&&t.date<date).sort((a,b)=>a.date.localeCompare(b.date))}
function carryAll(toDate){pushUndo();const ts=undoneBefore(toDate);ts.forEach(t=>{Object.assign(t,{date:toDate,order:nextOrder(toDate),updatedAt:Date.now()});op('upd',t.id,{date:toDate})});save();return ts.length}

// ---------- routines ----------
function ensureRoutines(){if(!state.routines.length){state.routines=ROUTINE_TEMPLATE.map(r=>({id:uid(),name:r.name,lines:[...r.lines]}));touchRoutines()}save()}
function resetRoutines(){state.routines=ROUTINE_TEMPLATE.map(r=>({id:uid(),name:r.name,lines:[...r.lines]}));touchRoutines();save()}
function newRoutine(){const r={id:uid(),name:'New routine',lines:[]};state.routines.push(r);touchRoutines();save();return r}
function deleteRoutine(id){state.routines=state.routines.filter(r=>r.id!==id);touchRoutines();save()}
// one undo step for the whole routine; lines that name a day go to that day, the rest to `date`
function applyRoutine(id,date){const r=state.routines.find(x=>x.id===id);if(!r)return 0;pushUndo();let n=0;for(const line of r.lines){if(line.trim()&&addTask(line,date,null,true))n++}return n}

// ---------- reminders ----------
const remindLead=t=>{const r=t.remind==null?S().defaultRemind:t.remind;return r>0?r:null};
// Events due now: reminders (lead minutes before start) and start alerts. 2-minute catch window so a sleeping laptop still fires.
// Keys carry the start time, so a rescheduled task fires again at its new time. Popup style and sound are decided by the UI, not here.
function dueEvents(nowMs){
  const out=[];
  for(const t of state.tasks){
    if(!t.notify||t.done||t.time==null)continue;
    const startMs=epoch(t.date,t.time);
    if(t.snoozeUntil&&nowMs>=t.snoozeUntil&&nowMs<t.snoozeUntil+120000&&!state.fired[t.id+':z'+t.snoozeUntil]){out.push({task:t,kind:'start',key:t.id+':z'+t.snoozeUntil});continue}
    const lead=remindLead(t);
    if(lead){const r=startMs-lead*60000;const k=t.id+':r:'+startMs;if(nowMs>=r&&nowMs<r+120000&&!state.fired[k])out.push({task:t,kind:'remind',key:k,lead})}
    const ks=t.id+':s:'+startMs;if(nowMs>=startMs&&nowMs<startMs+120000&&!state.fired[ks])out.push({task:t,kind:'start',key:ks});
  }
  return out;
}
function markFired(key){state.fired[key]=Date.now();const cutoff=Date.now()-7*86400000;for(const k in state.fired)if(state.fired[k]<cutoff)delete state.fired[k];save()}

// ---------- export / import ----------
function icsFor(tasks){
  const dt=(d,m)=>d.replace(/-/g,'')+'T'+pad(Math.floor(m/60))+pad(m%60)+'00';
  const esc=s=>String(s).replace(/\\/g,'\\\\').replace(/[,;]/g,'\\$&').replace(/\n/g,'\\n');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Sundial//EN','CALSCALE:GREGORIAN'];
  for(const t of tasks){lines.push('BEGIN:VEVENT','UID:'+t.id+'@sundial','SUMMARY:'+esc(t.title));
    if(t.time!=null){lines.push('DTSTART:'+dt(t.date,t.time),'DTEND:'+dt(t.date,t.time+(t.dur||30)))}else lines.push('DTSTART;VALUE=DATE:'+t.date.replace(/-/g,''));
    if(t.repeat)lines.push('RRULE:'+({daily:'FREQ=DAILY',weekly:'FREQ=WEEKLY',monthly:'FREQ=MONTHLY',weekdays:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'})[t.repeat]);
    if(t.notes)lines.push('DESCRIPTION:'+esc(t.notes));
    const lead=remindLead(t);if(t.notify&&t.time!=null&&lead)lines.push('BEGIN:VALARM','TRIGGER:-PT'+lead+'M','ACTION:DISPLAY','DESCRIPTION:'+esc(t.title),'END:VALARM');
    lines.push('END:VEVENT')}
  lines.push('END:VCALENDAR');return lines.join('\r\n');
}
const exportJSON=()=>JSON.stringify({schema:SCHEMA,device:state.device,exportedAt:Date.now(),tasks:state.tasks,tombstones:state.tombstones,notes:state.notes,notesTs:state.notesTs,labels:state.labels,oplog:state.oplog},null,1);
// Merge: tasks by id, newest updatedAt wins; notes by date, longer wins; oplog union by id. Same rule a sync server will apply.
function importJSON(text){
  const j=JSON.parse(text);let n=0;pushUndo();
  const theirDead=j.tombstones||{};
  for(const t of j.tasks||[]){if((state.tombstones[t.id]||0)>(t.updatedAt||0))continue;const ex=get(t.id);if(!ex){state.tasks.push(t);n++}else if((t.updatedAt||0)>(ex.updatedAt||0)){Object.assign(ex,t);n++}}
  for(const id in theirDead){const ex=get(id);if(ex&&theirDead[id]>(ex.updatedAt||0)){state.tasks=state.tasks.filter(x=>x.id!==id);state.tombstones[id]=theirDead[id];n++}}
  for(const d in j.notes||{}){const mine=state.notesTs[d]||0,theirs=(j.notesTs||{})[d]||0;if(!state.notes[d]||theirs>mine||(theirs===mine&&(j.notes[d]||'').length>state.notes[d].length)){state.notes[d]=j.notes[d];state.notesTs[d]=theirs||mine}}
  Object.assign(state.labels,j.labels||{});
  const seen=new Set(state.oplog.map(o=>o.id));for(const o of j.oplog||[])if(!seen.has(o.id))state.oplog.push(o);state.oplog.sort((a,b)=>a.ts-b.ts);
  if(typeof Sync!=='undefined')Sync.markAllDirty();
  save();return n;
}
