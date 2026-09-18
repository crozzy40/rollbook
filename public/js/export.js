/* Export page. Workbooks are assembled in the browser with SheetJS from the JSON feeds under /api/export. */
(function () {
  'use strict';
  var err = document.getElementById('xerr');
  function fail(msg) { err.style.display = 'block'; err.textContent = msg; }
  if (typeof XLSX === 'undefined') { fail('The spreadsheet builder did not load. Check your internet connection and reload this page.'); return; }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function col(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function get(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error('Server said ' + r.status); return r.json(); }); }
  function money(ws, range) { // apply currency format to a range of cells
    var r = XLSX.utils.decode_range(range);
    for (var R = r.s.r; R <= r.e.r; R++) for (var C = r.s.c; C <= r.e.c; C++) {
      var cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
    }
  }
  function widths(ws, arr) { ws['!cols'] = arr.map(function (w) { return { wch: w }; }); }
  function download(wb, name) { XLSX.writeFile(wb, name); }
  function sum(a) { return a.reduce(function (s, v) { return s + (Number(v) || 0); }, 0); }
  function busy(btn, on) { btn.disabled = on; btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = on ? 'Building…' : btn.dataset.label; }

  // ---- one building in her layout -------------------------------------------------
  function buildingWorkbook(d) {
    var y = d.year;
    var monthHeads = MONTHS.map(function (m) { return m + ' ' + y; });
    // Income: header, totals row, one row per tenant, formulas for Total and Average.
    var inc = rebuildIncome(d, monthHeads);
    var wsI = XLSX.utils.aoa_to_sheet(inc);
    money(wsI, XLSX.utils.encode_range({ s: { r: 1, c: 1 }, e: { r: inc.length, c: 16 } }));
    widths(wsI, [34, 10, 22].concat(MONTHS.map(function () { return 11; }), [12, 12]));

    // Expenses: category blocks with monthly totals, mirroring her template
    var exp = [[null, null, 'Expenses'].concat(monthHeads, ['Total', 'Average'])];
    var byCat = {};
    d.expenses.forEach(function (e) { var k = e.category; (byCat[k] = byCat[k] || {}); var item = e.description || 'Other'; (byCat[k][item] = byCat[k][item] || new Array(12).fill(0)); byCat[k][item][Number(e.date.slice(5, 7)) - 1] += e.amount; });
    d.categories.forEach(function (cat) {
      if (!byCat[cat]) return;
      var items = Object.keys(byCat[cat]);
      // Many receipts have unique descriptions; roll anything with <2 occurrences into a single line per category to keep the tab readable.
      var lines = [], misc = new Array(12).fill(0), miscN = 0;
      items.forEach(function (it) { var arr = byCat[cat][it]; var nz = arr.filter(function (v) { return v; }).length; if (nz >= 2 || items.length <= 12) lines.push([it, arr]); else { arr.forEach(function (v, i) { misc[i] += v; }); miscN++; } });
      if (miscN) lines.push([miscN + ' other receipts', misc]);
      var start = exp.length + 2; // 1-based row of first line
      var totalRow = [cat, null, 'Monthly totals:'];
      for (var m = 0; m < 12; m++) totalRow.push({ f: 'SUM(' + col(3 + m) + start + ':' + col(3 + m) + (start + lines.length - 1) + ')' });
      totalRow.push({ f: 'SUM(D' + (exp.length + 1) + ':O' + (exp.length + 1) + ')' }, { f: 'P' + (exp.length + 1) + '/12' });
      exp.push(totalRow);
      lines.forEach(function (l) { var r = exp.length + 1; exp.push([null, null, l[0]].concat(l[1].map(function (v) { return Math.round(v * 100) / 100; }), [{ f: 'SUM(D' + r + ':O' + r + ')' }, { f: 'P' + r + '/12' }])); });
      exp.push([]);
    });
    var wsE = XLSX.utils.aoa_to_sheet(exp);
    money(wsE, XLSX.utils.encode_range({ s: { r: 1, c: 3 }, e: { r: exp.length, c: 16 } }));
    widths(wsE, [24, 4, 28].concat(MONTHS.map(function () { return 11; }), [12, 12]));

    // Summary
    var incomeM = new Array(12).fill(0), expM = new Array(12).fill(0);
    d.tenancies.forEach(function (t) { t.months.forEach(function (v, i) { incomeM[i] += v; }); });
    d.expenses.forEach(function (e) { expM[Number(e.date.slice(5, 7)) - 1] += e.amount; });
    var sm = [[null, 'Summary'].concat(monthHeads, ['Total', 'Average'])];
    sm.push([null, 'Income'].concat(incomeM.map(r2), [{ f: 'SUM(C2:N2)' }, { f: 'O2/12' }]));
    sm.push([null, 'Expenses'].concat(expM.map(r2), [{ f: 'SUM(C3:N3)' }, { f: 'O3/12' }]));
    sm.push([null, 'Net'].concat(MONTHS.map(function (_, i) { return { f: col(2 + i) + '2-' + col(2 + i) + '3' }; }), [{ f: 'O2-O3' }, null]));
    sm.push([]); sm.push([null, 'Built by Rollbook on ' + new Date().toISOString().slice(0, 10)]);
    var wsS = XLSX.utils.aoa_to_sheet(sm);
    money(wsS, 'C2:P4');
    widths(wsS, [4, 14].concat(MONTHS.map(function () { return 11; }), [12, 12]));

    // Receipts / all expenses line by line
    var rc = [['Date', 'What', 'Vendor', 'Category', 'Unit', 'Amount', 'Note']];
    d.expenses.forEach(function (e) { rc.push([e.date, e.description, e.vendor, e.category, e.unit_label || '', e.amount, e.memo]); });
    var wsR = XLSX.utils.aoa_to_sheet(rc);
    money(wsR, 'F2:F' + (rc.length + 1));
    widths(wsR, [12, 34, 18, 22, 8, 12, 30]);

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsI, 'Income');
    XLSX.utils.book_append_sheet(wb, wsE, 'Expenses');
    XLSX.utils.book_append_sheet(wb, wsS, 'Summary');
    XLSX.utils.book_append_sheet(wb, wsR, 'Receipts');
    return wb;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function rebuildIncome(d, monthHeads) {
    var n = d.tenancies.length;
    var firstRow = 3; // 1-based: row 1 header, row 2 totals, row 3+ tenants
    var lastRow = firstRow + n - 1;
    var rows = [[null, null, null].concat(monthHeads, ['Total', 'Average'])];
    var totals = ['Lease', 'Rent', 'Lease Date'];
    for (var m = 0; m < 12; m++) totals.push(n ? { f: 'SUM(' + col(3 + m) + firstRow + ':' + col(3 + m) + lastRow + ')' } : 0);
    totals.push(n ? { f: 'SUM(P' + firstRow + ':P' + lastRow + ')' } : 0, n ? { f: 'P2/12' } : 0);
    rows.push(totals);
    d.tenancies.forEach(function (t, i) {
      var r = firstRow + i;
      var label = (t.unit_kind === 'apartment' ? 'Unit ' + t.unit_label + ': ' : t.unit_label + ': ') + t.tenant_name + (t.status === 'ended' ? ' (moved out)' : '');
      rows.push([label, t.rent, t.lease_text || ((t.lease_start || '') + (t.lease_end ? ' to ' + t.lease_end : ''))].concat(t.months.map(r2), [{ f: 'SUM(D' + r + ':O' + r + ')' }, { f: 'P' + r + '/12' }]));
    });
    return rows;
  }

  // ---- portfolio sheets ------------------------------------------------------------------
  function rentRoll(d) {
    var rows = [['Building', 'Unit', 'Type', 'Tenant', 'Phone', 'Email', 'Rent', 'Deposit', 'Lease start', 'Lease end', 'Status', 'Balance owed', 'Last payment', 'By']];
    d.rows.forEach(function (r) { rows.push([r.building, r.unit, r.kind, r.tenant, r.phone, r.email, r.rent, r.deposit, r.lease_start, r.lease_end, r.status, r.balance, r.last_payment, r.last_method]); });
    rows.push([]); rows.push(['Rent roll as of ' + d.asOf, null, null, null, null, 'Total', { f: 'SUM(G2:G' + (d.rows.length + 1) + ')' }, { f: 'SUM(H2:H' + (d.rows.length + 1) + ')' }, null, null, null, { f: 'SUM(L2:L' + (d.rows.length + 1) + ')' }]);
    var ws = XLSX.utils.aoa_to_sheet(rows);
    money(ws, 'G2:H' + (rows.length + 1)); money(ws, 'L2:L' + (rows.length + 1));
    widths(ws, [22, 8, 10, 28, 14, 24, 10, 10, 12, 12, 9, 12, 12, 10]);
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Rent roll'); return wb;
  }
  function delinquency(d) {
    var rows = [['Tenant', 'Building', 'Unit', 'Phone', 'Rent', 'Owed', 'Unpaid since', 'Days late', '0-30', '31-60', '61-90', '90+', 'Last payment', 'Last amount']];
    d.rows.forEach(function (r) { rows.push([r.tenant, r.building, r.unit, r.phone, r.rent, r.owed, r.unpaid_since, r.days_late, r.current, r.d30, r.d60, r.d90, r.last_payment, r.last_amount]); });
    rows.push([]); rows.push(['Delinquency as of ' + d.asOf, null, null, null, 'Total', { f: 'SUM(F2:F' + (d.rows.length + 1) + ')' }, null, null, { f: 'SUM(I2:I' + (d.rows.length + 1) + ')' }, { f: 'SUM(J2:J' + (d.rows.length + 1) + ')' }, { f: 'SUM(K2:K' + (d.rows.length + 1) + ')' }, { f: 'SUM(L2:L' + (d.rows.length + 1) + ')' }]);
    var ws = XLSX.utils.aoa_to_sheet(rows);
    money(ws, 'E2:F' + (rows.length + 1)); money(ws, 'I2:L' + (rows.length + 1)); money(ws, 'N2:N' + (rows.length + 1));
    widths(ws, [28, 22, 8, 14, 10, 12, 12, 9, 10, 10, 10, 10, 12, 12]);
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Who owes'); return wb;
  }
  function yearEnd(d) {
    var rows = [['Building', 'Rent received', 'Total spent', 'Net', 'Of which capital improvements']];
    d.byBuilding.forEach(function (b) { rows.push([b.name, b.income, b.expenses, { f: 'B' + (rows.length + 1) + '-C' + (rows.length + 1) }, b.capital]); });
    var n = d.byBuilding.length;
    rows.push(['All buildings', { f: 'SUM(B2:B' + (n + 1) + ')' }, { f: 'SUM(C2:C' + (n + 1) + ')' }, { f: 'B' + (n + 2) + '-C' + (n + 2) }, { f: 'SUM(E2:E' + (n + 1) + ')' }]);
    var ws = XLSX.utils.aoa_to_sheet(rows); money(ws, 'B2:E' + (n + 2)); widths(ws, [26, 14, 14, 14, 26]);
    var cat = [['Category'].concat(d.byBuilding.map(function (b) { return b.name; }), ['Total'])];
    d.byCategory.forEach(function (c) { cat.push([c.category].concat(d.byBuilding.map(function (b) { return c.per[b.id] || 0; }), [c.total])); });
    var wsC = XLSX.utils.aoa_to_sheet(cat); money(wsC, 'B2:' + col(n + 1) + (cat.length)); widths(wsC, [24].concat(d.byBuilding.map(function () { return 16; }), [14]));
    var mo = [['Month', 'Due', 'Received', 'Spent', 'Net']];
    d.months.forEach(function (m) { mo.push([m.period, m.expected, m.collected, m.expenses, { f: 'C' + (mo.length + 1) + '-D' + (mo.length + 1) }]); });
    var wsM = XLSX.utils.aoa_to_sheet(mo); money(wsM, 'B2:E13'); widths(wsM, [10, 12, 12, 12, 12]);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'By building');
    XLSX.utils.book_append_sheet(wb, wsC, 'By category');
    XLSX.utils.book_append_sheet(wb, wsM, 'By month');
    return wb;
  }
  function allExpenses(d) {
    var rows = [['Date', 'Building', 'Unit', 'Category', 'What', 'Vendor', 'Amount', 'Note']];
    d.rows.forEach(function (e) { rows.push([e.date, e.building_name, e.unit_label || '', e.category, e.description, e.vendor, e.amount, e.memo]); });
    rows.push([]); rows.push([null, null, null, null, null, 'Total', { f: 'SUM(G2:G' + (d.rows.length + 1) + ')' }]);
    var ws = XLSX.utils.aoa_to_sheet(rows); money(ws, 'G2:G' + (rows.length + 1)); widths(ws, [12, 22, 8, 22, 34, 18, 12, 30]);
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Expenses'); return wb;
  }

  // ---- wire up --------------------------------------------------------------------------
  function wire(id, fn) {
    var btn = document.getElementById(id); if (!btn) return;
    btn.addEventListener('click', function () {
      err.style.display = 'none'; busy(btn, true);
      Promise.resolve().then(fn).catch(function (e) { fail('Could not build that file: ' + e.message); }).then(function () { busy(btn, false); });
    });
  }
  wire('btn-building', function () {
    var id = document.getElementById('xb').value, y = document.getElementById('xy').value;
    return get('/api/export/building/' + id + '?year=' + y).then(function (d) { download(buildingWorkbook(d), d.building.name.replace(/[^\w\- ]+/g, '') + ' ' + d.year + '.xlsx'); });
  });
  wire('btn-rentroll', function () { return get('/api/export/rentroll').then(function (d) { download(rentRoll(d), 'Rent roll ' + d.asOf + '.xlsx'); }); });
  wire('btn-delinquency', function () { return get('/api/export/delinquency').then(function (d) { download(delinquency(d), 'Who owes ' + d.asOf + '.xlsx'); }); });
  wire('btn-yearend', function () { var y = document.getElementById('xy').value; return get('/api/export/yearend?year=' + y).then(function (d) { download(yearEnd(d), 'Year end ' + d.year + '.xlsx'); }); });
  wire('btn-expenses', function () { var y = document.getElementById('xy').value; return get('/api/export/expenses?year=' + y).then(function (d) { download(allExpenses(d), 'Expenses ' + y + '.xlsx'); }); });
})();
