#!/usr/bin/env python3
"""
Paradise Institutional Sales CRM - seed builder.

Reads the three source workbooks and emits Firestore-ready JSON:
  out/users.json          out/accounts.json      out/contacts.json
  out/opportunities.json  out/activities.json    out/orders.json
  out/stageHistory.json   out/targets.json       out/importReport.json

Run:  python3 build_seed.py
Then: node load_seed.js      (see README)

Nothing is written to Firestore by this script.
"""
import openpyxl, datetime as dt, collections, json, re, os, sys, zipfile, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(HERE, 'source')
OUT  = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)

# Put the three workbooks in seed/source/ with these names.
F_CUR    = 'DCR_Insti-Sales_FY-27.xlsx'
F_BASHAB = 'New_Analysis_Sheet_-_Bashab_Fin.xlsx'
F_SAMEER = 'New_Analysis_Sheet-Sameer.xlsx'

REPS  = ['Sameer', 'Bashab', 'Vishwanath', 'Pradeep', 'Anushikha']
# Real addresses, confirmed by Ayush 30-Sep-26. Lower case is not cosmetic:
# completeSignup looks a person up with where('email','==',<lowercased>), so a
# stored address carrying a capital would never match and that rep would get a
# second, empty account. .lower() below makes that impossible to get wrong.
EMAIL = {k: v.strip().lower() for k, v in {
    'Sameer':     'Sameer.rahangdale@paradisefoodcourt.in',
    'Bashab':     'bashab.datta@paradisefoodcourt.in',
    'Vishwanath': 'vishwanath.ks@paradisefoodcourt.in',
    'Pradeep':    'pradeep.kumar@paradisefoodcourt.in',
    'Anushikha':  'anushika.choudhury@paradisefoodcourt.in',   # note: anushika, no 'h'
}.items()}
MANAGER = {'Pradeep': 'Sameer', 'Anushikha': 'Sameer', 'Vishwanath': 'Bashab'}
# Accounts that count as NEW clients regardless of when they first ordered.
FORCE_NEW = ('azadengineer', 'jcnm')   # 'Azad Engineer' AND 'Azad Engineering'


def tgt_id(owner, month, bucket):
    """Readable, predictable target id: tgt_<owner>_<month>_<bucket>.

    Deliberately NOT a hash. The Admin screen edits targets in the browser,
    where md5 is not available, so the app has to be able to construct the
    same id the seed does. Without that, editing a target in the app and
    re-running the seed later would leave two documents for the same
    rep-month-bucket, and whichever loaded last would silently win.
    """
    return 'tgt_%s_%s_%s' % (owner, month, bucket)
ADMIN_EMAIL = 'kumar.ayush@paradisefoodcourt.in'.strip().lower()

# The FY27 workbook is authoritative from this date; history rows on or after
# it are dropped to avoid double-counting the April 2026 overlap.
CUTOVER = dt.datetime(2026, 4, 1)
CURRENT_FY = 2027

REGIONS = ['Hyderabad', 'Bangalore', 'Chennai']
TYPES   = ['Corporate', 'Aggregator', 'Bulk Order', 'ODC', 'Gifting']
AGGS    = ['Compass', 'Gokhana', 'Hunger Box', 'Meals & More', 'Pinnacle', 'SmartQ']

# 0 C0, 1 C1, 2 C2, 3 C2F, 4 C3, 5 C4, 6 Cancelled
STAGE_NAMES = ['C0', 'C1', 'C2', 'C2F', 'C3', 'C4', 'Cancelled']

report = collections.Counter()
notes  = []


def norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())


def uid(person):
    """User document id: sha256 of the email address, first 16 hex characters.

    This MUST stay identical to completeSignup in functions/index.js, which
    computes the same thing when somebody registers. Key users by an md5 of
    their NAME, as this did until 30-Sep-26, and a rep who signs up before the
    seed is loaded gets a SECOND document - one from each scheme - and signs
    in to an empty tool while their real deals sit under an id nothing is
    attached to.
    """
    email = ADMIN_EMAIL if person == 'Ayush' else EMAIL[person]
    return 'usr_' + hashlib.sha256(email.strip().lower().encode()).hexdigest()[:16]


def sid(prefix, key):
    return prefix + '_' + hashlib.md5(key.encode()).hexdigest()[:16]


def stage_of(raw):
    t = str(raw or '').lower()
    for k, v in [('intro', 0), ('follow', 1), ('nego', 2), ('confirm', 4),
                 ('close', 5), ('cancel', 6)]:
        if k in t:
            return v
    report['stage_unparsed'] += 1
    return 6


def region_of(raw):
    r = str(raw or '').strip()
    if r in REGIONS:
        return r
    if r:
        report['region_other'] += 1
        notes.append('Region outside the three: %s' % r)
    return 'Other'


def type_of(raw):
    t = str(raw or '').strip()
    if t in TYPES:
        return t
    tl = t.lower()
    for x in TYPES:
        if x.lower() == tl:
            report['type_case_fixed'] += 1
            return x
    if t:
        report['type_unmapped'] += 1
        notes.append('Account type with no FY27 equivalent: %s' % t)
    # DECISION §8: historic categories map to Corporate until told otherwise
    return 'Corporate'


def as_date(v):
    if not isinstance(v, dt.datetime):
        return None
    if v.year < 2023 or v.year > 2027:
        report['date_rejected'] += 1
        return None
    return v


def money(v):
    return float(v) if isinstance(v, (int, float)) else 0.0


def fy_of(d):
    return d.year + (1 if d.month >= 4 else 0)


def open_clean(path):
    """openpyxl chokes on one workbook's pivot cache; strip it first."""
    try:
        return openpyxl.load_workbook(path, data_only=True)
    except TypeError:
        tmp = path + '.clean.xlsx'
        zin = zipfile.ZipFile(path)
        zout = zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED)
        for n in zin.namelist():
            if 'pivot' in n.lower():
                continue
            data = zin.read(n)
            if n == 'xl/workbook.xml':
                data = re.sub(rb'<pivotCaches>.*?</pivotCaches>', b'', data, flags=re.S)
            if n.endswith('.rels'):
                data = re.sub(rb'<Relationship[^>]*pivot[^>]*/>', b'', data)
            if n == '[Content_Types].xml':
                data = re.sub(rb'<Override[^>]*pivot[^>]*/>', b'', data)
            zout.writestr(n, data)
        zout.close(); zin.close()
        report['pivot_cache_stripped'] += 1
        return openpyxl.load_workbook(tmp, data_only=True)


# ---------------------------------------------------------------- read rows
# Unified row shape:
# date, rep, region, accountName, connect, acctType, aggregator, spocName,
# spocPhone, remarks, stage, nextActionDate, nextActionType, temperature,
# expected, actual, orderDate, invoiceNo, store, hoStatus, isRepeat,
# industry, lossReason, source
rows = []

# --- historical workbooks (one file per rep, different schema) -------------
HIST_COLS = dict(date=0, account=1, connect=2, type=3, industry=4, spoc=5,
                 remarks=6, expected=7, actual=8, region=10, status=11,
                 lead=12, reason=13)

for fname, rep in [(F_BASHAB, 'Bashab'), (F_SAMEER, 'Sameer')]:
    path = os.path.join(SRC, fname)
    if not os.path.exists(path):
        print('MISSING: %s  (skipping)' % path, file=sys.stderr)
        continue
    ws = open_clean(path)['DCR']
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r[HIST_COLS['account']]:
            continue
        d = as_date(r[HIST_COLS['date']])
        if not d:
            continue
        # CUTOVER: the FY27 workbook is authoritative from 1 Apr 2026.
        # Sameer's analysis sheet runs to 30 Apr 2026, so 83 rows worth
        # Rs 29.4L overlap. Without this the FY27 total reads 4.29 Cr
        # instead of the workbook's 4.00 Cr.
        if d >= CUTOVER:
            report['history_after_cutover_dropped'] += 1
            continue
        lead = str(r[HIST_COLS['lead']] or '')
        # Lead Status holds a stage word in 2,386 rows - do not guess a temperature
        temp = lead if lead in ('Hot', 'Warm', 'Cold') else ''
        if lead and not temp:
            report['leadstatus_held_stage'] += 1
        rows.append(dict(
            date=d, rep=rep, region=region_of(r[HIST_COLS['region']]),
            account=str(r[HIST_COLS['account']]).strip(),
            connect=str(r[HIST_COLS['connect']] or ''),
            acctType=type_of(r[HIST_COLS['type']]), aggregator='',
            spocName=str(r[HIST_COLS['spoc']] or '').strip(), spocPhone='',
            remarks=str(r[HIST_COLS['remarks']] or '').strip(),
            stage=stage_of(r[HIST_COLS['status']]),
            nextActionDate=None, nextActionType='', temperature=temp,
            expected=money(r[HIST_COLS['expected']]),
            actual=money(r[HIST_COLS['actual']]),
            orderDate=None, invoiceNo='', store='', hoStatus='',
            isRepeat='', industry=str(r[HIST_COLS['industry']] or '').strip(),
            lossReason=str(r[HIST_COLS['reason']] or '').strip(), source='history'))
        report['rows_history'] += 1

# --- current FY27 workbook -------------------------------------------------
CUR = dict(date=0, rep=1, region=2, account=3, connect=4, type=5, agg=6,
           business=7, repeat=8, industry=9, spoc=10, phone=11, remarks=12,
           status=13, nad=14, nat=15, lead=18, expected=19, actual=20,
           orderDate=21, invoice=22, store=23, ho=24)

path = os.path.join(SRC, F_CUR)
if os.path.exists(path):
    ws = open_clean(path)['DCR']
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r[CUR['account']]:
            continue
        d = as_date(r[CUR['date']])
        if not d:
            continue
        rep = next((x for x in REPS if x.lower() in str(r[CUR['rep']]).lower()), '')
        if not rep:
            report['rep_unmatched'] += 1
        lead = str(r[CUR['lead']] or '')
        rows.append(dict(
            date=d, rep=rep, region=region_of(r[CUR['region']]),
            account=str(r[CUR['account']]).strip(),
            connect=str(r[CUR['connect']] or ''),
            acctType=type_of(r[CUR['type']]),
            aggregator=str(r[CUR['agg']] or '').strip(),
            spocName=str(r[CUR['spoc']] or '').strip(),
            spocPhone=re.sub(r'\D', '', str(r[CUR['phone']] or ''))[-10:],
            remarks=str(r[CUR['remarks']] or '').strip(),
            stage=stage_of(r[CUR['status']]),
            nextActionDate=as_date(r[CUR['nad']]),
            nextActionType=str(r[CUR['nat']] or ''),
            temperature=lead if lead in ('Hot', 'Warm', 'Cold') else '',
            expected=money(r[CUR['expected']]), actual=money(r[CUR['actual']]),
            orderDate=as_date(r[CUR['orderDate']]),
            invoiceNo=str(r[CUR['invoice']] or '').strip(),
            store=str(r[CUR['store']] or '').strip(),
            hoStatus=str(r[CUR['ho']] or '').strip(),
            isRepeat=str(r[CUR['repeat']] or ''),
            industry=str(r[CUR['industry']] or '').strip(),
            lossReason='', source='fy27'))
        report['rows_fy27'] += 1
else:
    print('MISSING: %s' % path, file=sys.stderr)

rows.sort(key=lambda x: x['date'])
report['rows_total'] = len(rows)

# ---------------------------------------------------------------- users
users = []
for r in REPS:
    users.append(dict(id=uid(r), name=r, email=EMAIL[r], role='rep',
                      managerId=uid(MANAGER[r]) if r in MANAGER else None,
                      region='', active=True))
for u in users:
    if any(v == u['id'] for v in
           [uid(m) for m in MANAGER.values()]):
        u['role'] = 'manager'
users.append(dict(id=uid('Ayush'), name='Ayush', email=ADMIN_EMAIL,
                  role='admin', managerId=None, region='', active=True))

# ---------------------------------------------------------------- accounts
by_account = collections.defaultdict(list)
for r in rows:
    by_account[norm(r['account'])].append(r)

accounts, contacts, opportunities, activities, orders, stage_hist = [], [], [], [], [], []
seen_phone = {}

for key, rs in by_account.items():
    rs.sort(key=lambda x: x['date'])
    last, first = rs[-1], rs[0]
    aid = sid('acc', key)

    paid = [x for x in rs if x['actual'] > 0]
    first_order = paid[0]['date'] if paid else None
    orders_by_fy = collections.Counter(fy_of(x['date']) for x in paid)

    # client class: old if first order in an earlier FY than the current one
    cur_fy = CURRENT_FY
    klass = 'old' if (first_order and fy_of(first_order) < cur_fy) else 'new'

    # Ayush, 30-Sep-26: Azad Engineering and JCNM Church count as NEW clients
    # for incentive, whatever their order history says. Matched on the
    # normalised name and deliberately narrow - 'church' alone hits 38
    # unrelated accounts, so only JCNM is taken. MSN is untouched: it has its
    # own flat 0.3% and is neither new nor old.
    if any(h in key for h in FORCE_NEW):
        klass = 'new'
        report['forced_new_client'] += 1
        notes.append('Counted as a new client on instruction: ' + last['account'][:60])

    owner = last['rep'] or (paid[-1]['rep'] if paid else '')
    accounts.append(dict(
        id=aid, name=last['account'][:120], nameNormalised=key,
        owner=uid(owner) if owner else None,
        team=sorted({uid(x['rep']) for x in rs if x['rep']}),
        region=last['region'], type=last['acctType'],
        industry=last['industry'], parentAccountId=None, isSite=False,
        firstOrderDate=first_order.isoformat() if first_order else None,
        lifetimeValue=round(sum(x['actual'] for x in rs), 2),
        orderCountByFY={str(k): v for k, v in orders_by_fy.items()},
        clientClass=klass, classEffectiveFrom='2026-04-01',
        createdAt=first['date'].isoformat(), createdBy='import',
        updatedAt=last['date'].isoformat(), updatedBy='import'))

    # contact - one per account, from the most recent row carrying a name
    named = [x for x in rs if x['spocName']]
    phoned = [x for x in rs if x['spocPhone']]
    if named or phoned:
        phone = phoned[-1]['spocPhone'] if phoned else ''
        if phone:
            if phone in seen_phone:
                report['duplicate_phone'] += 1
            seen_phone[phone] = key
        contacts.append(dict(
            id=sid('con', key), accountId=aid,
            name=named[-1]['spocName'] if named else '',
            phone=phone, phoneNormalised=phone, email='', designation='',
            isPrimary=True, createdAt=first['date'].isoformat(),
            createdBy='import'))

    # one opportunity per account for the import; new deals are created live
    oid = sid('opp', key)
    st = last['stage']
    since = last['date']
    for x in reversed(rs):
        if x['stage'] == st:
            since = x['date']
        else:
            break
    opportunities.append(dict(
        id=oid, accountId=aid, name=last['account'][:120],
        owner=uid(owner) if owner else None, stage=st,
        stageSince=since.isoformat(), expectedValue=round(last['expected'], 2),
        quotedValue=round(last['expected'], 2) if st in (2, 3) else 0,
        confirmedValue=round(last['expected'], 2) if st == 4 else 0,
        expectedOrderDate=None,
        nextActionDate=last['nextActionDate'].isoformat() if last['nextActionDate'] else None,
        nextActionType=last['nextActionType'], temperature=last['temperature'],
        source='import',
        lossReason=(last['lossReason'] or None) if st == 6 else None,
        createdAt=first['date'].isoformat(),
        closedAt=last['date'].isoformat() if st in (5, 6) else None))

    # stage history from observed transitions
    prev, prev_at = None, None
    for x in rs:
        if prev is None:
            prev, prev_at = x['stage'], x['date']
            continue
        if x['stage'] != prev:
            stage_hist.append(dict(
                id=sid('sh', key + str(x['date']) + str(x['stage'])),
                opportunityId=oid, fromStage=prev, toStage=x['stage'],
                changedAt=x['date'].isoformat(), changedBy='import',
                daysInPrevious=(x['date'] - prev_at).days))
            prev, prev_at = x['stage'], x['date']

    # activities + orders
    for x in rs:
        activities.append(dict(
            id=sid('act', key + x['date'].isoformat() + x['remarks'][:24] + str(x['expected'])),
            accountId=aid, opportunityId=oid,
            type=x['connect'] if x['connect'] in ('Call', 'F2F', 'Email') else 'Call',
            remarks=x['remarks'], checkIn=None,
            loggedBy=uid(x['rep']) if x['rep'] else None,
            loggedAt=x['date'].isoformat()))
        if x['actual'] > 0:
            od = x['orderDate'] or x['date']
            orders.append(dict(
                id=sid('ord', key + od.isoformat() + str(x['actual'])),
                accountId=aid, opportunityId=oid,
                bookedBy=uid(x['rep']) if x['rep'] else None,
                value=round(x['actual'], 2), orderDate=od.isoformat(),
                store=x['store'], channel='',
                invoiceNumber=x['invoiceNo'],
                paymentStatus=x['hoStatus'] or 'Pending',
                paymentReceivedAt=None, financeApprovedAt=None,
                aggregator=x['aggregator'] or None,
                commissionPct=0.15 if x['aggregator'] in AGGS else 0))

# ---------------------------------------------------------------- targets
# Three blocks per sheet: Overall, New (client|order), Old (client|order).
# Each block is a name column plus month columns. Parsed generically so it
# works on both the current workbook and the newer named version.
targets = []

MONTH_ABBR = {m: i + 1 for i, m in enumerate(
    ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'])}


def month_key(v, fallback_fy_start=None):
    """Header cell -> 'YYYY-MM', or None."""
    if isinstance(v, dt.datetime):
        return '%04d-%02d' % (v.year, v.month)
    t = str(v or '').strip()
    m = re.match(r'^([A-Za-z]{3})[-/ ]?(\d{2,4})$', t)          # 'Sep-26'
    if m and m.group(1).lower() in MONTH_ABBR:
        y = int(m.group(2))
        y = 2000 + y if y < 100 else y
        return '%04d-%02d' % (y, MONTH_ABBR[m.group(1).lower()])
    m = re.match(r'^([A-Za-z]{3,})$', t)                         # bare 'Apr'
    if m and m.group(1)[:3].lower() in MONTH_ABBR and fallback_fy_start:
        mm = MONTH_ABBR[m.group(1)[:3].lower()]
        yy = fallback_fy_start + (0 if mm >= 4 else 1)
        return '%04d-%02d' % (yy, mm)
    return None


# Blocks we want, and blocks that must STOP parsing. The Target sheet holds
# an 'Actuals' block with an identical layout directly below 'Overall'; without
# an explicit stop the parser reads actuals as targets.
STOP_BLOCKS = ('actual', 'aggregator', 'payment term', 'case ')


def bucket_of(label):
    t = str(label or '').strip().lower()
    if any(t.startswith(x) for x in STOP_BLOCKS):
        return 'STOP'
    if t.startswith('overall'):
        return 'overall'
    if t.startswith('new'):
        return 'new'
    if t.startswith('old'):
        return 'old'
    return None


NON_REP = ('sales person name', 'target', 'total target', 'total', '')
NAMED_ACCOUNT_HINT = ('church', 'engineer', 'labs', 'lab')


def find_anchors(ws):
    """Every cell that opens a block -> (row, col, bucket).

    The Target sheet lays its three blocks out SIDE BY SIDE: 'Overall' at
    (1,1), 'New Order' at (1,20), 'Old Order' at (1,39), each with its own
    month header row beneath it. An earlier version of this parser assumed
    the blocks were stacked vertically, so all 51 month columns collapsed
    into 'overall' and the Old Order figures - being furthest right - won
    the de-duplication. Sameer's Sep-26 overall target read 14,37,309
    (his old-client figure) instead of 26,13,289.

    Anchors are collected from anywhere in the sheet so the same code also
    reads a vertically stacked layout.
    """
    out = []
    for i in range(1, ws.max_row + 1):
        for j in range(1, ws.max_column + 1):
            b = bucket_of(ws.cell(i, j).value)
            if b:
                out.append((i, j, b))
    return out


def parse_target_sheet(ws, fy_start=2026):
    """Yield (bucket, rowLabel, monthKey, amount)."""
    anchors = find_anchors(ws)
    if not anchors:
        return
    anchor_rows = sorted({i for i, _, _ in anchors})

    for idx, (r, c, bucket) in enumerate(anchors):
        if bucket == 'STOP':
            continue

        # Column band: up to the next anchor on the same row.
        same_row = sorted(j for i, j, _ in anchors if i == r and j > c)
        col_end = (same_row[0] - 1) if same_row else ws.max_column

        # Month header row: this row or one of the next two, whichever
        # carries at least three parseable month headers inside the band.
        cols, hdr = {}, None
        for h in range(r, min(r + 3, ws.max_row) + 1):
            found = {}
            for j in range(c, col_end + 1):
                mk = month_key(ws.cell(h, j).value, fy_start)
                if mk:
                    found[j] = mk
            if len(found) >= 3:
                cols, hdr = found, h
                break
        if not cols:
            continue

        # The name column is the band's first column, unless a month header
        # sits there - then the band has no label column of its own.
        name_col = c
        if name_col in cols:
            continue

        # Row band: stop at the next anchor row below the header.
        below = [i for i in anchor_rows if i > hdr]
        row_end = (below[0] - 1) if below else ws.max_row

        blanks = 0
        for i in range(hdr + 1, row_end + 1):
            label = str(ws.cell(i, name_col).value or '').strip()
            if not label:
                blanks += 1
                if blanks >= 3:
                    break
                continue
            blanks = 0
            if label.lower() in NON_REP:
                continue
            for j, mk in cols.items():
                v = ws.cell(i, j).value
                if isinstance(v, (int, float)) and v:
                    yield bucket, label, mk, float(v), r


def load_targets(path):
    if not os.path.exists(path):
        return
    wb = open_clean(path)

    # 'Target' is authoritative: it carries all three buckets for all five
    # reps under their real names. 'Incentive Target MOM' holds the same
    # numbers but names three of the reps 'Person 1'..'Person 4', so it is
    # only read for reps when there is no Target sheet at all.
    main = [s for s in wb.sheetnames if s.strip().lower() == 'target']
    if not main:
        main = [s for s in wb.sheetnames
                if 'target' in s.lower() or 'incentive' in s.lower()]
    if not main:
        return
    report['target_sheet_used'] = main[0]

    # The named accounts - JCNM Church, Azad Engineer, MSN Labs - sit only on
    # the incentive sheet, below the rep rows, as one-off lumps on top of the
    # monthly numbers. Read those rows from there and nothing else.
    extra = [s for s in wb.sheetnames
             if s not in main and 'incentive' in s.lower()]

    for sheet, want_reps in [(s, True) for s in main] + \
                            [(s, False) for s in extra]:
        rows = list(parse_target_sheet(wb[sheet]))

        # A sheet can hold the SAME block twice. 'Incentive Target MOM' carries
        # an older one naming people 'Person 1'..'Person 4' and a newer one
        # using the real names, and they disagree about the named accounts -
        # the old one puts Azad in Oct and MSN as one Rs 1.8 Cr lump in Nov,
        # the new one puts Azad in Nov and splits MSN into Jul and Dec. Read
        # both and the account is counted in every month either block mentions.
        # So: if any block in this sheet names a real rep, trust only those
        # blocks and drop the placeholder ones entirely.
        # The tell is the PLACEHOLDER names, not the real ones - the stale
        # block carries Bashab and Sameer too, so 'contains a real rep' does
        # not separate them. Any block holding a 'Person N' row is the old
        # plan; drop everything sitting near it, named accounts included.
        stale = {ar for _, lab, _, _, ar in rows
                 if lab.strip().lower().startswith('person ')}
        if stale:
            drop = {ar for _, _, _, _, ar in rows
                    if any(abs(ar - st) <= 20 for st in stale)}
            report['target_rows_from_stale_block'] += len(
                [1 for t in rows if t[4] in drop])
            rows = [t for t in rows if t[4] not in drop]

        for bucket, label, mk, amt, _ in rows:
            clean = label.strip()
            named = any(h in clean.lower() for h in NAMED_ACCOUNT_HINT)
            if not want_reps and not named:
                continue                        # reps already read above
            if clean.lower().startswith('person '):
                report['target_placeholder_name'] += 1
                notes.append('Target row uses a placeholder name: %s '
                             '(send the named sheet)' % clean)
                continue
            if clean == 'Ayush':
                continue        # Ayush's line is the column total, not a target
            matched = next((r for r in REPS if r.lower() == clean.lower()), None)
            if matched:
                targets.append(dict(id=tgt_id(uid(matched), mk, bucket),
                                    userId=uid(matched), month=mk,
                                    bucket=bucket, amount=round(amt, 2),
                                    scope='rep', accountName=None))
                report['target_' + bucket] += 1
            elif named:
                # A lump sitting on top of the rep targets, carried in the
                # Total Target row. Scoped to the account, owned by nobody,
                # so it never inflates a rep's achievement.
                #
                # The sheet files JCNM Church and Azad Engineer under Old
                # Order. Ayush's instruction on 30-Sep-26 is that both count
                # as NEW, so the bucket is corrected here to match how their
                # revenue is now classified. MSN Labs keeps whatever the
                # sheet says - it is neither new nor old and pays a flat
                # 0.3% with no target of its own.
                b2 = bucket
                if bucket == 'old' and any(h in norm(clean) for h in FORCE_NEW):
                    b2 = 'new'
                    report['named_account_rebucketed'] += 1
                elif bucket == 'old' and 'msn' in norm(clean):
                    # MSN is its own incentive bucket at a flat 0.3%, neither
                    # new nor old. Filing it under 'old' would misread.
                    b2 = 'msn'
                targets.append(dict(id=tgt_id('acc:' + norm(clean), mk, b2),
                                    userId=None, month=mk, bucket=b2,
                                    amount=round(amt, 2), scope='account',
                                    accountName=clean))
                report['target_named_account'] += 1
            else:
                report['target_row_unmatched'] += 1
                notes.append('Target row not matched to a rep: %s' % clean)


load_targets(os.path.join(SRC, F_CUR))

# de-duplicate: the same rep/month/bucket may appear on two sheets
seen_t = {}
for t in targets:
    seen_t[t['id']] = t
targets = list(seen_t.values())

# ---------------------------------------------------------------- write
def dump(name, data):
    with open(os.path.join(OUT, name + '.json'), 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print('%-16s %6d' % (name, len(data)))

print('\n--- collections written to %s ---' % OUT)
dump('users', users)
dump('accounts', accounts)
dump('contacts', contacts)
dump('opportunities', opportunities)
dump('activities', activities)
dump('orders', orders)
dump('stageHistory', stage_hist)
dump('targets', targets)

# ---------------------------------------------------------------- reconcile
total_actual = sum(o['value'] for o in orders)
fy27_actual = sum(o['value'] for o in orders if o['orderDate'] >= '2026-04-01')
stage_dist = collections.Counter(o['stage'] for o in opportunities)

recon = dict(
    rowsRead=report['rows_total'],
    rowsHistory=report['rows_history'], rowsFY27=report['rows_fy27'],
    accounts=len(accounts), contacts=len(contacts),
    contactsWithPhone=sum(1 for c in contacts if c['phone']),
    opportunities=len(opportunities), activities=len(activities),
    orders=len(orders), stageHistory=len(stage_hist), targets=len(targets),
    totalActualAllTime=round(total_actual, 2),
    totalActualFY27=round(fy27_actual, 2),
    stageDistribution={STAGE_NAMES[k]: v for k, v in sorted(stage_dist.items())},
    openDeals=sum(v for k, v in stage_dist.items() if k < 5),
    openNoNextAction=sum(1 for o in opportunities
                         if o['stage'] < 5 and not o['nextActionDate']),
    openNoValue=sum(1 for o in opportunities
                    if o['stage'] < 5 and not o['expectedValue']),
    clientsOld=sum(1 for a in accounts if a['clientClass'] == 'old'),
    clientsNew=sum(1 for a in accounts if a['clientClass'] == 'new'),
    promoteNextFY=sum(1 for a in accounts
                      if a['clientClass'] == 'new'
                      and a['orderCountByFY'].get('2027', 0) >= 2),
    dataIssues=dict(report),
    notes=sorted(set(notes))[:40])

with open(os.path.join(OUT, 'importReport.json'), 'w') as f:
    json.dump(recon, f, indent=1)

print('\n--- reconciliation ---')
for k, v in recon.items():
    if k not in ('dataIssues', 'notes', 'stageDistribution'):
        print('%-22s %s' % (k, v))
print('stages                 %s' % recon['stageDistribution'])
print('\nCheck totalActualFY27 against the DCR Dashboard before loading.')
