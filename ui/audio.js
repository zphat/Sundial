/* Sundial audio: every sound is synthesized here, nothing is sampled. One shared chain:
   voices -> master -> (dry + plate reverb) -> compressor -> out. Plus the voice-input capture. */
'use strict';
const SFX=(()=>{
  let ctx=null,master,comp,wet,dry,conv,volume=.7,repeatTimer=null,doneStep=0;
  function ensure(){
    if(ctx)return ctx;
    const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return null;
    ctx=new AC();
    master=ctx.createGain();master.gain.value=volume;
    comp=ctx.createDynamicsCompressor();comp.threshold.value=-20;comp.knee.value=12;comp.ratio.value=3;comp.attack.value=.004;comp.release.value=.25;
    dry=ctx.createGain();dry.gain.value=1;
    wet=ctx.createGain();wet.gain.value=.3;
    conv=ctx.createConvolver();conv.buffer=impulse(2.1,2.6);
    master.connect(dry);dry.connect(comp);master.connect(conv);conv.connect(wet);wet.connect(comp);comp.connect(ctx.destination);
    return ctx;
  }
  // Dark plate: decaying noise, one-pole lowpassed so the tail is velvet rather than hiss.
  function impulse(sec,decay){
    const rate=ctx.sampleRate,len=Math.floor(rate*sec),buf=ctx.createBuffer(2,len,rate);
    for(let ch=0;ch<2;ch++){const d=buf.getChannelData(ch);let y=0;for(let i=0;i<len;i++){const x=(Math.random()*2-1)*Math.pow(1-i/len,decay);y=y*.82+x*.18;d[i]=y*1.6}}
    return buf;
  }
  const unlock=()=>{const c=ensure();if(c&&c.state==='suspended')c.resume()};
  function pan(node,p){if(!ctx.createStereoPanner)return node;const sp=ctx.createStereoPanner();sp.pan.value=p;node.connect(sp);return sp}
  // A struck bar or bell: list of [ratio, gain, decaySeconds] partials, optional mallet click.
  function strike(f,t,g,p,partials,mallet){
    const out=ctx.createGain();out.gain.value=1;pan(out,p||0).connect(master);
    for(const[r,pg,dec]of partials){const o=ctx.createOscillator();o.type='sine';o.frequency.value=f*r;const e=ctx.createGain();
      e.gain.setValueAtTime(0,t);e.gain.linearRampToValueAtTime(g*pg,t+.003);e.gain.exponentialRampToValueAtTime(.0001,t+dec);
      o.connect(e);e.connect(out);o.start(t);o.stop(t+dec+.05)}
    if(mallet){const n=ctx.createBufferSource();const len=Math.floor(ctx.sampleRate*.012);const b=ctx.createBuffer(1,len,ctx.sampleRate);const d=b.getChannelData(0);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*(1-i/len);n.buffer=b;
      const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=mallet;bp.Q.value=1.2;const e=ctx.createGain();e.gain.value=g*.5;n.connect(bp);bp.connect(e);e.connect(out);n.start(t)}
  }
  // Marimba: fundamental + the bar's 1:4:10 partials, decay scales with pitch like real rosewood.
  const marimba=(f,t,g,p)=>{const d=Math.min(1.9,520/f+.35);strike(f,t,g,p,[[1,1,d],[4,.22,d*.3],[10,.05,d*.12]],2600)};
  // Glass: inharmonic bar partials, long shimmer.
  const glass=(f,t,g,p)=>strike(f,t,g,p,[[1,1,1.8],[2.756,.45,1.2],[5.404,.18,.7],[8.93,.06,.4]],0);
  // Music box: thin tine, bright, with a soft comb.
  const tine=(f,t,g,p)=>strike(f,t,g,p,[[1,1,1.5],[3,.28,.9],[5.2,.1,.5],[7.8,.04,.3]],5200);
  // Wristwatch tick: a wooden knock and a tiny high click together.
  function tick(t,g,p){
    strike(1900,t,g*.55,p,[[1,1,.028]],0);strike(330,t,g*.5,p,[[1,1,.022]],0);
    const n=ctx.createBufferSource();const len=Math.floor(ctx.sampleRate*.01);const b=ctx.createBuffer(1,len,ctx.sampleRate);const d=b.getChannelData(0);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*(1-i/len);n.buffer=b;
    const hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=4200;const e=ctx.createGain();e.gain.value=g*.5;n.connect(hp);hp.connect(e);pan(e,p).connect(master);n.start(t);
  }
  const N={C3:130.81,C4:261.63,D4:293.66,E4:329.63,F4:349.23,G4:392,A4:440,Bb4:466.16,C5:523.25,D5:587.33,E5:659.25,F5:698.46,G5:783.99,A5:880,C6:1046.5,D6:1174.66,E6:1318.51,G6:1567.98,A6:1760,B6:1975.53,C7:2093,E7:2637.02};
  // Theremin: one sliding sine (plus a hair of detune for width) with vibrato that deepens as the note holds, extra reverb. Eerie on purpose.
  function theremin(t,g){
    const o=ctx.createOscillator(),o2=ctx.createOscillator();o.type=o2.type='sine';o2.detune.value=6;
    const lfo=ctx.createOscillator();lfo.frequency.value=5.3;const lg=ctx.createGain();lg.gain.setValueAtTime(0,t);lg.gain.linearRampToValueAtTime(10,t+1.4);lfo.connect(lg);lg.connect(o.frequency);lg.connect(o2.frequency);
    const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=2200;
    const env=ctx.createGain();env.gain.setValueAtTime(0,t);env.gain.linearRampToValueAtTime(g,t+.28);env.gain.setValueAtTime(g,t+2.0);env.gain.exponentialRampToValueAtTime(.0001,t+3.1);
    o.connect(lp);o2.connect(lp);lp.connect(env);pan(env,0).connect(master);const send=ctx.createGain();send.gain.value=.9;env.connect(send);send.connect(conv);
    [o.frequency,o2.frequency].forEach(f=>{f.setValueAtTime(N.A4,t);f.exponentialRampToValueAtTime(N.F5,t+.75);f.setValueAtTime(N.F5,t+1.1);f.exponentialRampToValueAtTime(N.E5,t+1.45);f.setValueAtTime(N.E5,t+1.95);f.exponentialRampToValueAtTime(N.D5,t+2.7)});
    [o,o2,lfo].forEach(x=>{x.start(t);x.stop(t+3.2)});
  }
  // Felt piano: triangle + sine under a low-pass, slow-ish attack, a soft hammer thump. Muted and close.
  function felt(f,t,g,p){
    const out=ctx.createGain();out.gain.value=1;const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=1000;lp.Q.value=.6;lp.connect(out);pan(out,p||0).connect(master);
    const d=Math.min(1.8,420/f+.6);
    [['triangle',1,1],['sine',1,.6],['sine',2,.16],['sine',3,.05]].forEach(([type,r,gg])=>{const o=ctx.createOscillator();o.type=type;o.frequency.value=f*r;const e=ctx.createGain();e.gain.setValueAtTime(0,t);e.gain.linearRampToValueAtTime(g*gg,t+.014);e.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(e);e.connect(lp);o.start(t);o.stop(t+d+.05)});
    const n=ctx.createBufferSource();const len=Math.floor(ctx.sampleRate*.02);const b=ctx.createBuffer(1,len,ctx.sampleRate);const dd=b.getChannelData(0);for(let i=0;i<len;i++)dd[i]=(Math.random()*2-1)*(1-i/len);n.buffer=b;
    const nl=ctx.createBiquadFilter();nl.type='lowpass';nl.frequency.value=500;const ne=ctx.createGain();ne.gain.value=g*.35;n.connect(nl);nl.connect(ne);ne.connect(out);n.start(t);
  }
  const SOUNDS={
    // reminders: a watch tick (once or twice) or a glass note (once or twice)
    'remind.tick1':t=>{tick(t,.9,0)},
    'remind.tick2':t=>{tick(t,.9,-.15);tick(t+.19,.8,.15)},
    'remind.glass1':t=>{glass(N.C7,t,.26,0)},
    'remind.glass2':t=>{glass(N.G6,t,.26,-.2);glass(N.D6*2,t+.24,.24,.2)},
    // starts
    'start.chord':t=>{[[N.F4,0,-.3],[N.A4,.015,-.1],[N.C5,.03,.1],[N.E5,.045,.3]].forEach(([f,o,p])=>marimba(f,t+o,.45,p))},
    'start.musicbox':t=>{[[N.E6,0,-.3],[N.G6,.18,-.1],[N.C7,.36,.1],[N.B6,.62,.2],[N.G6,.8,0]].forEach(([f,o,p])=>tine(f,t+o,.26,p))},
    'start.theremin':t=>{theremin(t,.34)},
    'start.felt':t=>{felt(N.C3,t,.42,0);[[N.C4,0,-.25],[N.G4,.18,-.1],[N.D5,.36,.1],[N.E5,.56,.25]].forEach(([f,o,p])=>felt(f,t+o,.5,p))},
    // completing a task climbs a pentatonic ladder, one step per completion; clearing the day resolves it
    'ui.done':t=>{const lad=[N.C5,N.D5,N.E5,N.G5,N.A5,N.C6];marimba(lad[doneStep%lad.length],t,.3,(doneStep%2?.2:-.2));doneStep++},
    'ui.undone':t=>{marimba(N.G4,t,.2,0);doneStep=Math.max(0,doneStep-1)},
    'ui.clear':t=>{[[N.C5,0],[N.E5,.1],[N.G5,.2]].forEach(([f,o])=>marimba(f,t+o,.4,0));[[N.C5,0],[N.E5,.012],[N.G5,.024],[N.C6,.036]].forEach(([f,o])=>marimba(f,t+.5+o,.38,0));doneStep=0},
    'ui.add':t=>{tick(t,.5,0)},
    'ui.voice.on':t=>{glass(N.A5,t,.14,0);glass(N.E6,t+.09,.14,0)},
    'ui.voice.off':t=>{glass(N.E6,t,.12,0);glass(N.A5,t+.09,.12,0)},
  };
  function play(name,force){
    const st=(typeof S==='function')?S().sounds:{enabled:true};
    if(!force&&!st.enabled)return;if(!force&&name.startsWith('ui.')&&!st.ui)return;
    const c=ensure();if(!c)return;const fn=SOUNDS[name];if(!fn)return;
    if(c.state==='running'){fn(c.currentTime+.02);return}
    // Not unlocked by a gesture yet: try, play only if it worked. Never queue into a suspended context (it would all burst out on the first click).
    c.resume().catch(()=>{});setTimeout(()=>{if(c.state==='running')fn(c.currentTime+.02)},80);
  }
  function ctxFor(){const c=ensure();if(c&&c.state!=='running')c.resume().catch(()=>{});return c}
  function setVolume(v){volume=v;if(master)master.gain.setTargetAtTime(v,ctx.currentTime,.02)}
  function repeat(name,secs){stopRepeat();if(!secs)return;repeatTimer=setInterval(()=>play(name),secs*1000)}
  function stopRepeat(){if(repeatTimer){clearInterval(repeatTimer);repeatTimer=null}}
  function analyser(stream){const c=ensure();const src=c.createMediaStreamSource(stream);const an=c.createAnalyser();an.fftSize=256;an.smoothingTimeConstant=.7;src.connect(an);return an}
  return {play,setVolume,repeat,stopRepeat,unlock,ctx:ctxFor,names:Object.keys(SOUNDS)};
})();

// Voice input: mic only while the button is lit. Level meter from the real stream; words from the browser's speech engine.
// Errors that only mean "no transcription here" (no engine, no network) keep the mic and meter alive; the user still stops it by hand.
const Voice=(()=>{
  let rec=null,stream=null,src=null,raf=0,active=false,starting=false,finalText='';
  const SOFT=['nosr','network','not-allowed','service-not-allowed','language-not-supported'];
  const hasSR=()=>!!(window.SpeechRecognition||window.webkitSpeechRecognition);
  async function start(h){
    if(active||starting)return false;starting=true;
    try{
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){h.onError('nomic');return false}
      try{stream=await navigator.mediaDevices.getUserMedia({audio:true})}catch(e){h.onError(e&&e.name==='NotAllowedError'?'denied':'nomic');return false}
      active=true;finalText='';
      try{const c=SFX.ctx();src=c.createMediaStreamSource(stream);const an=c.createAnalyser();an.fftSize=256;an.smoothingTimeConstant=.7;src.connect(an);
        const data=new Uint8Array(an.frequencyBinCount);const loop=()=>{if(!active)return;an.getByteFrequencyData(data);h.onLevel(data);raf=requestAnimationFrame(loop)};loop()}catch(e){}
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!SR){h.onError('nosr');return true}
      const r=new SR();r.continuous=true;r.interimResults=true;r.lang=navigator.language||'en-US';
      r.onresult=e=>{if(rec!==r)return;let inter='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)finalText+=t+' ';else inter+=t}h.onResult(finalText.trim(),inter.trim())};
      r.onerror=e=>{if(rec!==r||e.error==='no-speech'||e.error==='aborted')return;if(SOFT.includes(e.error))rec=null;h.onError(e.error)};
      r.onend=()=>{if(rec===r){stop();h.onEnd()}};
      try{r.start();rec=r}catch(e){h.onError('nosr')}
      return true;
    }finally{starting=false}
  }
  function stop(){active=false;cancelAnimationFrame(raf);if(rec){const r=rec;rec=null;r.onresult=r.onerror=r.onend=null;try{r.stop()}catch(e){}}if(src){try{src.disconnect()}catch(e){}src=null}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}}
  return {start,stop,hasSR,isSoft:c=>SOFT.includes(c),isActive:()=>active};
})();
