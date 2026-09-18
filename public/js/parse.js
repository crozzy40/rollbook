/* Rollbook workbook parser.
   Input: { sheetName: [[cell, cell, ...], ...] } as produced by SheetJS
   sheet_to_json(ws, { header: 1, raw: true, defval: null }).
   Dates arrive as Excel serial numbers (SheetJS raw) or ISO strings/Date objects.
   Works in the browser and in Node (module.exports guard at the bottom). */
(function (root) {
  'use strict';

  var MONTHS = 12;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function num(v) {
    if (isNum(v)) return v;
    if (typeof v === 'string') { var n = Number(v.replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }
    return 0;
  }
  // Excel serial -> YYYY-MM-DD (1900 date system).
  function serialToISO(serial) {
    var ms = Math.round((serial - 25569) * 86400000);
    var d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }
  function anyDateToISO(v) {
    if (v == null || v === '') return null;
    if (isNum(v)) return v > 20000 && v < 80000 ? serialToISO(v) : null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    var s = str(v);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[0];
    return parseLooseDate(s);
  }
  // "5-1-25", "8/1/2026", "4-20-26" -> ISO. Two-digit years are 20xx.
  function parseLooseDate(s) {
    var m = str(s).match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (!m) return null;
    var mo = +m[1], d = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  // "5-1-25 to 4-20-26" -> { start, end }
  function parseLeaseText(text) {
    var t = str(text).replace(/\s+/g, ' ');
    if (!t) return { start: null, end: null };
    var parts = t.split(/\s*(?:to|-|–|—|thru|through)\s*(?=\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\s*$)/i);
    if (parts.length === 2) return { start: parseLooseDate(parts[0]), end: parseLooseDate(parts[1]) };
    var all = t.match(/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/g) || [];
    return { start: all[0] ? parseLooseDate(all[0]) : null, end: all[1] ? parseLooseDate(all[1]) : null };
  }

  // Find the sheet by name, case-insensitively, with fallbacks.
  function pick(sheets, names) {
    var keys = Object.keys(sheets);
    for (var i = 0; i < names.length; i++) {
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].trim().toLowerCase() === names[i]) return { name: keys[k], rows: sheets[keys[k]] };
      }
    }
    return null;
  }

  // Locate the header row: the row containing 12 consecutive month cells (dates or serials).
  function findMonthHeader(rows) {
    for (var r = 0; r < Math.min(rows.length, 15); r++) {
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        var run = 0;
        for (var j = c; j < row.length && run < MONTHS; j++) {
          var v = row[j];
          if (isNum(v) && v > 20000 && v < 80000) run++;
          else if (v instanceof Date) run++;
          else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) run++;
          else break;
        }
        if (run === MONTHS) return { row: r, col: c };
      }
    }
    return null;
  }

  // ---- Income sheet ----------------------------------------------------------
  function parseIncome(sheet) {
    var out = { tenants: [], other: [], warnings: [] };
    if (!sheet) { out.warnings.push('No Income sheet found.'); return out; }
    var rows = sheet.rows;
    var hdr = findMonthHeader(rows);
    if (!hdr) { out.warnings.push('Income sheet: could not find the 12 month columns.'); return out; }
    var firstMonth = hdr.col;
    // Rows below the header. Columns: A name, B rent, C lease text, then 12 months.
    var section = 'lease';
    for (var r = hdr.row + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var a = str(row[0]);
      var b = row[1], c = row[2];
      if (/^other$/i.test(a)) { section = 'other'; continue; }
      if (/^lease$/i.test(a) && /^rent$/i.test(str(b))) { section = 'lease'; continue; } // the "Lease / Rent / Lease Date" label row
      if (!a) continue;
      var months = [];
      for (var m = 0; m < MONTHS; m++) months.push(num(row[firstMonth + m]));
      var rent = num(b);
      var received = months.reduce(function (s, v) { return s + v; }, 0);
      if (section === 'other') {
        if (received > 0) out.other.push({ label: a, months: months });
        continue;
      }
      if (rent === 0 && received === 0) continue;
      var lease = parseLeaseText(c);
      var kind = /garage/i.test(a) ? 'garage' : /parking/i.test(a) ? 'parking' : /storage/i.test(a) ? 'storage' : 'apartment';
      var firstPaid = -1;
      for (var i = 0; i < MONTHS; i++) if (months[i] > 0) { firstPaid = i; break; }
      out.tenants.push({
        name: a,
        rent: rent,
        lease_text: str(c),
        lease_start: lease.start,
        lease_end: lease.end,
        kind: kind,
        months: months,
        firstPaidMonth: firstPaid,   // 0-based month index, -1 if nothing received yet
        unit_label: '',              // she fills this in on the preview
      });
    }
    if (!out.tenants.length) out.warnings.push('Income sheet: no tenant rows found under the header.');
    return out;
  }

  // ---- Expenses sheet ----------------------------------------------------------
  // Blocks: column A holds the category on the "Monthly totals:" row; following rows have
  // the line item in column C and 12 monthly amounts.
  function parseExpenses(sheet) {
    var out = { lines: [], warnings: [] };
    if (!sheet) { out.warnings.push('No Expenses sheet found.'); return out; }
    var rows = sheet.rows;
    var hdr = findMonthHeader(rows);
    if (!hdr) { out.warnings.push('Expenses sheet: could not find the 12 month columns.'); return out; }
    var firstMonth = hdr.col;
    var category = '';
    for (var r = hdr.row + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var a = str(row[0]), c = str(row[2]);
      if (a && /monthly totals/i.test(c)) { category = a; continue; }
      if (a && !c) { category = a; continue; }        // a category label with no items yet (e.g. Building Equipment)
      if (!c || /monthly totals/i.test(c)) continue;
      var months = [];
      for (var m = 0; m < MONTHS; m++) months.push(num(row[firstMonth + m]));
      var total = months.reduce(function (s, v) { return s + v; }, 0);
      if (total === 0) continue;
      out.lines.push({ category: category || 'Miscellaneous', item: c, months: months });
    }
    return out;
  }

  // ---- Receipt log (Sheet2) --------------------------------------------------------
  // Rows: date serial | description | amount. Rows with no description are month subtotals.
  function parseReceipts(sheet) {
    var out = { receipts: [], warnings: [] };
    if (!sheet) return out;
    var rows = sheet.rows;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || [];
      var date = anyDateToISO(row[0]);
      var desc = str(row[1]);
      var amt = num(row[2]);
      if (!desc && !date) continue;            // subtotal row
      if (!desc && date) desc = 'Receipt';
      if (!amt) continue;
      out.receipts.push({ date: date, description: desc, amount: Math.round(amt * 100) / 100 });
    }
    return out;
  }

  // ---- year detection ---------------------------------------------------------------
  function guessYear(filename, sheets) {
    var m = str(filename).match(/(20\d{2})/);
    if (m) return +m[1];
    // Latest receipt year wins if present.
    var rec = pick(sheets, ['sheet2', 'receipts', 'log']);
    if (rec) {
      var best = null;
      for (var r = 0; r < rec.rows.length; r++) {
        var iso = anyDateToISO((rec.rows[r] || [])[0]);
        if (iso && (!best || iso > best)) best = iso;
      }
      if (best) return +best.slice(0, 4);
    }
    return new Date().getFullYear();
  }
  function guessBuildingName(filename) {
    var s = str(filename).replace(/\.(xlsx|xlsm|xls|csv)$/i, '');
    s = s.replace(/^copy[\s_]*of[\s_]*/i, '').replace(/[_\-]?20\d{2}$/, '').replace(/[_]+/g, ' ').trim();
    return s || 'Untitled building';
  }

  // ---- top level ----------------------------------------------------------------------
  function parseWorkbook(sheets, filename) {
    var income = parseIncome(pick(sheets, ['income', 'rent', 'rents']));
    var expenses = parseExpenses(pick(sheets, ['expenses', 'expense']));
    var receipts = parseReceipts(pick(sheets, ['sheet2', 'receipts', 'log']));
    var year = guessYear(filename, sheets);
    var warnings = income.warnings.concat(expenses.warnings, receipts.warnings);

    // Her monthly "Supplies" cells are usually the receipt-log subtotals typed by hand.
    // Receipts import line by line, so for any month the receipt log covers we drop the
    // matching Supplies cell; months with no receipts keep the cell so nothing is lost.
    if (receipts.receipts.length) {
      var covered = {};
      receipts.receipts.forEach(function (rc) { if (rc.date) covered[rc.date.slice(0, 7)] = true; });
      var skipped = 0;
      expenses.lines.forEach(function (l) {
        if (!/^supplies$/i.test(l.item)) return;
        for (var m = 0; m < MONTHS; m++) {
          var key = year + '-' + String(m + 1).padStart(2, '0');
          if (l.months[m] && covered[key]) { skipped += l.months[m]; l.months[m] = 0; }
        }
      });
      expenses.lines = expenses.lines.filter(function (l) { return l.months.some(function (v) { return v !== 0; }); });
      if (skipped) warnings.push('Supplies totals for months already covered by the receipt log were skipped ($' + skipped.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ') so purchases are not counted twice.');
    }
    return {
      filename: str(filename),
      building_name: guessBuildingName(filename),
      year: year,
      tenants: income.tenants,
      other_income: income.other,
      expense_lines: expenses.lines,
      receipts: receipts.receipts,
      warnings: warnings,
    };
  }

  var api = { parseWorkbook: parseWorkbook, parseLeaseText: parseLeaseText, parseLooseDate: parseLooseDate, serialToISO: serialToISO, anyDateToISO: anyDateToISO, guessBuildingName: guessBuildingName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RollbookParse = api;
})(typeof window !== 'undefined' ? window : this);
