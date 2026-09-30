/**
 * Paradise Institutional Sales CRM - Cloud Functions
 *
 * Deploy:  cd functions && npm install && firebase deploy --only functions
 *
 * NOTIFICATION RULE (non-negotiable, from the Project Flow incident):
 *   - fire once per STATE CHANGE, never on edit
 *   - recipients are always the specific owner plus their manager
 *   - no broadcast lists, ever
 *   - every send is written to notifyLog with its recipient list
 */
const functions = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const REGION = 'asia-south1';

/* ------------------------------------------------------------------- mail
 * Credentials live in Google Secret Manager, not in the old runtime config.
 * `functions.config()` was deprecated in firebase-functions 6.0.0 and new
 * deploys using it stop working after March 2027, so there is no reason to
 * start there. Set them once:
 *
 *   firebase functions:secrets:set MAIL_USER     # the sending Gmail address
 *   firebase functions:secrets:set MAIL_PASS     # a Gmail app password
 *
 * Every function that sends email must declare them in runWith({ secrets }),
 * otherwise .value() is empty at runtime. MAIL_SECRETS is that list.
 */
const MAIL_USER = defineSecret('MAIL_USER');
const MAIL_PASS = defineSecret('MAIL_PASS');
const MAIL_SECRETS = [MAIL_USER, MAIL_PASS];

// Built on first use: at module load the secret values are not yet available.
let _mailer = null;
function mailer() {
  if (!_mailer) {
    _mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: MAIL_USER.value(), pass: MAIL_PASS.value() }
    });
  }
  return _mailer;
}
const mailFrom = () => 'Paradise Sales <' + MAIL_USER.value() + '>';

// Shorthand for a function that sends email.
const sender = () => functions.runWith({ secrets: MAIL_SECRETS }).region(REGION);

const ALLOWED_DOMAIN = '@paradisefoodcourt.in';

/* ------------------------------------------------------------------ config */
const DEFAULT_CONFIG = {
  rateNew: 0.017, rateOld: 0.010, rateMsn: 0.003,
  floor: 0.80, cap: 1.20, gateOld: 0.99, headShare: 0.50,
  // each bucket is measured against its own target; overall is not used
  gateBasis: 'monthly',
  // Weighted-pipeline multipliers, editable in Admin. Nothing server-side
  // uses them today; they live here so meta/config has one documented shape.
  stageWeights: [0.10, 0.25, 0.45, 0.60, 0.80],
  slaByStage: [3, 5, 5, 4, 7],
  winbackActionDays: 7,
  handoffSlaHours: 24,
  ageingOrdersToPromote: 2,
  currentFY: 2027
};

async function getConfig() {
  const snap = await db.collection('meta').doc('config').get();
  return Object.assign({}, DEFAULT_CONFIG, snap.exists ? snap.data() : {});
}

/* ------------------------------------------------------------ Indian dates
   Every date in this system is an Indian calendar date, and Cloud Functions
   run in UTC. dailyFollowUpCheck fires at 03:30 IST, which is 22:00 UTC the
   PREVIOUS day, so new Date().toISOString().slice(0,10) returned yesterday -
   the overdue check ran against the wrong day, every single day.

   Adding the offset and then reading the UTC fields gives the Indian wall
   clock, which is what every stored date means. */
const IST_MS = 330 * 60000;
const istDate  = d => new Date((d ? d.getTime() : Date.now()) + IST_MS)
  .toISOString().slice(0, 10);
const istStamp = d => new Date((d ? d.getTime() : Date.now()) + IST_MS)
  .toISOString().slice(0, 19);

/* --------------------------------------------------------------- utilities */
const name0 = e => String(e || '').split('@')[0];
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

async function notify(recipients, subject, html, reason) {
  const to = [...new Set(recipients.filter(Boolean))];
  if (!to.length) return;
  if (to.length > 4) {
    // A guard, not a limit: no legitimate notification in this system
    // reaches more than an owner, a manager and the admin.
    console.error('REFUSED: recipient list too large', reason, to.length);
    await db.collection('notifyLog').add({
      reason, refused: true, count: to.length,
      at: admin.firestore.FieldValue.serverTimestamp()
    });
    return;
  }
  await mailer().sendMail({
    from: mailFrom(),
    to: to.join(','), subject, html
  });
  await db.collection('notifyLog').add({
    reason, to, subject, at: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function userDoc(uid) {
  if (!uid) return null;
  const s = await db.collection('users').doc(uid).get();
  return s.exists ? Object.assign({ id: s.id }, s.data()) : null;
}

async function ownerAndManager(uid) {
  const u = await userDoc(uid);
  if (!u) return [];
  const m = u.managerId ? await userDoc(u.managerId) : null;
  return [u.email, m && m.email].filter(Boolean);
}

/* ============================================ sign-in
 * Same shape as Project Flow and the Mystery Audit dashboard, so the team
 * meets one login everywhere:
 *
 *   Log in    ->  email + password, native Firebase Auth, no code to fetch
 *   Sign up   ->  email  ->  6-digit code  ->  set a password  (3 steps)
 *   Forgot    ->  Firebase's own reset email, sent from the client
 *
 * The code exists only to prove the person controls the address. It is not
 * part of signing in day to day, which is the whole point: a rep logging a
 * visit from a shop floor should not have to go and find an email first.
 *
 * Passwords are Firebase Auth's problem, not ours: it hashes them, throttles
 * guesses and owns the reset flow. Nothing here ever sees or stores one.
 *
 * The one subtlety is the uid. firestore.rules resolves a caller by
 * get(/users/$(request.auth.uid)), so the Auth uid MUST equal the users
 * document id. The seed already created documents keyed 'usr_<hash of name>'
 * and 2,012 accounts point at them, so for anyone already in the seed we
 * create the Auth user with that SAME id rather than letting Firebase mint a
 * fresh one. Get this wrong and Sameer signs in to an empty tool while his
 * 700 accounts sit under an id nothing is attached to.
 */
const OTP_TTL_MS      = 10 * 60 * 1000;   // code is valid for 10 minutes
const VERIFIED_TTL_MS = 20 * 60 * 1000;   // password must be set within 20
const MAX_OTP_TRIES   = 5;

async function authUserByEmail(email) {
  try {
    return await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code === 'auth/user-not-found') return null;
    throw e;
  }
}

async function userDocByEmail(email) {
  const q = await db.collection('users').where('email', '==', email).limit(1).get();
  return q.empty ? null : Object.assign({ id: q.docs[0].id }, q.docs[0].data());
}

function cleanEmail(v) {
  const email = String(v || '').trim().toLowerCase();
  if (!email.endsWith(ALLOWED_DOMAIN)) {
    throw new functions.https.HttpsError('permission-denied',
      'Only ' + ALLOWED_DOMAIN + ' addresses can sign up here.');
  }
  return email;
}

/* ---- step 1: send the code ---------------------------------------------- */
exports.requestSignupOtp = sender().https.onCall(async (data) => {
  const email = cleanEmail(data.email);

  // Already has a password? Send them to the log-in tab instead of quietly
  // starting a second signup.
  if (await authUserByEmail(email)) {
    throw new functions.https.HttpsError('already-exists',
      'An account already exists for this email. Log in instead, or use '
      + 'Forgot password.');
  }

  const known = await userDocByEmail(email);
  if (known && known.active === false) {
    throw new functions.https.HttpsError('permission-denied',
      'That account has been deactivated. Ask Ayush to switch it back on.');
  }

  const code = String(crypto.randomInt(100000, 999999));
  await db.collection('otps').doc(email).set({
    hash: crypto.createHash('sha256').update(code).digest('hex'),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    verified: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await mailer().sendMail({
    from: mailFrom(),
    to: email,
    subject: code + ' is your Paradise Sales verification code',
    html: '<p style="font-family:system-ui">Your code is <b style="font-size:22px;'
        + 'letter-spacing:3px">' + code + '</b></p>'
        + '<p style="font-family:system-ui;color:#666">It expires in 10 minutes. '
        + 'Enter it to finish setting up your account. If you did not ask for '
        + 'it, ignore this email.</p>'
  });

  // isKnown says the seed already has this person, so the signup screen can
  // skip asking for a name it already knows.
  return { ok: true, isKnown: !!known, name: known ? known.name : null };
});

/* ---- step 2: check the code -------------------------------------------- */
exports.verifySignupOtp = functions.region(REGION).https.onCall(async (data) => {
  const email = cleanEmail(data.email);
  const code = String(data.otp || data.code || '').trim();
  const ref = db.collection('otps').doc(email);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Request a new code.');
  }

  const o = snap.data();
  if (Date.now() > o.expiresAt) {
    await ref.delete();
    throw new functions.https.HttpsError('deadline-exceeded',
      'That code expired. Request a new one.');
  }
  if (o.attempts >= MAX_OTP_TRIES) {
    await ref.delete();
    throw new functions.https.HttpsError('resource-exhausted',
      'Too many tries. Request a new code.');
  }
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  if (hash !== o.hash) {
    await ref.update({ attempts: o.attempts + 1 });
    throw new functions.https.HttpsError('permission-denied', 'That code is wrong.');
  }

  // Verified, but not spent: step 3 redeems it when the password is set.
  await ref.update({
    verified: true,
    verifiedAt: Date.now(),
    expiresAt: Date.now() + VERIFIED_TTL_MS
  });
  return { ok: true };
});

/* ---- step 3: set the password, create the account ---------------------- */
exports.completeSignup = sender().https.onCall(async (data) => {
  const email = cleanEmail(data.email);
  const password = String(data.password || '');
  if (password.length < 8) {
    throw new functions.https.HttpsError('invalid-argument',
      'Password must be at least 8 characters.');
  }

  // Check for an existing account FIRST. A second press of Create account -
  // after the first one already succeeded and spent the code - used to fall
  // through to 'Verify your email first', which sent people back to re-verify
  // an address that was already registered. The account existing is the more
  // specific fact, so it is the one worth reporting.
  if (await authUserByEmail(email)) {
    throw new functions.https.HttpsError('already-exists',
      'An account already exists for this email. Log in instead, or use '
      + 'Forgot password.');
  }

  const ref = db.collection('otps').doc(email);
  const snap = await ref.get();
  const o = snap.exists ? snap.data() : null;
  if (!o) {
    throw new functions.https.HttpsError('not-found',
      'That verification has expired or was already used. Start the sign-up '
      + 'again to get a fresh code.');
  }
  if (!o.verified) {
    throw new functions.https.HttpsError('permission-denied',
      'Enter the 6-digit code before setting a password.');
  }
  if (Date.now() > o.expiresAt) {
    await ref.delete();
    throw new functions.https.HttpsError('deadline-exceeded',
      'That took more than 20 minutes. Start the sign-up again.');
  }

  // Reuse the seeded document id where there is one, so ownership survives.
  const known = await userDocByEmail(email);
  const uid = known
    ? known.id
    : 'usr_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);

  // A seeded person keeps the name the reports already show. Only somebody
  // genuinely new gets to type their own.
  const displayName = known && known.name
    ? known.name
    : (String(data.name || '').trim().replace(/\s+/g, ' ').slice(0, 60) || name0(email));

  await admin.auth().createUser({ uid, email, password, displayName });

  // Everything that carries privilege is decided here, never taken from the
  // client: role is 'rep' and there is no manager until Ayush sets one. merge
  // leaves a seeded rep's role, manager and region untouched.
  await db.collection('users').doc(uid).set(Object.assign({
    name: displayName, email, active: true,
    lastSignupAt: admin.firestore.FieldValue.serverTimestamp()
  }, known ? {} : {
    role: 'rep', managerId: null, region: '', selfRegistered: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }), { merge: true });

  await ref.delete();

  if (!known) {
    const admins = await db.collection('users').where('role', '==', 'admin').get();
    await notify(admins.docs.map(d => d.data().email),
      'New sign-up: ' + displayName,
      '<p style="font-family:system-ui"><b>' + esc(displayName) + '</b> ('
      + esc(email) + ') created an account and is in as a rep.</p>'
      + '<p style="font-family:system-ui">They have no manager yet, so their '
      + 'target and incentive roll up to nobody. Set one on the Admin screen. '
      + 'If you do not recognise this person, deactivate them there.</p>',
      'self-registration');
  }

  const token = await admin.auth().createCustomToken(uid, { email });
  return { token, uid, created: !known };
});

/* ------------------------------------ stage transitions: validate + record */
const STAGE = { C0: 0, C1: 1, C2: 2, C2F: 3, C3: 4, C4: 5, CANCELLED: 6 };

exports.onOpportunityWrite = sender()
  .firestore.document('opportunities/{id}')
  .onWrite(async (change, ctx) => {
    if (!change.after.exists) return null;
    const after = change.after.data();
    const before = change.before.exists ? change.before.data() : null;
    if (before && before.stage === after.stage) return null;   // edit, not a move

    // A bulk import is not a stage change. Without this, the first
    // load_seed.js run appended 2,012 "created at stage N" rows dated the day
    // of the load, which is what buried the 618 real transitions the workbook
    // carried. Later loads are merges and already return above.
    if (!before && (after.createdBy === 'import' || after.updatedBy === 'import')) {
      return null;
    }

    const cfgv = await getConfig();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // append to stage history
    const daysIn = before && before.stageSince
      ? Math.round((Date.now() - new Date(before.stageSince).getTime()) / 864e5)
      : null;
    await db.collection('stageHistory').add({
      opportunityId: ctx.params.id,
      fromStage: before ? before.stage : null,
      toStage: after.stage,
      changedAt: now,
      changedBy: after.updatedBy || 'system',
      daysInPrevious: daysIn
    });
    await change.after.ref.update({ stageSince: istDate() });

    // notify once, scoped
    const acct = await db.collection('accounts').doc(after.accountId).get();
    const name = acct.exists ? acct.data().name : after.name;
    const to = await ownerAndManager(after.owner);
    const high = (after.confirmedValue || after.expectedValue || 0) >= 200000;
    if (after.stage >= STAGE.C3 && high) {
      await notify(to,
        name + ' moved to ' + Object.keys(STAGE)[after.stage],
        '<p style="font-family:system-ui">' + name + ' is now <b>'
        + Object.keys(STAGE)[after.stage] + '</b>.</p>',
        'stage-change-highvalue');
    }
    return null;
  });

/* --------------------------------------- daily: SLA breaches and reminders */
exports.dailyFollowUpCheck = sender()
  .pubsub.schedule('30 3 * * *').timeZone('Asia/Kolkata')
  .onRun(async () => {
    const cfgv = await getConfig();
    const today = istDate();
    const snap = await db.collection('opportunities').where('stage', '<', 5).get();

    const byOwner = {};
    snap.forEach(doc => {
      const o = doc.data();
      if (!o.nextActionDate || o.nextActionDate >= today) return;
      const late = Math.round((Date.now() - new Date(o.nextActionDate).getTime()) / 864e5);
      const sla = cfgv.slaByStage[o.stage] || 5;
      if (late < sla) return;                       // still inside grace
      (byOwner[o.owner] = byOwner[o.owner] || []).push({
        name: o.name, late, sla, stage: o.stage,
        value: o.confirmedValue || o.expectedValue || 0,
        critical: late > sla * 3
      });
    });

    for (const uid of Object.keys(byOwner)) {
      const items = byOwner[uid].sort((a, b) => b.late - a.late);
      const to = await ownerAndManager(uid);
      const rows = items.slice(0, 20).map(i =>
        '<tr><td>' + i.name + '</td><td align="right">' + i.late
        + 'd late</td><td align="right">Rs ' + Math.round(i.value).toLocaleString('en-IN')
        + '</td><td>' + (i.critical ? 'critical' : 'past SLA') + '</td></tr>').join('');
      await notify(to,
        items.length + ' follow-up' + (items.length > 1 ? 's' : '') + ' past SLA',
        '<div style="font-family:system-ui"><p>These are past their stage SLA.</p>'
        + '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">'
        + rows + '</table></div>',
        'sla-breach');
    }
    return null;
  });

/* -------------------------------------- monthly: win-back queue generation */
exports.monthlyWinback = sender()
  .pubsub.schedule('0 4 1 * *').timeZone('Asia/Kolkata')
  .onRun(async () => {
    const cfgv = await getConfig();
    const now = new Date();
    const ly = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    const lyEnd = new Date(now.getFullYear() - 1, now.getMonth() + 1, 0);
    // ly and lyEnd are built from local Y/M/D, so format them the same way
    // rather than through UTC, which would walk the 1st back to the 31st.
    const from = istDate(new Date(ly.getTime() + ly.getTimezoneOffset() * 60000));
    const to   = istDate(new Date(lyEnd.getTime() + lyEnd.getTimezoneOffset() * 60000));

    const orders = await db.collection('orders')
      .where('orderDate', '>=', from).where('orderDate', '<=', to).get();

    // accounts billed in the same month last year
    const lastYear = {};
    orders.forEach(d => {
      const o = d.data();
      if (!o.value) return;
      const a = lastYear[o.accountId] = lastYear[o.accountId]
        || { value: 0, bookedBy: o.bookedBy };
      a.value += o.value;
    });

    // accounts with an open deal today
    const open = new Set();
    const opps = await db.collection('opportunities').where('stage', '<', 5).get();
    opps.forEach(d => open.add(d.data().accountId));

    const due = istDate(new Date(Date.now() + cfgv.winbackActionDays * 864e5));

    let made = 0;
    const byOwner = {};
    for (const accountId of Object.keys(lastYear)) {
      if (open.has(accountId)) continue;
      const acct = await db.collection('accounts').doc(accountId).get();
      if (!acct.exists) continue;
      const info = lastYear[accountId];
      let owner = info.bookedBy;
      const u = await userDoc(owner);
      if (!u || u.active === false) {                 // rep has left
        owner = (u && u.managerId) || acct.data().owner;
      }
      await db.collection('opportunities').add({
        accountId, name: acct.data().name, owner, stage: STAGE.C1,
        stageSince: istDate(),
        expectedValue: info.value, nextActionDate: due,
        nextActionType: 'Call', temperature: 'Warm',
        source: 'winback', createdAt: istStamp(),
        createdBy: 'winback-job'
      });
      (byOwner[owner] = byOwner[owner] || []).push(acct.data().name);
      made++;
    }

    for (const uid of Object.keys(byOwner)) {
      const to2 = await ownerAndManager(uid);
      await notify(to2,
        byOwner[uid].length + ' win-back account' + (byOwner[uid].length > 1 ? 's' : '')
        + ' raised to you',
        '<div style="font-family:system-ui"><p>These billed with you this month last '
        + 'year and have no open deal now. Follow-up due ' + due + '.</p><ul>'
        + byOwner[uid].slice(0, 30).map(n => '<li>' + n + '</li>').join('')
        + '</ul></div>',
        'winback');
    }
    console.log('win-back opportunities created:', made);
    return null;
  });

/* ------------------------ 1 April: promote clients with 2+ orders to "old" */
exports.annualClientAgeing = sender()
  .pubsub.schedule('0 2 1 4 *').timeZone('Asia/Kolkata')
  .onRun(async () => {
    const cfgv = await getConfig();
    const closingFY = cfgv.currentFY;
    const snap = await db.collection('accounts').where('clientClass', '==', 'new').get();

    let promoted = 0;
    let batch = db.batch(), n = 0;
    for (const doc of snap.docs) {
      const a = doc.data();
      const count = (a.orderCountByFY || {})[String(closingFY)] || 0;
      if (count < cfgv.ageingOrdersToPromote) continue;
      batch.update(doc.ref, {
        clientClass: 'old',
        classEffectiveFrom: istDate()
      });
      promoted++; n++;
      if (n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n) await batch.commit();

    await db.collection('meta').doc('config').set(
      { currentFY: closingFY + 1 }, { merge: true });

    const admins = await db.collection('users').where('role', '==', 'admin').get();
    await notify(admins.docs.map(d => d.data().email),
      promoted + ' clients promoted to old for FY' + (closingFY + 1),
      '<p style="font-family:system-ui">' + promoted + ' accounts had '
      + cfgv.ageingOrdersToPromote + ' or more orders in FY' + closingFY
      + ' and now attract the old-client rate.</p>',
      'client-ageing');
    console.log('promoted', promoted);
    return null;
  });

/* --------------------------------------------- incentive: callable, admin */
/*
 * Scheme, per Ayush 29-Sep-26. Each bucket is measured against ITS OWN
 * target. Overall achievement does not enter the calculation at all.
 *
 *   New client :  ach = newRevenue / newTarget
 *                 ach >= 80%  ->  newRevenue * 1.7% * min(ach, 120%)
 *                 below 80%   ->  0
 *                 e.g. ach 95%  ->  netSales * 1.7% * 95%
 *   Old client :  ach = oldRevenue / oldTarget
 *                 ach >= 99%  ->  oldRevenue * 1.0%   (flat, no band)
 *                 below 99%   ->  0
 *   MSN Lab    :  flat 0.3%, no gate, no band
 *   Head       :  the same three buckets run ONCE on collective totals and
 *                 collective targets, then halved. Not half the sum of reps.
 */
exports.calculateIncentive = functions.region(REGION).https.onCall(async (data, ctx) => {
  if (!ctx.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in.');
  const me = await userDoc(ctx.auth.uid);
  if (!me || me.active === false) {
    throw new functions.https.HttpsError('permission-denied', 'No access.');
  }
  const isAdmin = me.role === 'admin';
  const month = String(data.month || '').slice(0, 7);          // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new functions.https.HttpsError('invalid-argument', 'month must be YYYY-MM');
  }
  const c = await getConfig();

  /* Who may this caller see? An admin sees everyone; anybody else sees
     themselves plus whoever reports up to them, at any depth. Worked out
     here from the users collection, never taken from the client - the whole
     point is that a rep cannot ask for somebody else's payout. */
  const allUsers = [];
  (await db.collection('users').get()).forEach(d =>
    allUsers.push(Object.assign({ id: d.id }, d.data())));
  let scope;
  if (isAdmin) {
    scope = new Set(allUsers.map(u => u.id));
  } else {
    scope = new Set([ctx.auth.uid]);
    const walk = (p, depth) => {
      if (depth > 20) return;                       // cycle guard
      allUsers.filter(u => u.managerId === p).forEach(u => {
        if (scope.has(u.id)) return;
        scope.add(u.id);
        walk(u.id, depth + 1);
      });
    };
    walk(ctx.auth.uid, 0);
  }

  const from = month + '-01';
  const to = month + '-31';
  const [ordersSnap, targetsSnap, accountsSnap] = await Promise.all([
    db.collection('orders').where('orderDate', '>=', from).where('orderDate', '<=', to).get(),
    db.collection('targets').where('month', '==', month).get(),
    db.collection('accounts').get()
  ]);

  const klass = {}, isMsn = {};
  accountsSnap.forEach(d => {
    const a = d.data();
    klass[d.id] = a.clientClass || 'new';
    isMsn[d.id] = /msn/i.test(a.nameNormalised || a.name || '');
  });

  // revenue by rep and bucket
  const per = {};
  const blank = () => ({ newRev: 0, oldRev: 0, msnRev: 0,
                         newTarget: 0, oldTarget: 0, overallTarget: 0 });
  /* Revenue follows CREDIT, not authorship. An order booked on somebody
     else's account carries a creditSplit - a map of user id to fraction -
     settled once by Ayush and then reused for that account. No split means
     it all belongs to whoever booked it, which covers every imported row
     and every order on a rep's own account. */
  ordersSnap.forEach(d => {
    const o = d.data();
    const split = o.creditSplit
      || (o.bookedBy ? { [o.bookedBy]: 1 } : null);
    if (!split) return;
    Object.keys(split).forEach(uid => {
      const share = split[uid] || 0;
      if (!share) return;
      const amount = (o.value || 0) * share;
      const p = per[uid] = per[uid] || blank();
      if (isMsn[o.accountId]) p.msnRev += amount;
      else if (klass[o.accountId] === 'old') p.oldRev += amount;
      else p.newRev += amount;
    });
  });

  // Targets carry a bucket: 'overall' | 'new' | 'old'.
  //
  // Only rep-scoped targets count toward a rep's achievement. The named
  // accounts - JCNM Church, Azad Engineer, MSN Labs - are scope 'account'
  // with no userId: lumps that sit on top of the monthly numbers in the
  // sheet's Total Target row. Letting them through would both create a
  // phantom rep under the key null and, because the sheet repeats them in
  // the Old Order block, add MSN Labs' Rs 1.8 Cr to someone's oldTarget and
  // bury the 99% gate. MSN needs no target at all - it pays a flat 0.3%
  // with no gate and no band.
  const accountTargets = [];
  targetsSnap.forEach(d => {
    const t = d.data();
    if (t.scope === 'account' || !t.userId) { accountTargets.push(t); return; }
    const p = per[t.userId] = per[t.userId] || blank();
    if (t.bucket === 'new') p.newTarget += t.amount;
    else if (t.bucket === 'old') p.oldTarget += t.amount;
    else p.overallTarget += t.amount;
  });

  function newPay(rev, target) {
    if (!target) return { ach: 0, band: 0, pay: 0 };
    const ach = rev / target;
    if (ach < c.floor) return { ach, band: 0, pay: 0 };
    const band = Math.min(ach, c.cap);
    return { ach, band, pay: Math.round(rev * c.rateNew * band) };
  }
  function oldPay(rev, target) {
    if (!target) return { ach: 0, pay: 0 };
    const ach = rev / target;
    return { ach, pay: ach >= c.gateOld ? Math.round(rev * c.rateOld) : 0 };
  }

  const rows = [];
  const T = { newRev: 0, oldRev: 0, msnRev: 0,
              newTarget: 0, oldTarget: 0, overallTarget: 0, payout: 0 };

  for (const uid of Object.keys(per)) {
    const p = per[uid];
    const n = newPay(p.newRev, p.newTarget);
    const o = oldPay(p.oldRev, p.oldTarget);
    const msnPay = Math.round(p.msnRev * c.rateMsn);
    const u = await userDoc(uid);
    rows.push({
      uid, name: u ? u.name : uid,
      newRev: p.newRev, newTarget: p.newTarget, newAch: n.ach, newBand: n.band, newPay: n.pay,
      oldRev: p.oldRev, oldTarget: p.oldTarget, oldAch: o.ach, oldPay: o.pay,
      msnRev: p.msnRev, msnPay,
      overallTarget: p.overallTarget,
      overallActual: p.newRev + p.oldRev + p.msnRev,
      payout: n.pay + o.pay + msnPay
    });
    T.newRev += p.newRev; T.oldRev += p.oldRev; T.msnRev += p.msnRev;
    T.newTarget += p.newTarget; T.oldTarget += p.oldTarget;
    T.overallTarget += p.overallTarget;
    T.payout += n.pay + o.pay + msnPay;
  }

  // head's override: same buckets, once, on the collective, then halved
  const cn = newPay(T.newRev, T.newTarget);
  const co = oldPay(T.oldRev, T.oldTarget);
  const cm = Math.round(T.msnRev * c.rateMsn);
  const collective = cn.pay + co.pay + cm;
  const headPay = Math.round(collective * c.headShare);

  /* A rep gets their own row and nothing else. A manager gets their team's.
     The team totals, the collective and the head's override are whole-scheme
     figures, so they go to the admin alone - a rep seeing "total scheme cost"
     can work backwards to what everyone else earned. */
  const mine = rows.filter(r => scope.has(r.uid));

  const result = {
    month, config: c,
    scope: isAdmin ? 'all' : (mine.length > 1 ? 'team' : 'self'),
    rows: mine.sort((a, b) => b.payout - a.payout),
    yourPayout: mine.reduce((n, r) => n + r.payout, 0),
    // Reported, never paid on: the named-account lumps for this month.
    // Shown so the dashboard's target line matches the sheet's Total Target.
    calculatedAt: new Date().toISOString(), calculatedBy: ctx.auth.uid
  };

  if (isAdmin) {
    Object.assign(result, {
      team: T,
      collective: {
        newAch: cn.ach, newBand: cn.band, newPay: cn.pay,
        oldAch: co.ach, oldPay: co.pay, msnPay: cm, result: collective
      },
      headPayout: headPay,
      totalSchemeCost: T.payout + headPay,
      accountTargets: accountTargets
        .filter(t => t.bucket === 'overall')
        .map(t => ({ account: t.accountName, amount: t.amount }))
    });
    // Only the admin's run is the record. A rep's filtered view must never
    // overwrite the month's stored result with a one-row version of it.
    await db.collection('incentiveRuns').doc(month).set(result);
  }
  return result;
});

/* -------------------------------------------- audit trail on key documents */
['accounts', 'opportunities', 'orders', 'targets', 'users'].forEach(col => {
  exports['audit_' + col] = functions.region(REGION)
    .firestore.document(col + '/{id}')
    .onWrite(async (change, ctx) => {
      const before = change.before.exists ? change.before.data() : null;
      const after = change.after.exists ? change.after.data() : null;
      const who = (after && after.updatedBy) || (before && before.updatedBy) || 'system';
      const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
      const diffs = [];
      fields.forEach(f => {
        const a = before ? before[f] : undefined;
        const b = after ? after[f] : undefined;
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          diffs.push({ field: f, from: a === undefined ? null : a, to: b === undefined ? null : b });
        }
      });
      if (!diffs.length) return null;
      await db.collection('auditLog').add({
        collection: col, docId: ctx.params.id, changes: diffs.slice(0, 40),
        changedBy: who, changedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return null;
    });
});
