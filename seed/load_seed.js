/**
 * Loads seed/out/*.json into Firestore.
 *
 *   npm install firebase-admin
 *   node load_seed.js --dry          # count only, writes nothing
 *   node load_seed.js                # writes
 *   node load_seed.js --only=accounts,orders
 *   node load_seed.js --project=paradise-insti-crm
 *
 * CREDENTIALS, in order of preference:
 *
 *   1. Application Default Credentials. In Cloud Shell you are already signed
 *      in as yourself, so nothing else is needed - no key file to download,
 *      upload, and then leave sitting in a folder. This is the normal path.
 *   2. seed/serviceAccountKey.json, if you put one there. Needed when running
 *      somewhere without ADC. It is gitignored; never commit it.
 *
 * Written against the MODULAR entry points (firebase-admin/app and
 * firebase-admin/firestore) rather than the old `admin.credential.cert(...)`
 * and `admin.firestore()` namespace. firebase-admin 14 removed that namespace,
 * so a fresh `npm install firebase-admin` broke the old form with
 * "Cannot read properties of undefined (reading 'cert')". The modular imports
 * have worked since v10 and still do.
 */
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const KEY = path.join(__dirname, 'serviceAccountKey.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const arg = n => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=').slice(1).join('=') : null;
};
const ONLY = arg('only') ? arg('only').split(',') : null;

const ORDER = ['users', 'accounts', 'contacts', 'opportunities',
               'activities', 'orders', 'stageHistory', 'targets'];

/* ---- which project are we writing to? ------------------------------------
 * Getting this wrong writes 11,000 documents into the wrong database, so it
 * is resolved explicitly and printed before anything is written.            */
function resolveProject() {
  if (arg('project')) return arg('project');
  try {
    const rc = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '.firebaserc'), 'utf8'));
    const p = rc.projects && (rc.projects.default || Object.values(rc.projects)[0]);
    if (p) return p;
  } catch (e) { /* no .firebaserc, fall through */ }
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null;
}

const projectId = resolveProject();
const haveKey = fs.existsSync(KEY);

if (!haveKey && !projectId) {
  console.error('Cannot tell which project to write to.');
  console.error('Run it from inside the repo so .firebaserc is found, or pass');
  console.error('  node load_seed.js --project=paradise-insti-crm');
  process.exit(1);
}

let db;
try {
  initializeApp(haveKey
    ? { credential: cert(require(KEY)), projectId }
    : { credential: applicationDefault(), projectId });
  db = getFirestore();
} catch (e) {
  console.error('Could not connect: ' + e.message);
  console.error('');
  console.error('If that is a credentials problem and you are in Cloud Shell,');
  console.error('run:  gcloud auth application-default login');
  process.exit(1);
}

console.log('project     : ' + projectId);
console.log('credentials : ' + (haveKey ? 'serviceAccountKey.json'
                                        : 'application default, your Cloud Shell login'));
console.log('');

async function loadCollection(name) {
  const file = path.join(OUT, name + '.json');
  if (!fs.existsSync(file)) { console.log(name + ': no file, skipped'); return; }
  const docs = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (DRY) { console.log(name.padEnd(16) + docs.length + ' docs (dry run)'); return; }

  let written = 0;
  // Firestore caps a batch at 500 writes.
  for (let i = 0; i < docs.length; i += 450) {
    const batch = db.batch();
    docs.slice(i, i + 450).forEach(d => {
      const { id, ...rest } = d;
      batch.set(db.collection(name).doc(id), rest, { merge: true });
    });
    await batch.commit();
    written += Math.min(450, docs.length - i);
    process.stdout.write('\r' + name.padEnd(16) + written + '/' + docs.length);
  }
  process.stdout.write('\r' + name.padEnd(16) + written + '/' + docs.length + ' done\n');
}

(async () => {
  const list = ORDER.filter(n => !ONLY || ONLY.includes(n));
  console.log(DRY ? '--- DRY RUN, nothing is written ---'
                  : '--- WRITING TO FIRESTORE ---');
  for (const name of list) await loadCollection(name);

  if (!DRY) {
    const rpt = path.join(OUT, 'importReport.json');
    if (fs.existsSync(rpt)) {
      await db.collection('meta').doc('import').set({
        ...JSON.parse(fs.readFileSync(rpt, 'utf8')),
        loadedAt: FieldValue.serverTimestamp()
      });
      console.log('\nimport report stored at meta/import');
    }
  }
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
