// Keep the measurements visible; supporting explanations remain available in dialogs.
function panel(title, content) {
  const dialog = document.createElement('dialog');
  dialog.className = 'help-panel';
  const header = document.createElement('div');
  header.className = 'help-panel-head';
  const heading = document.createElement('h2'); heading.textContent = title;
  const close = document.createElement('button'); close.className = 'tool-btn'; close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  header.append(heading, close); dialog.append(header, ...content); document.body.append(dialog);
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r=dialog.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close(); } });
  return dialog;
}
document.querySelectorAll('.lab-section').forEach(section => {
  const stage = section.querySelector('.stage-instrument');
  if (!stage) return;
  const dock = section.querySelector('.control-dock');
  const heading = section.querySelector('.lab-heading');
  const title = heading.querySelector('h1').textContent;
  const explanations = [heading, ...section.querySelectorAll('.insight')];
  const generator = stage.querySelector('.signal-generator');
  if (generator) {
    const note = generator.querySelector('p'); if(note)explanations.push(note);
    dock.querySelector('.dock-head').after(generator);
  }
  const time = stage.querySelector('.time-controls') || document.createElement('div');
  time.classList.add('lab-toolbar');
  const help = document.createElement('button'); help.className='tool-btn'; help.textContent='Lab notes';
  const dialog=panel(title, explanations);
  help.addEventListener('click',()=>dialog.showModal());
  time.append(help);
  section.prepend(time);
  const probe=stage.querySelector('.probe-control');if(probe)dock.querySelector('.metrics').before(probe);
  const sum=stage.querySelector('.voltage-sum');if(sum)stage.append(sum);
  stage.querySelector('.change-readout').classList.add('compact-observation');
  section.classList.add('screen-lab');
});
const overview=document.querySelector('.channel-strip');
const overviewDialog=panel('Shared channel overview',[overview]);
const overviewButton=document.createElement('button');overviewButton.className='tool-btn';overviewButton.textContent='System';
overviewButton.addEventListener('click',()=>{overviewDialog.showModal();requestAnimationFrame(()=>drawJourney())});
document.querySelector('.header-actions').prepend(overviewButton);
