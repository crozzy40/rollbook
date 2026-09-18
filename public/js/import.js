/* Import page. The workbook is parsed in the browser (SheetJS + parse.js);
   only the confirmed rows are posted to /api/import. */
(function () {
  'use strict';
  var drop = document.getElementById('drop');
  var file = document.getElementById('file');
  var step1 = document.getElementById('step1');
  var step2 = document.getElementById('step2');
  var loaderr = document.getElementById('loaderr');
  var parsed = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function showErr(msg) { loaderr.style.display = 'block'; loaderr.textContent = msg; }

  if (typeof XLSX === 'undefined') {
    showErr('The spreadsheet reader did not load. Check your internet connection and reload this page.');
  }

  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  file.addEventListener('change', function () { if (file.files[0]) handle(file.files[0]); });

  function handle(f) {
    loaderr.style.display = 'none';
    var reader = new FileReader();
    reader.onerror = function () { showErr('Could not read that file.'); };
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: false });
        var sheets = {};
        wb.SheetNames.forEach(function (n) { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }); });
        parsed = RollbookParse.parseWorkbook(sheets, f.name);
        if (!parsed.tenants.length) { showErr('No tenant rows were found. Rollbook expects an "Income" tab with tenant names in column A, rent in column B, lease dates in column C, and twelve month columns.'); return; }
        renderPreview();
      } catch (err) {
        console.error(err);
        showErr('That file could not be read as a workbook: ' + (err.message || err));
      }
    };
    reader.readAsArrayBuffer(f);
  }

  var MONTH_ABBR = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  function monthsStrip(months, rent) {
    return '<div class="preview-months">' + months.map(function (v, i) {
      var cls = v > 0 ? (rent && v < rent ? 'on' : 'on') : 'zero';
      return '<span class="' + cls + '" title="' + money(v) + '">' + MONTH_ABBR[i] + '</span>';
    }).join('') + '</div>';
  }

  function renderPreview() {
    var p = parsed;
    var expTotal = p.expense_lines.reduce(function (s, l) { return s + l.months.reduce(function (a, b) { return a + b; }, 0); }, 0);
    var recTotal = p.receipts.reduce(function (s, r) { return s + r.amount; }, 0);
    var html = '' +
      '<div class="page-head"><div><h1>Check before saving</h1><p class="lede">' + esc(p.filename) + '. Give each tenant a unit number, fix anything that looks wrong, then save.</p></div></div>' +
      (p.warnings.length ? '<div class="notice warn"><ul>' + p.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<div id="serverwarn"></div>' +
      '<div class="fields" style="max-width:620px;margin-bottom:22px">' +
      '<div class="field"><label for="bname">Building name</label><input id="bname" type="text" value="' + esc(p.building_name) + '"></div>' +
      '<div class="field"><label for="baddr">Address</label><input id="baddr" type="text" placeholder="optional"></div>' +
      '<div class="field"><label for="byear">Year these numbers are for</label><input id="byear" type="number" min="2000" max="2100" value="' + p.year + '"><div class="help">The month columns in your template are labeled with old dates; this is the year that actually applies.</div></div>' +
      '</div>' +
      '<h2 style="margin-bottom:10px">Tenants</h2>' +
      '<div class="table-wrap"><table class="ledger" id="tbl-tenants"><thead><tr><th>Unit</th><th>Type</th><th>Tenant</th><th class="num">Rent</th><th>Lease</th><th>Months with money</th><th class="num">Received</th><th>Import</th></tr></thead><tbody>' +
      p.tenants.map(function (t, i) {
        var guess = t.kind === 'garage' ? 'Garage' : t.kind === 'parking' ? 'Parking' : t.kind === 'storage' ? 'Storage' : String(i + 1);
        var received = t.months.reduce(function (a, b) { return a + b; }, 0);
        var leaseOk = t.lease_start && t.lease_end;
        return '<tr data-i="' + i + '">' +
          '<td style="width:110px"><input type="text" class="u-label" value="' + esc(t.unit_label || guess) + '" aria-label="Unit label"></td>' +
          '<td><select class="u-kind">' + ['apartment', 'garage', 'parking', 'storage', 'other'].map(function (k) { return '<option ' + (k === t.kind ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></td>' +
          '<td>' + esc(t.name) + '</td>' +
          '<td class="num">' + money(t.rent) + '</td>' +
          '<td>' + (leaseOk ? esc(t.lease_start) + ' to ' + esc(t.lease_end) : (t.lease_text ? '<span class="muted">"' + esc(t.lease_text) + '" (set dates later)</span>' : '<span class="muted">none</span>')) + '</td>' +
          '<td style="min-width:150px">' + monthsStrip(t.months, t.rent) + '</td>' +
          '<td class="num">' + money(received) + '</td>' +
          '<td><input type="checkbox" class="u-skip" checked aria-label="Import this row"></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<p class="help">Months in green had money recorded; red months had nothing. Months before the first payment are treated as before move-in, not as owed. Each month with money becomes one payment dated the rent due day, so you can tell them apart from payments you record here. A tenant who stopped paying part-way through the year shows as owing; if they actually moved out, open their unit and use Move out with the right date and the later months clear.</p>' +
      '<h2 style="margin:26px 0 10px">Expenses</h2>' +
      '<p class="muted">' + p.expense_lines.length + ' line' + (p.expense_lines.length === 1 ? '' : 's') + ' from the Expenses tab (' + money(expTotal) + ') and ' + p.receipts.length + ' receipt' + (p.receipts.length === 1 ? '' : 's') + ' from the log (' + money(recTotal) + '). Each lands with a category from the chart of accounts; you can change any of them later under Expenses.</p>' +
      (p.expense_lines.length ? '<div class="table-wrap"><table class="ledger"><thead><tr><th>Your label</th><th>Line</th><th class="num">Year total</th></tr></thead><tbody>' +
        p.expense_lines.map(function (l) { return '<tr><td>' + esc(l.category) + '</td><td>' + esc(l.item) + '</td><td class="num">' + money(l.months.reduce(function (a, b) { return a + b; }, 0)) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') +
      (p.receipts.length ? '<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--sky)">Show the ' + p.receipts.length + ' receipts</summary><div class="table-wrap" style="margin-top:10px"><table class="ledger"><thead><tr><th>Date</th><th>What</th><th class="num">Amount</th></tr></thead><tbody>' +
        p.receipts.map(function (r) { return '<tr><td>' + esc(r.date || '?') + '</td><td>' + esc(r.description) + '</td><td class="num">' + money(r.amount) + '</td></tr>'; }).join('') + '</tbody></table></div></details>' : '') +
      '<div class="actions" style="margin-top:28px"><button class="btn" id="save">Save to Rollbook</button><button class="btn secondary" id="cancel">Start over</button></div>' +
      '<div id="saveerr" class="notice error" style="display:none;margin-top:16px"></div>';
    step2.innerHTML = html;
    step1.style.display = 'none';
    step2.style.display = 'block';
    window.scrollTo(0, 0);
    document.getElementById('cancel').addEventListener('click', function () { step2.style.display = 'none'; step1.style.display = 'block'; file.value = ''; });
    document.getElementById('save').addEventListener('click', save);
    check();
    document.getElementById('bname').addEventListener('change', check);
  }

  function collect() {
    var p = parsed;
    var rows = document.querySelectorAll('#tbl-tenants tbody tr');
    var tenants = p.tenants.map(function (t, i) {
      var tr = rows[i];
      return { name: t.name, rent: t.rent, lease_text: t.lease_text, lease_start: t.lease_start, lease_end: t.lease_end,
        kind: tr.querySelector('.u-kind').value, unit_label: tr.querySelector('.u-label').value.trim(), months: t.months,
        skip: !tr.querySelector('.u-skip').checked };
    });
    return { _csrf: window.CSRF, filename: p.filename, building_name: document.getElementById('bname').value.trim(), address: document.getElementById('baddr').value.trim(),
      year: Number(document.getElementById('byear').value), tenants: tenants, other_income: p.other_income, expense_lines: p.expense_lines, receipts: p.receipts };
  }

  function check() {
    fetch('/api/import/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        var box = document.getElementById('serverwarn');
        if (r.existing) box.innerHTML = '<div class="notice warn">A building called "' + esc(r.existing.name) + '" already exists. Saving adds this year\'s numbers to it; units with the same label are reused, and months already imported are skipped.</div>';
        else box.innerHTML = '';
      }).catch(function () { });
  }

  function save() {
    var btn = document.getElementById('save'); btn.disabled = true; btn.textContent = 'Saving…';
    var err = document.getElementById('saveerr'); err.style.display = 'none';
    fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { err.style.display = 'block'; err.innerHTML = '<b>Not saved.</b><ul>' + (r.errors || ['Unknown error']).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>'; btn.disabled = false; btn.textContent = 'Save to Rollbook'; return; }
        var s = r.summary;
        step2.innerHTML = '<h1>Saved</h1><p class="lede" style="margin:8px 0 18px">' + esc(s.building) + ' is in Rollbook: ' + s.tenants + ' tenant' + (s.tenants === 1 ? '' : 's') + ', ' + s.payments + ' payment' + (s.payments === 1 ? '' : 's') + ', ' + (s.expenses + s.receipts) + ' expense' + ((s.expenses + s.receipts) === 1 ? '' : 's') + '.</p>' +
          (s.warnings && s.warnings.length ? '<div class="notice warn"><ul>' + s.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>' : '') +
          '<div class="actions"><a class="btn" href="/units#b' + r.buildingId + '">See the unit board</a><a class="btn secondary" href="/delinquency">Who owes</a><a class="btn secondary" href="/import">Import another building</a></div>';
        window.scrollTo(0, 0);
      })
      .catch(function (e) { err.style.display = 'block'; err.textContent = 'Could not reach the server: ' + e.message; btn.disabled = false; btn.textContent = 'Save to Rollbook'; });
  }
})();
