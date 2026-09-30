# Paradise Institutional Sales CRM

Replaces `DCR_Insti-Sales_FY-27.xlsx`. Same stack as Project Flow — GitHub Pages
front end, Firestore, Cloud Functions, 6-digit email OTP on
`@paradisefoodcourt.in` — but a **separate Firebase project and repo**, so a
Functions deploy on one tool can never reach the other.

```
paradise-crm/
├── firebase.json            project config
├── firestore.rules          server-enforced permissions
├── firestore.indexes.json   composite indexes
├── functions/index.js       OTP, stage validation, SLA alerts, win-back,
│                            client ageing, incentive, audit trail
├── seed/
│   ├── build_seed.py        Excel  →  Firestore-ready JSON
│   ├── load_seed.js         JSON   →  Firestore
│   ├── source/              put the three workbooks here (gitignored)
│   └── out/                 generated JSON (gitignored)
└── public/                  the app (next drop)
```

---

## Setup, once

### 1. Firebase project

1. console.firebase.google.com → **Add project** → `paradise-insti-crm`
2. Build → **Firestore Database** → Create → **Production mode** → region `asia-south1`
3. Build → **Authentication** → Get started, and enable **Email/Password** —
   only that one, leave Anonymous off. Same provider Project Flow and the
   Mystery Audit dashboard use.
   Also check **Authentication → Settings → Authorised domains** lists wherever
   you serve from. `web.app` and `firebaseapp.com` are there by default;
   `paradise-sudo.github.io` is not, and without it login and password reset
   fail with `auth/unauthorized-domain`.
4. Upgrade to **Blaze** — Functions need outbound network for email
5. Project settings → General → scroll to *Your apps* → **Web app** → register →
   copy the `firebaseConfig` block. You will paste it into `public/index.html`.

### 2. Local tools

```bash
npm install -g firebase-tools
firebase login
cd paradise-crm
firebase use --add            # pick paradise-insti-crm, alias "default"
```

### 3. Email sender

Use the same personal Gmail with an app password that Project Flow moved to.
Credentials go in Secret Manager, not the old `functions:config:set` runtime
config — that was deprecated in `firebase-functions` 6.0.0 and new deploys
using it stop working after March 2027.

```bash
firebase functions:secrets:set MAIL_USER     # paste the Gmail address
firebase functions:secrets:set MAIL_PASS     # paste the 16-char app password
```

Each command prompts for the value, so nothing lands in your shell history.
The five functions that send email declare both secrets in `runWith`; the rest
have no access to them.

### 4. Deploy rules and functions

```bash
firebase deploy --only firestore:rules,firestore:indexes
cd functions && npm install && cd ..
firebase deploy --only functions
```

Indexes take a few minutes to build. Check Firestore → Indexes before loading data.

---

## Loading the data

### 1. Build the seed

Put the three workbooks in `seed/source/` with exactly these names:

```
DCR_Insti-Sales_FY-27.xlsx
New_Analysis_Sheet_-_Bashab_Fin.xlsx
New_Analysis_Sheet-Sameer.xlsx
```

```bash
cd seed
pip install openpyxl
python3 build_seed.py
```

It writes JSON to `seed/out/` and prints a reconciliation. **Check
`totalActualFY27` against the DCR Dashboard before going further.** It should
read `39,990,850` — that is ₹399.9L, matching the workbook.

Current output:

| | |
|---|---|
| Rows read | 4,439 (3,320 history + 1,119 FY27) |
| Accounts | 2,012 |
| Opportunities | 2,012 |
| Activities | 4,439 |
| Orders | 2,111 |
| Stage history | 618 |
| Targets | 172 (166 rep + 6 named account) |
| FY27 actual | ₹3,99,90,850 |

Rep targets cover Nov-25 → Mar-27 for all five reps in all three buckets, and
`new + old` reconciles to `overall` on every one of the 62 rep-months.

### 2. Load it

```bash
npm install firebase-admin
# Firebase console > Project settings > Service accounts > Generate new private key
# save as seed/serviceAccountKey.json   (gitignored — never commit it)

node load_seed.js --dry      # counts only
node load_seed.js            # writes
```

Writes are idempotent — document IDs are hashes of natural keys, so re-running
updates rather than duplicating. Safe to re-run after fixing a mapping.

### 3. Set the admin

`seed/build_seed.py` creates a user for `kumar.ayush@paradisefoodcourt.in` with
role `admin` and one per rep. **Correct the rep email addresses at the top of
that file before the first load.** A wrong address does not lock that rep out —
self-registration means they get a second, empty account instead, with no
history, no targets and no manager, while their real record sits unused.

---

## Who can sign in

Same three screens as Project Flow and the Mystery Audit dashboard, so the team
meets one login everywhere:

| Screen | How it works |
|---|---|
| **Log in** | Email + password, native `signInWithEmailAndPassword`. No code to fetch. |
| **Sign up** | Three steps: email → 6-digit code → set a password. `@paradisefoodcourt.in` only. |
| **Forgot password** | Firebase's own reset email, via `sendPasswordResetEmail`. |

Passwords are Firebase Auth's business. It hashes them, throttles guessing and
owns the reset flow; nothing in `functions/index.js` ever sees one. The 6-digit
code exists only to prove the address at signup — it is not part of signing in
day to day, which is the point: a rep logging a visit from a shop floor should
not have to go and find an email first.

Callables: `requestSignupOtp` → `verifySignupOtp` → `completeSignup`. Only the
last one creates anything.

**The uid subtlety, which matters.** `firestore.rules` resolves a caller with
`get(/users/$(request.auth.uid))`, so the Auth uid must equal the users document
id. The seed already created documents keyed `usr_<hash of name>` and 2,012
accounts point at them, so `completeSignup` creates the Auth user with that
*same* id for anyone already seeded, rather than letting Firebase mint a fresh
one. Get this wrong and Sameer signs in to an empty tool while his deals sit
under an id nothing is attached to.

Self-registration is on, Ayush's decision 30-Sep-26: anyone with a working
`@paradisefoodcourt.in` address can sign up and is in as a rep. The domain check
is the only gate, so whoever controls a mailbox on that domain can read the whole
pipeline. What limits it:

- `completeSignup` writes `role: 'rep'` and `managerId: null` and never spreads
  client input into the document, so nobody can register as an admin. For a
  seeded rep, `merge` leaves their existing role, manager and region alone.
- Every genuinely new sign-up emails the admins through `notify()`, inside the
  four-recipient guard.
- `active: false` locks someone out **at the next read, not the next sign-in** —
  `isStaff()` checks it, because a minted token stays valid for the best part of
  an hour. `isAdmin()` deliberately does not, so an admin cannot lock themselves
  out of their own tool.

A new rep has no manager, so their target and incentive roll up to nobody until
one is assigned. That is intentional: a rep silently appearing under Sameer would
move both his target and his payout.

---

## Two things the seed does that matter

**April 2026 cutover.** Sameer's analysis sheet runs to 30 Apr 2026 and the FY27
workbook starts 1 Apr 2026, so 83 rows worth ₹29.4L sit in both. The builder
drops history rows on or after `CUTOVER`. Without it FY27 reads ₹4.29 Cr instead
of ₹4.00 Cr.

**The Target sheet is laid out sideways.** Its three blocks — Overall, New
Order, Old Order — sit side by side at columns 1, 20 and 39, each with its own
month header row, not stacked vertically. The parser reads column bands for
that reason. It also prefers the `Target` sheet over `Incentive Target MOM`,
which holds the same numbers but calls three of the reps `Person 1`…`Person 4`.

**Named accounts are reported, never paid on.** JCNM Church, Azad Engineer and
MSN Labs load with `scope: 'account'` and no `userId`, so they show on the
dashboard but never enter a rep's achievement. The workbook currently reads:

| Account | Month | Amount |
|---|---|---|
| Azad Engineer | Oct-26 | ₹30,00,000 |
| JCNM Church | Dec-26 | ₹45,00,000 |
| MSN Labs | Nov-26 | ₹1,80,00,000 |

Your screenshot showed Azad in **Nov-26** and MSN as **₹87L Jul-26 + ₹80L
Dec-26**, so that sheet is a later revision than the file I have. Send it and
re-run `build_seed.py` — the parser is generic and will pick the new rows up.

**Lead Status is not a temperature.** In 2,386 historical rows that column holds
a stage word (`Closed`, `Cancelled`, `Csncelled`) rather than Hot/Warm/Cold. The
builder reads stage from the `Status` column and leaves temperature blank rather
than inventing one.

---

## Config you can change without a deploy

Firestore → `meta/config`. Anything absent falls back to the defaults in
`functions/index.js`.

```json
{
  "rateNew": 0.017, "rateOld": 0.010, "rateMsn": 0.003,
  "floor": 0.80, "cap": 1.20, "gateOld": 0.99, "headShare": 0.50,
  "msnCountsTowardAchievement": true,
  "gateBasis": "monthly",
  "slaByStage": [3, 5, 5, 4, 7],
  "winbackActionDays": 7,
  "ageingOrdersToPromote": 2,
  "currentFY": 2027
}
```

The two worth deciding early: `msnCountsTowardAchievement` (Sameer read 1280% in
Jul-26 on MSN volume, pushing his new-client band to the cap) and `gateBasis`.

---

## Scheduled jobs

| Function | Runs | Does |
|---|---|---|
| `dailyFollowUpCheck` | 09:00 IST daily | SLA breaches → owner + manager, once |
| `monthlyWinback` | 09:30 IST, 1st | Raises last-year's clients with no open deal to whoever closed them |
| `annualClientAgeing` | 07:30 IST, 1 Apr | Promotes accounts with 2+ orders to old-client rate |

---

## The notification rule

From the Project Flow mass-email incident:

- Fire **once per state change**, never on edit
- Recipients are always **the specific owner plus their manager**
- `notify()` refuses any list over four addresses and logs the refusal
- Every send is written to `notifyLog` with its recipient list

Before re-enabling anything that sends, check `notifyLog` for `refused: true`.

---

## The app

`public/index.html` — one self-contained file, no build step. Paste your
`firebaseConfig` into the block near the top; nothing else needs editing.

Deploy: `firebase deploy --only hosting`, or push and let GitHub Pages serve
`public/`.

**Built and tested:**

- Email OTP sign-in on `@paradisefoodcourt.in`
- Role-based navigation behind the three-line menu. A rep sees Dashboard,
  Log activity, Pipeline, Exceptions, Win back, Shared accounts, Data &
  imports. A manager adds Incentive. Admin adds Admin.
- Date range picker in the header with MTD, Last month, QTD, YTD, Since Sep-23
  and custom. It defaults to month-to-date computed from the clock, so on 1 Oct
  it becomes 1–1 Oct with nobody touching it.
- Multi-select rep filter, scoped to who you may see
- Hover definitions on every abbreviation — C0…C4, C2F, SLA, SSSG, SPOC, MTD,
  QTD, YTD, FY, CPU, DCR
- **Log activity**, the rep's main screen: search by account name *or any part
  of a contact number*, create a new account inline with duplicate-name
  checking, log the activity, move the stage, set the next action.
  - Moving to C1 or C2 defaults the assignee to Anushikha and demands a typed
    reason to hand it elsewhere
  - Closing at C4 demands order value, invoice number and payment status, and
    writes the order. Payment status starts blank on purpose, so it is a choice
    and not a default.
  - Cancelling demands a loss reason
  - An open deal cannot be saved without a next action date
  - Nothing is written until validation passes

## Who sees what

Set by Ayush, 1-Oct-26.

| Screen | Rep | Manager | Admin |
|---|---|---|---|
| Dashboard | whole team | whole team | whole team |
| Log activity, Entry log, Pipeline, Win back, Incentive | own | own + reportees | everyone |
| Exceptions, Shared accounts, Client history, Data & imports, Admin | — | — | yes |

The Dashboard is deliberately everyone's, with the full team's numbers, so
nobody works from a private version of the total. Every other screen is a
working list and scopes to whoever reports up to the person signed in.

Note that this scoping is in the SCREENS, not the database. `firestore.rules`
lets any signed-in staff member read every collection, and the app holds the
lot in the browser before filtering. For a team of five that is the right
trade, but it is not a wall - anyone who opens developer tools can read
everything. Making it real means per-rep queries and document-level rules,
and would end the log-against-any-account rule that depends on the search
seeing every account.

## Credit splits

Anyone may log against any account. What that does not settle is whose target
it counts toward, so:

1. The first order booked on an account you do not own raises a request. The
   order counts to whoever booked it in the meantime, flagged `creditPending`.
2. Ayush approves it once with a ratio in Admin. The order that raised it is
   settled back to that date.
3. Every later order on that account uses the same split with no further
   approval.

An order carries its own `creditSplit` - a map of user id to fraction -
rather than pointing at the rule, so a split changed in March cannot silently
restate January. Both the dashboard's per-rep figures and
`calculateIncentive` read it.
