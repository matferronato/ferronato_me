// Execution/finite-coordinate checks only; this is not browser visual QA.
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert');
const g={addColorStop(){}};const finite=(...a)=>{for(const v of a)if(typeof v==='number')assert(Number.isFinite(v),'nonfinite canvas value')};
const ctx=new Proxy({createLinearGradient:()=>g,createRadialGradient:()=>g,measureText:s=>({width:s.length*6}),moveTo:finite,lineTo:finite,arc:finite,fillRect:finite,setTransform:finite},{get:(o,k)=>o[k]||(()=>{})});
function node(tag='div',id=''){return {id,tagName:tag.toUpperCase(),dataset:{},children:[],width:1200,height:600,style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},setAttribute(){},addEventListener(k,fn){this['on'+k]=fn},append(...v){this.children.push(...v)},before(){},after(){},closest:()=>null,querySelector:()=>null,querySelectorAll:()=>[],getBoundingClientRect:()=>({width:800,height:340}),getContext:()=>ctx};}
const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,node('canvas',id));return elements.get(id)};
const box={document:{documentElement:{dataset:{}},getElementById:get,querySelectorAll:()=>[],createElement:node,createTextNode:text=>({text})},window:{addEventListener(){},matchMedia:()=>({matches:true})},performance:{now:()=>0},devicePixelRatio:1,requestAnimationFrame(){},fetch:()=>Promise.reject(),setTimeout,clearTimeout,console};
vm.createContext(box);vm.runInContext(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),box);
vm.runInContext(`
let renders=0;for(const velocityMode of ['geometry','manual'])for(const waveform of ['step','sine','square','triangle','random'])for(const termMode of ['none','series','parallel']){
 Object.assign(state,defaults,{velocityMode,waveform,termMode});simT=3;
 for(const lab of ['tl','match','diff','xtalk','vias','stackup','guide']){active=lab;renderStatic();renders++;}
}
Object.assign(state,defaults,{waveform:'square',edgePs:50,freqMHz:2000,windowNs:80,lineMm:20});for(const lab of ['tl','diff','xtalk']){active=lab;renderStatic();renders++;}
console.log('PASS: '+renders+' render executions with finite canvas coordinates.');
`,box);
for(const id of ['tlCanvas','tlPlot','matchPlot','diffPlot','cmPlot','xtalkPlot','viaPlot','stackPlot']){
 const labels=get(id)._traceControls.children.slice(1);assert(labels.length>0,id);
 for(const label of labels){const c=label.children[0];c.checked=false;c.onchange();assert.equal(vm.runInContext(`traceOn('${id}','${c.dataset.traceKey}')`,box),false);c.checked=true;c.onchange();}
}
console.log('PASS: trace controls on all eight numeric plots.');
// Exercise the teaching drawers against the actual control inventory.
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const sections=[...html.matchAll(/<section id="([^"]+)" class="lab-section[^\"]*">([\s\S]*?)<\/section>/g)].map(([,id,markup])=>{
 const s=node('section',id);s.querySelectorAll=sel=>sel==='[data-bind]'?[...markup.matchAll(/data-bind="([^"]+)"/g)].map(m=>({dataset:{bind:m[1]}})):[];
 s.querySelector=sel=>sel==='[data-scrub]'&&markup.includes('data-scrub')?node():null;return s;
});
const descendants=n=>[n,...n.children.flatMap(c=>typeof c==='object'&&c.children?descendants(c):[])];
box.document.querySelectorAll=sel=>sel==='.lab-section'?sections:sel==='[data-lesson-result]'?sections.flatMap(descendants).filter(n=>n.dataset.lessonResult):[];
vm.runInContext(fs.readFileSync(path.join(__dirname,'../explanations.js'),'utf8'),box);
assert.equal(sections.length,7);
for(const s of sections){assert.equal(s.children[0].tagName,'DETAILS');assert(!s.children[0].open);}
for(const waveform of ['step','sine','random']){vm.runInContext(`state.waveform='${waveform}';renderStatic()`,box);for(const n of box.document.querySelectorAll('[data-lesson-result]'))assert(n.textContent.length>50&&!/NaN|undefined/.test(n.textContent),n.dataset.lessonResult);}
console.log('PASS: seven collapsed teaching drawers, full bound-control coverage and dynamic result text.');
