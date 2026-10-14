/**
 * Removes the test rows typed into the live app while we were building it.
 *
 *   node droptest.js            # reports, deletes nothing
 *   node droptest.js --apply    # deletes
 *
 * WHAT IT IS FOR
 *
 * Two closed orders were entered as tests against real accounts and never
 * taken out, so October read Rs 12.2L against a real month of Rs 8,295:
 *
 *   06-Oct  Azad Engineering  Rs 11,99,875  invoice "Testing01234"  (Ayush)
 *   07-Oct  Smartq            Rs     9,765  invoice "Testing 1234"  (Vishwanath)
 *
 * That is 99.3% of the month. The third October order - Paytm Rs 8,295,
 * invoice 00GDMTA000036967 - is real and is left alone.
 *
 * HOW IT DECIDES
 *
 * An order goes only when BOTH hold:
 *   - it was logged in the app (channel 'app'); the import is never touched
 *   - its invoice number starts with "test"
 *
 * An invoice number is the one field on a closed order that cannot be left
 * blank and has no reason to say "Testing", so it is a far safer marker than
 * a value or a date. Nothing is matched on remarks alone: "Testing the new
 * menu with their team" is a real note on a real visit.
 *
 * Activities go only when the whole remark is the word test or testing, with
 * nothing else in it. That is tight on purpose.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not move an opportunity back to the stage it was at before the
 * test. Deleting an order cannot know what the stage was beforehand, so the
 * accounts touched are listed at the end and are worth a look on the Pipeline
 * screen - a test that pushed a live deal to C4 would otherwise sit there.
 *
 * Safe to run twice.
 */
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const KEY = path.join(__dirname, 'serviceAccountKey.json');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const arg = n => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=').slice(1).join('=') : null;
};

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
const IS_TEST_INV = /^\s*test/i;
const IS_TEST_REMARK = /^\s*test(ing)?\s*$/i;

(async () => {
  console.log('project: ' + projectId);
  console.log(APPLY ? 'MODE   : deleting\n' : 'MODE   : report only, nothing is deleted\n');

  const users = await db.collection('users').get();
  const name = {};
  users.docs.forEach(d => { name[d.id] = (d.data() || {}).name || d.id; });

  const accounts = await db.collection('accounts').get();
  const accName = {};
  accounts.docs.forEach(d => { accName[d.id] = (d.data() || {}).name || d.id; });

  const orders = await db.collection('orders').get();
  const badOrders = orders.docs.filter(d => {
    const o = d.data() || {};
    return o.channel === 'app' && IS_TEST_INV.test(String(o.invoiceNumber || ''));
  });

  console.log('--- orders to delete: ' + badOrders.length + ', '
    + inr(badOrders.reduce((n, d) => n + ((d.data() || {}).value || 0), 0)) + ' ---');
  badOrders.forEach(d => {
    const o = d.data() || {};
    console.log('   ' + String(o.orderDate || '').slice(0, 10)
      + '  ' + inr(o.value || 0).padStart(16)
      + '  ' + (accName[o.accountId] || '?').slice(0, 26).padEnd(26)
      + '  by ' + (name[o.bookedBy] || '?').padEnd(12)
      + '  inv ' + String(o.invoiceNumber || '-'));
  });

  const acts = await db.collection('activities').get();
  const badActs = acts.docs.filter(d =>
    IS_TEST_REMARK.test(String((d.data() || {}).remarks || '')));
  console.log('\n--- activities whose whole remark is "test": '
    + badActs.length + ' ---');
  badActs.forEach(d => {
    const a = d.data() || {};
    console.log('   ' + String(a.loggedAt || '').slice(0, 10)
      + '  ' + (accName[a.accountId] || '?').slice(0, 26).padEnd(26)
      + '  by ' + (name[a.loggedBy] || '?').padEnd(12)
      + '  "' + String(a.remarks || '').trim() + '"');
  });

  /* A test that moved a live deal forward leaves the deal where it was
     pushed, and no delete can know where it came from. Name the accounts so
     they can be checked by eye. */
  const touched = new Set();
  badOrders.forEach(d => touched.add((d.data() || {}).accountId));
  badActs.forEach(d => touched.add((d.data() || {}).accountId));

  if (!APPLY) {
    console.log('\nRe-run with --apply to delete them.');
    if (touched.size) {
      console.log('\nAfterwards, check the stage on these accounts - a test '
        + 'may have pushed a live deal forward:');
      [...touched].forEach(a => console.log('   ' + (accName[a] || a)));
    }
    process.exit(0);
  }

  const del = async docs => {
    for (let i = 0; i < docs.length; i += 450) {
      const batch = db.batch();
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  };
  await del(badOrders);
  console.log('\ndeleted ' + badOrders.length + ' orders');
  await del(badActs);
  console.log('deleted ' + badActs.length + ' activities');

  if (touched.size) {
    console.log('\nCheck the stage on these accounts - a test may have pushed '
      + 'a live deal forward:');
    [...touched].forEach(a => console.log('   ' + (accName[a] || a)));
  }
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
