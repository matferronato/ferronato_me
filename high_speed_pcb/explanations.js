/* Contextual teaching notes: updated on parameter changes, never on animation frames. */
const labLessons = {
 tl: {
  scene: 'The upper view is a snapshot of voltage along the trace. The lower plot follows voltage over time. A wave takes one flight time to reach the load; its reflection needs another flight to return to the source. All traces use the same time origin.',
  read: 'Driver is the ideal generator voltage before the source resistance. Forward and reflected are traveling voltage components at the selected probe; sum is their point-by-point addition. Load is measured at the receiver. At a 100% probe, sum and load coincide. Reflected and forward can be in phase at the load for a positive, purely resistive reflection; moving the probe separates their travel times.',
  try: 'Select a step and move the probe to Source. Increase channel length: the first returning reflection arrives later. Then increase load resistance: a more positive reflection raises load voltage. Increasing source resistance instead reduces the initial launched voltage.',
  limits: 'Lossless uniform line with resistive source and load. No conductor loss, dielectric dispersion, receiver capacitance or frequency-dependent impedance.'
 },
 match: {
  scene: 'The bounce diagram tracks successive trips between source and receiver. Time runs downward. Labels are voltage gain relative to the generator, not instantaneous volts. The scope adds all arrivals at their actual times.',
  read: 'Series termination adds R at the driver: the effective source resistance is driver R + termination R. The receiver load still connects from the far-end node to return; it does not move into series with the trace. Parallel termination instead places termination R across the receiver load. Source matching absorbs returning waves; load matching prevents a load reflection.',
  try: 'Choose Series and set driver R + termination R close to Z₀. Compare the first load arrival and later settling. Switch to Parallel and observe how the lower effective load changes both reflection polarity and the final voltage.',
  limits: 'A finite resistive receiver is modeled, not a high-impedance CMOS input with capacitance. A matched source does not guarantee the load sees the full generator voltage.'
 },
 diff: {
  scene: 'Two opposite-polarity signals travel along the pair. Length mismatch delays the negative conductor relative to the positive one. The plot compares both conductors and their differential and common-mode combinations.',
  read: 'Differential voltage is Vp − Vn. Common-mode voltage is (Vp + Vn)/2. Equal and opposite arrivals cancel in common mode. Skew breaks that cancellation during transitions. Differential Vpp is the full bipolar differential swing; a step reaches half that value.',
  try: 'Start with zero mismatch, then increase mismatch while watching common mode. Make the edge slower and compare skew / rise time. Changing pair spacing changes the field sketch, not the electrical waveforms in this ideal skew model.',
  limits: 'Ideal delayed signals only. Pair spacing does not extract differential impedance, coupling, loss or mode conversion from an electromagnetic solver.'
 },
 xtalk: {
  scene: 'An aggressor excites even and odd modes in a uniform coupled section. The victim voltage comes from the difference between those modal responses. NEXT is observed at the near end; FEXT at the far end.',
  read: 'NEXT and FEXT are voltages at different locations and must not be added as one local voltage. kC and kL are explicit assumed coupling ratios. Equal kC and kL produce equal modal velocities and cancel FEXT in this model. The amplitude control is nominal incident A; the matched-source generator is 2A.',
  try: 'Set both coupling ratios to zero, then increase them together. Next change only one ratio to create modal delay mismatch and FEXT. Increase parallel length to see modal transit times change.',
  limits: 'Lossless modal calculation with Z₀ terminations on each conductor. Spacing changes the sketch; kC/kL are not extracted from spacing. Plane height changes the shared stackup and derived velocity, but does not automatically recalculate coupling ratios.'
 },
 vias: {
  scene: 'The drawing shows a layer transition, nearby return vias and a reference-plane opening. The field animation is an illustration of return-path geometry.',
  read: 'Wavelength is calculated as c / (frequency × √εr) in bulk dielectric. Pitch / wavelength compares fence spacing with that wavelength. These are geometric reference quantities, not a measured attenuation or containment percentage.',
  try: 'Toggle the fence, vary its distance, and open the reference plane. Compare the illustrated return path. Increase frequency and observe wavelength shrink while pitch / wavelength grows.',
  limits: 'No via inductance, stub resonance, radiation or S-parameter solver. Fence distance and the plane opening change the illustration, not a quantitative leakage prediction.'
 },
 stackup: {
  scene: 'The cross section shows a microstrip conductor over a reference plane. The impedance calculation uses trace width, dielectric height, copper thickness and relative permittivity.',
  read: 'Z₀ is characteristic impedance, not DC resistance. Effective permittivity accounts for the microstrip field in both air and dielectric. Propagation speed is c / √εeff; channel flight time is length / speed. Other labs share this geometry.',
  try: 'Increase width while keeping height fixed and observe Z₀ decrease. Increase height and compare. Increase εr and observe the calculated speed decrease. Check whether the transmission-line lab is using the stackup speed or a manual override.',
  limits: 'Quasi-static Hammerstad–Jensen microstrip approximation with thickness correction. No solder mask, frequency dispersion, roughness, loss or manufacturing tolerances.'
 },
 guide: {
  scene: 'This screen collects the shared channel settings into review questions. Each card reports a calculated quantity and compares it with an educational threshold.',
  read: 'A favorable card means its heuristic is satisfied, not that a real board passes compliance. Read the quantities together: electrical length, mismatch, skew and return-path geometry describe different mechanisms.',
  try: 'Change one parameter in its lab, then return here to see which review cards respond. Follow the workflow from stackup through interfaces and return paths before checking coupling and measurements.',
  limits: 'No independent controls on this screen. Thresholds are teaching aids, not interface specifications or a complete channel signoff.'
 }
};
const controlLessons = {
 waveform: ['Excitation', 'Step is a single transition; sine, square and triangle repeat; random NRZ is a repeatable bit sequence. All begin at the shared time origin.'],
 freqMHz: ['Frequency / bit rate', 'Sets cycles per second for periodic signals, or Mbit/s for random NRZ. Disabled for a single step. More cycles fit in the same time span at a higher rate.'],
 ampV: ['Amplitude', 'Sets generator peak voltage in transmission/matching, or nominal incident amplitude in crosstalk. Step is 0 → A; bipolar signals are ±A.'],
 windowNs: ['Span', 'Changes the displayed time window, not propagation speed or excitation frequency.'],
 voltsDiv: ['Scale', 'Changes volts per vertical division. A clipped trace needs a larger V/div; this does not change its actual voltage.'],
 probePct: ['Voltage probe', 'Moves the forward/reflected/sum measurement from source (0%) to load (100%). Load voltage remains measured at the receiver.'],
 lineMm: ['Channel length', 'Sets one-way delay as length / propagation speed. Longer lines delay arrivals and change periodic phase.'],
 loadR: ['Load resistance', 'Sets the far-end resistive load. Above Z₀ the load reflection is positive; below Z₀ it is negative. Parallel termination modifies the effective load.'],
 edgePs: ['Edge time', 'Controls transition slew for step, square and random signals. Sine and triangle derive their rise time from frequency, so this control is disabled for them.'],
 velocityMode: ['Velocity model', 'Choose the stackup-derived speed or an explicit manual override.'],
 vpMmNs: ['Propagation velocity', 'Manual speed in mm/ns. Increasing speed reduces all flight times; editable only in Manual override mode.'],
 sourceR: ['Driver output R', 'Sets source impedance. Higher source R reduces the initial launch and changes the source reflection coefficient.'],
 termR: ['Termination R', 'Added to driver R in Series mode; placed across load R in Parallel mode; unused in None mode.'],
 diffVpp: ['Differential Vpp', 'Sets full bipolar differential peak-to-peak swing. Each balanced conductor has peak Vpp/4; the differential step excursion is Vpp/2.'],
 diffSpacing: ['Pair spacing', 'Changes conductor separation and illustrative field overlap. Does not change electrical coupling in the ideal skew calculation.'],
 skewMm: ['Length mismatch', 'Adds negative-conductor delay equal to mismatch / speed. Larger skew creates greater common-mode imbalance around transitions.'],
 xtalkSpacing: ['Trace spacing', 'Moves the victim in the sketch and changes spacing/height. Coupling ratios remain explicitly supplied.'],
 heightMm: ['Plane height H', 'Changes dielectric height, microstrip impedance and stackup-derived speed. Also moves the reference plane in the geometry views.'],
 parallelMm: ['Parallel length', 'Sets coupled-section even/odd flight times. Longer overlap changes the duration and timing of crosstalk responses.'],
 kC: ['Capacitive coupling kC', 'Assumed mutual/self capacitance ratio; changes even/odd impedances and transit times.'],
 kL: ['Inductive coupling kL', 'Assumed mutual/self inductance ratio; changes even/odd impedances and transit times.'],
 viaPitch: ['Fence pitch', 'Sets spacing between return vias and the pitch/wavelength ratio.'],
 viaDist: ['Fence distance', 'Moves return vias relative to the signal transition in the illustration.'],
 viaFreqGHz: ['Equivalent frequency', 'Sets the bulk-dielectric wavelength reference. Independent of the signal-generator frequency in other labs.'],
 planeGap: ['Plane discontinuity', 'Dimensionless 0–1 visual opening control; not a gap size in millimeters or a solved electrical discontinuity.'],
 widthMm: ['Trace width W', 'Wider microstrip generally lowers characteristic impedance for fixed height and material.'],
 copperUm: ['Copper thickness T', 'Sets finite conductor thickness for the impedance correction and cross-section drawing.'],
 er: ['Dielectric εr', 'Relative permittivity affects impedance, effective permittivity and propagation speed. Also used for the via wavelength reference.']
};
function currentLesson(id) {
 const d=derived(), f=(v,n=2)=>Number(v).toFixed(n);
 switch(id){
 case 'tl': return `One-way flight: ${f(d.td,3)} ns. Load reflection ΓL = ${f(d.gammaL,3)}; source reflection ΓS = ${f(d.gammaS,3)}. At this ${state.probePct}% probe, first forward arrival is ${f(d.td*state.probePct/100,3)} ns and first load-reflected arrival is ${f(d.td*(2-state.probePct/100),3)} ns. These are causal arrival times, not a phase measurement.`;
 case 'match': return `${state.termMode} termination: effective source ${f(d.srcEff)} Ω; effective load ${f(d.loadEff)} Ω; line Z₀ ${f(d.z0)} Ω. Initial launch factor Z₀/(Rs + Z₀) = ${f(d.z0/(d.srcEff+d.z0),3)}. Load reflection ΓL = ${f(d.gammaL,3)} and source reflection ΓS = ${f(d.gammaS,3)}.`;
 case 'diff': return `Mismatch ${f(state.skewMm)} mm creates ${f(d.skewPs,1)} ps skew, or ${f(d.skewPs/d.risePs,3)} × rise time. Requested differential swing is ${f(state.diffVpp)} Vpp; the step excursion is ${f(state.diffVpp/2)} V.`;
 case 'xtalk': {const m=xtalkModes();return `Assumed kC = ${f(state.kC,3)}, kL = ${f(state.kL,3)}. Even-mode flight ${f(m.even.td,4)} ns; odd-mode flight ${f(m.odd.td,4)} ns. Spacing/height = ${f(d.sh)}. The two coupling coefficients are inputs, not geometry-derived results.`;}
 case 'vias': return `At ${f(state.viaFreqGHz,1)} GHz and εr = ${f(state.er)}, bulk wavelength is ${f(d.lambda)} mm. Fence pitch / wavelength = ${f(d.pitchRatio,3)}. Fence is ${state.fence?'enabled':'disabled'}; no leakage or attenuation value is predicted.`;
 case 'stackup': return `Z₀ = ${f(d.z0)} Ω; εeff = ${f(d.ee,3)}; geometry-derived velocity = ${f(d.vpGeom)} mm/ns. Active channel velocity = ${f(d.vp)} mm/ns (${state.velocityMode==='manual'?'manual override':'from stackup'}), giving ${f(d.td,3)} ns one-way delay.`;
 case 'guide': return `Shared channel: ${f(state.lineMm,0)} mm, ${f(d.z0)} Ω, ${f(d.td,3)} ns one-way delay. Flight time / rise time = ${f(d.electrical)}; differential skew / rise time = ${f(d.skewPs/d.risePs,3)}. Inspect each card’s explanation before applying its threshold.`;
 }
}
for(const section of document.querySelectorAll('.lab-section')) {
 const lesson=labLessons[section.id];if(!lesson)continue;
 const details=document.createElement('details');details.className='lab-explanation';
 const summary=document.createElement('summary');summary.textContent='Understand this lab';
 const hint=document.createElement('span');hint.textContent='What you see · controls · results';summary.append(hint);
 const body=document.createElement('div');body.className='lesson-body';body.tabIndex=0;body.setAttribute('aria-label','Lab explanation');
 function paragraph(title,text){const item=document.createElement('div'),h=document.createElement('h3'),p=document.createElement('p');h.textContent=title;p.textContent=text;item.append(h,p);body.append(item);return p;}
 paragraph('What is happening',lesson.scene);paragraph('Read the results',lesson.read);
 const current=paragraph('With your current settings','');current.dataset.lessonResult=section.id;
 paragraph('Try this',lesson.try);
 const controls=document.createElement('div');controls.className='lesson-controls';const heading=document.createElement('h3');heading.textContent='What each control does';controls.append(heading);
 const list=document.createElement('dl');
 const keys=[...new Set([...section.querySelectorAll('[data-bind]')].map(el=>el.dataset.bind))];
 const rows=keys.map(key=>controlLessons[key]);
 if(section.id==='match')rows.push(['Topology / probe shortcuts','None, Series and Parallel select the resistor connection. Source, Midpoint and Load move the probe. Phase example loads a preset so travel delay is easier to see.']);
 if(section.id==='vias')rows.push(['Via fence','Toggles return-via geometry; no numeric shielding effectiveness is calculated.']);
 if(section.querySelector('[data-scrub]'))rows.push(['Time / Replay','Scrub to inspect a shared simulation instant. Replay restarts the time cursor without changing parameters.']);
 if(section.id!=='guide')rows.push(['Trace checkboxes','Show or hide individual plotted voltages. Hiding a component does not remove it from the physical calculation.']);
 rows.push(['Shared settings / Pause / Reset','Settings carry between labs. Pause freezes animation; Reset restores the app defaults. Theme changes only appearance.']);
 for(const row of rows){if(!row)throw new Error(`Missing control explanation in ${section.id}`);const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=row[0];dd.textContent=row[1];list.append(dt,dd);}
 controls.append(list);body.append(controls);paragraph('Model boundaries',lesson.limits);
 details.append(summary,body);section.append(details);
 details.addEventListener('toggle',()=>{if(details.open)updateLabExplanations();requestAnimationFrame(renderStatic);});
}
function updateLabExplanations(){document.querySelectorAll('[data-lesson-result]').forEach(el=>{el.textContent=currentLesson(el.dataset.lessonResult);});}
updateLabExplanations();
