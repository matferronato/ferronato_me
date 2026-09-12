import {burstAddress} from './protocols.mjs';
export function checkBurst(base,size,len,type,width=4){
 const errors=[],bytes=2**size;
 if(!Number.isSafeInteger(base)||base<0||base>0xffffffff)errors.push('Enter a valid 32-bit unsigned start address.');
 if(!Number.isInteger(len)||len<1||len>256)errors.push('Length must be 1–256 beats.');
 if(bytes>width)errors.push('Transfer size cannot exceed the data bus width.');
 if(type==='WRAP'&&![2,4,8,16].includes(len))errors.push('WRAP requires 2, 4, 8 or 16 beats.');
 if(type==='WRAP'&&base%bytes)errors.push('WRAP start address must align to the beat size.');
 if(type==='FIXED'&&len>16)errors.push('AXI4 FIXED allows at most 16 beats.');
 if(errors.length)return{errors,addresses:[]};
 const addresses=Array.from({length:len},(_,i)=>burstAddress(base,i,size,type,len));
 // Aligned end of each transfer; an unaligned first beat uses only remaining lanes.
 if(addresses.some(a=>Math.floor(a/4096)!==Math.floor(base/4096)||Math.floor((Math.floor(a/bytes)*bytes+bytes-1)/4096)!==Math.floor(base/4096)))errors.push('Burst crosses a 4 KiB address boundary. Split it into separate transactions.');
 if(addresses.some(a=>a>0xffffffff))errors.push('Address exceeds this 32-bit address space.');
 return{errors,addresses,bytes,payload:addresses.reduce((n,a)=>n+bytes-a%bytes,0)};
}
const $=s=>document.querySelector(s);
function init(){
 $('#view-address').innerHTML=`<header class="lab-heading"><div><p class="eyebrow">AXI4 ADDRESS ENGINE</p><h2>Decode the burst before it hits memory.</h2><p>Explore INCR, FIXED and WRAP addressing, byte lanes and the 4 KiB rule.</p></div></header><div class="lab-layout"><aside class="lab-controls"><label>Start address (hex)<input id="a-base" value="0x100C" spellcheck="false"></label><label>Burst type<select id="a-type"><option>INCR</option><option>WRAP</option><option>FIXED</option></select></label><label>AxLEN (beats minus 1)<input id="a-len" type="number" min="0" max="255" value="3"></label><label>AxSIZE<select id="a-size"><option value="0">0 · 1 byte</option><option value="1">1 · 2 bytes</option><option value="2" selected>2 · 4 bytes</option><option value="3">3 · 8 bytes</option></select></label><label>Data bus width<select id="a-width"><option value="4">32 bits</option><option value="8">64 bits</option><option value="16">128 bits</option></select></label><button class="chip" id="wrapExample">Critical word first WRAP</button><button class="chip" id="boundaryExample">Cross a 4 KiB boundary</button></aside><div class="lab-results"><div class="lab-notice" id="addressStatus" aria-live="polite"></div><div class="stat-grid" id="addressStats"></div><div class="address-scroll"><table class="lab-table"><thead><tr><th>Beat</th><th>Address</th><th>Eligible byte lanes</th><th>Last</th></tr></thead><tbody id="addressRows"></tbody></table></div><p class="fieldnote">Eligible lanes show the maximum bytes for each transfer. WSTRB can select a subset on writes. For an unaligned INCR start, only the first beat is partial; following addresses align to the transfer size. FIXED repeats the same lanes.</p></div></div><div class="lesson-grid"><article><h3>INCR</h3><p>The first transfer uses the start address. Subsequent addresses increment from its transfer-size-aligned base. Length: 1–256 beats.</p><code>Aᵢ = floor(A₀/B)B + iB, i &gt; 0</code></article><article><h3>WRAP</h3><p>Beat-aligned starts are required, but the start need not be aligned to the complete wrap region. Length: 2, 4, 8 or 16 beats.</p><code>L = floor(A₀/(B×N)) × B×N</code><p>The address wraps within [L, L + B×N).</p></article><article><h3>FIXED</h3><p>Every beat uses the same address, useful for a FIFO register. Length: 1–16 beats. Payload may advance while the address stays constant.</p><code>Aᵢ = A₀</code></article><article><h3>Transaction boundary</h3><p>No AXI burst may cross a 4 KiB boundary. Bus width and transfer size are distinct; a 64-bit bus may carry 4-byte transfers on selected lanes.</p><p><a href="https://developer.arm.com/documentation/ihi0022/latest" target="_blank" rel="noreferrer">Arm AMBA AXI specification</a></p></article></div>`;
 ['base','type','len','size','width'].forEach(id=>$('#a-'+id).addEventListener('input',addressRender));
 $('#wrapExample').onclick=()=>{$('#a-base').value='0x100C';$('#a-type').value='WRAP';$('#a-len').value=3;$('#a-size').value=2;addressRender()};
 $('#boundaryExample').onclick=()=>{$('#a-base').value='0x0FFC';$('#a-type').value='INCR';$('#a-len').value=3;$('#a-size').value=2;addressRender()};addressRender();
 window.addEventListener('busdocument',e=>metrics(e.detail));
}
function addressRender(){
 const raw=$('#a-base').value.trim();const base=/^(0x)?[0-9a-f]+$/i.test(raw)?parseInt(raw.replace(/^0x/i,''),16):NaN;
 const n=+$('#a-len').value+1,size=+$('#a-size').value,type=$('#a-type').value,width=+$('#a-width').value;
 const r=checkBurst(base,size,n,type,width);
 $('#addressStatus').textContent=r.errors.length?r.errors.join(' '):'Legal burst for the selected address, size, length and bus width.';
 $('#addressStatus').dataset.bad=String(!!r.errors.length);
 $('#addressStats').innerHTML=[['Beats',n],['Bytes per transfer',2**size],['Maximum payload',r.payload===undefined?'—':r.payload+' B']].map(([k,v])=>`<article><small>${k}</small><strong>${v}</strong></article>`).join('');
 $('#addressRows').innerHTML=r.addresses.map((a,i)=>{const end=Math.floor(a/(2**size))*2**size+2**size;const lanes=Array.from({length:width},(_,l)=>`<span class="lane ${l>=a%width&&l<(end-1)%width+1?'active':''}">${l}</span>`).join('');return`<tr><td>${i}</td><td><code>0x${a.toString(16).toUpperCase().padStart(8,'0')}</code></td><td>${lanes}</td><td>${i===n-1?'LAST':'—'}</td></tr>`}).join('');
}
function metrics({doc,state}){
 const serial=['i2c','spi'].includes(doc.id),active=doc.frames.length-2;
 const dataMarks=doc.markers.filter(m=>/^beat|^transfer$|terminated|write accepted|read data/i.test(m.text));
 const beats=dataMarks.length;
 $('#transactionStats').innerHTML=serial?`<p>Serial view: columns include bus conditions as well as clock periods. Use sampling markers to inspect each bit; column count is not a physical bitrate measurement.</p>`:[['Active scenario cycles',active],['Data beats accepted',beats],['Scenario data occupancy',active?`${(100*beats/active).toFixed(1)}%`:'—'],['32-bit payload / cycle',active?`${(4*beats/active).toFixed(2)} B`:'—']].map(([k,v])=>`<article><small>${k}</small><strong>${v}</strong></article>`).join('');
 $('#scenarioNote').textContent=serial?'SPI shows sampling edges, with bit values summarized per clock period. I2C high means release to a pull-up, never an actively driven high.':'Metrics include request/response/latency cycles between the outer idle frames, for this generated scenario. They are not protocol peak throughput. All displayed parallel data transfers are 32-bit.';
}
if(typeof document!=='undefined')init();
