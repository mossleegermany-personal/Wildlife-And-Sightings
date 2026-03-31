require('dotenv').config();
const axios = require('axios');
const key = process.env.EBIRD_API_KEY;

(async () => {
  // 0. Inspect target checklist S315117033 for full structure
  console.log('\n=== TARGET CHECKLIST S315117033 ===');
  const target = await axios.get('https://api.ebird.org/v2/product/checklist/view/S315117033', {
    headers: { 'X-eBirdApiToken': key }
  });
  const td = target.data;
  console.log('Top-level keys:', Object.keys(td));
  console.log('userDisplayName:', td.userDisplayName);
  console.log('firstName:', td.firstName, '| lastName:', td.lastName);
  console.log('subAux:', JSON.stringify(td.subAux));
  console.log('Total obs:', td.obs.length);
  for (const o of td.obs) {
    console.log('\n  --- obs ---');
    console.log('  keys:', Object.keys(o));
    console.log('  speciesCode:', o.speciesCode, '| obsId:', o.obsId);
    console.log('  comments:', o.comments);
    console.log('  obsAux (if any):', JSON.stringify(o.obsAux));
    console.log('  mediaCounts:', JSON.stringify(o.mediaCounts));
    console.log('  full:', JSON.stringify(o));
  }
  process.exit(0);

  // 1. Check what keys come back from recent obs
  const r = await axios.get('https://api.ebird.org/v2/data/obs/SG/recent', {
    headers: { 'X-eBirdApiToken': key },
    params: { back: 30, maxResults: 100, detail: 'full' }
  });
  console.log('=== Recent obs ===');
  console.log('Total obs:', r.data.length);
  console.log('ALL KEYS on obs[0]:', Object.keys(r.data[0]));
  const withBreed = r.data.filter(o => o.breedingCode);
  console.log('With breedingCode in recent obs:', withBreed.length);
  if (withBreed[0]) console.log('Sample with breedingCode:', JSON.stringify(withBreed[0]));

  // 2. Check known checklist S312315508
  console.log('\n=== Checklist S312315508 (Barred Eagle-Owl) ===');
  const cl = await axios.get('https://api.ebird.org/v2/product/checklist/view/S312315508', {
    headers: { 'X-eBirdApiToken': key }
  });
  console.log('Checklist obs count:', cl.data.obs.length);
  console.log('subAux:', JSON.stringify(cl.data.subAux));
  console.log('subAuxAi:', JSON.stringify(cl.data.subAuxAi));
  for (const o of cl.data.obs) {
    console.log('  speciesCode:', o.speciesCode, '| keys:', Object.keys(o));
    console.log('  full entry:', JSON.stringify(o));
  }

  // Find a checklist with breeding codes - search notable obs
  console.log('\n=== Looking for obs with breedingCode in notable SG ===');
  const notable = await axios.get('https://api.ebird.org/v2/data/obs/SG/recent/notable', {
    headers: { 'X-eBirdApiToken': key },
    params: { back: 30, detail: 'full' }
  });
  console.log('Notable obs keys:', Object.keys(notable.data[0] || {}));
  const nb = notable.data.filter(o => o.breedingCode);
  console.log('Notable with breedingCode:', nb.length);
  // Fetch one notable checklist and show full subAux
  if (notable.data[0]) {
    const subId2 = notable.data[0].subId;
    const cl3 = await axios.get('https://api.ebird.org/v2/product/checklist/view/' + subId2, {
      headers: { 'X-eBirdApiToken': key }
    });
    console.log('Notable checklist', subId2, 'subAux:', JSON.stringify(cl3.data.subAux));
    console.log('Notable checklist obs[0]:', JSON.stringify(cl3.data.obs[0]));
  }

  // 3. Pick first subId from recent obs and fetch that checklist
  const subId = r.data[0].subId;
  console.log('\n=== Random checklist from recent obs:', subId, '===');
  const cl2 = await axios.get('https://api.ebird.org/v2/product/checklist/view/' + subId, {
    headers: { 'X-eBirdApiToken': key }
  });
  console.log('obs count:', cl2.data.obs.length);
  for (const o of cl2.data.obs.slice(0, 3)) {
    console.log('  keys:', Object.keys(o));
    console.log('  entry:', JSON.stringify(o));
  }
})().catch(e => console.error('ERROR:', e.response?.status, e.message));
