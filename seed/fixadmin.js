/**
 * Moves orders the head entered on a rep's behalf onto that rep's line.
 *
 *   node fixadmin.js            # reports, changes nothing
 *   node fixadmin.js --apply    # rewrites them
 *
 * WHAT WENT WRONG
 *
 * The credit-split rule was written for one rep booking on another rep's
 * account, where "whose is this?" is a real question worth stopping for. It
 * credited the order to whoever logged it and raised a request for Ayush to
 * settle.
 *
 * Ayush logging an order is not that. He closes Compass himself, and he fills
 * in for a rep who is travelling - and the rule read both as a claim. Each
 * such order was credited 100% to him, pending a split request addressed to
 * himself, which nobody would ever answer because it does not look like a
 * question. He has no individual target - his number is the sum of everyone's
 * - so roughly Rs 12 lakh of the team's revenue sat on a line that should not
 * exist, and was missing from the reps who earned it.
 *
 * The app no longer does this: an admin logging on an owned account credits
 * the owner outright. This repairs what was written before that.
 *
 * WHAT IT CHANGES
 *
 * An order qualifies when ALL of these hold:
 *   - it is credited wholly to an admin, or booked by one with no split
 *   - its account has an owner, and that owner is not the admin
 *   - it was logged in the app (channel 'app'); imported rows are never
 *     touched, because the DCR's rep column said who did the work
 *
 * It then becomes creditSplit {owner: 1}, creditPending false. bookedBy is
 * left alone: it still records who typed it, which is the audit trail.
 *
 * Any creditSplits request the admin raised against himself is closed at the
 * same time, since it was never a real question.
 *
 * Safe to run twice: a repaired order no longer matches.
 */
const { db, projectId } = require('./fbadmin');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const arg = n => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=').slice(1).join('=') : null;
};


const inr = n => 'Rs ' + Math.round(n).toLocaleString('en-IN');

(async () => {
  console.log('project: ' + projectId);
  console.log(APPLY ? 'MODE   : rewriting\n' : 'MODE   : report only, nothing is changed\n');

  const users = await db.collection('users').get();
  const name = {}, admins = new Set();
  users.docs.forEach(d => {
    const v = d.data() || {};
    name[d.id] = v.name || d.id;
    if (v.role === 'admin') admins.add(d.id);
  });
  if (!admins.size) {
    console.log('No admin user found. Nothing to do.');
    process.exit(0);
  }
  console.log('admins: ' + [...admins].map(i => name[i]).join(', ') + '\n');

  const accounts = await db.collection('accounts').get();
  const owner = {}, accName = {};
  accounts.docs.forEach(d => {
    const v = d.data() || {};
    owner[d.id] = v.owner || null;
    accName[d.id] = v.name || d.id;
  });

  const orders = await db.collection('orders').get();
  const hits = [];
  let importedSkipped = 0, noOwner = 0;

  orders.docs.forEach(d => {
    const o = d.data() || {};
    const sp = o.creditSplit;
    const wholly = sp
      ? (Object.keys(sp).length === 1 && admins.has(Object.keys(sp)[0])
         && Math.abs((sp[Object.keys(sp)[0]] || 0) - 1) < 1e-9)
      : admins.has(o.bookedBy);
    if (!wholly) return;

    // The import knew who did the work; only the app ever guessed.
    if (o.channel !== 'app') { importedSkipped++; return; }

    const own = owner[o.accountId];
    if (!own || admins.has(own)) { noOwner++; return; }
    hits.push({ ref: d.ref, id: d.id, o, own });
  });

  const total = hits.reduce((n, h) => n + (h.o.value || 0), 0);
  console.log('orders in the database        : ' + orders.size);
  console.log('credited wholly to an admin   : '
    + (hits.length + importedSkipped + noOwner));
  console.log('  imported, left alone        : ' + importedSkipped);
  console.log('  account has no other owner  : ' + noOwner);
  console.log('  to move onto the rep        : ' + hits.length
    + '   ' + inr(total) + '\n');

  const byRep = {};
  hits.forEach(h => {
    byRep[h.own] = byRep[h.own] || { n: 0, v: 0 };
    byRep[h.own].n++; byRep[h.own].v += h.o.value || 0;
  });
  if (hits.length) {
    console.log('moving to:');
    Object.entries(byRep).sort((a, b) => b[1].v - a[1].v).forEach(([u, s]) =>
      console.log('   ' + (name[u] || u).padEnd(14) + String(s.n).padStart(4)
        + ' orders   ' + inr(s.v)));
    console.log('\nthe largest:');
    hits.slice().sort((a, b) => (b.o.value || 0) - (a.o.value || 0)).slice(0, 10)
      .forEach(h => console.log('   ' + String(h.o.orderDate || '').slice(0, 10)
        + '  ' + inr(h.o.value || 0).padStart(14)
        + '  ' + (accName[h.o.accountId] || '?').slice(0, 30).padEnd(30)
        + '  -> ' + (name[h.own] || h.own)));
  }

  // Requests the admin raised against himself were never a real question.
  const splits = await db.collection('creditSplits').get();
  const stale = splits.docs.filter(d => {
    const v = d.data() || {};
    return v.status === 'pending' && admins.has(v.requestedBy);
  });
  console.log('\npending split requests raised by an admin: ' + stale.length);

  /* --list prints everything the app has written, by whoever wrote it. The
     seed never sets channel 'app', so this is exactly the set of orders
     typed into the CRM - which is where a test close from a build session
     would be hiding. Worth looking at before moving anything: reassigning a
     test order to a rep is worse than leaving it where it is. */
  if (args.includes('--list')) {
    const app = orders.docs.map(d => ({ id: d.id, o: d.data() || {} }))
      .filter(x => x.o.channel === 'app')
      .sort((a, b) => String(a.o.orderDate).localeCompare(String(b.o.orderDate)));
    console.log('\n--- every order logged in the app: ' + app.length + ', '
      + inr(app.reduce((n, x) => n + (x.o.value || 0), 0)) + ' ---');
    const by = {};
    app.forEach(x => {
      const k = x.o.bookedBy || '(nobody)';
      by[k] = by[k] || { n: 0, v: 0 };
      by[k].n++; by[k].v += x.o.value || 0;
    });
    Object.entries(by).sort((a, b) => b[1].v - a[1].v).forEach(([u, s]) =>
      console.log('   ' + (name[u] || u).padEnd(14) + String(s.n).padStart(4)
        + ' orders   ' + inr(s.v)));
    console.log('');
    app.forEach(x => console.log('   ' + String(x.o.orderDate || '').slice(0, 10)
      + '  ' + inr(x.o.value || 0).padStart(14)
      + '  ' + (name[x.o.bookedBy] || '?').padEnd(12)
      + '  ' + (accName[x.o.accountId] || '?').slice(0, 26).padEnd(26)
      + '  inv ' + String(x.o.invoiceNumber || '-').slice(0, 20).padEnd(20)
      + '  ' + x.id));
    console.log('\nAnything here you do not recognise is a test close. Delete '
      + 'those rather than moving them onto a rep.');
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to make these changes, or --list to see '
      + 'every order the app has written.');
    process.exit(0);
  }

  for (let i = 0; i < hits.length; i += 450) {
    const batch = db.batch();
    hits.slice(i, i + 450).forEach(h => batch.update(h.ref, {
      creditSplit: { [h.own]: 1 },
      creditPending: false,
      enteredOnBehalf: true
    }));
    await batch.commit();
  }
  console.log('moved ' + hits.length + ' orders');

  for (let i = 0; i < stale.length; i += 450) {
    const batch = db.batch();
    stale.slice(i, i + 450).forEach(d => batch.update(d.ref, {
      status: 'withdrawn',
      note: 'Raised by the head against himself; the order now counts to the '
          + 'account owner.'
    }));
    await batch.commit();
  }
  console.log('closed ' + stale.length + ' split requests');
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('\n' + (e.stack || e)); process.exit(1); });
