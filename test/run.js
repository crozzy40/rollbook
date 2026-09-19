'use strict';
// End-to-end test. Boots the server on a throwaway database and drives it over HTTP like a browser would.
// Run: npm test   (needs Node 22.13+)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3999 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rollbook-test-'));
const jar = {};
let cookie = ''; // rendered from jar
let csrf = '';
let passed = 0, failed = 0;

function log(ok, name, extra = '') { (ok ? passed++ : failed++); console.log(`${ok ? '  ok ' : ' FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); }
async function test(name, fn) { try { await fn(); log(true, name); } catch (e) { log(false, name, e.message); } }

async function req(method, p, body, opts = {}) {
  const headers = { cookie };
  let payload;
  if (body && opts.json) { headers['content-type'] = 'application/json'; payload = JSON.stringify({ _csrf: csrf, ...body }); }
  else if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams({ _csrf: csrf, ...body }).toString(); }
  const r = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) { const m = c.match(/^([^=]+)=([^;]*)/); if (!m) continue; if (m[2] === '' || /Max-Age=0/.test(c)) delete jar[m[1]]; else jar[m[1]] = m[2]; }
  cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const text = opts.raw ? null : await r.text();
  const m = text && text.match(/name="_csrf" value="([^"]+)"/); if (m) csrf = m[1];
  const w = text && text.match(/window\.CSRF="([^"]+)"/); if (w) csrf = w[1];
  return { status: r.status, location: r.headers.get('location'), text, res: r };
}
const get = (p, o) => req('GET', p, null, o);
const post = (p, b, o) => req('POST', p, b, o);
async function follow(p, b, o) { const r = await post(p, b, o); assert.equal(r.status, 303, `expected redirect from ${p}, got ${r.status}`); return get(r.location.replace(/#.*$/, '')); }

// Her workbook, in the shape SheetJS hands the parser (dates as Excel serials). Built to look like the real template.
function fixtureSheets(year) {
  const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  const head = [null, null, null]; for (let m = 1; m <= 12; m++) head.push(serial(2016, m, 1)); head.push('Total', 'Average');
  const income = [[null, 'Income'], head, ['Lease', 'Rent', 'Lease Date'],
    ['Alice Example', 2500, '5-1-25 to 4-30-26', 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 0, 0, 0],
    ['Bob Sample', 3500, '6-1-25 to 5-31-26', 3500, 3500, 3500, 3500, 3500, 3500, 3500, 3500, 0, 0, 0, 0],
    ['Carol New', 3000, '8-1-26 to 7-31-27', 0, 0, 0, 0, 0, 0, 0, 3000, 3000, 0, 0, 0],
    ['Garage', 350, null, 350, 350, 350, 350, 350, 350, 350, 350, 350, 0, 0, 0],
    [], ['Other'], ['Laundry', null, null, 40, 40, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
  const ehead = [null, null, 'Expenses']; for (let m = 1; m <= 12; m++) ehead.push(serial(2016, m, 1)); ehead.push('Total', 'Average');
  const expenses = [ehead,
    ['Legal', null, 'Monthly totals:'], [null, null, 'Lawyer', 0, 0, 553, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ['Repairs and Maintenance', null, 'Monthly totals:'], [null, null, 'Supplies', 1023, 92.51, 0, 0, 500, 0, 0, 56, 0, 0, 0, 0], [null, null, 'Mortgage', 8024.49, 8024.49, 8024.49, 8024.49, 8024.49, 8024.49, 8024.49, 8024.49, 8024.49, 0, 0, 0],
    ['Utilities', null, 'Monthly totals:'], [null, null, 'Gas', 400, 380, 300, 200, 100, 80, 80, 80, 90, 0, 0, 0],
    ['Miscellaneous', null, 'Monthly totals:'], [null, null, 'Property Tax', 0, 0, 6675.5, 0, 0, 0, 0, 6675.5, 0, 0, 0, 0]];
  const receipts = [[serial(year, 5, 25), 'oven and stove', 2047.94], [serial(year, 5, 26), 'screws', 70.84], [null, null, 2118.78], [serial(year, 5, 3), 'new furnace', 4800], [serial(year, 6, 7), 'appliance', 465.01], [serial(year, 6, 7), 'appliance', 465.01], [null, null, 5730.02]];
  return { Income: income, Expenses: expenses, Summary: [], Sheet2: receipts };
}

// ---- Stripe stand-in: enough of the API for Checkout sessions, on a local port
const http = require('node:http');
const STRIPE_PORT = PORT + 1;
const sessions = {};
const stripeMock = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const auth = req.headers.authorization || '';
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!/^Bearer sk_test_ok/.test(auth)) return send(401, { error: { message: 'Invalid API Key provided' } });
    if (req.method === 'GET' && req.url === '/v1/account') return send(200, { id: 'acct_1', settings: { dashboard: { display_name: 'Test Landlord LLC' } } });
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      const q = new URLSearchParams(body); const id = 'cs_test_' + Object.keys(sessions).length;
      sessions[id] = { id, object: 'checkout.session', status: 'open', payment_status: 'unpaid', url: 'http://stripe.local/checkout/' + id, params: Object.fromEntries(q) };
      return send(200, sessions[id]);
    }
    const m = req.url.match(/^\/v1\/checkout\/sessions\/(cs_[\w]+)/);
    if (req.method === 'GET' && m && sessions[m[1]]) return send(200, sessions[m[1]]);
    send(404, { error: { message: 'no such route ' + req.method + ' ' + req.url } });
  });
});

(async () => {
  await new Promise(r => stripeMock.listen(STRIPE_PORT, r));
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR, STRIPE_API_BASE: `http://localhost:${STRIPE_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', d => serverLog += d); server.stderr.on('data', d => serverLog += d);
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  console.log(`Rollbook test on ${BASE}, data in ${DATA_DIR}\n`);
  const year = new Date().getFullYear();
  const cur = new Date().toISOString().slice(0, 7);
  let unitIds = {};

  try {
    await test('fresh install redirects to /setup', async () => { const r = await get('/'); assert.equal(r.status, 303); assert.match(r.location, /\/setup$/); });
    await test('setup rejects mismatched passwords', async () => { await get('/setup'); const r = await post('/setup', { owner_name: 'Test', portfolio_name: 'Test Props', password: 'password123', password2: 'nope', demo: '0' }); assert.equal(r.status, 200); assert.match(r.text, /do not match/); });
    await test('setup creates the account and signs in (no demo)', async () => { const r = await post('/setup', { owner_name: 'Test Owner', portfolio_name: 'Test Props', password: 'password123', password2: 'nope'.repeat(0) || 'password123' }); assert.equal(r.status, 303); assert.ok(jar.rollbook_session, 'session cookie set'); });
    await test('dashboard shows the empty state', async () => { const r = await get('/'); assert.equal(r.status, 200); assert.match(r.text, /Nothing here yet/); });
    await test('sign out and back in', async () => { await get('/logout'); assert.ok(!jar.rollbook_session, 'session cleared'); let r = await get('/'); assert.match(r.location, /\/login$/); await get('/login'); r = await post('/login', { password: 'wrong' }); assert.equal(r.status, 401); r = await post('/login', { password: 'password123' }); assert.equal(r.status, 303); assert.ok(jar.rollbook_session); });
    await test('a POST without a CSRF token is refused', async () => { const saved = csrf; csrf = 'bogus'; const r = await post('/settings', { portfolio_name: 'x' }); assert.equal(r.status, 403); csrf = saved; await get('/settings'); });

    // ---- import her workbook shape
    const P = require('../public/js/parse.js');
    const parsed = P.parseWorkbook(fixtureSheets(year), `Copy_of_1657_W_Test_${year}.xlsx`);
    await test('parser reads tenants, lease dates, expenses, receipts', async () => {
      assert.equal(parsed.tenants.length, 4); assert.equal(parsed.tenants[0].lease_start, '2025-05-01'); assert.equal(parsed.tenants[3].kind, 'garage');
      assert.equal(parsed.other_income.length, 1); assert.equal(parsed.receipts.length, 5); assert.equal(parsed.year, year);
      const supplies = parsed.expense_lines.find(l => l.item === 'Supplies'); assert.equal(supplies.months[4], 0, 'May supplies dropped (receipts cover May)'); assert.equal(supplies.months[0], 1023, 'Jan supplies kept');
    });
    await test('import check flags missing unit labels', async () => { await get('/import'); const r = await post('/api/import/check', parsed, { json: true }); const j = JSON.parse(r.text); assert.equal(j.ok, false); assert.match(j.errors.join(' '), /unit number/); });
    let importResult;
    await test('import saves building, units, tenants, payments, expenses', async () => {
      parsed.tenants.forEach((t, i) => t.unit_label = t.kind === 'garage' ? 'Garage' : String(i + 1));
      const r = await post('/api/import', parsed, { json: true }); const j = JSON.parse(r.text); importResult = j;
      assert.equal(j.ok, true, JSON.stringify(j.errors)); assert.equal(j.summary.units, 4); assert.equal(j.summary.tenants, 4);
      assert.equal(j.summary.payments, 9 + 8 + 2 + 9); assert.equal(j.summary.receipts, 5, 'two identical receipts on one day are both kept'); assert.ok(j.summary.expenses > 20);
      assert.match(j.summary.warnings.join(' '), /"Other" income/);
    });
    await test('re-importing the same file adds nothing twice', async () => { const r = await post('/api/import', parsed, { json: true }); const j = JSON.parse(r.text); assert.equal(j.ok, true); assert.equal(j.summary.payments, 0); assert.equal(j.summary.units, 0); assert.equal(j.summary.receipts, 0); assert.equal(j.summary.expenses, 0); });
    await test('unit board lists the imported building and units', async () => { const r = await get('/units'); assert.match(r.text, /1657 W Test/); for (const m of r.text.matchAll(/href="\/units\/(\d+)"[^>]*>\s*<div class="unit">([^<]+)/g)) unitIds[m[2].trim()] = m[1]; assert.deepEqual(Object.keys(unitIds).sort(), ['1', '2', '3', 'Garage']); });
    await test('delinquency: tenant with missing months owes; new mid-year tenant owes nothing before move-in', async () => {
      const r = await get('/delinquency'); assert.equal(r.status, 200);
      // Bob paid Jan–Aug only. If the current month is later than August he owes; Alice paid through September.
      const curMonth = Number(cur.slice(5, 7));
      if (curMonth > 8) assert.match(r.text, /Bob Sample/); 
      if (curMonth <= 9) assert.doesNotMatch(r.text, /Alice Example.*owed/s);
      assert.doesNotMatch(r.text, /Carol New/, 'Carol moved in August and paid; should not be listed');
    });

    // ---- payments and charges
    await test('record a payment and see it on the ledger', async () => {
      const u = unitIds['2']; await get(`/units/${u}`);
      const page = await get(`/units/${u}`); const tid = page.text.match(/\/tenancies\/(\d+)\/payments/)[1];
      const r = await follow(`/tenancies/${tid}/payments`, { amount: '3500', date: `${cur}-15`, method: 'Zelle', reference: '', memo: 'test' });
      assert.match(r.text, /Recorded \$3,500\.00 from Bob Sample by Zelle/); assert.match(r.text, /Payment, Zelle/);
    });
    await test('a payment of zero is refused', async () => { const u = unitIds['2']; const page = await get(`/units/${u}`); const tid = page.text.match(/\/tenancies\/(\d+)\/payments/)[1]; const r = await follow(`/tenancies/${tid}/payments`, { amount: '0', date: `${cur}-15`, method: 'Cash' }); assert.match(r.text, /above zero/); });
    await test('add a late fee charge, then remove it', async () => {
      const u = unitIds['1']; const page = await get(`/units/${u}`); const tid = page.text.match(/\/tenancies\/(\d+)\/charges/)[1];
      let r = await follow(`/tenancies/${tid}/charges`, { kind: 'late_fee', amount: '50', date: `${cur}-10`, memo: 'test fee' }); assert.match(r.text, /Late fee of \$50\.00 added/);
      const id = r.text.match(/\/charges\/(\d+)\/delete/)[1];
      r = await get(`/charges/${id}/delete`); assert.match(r.text, /Remove this charge/);
      r = await follow(`/charges/${id}/delete`, {}); assert.match(r.text, /Removed\./); assert.doesNotMatch(r.text, /test fee/);
    });
    await test('overpayment shows as credit', async () => {
      const u = unitIds['Garage']; const page = await get(`/units/${u}`); const tid = page.text.match(/\/tenancies\/(\d+)\/payments/)[1];
      const before = page.text.match(/<div class="n [^"]*">([^<]+)<\/div><div class="l">[^<]*(owed|paid up|credit)/);
      const r = await follow(`/tenancies/${tid}/payments`, { amount: '10000', date: `${cur}-15`, method: 'Cash' });
      assert.match(r.text, /Credit of \$[\d,.]+ on account/);
      const pid = r.text.match(/\/payments\/(\d+)\/delete/)[1]; await follow(`/payments/${pid}/delete`, {});
    });

    // ---- tenancy lifecycle
    await test('edit tenant: rent change updates this month forward only', async () => {
      const u = unitIds['3']; const page = await get(`/units/${u}`); const tid = page.text.match(/\/tenancies\/(\d+)\/edit/)[1];
      const form = await get(`/tenancies/${tid}/edit`); const cf = form.text.match(/name="charges_from" value="([^"]+)"/)[1];
      const r = await follow(`/tenancies/${tid}/edit`, { tenant_name: 'Carol New', phone: '555', email: '', rent: '3100', deposit: '3000', lease_start: `${year}-08-01`, lease_end: `${year + 1}-07-31`, charges_from: cf, notes: '' });
      assert.match(r.text, /\$3,100\.00/); assert.match(r.text, /\$3,000\.00<\/b> deposit/);
    });
    await test('move out, then move someone new in', async () => {
      const u = unitIds['3']; let page = await get(`/units/${u}`); const tid = page.text.match(/\/tenancies\/(\d+)\/move-out/)[1];
      let r = await get(`/tenancies/${tid}/move-out`); assert.match(r.text, /Move out Carol New/);
      r = await follow(`/tenancies/${tid}/move-out`, { move_out: `${cur}-28` }); assert.match(r.text, /This unit is vacant/); assert.match(r.text, /Past tenants/);
      r = await get(`/units/${u}/move-in`); assert.match(r.text, /Move someone in/);
      r = await follow(`/units/${u}/move-in`, { tenant_name: 'Dan Next', phone: '', email: '', rent: '3200', deposit: '3200', lease_start: `${cur}-01`, lease_end: `${year + 1}-${cur.slice(5)}-01`, charges_from: cur, notes: '' });
      assert.match(r.text, /Dan Next moved in/); assert.match(r.text, /Rent, /); assert.match(r.text, /\$3,200\.00/);
    });
    await test('mobile More page reaches every section', async () => { const r = await get('/more'); assert.equal(r.status, 200); for (const h of ['/leases', '/work', '/reports', '/import', '/export', '/settings']) assert.match(r.text, new RegExp(`href="${h}"`)); });
    await test('leases page lists end dates', async () => { const r = await get('/leases'); assert.equal(r.status, 200); assert.match(r.text, /Dan Next/); });

    // ---- buildings & units
    let b2;
    await test('add a building by hand, add and edit a unit, delete it', async () => {
      let r = await follow('/buildings/new', { name: 'Manual Bldg', address: '1 Test St', notes: '' }); b2 = r.text.match(/action="\/buildings\/(\d+)\/units"/)[1]; assert.match(r.text, /Building added/);
      r = await follow(`/buildings/${b2}/units`, { label: '1A', kind: 'apartment' }); assert.match(r.text, /Unit 1A added/);
      r = await follow(`/buildings/${b2}/units`, { label: '1a', kind: 'apartment' }); assert.match(r.text, /already a unit called/);
      const uid = r.text.match(/href="\/units\/(\d+)"/)[1];
      r = await follow(`/units/${uid}/edit`, { label: '1B', kind: 'storage', notes: 'n' }); assert.match(r.text, /Saved/); assert.match(r.text, /1B/);
      r = await follow(`/units/${uid}/delete`, {}); assert.match(r.text, /Unit deleted/);
    });

    // ---- expenses
    let expId;
    await test('add, edit, filter, delete an expense', async () => {
      let r = await follow('/expenses/new', { building_id: importResult.buildingId, unit_id: unitIds['1'], date: `${cur}-05`, category: 'Repairs & maintenance', description: 'Test faucet', vendor: 'Plumber', amount: '199.5', memo: '' });
      assert.match(r.text, /Logged \$199\.50 for Test faucet/); expId = r.text.match(/\/expenses\/(\d+)\/edit/)[1];
      r = await follow(`/expenses/${expId}/edit`, { building_id: importResult.buildingId, unit_id: '', date: `${cur}-05`, category: 'Supplies', description: 'Test faucet edited', vendor: '', amount: '210', memo: '' }); assert.match(r.text, /Test faucet edited/);
      r = await get(`/expenses?category=${encodeURIComponent('Supplies')}&period=${cur}`); assert.match(r.text, /Test faucet edited/); assert.doesNotMatch(r.text, /<td class="hide-m">Mortgage<\/td>/);
      r = await get(`/expenses?category=${encodeURIComponent('Mortgage')}&year=${year}`); assert.match(r.text, /Mortgage/);
      r = await follow(`/expenses/${expId}/delete`, {}); assert.match(r.text, /Deleted/);
    });
    await test('imported expenses were categorized onto the chart of accounts', async () => { const r = await get(`/expenses?year=${year}`); assert.match(r.text, /<td class="hide-m">Mortgage<\/td>/); assert.match(r.text, /<td class="hide-m">Property tax<\/td>/); assert.match(r.text, /<td class="hide-m">Legal &amp; professional<\/td>/); assert.match(r.text, /new furnace/); assert.match(r.text, /<td class="hide-m">Capital improvements<\/td>/); });

    // ---- work orders
    await test('open a work order, mark it done, cost lands in expenses', async () => {
      let r = await follow('/work/new', { building_id: importResult.buildingId, unit_id: unitIds['2'], title: 'Test leak', notes: '', vendor: 'Plumber', opened_at: `${cur}-01`, cost: '', status: 'open' }); assert.match(r.text, /Work order opened/);
      const id = r.text.match(/\/work\/(\d+)\/done/)[1];
      r = await get(`/work/${id}/done`); assert.match(r.text, /Done: Test leak/);
      r = await follow(`/work/${id}/done`, { cost: '325', category: 'Repairs & maintenance', closed_at: `${cur}-03`, add_expense: '1' }); assert.match(r.text, /\$325\.00 logged to expenses/);
      r = await get(`/expenses?period=${cur}`); assert.match(r.text, /Test leak/);
      r = await follow(`/work/${id}/delete`, {}); assert.match(r.text, /Deleted/);
    });

    // ---- reports & exports
    await test('reports page totals add up', async () => { const r = await get(`/reports?year=${year}`); assert.equal(r.status, 200); assert.match(r.text, /rent received in/); assert.match(r.text, /Capital improvements/); });
    await test('export feeds return JSON with the right shape', async () => {
      let j = JSON.parse((await get(`/api/export/building/${importResult.buildingId}?year=${year}`)).text); assert.equal(j.tenancies.length >= 4, true); assert.equal(j.tenancies[0].months.length, 12); assert.ok(j.expenses.length > 20);
      j = JSON.parse((await get('/api/export/rentroll')).text); assert.ok(j.rows.length >= 4); assert.ok('balance' in j.rows[0]);
      j = JSON.parse((await get('/api/export/delinquency')).text); assert.ok(Array.isArray(j.rows));
      j = JSON.parse((await get(`/api/export/yearend?year=${year}`)).text); assert.equal(j.months.length, 12);
      j = JSON.parse((await get(`/api/export/expenses?year=${year}`)).text); assert.ok(j.rows.length > 20);
    });
    await test('backup download is a real SQLite file', async () => { const r = await fetch(BASE + '/backup.sqlite', { headers: { cookie } }); const buf = Buffer.from(await r.arrayBuffer()); assert.equal(buf.slice(0, 15).toString(), 'SQLite format 3'); assert.match(r.headers.get('content-disposition'), /rollbook-backup-/); });

    // ---- settings
    await test('settings save and late fee rule shows on the report', async () => { let r = await follow('/settings', { portfolio_name: 'Test Props', owner_name: 'Test Owner', rent_due_day: '1', grace_days: '5', late_fee_kind: 'percent', late_fee_amount: '5' }); assert.match(r.text, /Settings saved/); r = await get('/delinquency'); assert.match(r.text, /5 days grace, then 5% of rent/); });
    await test('password change signs other sessions out and keeps this one', async () => { let r = await follow('/settings/password', { current: 'password123', password: 'newpassword1', password2: 'newpassword1' }); assert.match(r.text, /Password changed/); await get('/logout'); await get('/login'); r = await post('/login', { password: 'newpassword1' }); assert.equal(r.status, 303); });
    await test('demo portfolio loads and clears without touching real data', async () => {
      await get('/settings'); let r = await follow('/settings/seed-demo', {}); assert.match(r.text, /Demo portfolio loaded/); assert.match(r.text, /chip demo/);
      r = await get('/settings'); assert.match(r.text, /3 demo buildings are loaded/);
      r = await follow('/settings/clear-demo', {}); assert.match(r.text, /Cleared 3 demo building/);
      r = await get('/units'); assert.doesNotMatch(r.text, /chip demo/); assert.match(r.text, /1657 W Test/); assert.match(r.text, /Manual Bldg/);
    });
    await test('importing a building named like a demo building never merges into the demo', async () => {
      await get('/settings'); await follow('/settings/seed-demo', {});
      const clone = JSON.parse(JSON.stringify(parsed)); clone.building_name = '100 Sample Ave'; clone.filename = 'collide.xlsx';
      await get('/import'); const j = JSON.parse((await post('/api/import', clone, { json: true })).text); assert.equal(j.ok, true); assert.equal(j.summary.units, 4, 'created its own units, did not reuse the demo ones');
      let r = await follow('/settings/clear-demo', {}); assert.match(r.text, /Cleared 3 demo/);
      r = await get('/units'); assert.match(r.text, /100 Sample Ave/, 'the real building with the colliding name survives');
      r = await get(`/api/export/rentroll`); assert.ok(JSON.parse(r.text).rows.some(x => x.building === '100 Sample Ave' && x.tenant === 'Alice Example'));
    });
    await test('building home page: band, figures, units, and rail entry', async () => {
      const r = await get(`/buildings/${importResult.buildingId}`); assert.equal(r.status, 200);
      assert.match(r.text, /class="bhero placeholder" href="\/buildings\/\d+\/edit#photo"/); assert.match(r.text, /Add a photo of the front/); assert.match(r.text, /collected of/); assert.match(r.text, /class="tile /); assert.match(r.text, /Recent payments/);
      assert.match(r.text, /class="nav-group">Buildings</); assert.match(r.text, new RegExp(`class="bnav on"[^>]*>.*?1657 W Test`), 'current building highlighted in the rail');
      const u = await get(`/units/${unitIds['1']}`); assert.match(u.text, /class="where in-building"/, 'unit page shows the location bar in-building'); assert.match(u.text, /where-name">1657 W Test</);
      const t = await get('/'); assert.match(t.text, /class="where"><a class="where-main" href="\/units">/, 'admin pages show the portfolio, not a building');
      const x = await get(`/expenses?building=${importResult.buildingId}`); assert.match(x.text, /class="where in-building"/, 'filtering by building puts you in it');
      const sw = u.text.match(/<option value="\/buildings\/\d+"[^>]*>/g) || []; assert.ok(sw.length >= 1, 'switcher lists buildings');
    });
    await test('nickname shows everywhere the building is named; name on the books stays', async () => {
      const bid = importResult.buildingId;
      let r = await follow(`/buildings/${bid}`, { name: '1657 W Test', display_name: 'Hollywood', address: '1657 W Test Ave', notes: '' }); assert.match(r.text, /<h1>Hollywood/);
      r = await get('/delinquency'); assert.doesNotMatch(r.text, /<span class="sub">1657 W Test/); r = await get('/'); assert.match(r.text, /Hollywood/);
      r = await get(`/api/export/rentroll`); assert.equal(JSON.parse(r.text).rows[0].building, 'Hollywood');
      const chk = JSON.parse((await post('/api/import/check', { ...parsed, building_name: '1657 W Test' }, { json: true })).text); assert.ok(chk.existing, 're-import still matches on the name on the books');
      r = await follow(`/buildings/${bid}`, { name: '1657 W Test', display_name: '', address: '1657 W Test Ave', notes: '' }); assert.match(r.text, /<h1>1657 W Test/);
    });
    await test('photo upload, serve, and remove', async () => {
      const bid = importResult.buildingId;
      // smallest valid JPEG (1x1 grey)
      const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
      await get(`/buildings/${bid}/edit`);
      let r = await post(`/buildings/${bid}/photo`, { data: 'data:image/jpeg;base64,' + jpg.toString('base64') }, { json: true }); const j = JSON.parse(r.text); assert.equal(j.ok, true, r.text);
      r = await fetch(BASE + '/photos/' + j.photo, { headers: { cookie } }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
      r = await fetch(BASE + '/photos/' + j.photo, { redirect: 'manual' }); assert.equal(r.status, 303, 'photos need a login');
      r = await get(`/buildings/${bid}`); assert.match(r.text, new RegExp(`class="bhero" href="/buildings/${bid}/edit#photo" style="background-image:url\\('/photos/${j.photo}'\\)`));
      r = await post(`/buildings/${bid}/photo`, { data: 'data:image/png;base64,AAAA' }, { json: true }); assert.equal(JSON.parse(r.text).ok, false);
      r = await follow(`/buildings/${bid}/photo/delete`, {}); assert.match(r.text, /Photo removed/);
      r = await fetch(BASE + '/photos/' + j.photo, { headers: { cookie } }); assert.equal(r.status, 404, 'old file gone');
    });
    await test('buildings can be reordered', async () => {
      let r = await get('/units'); const order = [...r.text.matchAll(/<section class="building" id="b(\d+)"/g)].map(m => m[1]); assert.ok(order.length >= 2);
      await get(`/buildings/${order[1]}/edit`); r = await follow(`/buildings/${order[1]}/move`, { dir: 'up' }); assert.match(r.text, /Order updated/);
      r = await get('/units'); const after = [...r.text.matchAll(/<section class="building" id="b(\d+)"/g)].map(m => m[1]); assert.equal(after[0], order[1]); assert.equal(after[1], order[0]);
    });
    await test('delete a building with confirmation', async () => { let r = await get(`/buildings/${b2}/delete`); assert.match(r.text, /Delete Manual Bldg\?/); r = await follow(`/buildings/${b2}/delete`, {}); assert.match(r.text, /Building deleted/); assert.doesNotMatch(r.text, /Manual Bldg/); });
    await test('unknown page is a 404, not a crash', async () => { const r = await get('/nope/123'); assert.equal(r.status, 404); });
    await test('server log has no errors', async () => { assert.doesNotMatch(serverLog, /Error|TypeError|ReferenceError/); });
    // ---- Phase 2: online payments
    const { signWebhook } = require('../lib/stripe');
    const WH = 'whsec_testsecret';
    let payLink, payToken, tid2;
    await test('pay link exists on the unit page and works without a login', async () => {
      const u = await get(`/units/${unitIds['2']}`); payLink = (u.text.match(/value="(http[^"]+\/pay\/[A-Za-z0-9]+)"/) || [])[1];
      assert.ok(payLink, 'pay link rendered'); payToken = payLink.split('/pay/')[1]; tid2 = u.text.match(/\/tenancies\/(\d+)\/payments/)[1];
      const saved = cookie; cookie = '';
      const r = await get(`/pay/${payToken}`); assert.equal(r.status, 200); assert.match(r.text, /Bob Sample/); assert.match(r.text, /not switched on yet/);
      const bad = await get('/pay/nopenope1234'); assert.equal(bad.status, 404);
      cookie = saved;
    });
    await test('settings: a bad key is rejected, a good one connects', async () => {
      await get('/settings');
      let r = await follow('/settings/stripe', { stripe_secret_key: 'sk_test_bad', stripe_webhook_secret: WH, pay_bank: '1', pay_card: '1', pay_card_fee_to_tenant: '1' }); assert.match(r.text, /Stripe rejected the key/);
      r = await follow('/settings/stripe', { stripe_secret_key: 'sk_test_ok123', stripe_webhook_secret: '', pay_bank: '1', pay_card: '1', pay_card_fee_to_tenant: '1' }); assert.match(r.text, /Connected to Stripe as Test Landlord LLC \(test mode\)/);
      assert.match(r.text, /Webhook secret is set/, 'blank webhook field keeps the earlier secret');
    });
    async function tenantPost(path, form) { const saved = cookie; cookie = ''; const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), redirect: 'manual' }); cookie = saved; return r; }
    async function webhook(event) { const raw = JSON.stringify(event); return fetch(BASE + '/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signWebhook(raw, WH) }, body: raw }); }
    let cardSession, bankSession;
    await test('tenant starts a card payment: session created with rent + fee line items', async () => {
      const r = await tenantPost(`/pay/${payToken}/checkout`, { amount: '1000', method: 'card' }); assert.equal(r.status, 303); const loc = r.headers.get('location'); assert.match(loc, /stripe\.local\/checkout\/cs_test_/);
      cardSession = loc.split('/').pop(); const p = sessions[cardSession].params;
      assert.equal(p['payment_method_types[0]'], 'card'); assert.equal(p['line_items[0][price_data][unit_amount]'], '100000'); assert.equal(p['line_items[1][price_data][product_data][name]'], 'Card processing fee');
      const fee = Number(p['line_items[1][price_data][unit_amount]']); assert.ok(fee > 2900 && fee < 3200, 'fee ~ $30.20 on $1000: ' + fee);
      assert.equal(p['metadata[tenancy_id]'], tid2); assert.match(p['success_url'], /session_id=\{CHECKOUT_SESSION_ID\}/);
    });
    await test('webhook with a bad signature is refused', async () => { const raw = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed' }); const r = await fetch(BASE + '/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=deadbeef' }, body: raw }); assert.equal(r.status, 400); });
    await test('card payment completes: lands on the ledger once, even if the webhook repeats', async () => {
      sessions[cardSession].status = 'complete'; sessions[cardSession].payment_status = 'paid'; sessions[cardSession].payment_intent = 'pi_12345678';
      const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: sessions[cardSession] } };
      let r = await webhook(ev); assert.equal((await r.json()).result, 'recorded');
      r = await webhook(ev); assert.equal((await r.json()).result, 'duplicate');
      r = await webhook({ ...ev, id: 'evt_1b' }); assert.equal((await r.json()).result, 'already recorded');
      const u = await get(`/units/${unitIds['2']}`); assert.match(u.text, /Payment, Online \(card\)/); assert.equal((u.text.match(/Online \(card\)/g) || []).length >= 1, true);
      assert.match(u.text, /incl\. \$3[01]\.\d\d card fee/);
      const j = JSON.parse((await get('/api/export/rentroll')).text); const row = j.rows.find(x => x.tenant === 'Bob Sample'); assert.equal(row.last_method, 'Online (card)');
    });
    await test('tenant sees the done page as paid', async () => { const saved = cookie; cookie = ''; const r = await get(`/pay/${payToken}/done?session_id=${cardSession}`); cookie = saved; assert.match(r.text, /<h1[^>]*>Paid</); assert.match(r.text, /\$1,000\.00 has been received/); });
    await test('bank payment: pending after checkout, then settles on async success', async () => {
      const r = await tenantPost(`/pay/${payToken}/checkout`, { amount: '500', method: 'bank' }); bankSession = r.headers.get('location').split('/').pop();
      const p = sessions[bankSession].params; assert.equal(p['payment_method_types[0]'], 'us_bank_account'); assert.equal(p['line_items[1][price_data][unit_amount]'], undefined, 'no fee on bank');
      sessions[bankSession].status = 'complete'; sessions[bankSession].payment_status = 'unpaid';
      let w = await webhook({ id: 'evt_2', type: 'checkout.session.completed', data: { object: sessions[bankSession] } }); assert.equal((await w.json()).result, 'pending');
      let u = await get(`/units/${unitIds['2']}`); assert.match(u.text, /\$500\.00 bank payment on its way/); assert.match(u.text, /Clearing/);
      let d = await get('/delinquency'); if (new RegExp(`href="/units/${unitIds['2']}"`).test(d.text)) assert.match(d.text, /\$500\.00 clearing/);
      const saved = cookie; cookie = ''; const done = await get(`/pay/${payToken}/done?session_id=${bankSession}`); cookie = saved; assert.match(done.text, /On its way/);
      sessions[bankSession].payment_status = 'paid'; sessions[bankSession].payment_intent = 'pi_bank1';
      w = await webhook({ id: 'evt_3', type: 'checkout.session.async_payment_succeeded', data: { object: sessions[bankSession] } }); assert.equal((await w.json()).result, 'recorded');
      u = await get(`/units/${unitIds['2']}`); assert.match(u.text, /Payment, Online \(bank\)/); assert.doesNotMatch(u.text, /on its way/);
    });
    await test('bank payment failure is marked, nothing lands', async () => {
      const r = await tenantPost(`/pay/${payToken}/checkout`, { amount: '250', method: 'bank' }); const sid = r.headers.get('location').split('/').pop();
      sessions[sid].status = 'complete';
      await webhook({ id: 'evt_4', type: 'checkout.session.completed', data: { object: sessions[sid] } });
      const w = await webhook({ id: 'evt_5', type: 'checkout.session.async_payment_failed', data: { object: sessions[sid] } }); assert.equal((await w.json()).result, 'failed');
      const u = await get(`/units/${unitIds['2']}`); assert.doesNotMatch(u.text, /\$250\.00/);
      const st = await get('/settings'); assert.match(st.text, /Failed/);
    });
    await test('done page syncs a paid session even with no webhook', async () => {
      const r = await tenantPost(`/pay/${payToken}/checkout`, { amount: '75', method: 'card' }); const sid = r.headers.get('location').split('/').pop();
      sessions[sid].status = 'complete'; sessions[sid].payment_status = 'paid'; sessions[sid].payment_intent = 'pi_sync1';
      const saved = cookie; cookie = ''; const d = await get(`/pay/${payToken}/done?session_id=${sid}`); cookie = saved; assert.match(d.text, /<h1[^>]*>Paid</);
      const u = await get(`/units/${unitIds['2']}`); assert.match(u.text, /\$75\.00/);
    });
    await test('turning cards off removes the option; a card attempt is refused', async () => {
      await get('/settings'); await follow('/settings/stripe', { stripe_secret_key: '', stripe_webhook_secret: '', pay_bank: '1', pay_card: '0', pay_card_fee_to_tenant: '1' });
      const saved = cookie; cookie = ''; const r = await get(`/pay/${payToken}`); cookie = saved; assert.doesNotMatch(r.text, /value="card"/);
      const c = await tenantPost(`/pay/${payToken}/checkout`, { amount: '100', method: 'card' }); assert.equal(c.status, 400);
    });
    await test('new link kills the old one; moved-out tenant link stops working', async () => {
      await get(`/units/${unitIds['2']}`); const r = await follow(`/tenancies/${tid2}/pay-link/reset`, {}); assert.match(r.text, /New pay link made/);
      const saved = cookie; cookie = ''; const old = await get(`/pay/${payToken}`); cookie = saved; assert.equal(old.status, 404);
      const u = await get(`/units/${unitIds['3']}`); const link3 = u.text.match(/value="(http[^"]+\/pay\/[A-Za-z0-9]+)"/)[1]; const tok3 = link3.split('/pay/')[1]; const t3 = u.text.match(/\/tenancies\/(\d+)\/move-out/)[1];
      await follow(`/tenancies/${t3}/move-out`, { move_out: `${cur}-28` });
      cookie = ''; const gone = await get(`/pay/${tok3}`); cookie = saved; assert.equal(gone.status, 404);
    });
    // ---- Phase 3: tenant repair requests
    const jpgData = 'data:image/jpeg;base64,' + Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64').toString('base64');
    let newToken, woId;
    await test('tenant link offers a repair report when the setting is on', async () => {
      const u = await get(`/units/${unitIds['2']}`); newToken = u.text.match(/value="http[^"]+\/pay\/([A-Za-z0-9]+)"/)[1];
      const saved = cookie; cookie = '';
      const r = await get(`/pay/${newToken}`); assert.match(r.text, /Something need fixing\?/); assert.match(r.text, /href="\/pay\/[A-Za-z0-9]+\/fix"/);
      const f = await get(`/pay/${newToken}/fix`); assert.equal(f.status, 200); assert.match(f.text, /What is wrong\?/); assert.match(f.text, /Emergency/);
      cookie = saved;
    });
    async function report(body) { const saved = cookie; cookie = ''; const r = await fetch(BASE + `/pay/${newToken}/fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); cookie = saved; return { status: r.status, json: await r.json() }; }
    await test('a report with no title is refused', async () => { const r = await report({ title: '  ', notes: 'x' }); assert.equal(r.status, 400); assert.match(r.json.error, /what is wrong/i); });
    await test('tenant reports a repair with photos; it lands as a work order', async () => {
      const r = await report({ title: 'Kitchen sink leaking', notes: 'Started last night, bucket under it', urgency: 'urgent', photos: [jpgData, jpgData] });
      assert.equal(r.json.ok, true); woId = r.json.id;
      const w = await get('/work'); assert.match(w.text, /Kitchen sink leaking/); assert.match(w.text, /from Bob/); assert.match(w.text, /Soon<\/span>/);
      const imgs = w.text.match(/\/photos\/[a-f0-9]{24}\.jpg/g) || []; assert.ok(imgs.length >= 2, 'two photos shown');
      const img = await fetch(BASE + imgs[0], { headers: { cookie } }); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
      const anon = await fetch(BASE + imgs[0], { redirect: 'manual' }); assert.equal(anon.status, 303, 'photos need a login');
    });
    await test('a bad photo is dropped, the report still lands', async () => {
      const r = await report({ title: 'Front door sticks', photos: ['data:image/png;base64,AAAA', 'not a data url'] });
      assert.equal(r.json.ok, true);
      const e = await get(`/work/${r.json.id}/edit`); assert.match(e.text, /Front door sticks/); assert.doesNotMatch(e.text, /thumbs big/);
    });
    await test('emergency reports sort to the top and are flagged', async () => {
      await report({ title: 'No heat at all', urgency: 'emergency' });
      const w = await get('/work'); const rows = [...w.text.matchAll(/<td>(?:<span class="chip"[^>]*>([^<]*)<\/span> )?([^<]{4,40})</g)].map(m => m[2]);
      assert.match(w.text, /class="hot"/); assert.ok(w.text.indexOf('No heat at all') < w.text.indexOf('Kitchen sink leaking'), 'emergency first');
    });
    await test('the owner sees a badge for unread reports, cleared by opening the page', async () => {
      await get('/work'); // start from a clean slate
      let home = await get('/'); assert.doesNotMatch(home.text, /Work orders<span class="count">/);
      await report({ title: 'Buzzer not working' });
      home = await get('/'); assert.match(home.text, /Work orders<span class="count">1<\/span>/, 'badge appears for a new tenant report');
      await get('/work');
      home = await get('/'); assert.doesNotMatch(home.text, /Work orders<span class="count">/);
    });
    await test('tenant sees status and the note the owner wrote', async () => {
      await get(`/work/${woId}/edit`);
      let r = await follow(`/work/${woId}/edit`, { building_id: importResult.buildingId, unit_id: unitIds['2'], title: 'Kitchen sink leaking', notes: 'x', vendor: 'Plumber', opened_at: `${cur}-02`, cost: '', status: 'open', urgency: 'urgent', tenant_note: 'Plumber coming Thursday' });
      const saved = cookie; cookie = '';
      r = await get(`/pay/${newToken}`); assert.match(r.text, /Kitchen sink leaking/); assert.match(r.text, /Plumber coming Thursday/); assert.match(r.text, /Reported/);
      cookie = saved;
      r = await get(`/work/${woId}/done`); assert.match(r.text, /Note the tenant sees/);
      r = await follow(`/work/${woId}/done`, { cost: '180', category: 'Repairs & maintenance', closed_at: `${cur}-05`, add_expense: '1', tenant_note: 'Fixed, new faucet' }); assert.match(r.text, /\$180\.00 logged to expenses/);
      cookie = '';
      r = await get(`/pay/${newToken}`); assert.match(r.text, /Fixed, new faucet/); assert.match(r.text, /status paid">Fixed/);
      cookie = saved;
    });
    await test('deleting a work order deletes its photos from disk', async () => {
      const e = await get(`/work/${woId}/edit`); const file = (e.text.match(/\/photos\/([a-f0-9]{24}\.jpg)/) || [])[1];
      assert.ok(file, 'photo present before delete');
      await follow(`/work/${woId}/delete`, {});
      const img = await fetch(BASE + '/photos/' + file, { headers: { cookie }, redirect: 'manual' }); assert.equal(img.status, 404, 'file gone');
    });
    await test('flood protection: a tenant cannot open unlimited reports', async () => {
      for (let i = 0; i < 5; i++) await report({ title: 'Spam report ' + i });
      const r = await report({ title: 'One too many' }); assert.equal(r.status, 429); assert.match(r.json.error, /call your landlord/);
    });
    await test('saving rent rules leaves the repair-request switches alone', async () => {
      await get('/settings');
      await follow('/settings', { section: 'requests', requests_on: '1', emergency_phone: '(312) 555-0199' });
      await follow('/settings', { section: 'rules', portfolio_name: 'Test Props', owner_name: 'Test Owner', rent_due_day: '1', grace_days: '5', late_fee_kind: 'percent', late_fee_amount: '5' });
      const r = await get('/settings'); assert.match(r.text, /name="requests_on" value="1" checked/); assert.match(r.text, /\(312\) 555-0199/);
    });
    await test('turning requests off hides the form and refuses posts', async () => {
      await get('/settings');
      await follow('/settings', { section: 'requests', requests_on: '0', emergency_phone: '' });
      const saved = cookie; cookie = '';
      const r = await get(`/pay/${newToken}`); assert.doesNotMatch(r.text, /Something need fixing/);
      const f = await fetch(BASE + `/pay/${newToken}/fix`, { redirect: 'manual' }); assert.equal(f.status, 303);
      cookie = saved;
      await get('/settings');
      await follow('/settings', { section: 'requests', requests_on: '1', emergency_phone: '(312) 555-0100' });
      cookie = '';
      const f2 = await get(`/pay/${newToken}/fix`); assert.match(f2.text, /\(312\) 555-0100/);
      cookie = saved;
    });
  } finally {
    server.kill(); stripeMock.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nserver log:\n' + serverLog); process.exit(1); }
})();
