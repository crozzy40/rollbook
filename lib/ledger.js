'use strict';
// Every number the app shows comes from here. Balances are never stored; they are
// computed from charges minus payments so the ledger can't drift.

const { db, now, getSetting } = require('./db');

// ---- dates ---------------------------------------------------------------

function todayISO(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function periodOf(iso) { return iso.slice(0, 7); }
function currentPeriod() { return periodOf(todayISO()); }
function addMonths(period, n) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function periodDate(period, day) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
function daysBetween(a, b) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
                     Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function periodShort(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', " '");
}

// ---- posting monthly rent --------------------------------------------------
// Called at the top of every request. Cheap: one query for what's missing.
function postRentCharges() {
  const due = Number(getSetting('rent_due_day', '1')) || 1;
  const cur = currentPeriod();
  const tenancies = db.prepare(`SELECT id, rent, charges_from, status, move_out FROM tenancies WHERE status = 'active' AND rent > 0`).all();
  const existing = db.prepare(`SELECT tenancy_id, period FROM charges WHERE kind = 'rent'`).all();
  const have = new Set(existing.map(r => `${r.tenancy_id}|${r.period}`));
  const ins = db.prepare(`INSERT INTO charges(tenancy_id, date, period, kind, amount, memo, created_at) VALUES (?,?,?,?,?,?,?)`);
  let n = 0;
  for (const t of tenancies) {
    let p = t.charges_from;
    // Safety: never post more than 36 months in one go (a typo in charges_from shouldn't flood the ledger).
    let guard = 0;
    while (p <= cur && guard++ < 36) {
      if (!have.has(`${t.id}|${p}`)) {
        ins.run(t.id, periodDate(p, due), p, 'rent', t.rent, 'Monthly rent', now());
        n++;
      }
      p = addMonths(p, 1);
    }
  }
  return n;
}

// ---- allocation & aging ----------------------------------------------------
// FIFO: payments pay off the oldest open charge first. Returns per-charge open amounts.
function allocate(charges, payments) {
  const open = charges
    .slice()
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)
    .map(c => ({ ...c, open: c.amount }));
  let pool = payments.reduce((s, p) => s + p.amount, 0);
  for (const c of open) {
    if (pool <= 0) break;
    const take = Math.min(c.open, pool);
    c.open = round2(c.open - take);
    pool = round2(pool - take);
  }
  return { charges: open, credit: round2(pool) }; // credit = overpayment
}

function round2(n) { return Math.round(n * 100) / 100; }

function aging(openCharges, asOf = todayISO()) {
  const b = { current: 0, d30: 0, d60: 0, d90: 0 };
  let oldest = null;
  for (const c of openCharges) {
    if (c.open <= 0) continue;
    const d = daysBetween(c.date, asOf);
    if (oldest === null || c.date < oldest) oldest = c.date;
    if (d <= 30) b.current += c.open;
    else if (d <= 60) b.d30 += c.open;
    else if (d <= 90) b.d60 += c.open;
    else b.d90 += c.open;
  }
  for (const k in b) b[k] = round2(b[k]);
  return { ...b, oldest, daysLate: oldest ? daysBetween(oldest, asOf) : 0 };
}

// ---- tenancy snapshot --------------------------------------------------------
function tenancyBalance(tenancyId) {
  const charges = db.prepare('SELECT id, date, period, kind, amount, memo FROM charges WHERE tenancy_id = ?').all(tenancyId);
  const payments = db.prepare('SELECT id, date, amount, method FROM payments WHERE tenancy_id = ?').all(tenancyId);
  const alloc = allocate(charges, payments);
  const charged = round2(charges.reduce((s, c) => s + c.amount, 0));
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  const balance = round2(charged - paid);
  const ag = aging(alloc.charges.filter(c => c.open > 0));
  const lastPayment = payments.slice().sort((a, b) => b.date < a.date ? -1 : b.date > a.date ? 1 : b.id - a.id)[0] || null;
  return { charged, paid, balance, credit: alloc.credit, aging: ag, lastPayment, charges, payments, openCharges: alloc.charges };
}

// ---- portfolio-wide views ------------------------------------------------------
// One pass over everything: returns rows per active tenancy with balance, aging, unit, building.
function portfolioRows() {
  const rows = db.prepare(`
    SELECT t.id AS tenancy_id, t.tenant_name, t.rent, t.deposit, t.lease_start, t.lease_end, t.lease_text, t.phone, t.email,
           u.id AS unit_id, u.label AS unit_label, u.kind AS unit_kind,
           b.id AS building_id, b.name AS building_name, b.demo
    FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN buildings b ON b.id = u.building_id
    WHERE t.status = 'active'
    ORDER BY b.sort, b.name, u.sort, u.label`).all();
  const charges = groupBy(db.prepare('SELECT id, tenancy_id, date, period, kind, amount FROM charges').all(), 'tenancy_id');
  const payments = groupBy(db.prepare('SELECT id, tenancy_id, date, amount, method FROM payments').all(), 'tenancy_id');
  const cur = currentPeriod();
  const today = todayISO();
  return rows.map(r => {
    const ch = charges[r.tenancy_id] || [];
    const pm = payments[r.tenancy_id] || [];
    const alloc = allocate(ch, pm);
    const balance = round2(ch.reduce((s, c) => s + c.amount, 0) - pm.reduce((s, p) => s + p.amount, 0));
    const ag = aging(alloc.charges.filter(c => c.open > 0), today);
    const paidThisMonth = round2(pm.filter(p => periodOf(p.date) === cur).reduce((s, p) => s + p.amount, 0));
    const chargedThisMonth = round2(ch.filter(c => c.period === cur).reduce((s, c) => s + c.amount, 0));
    const lastPayment = pm.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)[0] || null;
    let status;
    if (balance <= 0) status = 'paid';
    else if (paidThisMonth > 0 && balance < chargedThisMonth) status = 'partial';
    else if (paidThisMonth > 0) status = 'partial';
    else status = 'owed';
    return { ...r, balance, credit: alloc.credit, aging: ag, paidThisMonth, chargedThisMonth, lastPayment, status };
  });
}

function groupBy(rows, key) {
  const out = {};
  for (const r of rows) (out[r[key]] ||= []).push(r);
  return out;
}

// Unit board for a building: every unit, with its active tenancy row (or vacant).
function unitBoard() {
  const units = db.prepare(`
    SELECT u.id AS unit_id, u.label AS unit_label, u.kind AS unit_kind, u.sort,
           b.id AS building_id, b.name AS building_name, b.address, b.demo
    FROM units u JOIN buildings b ON b.id = u.building_id
    ORDER BY b.sort, b.name, u.sort, u.label`).all();
  const byUnit = {};
  for (const r of portfolioRows()) byUnit[r.unit_id] = r;
  const buildings = [];
  const idx = {};
  for (const u of units) {
    if (!(u.building_id in idx)) {
      idx[u.building_id] = buildings.length;
      buildings.push({ id: u.building_id, name: u.building_name, address: u.address, demo: u.demo, units: [] });
    }
    const row = byUnit[u.unit_id];
    buildings[idx[u.building_id]].units.push(row ? { ...u, ...row, vacant: false } : { ...u, vacant: true, status: 'vacant', balance: 0 });
  }
  // buildings with no units yet still show up
  const empty = db.prepare('SELECT id, name, address, demo FROM buildings WHERE id NOT IN (SELECT DISTINCT building_id FROM units) ORDER BY sort, name').all();
  for (const b of empty) buildings.push({ ...b, units: [] });
  return buildings;
}

// Month totals across the portfolio.
function monthSummary(period = currentPeriod()) {
  const expected = db.prepare(`SELECT COALESCE(SUM(c.amount),0) AS v FROM charges c JOIN tenancies t ON t.id = c.tenancy_id WHERE c.period = ? AND t.status = 'active'`).get(period).v;
  const collected = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE substr(date,1,7) = ?`).get(period).v;
  const expenses = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE substr(date,1,7) = ?`).get(period).v;
  return { period, expected: round2(expected), collected: round2(collected), expenses: round2(expenses) };
}

function lateFeeFor(rent) {
  const kind = getSetting('late_fee_kind', 'flat');
  const amt = Number(getSetting('late_fee_amount', '0')) || 0;
  return kind === 'percent' ? round2(rent * amt / 100) : round2(amt);
}

module.exports = {
  todayISO, periodOf, currentPeriod, addMonths, periodDate, daysBetween, periodLabel, periodShort, round2,
  postRentCharges, allocate, aging, tenancyBalance, portfolioRows, unitBoard, monthSummary, lateFeeFor,
};
