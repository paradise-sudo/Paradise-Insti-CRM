/**
 * Repairs dates the app stored in UTC.
 *
 *   node fixdates.js                 # reports, changes nothing
 *   node fixdates.js --apply         # rewrites them
 *   node fixdates.js --only=orders --apply
 *
 * WHAT WENT WRONG
 *
 * The app wrote timestamps with `new Date().toISOString()`, which converts to
 * UTC first. India is +5:30, so anything logged between 18:30 and midnight
 * IST was stored with the PREVIOUS day's date once every screen read it back
 * with .slice(0,10). An order booked at 22:48 on 30 September went into the
 * books as 30 September in UTC terms but is read as... well, that is the
 * point: it depends on the hour, which is exactly the bug.
 *
 * Two shapes exist in the database:
 *
 *   '2026-09-17T00:00:00'        written by the import - local, correct
 *   '2026-09-30T17:18:00.000Z'   written by the app    - UTC, needs fixing
 *
 * So the trailing Z is the marker. Every Z value is converted to the Indian
 * wall clock and rewritten in the import's shape, which makes both sources
 * agree and makes .slice(0,10) mean the same thing everywhere.
 *
 * A value only changes CALENDAR DAY when its UTC time of day is 18:30 or
 * later. Those are listed separately below, because those are the ones that
 * moved money between two days in a report.
 *
 * This is safe to run twice: a value already in local shape has no Z and is
 * skipped.
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

/* collection -> the date fields the app writes into it */
const FIELDS = {
  orders:        ['orderDate', 'paymentReceivedAt', 'financeApprovedAt'],
  activities:    ['loggedAt'],
  opportunities: ['stageSince', 'closedAt', 'nextActionDate', 'createdAt'],
  contacts:      ['createdAt']
};
const ONLY = arg('only') ? arg('only').split(',') : Object.keys(FIELDS);

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

const IST_MS = 330 * 60000;

/** '2026-09-30T17:18:00.000Z' -> '2026-09-30T22:48:00'; anything else -> null */
function toLocal(v) {
  if (typeof v !== 'string' || !/Z$/.test(v)) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + IST_MS).toISOString().slice(0, 19);
}
const dayOf = s => String(s || '').slice(0, 10);

(async () => {
  console.log('project: ' + projectId);
  console.log(APPLY ? 'MODE   : rewriting\n'
                    : 'MODE   : report only, nothing is changed\n');

  let totalTouched = 0, totalMoved = 0;
  const moved = [];

  for (const name of ONLY) {
    const fields = FIELDS[name];
    if (!fields) { console.log(name + ': not a collection this script knows'); continue; }

    const snap = await db.collection(name).get();
    const edits = [];

    snap.forEach(doc => {
      const d = doc.data();
      const patch = {};
      let dayChanged = false;
      fields.forEach(f => {
        const fixed = toLocal(d[f]);
        if (!fixed) return;
        patch[f] = fixed;
        if (dayOf(fixed) !== dayOf(d[f])) {
          dayChanged = true;
          moved.push({ col: name, id: doc.id, field: f,
                       from: d[f], to: fixed,
                       value: d.value, account: d.accountId });
        }
      });
      if (Object.keys(patch).length) edits.push({ ref: doc.ref, patch, dayChanged });
    });

    const dayMoves = edits.filter(e => e.dayChanged).length;
    totalTouched += edits.length;
    totalMoved += dayMoves;
    console.log(name.padEnd(15) + String(snap.size).padStart(6) + ' docs, '
      + String(edits.length).padStart(4) + ' written by the app, '
      + String(dayMoves).padStart(3) + ' on the wrong DAY');

    if (APPLY && edits.length) {
      for (let i = 0; i < edits.length; i += 400) {
        const batch = db.batch();
        edits.slice(i, i + 400).forEach(e => batch.update(e.ref, e.patch));
        await batch.commit();
      }
      console.log('                rewrote ' + edits.length);
    }
  }

  if (moved.length) {
    console.log('\nThese moved to a different day:');
    moved.slice(0, 40).forEach(m => console.log('  ' + m.col.padEnd(14)
      + m.field.padEnd(16) + dayOf(m.from) + '  ->  ' + dayOf(m.to)
      + (m.value ? '   Rs ' + Math.round(m.value).toLocaleString('en-IN') : '')));
    if (moved.length > 40) console.log('  … and ' + (moved.length - 40) + ' more');

    // The number that actually matters: revenue that changes month
    const crossMonth = moved.filter(m => m.col === 'orders' && m.field === 'orderDate'
      && dayOf(m.from).slice(0, 7) !== dayOf(m.to).slice(0, 7));
    if (crossMonth.length) {
      const amt = crossMonth.reduce((n, m) => n + (m.value || 0), 0);
      console.log('\n  ' + crossMonth.length + ' order(s) worth Rs '
        + Math.round(amt).toLocaleString('en-IN')
        + ' move to a different MONTH, so a monthly total changes.');
    }
  }

  console.log('\n' + totalTouched + ' value(s) in the app\'s UTC shape, '
    + totalMoved + ' of them on the wrong day.');
  if (!APPLY && totalTouched) console.log('Re-run with --apply to rewrite them.');
  if (!totalTouched) console.log('Nothing to fix.');
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
