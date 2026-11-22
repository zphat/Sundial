/* Sundial data layer: state, settings, dates, the one-line parser, mutations with undo + oplog,
   recurrence, reminder math, import/export. No DOM in this file. */
'use strict';
const COLORS=[['acid','Work'],['violet','Creative'],['tangerine','Errands'],['aqua','Health'],['cherry','Urgent'],['chalk','Admin']];
const HL={acid:'rgba(209,255,74,.45)',violet:'rgba(180,156,255,.42)',tangerine:'rgba(255,157,92,.45)',aqua:'rgba(94,230,208,.42)',cherry:'rgba(255,106,122,.4)',chalk:'rgba(201,195,178,.45)'};
const KEY='sundial.v3';
const SCHEMA=3;
// What a task id, a day key and a repeat word may look like. They go into markup and into date math, so data that
// comes from outside the running app (the saved file, an import, sync) is held to these.
const DATE_RE=/^\d{4}-\d\d-\d\d$/,ID_RE=/^[^\s"'<>&`]{1,120}$/,REPEATS=['daily','weekdays','weekly','monthly'];
const LOG_MAX=1000;
const DEFAULT_SETTINGS={
  theme:'system', weekStart:1, h24:false, density:'comfortable',
  notifyDefault:true, defaultRemind:60,
  startStyle:'banner', remindStyle:'banner', bannerPos:'top', bannerSecs:30,
  sounds:{enabled:true, volume:.7, remind:'tick2', start:'chord', repeat:0, ui:true},
  voice:{enabled:true, hotkey:'Ctrl+Shift+Space', autoAdd:false},
  quick:{hotkey:'Ctrl+Space'},
  onboarded:false,
  routinesEnabled:false,
  ai:{enabled:false, provider:'anthropic', model:'claude-opus-5-5', baseUrl:'', keysInBrowser:{}},
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
// A change is stamped later than the version it replaces, whatever this clock says: another device with a fast clock
// may have written that version, and the server keeps the higher stamp.
const stamp=prev=>Math.max(Date.now(),(prev||0)+1);
// One shape for every task from outside: a bad id or day drops it, anything else odd goes back to a default.
function cleanTask(t){
  if(!t||typeof t!=='object')return null;
  if(typeof t.id==='number')t.id=String(t.id);
  if(typeof t.id!=='string'||!ID_RE.test(t.id)||typeof t.date!=='string'||!DATE_RE.test(t.date)||ymd(fromYmd(t.date))!==t.date)return null;
  const num=(v,lo,hi)=>typeof v==='number'&&isFinite(v)&&v>=lo&&v<=hi;
  t.title=typeof t.title==='string'?t.title:String(t.title??'');t.notes=typeof t.notes==='string'?t.notes:'';
  if(!COLORS.some(c=>c[0]===t.color))t.color='acid';
  if(!REPEATS.includes(t.repeat))t.repeat=null;
  t.time=num(t.time,0,1439)?Math.round(t.time):null;t.dur=num(t.dur,1,10080)?Math.round(t.dur):null;
  t.remind=num(t.remind,-1,527040)?t.remind:null;
  if(!num(t.order,-1e9,1e9))t.order=0;
  t.done=!!t.done;t.notify=!!t.notify;
  if(!num(t.updatedAt,0,1e15))t.updatedAt=0;if(!num(t.createdAt,0,1e15))t.createdAt=t.updatedAt;
  if(t.snoozeUntil!=null&&!num(t.snoozeUntil,0,1e15))delete t.snoozeUntil;
  if(t.seriesId!=null&&(typeof t.seriesId!=='string'||!ID_RE.test(t.seriesId)))delete t.seriesId;
  if(t.anchorDay!=null&&!num(t.anchorDay,1,31))delete t.anchorDay;
  return t}
// The change log is only ever exported, so a long note is not copied into it in full.
function slimPatch(p){if(!p||typeof p!=='object'||Array.isArray(p))return p??null;const o={};for(const k in p){const v=p[k];o[k]=typeof v==='string'&&v.length>160?v.slice(0,160)+'…':v}return o}
function slimOp(o){if(o&&typeof o==='object')o.patch=slimPatch(o.patch)}
// In a browser localStorage is the only store, so a failed write (quota, blocked site data) is reported once through
// onSaveFailed, which ui.js defines. The desktop still writes through its own bridge regardless.
let saveFailed=false;
const save=()=>{const j=JSON.stringify(state);try{localStorage.setItem(KEY,j);saveFailed=false}catch(e){if(!window.SundialDesktop&&!saveFailed){saveFailed=true;if(typeof onSaveFailed==='function')onSaveFailed(e)}}if(window.SundialDesktop)window.SundialDesktop.save(j)};
const deepMerge=(a,b)=>{for(const k in b){if(b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])){a[k]=deepMerge(a[k]&&typeof a[k]==='object'?a[k]:{},b[k])}else a[k]=b[k]}return a};
// The seeded demo note, matched exactly by clearExamples so an edited note is never mistaken for it.
const EXAMPLE_NOTE='<h2>Example day note</h2><p>This page is per day. Select text and hit a highlighter, or <b>B</b> / <i>I</i> / list.</p><ul><li>Call back about the <mark style="background:'+HL.acid+'">invoice</mark></li><li>Idea for ep. 13: <mark style="background:'+HL.violet+'">the subscription trap</mark></li></ul>';
// Where the state in memory came from: 'file' (the desktop's data file), 'storage' (this app's own copy in localStorage)
// or 'seed' (nothing was found, the example tasks). The desktop start reads it to know whether it holds a copy of its own.
let bootSource='seed';
function bootState(rawJson){
  const COLOR_MAP={coral:'cherry',mango:'tangerine',lime:'acid',pool:'aqua',lilac:'violet',sand:'chalk',peach:'tangerine',seafoam:'aqua',fog:'chalk'};
  let raw=null,ver=3;
  if(rawJson){try{raw=JSON.parse(rawJson)}catch(e){}}
  if(!raw&&!rawJson){try{raw=JSON.parse(localStorage.getItem(KEY))}catch(e){}}
  if(!raw&&!rawJson){for(const [k,v] of [['sundial.v2',2],['sundial.v1',1]]){try{const s=JSON.parse(localStorage.getItem(k));if(s&&Array.isArray(s.tasks)){raw=s;ver=v;break}}catch(e){}}}
  bootSource=raw&&Array.isArray(raw.tasks)?(rawJson?'file':'storage'):'seed';
  if(raw&&Array.isArray(raw.tasks)){
    const s=deepMerge(JSON.parse(JSON.stringify(state)),raw);
    s.settings=deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),raw.settings||{});
    if(raw.theme&&!raw.settings)s.settings.theme=raw.theme;
    if(raw.hh&&!raw.settings)s.settings.hh=raw.hh;
    // sound sets were renamed in v3.2
    s.settings.sounds.remind=({ticks:'tick2',glass:'glass2',single:'glass1'})[s.settings.sounds.remind]||s.settings.sounds.remind;
    s.settings.sounds.start=({marimba:'chord',marimba3:'chord'})[s.settings.sounds.start]||s.settings.sounds.start;
    if(!Array.isArray(s.routines))s.routines=[];
    // the browser's AI key used to be one field for every provider; it belongs to the provider it was saved under
    {if(!s.settings.ai||typeof s.settings.ai!=='object')s.settings.ai=JSON.parse(JSON.stringify(DEFAULT_SETTINGS.ai));const a=s.settings.ai;if(!a.keysInBrowser||typeof a.keysInBrowser!=='object')a.keysInBrowser={};if(a.keyInBrowser){if(!a.keysInBrowser[a.provider])a.keysInBrowser[a.provider]=a.keyInBrowser}delete a.keyInBrowser}
    // the maps the rest of the app indexes into are always plain objects, whatever the saved copy held
    for(const k of ['notes','notesTs','tombstones','fired','labels']){if(!s[k]||typeof s[k]!=='object'||Array.isArray(s[k]))s[k]=k==='labels'?Object.fromEntries(COLORS):{}}
    for(const [k,l] of COLORS){if(typeof s.labels[k]!=='string')s.labels[k]=l}
    s.tasks=s.tasks.filter(t=>t&&typeof t==='object').map(t=>{const n={...t};n.color=COLOR_MAP[n.color]||n.color;
      if(ver<3){n.notify=!!t.alert;delete n.alert;if(n.remind===undefined)n.remind=null;if(n.repeat===undefined)n.repeat=null}return cleanTask(n)}).filter(Boolean);
    for(const d of Object.keys(s.notes||{})){if(!DATE_RE.test(d)||typeof s.notes[d]!=='string')delete s.notes[d]}
    s.oplog=(Array.isArray(s.oplog)?s.oplog:[]).filter(o=>o&&typeof o==='object').slice(-LOG_MAX);s.oplog.forEach(slimOp);
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
    state.notes[t]=EXAMPLE_NOTE;
  }
  save();
}
bootState(null);
// desktop: replace the in-memory state with the data file's contents (before the first render). Text that is not a
// Sundial state throws before anything is touched, so a damaged file can never be answered with a blank start.
// If reading it in fails part-way, the state that was in memory is put back, so nothing half-loaded is ever saved.
function hydrate(rawJson){let ok=false;try{const j=JSON.parse(rawJson);ok=!!j&&typeof j==='object'&&Array.isArray(j.tasks)}catch(e){}if(!ok)throw new Error('not a Sundial data file');
  const prev=state,prevSource=bootSource;try{hydrateInto(rawJson)}catch(e){state=prev;bootSource=prevSource;throw e}}
function hydrateInto(rawJson){
  state={tasks:[],labels:Object.fromEntries(COLORS),notes:{},notesTs:{},labelsTs:0,routinesTs:0,tombstones:{},fired:{},oplog:[],routines:[],device:null,schema:SCHEMA,layout:{cal:true,board:true,tl:true,wl:240,wr:320,hc:300,hb:0,ht:320,mode:'auto',lock:{cal:false,board:true,tl:true}},settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),carryDismissed:null};bootState(rawJson)}
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
// how a label is typed after a # in the add line: lower case, no spaces ("Deep Work" is #deepwork)
const tagOf=label=>String(label||'').toLowerCase().replace(/\s+/g,'');
function fmtTime(m){if(m==null)return'';let h=Math.floor(m/60),mm=m%60;if(S().h24)return pad(h)+':'+pad(mm);const ap=h>=12?'pm':'am';h=h%12||12;return h+(mm?':'+pad(mm):'')+ap}
const fmtDur=m=>!m?'':m%60===0?(m/60)+'h':m>60?Math.floor(m/60)+'h'+(m%60)+'m':m+'m';
const fmtLead=m=>m==null||m<0?'none':m===0?'at start':m%1440===0?(m/1440)+'d before':m%60===0?(m/60)+'h before':m+'m before';
const relDay=s=>{const t=todayStr();return s===t?'Today':s===addDays(t,1)?'Tomorrow':s===addDays(t,-1)?'Yesterday':dowName(s)};
const epoch=(date,min)=>{const d=fromYmd(date);d.setMinutes(min||0);return d.getTime()};

// ---------- parser ----------
// "dentist 10:15am 45m #health tmrw every week remind 1h !"  -> fields + preview chips
function parse(raw,baseDate){
  let s=' '+raw+' ';const out={title:'',time:null,dur:null,color:null,date:baseDate,notify:null,repeat:null,remind:null,hits:[]};
  // a rule that returns false leaves its words in the title (a clock or a date that cannot exist is not one)
  const take=(re,fn)=>{const m=s.match(re);if(m&&fn(m)!==false)s=s.replace(re,' ')};
  // whole month names only: "marketing 3" and "decide 2" are not dates
  const MONRE='(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  let explicit=false;
  take(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)\s/i,m=>{if(+m[1]<1||+m[1]>12||+(m[2]||0)>59)return false;let h=+m[1]%12;if(/^p/i.test(m[3]))h+=12;out.time=h*60+(+(m[2]||0));out.hits.push('⏰ '+fmtTime(out.time))});
  if(out.time==null)take(/\s(\d{1,2}):(\d{2})\s/,m=>{if(+m[1]>23||+m[2]>59)return false;out.time=(+m[1])*60+(+m[2]);out.hits.push('⏰ '+fmtTime(out.time))});
  if(out.time==null)take(/\sat\s(\d{1,2})\s/i,m=>{let h=+m[1];if(h>23)return false;if(h<7)h+=12;out.time=h*60;out.hits.push('⏰ '+fmtTime(out.time))});
  // the reminder goes first, or "remind 1h" would be read as a one-hour task
  take(/\s(?:remind|r)\s*(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*(?:before|ahead|early)?\s/i,m=>{const n=+m[1];const u=m[2][0].toLowerCase();out.remind=u==='h'?n*60:u==='d'?n*1440:n;out.hits.push('🔔 '+fmtLead(out.remind))});
  take(/\sfor\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(m|min)?\s/i,m=>{out.dur=Math.round(+m[1]*60)+(+(m[3]||0));out.hits.push('⧗ '+fmtDur(out.dur))});
  if(out.dur==null)take(/\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(m|min)?\s/i,m=>{out.dur=Math.round(+m[1]*60)+(+(m[3]||0));out.hits.push('⧗ '+fmtDur(out.dur))});
  if(out.dur==null)take(/\s(?:for\s)?(\d{1,3})\s*(m|min|mins|minutes?)\s/i,m=>{out.dur=+m[1];out.hits.push('⧗ '+fmtDur(out.dur))});
  if(out.dur==null)take(/\s(?:for\s)?(half an hour|an hour|one hour|two hours)\s/i,m=>{out.dur={'half an hour':30,'an hour':60,'one hour':60,'two hours':120}[m[1].toLowerCase()];out.hits.push('⧗ '+fmtDur(out.dur))});
  // the first #word that names a label (its name without spaces) is taken; any other #word stays where it was typed
  for(const m of s.matchAll(/\s#([^\s#]+)(?=\s)/g)){const w=m[1].toLowerCase();const c=COLORS.find(([k,l])=>k===w||tagOf(state.labels[k]||l)===w);if(c){out.color=c[0];out.hits.push({sw:c[0],label:state.labels[c[0]]});s=s.slice(0,m.index)+' '+s.slice(m.index+m[0].length);break}}
  take(/\s(every\s*day|daily)\s/i,()=>{out.repeat='daily';out.hits.push('↻ daily')});
  take(/\s(every\s*weekday|weekdays)\s/i,()=>{out.repeat='weekdays';out.hits.push('↻ weekdays')});
  take(/\s(every\s*week|weekly)\s/i,()=>{out.repeat='weekly';out.hits.push('↻ weekly')});
  take(/\s(every\s*month|monthly)\s/i,()=>{out.repeat='monthly';out.hits.push('↻ monthly')});
  take(/\s(today|tod|tonight)\s/i,m=>{out.date=todayStr();if(/tonight/i.test(m[1])&&out.time==null){out.time=19*60;out.hits.push('⏰ '+fmtTime(out.time))}out.hits.push('📅 today')});
  take(/\s(tomorrow|tmr|tmrw|tmw)\s/i,()=>{out.date=addDays(todayStr(),1);out.hits.push('📅 tomorrow')});
  take(/\snext\s*week\s/i,()=>{out.date=addDays(baseDate,7);out.hits.push('📅 '+dowName(out.date)+' '+fromYmd(out.date).getDate())});
  take(/\sin\s(\d{1,2})\s*(d|days?)\s/i,m=>{out.date=addDays(todayStr(),+m[1]);out.hits.push('📅 '+dowName(out.date)+' '+fromYmd(out.date).getDate())});
  take(new RegExp('\\s'+MONRE+'\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s','i'),m=>{const mi=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase().slice(0,3));if(+m[2]<1||+m[2]>31)return false;const n=new Date();let d=new Date(n.getFullYear(),mi,+m[2]);if(ymd(d)<todayStr())d.setFullYear(d.getFullYear()+1);out.date=ymd(d);explicit=true;out.hits.push('📅 '+MON[mi].slice(0,3)+' '+(+m[2]))});
  take(/\s(\d{1,2})\/(\d{1,2})\s/,m=>{if(+m[1]<1||+m[1]>12||+m[2]<1||+m[2]>31)return false;const n=new Date();let d=new Date(n.getFullYear(),+m[1]-1,+m[2]);if(ymd(d)<todayStr())d.setFullYear(d.getFullYear()+1);out.date=ymd(d);explicit=true;out.hits.push('📅 '+MON[d.getMonth()].slice(0,3)+' '+d.getDate())});
  // a weekday next to a written date ("nov 28 friday") does not move the date; "every friday" still sets the repeat
  take(/\s(?:(every|next|on|this)\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\s/i,m=>{const i=DOW_SUN.findIndex(d=>d.toLowerCase()===m[2].toLowerCase().slice(0,3));const every=/^every$/i.test(m[1]||'');
    if(!explicit){let d=baseDate;for(let k=1;k<=7;k++){d=addDays(baseDate,k);if(fromYmd(d).getDay()===i)break}out.date=d}
    if(every){out.repeat='weekly';out.hits.push('↻ every '+DOW_SUN[i])}else if(!explicit)out.hits.push('📅 '+DOW_SUN[i]+' '+fromYmd(out.date).getDate())});
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
// (Not named `history`: a top-level const of that name hides window.history from every script on the page.)
const undoStack=[],redoStack=[];
// Every snapshot has a sequence number, and so does every task that another device or another window changed
// (noteRemote, called by sync). Undo and redo leave those tasks as they are now, so stepping back never deletes or
// reverts what arrived from somewhere else in between.
let undoSeq=0;const remoteAt={};
function noteRemote(id){remoteAt[id]=++undoSeq}
function dropUndo(){undoStack.length=0;redoStack.length=0}
const snapshot=()=>({seq:++undoSeq,json:JSON.stringify(state.tasks)});
function pushUndo(){undoStack.push(snapshot());if(undoStack.length>80)undoStack.shift();redoStack.length=0}
// Undo/redo swap the whole task list; tombstones for anything brought back are lifted, and the log notes the rewind so a sync layer re-diffs.
function swapTasks(entry,kind){const before=state.tasks,bm=new Map(before.map(t=>[t.id,t]));const outside=id=>remoteAt[id]>entry.seq;
  const after=JSON.parse(entry.json).filter(t=>!outside(t.id)).concat(before.filter(t=>outside(t.id)));const am=new Map(after.map(t=>[t.id,t]));
  for(const [id,b] of bm){if(!am.has(id)){state.tombstones[id]=stamp(b.updatedAt);touch('task:'+id)}}
  for(const [id,t] of am){const b=bm.get(id);if(b===t)continue;if(b&&!b.example&&t.example)t.example=false;if(!b||JSON.stringify(b)!==JSON.stringify(t)){t.updatedAt=stamp(Math.max(b?b.updatedAt||0:0,t.updatedAt||0,state.tombstones[id]||0));touch('task:'+id)}delete state.tombstones[id]}
  state.tasks=after;op(kind,null,{tasks:after.length})}
function undo(){if(!undoStack.length)return false;redoStack.push(snapshot());swapTasks(undoStack.pop(),'undo');save();return true}
function redo(){if(!redoStack.length)return false;undoStack.push(snapshot());swapTasks(redoStack.pop(),'redo');save();return true}
// Change log, one entry per mutation, newest LOG_MAX kept. Nothing reads it but the export; sync works from dirty marks.
function op(kind,ref,patch,silent){const log=state.oplog,last=log[log.length-1],now=Date.now();
  // a field being typed in arrives as one silent edit per key: keep the newest, not a copy for every keystroke
  if(silent&&kind==='upd'&&patch&&last&&last.kind==='upd'&&last.ref===ref&&last.dev===state.device&&now-last.ts<60000&&last.patch&&Object.keys(last.patch).join()===Object.keys(patch).join()){last.patch=slimPatch(patch);last.ts=now}
  else log.push({id:uid(),ts:now,dev:state.device,kind,ref,patch:slimPatch(patch)});
  if(log.length>LOG_MAX)log.splice(0,log.length-LOG_MAX);
  if(kind==='add'||kind==='upd'||kind==='del')touch('task:'+ref);else if(kind==='reorder'&&Array.isArray(patch))patch.forEach(id=>touch('task:'+id))}
function touch(docId){if(typeof Sync!=='undefined')Sync.markDirty(docId)}
function touchRoutines(){state.routinesTs=stamp(state.routinesTs);touch('routines')}

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
function upd(id,patch,silent){const t=get(id);if(!t)return;if(!silent)pushUndo();Object.assign(t,patch,{updatedAt:stamp(t.updatedAt)});if(t.example&&Object.keys(patch||{}).some(k=>k!=='order'&&k!=='snoozeUntil'))t.example=false;
  if(patch&&'date' in patch)delete t.anchorDay;   // moved by hand: a monthly repeat counts from the new day
  op('upd',id,patch,silent);save()}
function deleteTask(id){const t=get(id);if(!t)return null;pushUndo();state.tasks=state.tasks.filter(x=>x.id!==id);state.tombstones[id]=stamp(t.updatedAt);op('del',id);save();return {...t}}
// Putting a deleted task back: stamped later than its tombstone, which other devices may already hold, or the deletion would win there.
function restoreTask(copy){if(!copy||get(copy.id))return;pushUndo();const dead=state.tombstones[copy.id]||0;delete state.tombstones[copy.id];copy.updatedAt=stamp(Math.max(dead,copy.updatedAt||0));state.tasks.push(copy);op('add',copy.id,{...copy});save()}
function moveTo(id,date){const t=get(id);if(!t||t.date===date)return;upd(id,{date,order:nextOrder(date)})}
function reorder(id,beforeId){const t=get(id);if(!t)return;pushUndo();const list=dayTasks(t.date).filter(x=>x.id!==id);const i=beforeId?list.findIndex(x=>x.id===beforeId):list.length;list.splice(i<0?list.length:i,0,t);list.forEach((x,k)=>{x.order=k+1;x.updatedAt=stamp(x.updatedAt)});op('reorder',t.date,list.map(x=>x.id));save()}
function duplicate(id){const t=get(id);if(!t)return null;pushUndo();const c={...t,id:uid(),done:false,createdAt:Date.now(),updatedAt:Date.now(),order:t.order+0.5,spawned:false,example:false};delete c.snoozeUntil;state.tasks.push(c);op('add',c.id,{...c});save();return c}
// anchor: the day of the month a monthly repeat was set on, so the 31st comes back after a short month
function nextDate(date,repeat,anchor){
  if(repeat==='daily')return addDays(date,1);
  if(repeat==='weekly')return addDays(date,7);
  if(repeat==='weekdays'){let d=addDays(date,1);while([0,6].includes(fromYmd(d).getDay()))d=addDays(d,1);return d}
  if(repeat==='monthly'){const d=fromYmd(date);const day=anchor||d.getDate();d.setDate(1);d.setMonth(d.getMonth()+1);const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(day,last));return ymd(d)}
  return null;
}
// Completing a repeating task plants the next one. Un-completing leaves the next one alone (it's a real task now).
function completeTask(id,done){
  const t=get(id);if(!t)return null;pushUndo();
  Object.assign(t,{done,updatedAt:stamp(t.updatedAt)});if(t.example)t.example=false;op('upd',id,{done});
  let spawned=null;
  if(done&&t.repeat&&!t.spawned){const anchor=t.repeat==='monthly'?(t.anchorDay||fromYmd(t.date).getDate()):0,today=todayStr();let nd=nextDate(t.date,t.repeat,anchor);
    // an overdue repeat lands on its next day from today on, not on a day already gone
    for(let i=0;nd&&nd<today&&i<4000;i++)nd=nextDate(nd,t.repeat,anchor);
    if(nd){spawned={...t,id:uid(),date:nd,done:false,spawned:false,order:nextOrder(nd),createdAt:Date.now(),updatedAt:Date.now(),seriesId:t.seriesId||t.id,example:false};delete spawned.snoozeUntil;if(anchor)spawned.anchorDay=anchor;
      t.spawned=true;state.tasks.push(spawned);op('add',spawned.id,{...spawned})}}
  save();return spawned;
}
function clearDone(date){pushUndo();const gone=state.tasks.filter(x=>x.date===date&&x.done).map(x=>({...x}));state.tasks=state.tasks.filter(x=>!(x.date===date&&x.done));gone.forEach(x=>{state.tombstones[x.id]=stamp(x.updatedAt);op('del',x.id)});save();return gone}
function undoneBefore(date){return state.tasks.filter(t=>!t.done&&t.date<date).sort((a,b)=>a.date.localeCompare(b.date))}
function carryAll(toDate){pushUndo();const ts=undoneBefore(toDate);ts.forEach(t=>{Object.assign(t,{date:toDate,order:nextOrder(toDate),updatedAt:stamp(t.updatedAt)});delete t.anchorDay;op('upd',t.id,{date:toDate})});save();return ts.length}

// ---------- routines ----------
// The starter set is not stamped as an edit: turning Routines on must not let three untouched templates overwrite the
// routines another device already has. Renaming, editing, adding or deleting one stamps it.
function ensureRoutines(){if(!state.routines.length)state.routines=ROUTINE_TEMPLATE.map(r=>({id:uid(),name:r.name,lines:[...r.lines]}));save()}
function resetRoutines(){state.routines=ROUTINE_TEMPLATE.map(r=>({id:uid(),name:r.name,lines:[...r.lines]}));touchRoutines();save()}
function newRoutine(){const r={id:uid(),name:'New routine',lines:[]};state.routines.push(r);touchRoutines();save();return r}
function deleteTasks(ids){const set=new Set(ids);if(!set.size)return 0;pushUndo();const at=new Map(state.tasks.filter(t=>set.has(t.id)).map(t=>[t.id,t.updatedAt]));state.tasks=state.tasks.filter(t=>!set.has(t.id));for(const id of set){state.tombstones[id]=stamp(at.get(id));op('del',id)}save();return set.size}
// The seeded demo: example tasks are deleted properly (tombstones, so every synced device drops them too); the example
// day note goes only while it is still the untouched seed (an edited note has a timestamp and is the user's).
function clearExamples(){const n=deleteTasks(state.tasks.filter(t=>t.example).map(t=>t.id));const removedNotes={};for(const k of Object.keys(state.notes)){if(!state.notesTs[k]&&state.notes[k]===EXAMPLE_NOTE){removedNotes[k]=state.notes[k];delete state.notes[k]}}const notes=Object.keys(removedNotes).length;if(notes)save();return {tasks:n,notes,removedNotes}}
// Undo of clearExamples: the tasks come back through the task history; the untouched seed note is put back by hand.
function restoreExampleNotes(removed){let n=0;for(const k in removed){if(!state.notes[k]){state.notes[k]=removed[k];n++}}if(n)save();return n}
function deleteRoutine(id){state.routines=state.routines.filter(r=>r.id!==id);touchRoutines();save()}
// one undo step for the whole routine; lines that name a day go to that day, the rest to `date`
function applyRoutine(id,date){const r=state.routines.find(x=>x.id===id);if(!r)return 0;pushUndo();let n=0;for(const line of r.lines){if(line.trim()&&addTask(line,date,null,true))n++}return n}

// ---------- reminders ----------
const remindLead=t=>{const r=t.remind==null?S().defaultRemind:t.remind;return r>0?r:null};
// Events due now: reminders (lead minutes before start) and start alerts. The catch window is two minutes; when the
// last check was longer ago than that (the PC slept, the tab was frozen) it reaches back to that check, 12 hours at
// most, and such events are marked late. sinceMs 0 (the first check after a launch) keeps the two minutes.
// Keys carry the start time, so a rescheduled task fires again at its new time. Popup style and sound are decided by the UI, not here.
function dueEvents(nowMs,sinceMs){
  const lo=sinceMs?Math.min(nowMs-120000,Math.max(sinceMs,nowMs-12*3600000)):nowMs-120000,late=at=>nowMs-at>120000;
  const out=[];
  for(const t of state.tasks){
    if(!t.notify||t.done||t.time==null)continue;
    const startMs=epoch(t.date,t.time);
    if(t.snoozeUntil&&t.snoozeUntil<=nowMs&&t.snoozeUntil>lo&&!state.fired[t.id+':z'+t.snoozeUntil]){out.push({task:t,kind:'start',key:t.id+':z'+t.snoozeUntil,late:late(t.snoozeUntil)});continue}
    const ks=t.id+':s:'+startMs,startDue=startMs<=nowMs&&startMs>lo&&!state.fired[ks];
    const lead=remindLead(t);
    if(lead){const r=startMs-lead*60000;const k=t.id+':r:'+startMs;if(r<=nowMs&&r>lo&&!state.fired[k]){
      if(startDue&&late(r))state.fired[k]=nowMs;   // both fell in the gap: the start alert says it all
      else out.push({task:t,kind:'remind',key:k,lead,late:late(r)})}}
    if(startDue)out.push({task:t,kind:'start',key:ks,late:late(startMs)});
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
    if(t.time!=null){const end=t.time+(t.dur||30);lines.push('DTSTART:'+dt(t.date,t.time),'DTEND:'+dt(addDays(t.date,Math.floor(end/1440)),end%1440))}else lines.push('DTSTART;VALUE=DATE:'+t.date.replace(/-/g,''));
    if(t.repeat)lines.push('RRULE:'+({daily:'FREQ=DAILY',weekly:'FREQ=WEEKLY',monthly:'FREQ=MONTHLY',weekdays:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'})[t.repeat]);
    if(t.notes)lines.push('DESCRIPTION:'+esc(t.notes));
    const lead=remindLead(t);if(t.notify&&t.time!=null&&lead)lines.push('BEGIN:VALARM','TRIGGER:-PT'+lead+'M','ACTION:DISPLAY','DESCRIPTION:'+esc(t.title),'END:VALARM');
    lines.push('END:VEVENT')}
  lines.push('END:VCALENDAR');return lines.join('\r\n');
}
const exportJSON=()=>JSON.stringify({schema:SCHEMA,device:state.device,exportedAt:Date.now(),tasks:state.tasks,tombstones:state.tombstones,notes:state.notes,notesTs:state.notesTs,labels:state.labels,oplog:state.oplog},null,1);
// Merge: tasks by id, newest updatedAt wins; notes by date, longer wins; oplog union by id. Same rule a sync server will apply.
// What comes in is someone else's file: tasks go through cleanTask, note HTML is cut down to what the editor makes
// (cleanNote, in ui.js), and label names must be text for a known colour.
function importJSON(text){
  const j=JSON.parse(text);if(!j||typeof j!=='object')throw new Error('That is not a Sundial export');let n=0;pushUndo();
  const theirDead=j.tombstones&&typeof j.tombstones==='object'?j.tombstones:{};const stampOk=v=>typeof v==='number'&&isFinite(v)&&v>0;
  for(const raw of Array.isArray(j.tasks)?j.tasks:[]){const t=cleanTask(raw&&typeof raw==='object'?{...raw}:null);if(!t)continue;if((state.tombstones[t.id]||0)>(t.updatedAt||0))continue;const ex=get(t.id);if(!ex){state.tasks.push(t);n++}else if((t.updatedAt||0)>(ex.updatedAt||0)){Object.assign(ex,t);n++}}
  for(const id in theirDead){if(!stampOk(theirDead[id]))continue;const ex=get(id);if(ex&&theirDead[id]>(ex.updatedAt||0)){state.tasks=state.tasks.filter(x=>x.id!==id);state.tombstones[id]=theirDead[id];n++}}
  const notes=j.notes&&typeof j.notes==='object'?j.notes:{},nts=j.notesTs&&typeof j.notesTs==='object'?j.notesTs:{};
  for(const d in notes){if(!DATE_RE.test(d)||typeof notes[d]!=='string')continue;const html=typeof cleanNote==='function'?cleanNote(notes[d]):notes[d];const mine=state.notesTs[d]||0,theirs=stampOk(nts[d])?nts[d]:0;if(!state.notes[d]||theirs>mine||(theirs===mine&&html.length>state.notes[d].length)){state.notes[d]=html;state.notesTs[d]=theirs||mine}}
  if(j.labels&&typeof j.labels==='object')for(const [k] of COLORS){if(typeof j.labels[k]==='string'&&j.labels[k].trim())state.labels[k]=j.labels[k].slice(0,40)}
  const seen=new Set(state.oplog.map(o=>o.id));for(const o of Array.isArray(j.oplog)?j.oplog:[]){if(o&&typeof o==='object'&&typeof o.ts==='number'&&!seen.has(o.id)){slimOp(o);state.oplog.push(o)}}state.oplog.sort((a,b)=>a.ts-b.ts);if(state.oplog.length>LOG_MAX)state.oplog.splice(0,state.oplog.length-LOG_MAX);
  if(typeof Sync!=='undefined')Sync.markAllDirty();
  save();return n;
}
