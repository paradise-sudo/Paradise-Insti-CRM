/**
 * Clears FY27 closed sales so the DCR can be reloaded as the only source.
 *
 *   node resetfy27.js                 # reports, deletes nothing
 *   node resetfy27.js --apply         # deletes the orders
 *   node resetfy27.js --acts --apply  # also deletes FY27 activities
 *
 * WHY A WIPE RATHER THAN ANOTHER REPAIR
 *
 * FY27 orders reached the database by three routes and the routes disagree:
 *
 *   - the import, which between 13 and 22-Oct-26 MERGED the two rows of a
 *     bill worked by two reps, on the mistaken belief that they were the
 *     bill counted twice. They are not: each row holds that rep's share, so
 *     the merge halved genuine revenue and understated FY27 by Rs 89 lakh.
 *     The importer emits one order per DCR row again.
 *   - the app, where the team has started closing orders directly
 *   - the app again, as test rows, since removed
 *
 * The second and third overlap the first. Pradeep logged Paytm in the app at
 * Rs 8,295, and the same bill is in the DCR at Rs 8,296 under invoice
 * 00GDMTA000036967 - reload without clearing and that one bill is in the
 * books twice, at Rs 16,591. No repair script can tell those apart reliably,
 * because they are not duplicates of each other in any field: different ids,
 * different values, different channel.
 *
 * So FY27 is cleared and rebuilt from the DCR, which today still holds
 * everything. One order per DCR row, at the value that row states, credited
 * to the rep whose row it is. Only a row the SAME rep keyed twice under the
 * same invoice is merged, which is a re-key rather than a share.
 *
 * WHAT IT TOUCHES
 *
 *   - orders dated on or after 1-Apr-2026. Nothing before that: three years
 *     of history drive the vs-last-year and SSSG figures and are not in the
 *     FY27 workbook to be rebuilt from.
 *   - with --acts, activities logged on or after 1-Apr-2026 as well. Without
 *     it they are left, and an activity the DCR also carries will appear
 *     twice in the entry log until the next rebuild.
 *
 * It does not touch accounts, contacts, opportunities, targets or users. The
 * seed rewrites those in place by id, so they need no clearing.
 *
 * AFTERWARDS, IN THIS ORDER
 *
 *   python3 build_seed.py && node load_seed.js
 *
 * Between the delete and the load the dashboard reads zero for FY27. That is
 * a real window, so do it when nobody is presenting from it.
 */
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const KEY = path.join(__dirname, 'serviceAccountKey.json');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ACTS = args.includes('--acts');
const arg = n => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=').slice(1).join('=') : null;
};
const FY = arg('from') || '2026-04-01';

let projectId = arg('project');
if (!projectId) {
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.firebaserc'), 'utf8'));
    projectId = rc.projects && (rc.projects.default || Object.values(rc.projects)[0]);
  } catch (e) { /* fall through */ }
}
projectId = projectId || process.env.GOOGLE_CLOUD_PROJECT;

initializeApp(fs.existsSync(KEY)
  ? { credential: cert(require(KEY)), projectId }
  : { credential: applicationDefault(), projectId });
const db = getFirestore();

const inr = n => 'Rs ' + Math.round(n).toLocaleString('en-IN');
const day = v => String(v || '').slice(0, 10);

(async () => {
  console.log('project    : ' + projectId);
  console.log('FY starts  : ' + FY);
  console.log(APPLY ? 'MODE       : deleting\n' : 'MODE       : report only, nothing is deleted\n');

  const users = await db.collection('users').get();
  const name = {};
  users.docs.forEach(d => { name[d.id] = (d.data() || {}).name || d.id; });

  const orders = await db.collection('orders').get();
  const hit = orders.docs.filter(d => day((d.data() || {}).orderDate) >= FY);
  const keep = orders.size - hit.length;

  const byChannel = {}, byRep = {};
  hit.forEach(d => {
    const o = d.data() || {};
    const c = o.channel === 'app' ? 'logged in the app' : 'imported from the DCR';
    byChannel[c] = byChannel[c] || { n: 0, v: 0 };
    byChannel[c].n++; byChannel[c].v += o.value || 0;
    const r = name[o.bookedBy] || '(no rep)';
    byRep[r] = byRep[r] || { n: 0, v: 0 };
    byRep[r].n++; byRep[r].v += o.value || 0;
  });

  console.log('orders in the database : ' + orders.size);
  console.log('  before ' + FY + ', kept : ' + keep);
  console.log('  on or after, to delete : ' + hit.length + '   '
    + inr(hit.reduce((n, d) => n + ((d.data() || {}).value || 0), 0)) + '\n');
  Object.entries(byChannel).forEach(([k, s]) =>
    console.log('   ' + k.padEnd(24) + String(s.n).padStart(5) + '   ' + inr(s.v)));
  console.log('');
  Object.entries(byRep).sort((a, b) => b[1].v - a[1].v).forEach(([k, s]) =>
    console.log('   ' + k.padEnd(24) + String(s.n).padStart(5) + '   ' + inr(s.v)));

  let acts = { docs: [], size: 0 }, actHit = [];
  acts = await db.collection('activities').get();
  actHit = acts.docs.filter(d => day((d.data() || {}).loggedAt) >= FY);
  console.log('\nactivities in the database : ' + acts.size);
  console.log('  on or after ' + FY + '     : ' + actHit.length
    + (ACTS ? '   -> will be deleted' : '   -> left alone (pass --acts to clear)'));

  if (!APPLY) {
    console.log('\nNothing has been deleted. To do it:');
    console.log('   node resetfy27.js --apply' + (ACTS ? ' --acts' : ''));
    console.log('   python3 build_seed.py && node load_seed.js');
    process.exit(0);
  }

  const del = async docs => {
    for (let i = 0; i < docs.length; i += 450) {
      const batch = db.batch();
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  };
  await del(hit);
  console.log('\ndeleted ' + hit.length + ' orders');
  if (ACTS) {
    await del(actHit);
    console.log('deleted ' + actHit.length + ' activities');
  }
  console.log('\nFY27 is empty. Now rebuild it, or the dashboard stays at zero:');
  console.log('   python3 build_seed.py && node load_seed.js');
  process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
