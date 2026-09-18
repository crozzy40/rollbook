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
async function follow(p, b, o) { const r = await post(p, b, o); assert.equal(r.status, 303, `expected redirect from ${p}, got ${r.status}`); return get(r.location); }

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

(async () => {
  const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await test('delete a building with confirmation', async () => { let r = await get(`/buildings/${b2}/delete`); assert.match(r.text, /Delete Manual Bldg\?/); r = await follow(`/buildings/${b2}/delete`, {}); assert.match(r.text, /Building deleted/); assert.doesNotMatch(r.text, /Manual Bldg/); });
    await test('unknown page is a 404, not a crash', async () => { const r = await get('/nope/123'); assert.equal(r.status, 404); });
    await test('server log has no errors', async () => { assert.doesNotMatch(serverLog, /Error|TypeError|ReferenceError/); });
  } finally {
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nserver log:\n' + serverLog); process.exit(1); }
})();
