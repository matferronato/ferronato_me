// No npm packages required. Run: node tests/verify_math.cjs
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const box={document:{},performance:{now:()=>0},console};vm.createContext(box);
vm.runInContext(source.slice(0,source.indexOf('function microstripModel')),box);
for(const name of ['microstripModel','microstripZ0','effectiveRisePs','derived','bounceParams','randomBit','sourceSignal','sourceDerivative','sampleCount','timeWindow','wavesAt','voltageTraces','timingInfo','diffSignals','xtalkModes','xtalkAt','xtalkWave']){
 const start=source.indexOf('function '+name+'('),next=source.indexOf('\nfunction ',start+1);assert(start>=0,name);
 vm.runInContext(source.slice(start,next),box);
}
box.check=(condition,message)=>assert(condition,message);box.near=(a,b,tol=1e-8)=>assert(Math.abs(a-b)<=tol,`${a} != ${b}`);
const cases=[];for(const w of [.05,.15,.5])for(const h of [.05,.12,.5])for(const t of [0,.035,.07])for(const er of [1,2,4.1,6])cases.push([w,h,t,er]);
box.cases=cases;
vm.runInContext(`
let checks=0;const reset=(extra={})=>Object.assign(state,defaults,extra);
for(const args of cases){const m=microstripModel(...args);check(Number.isFinite(m.z0)&&m.z0>0,'positive impedance');check(m.ee>=1-1e-10&&m.ee<=args[3]+1e-10,'permittivity bounds');near(m.vp,299.792458/Math.sqrt(m.ee));checks+=3;}
for(const er of [1,2,4.1,6])for(const h of [.05,.12,.5]){check(microstripZ0(.1,h,.009,er)>microstripZ0(.2,h,.009,er),'width monotonic');checks++;}
near(microstripModel(1,1,0,1).ee,1);near(microstripModel(1,1,0,1).vp,299.792458);
reset();const v0=derived().vp;state.er=6;check(derived().vp<v0,'geometry dielectric delay');state.velocityMode='manual';state.vpMmNs=170;near(derived().vp,170);checks+=3;
for(const shape of ['step','sine','square','triangle','random']){
 reset({waveform:shape,velocityMode:'manual',edgePs:100});
 for(let t=-.1;t<8;t+=.017){const v=sourceSignal(t);check(Number.isFinite(v)&&Math.abs(v)<=1+1e-10,'waveform bound');checks++;}
 if(['step','sine','triangle'].includes(shape))for(const t of [.023,.123,.437])near(sourceDerivative(t),(sourceSignal(t+1e-7)-sourceSignal(t-1e-7))/2e-7,1e-5);
}
reset({waveform:'step',edgePs:300});near(sourceSignal(.1*.3/.8),.1);near(sourceSignal(.9*.3/.8),.9);
for(const shape of ['square','random']){reset({waveform:shape,edgePs:2000,freqMHz:2000});const slot=shape==='square'?.25:.5;for(let i=1;i<50;i++){check(Math.abs(sourceSignal(i*slot+1e-8)-sourceSignal(i*slot-1e-8))<1e-6,'edge continuity');checks++;}}
for(const mode of ['none','series','parallel'])for(const shape of ['step','sine','square','triangle','random'])for(const rl of [0,25,50,200]){
 reset({termMode:mode,waveform:shape,loadR:rl,velocityMode:'manual'});const p=bounceParams();
 for(const t of [.11,.97,2.83,9.27,23.19]){
  const a=wavesAt(0,t,p),b=wavesAt(1,t,p);
  near(a.total+p.srcEff*(a.inc-a.ref)/p.z0,state.ampV*sourceSignal(t),1e-7);
  near(b.total,p.loadEff*(b.inc-b.ref)/p.z0,1e-7);near(b.ref,p.gl*b.inc,1e-7);checks+=3;
 }
}
reset({waveform:'step',edgePs:50});const fixture={z0:50,td:1,launch:.5,gs:0,gl:.5};
near(wavesAt(1,1.5,fixture).total,.75);near(wavesAt(1,1.5,fixture).inc,.5);near(wavesAt(1,1.5,fixture).ref,.25);
for(const rs of [10,50,100])for(const rl of [25,50,200]){const p={z0:50,td:1,launch:50/(50+rs),gs:(rs-50)/(rs+50),gl:(rl-50)/(rl+50)};near(wavesAt(1,200,p).total,rl/(rs+rl),1e-7);checks++;}
for(const rl of [10,25,50,100,200]){const vi=.7,vr=vi*(rl-50)/(rl+50),vl=vi+vr;near((vi*vi-vr*vr)/50,vl*vl/rl);checks++;}
reset({waveform:'sine',freqMHz:250,probePct:50});near(timingInfo(fixture).forward,.5);near(timingInfo(fixture).firstReflection,1.5);near(timingInfo(fixture).loadPhase,-90);
for(const gs of [-.7,0,.7]){const p={...fixture,gs},q=timingInfo(p);let si=0,co=0;for(let i=0;i<2000;i++){const t=80+16*i/2000,v=wavesAt(1,t,p).total;si+=v*Math.sin(2*Math.PI*.25*t)/1000;co+=v*Math.cos(2*Math.PI*.25*t)/1000;}near(Math.atan2(co,si)*180/Math.PI,q.loadPhase,1e-5);near(Math.hypot(si,co),q.loadGain,1e-6);checks+=2;}
for(const shape of ['step','sine','square','triangle','random']){
 reset({waveform:shape,skewMm:0});let q=diffSignals();for(let i=0;i<q.datC.length;i+=31){near(q.datC[i][1],0);near(q.datD[i][1],q.datP[i][1]-q.datM[i][1]);checks+=2;}
 state.skewMm=10;q=diffSignals();for(let i=0;i<q.datC.length;i+=31){near(q.datC[i][1],(q.datP[i][1]+q.datM[i][1])/2);checks++;}
}
reset({waveform:'sine',windowNs:24,skewMm:0});let dif=diffSignals().datD.map(p=>p[1]);near(Math.max(...dif)-Math.min(...dif),state.diffVpp,1e-4);
for(const shape of ['step','sine','square','triangle','random']){
 reset({waveform:shape,kC:0,kL:0});for(const t of [.1,1,3,10]){const v=xtalkAt(t);near(v.next,0);near(v.fext,0);checks+=2;}
 state.kC=.06;state.kL=.06;for(let t=0;t<10;t+=.137){near(xtalkAt(t).fext,0,1e-9);checks++;}
}
reset({waveform:'step',kC:.06,kL:.04});const modes=xtalkModes();
for(const t of [.1,1,3,10]){
 for(const x of [0,1]){
 const e=wavesAt(x,t,modes.even),o=wavesAt(x,t,modes.odd),va=e.total+o.total,vb=e.total-o.total,ia=(e.inc-e.ref)/modes.even.z0+(o.inc-o.ref)/modes.odd.z0,ib=(e.inc-e.ref)/modes.even.z0-(o.inc-o.ref)/modes.odd.z0,Z=derived().z0;
 if(x===0){near(va+Z*ia,2*state.ampV*sourceSignal(t),1e-7);near(vb+Z*ib,0,1e-7);}else{near(va-Z*ia,0,1e-7);near(vb-Z*ib,0,1e-7);}checks+=2;
 }
}
near(xtalkAt(-1).next,0);near(xtalkAt(-1).fext,0);near(xtalkAt(100).next,0,1e-8);near(xtalkAt(100).fext,0,1e-8);
reset({er:4,viaFreqGHz:5});near(derived().lambda,29.9792458);const l=derived().lambda;state.viaFreqGHz=10;near(derived().lambda,l/2);checks+=2;
for(const bad of [[0,1,0,4],[1,0,0,4],[1,1,-1,4],[1,1,0,.5]]){let thrown=false;try{microstripModel(...bad)}catch{thrown=true}check(thrown,'invalid domain rejected');checks++;}
console.log('PASS: '+checks+' mathematical checks plus reference fixtures.');
`,box);
console.log(`PASS: ${cases.length} browser microstrip model cases exercised.`);
