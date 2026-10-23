/**
 * One place to reach Firestore, and one clear message when it cannot.
 *
 *   const { db, projectId } = require('./fbadmin');
 *
 * WHY THIS EXISTS
 *
 * Every script in this folder opened firebase-admin itself, and on a fresh
 * clone there was no package.json to install it from. The whole folder
 * therefore died on `require` with a raw Node stack trace:
 *
 *   Error: Cannot find module 'firebase-admin/app'
 *
 * which says nothing about what to do, and buries the real problem: the data
 * never reached the database, so every figure on the dashboard read zero
 * while the code that computed it was perfectly correct. A missing dependency
 * should not be able to look like a broken CRM.
 *
 * So: the require is guarded, and a failure prints the one command that fixes
 * it. Same for the two other ways this can go wrong - no project to write to,
 * and no credentials.
 */
const fs = require('fs');
const path = require('path');

const KEY = path.join(__dirname, 'serviceAccountKey.json');

function die(what, how) {
  console.error('\n' + what + '\n');
  how.forEach(l => console.error('   ' + l));
  console.error('');
  process.exit(1);
}

let initializeApp, cert, applicationDefault, getFirestore, FieldValue;
try {
  ({ initializeApp, cert, applicationDefault } = require('firebase-admin/app'));
  ({ getFirestore, FieldValue } = require('firebase-admin/firestore'));
} catch (e) {
  if (!/Cannot find module/.test(String(e && e.message))) throw e;
  die('firebase-admin is not installed, so this script cannot reach Firestore.',
      ['Install it once, from this folder:', '',
       '   cd seed && npm install', '',
       'Then run the script again. Nothing was read or written.']);
}

/* Getting the project wrong writes thousands of documents into the wrong
   database, so it is resolved explicitly and printed before any write. */
function resolveProject(argv) {
  const a = (argv || []).find(x => x.startsWith('--project='));
  if (a) return a.split('=').slice(1).join('=');
  try {
    const rc = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '.firebaserc'), 'utf8'));
    const p = rc.projects && (rc.projects.default || Object.values(rc.projects)[0]);
    if (p) return p;
  } catch (e) { /* no .firebaserc */ }
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null;
}

const projectId = resolveProject(process.argv.slice(2));
if (!projectId) {
  die('No Firebase project to work against.',
      ['Pass it explicitly:', '',
       '   node ' + path.basename(process.argv[1] || 'script.js')
         + ' --project=paradise-insti-crm', '',
       'Paradise Insti CRM is its OWN project, separate from Project Flow.']);
}

const haveKey = fs.existsSync(KEY);
let db;
try {
  initializeApp(haveKey
    ? { credential: cert(require(KEY)), projectId }
    : { credential: applicationDefault(), projectId });
  db = getFirestore();
} catch (e) {
  die('Could not sign in to Firebase project ' + projectId + '.',
      ['Either sign in as yourself:', '',
       '   gcloud auth application-default login', '',
       'or put a service account key at seed/serviceAccountKey.json',
       '(Firebase console > Project settings > Service accounts).',
       '', 'The error was: ' + (e && e.message)]);
}

module.exports = { db, projectId, FieldValue, haveKey, KEY };
