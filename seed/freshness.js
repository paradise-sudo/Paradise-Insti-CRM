/**
 * Is what the database holds actually CURRENT? Run by ship.sh after a deploy.
 *
 *   node freshness.js
 *
 * WHY, AND WHAT IT CAUGHT
 *
 * ship.sh used to ask only "are there any FY27 orders?". That question passes
 * on a load that is months stale, because April to September are still
 * sitting there - so a deploy finished with a tick while the dashboard read
 * zero for the current month, and the month is the number anybody actually
 * looks at.
 *
 * That is exactly what happened through October 2026. seed/ had no
 * package.json, so every script here died on `require` with MODULE_NOT_FOUND
 * before touching Firestore. Three DCRs were handed over on the 13th, 14th
 * and 22nd and none of them ever loaded. FY27 looked populated, the FY27
 * check stayed quiet, and MTD read zero for a week and a half while the code
 * computing it was correct the whole time.
 *
 * So this reports the newest order in the database and the current month's
 * total, and says plainly when the month is empty. A stale load and a working
 * one no longer look the same.
 */
const { db, projectId } = require('./fbadmin');

const inr = n => 'Rs ' + Math.round(n).toLocaleString('en-IN');
const Y = '\u001b[33m', R = '\u001b[31m', O = '\u001b[0m';

/* LOCAL date. toISOString() is UTC and India is +5:30, so before 05:30 it
   names yesterday - the same bug that made every MTD range start a day
   early. */
const iso = d => {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

(async () => {
  const now = new Date();
  const month = iso(now).slice(0, 7);
  const fy = now.getMonth() >= 3
    ? now.getFullYear() + '-04-01'
    : (now.getFullYear() - 1) + '-04-01';

  const snap = await db.collection('orders').get();
  let fyN = 0, fyV = 0, mN = 0, mV = 0, newest = '';
  snap.forEach(d => {
    const o = d.data() || {};
    const day = String(o.orderDate || '').slice(0, 10);
    if (!day) return;
    if (day > newest) newest = day;
    if (day >= fy) { fyN++; fyV += o.value || 0; }
    if (day.slice(0, 7) === month) { mN++; mV += o.value || 0; }
  });

  console.log('   project      : ' + projectId);
  console.log('   orders       : ' + snap.size);
  console.log('   FY27         : ' + fyN + ' orders, ' + inr(fyV));
  console.log('   newest order : ' + (newest || '(none)'));
  console.log('   this month   : ' + mN + ' orders, ' + inr(mV));

  if (!fyN) {
    console.log(Y + '\n   FY27 IS EMPTY - every revenue figure will read zero.' + O);
  } else if (!mN) {
    console.log(R + '\n   NOTHING THIS MONTH. Month to date will read zero on the'
      + '\n   dashboard even though FY27 looks populated - which is what a'
      + '\n   stale load looks like.' + O);
  }
  if (!fyN || !mN) {
    console.log('\n   Load the DCR:\n');
    console.log('      cd seed && npm install');
    console.log('      python3 build_seed.py && node load_seed.js\n');
  }

  /* The days between the newest order and today. A DCR handed over on Monday
     and loaded on Monday reads 0 or 1; anything beyond a few days means the
     workbook moved on and the database did not. */
  if (newest) {
    const gap = Math.round((new Date(iso(now)) - new Date(newest)) / 864e5);
    if (gap > 4) console.log(Y + '   The newest order is ' + gap
      + ' days old. If the DCR has moved on since, reload it.' + O);
  }
  process.exit(0);
})().catch(e => {
  console.log('   (could not check: ' + (e && e.message) + ')');
  process.exit(0);
});
