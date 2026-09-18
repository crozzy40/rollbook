'use strict';
// Takes the JSON the browser sends after she confirms the preview and writes it to the ledger.
// Everything happens in one transaction: either the whole workbook lands or none of it does.

const { db, now, transaction } = require('./db');
const { categorizeLine, categorizeReceipt, CATEGORIES } = require('./util');
const { periodDate, currentPeriod, addMonths } = require('./ledger');

function pad2(n) { return String(n).padStart(2, '0'); }
function isISO(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function clean(s, max = 200) { return String(s == null ? '' : s).trim().slice(0, max); }
function amt(v) { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; }

function validate(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') return ['Nothing to import.'];
  if (!clean(payload.building_name)) errors.push('Building needs a name.');
  const year = Number(payload.year);
  if (!(year >= 2000 && year <= 2100)) errors.push('Year must be between 2000 and 2100.');
  if (!Array.isArray(payload.tenants)) errors.push('No tenant rows.');
  else {
    const labels = new Set();
    payload.tenants.forEach((t, i) => {
      if (t.skip) return;
      if (!clean(t.name)) errors.push(`Row ${i + 1}: tenant needs a name.`);
      const lbl = clean(t.unit_label, 40);
      if (!lbl) errors.push(`${clean(t.name) || 'Row ' + (i + 1)}: needs a unit number or label.`);
      else if (labels.has(lbl.toLowerCase())) errors.push(`Unit "${lbl}" is used twice.`);
      else labels.add(lbl.toLowerCase());
      if (!Array.isArray(t.months) || t.months.length !== 12) errors.push(`${clean(t.name)}: needs 12 monthly amounts.`);
    });
  }
  return errors;
}

function apply(payload, rentDueDay = 1) {
  const errors = validate(payload);
  if (errors.length) { const e = new Error(errors.join(' ')); e.errors = errors; throw e; }

  const year = Number(payload.year);
  const cur = currentPeriod();
  const summary = { building: '', units: 0, tenants: 0, charges: 0, payments: 0, expenses: 0, receipts: 0, warnings: [] };

  return transaction(() => {
    const ts = now();
    // Building: reuse by exact name (re-importing the same building's next year), else create.
    // Never merge real data into a demo building, whatever it is called.
    let building = db.prepare('SELECT id, name FROM buildings WHERE lower(name) = lower(?) AND demo = 0').get(clean(payload.building_name));
    if (!building) {
      const sort = (db.prepare('SELECT COALESCE(MAX(sort),0) AS s FROM buildings').get().s) + 1;
      const r = db.prepare('INSERT INTO buildings(name, address, notes, sort, demo, created_at) VALUES (?,?,?,?,0,?)')
        .run(clean(payload.building_name), clean(payload.address || ''), '', sort, ts);
      building = { id: Number(r.lastInsertRowid), name: clean(payload.building_name) };
    }
    summary.building = building.name;

    const insUnit = db.prepare('INSERT INTO units(building_id, label, kind, notes, sort) VALUES (?,?,?,?,?)');
    const insTen = db.prepare(`INSERT INTO tenancies(unit_id, tenant_name, phone, email, rent, deposit, lease_start, lease_end, lease_text, charges_from, status, notes, created_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?)`);
    const insCh = db.prepare(`INSERT OR IGNORE INTO charges(tenancy_id, date, period, kind, amount, memo, created_at) VALUES (?,?,?,?,?,?,?)`);
    const insPay = db.prepare(`INSERT INTO payments(tenancy_id, date, amount, method, reference, memo, source, created_at) VALUES (?,?,?,?,?,?,'import',?)`);
    const insExp = db.prepare(`INSERT INTO expenses(building_id, unit_id, date, category, description, vendor, amount, memo, source, created_at) VALUES (?,NULL,?,?,?,?,?,?,'import',?)`);

    let usort = 0;
    for (const t of payload.tenants) {
      if (t.skip) continue;
      const label = clean(t.unit_label, 40);
      // Reuse an existing unit with the same label in this building (second-year import), else create.
      let unit = db.prepare('SELECT id FROM units WHERE building_id = ? AND lower(label) = lower(?)').get(building.id, label);
      if (!unit) {
        const r = insUnit.run(building.id, label, clean(t.kind || 'apartment', 20), '', ++usort);
        unit = { id: Number(r.lastInsertRowid) };
        summary.units++;
      }
      // If this unit already has an active tenancy with the same name, add to it rather than duplicating.
      let tenancyId;
      const existing = db.prepare(`SELECT id FROM tenancies WHERE unit_id = ? AND status = 'active' AND lower(tenant_name) = lower(?)`).get(unit.id, clean(t.name));
      const months = t.months.map(amt);
      const firstPaid = months.findIndex(v => v > 0);
      const rent = amt(t.rent);
      // Rent is charged from the first month money came in this year, or from lease start if that is inside the year
      // and earlier, or from January if nothing has been received yet (a brand-new tenant).
      let chargesFrom;
      if (firstPaid >= 0) chargesFrom = `${year}-${pad2(firstPaid + 1)}`;
      else if (isISO(t.lease_start) && t.lease_start.slice(0, 4) === String(year)) chargesFrom = t.lease_start.slice(0, 7);
      else chargesFrom = `${year}-01`;
      if (isISO(t.lease_start) && t.lease_start.slice(0, 7) > chargesFrom && t.lease_start.slice(0, 4) === String(year) && firstPaid < 0) chargesFrom = t.lease_start.slice(0, 7);
      if (chargesFrom > cur) chargesFrom = cur; // don't schedule the future

      if (existing) {
        tenancyId = existing.id;
        db.prepare('UPDATE tenancies SET rent = ?, lease_text = COALESCE(NULLIF(?, \'\'), lease_text), lease_start = COALESCE(?, lease_start), lease_end = COALESCE(?, lease_end), charges_from = MIN(charges_from, ?) WHERE id = ?')
          .run(rent, clean(t.lease_text), isISO(t.lease_start) ? t.lease_start : null, isISO(t.lease_end) ? t.lease_end : null, chargesFrom, tenancyId);
      } else {
        const r = insTen.run(unit.id, clean(t.name), clean(t.phone || '', 40), clean(t.email || '', 120), rent, amt(t.deposit || 0),
          isISO(t.lease_start) ? t.lease_start : null, isISO(t.lease_end) ? t.lease_end : null, clean(t.lease_text), chargesFrom, '', ts);
        tenancyId = Number(r.lastInsertRowid);
        summary.tenants++;
      }

      // One rent charge per month from chargesFrom through the last month with money or the current month, whichever is later within the year.
      // Current year: through today (so this month's rent shows as due). A past year: only through the last
      // month that had money, so a tenant who left mid-year is not shown owing for the rest of it.
      const lastPaid = months.reduce((last, v, i) => (v > 0 ? i : last), -1);
      let endPeriod;
      if (`${year}` === cur.slice(0, 4)) endPeriod = cur; // money in future months becomes credit on account
      else if (`${year}` < cur.slice(0, 4)) endPeriod = lastPaid >= 0 ? `${year}-${pad2(lastPaid + 1)}` : `${year}-00`;
      else endPeriod = `${year}-00`; // a future year: nothing is due yet
      let p = chargesFrom;
      let guard = 0;
      while (p <= endPeriod && guard++ < 13) {
        if (p.slice(0, 4) !== String(year)) break;
        const r = insCh.run(tenancyId, periodDate(p, rentDueDay), p, 'rent', rent, 'Monthly rent', ts);
        if (r.changes) summary.charges++;
        p = addMonths(p, 1);
      }
      // Payments: one per month with money in it, dated the due day, method "Other" and memo saying it came from the workbook.
      // Skip a month if an imported payment already exists for it (re-import safety).
      for (let m = 0; m < 12; m++) {
        if (months[m] <= 0) continue;
        const period = `${year}-${pad2(m + 1)}`;
        const dup = db.prepare(`SELECT 1 FROM payments WHERE tenancy_id = ? AND source = 'import' AND substr(date,1,7) = ?`).get(tenancyId, period);
        if (dup) continue;
        insPay.run(tenancyId, periodDate(period, rentDueDay), months[m], 'Other', '', `From ${payload.filename || 'workbook'}`, ts);
        summary.payments++;
      }
    }

    // Other income rows (e.g. laundry) are stored as payments? No: they have no tenancy. Kept as a note for now.
    if (Array.isArray(payload.other_income) && payload.other_income.length) {
      summary.warnings.push(`${payload.other_income.length} "Other" income row(s) were not imported; Rollbook tracks income per unit. Add them as a unit (for example "Laundry") if you want them in the ledger.`);
    }

    // Expense lines: one expense per non-zero month cell, categorized onto the chart of accounts.
    const seenLine = {};
    for (const l of (payload.expense_lines || [])) {
      const cat = CATEGORIES.includes(l.category_final) ? l.category_final : categorizeLine(l.category, l.item);
      for (let m = 0; m < 12; m++) {
        const v = amt((l.months || [])[m]);
        if (!v) continue;
        const period = `${year}-${pad2(m + 1)}`;
        const key = `${period}|${clean(l.item)}|${v}`;
        seenLine[key] = (seenLine[key] || 0) + 1;
        const have = db.prepare(`SELECT COUNT(*) c FROM expenses WHERE building_id = ? AND source = 'import' AND substr(date,1,7) = ? AND description = ? AND amount = ? AND memo != 'Receipt log'`).get(building.id, period, clean(l.item), v).c;
        if (have >= seenLine[key]) continue;
        insExp.run(building.id, periodDate(period, 1), cat, clean(l.item), '', v, `From ${payload.filename || 'workbook'}`, ts);
        summary.expenses++;
      }
    }
    // Receipts: one expense each, with their real date.
    // Identical rows are real (two appliances on the same day). Skip only as many as a previous
    // import of this building already holds, so a re-import adds nothing and a fresh import drops nothing.
    const seenRec = {};
    for (const r of (payload.receipts || [])) {
      const v = amt(r.amount);
      if (!v) continue;
      const date = isISO(r.date) ? r.date : `${year}-01-01`;
      const cat = CATEGORIES.includes(r.category_final) ? r.category_final : categorizeReceipt(r.description, v);
      const key = `${date}|${clean(r.description)}|${v}`;
      seenRec[key] = (seenRec[key] || 0) + 1;
      const have = db.prepare(`SELECT COUNT(*) c FROM expenses WHERE building_id = ? AND source = 'import' AND date = ? AND description = ? AND amount = ?`).get(building.id, date, clean(r.description), v).c;
      if (have >= seenRec[key]) continue;
      insExp.run(building.id, date, cat, clean(r.description), '', v, 'Receipt log', ts);
      summary.receipts++;
    }

    db.prepare('INSERT INTO imports(building_id, filename, summary, created_at) VALUES (?,?,?,?)')
      .run(building.id, clean(payload.filename || 'workbook', 200), JSON.stringify(summary), ts);
    return { buildingId: building.id, summary };
  });
}

module.exports = { apply, validate };
