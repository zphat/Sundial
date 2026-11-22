/* Optional AI parsing with the user's own key. On desktop the request goes through Rust (key in the OS
   credential store). In a browser it calls the provider directly (key kept in this browser only).
   The regex parser always runs first and the task appears instantly; AI only refines fields afterwards. */
'use strict';
const AI={
  SCHEMA:{type:'object',properties:{
    title:{type:'string'},date:{type:['string','null']},time:{type:['integer','null']},dur:{type:['integer','null']},
    color:{type:['string','null']},repeat:{type:['string','null'],enum:['daily','weekdays','weekly','monthly',null]},
    remind:{type:['integer','null']},notify:{type:['boolean','null']},notes:{type:['string','null']}},
    required:['title','date','time','dur','color','repeat','remind','notify','notes'],additionalProperties:false},
  context(sel){const n=new Date();return {today:todayStr(),weekday:dowName(todayStr()),now:fmtTime(nowMin()),selected:sel,labels:Object.fromEntries(COLORS.map(([k])=>[k,state.labels[k]]))}},
  system(ctx){return `You turn one line typed into a personal planner into fields. Today is ${ctx.today} (${ctx.weekday}), local time ${ctx.now}. The day currently selected in the app is ${ctx.selected}; use it when the line names no day. Color keys and what the user calls them: ${JSON.stringify(ctx.labels)}. Rules: keep the title in the user's words with scheduling words removed. Times are minutes after midnight; a bare small number like 'at 3' for a daytime errand means afternoon. Durations in minutes. Set only what the line actually implies, otherwise null. Details that are not the task itself (address, names, links, what to bring, why) go into notes. Never invent dates, times or people.`},
  async parse(text,sel){
    const a=S().ai;const ctx=this.context(sel);
    if(window.SundialDesktop)return window.SundialDesktop.aiParse({provider:a.provider,model:a.model,base_url:a.baseUrl||null,text,context:ctx});
    const key=(a.keysInBrowser||{})[a.provider];if(!key)throw new Error('No API key saved for this provider');
    if(a.provider==='anthropic'){
      const fb=['claude-opus-5-5','claude-opus-5','claude-sonnet-5-5','claude-fable'].some(p=>a.model.startsWith(p));
      const headers={'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'};
      if(fb)headers['anthropic-beta']='server-side-fallback-2026-07-01';
      const body={model:a.model,max_tokens:1024,system:this.system(ctx),messages:[{role:'user',content:text}],output_config:{effort:'low',format:{type:'json_schema',schema:this.SCHEMA}}};
      if(fb)body.fallbacks='default';
      const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});const v=await r.json();
      if(!r.ok)throw new Error(v.error?.message||('HTTP '+r.status));if(v.stop_reason==='refusal')throw new Error('The model declined this line');
      const t=(v.content||[]).find(b=>b.type==='text');if(!t)throw new Error('No text in response');return JSON.parse(t.text);
    }
    const base=(a.baseUrl||'https://api.openai.com/v1').replace(/\/+$/,'');
    const r=await fetch(base+'/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+key},body:JSON.stringify({model:a.model,messages:[{role:'system',content:this.system(ctx)},{role:'user',content:text}],response_format:{type:'json_schema',json_schema:{name:'task',schema:this.SCHEMA,strict:true}}}),signal:AbortSignal.timeout(40000)});
    const v=await r.json();if(!r.ok)throw new Error(v.error?.message||('HTTP '+r.status));
    const c=v.choices?.[0]?.message?.content;if(!c)throw new Error('No content in response');return JSON.parse(c);
  },
  // Apply what the model found that the regex pass did not. Returns a human summary or null.
  // `had` says what the typed line already stated explicitly; the model never overrides those.
  refinePatch(task,ai,had){
    const p={},said=[];had=had||{};if(!ai||typeof ai!=='object')return null;
    // the model's answer is outside data: times, lengths, repeat words and dates must be real ones
    const int=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
    if(typeof ai.title==='string'&&ai.title.trim()&&ai.title.trim()!==task.title&&ai.title.length<=task.title.length){p.title=ai.title.trim()}
    if(task.time==null&&int(ai.time,0,1439)){p.time=ai.time;said.push(fmtTime(ai.time))}
    if(!task.dur&&int(ai.dur,1,1440)){p.dur=ai.dur;said.push(fmtDur(ai.dur))}
    if(typeof ai.date==='string'&&DATE_RE.test(ai.date)&&ymd(fromYmd(ai.date))===ai.date&&ai.date!==task.date&&!had.date){p.date=ai.date;said.push(relDay(ai.date)+' '+fromYmd(ai.date).getDate())}
    if(ai.color&&COLORS.some(([k])=>k===ai.color)&&!had.color&&ai.color!==task.color){p.color=ai.color;said.push(state.labels[ai.color])}
    if(REPEATS.includes(ai.repeat)&&!task.repeat){p.repeat=ai.repeat;said.push('↻ '+ai.repeat)}
    if(int(ai.remind,1,10080)&&task.remind==null){p.remind=ai.remind;said.push('remind '+fmtLead(ai.remind))}
    if(ai.notify===false&&task.notify){p.notify=false;said.push('silent')}
    if(typeof ai.notes==='string'&&ai.notes.trim()&&!task.notes){p.notes=ai.notes.trim();said.push('notes')}
    return Object.keys(p).length?{patch:p,summary:said.join(' · ')||'title'}:null;
  }
};
