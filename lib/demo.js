'use strict';
// A small fake portfolio so the app can be shown without anyone's real data.
// Every building is flagged demo = 1; "Clear demo data" deletes them and everything under them.

const { db, now, transaction } = require('./db');
const { currentPeriod, addMonths, periodDate, todayISO } = require('./ledger');

const NAMES = ['Dana Whitfield', 'Marcus Oyelaran', 'Priya Natarajan', 'Tomás Reyes', 'Helen Ashby', 'Jordan Kimura',
  'Leah Brandt', 'Samuel Okoro', 'Nina Castellanos', 'Owen Fitzgerald', 'Ruth Adeyemi', 'Victor Lindqvist',
  'Maya Sørensen', 'Caleb Thornton', 'Ines Moreau', 'Darius Webb', 'Fiona Gallagher', 'Amir Haddad'];

function seed() {
  if (db.prepare('SELECT 1 FROM buildings WHERE demo = 1 LIMIT 1').get()) return 0;
  const cur = currentPeriod();
  const start = addMonths(cur, -8); // nine months of history
  const ts = now();
  let ni = 0;
  const plan = [
    { name: '100 Sample Ave', address: '100 Sample Ave (demo)', units: [
      { label: '1', rent: 2500, status: 'ok' }, { label: '2', rent: 3500, status: 'late2' }, { label: '3', rent: 3500, status: 'ok' },
      { label: '4', rent: 3500, status: 'partial' }, { label: 'Garage', rent: 350, kind: 'garage', status: 'ok' } ] },
    { name: '2200 Example St', address: '2200 Example St (demo)', units: [
      { label: '1A', rent: 1850, status: 'ok' }, { label: '1B', rent: 1850, status: 'late1' }, { label: '2A', rent: 1950, status: 'ok' },
      { label: '2B', rent: 1950, status: 'vacant' }, { label: '3A', rent: 2100, status: 'ok' }, { label: '3B', rent: 2100, status: 'late3' },
      { label: 'Garage', rent: 200, kind: 'garage', status: 'ok' } ] },
    { name: '45 Placeholder Ct', address: '45 Placeholder Ct (demo)', units: [
      { label: '1', rent: 1650, status: 'ok' }, { label: '2', rent: 1650, status: 'ok' }, { label: '3', rent: 1700, status: 'partial' },
      { label: '4', rent: 1700, status: 'ok' }, { label: '5', rent: 1800, status: 'ok' }, { label: '6', rent: 1800, status: 'ok' } ] },
  ];
  const insB = db.prepare('INSERT INTO buildings(name,address,notes,sort,demo,created_at) VALUES (?,?,?,?,1,?)');
  const insU = db.prepare('INSERT INTO units(building_id,label,kind,notes,sort) VALUES (?,?,?,?,?)');
  const insT = db.prepare(`INSERT INTO tenancies(unit_id,tenant_name,phone,email,rent,deposit,lease_start,lease_end,lease_text,charges_from,status,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'active','',?)`);
  const insC = db.prepare(`INSERT INTO charges(tenancy_id,date,period,kind,amount,memo,created_at) VALUES (?,?,?,?,?,?,?)`);
  const insP = db.prepare(`INSERT INTO payments(tenancy_id,date,amount,method,reference,memo,source,created_at) VALUES (?,?,?,?,?,?,'manual',?)`);
  const insE = db.prepare(`INSERT INTO expenses(building_id,unit_id,date,category,description,vendor,amount,memo,source,created_at) VALUES (?,?,?,?,?,?,?,?,'manual',?)`);
  const insW = db.prepare(`INSERT INTO work_orders(building_id,unit_id,title,notes,vendor,status,opened_at,closed_at,cost,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const methods = ['Zelle', 'Check', 'Cash', 'Bank transfer', 'Zelle', 'RentRedi'];
  let bsort = 0;
  return transaction(() => {
    for (const b of plan) {
      const bid = Number(insB.run(b.name, b.address, 'Demo building', ++bsort, ts).lastInsertRowid);
      let usort = 0;
      const unitIds = {};
      for (const u of b.units) {
        const uid = Number(insU.run(bid, u.label, u.kind || 'apartment', '', ++usort).lastInsertRowid);
        unitIds[u.label] = uid;
        if (u.status === 'vacant') continue;
        const name = u.kind === 'garage' ? NAMES[(ni - 1 + NAMES.length) % NAMES.length] : NAMES[ni++ % NAMES.length];
        const ls = addMonths(start, -(usort % 4) - 2) + '-01';
        // Lease ends spread over the next 1–14 months so the Leases page has something to show.
        const leaseEnd = periodDate(addMonths(cur, 1 + ((usort * 5 + bsort * 3) % 14)), 1);
        const tid = Number(insT.run(uid, name, u.kind === 'garage' ? '' : `(312) 555-0${100 + ni}`, u.kind === 'garage' ? '' : name.split(' ')[0].toLowerCase() + '@example.com',
          u.rent, u.kind === 'garage' ? 0 : u.rent, ls, leaseEnd, `${ls} to ${leaseEnd}`, start, ts).lastInsertRowid);
        // charges + payments month by month
        let p = start, i = 0;
        while (p <= cur) {
          insC.run(tid, periodDate(p, 1), p, 'rent', u.rent, 'Monthly rent', ts);
          const isCur = p === cur;
          const monthsAgo = Math.round((Date.UTC(+cur.slice(0, 4), +cur.slice(5, 7) - 1) - Date.UTC(+p.slice(0, 4), +p.slice(5, 7) - 1)) / (30 * 86400000));
          let pay = u.rent;
          if (u.status === 'late1' && isCur) pay = 0;
          if (u.status === 'late2' && monthsAgo <= 1) pay = 0;
          if (u.status === 'late3' && monthsAgo <= 2) pay = monthsAgo === 2 ? u.rent * 0.5 : 0;
          if (u.status === 'partial' && isCur) pay = Math.round(u.rent * 0.6);
          if (pay > 0) {
            const day = 1 + ((i * 3 + usort) % 6);
            insP.run(tid, periodDate(p, day), pay, methods[(i + usort) % methods.length], '', '', ts);
          }
          p = addMonths(p, 1); i++;
        }
      }
      // expenses: mortgage monthly, utilities, a few repairs
      let p = start;
      const mort = b.units.length * 1550;
      while (p <= cur) {
        insE.run(bid, null, periodDate(p, 1), 'Mortgage', 'Mortgage payment', 'Bank', mort, '', ts);
        insE.run(bid, null, periodDate(p, 12), 'Utilities', 'Gas', 'Peoples Gas', 90 + (p.slice(5, 7) % 5) * 60, '', ts);
        insE.run(bid, null, periodDate(p, 15), 'Utilities', 'Water', 'City water', 180 + (b.units.length * 20), '', ts);
        p = addMonths(p, 1);
      }
      insE.run(bid, unitIds[b.units[1].label], periodDate(addMonths(cur, -2), 9), 'Repairs & maintenance', 'Kitchen faucet replaced', 'Handyman', 240, '', ts);
      insE.run(bid, null, periodDate(addMonths(cur, -1), 20), 'Supplies', 'Furnace filters, light bulbs', 'Hardware store', 86.4, '', ts);
      insE.run(bid, null, periodDate(addMonths(cur, -4), 3), 'Property tax', 'First installment', 'County', b.units.length * 1180, '', ts);
      const wo = [['Bathroom fan rattles', 'Tenant says it started last week.'], ['Back porch light out', 'Replace fixture, check the switch.'], ['Radiator knocking in unit 5', 'Bleed the line before the heat comes on.']][bsort - 1];
      insW.run(bid, unitIds[b.units[0].label], wo[0], wo[1], '', 'open', todayISO(), null, 0, ts);
      if (b.units.some(u => u.status === 'vacant')) insW.run(bid, unitIds['2B'], 'Turnover: paint and clean', 'Ready to list once done.', 'Cleaning crew', 'open', periodDate(cur, 2), null, 0, ts);
    }
    return plan.length;
  });
}

function clear() {
  return transaction(() => db.prepare('DELETE FROM buildings WHERE demo = 1').run().changes);
}

module.exports = { seed, clear };
