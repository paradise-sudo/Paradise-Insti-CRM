/**
 * Loads seed/out/*.json into Firestore.
 *
 *   npm install firebase-admin
 *   node load_seed.js --dry          # count only, writes nothing
 *   node load_seed.js                # writes
 *   node load_seed.js --only=accounts,orders
 *
 * Needs a service-account key at seed/serviceAccountKey.json
 * (Firebase console > Project settings > Service accounts > Generate new private key).
 * Never commit that file.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const KEY = path.join(__dirname, 'serviceAccountKey.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1].split(',') : null;

const ORDER = ['users', 'accounts', 'contacts', 'opportunities',
               'activities', 'orders', 'stageHistory', 'targets'];

if (!fs.existsSync(KEY)) {
  console.error('Missing ' + KEY);
  console.error('Firebase console > Project settings > Service accounts > Generate new private key');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(KEY)) });
const db = admin.firestore();

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
  console.log(DRY ? '--- DRY RUN ---' : '--- WRITING TO FIRESTORE ---');
  for (const name of list) await loadCollection(name);

  if (!DRY) {
    const report = JSON.parse(fs.readFileSync(path.join(OUT, 'importReport.json'), 'utf8'));
    await db.collection('meta').doc('import').set({
      ...report, loadedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('\nimport report stored at meta/import');
  }
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
