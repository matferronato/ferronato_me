const $ = id => document.getElementById(id);
const $$ = s => [...document.querySelectorAll(s)];
const C = {grid:'#202a33',grid2:'#43515d',text:'#eeede8',muted:'#75828d',cyan:'#63d5e8',blue:'#7f9fd2',lime:'#84c99c',amber:'#e7aa57',red:'#dc7c76',purple:'#ad91cb',copper:'#c98c56'};

const defaults = {
  probePct:100,windowNs:12,voltsDiv:.5,waveform:'step',freqMHz:500,edgePs:300,lineMm:150,ampV:1.0,loadR:90,widthMm:.15,heightMm:.12,copperUm:35,er:4.1,
  vpMmNs:170,sourceR:10,termR:40,termMode:'series',diffSpacing:.18,skewMm:0,diffVpp:.8,
  xtalkSpacing:.20,parallelMm:40,viaPitch:3,viaDist:1,viaFreqGHz:5,planeGap:0,fence:true
};
const state = {...defaults};
let active='tl', paused=false, simT=0, lastTs=performance.now();

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const fmt=(v,n=2)=>Number(v).toFixed(n);
const norm=(v,a,b)=>clamp((v-a)/(b-a),0,1);

function microstripZ0(w,h,t,er){
  w=Math.max(w,1e-5); h=Math.max(h,1e-5); t=Math.max(t,1e-5);
  const we=w+t/Math.PI*(1+Math.log(4*Math.E/Math.sqrt((t/h)**2+(1/Math.PI/(w/t+1.1))**2)));
  const u=we/h;
  let ee=(er+1)/2+(er-1)/2/Math.sqrt(1+12/u);
  if(u<1) ee+=.04*(1-u)**2;
  return u<=1 ? (60/Math.sqrt(ee))*Math.log(8/u+.25*u) : (120*Math.PI)/(Math.sqrt(ee)*(u+1.393+.667*Math.log(u+1.444)));
}

function derived(){
  const z0=microstripZ0(state.widthMm,state.heightMm,state.copperUm/1000,state.er);
  const ee=(state.er+1)/2+(state.er-1)/2/Math.sqrt(1+12*state.heightMm/state.widthMm);
  const vpGeom=299.8/Math.sqrt(ee);
  const td=state.lineMm/state.vpMmNs;
  const gammaL=state.loadR===0?-1:(state.loadR-z0)/(state.loadR+z0);
  const srcEff=state.sourceR+(state.termMode==='series'?state.termR:0);
  const gammaS=(srcEff-z0)/(srcEff+z0);
  const launch=z0/(z0+srcEff);
  const kneeGHz=500/state.edgePs;
  const electrical=td/(state.edgePs/1000);
  const skewPs=state.skewMm/state.vpMmNs*1000;
  const diffCoupling=clamp(Math.exp(-state.diffSpacing/(state.widthMm*.95)),.02,.94);
  const sh=state.xtalkSpacing/state.heightMm;
  const xtalkK=clamp(.18*Math.exp(-state.xtalkSpacing/(state.heightMm*1.3))*(1-Math.exp(-state.parallelMm/55))*clamp(350/state.edgePs,.08,2.6),0,.48);
  const lambda=150/state.viaFreqGHz;
  const pitchRatio=state.viaPitch/lambda;
  const viaBenefit=state.fence ? clamp(1-Math.pow(clamp(pitchRatio/.18,0,1),1.45),0,1)*Math.exp(-state.viaDist/8) : 0;
  const leakage=clamp((1-viaBenefit)*(.22+.78*state.planeGap),0,1);
  return {z0,ee,vpGeom,td,gammaL,gammaS,launch,kneeGHz,electrical,skewPs,diffCoupling,sh,xtalkK,lambda,pitchRatio,leakage};
}

function unit(key,v){
  const n={probePct:[0,' %'],windowNs:[0,' ns'],voltsDiv:[2,' V/div'],freqMHz:[0,' MHz'],edgePs:[0,' ps'],lineMm:[0,' mm'],ampV:[2,' V'],loadR:[0,' Ω'],widthMm:[3,' mm'],heightMm:[3,' mm'],copperUm:[0,' µm'],er:[2,''],vpMmNs:[0,' mm/ns'],sourceR:[0,' Ω'],termR:[0,' Ω'],diffSpacing:[2,' mm'],skewMm:[1,' mm'],diffVpp:[2,' Vpp'],xtalkSpacing:[2,' mm'],parallelMm:[0,' mm'],viaPitch:[1,' mm'],viaDist:[1,' mm'],viaFreqGHz:[1,' GHz'],planeGap:[0,'%']}[key];
  if(key==='planeGap') return fmt(v*100,0)+'%';
  return n ? fmt(v,n[0])+n[1] : String(v);
}

const changeText={
  waveform:'Excitation changed. The time cursor is held for comparison.',
  freqMHz:'Frequency changed at a fixed time span. Watch cycle spacing change.',
  probePct:'Probe moved. Forward and reflected voltages are added at this position.',
  voltsDiv:'Voltage scale changed for the spatial and receiver views.',
  windowNs:'Time span changed. All signal views share this timebase.',
  lineMm:'Channel length changed → the drawn interconnect length and flight time changed.',
  loadR:'Load impedance changed → watch reflected-wave polarity/amplitude and the load marker.',
  edgePs:'Edge time changed → watch the transition band widen/narrow and coupling strength react.',
  ampV:'Signal swing changed → wave/field amplitude changes directly in the scene.',
  vpMmNs:'Propagation velocity changed → watch the wavefront travel faster/slower.',
  sourceR:'Driver resistance changed → source resistor and source reflection coefficient changed.',
  termR:'Termination resistance changed → the drawn termination and bounce amplitudes changed.',
  diffSpacing:'Pair spacing changed → the two traces physically moved and their shared field changed.',
  skewMm:'Length mismatch changed → one differential edge now arrives earlier/later.',
  diffVpp:'Differential swing changed → receiver bars and transition intensity changed.',
  xtalkSpacing:'Trace spacing changed → the victim trace physically moved and coupling field changed.',
  parallelMm:'Parallel length changed → the highlighted coupled section physically changed length.',
  heightMm:'Reference-plane height changed → plane position/field spread changed.',
  viaPitch:'Fence pitch changed → the visible via density and spacing changed.',
  viaDist:'Fence distance changed → stitching/fence vias moved relative to the signal via.',
  viaFreqGHz:'Frequency changed → the visible field-wavelength rings changed spacing.',
  planeGap:'Plane discontinuity changed → the reference-plane opening visibly changed.',
  widthMm:'Trace width changed → copper width and Z₀ changed.',
  copperUm:'Copper thickness changed → the drawn copper thickness changed.',
  er:'Dielectric constant changed → dielectric shading, field concentration, velocity, and Z₀ changed.'
};

function syncBindings(){
  $$('#termMode button').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.termMode));
  $$('#fenceMode button').forEach(b=>b.classList.toggle('active',(b.dataset.mode==='on')===state.fence));
  $$('[data-bind="freqMHz"]').forEach(el=>{el.disabled=state.waveform==='step'});
  $$('[data-bind="edgePs"]').forEach(el=>{el.disabled=['sine','triangle'].includes(state.waveform)});
  $$('.frequency-label').forEach(el=>el.textContent=state.waveform==='random'?'Symbol rate':state.waveform==='step'?'Frequency · single step':'Frequency');

  $$('[data-bind]').forEach(el=>{
    el.value=state[el.dataset.bind];
    const min=+el.min||0,max=+el.max||100,v=+el.value;
    el.style.setProperty('--pct',`${clamp((v-min)/(max-min),0,1)*100}%`);
  });
  $$('[data-out]').forEach(o=>{o.textContent=unit(o.dataset.out,state[o.dataset.out])});
}

function announceChange(key,sectionId){
  const section=$(sectionId)||$(active);
  const readout=section?.querySelector('.change-readout');
  const pane=section?.querySelector('.stage-instrument, .stage-pane');
  if(readout){
    readout.textContent=changeText[key]||'Parameter changed → watch the animation update.';
    readout.classList.remove('hot'); void readout.offsetWidth; readout.classList.add('hot');
    clearTimeout(readout._timer); readout._timer=setTimeout(()=>readout.classList.remove('hot'),900);
  }
  if(pane){pane.classList.remove('visual-change'); void pane.offsetWidth; pane.classList.add('visual-change');}
  section?.querySelectorAll(`[data-bind="${key}"]`).forEach(input=>{
    const row=input.closest('.control-row'); if(!row)return;
    row.classList.add('is-changing'); clearTimeout(row._timer); row._timer=setTimeout(()=>row.classList.remove('is-changing'),650);
  });
}

$$('[data-bind]').forEach(el=>el.addEventListener('input',()=>{
  state[el.dataset.bind]=el.dataset.bind==='waveform'?el.value:+el.value;
  syncBindings();
  announceChange(el.dataset.bind,el.closest('.lab-section')?.id||active);
  renderStatic();
}));

function metric(label,value,sev=''){return `<div class="metric ${sev}"><span>${label}</span><strong>${value}</strong></div>`}
function sev(v,good,warn,invert=false){if(!invert)return v<=good?'good':v<=warn?'warn':'bad';return v>=good?'good':v>=warn?'warn':'bad'}

function prep(canvas){
  const r=canvas.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1);
  const fitted=window.matchMedia('(min-width: 1100px) and (min-height: 680px)').matches;
  const aspect=+(canvas.dataset.aspect ||= canvas.height/canvas.width);
  const cw=Math.max(1,r.width),ch=fitted?Math.max(1,r.height):Math.max(180,r.width*aspect);
  const pw=Math.round(cw*d),ph=Math.round(ch*d);
  if(canvas.width!==pw||canvas.height!==ph){canvas.width=pw;canvas.height=ph;}
  const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,pw,ph);
  const scene=canvas.closest('.viewport');
  if(fitted&&scene){
    // Preserve geometric proportions inside the allocated panel, not intrinsic canvas height.
    const w=Math.max(760,cw),h=canvas.id==='matchCanvas'?440:Math.max(380,w*.38);
    const scale=Math.min(cw/w,ch/h);
    ctx.setTransform(d*scale,0,0,d*scale,(cw-w*scale)*d/2,(ch-h*scale)*d/2);
    return {ctx,w,h};
  }
  ctx.setTransform(d,0,0,d,0,0);return {ctx,w:Math.max(300,cw),h:ch};
}

function line(ctx,x1,y1,x2,y2,c=C.grid,w=1,d=[]){ctx.save();ctx.strokeStyle=c;ctx.lineWidth=w;ctx.setLineDash(d);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.restore()}
function txt(ctx,s,x,y,c=C.muted,size=11,align='left',weight=500){ctx.save();ctx.fillStyle=c;ctx.font=`${weight} ${size}px ui-monospace,SFMono-Regular,Menlo,monospace`;ctx.textAlign=align;ctx.fillText(s,x,y);ctx.restore()}
function box(ctx,x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.stroke()}}
function glowDot(ctx,x,y,r,c,alpha=1){ctx.save();ctx.shadowColor=c;ctx.shadowBlur=18;ctx.globalAlpha=alpha;ctx.fillStyle=c;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();ctx.restore()}
function arrow(ctx,x1,y1,x2,y2,c,w=2){line(ctx,x1,y1,x2,y2,c,w);const a=Math.atan2(y2-y1,x2-x1);ctx.fillStyle=c;ctx.beginPath();ctx.moveTo(x2,y2);ctx.lineTo(x2-8*Math.cos(a-.55),y2-8*Math.sin(a-.55));ctx.lineTo(x2-8*Math.cos(a+.55),y2-8*Math.sin(a+.55));ctx.closePath();ctx.fill()}
function dimArrow(ctx,x1,y1,x2,y2,label,c=C.amber){arrow(ctx,x1,y1,x2,y2,c,1.3);arrow(ctx,x2,y2,x1,y1,c,1.3);txt(ctx,label,(x1+x2)/2,(y1+y2)/2-6,c,9,'center',700)}
function pcbTrace(ctx,x1,y1,x2,y2,core='#365e77',width=9){
  ctx.save();ctx.lineCap='round';ctx.shadowColor='rgba(57,125,158,.18)';ctx.shadowBlur=12;
  line(ctx,x1,y1,x2,y2,'rgba(17,35,47,.95)',width+7);line(ctx,x1,y1,x2,y2,core,width);line(ctx,x1,y1-1,x2,y2-1,'rgba(177,214,231,.16)',1);
  ctx.restore();
}
function scopeBackdrop(ctx,w,h){
  ctx.save();ctx.fillStyle='#070b0e';ctx.fillRect(0,0,w,h);
  for(let i=0;i<=10;i++){const x=w*i/10;line(ctx,x,0,x,h,i===5?'rgba(79,98,112,.22)':'rgba(59,73,84,.105)',i===5?1.1:1)}
  for(let i=0;i<=8;i++){const y=h*i/8;line(ctx,0,y,w,y,i===4?'rgba(79,98,112,.22)':'rgba(59,73,84,.105)',i===4?1.1:1)}
  ctx.restore();
}
function resistor(ctx,x1,y,x2,c=C.amber,width=2){
  const n=7, lead=(x2-x1)*.12; line(ctx,x1,y,x1+lead,y,c,width); line(ctx,x2-lead,y,x2,y,c,width);
  ctx.save();ctx.strokeStyle=c;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(x1+lead,y);
  const span=x2-x1-2*lead;
  for(let i=1;i<=n;i++){const x=x1+lead+span*i/n;const yy=y+(i===n?0:(i%2?7:-7));ctx.lineTo(x,yy)}ctx.stroke();ctx.restore();
}
function resistorV(ctx,x,y1,y2,c=C.cyan,width=2){
  const n=7,lead=(y2-y1)*.12;line(ctx,x,y1,x,y1+lead,c,width);line(ctx,x,y2-lead,x,y2,c,width);ctx.save();ctx.strokeStyle=c;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(x,y1+lead);const span=y2-y1-2*lead;for(let i=1;i<=n;i++){const y=y1+lead+span*i/n,xx=x+(i===n?0:(i%2?7:-7));ctx.lineTo(xx,y)}ctx.stroke();ctx.restore();
}
function plot(canvas,series,opt={},cursor=null){
  const {ctx,w,h}=prep(canvas);ctx.clearRect(0,0,w,h);scopeBackdrop(ctx,w,h);const l=58,r=18,t=24,b=38,pw=w-l-r,ph=h-t-b;
  for(let i=0;i<=4;i++){const y=t+ph*i/4;line(ctx,l,y,w-r,y,C.grid,1);const val=lerp(opt.ymax,opt.ymin,i/4);txt(ctx,fmt(val,opt.yDigits??2),l-8,y+4,C.muted,9,'right')}
  line(ctx,l,t,l,h-b,C.grid2,1.2);line(ctx,l,h-b,w-r,h-b,C.grid2,1.2);
  const xmin=opt.xmin,xmax=opt.xmax,X=x=>l+(x-xmin)/(xmax-xmin)*pw,Y=y=>t+(opt.ymax-y)/(opt.ymax-opt.ymin)*ph;
  ctx.save();ctx.beginPath();ctx.rect(l,t,pw,ph);ctx.clip();
  series.forEach(s=>{ctx.save();ctx.strokeStyle=s.color;ctx.lineWidth=s.width||2;ctx.beginPath();s.data.forEach((p,i)=>i?ctx.lineTo(X(p[0]),Y(p[1])):ctx.moveTo(X(p[0]),Y(p[1])));ctx.stroke();ctx.restore()});
  ctx.restore();
  if(opt.zero&&opt.ymin<0&&opt.ymax>0)line(ctx,l,Y(0),w-r,Y(0),C.grid2,1,[4,4]);
  if(cursor!=null&&cursor>=xmin&&cursor<=xmax){const x=X(cursor);line(ctx,x,t,x,h-b,'rgba(255,255,255,.45)',1,[3,3]);glowDot(ctx,x,h-b,3,C.text,.8)}
  txt(ctx,opt.xLabel||'',(l+w-r)/2,h-10,C.muted,9,'center');txt(ctx,opt.yLabel||'',12,t+ph/2,C.muted,9,'center');txt(ctx,fmt(xmin,opt.xDigits??2),l,h-18,C.muted,9);txt(ctx,fmt(xmax,opt.xDigits??2),w-r,h-18,C.muted,9,'right');
  if(opt.legend){let x=l;opt.legend.forEach(it=>{line(ctx,x,t+6,x+17,t+6,it.color,3);txt(ctx,it.name,x+23,t+9,C.text,9);x+=95})}
}

function switchTab(id){
  active=id;
  $$('.lab-nav button').forEach(b=>b.classList.toggle('active',b.dataset.target===id));
  $$('.lab-section').forEach(s=>s.classList.toggle('active',s.id===id));
  const names={tl:'Transmission line',match:'Impedance matching',diff:'Differential pair',xtalk:'Crosstalk',vias:'Via transition',stackup:'Stackup / Z₀',guide:'Design review'};
  if($('activeLabTitle')) $('activeLabTitle').textContent=names[id]||id;
  requestAnimationFrame(renderStatic);
}
function setTheme(theme){
 document.documentElement.dataset.theme=theme;
 $('themeBtn').textContent=theme==='dark'?'Light mode':'Dark mode';
 $('themeBtn').setAttribute('aria-label',`Switch to ${theme==='dark'?'light':'dark'} mode`);
 try{localStorage.setItem('si-theme',theme)}catch{}
}
let savedTheme='dark';try{savedTheme=localStorage.getItem('si-theme')||'dark'}catch{}
setTheme(savedTheme==='light'?'light':'dark');
$('themeBtn').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
$$('[data-scrub]').forEach(el=>el.addEventListener('input',()=>{paused=true;simT=+el.value/1000*8;$('pauseBtn').textContent='▶ Resume';renderStatic()}));
$$('[data-replay]').forEach(el=>el.onclick=()=>{simT=0;paused=false;$('pauseBtn').textContent='Ⅱ Pause';renderStatic()});
function syncTime(){
 $$('[data-scrub]').forEach(el=>el.value=simT/8%1*1000);
 $$('[data-time]').forEach(el=>el.textContent=fmt(modelTime(),3)+' ns');
}
$('labNav').addEventListener('click',e=>{const b=e.target.closest('button[data-target]');if(b)switchTab(b.dataset.target)});
$$('[data-go]').forEach(b=>b.onclick=()=>switchTab(b.dataset.go));
$('pauseBtn').onclick=()=>{paused=!paused;$('pauseBtn').innerHTML=paused?'▶ Resume':'<span class="pause-icon">Ⅱ</span> Pause';renderStatic()};
$('resetAll').onclick=()=>{Object.assign(state,defaults);simT=0;syncBindings();renderStatic()};
$('termMode').onclick=e=>{const b=e.target.closest('button[data-mode]');if(!b)return;state.termMode=b.dataset.mode;$$('#termMode button').forEach(x=>x.classList.toggle('active',x===b));announceChange('termR','match');renderStatic()};
$('fenceMode').onclick=e=>{const b=e.target.closest('button[data-mode]');if(!b)return;state.fence=b.dataset.mode==='on';$$('#fenceMode button').forEach(x=>x.classList.toggle('active',x===b));announceChange('viaPitch','vias');renderStatic()};
fetch('/api/health').then(r=>r.json()).then(()=>{$('serverStatus').textContent='Python engine'}).catch(()=>{});

function renderTelemetry(){
  const d=derived();
  $('globalTelemetry').innerHTML=metric('Calculated Z₀',fmt(d.z0,1)+' Ω',sev(Math.abs(d.z0-50),3,8))+metric('1-way delay',fmt(d.td,3)+' ns')+metric('td / tr',fmt(d.electrical,2),sev(d.electrical,.2,.5))+metric('Edge knee',fmt(d.kneeGHz,2)+' GHz');
}

function drawJourney(){
  if(!$('journeyCanvas').getBoundingClientRect().width)return;
  const d=derived(), {ctx,w,h}=prep($('journeyCanvas'));ctx.clearRect(0,0,w,h);
  const y=h*.52,x0=65,x1=w-70,seg=[x0,x0+w*.16,x0+w*.43,x0+w*.65,x0+w*.82,x1],labels=['TX','controlled Z₀','parallel region','via','RX'];
  box(ctx,24,y-50,68,100,14,'#102538',C.grid2);txt(ctx,'TX',58,y-7,C.text,12,'center',800);txt(ctx,'DRV',58,y+13,C.muted,9,'center');
  pcbTrace(ctx,seg[0],y,seg[4],y,'#31556b',9);for(let i=1;i<5;i++)line(ctx,seg[i],y-18,seg[i],y+18,'rgba(255,255,255,.05)',1);
  pcbTrace(ctx,seg[2],y+48,seg[3],y+48,'#263e50',6);txt(ctx,'victim',seg[2]+8,y+68,C.amber,9);
  const viaX=seg[3]+20;line(ctx,viaX,y-24,viaX,y+35,C.copper,6);ctx.fillStyle='#71889b';for(const yy of [y-30,y+42]){ctx.beginPath();ctx.arc(viaX,yy,7,0,Math.PI*2);ctx.fill()}
  box(ctx,seg[4],y-50,76,100,14,'#102538',C.grid2);txt(ctx,'RX',seg[4]+38,y-7,C.text,12,'center',800);txt(ctx,`${fmt(d.z0,1)}Ω line`,(seg[1]+seg[2])/2,y-21,C.cyan,9,'center');
  const currentRegion=active==='match'?0:active==='tl'||active==='stackup'?1:active==='xtalk'?2:active==='vias'?3:active==='diff'?4:-1;
  for(let i=0;i<5;i++){const a=i===0?24:seg[i],b=i===4?seg[4]+76:seg[i+1];if(i===currentRegion){ctx.fillStyle='rgba(77,225,255,.035)';ctx.fillRect(a,20,b-a,h-40)}txt(ctx,labels[i],(a+b)/2,24,i===currentRegion?C.cyan:C.muted,9,'center',i===currentRegion?800:500)}
}

// All times are nanoseconds. Random is a deterministic NRZ bit stream.
function randomBit(n){let x=(n+1)|0;x=Math.imul(x^0x9e3779b9,0x85ebca6b);x^=x>>>13;return (x>>>0)%2;}
function sourceSignal(t){
  if(t<0)return 0;
  const tr=state.edgePs/1000, period=1000/state.freqMHz;
  const ramp=u=>clamp(u/Math.max(tr/0.8,1e-6),0,1);
  if(state.waveform==='step')return ramp(t);
  if(state.waveform==='sine')return Math.sin(2*Math.PI*t/period);
  if(state.waveform==='triangle')return 2/Math.PI*Math.asin(Math.sin(2*Math.PI*t/period));
  const slot=state.waveform==='square'?period/2:period;
  const n=Math.floor(t/slot),phase=t-n*slot;
  const key=[state.waveform,state.freqMHz,state.edgePs].join(':');
  if(sourceSignal.cache?.key!==key)sourceSignal.cache={key,starts:[0]};
  const starts=sourceSignal.cache.starts,rate=1.6/tr;
  const target=i=>state.waveform==='square'?(i%2?-1:1):(randomBit(i)?1:-1);
  const move=(v,to,dt)=>v+clamp(to-v,-rate*dt,rate*dt);
  while(starts.length<=n){const i=starts.length-1;starts.push(move(starts[i],target(i),slot));}
  return move(starts[n],target(n),phase);

}
function timeWindow(){return state.windowNs;}
function modelTime(){return (simT/8%1)*timeWindow();}
function wavesAt(x,t,p=bounceParams()){
  let inc=0,ref=0,coefficient=state.ampV*p.launch;
  const count=Math.max(0,Math.ceil(t/(2*p.td))+1);
  for(let n=0;n<count;n++){
    inc+=coefficient*sourceSignal(t-(2*n+x)*p.td);
    ref+=coefficient*p.gl*sourceSignal(t-(2*n+2-x)*p.td);
    coefficient*=p.gl*p.gs;
    if(Math.abs(coefficient)<1e-8)break;
  }
  return {inc,ref,total:inc+ref};
}
function receiverPlot(canvas,p=bounceParams()){
  const T=timeWindow(),data=[],input=[];
  for(let i=0;i<1000;i++){const t=T*i/999;data.push([t,wavesAt(1,t,p).total]);input.push([t,state.ampV*sourceSignal(t)]);}
  const peak=state.voltsDiv*4;
  plot(canvas,[{data:input,color:C.blue},{data,color:C.lime}],{xmin:0,xmax:T,ymin:-peak,ymax:peak,xLabel:'time (ns)',yLabel:'voltage (V)',yDigits:2,zero:true,legend:[{name:'driver Vs',color:C.blue},{name:'load total',color:C.lime}]},modelTime());
}
function travelingTrace(ctx,x0,x1,y,t,amplitude,color,delay=0){
  const td=derived().td;ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2;
  for(let i=0;i<=320;i++){const q=i/320,v=sourceSignal(t-q*td-delay),x=lerp(x0,x1,q),yy=y-amplitude*v;i?ctx.lineTo(x,yy):ctx.moveTo(x,yy)}ctx.stroke();
}
function renderTLText(){
  const bp=bounceParams(),d={...bp,gammaL:bp.gl},rl=Math.abs(d.gammaL)<1e-5?99:-20*Math.log10(Math.abs(d.gammaL));
  $('tlMetrics').innerHTML=metric('Z₀ from stackup',fmt(d.z0,1)+' Ω',sev(Math.abs(d.z0-50),3,8))+metric('ΓL',fmt(d.gammaL,3),sev(Math.abs(d.gammaL),.08,.25))+metric('Return loss',rl>90?'∞ dB':fmt(rl,1)+' dB',sev(rl,20,10,true))+metric('td / tr',fmt(d.electrical,2),sev(d.electrical,.2,.5));
  $('tlInsight').innerHTML=`<span class="tag">${Math.abs(d.gammaL)<.05?'MATCHED LOAD':d.gammaL>0?'HIGH-Z LOAD':'LOW-Z LOAD'}</span><div class="big">${d.gammaL>=0?'+':''}${fmt(d.gammaL*100,1)}% voltage reflection</div><p>${d.gammaL>0?'The reflected voltage keeps the incident polarity.':d.gammaL<0?'The reflected voltage inverts because the load impedance is below Z₀.':'The load absorbs the traveling wave.'}</p><ul><li>One-way delay: <b>${fmt(d.td,3)} ns</b></li><li>Round trip: <b>${fmt(2*d.td,3)} ns</b></li><li>Current stackup: <b>${fmt(d.z0,1)} Ω</b>.</li></ul>`;
}

function drawTL(){
 const p=bounceParams(),{ctx,w,h}=prep($('tlCanvas'));ctx.clearRect(0,0,w,h);
 const x0=64,x1=w-36,top=64,bottom=h-74,base=(top+bottom)/2,scale=(bottom-top)/(8*state.voltsDiv),t=modelTime();
 for(let n=-4;n<=4;n++){const y=base-n*state.voltsDiv*scale;line(ctx,x0,y,x1,y,n===0?C.grid2:C.grid);txt(ctx,fmt(n*state.voltsDiv,2),x0-9,y+4,C.muted,11,'right');}
 const samples=Array.from({length:401},(_,i)=>wavesAt(i/400,t,p));
 ctx.save();ctx.beginPath();ctx.rect(x0,top,x1-x0,bottom-top);ctx.clip();
 for(const [key,color,width,dash] of [['inc',C.cyan,1.7,[6,4]],['ref',C.red,1.7,[3,3]],['total',C.lime,3,[]]]){
  ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);
  samples.forEach((v,i)=>{const x=lerp(x0,x1,i/400),y=base-v[key]*scale;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
 }
 ctx.restore();
 const x=lerp(x0,x1,state.probePct/100),v=wavesAt(state.probePct/100,t,p);
 line(ctx,x,top,x,bottom,C.text,1,[3,4]);
 for(const [key,color] of [['inc',C.cyan],['ref',C.red],['total',C.lime]])if(Math.abs(v[key])<=4*state.voltsDiv)glowDot(ctx,x,base-v[key]*scale,key==='total'?5:3,color);
 txt(ctx,`FORWARD →  /  ← REFLECTED`,x0,24,C.muted,12);
 txt(ctx,`t = ${fmt(t,3)} ns`,x1,44,C.text,12,'right');
 txt(ctx,'SOURCE',x0,bottom+24,C.cyan,12);txt(ctx,'LOAD',x1,bottom+24,C.red,12,'right');
 txt(ctx,`${state.lineMm} mm · Z₀ ${fmt(p.z0,1)} Ω · td ${fmt(p.td,3)} ns`,(x0+x1)/2,h-15,C.muted,12,'center');
 $('voltageSum').innerHTML=`<span>Probe ${fmt(state.probePct/100*state.lineMm,1)} mm · ${fmt(t,3)} ns</span><strong><i class="forward-value">${fmt(v.inc,3)} V</i> + <i class="reflection-value">(${fmt(v.ref,3)} V)</i> = <i class="total-value">${fmt(v.total,3)} V</i></strong><small>Forward + reflected = total at the same position and instant. ΓL ${fmt(p.gl,3)} · ${state.termMode} termination · effective load ${fmt(p.loadEff,1)} Ω${samples.some(q=>Math.abs(q.total)>4*state.voltsDiv)?' · Trace exceeds scale: increase V/div.':''}</small>`;
 receiverPlot($('tlPlot'),p);
}

function renderMatchText(){
  const d=derived();let gl=d.gammaL;
  if(state.termMode==='parallel'){const reff=1/(1/state.loadR+1/Math.max(state.termR,.001));gl=(reff-d.z0)/(reff+d.z0)}
  const gs=d.gammaS;
  $('matchMetrics').innerHTML=metric('Launch V/Vs',fmt(d.launch,3))+metric('Γsource',fmt(gs,3),sev(Math.abs(gs),.08,.25))+metric('Γload',fmt(gl,3),sev(Math.abs(gl),.08,.25))+metric('Rs effective',fmt(state.sourceR+(state.termMode==='series'?state.termR:0),0)+' Ω',state.termMode==='series'?sev(Math.abs(state.sourceR+state.termR-d.z0),3,8):'');
  $('matchCaption').textContent=state.termMode==='series'?'series source termination':state.termMode==='parallel'?'parallel load termination':'no termination';
}
function bounceParams(){
  const d=derived();let gl=d.gammaL,launch=d.launch,gs=d.gammaS;
  if(state.termMode==='parallel'){const reff=1/(1/state.loadR+1/Math.max(state.termR,.001));gl=(reff-d.z0)/(reff+d.z0);launch=d.z0/(state.sourceR+d.z0);gs=(state.sourceR-d.z0)/(state.sourceR+d.z0)}
  if(state.termMode==='none'){launch=d.z0/(state.sourceR+d.z0);gs=(state.sourceR-d.z0)/(state.sourceR+d.z0)}
  const loadEff=state.termMode==='parallel'?(state.loadR===0||state.termR===0?0:state.loadR*state.termR/(state.loadR+state.termR)):state.loadR;
  gl=(loadEff-d.z0)/(loadEff+d.z0);
  return {...d,gl,gs,launch,loadEff};
}
function drawMatch(){
  const p=bounceParams(),{ctx,w,h}=prep($('matchCanvas'));ctx.clearRect(0,0,w,h);
  const sx=w*.23,lx=w*.77,schemY=75;
  box(ctx,32,schemY-28,66,56,11,'#102538',C.grid2);txt(ctx,'DRV',65,schemY+4,C.text,10,'center',800);
  resistor(ctx,100,schemY,175,C.amber,2);txt(ctx,`${state.sourceR}Ω`,138,schemY-14,C.amber,9,'center');
  let lineStart=180;
  if(state.termMode==='series'){resistor(ctx,180,schemY,260,C.cyan,2.2);txt(ctx,`${state.termR}Ω series`,220,schemY-15,C.cyan,9,'center');lineStart=264}
  pcbTrace(ctx,lineStart,schemY,w-180,schemY,'#315a72',6);
  line(ctx,w-180,schemY,w-102,schemY,C.cyan,2);resistorV(ctx,w-142,schemY,schemY+48,C.amber,2);line(ctx,w-156,schemY+48,w-128,schemY+48,C.grid2,2);txt(ctx,`${state.loadR}Ω load`,w-142,schemY-14,C.amber,9,'center');
  box(ctx,w-102,schemY-28,66,56,11,'#102538',C.grid2);txt(ctx,'RX',w-69,schemY+4,C.text,10,'center',800);
  if(state.termMode==='parallel'){const px=w-205;line(ctx,px,schemY,px,schemY+30,C.cyan,2);resistorV(ctx,px,schemY+30,schemY+96,C.cyan,2);line(ctx,px,schemY+96,px,schemY+110,C.cyan,2);line(ctx,px-18,schemY+110,px+18,schemY+110,C.grid2,3);txt(ctx,`${state.termR}Ω shunt`,px+15,schemY+72,C.cyan,9)}
  txt(ctx,`Z₀=${fmt(p.z0,1)}Ω`,w/2,schemY+25,C.muted,9,'center');

  const top=155,bottom=h-42;line(ctx,sx,top,sx,bottom,C.grid2,2);line(ctx,lx,top,lx,bottom,C.grid2,2);txt(ctx,'SOURCE',sx,top-13,C.text,10,'center',800);txt(ctx,'LOAD',lx,top-13,C.text,10,'center',800);
  const waves=[];let amp=p.launch,from='s';
  for(let n=0;n<8;n++){const y1=top+n*(bottom-top)/8,y2=top+(n+1)*(bottom-top)/8;if(from==='s'){waves.push({x1:sx,x2:lx,y1,y2,a:amp});amp*=p.gl;from='l'}else{waves.push({x1:lx,x2:sx,y1,y2,a:amp});amp*=p.gs;from='s'}}
  const progress=modelTime()/p.td;
  waves.forEach((v,i)=>{const waveV=v.a*state.ampV*sourceSignal(modelTime()-(i+.5)*p.td),alpha=clamp(Math.abs(waveV)*1.7,.08,1),col=waveV>=0?C.cyan:C.red;ctx.save();ctx.globalAlpha=alpha;line(ctx,v.x1,v.y1,v.x2,v.y2,col,2.4+Math.abs(v.a)*1.2);ctx.restore();txt(ctx,`${v.a>=0?'+':''}${fmt(v.a,3)}`,(v.x1+v.x2)/2,(v.y1+v.y2)/2-5,col,9,'center');if(state.waveform==='step'&&progress>=i&&progress<i+1){const q=progress-i;glowDot(ctx,lerp(v.x1,v.x2,q),lerp(v.y1,v.y2,q),5+Math.abs(v.a)*3,col)}});
  txt(ctx,`ΓS=${fmt(p.gs,2)}`,sx,bottom+18,C.muted,9,'center');txt(ctx,`ΓL=${fmt(p.gl,2)}`,lx,bottom+18,C.muted,9,'center');
  receiverPlot($('matchPlot'),p);
}

function renderDiffText(){
  const d=derived(),cm=Math.max(...diffSignals().datC.map(v=>Math.abs(v[1])));
  $('diffMetrics').innerHTML=metric('Pair field coupling',fmt(d.diffCoupling*100,1)+'%')+metric('Skew delay',fmt(d.skewPs,1)+' ps',sev(d.skewPs/state.edgePs,.1,.3))+metric('Skew / tr',fmt(d.skewPs/state.edgePs,2),sev(d.skewPs/state.edgePs,.1,.3))+metric('Peak Vcm est.',fmt(cm*1000,0)+' mV',sev(cm,.04,.12));
}
function diffSignals(){
 const d=derived(),T=timeWindow()*1000,datP=[],datM=[],datD=[],datC=[];
 for(let i=0;i<1000;i++){const t=T*i/999,vp=state.diffVpp/4*sourceSignal(t/1000-d.td),vm=-state.diffVpp/4*sourceSignal((t-d.skewPs)/1000-d.td);datP.push([t,vp]);datM.push([t,vm]);datD.push([t,vp-vm]);datC.push([t,(vp+vm)/2]);}
 return {d,T,datP,datM,datD,datC,xmin:0,xmax:T};
}

function drawDiff(){
  const q=diffSignals(),{ctx,w,h}=prep($('diffCanvas'));ctx.clearRect(0,0,w,h);
  const x0=72,x1=w-150,center=h*.52,sepPx=lerp(54,210,norm(state.diffSpacing,.08,.8)),y1=center-sepPx/2,y2=center+sepPx/2;
  pcbTrace(ctx,x0,y1,x1,y1,'#315a72',8);pcbTrace(ctx,x0,y2,x1,y2,'#315a72',8);dimArrow(ctx,x0+18,y1,x0+18,y2,`${fmt(state.diffSpacing,2)} mm`,C.amber);
  for(let x=x0+45;x<x1;x+=58){const a=.06+q.d.diffCoupling*.34,curve=clamp(sepPx*.7,40,145);ctx.strokeStyle=`rgba(77,225,255,${a})`;ctx.beginPath();ctx.moveTo(x,y1+3);ctx.bezierCurveTo(x+22,y1+curve*.35,x+22,y2-curve*.35,x,y2-3);ctx.stroke();ctx.strokeStyle=`rgba(187,140,255,${a})`;ctx.beginPath();ctx.moveTo(x+15,y2-3);ctx.bezierCurveTo(x-7,y2-curve*.35,x-7,y1+curve*.35,x+15,y1+3);ctx.stroke()}
  box(ctx,x1+28,h*.27,92,h*.46,13,'#102538',C.grid2);txt(ctx,'RX',x1+74,h*.35,C.text,11,'center',800);
  const vp=state.diffVpp/4*sourceSignal(modelTime()-q.d.td),vm=-state.diffVpp/4*sourceSignal(modelTime()-q.d.td-q.d.skewPs/1000),vcm=Math.abs((vp+vm)/2),vDiff=Math.abs(vp-vm);
  const meterTop=h*.42,meterH=72;ctx.fillStyle='rgba(114,239,173,.12)';ctx.fillRect(x1+42,meterTop,18,meterH);ctx.fillStyle=C.lime;ctx.fillRect(x1+42,meterTop+meterH*(1-vDiff/1.8),18,meterH*(vDiff/1.8));
  ctx.fillStyle='rgba(255,199,95,.12)';ctx.fillRect(x1+67,meterTop,18,meterH);ctx.fillStyle=C.amber;ctx.fillRect(x1+67,meterTop+meterH*(1-clamp(vcm/.9,0,1)),18,meterH*clamp(vcm/.9,0,1));
  txt(ctx,'Vdiff',x1+51,meterTop+meterH+15,C.lime,8,'center');txt(ctx,'Vcm',x1+76,meterTop+meterH+15,C.amber,8,'center');txt(ctx,`${fmt(vDiff,2)}V`,x1+74,h*.66,C.text,10,'center',800);
  txt(ctx,`skew ${fmt(q.d.skewPs,1)} ps · tr ${state.edgePs} ps`,w/2,26,C.muted,9,'center');
  travelingTrace(ctx,x0,x1,y1,modelTime(),state.diffVpp*18,C.cyan);
  travelingTrace(ctx,x0,x1,y2,modelTime(),-state.diffVpp*18,C.purple,q.d.skewPs/1000);
  const cursor=modelTime()*1000;
  plot($('diffPlot'),[{data:q.datP,color:C.cyan},{data:q.datM,color:C.purple},{data:q.datD,color:C.lime}],{xmin:q.xmin,xmax:q.xmax,ymin:-4*state.voltsDiv,ymax:4*state.voltsDiv,xLabel:'time (ps)',yLabel:'volts',legend:[{name:'V+',color:C.cyan},{name:'V−',color:C.purple},{name:'Vdiff',color:C.lime}],zero:true},cursor);
  plot($('cmPlot'),[{data:q.datC,color:C.amber}],{xmin:q.xmin,xmax:q.xmax,ymin:-4*state.voltsDiv,ymax:4*state.voltsDiv,xLabel:'time (ps)',yLabel:'Vcm',zero:true},cursor);
}

function renderXText(){
  const d=derived(),{next,fext}=xtalkWave();
  $('xtalkMetrics').innerHTML=metric('S / H',fmt(d.sh,2),sev(d.sh,3,1.5,true))+metric('Coupling k',fmt(d.xtalkK*100,2)+'%',sev(d.xtalkK,.03,.1))+metric('NEXT est.',fmt(next*1000,0)+' mV',sev(next,.03,.1))+metric('FEXT est.',fmt(fext*1000,0)+' mV',sev(fext,.02,.08));
  $('xtalkInsight').innerHTML=`<span class="tag">CURRENT GEOMETRY</span><div class="big">S/H = ${fmt(d.sh,2)}</div><p>The plane position and trace spacing are drawn directly in the scene. Bring the plane closer or separate the traces and the shared field visibly collapses.</p><ul><li>${d.sh>3?'Spacing is comfortable in this simplified model.':'Increase spacing or bring the reference plane closer.'}</li><li>Parallel run: <b>${state.parallelMm} mm</b></li><li>Edge time: <b>${state.edgePs} ps</b></li></ul>`;
}
function xtalkAt(t){
 const d=derived(),tr=state.edgePs/1000,nextGain=state.ampV*d.xtalkK,fextGain=nextGain*clamp(state.parallelMm/120,0,.75)*.65,eps=Math.max(.0001,tr/40);
 const dv=u=>(sourceSignal(u+eps)-sourceSignal(u-eps))/(2*eps)*tr/0.8;
 const next=nextGain*dv(t),fext=-fextGain*dv(t-2*state.parallelMm/state.vpMmNs);
 return {next,fext,victim:next+fext};
}
function xtalkWave(){
 const a=[],v=[],T=timeWindow();let next=0,fext=0;
 for(let i=0;i<1000;i++){const t=T*i/999,q=xtalkAt(t);a.push([t*1000,state.ampV*sourceSignal(t)]);v.push([t*1000,q.victim]);next=Math.max(next,Math.abs(q.next));fext=Math.max(fext,Math.abs(q.fext));}
 return {a,v,xmin:0,xmax:T*1000,next,fext};
}

function drawXtalk(){
  const d=derived(),q=xtalkWave(),{ctx,w,h}=prep($('xtalkCanvas'));ctx.clearRect(0,0,w,h);
  const x0=65,x1=w-55,yA=h*.25,traceGap=lerp(48,180,norm(state.xtalkSpacing,.08,1.5)),yV=yA+traceGap,planeGap=lerp(45,145,norm(state.heightMm,.05,.5)),plane=Math.min(h-38,yV+planeGap);
  const coupledLen=lerp((x1-x0)*.18,(x1-x0)*.88,norm(state.parallelMm,5,200)),cx0=x0+(x1-x0-coupledLen)/2,cx1=cx0+coupledLen;
  pcbTrace(ctx,x0,yA,x1,yA,'#315a72',8);pcbTrace(ctx,x0,yV,x1,yV,'#315a72',8);line(ctx,45,plane,w-40,plane,'#45647b',4);
  ctx.fillStyle='rgba(255,199,95,.045)';ctx.fillRect(cx0,yA-22,coupledLen,traceGap+44);line(ctx,cx0,yA-28,cx0,yV+28,C.amber,1,[4,4]);line(ctx,cx1,yA-28,cx1,yV+28,C.amber,1,[4,4]);
  txt(ctx,'AGGRESSOR',x0,yA-18,C.cyan,9);txt(ctx,'VICTIM',x0,yV+25,C.amber,9);txt(ctx,'REFERENCE PLANE',w-45,plane+20,C.muted,9,'right');txt(ctx,`${state.parallelMm} mm parallel`,(cx0+cx1)/2,yA-31,C.amber,9,'center');
  dimArrow(ctx,x0+22,yA,x0+22,yV,`S=${fmt(state.xtalkSpacing,2)}mm`,C.amber);dimArrow(ctx,w-92,yV,w-92,plane,`H=${fmt(state.heightMm,3)}mm`,C.muted);
  const t=modelTime(),eps=.002;
  let strongest=0;
  for(let j=0;j<=20;j++){
   const x=lerp(cx0,cx1,j/20),local=t-(x-x0)/(x1-x0)*d.td;
   const slope=Math.abs(sourceSignal(local+eps)-sourceSignal(local-eps))/(2*eps);
   const activity=clamp(slope*.1*state.ampV,0,1);strongest=Math.max(strongest,activity);
   if(activity>.001)line(ctx,x,yA+4,x,yV-4,`rgba(99,213,232,${activity*clamp(d.xtalkK*5,0,.8)})`,2);
  }
  txt(ctx,`Local field activity follows dV/dt`,w/2,24,C.muted,12,'center');
  travelingTrace(ctx,x0,x1,yA,t,state.ampV*20,C.cyan);
  ctx.beginPath();ctx.strokeStyle=C.amber;ctx.lineWidth=2;
  for(let i=0;i<300;i++){const x=lerp(x0,x1,i/299),local=t-(x-x0)/(x1-x0)*d.td,y=yV-xtalkAt(local).victim*90;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.stroke();
  const cursor=modelTime()*1000;plot($('xtalkPlot'),[{data:q.a,color:C.cyan},{data:q.v,color:C.amber}],{xmin:q.xmin,xmax:q.xmax,ymin:-4*state.voltsDiv,ymax:4*state.voltsDiv,xLabel:'time (ps)',yLabel:'volts',legend:[{name:'aggressor',color:C.cyan},{name:'victim',color:C.amber}],zero:true},cursor);
}

function renderViaText(){
  const d=derived();$('viaMetrics').innerHTML=metric('λeff',fmt(d.lambda,1)+' mm')+metric('Pitch / λ',fmt(d.pitchRatio,3),sev(d.pitchRatio,.05,.1))+metric('Containment',fmt((1-d.leakage)*100,0)+'%',sev(1-d.leakage,.8,.5,true))+metric('Leakage',fmt(d.leakage*100,0)+'%',sev(d.leakage,.2,.5));
}
function drawVia(){
  const d=derived(),{ctx,w,h}=prep($('viaCanvas'));ctx.clearRect(0,0,w,h);
  const top=h*.27,bot=h*.70,vx=w*.52,gapHalf=lerp(0,92,state.planeGap),distPx=lerp(28,125,norm(state.viaDist,.3,6));
  function planeLine(y,label){if(gapHalf<2)line(ctx,45,y,w-45,y,'#42637a',5);else{line(ctx,45,y,vx-gapHalf,y,'#42637a',5);line(ctx,vx+gapHalf,y,w-45,y,'#42637a',5);txt(ctx,'PLANE GAP',vx,y-10,C.red,8,'center',800)}txt(ctx,label,48,y+(y===top?-13:20),C.muted,9)}
  planeLine(top,'L2 reference');planeLine(bot,'L5 reference');
  pcbTrace(ctx,70,top-44,vx,top-44,C.copper,7);pcbTrace(ctx,vx,top-44,vx,bot+44,C.copper,6);pcbTrace(ctx,vx,bot+44,w-80,bot+44,C.copper,7);txt(ctx,'signal via',vx+10,h*.50,C.copper,9);
  const pitchPx=lerp(24,84,norm(state.viaPitch,.5,15)),positions=[];
  if(state.fence){
    for(const dir of [-1,1]){for(let n=0;n<8;n++){const px=vx+dir*(distPx+n*pitchPx);if(px<58||px>w-58)break;positions.push(px)}}
    positions.forEach((px,i)=>{line(ctx,px,top,px,bot,'rgba(77,225,255,.55)',3);ctx.fillStyle='#7890a2';for(const yy of [top,bot]){ctx.beginPath();ctx.arc(px,yy,5,0,Math.PI*2);ctx.fill()}});
    const rvx=vx+distPx;txt(ctx,'nearest return via',rvx+8,h*.49,C.cyan,8);dimArrow(ctx,vx,top+25,rvx,top+25,`${fmt(state.viaDist,1)}mm`,C.cyan);
    if(positions.length>2){const p1=positions.filter(x=>x>vx).sort((a,b)=>a-b);if(p1.length>1)dimArrow(ctx,p1[0],bot-24,p1[1],bot-24,`${fmt(state.viaPitch,1)}mm pitch`,C.amber)}
  }
  const p=(simT%2)/2;
  if(p<.5){const q=p*2,x=lerp(70,vx,q);glowDot(ctx,x,top-44,6,C.amber);if(state.fence)glowDot(ctx,lerp(70,vx+distPx,q),top,5,C.cyan,.85)}
  else{const q=(p-.5)*2,y=lerp(top-44,bot+44,q);glowDot(ctx,vx,y,6,C.amber);if(state.fence)glowDot(ctx,vx+distPx,lerp(top,bot,q),5,C.cyan,.85)}
  if(!state.fence){const detour=85+175*d.leakage;ctx.strokeStyle=`rgba(255,111,127,${.28+d.leakage*.52})`;ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(vx,top);ctx.bezierCurveTo(vx+detour,top+25,vx+detour,bot-25,vx,bot);ctx.stroke();txt(ctx,'return-current detour',vx+detour*.72,h*.49,C.red,9,'center')}
  else{const nearest=vx+distPx;ctx.strokeStyle='rgba(77,225,255,.75)';ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(vx,top);ctx.bezierCurveTo(nearest,top+10,nearest,bot-10,vx,bot);ctx.stroke()}
  const waveSpacing=lerp(92,15,norm(state.viaFreqGHz,.5,20)),phase=(simT*.8)%1;
  for(let i=0;i<5;i++){const r=(i+phase)*waveSpacing;if(r<10||r>170)continue;ctx.save();ctx.strokeStyle=`rgba(255,111,127,${(.07+d.leakage*.28)*(1-r/190)})`;ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(vx,(top+bot)/2,r,-1.15,1.15);ctx.stroke();ctx.restore()}
  txt(ctx,`field wavelength cue: λeff ${fmt(d.lambda,1)} mm @ ${fmt(state.viaFreqGHz,1)} GHz`,w/2,24,C.muted,9,'center');txt(ctx,`${positions.length} fence vias visible`,w-55,h-18,state.fence?C.cyan:C.red,9,'right');
  const data=[];for(let pitch=.5;pitch<=15;pitch+=.15){const ratio=pitch/d.lambda,b=state.fence?clamp(1-Math.pow(clamp(ratio/.18,0,1),1.45),0,1)*Math.exp(-state.viaDist/8):0,leak=clamp((1-b)*(.22+.78*state.planeGap),0,1);data.push([pitch,(1-leak)*100])}
  plot($('viaPlot'),[{data,color:C.lime}],{xmin:.5,xmax:15,ymin:0,ymax:100,xLabel:'via pitch (mm)',yLabel:'containment %',yDigits:0},state.viaPitch);
}

function renderStackText(){
  const d=derived();$('stackMetrics').innerHTML=metric('Calculated Z₀',fmt(d.z0,1)+' Ω',sev(Math.abs(d.z0-50),3,8))+metric('Effective εr',fmt(d.ee,2))+metric('vp from εeff',fmt(d.vpGeom,0)+' mm/ns')+metric('W / H',fmt(state.widthMm/state.heightMm,2));$('z0Badge').textContent=`Z₀ = ${fmt(d.z0,1)} Ω`;
}
function drawStack(){
  const d=derived(),{ctx,w,h}=prep($('stackCanvas'));ctx.clearRect(0,0,w,h);
  const plane=h*.80,scale=Math.min(w*1.35,620),tw=clamp(state.widthMm*scale,34,w*.58),dh=clamp(state.heightMm*scale,48,h*.48),th=lerp(4,22,norm(state.copperUm,9,70)),ty=plane-dh;
  const erN=norm(state.er,2,6);ctx.fillStyle=`rgba(111,146,255,${.035+erN*.09})`;ctx.fillRect(45,55,w-90,plane-55);ctx.fillStyle='#3a5a71';ctx.fillRect(45,plane,w-90,10);ctx.fillStyle=C.copper;ctx.fillRect((w-tw)/2,ty-th,tw,th);
  const count=Math.round(11+state.er*2),spread=lerp(2.25,1.18,erN),phase=(simT%1.6)/1.6;
  for(let i=0;i<count;i++){const f=count===1?0:(i/(count-1)*2-1),alpha=.05+.22*(1-Math.abs(f))*(.7+erN*.45),xStart=w/2+f*tw*.47;ctx.strokeStyle=`rgba(77,225,255,${alpha})`;ctx.lineWidth=1.15;ctx.beginPath();ctx.moveTo(xStart,ty-th);const side=f*tw*spread,sway=Math.sin(phase*Math.PI*2+i)*3;ctx.bezierCurveTo(w/2+side*.52+sway,ty+dh*.28,w/2+side*.82-sway,plane-dh*.22,w/2+side,plane);ctx.stroke()}
  const markerX=lerp((w-tw)/2,(w+tw)/2,(simT*(d.vpGeom/140)%1));glowDot(ctx,markerX,ty-th/2,4,C.amber,.9);
  dimArrow(ctx,(w-tw)/2,ty-34,(w+tw)/2,ty-34,`W ${fmt(state.widthMm,3)} mm`,C.amber);dimArrow(ctx,75,ty,75,plane,`H ${fmt(state.heightMm,3)} mm`,C.muted);
  txt(ctx,`T ${state.copperUm} µm`,w/2,ty-th-48,C.copper,9,'center');txt(ctx,`εr ${fmt(state.er,2)} · field lines ${count}`,w-58,78,C.cyan,9,'right');txt(ctx,`vp≈${fmt(d.vpGeom,0)} mm/ns`,58,78,C.muted,9);txt(ctx,`This Z₀ feeds the transmission-line and matching labs`,w/2,h-24,C.cyan,9,'center');
  const data=[];for(let ww=.04;ww<=.7;ww+=.01)data.push([ww,microstripZ0(ww,state.heightMm,state.copperUm/1000,state.er)]);
  plot($('stackPlot'),[{data,color:C.cyan}],{xmin:.04,xmax:.7,ymin:20,ymax:130,xLabel:'trace width W (mm)',yLabel:'Z₀ (Ω)',yDigits:0},state.widthMm);
}

function renderGuide(){
  const p=bounceParams(),d={...p,gammaL:p.gl,gammaS:p.gs},items=[
    {title:'Transmission-line severity',v:d.electrical,good:.2,warn:.5,text:`td/tr = ${fmt(d.electrical,2)}. ${d.electrical>.5?'Treat routing discontinuities and terminations as first-class channel elements.':'The interconnect is electrically shorter relative to the edge, but discontinuities can still matter.'}`},
    {title:'Impedance target',v:Math.abs(d.z0-50),good:3,warn:8,text:`Current microstrip estimate is ${fmt(d.z0,1)} Ω. Width ${fmt(state.widthMm,3)} mm over ${fmt(state.heightMm,3)} mm dielectric.`},
    {title:'Differential skew',v:d.skewPs/state.edgePs,good:.1,warn:.3,text:`Skew is ${fmt(d.skewPs,1)} ps, or ${fmt(d.skewPs/state.edgePs,2)} × the edge time.`},
    {title:'Crosstalk geometry',v:d.sh,good:3,warn:1.5,invert:true,text:`S/H = ${fmt(d.sh,2)} across ${state.parallelMm} mm of parallel routing.`},
    {title:'Load reflection',v:Math.abs(d.gammaL),good:.08,warn:.25,text:`ΓL = ${fmt(d.gammaL,3)} at effective ZL ${fmt(d.loadEff,1)} Ω versus Z₀ ${fmt(d.z0,1)} Ω.`},
    {title:'Source termination',v:Math.abs(d.gammaS),good:.08,warn:.25,text:`ΓS = ${fmt(d.gammaS,3)} with effective source resistance ${state.sourceR+(state.termMode==='series'?state.termR:0)} Ω.`},
    {title:'Via fence pitch',v:d.pitchRatio,good:.05,warn:.1,text:`Pitch/λeff = ${fmt(d.pitchRatio,3)} at ${fmt(state.viaFreqGHz,1)} GHz equivalent frequency.`},
    {title:'Return-path continuity',v:d.leakage,good:.2,warn:.5,text:`Relative leakage estimate is ${fmt(d.leakage*100,0)}%. ${state.fence?'Stitching vias are enabled.':'No stitching vias are present in the current scenario.'}`}
  ];
  $('reviewGrid').innerHTML=items.map(it=>{const s=sev(it.v,it.good,it.warn,it.invert);return `<article class="card review-card"><span class="severity ${s}">${s.toUpperCase()}</span><h3>${it.title}</h3><p>${it.text}</p></article>`}).join('');
}

function renderStatic(){
  syncTime();
  $$('.live-status').forEach(el=>el.textContent=paused?'PAUSED':'RUNNING');
  renderTelemetry();renderTLText();renderMatchText();renderDiffText();renderXText();renderViaText();renderStackText();renderGuide();drawJourney();
  if(active==='tl')drawTL();else if(active==='match')drawMatch();else if(active==='diff')drawDiff();else if(active==='xtalk')drawXtalk();else if(active==='vias')drawVia();else if(active==='stackup')drawStack();
}
function frame(ts){
  const dt=Math.min(.04,(ts-lastTs)/1000);lastTs=ts;if(!paused)simT+=dt;syncTime();drawJourney();
  if(active==='tl')drawTL();else if(active==='match')drawMatch();else if(active==='diff')drawDiff();else if(active==='xtalk')drawXtalk();else if(active==='vias')drawVia();else if(active==='stackup')drawStack();
  requestAnimationFrame(frame);
}

window.addEventListener('resize',()=>requestAnimationFrame(renderStatic));
syncBindings();renderStatic();requestAnimationFrame(frame);
