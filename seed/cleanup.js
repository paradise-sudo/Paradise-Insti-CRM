/**
 * Deletes documents that the seed no longer produces.
 *
 *   node cleanup.js                 # reports, deletes nothing
 *   node cleanup.js --apply         # deletes
 *   node cleanup.js --only=targets --apply
 *
 * Why this exists: target ids changed from an md5 to the readable
 * tgt_<userId>_<month>_<bucket>, so that the Admin screen could write the
 * same document the seed does - a browser cannot compute an md5. Loading
 * after that change left BOTH sets in place and every target was counted
 * twice, which read as a doubled target on the dashboard.
 *
 * It only ever deletes documents absent from seed/out, so a row the seed
 * still produces is never touched. Activities and orders created in the app
 * are not in the seed either, so those collections are skipped unless you
 * name them explicitly - and you almost certainly should not.
 */
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const KEY = path.join(__dirname, 'serviceAccountKey.json');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const arg = n => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=').slice(1).join('=') : null;
};

// Safe by default: these are fully owned by the seed. Anything people create
// in the app lives in activities, orders, opportunities and contacts, so those
// are left alone unless asked for by name.
const DEFAULT = ['targets', 'users'];
const ONLY = arg('only') ? arg('only').split(',') : DEFAULT;

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

(async () => {
  console.log('project: ' + projectId);
  console.log(APPLY ? 'MODE   : deleting\n' : 'MODE   : report only, nothing is deleted\n');

  for (const name of ONLY) {
    const file = path.join(OUT, name + '.json');
    if (!fs.existsSync(file)) {
      console.log(name + ': no seed file, skipped (refusing to guess)');
      continue;
    }
    const keep = new Set(JSON.parse(fs.readFileSync(file, 'utf8')).map(d => d.id));
    const snap = await db.collection(name).get();
    const stale = snap.docs.filter(d => !keep.has(d.id));

    console.log(name.padEnd(14) + snap.size + ' in Firestore, '
      + keep.size + ' in the seed, ' + stale.length + ' stale');
    stale.slice(0, 5).forEach(d => console.log('    ' + d.id));
    if (stale.length > 5) console.log('    … and ' + (stale.length - 5) + ' more');

    if (APPLY && stale.length) {
      for (let i = 0; i < stale.length; i += 450) {
        const batch = db.batch();
        stale.slice(i, i + 450).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      console.log('    deleted ' + stale.length);
    }
  }

  if (!APPLY) console.log('\nRe-run with --apply to delete them.');
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
