/**
 * Reads what is ACTUALLY in Firestore and compares it with seed/out.
 *
 *   node check.js
 *   node check.js --month=2026-09
 *
 * Written because the dashboard was showing 45 orders where the seed holds
 * 49. Guessing at that from the outside wastes everyone's time; this prints
 * the difference and names the rows responsible.
 */
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const KEY = path.join(__dirname, 'serviceAccountKey.json');
const args = process.argv.slice(2);
const arg = n => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=').slice(1).join('=') : null;
};
const MONTH = arg('month') || '2026-09';

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

const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const local = n => {
  const f = path.join(OUT, n + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

(async () => {
  console.log('project: ' + projectId + '\n');

  const names = ['users', 'accounts', 'contacts', 'opportunities',
                 'activities', 'orders', 'stageHistory', 'targets'];
  console.log('collection        in Firestore   in seed/out   match');
  const live = {};
  for (const n of names) {
    const snap = await db.collection(n).get();
    live[n] = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    const l = local(n);
    const ok = l ? (l.length === live[n].length ? 'yes' : 'NO') : '-';
    console.log('  ' + n.padEnd(16) + String(live[n].length).padStart(8)
      + String(l ? l.length : '-').padStart(14) + '   ' + ok);
  }

  // users: are there leftovers from an earlier load under different ids?
  console.log('\nusers in Firestore:');
  live.users.forEach(u => console.log('  ' + u.id + '  ' + (u.name || '?').padEnd(12)
    + (u.email || '') + '  ' + (u.role || '')));
  const seedUsers = local('users');
  if (seedUsers) {
    const stale = live.users.filter(u => !seedUsers.some(s => s.id === u.id));
    if (stale.length) {
      console.log('\n  ' + stale.length + ' user(s) above are NOT in the current seed.');
      console.log('  Those are left over from an earlier load under different ids.');
    }
  }

  // the month in question
  const known = new Set(live.users.map(u => u.id));
  const inMonth = live.orders.filter(o => (o.orderDate || '').startsWith(MONTH));
  const orphan = inMonth.filter(o => o.bookedBy && !known.has(o.bookedBy));
  const sum = a => a.reduce((n, o) => n + (o.value || 0), 0);

  console.log('\n' + MONTH + ' in Firestore:');
  console.log('  orders            ' + inMonth.length);
  console.log('  value             ' + inr(sum(inMonth)));
  console.log('  the dashboard drops any order whose bookedBy is not a known user');
  console.log('  orphaned orders   ' + orphan.length + '  worth ' + inr(sum(orphan)));
  if (orphan.length) {
    console.log('\n  those orders:');
    orphan.slice(0, 20).forEach(o => console.log('    ' + (o.orderDate || '').slice(0, 10)
      + '  ' + inr(o.value || 0).padStart(12) + '  bookedBy=' + o.bookedBy));
    console.log('\n  FIX: node load_seed.js --only=users,orders');
  }

  const localOrders = local('orders');
  if (localOrders) {
    const lm = localOrders.filter(o => (o.orderDate || '').startsWith(MONTH));
    console.log('\n' + MONTH + ' in seed/out: ' + lm.length + ' orders worth ' + inr(sum(lm)));
    const liveIds = new Set(inMonth.map(o => o.id));
    const missing = lm.filter(o => !liveIds.has(o.id));
    if (missing.length) {
      console.log('  ' + missing.length + ' of them never reached Firestore:');
      missing.slice(0, 20).forEach(o => console.log('    ' + (o.orderDate || '').slice(0, 10)
        + '  ' + inr(o.value || 0).padStart(12) + '  ' + o.id));
      console.log('\n  FIX: node load_seed.js');
    }
  }

  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
