'use strict';
const { esc, money, money0, dateLong, dateShort, CATEGORIES, UNIT_KINDS } = require('./util');
const L = require('./ledger');
const { layout, csrfField, unitName } = require('./views');

// ---------------------------------------------------------------- expenses
function expensesPage(ctx, d) {
  const { rows, buildings, filters, byCategory, total } = d;
  const bOpts = `<option value="">All buildings</option>` + buildings.map(b => `<option value="${b.id}" ${filters.building === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  const cOpts = `<option value="">All categories</option>` + CATEGORIES.map(c => `<option value="${esc(c)}" ${filters.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  return layout(ctx, { title: 'Expenses', active: 'expenses', body: `
    <div class="page-head"><div><h1>Expenses</h1><p class="lede">${filters.period ? esc(L.periodLabel(filters.period)) : filters.year ? filters.year : 'Everything on record'}. ${money(total)} across ${rows.length} entries.</p></div>
      <div class="actions"><a class="btn" href="/expenses/new">Add an expense</a></div></div>
    <form class="filters" method="get" action="/expenses">
      <div class="field"><label for="b">Building</label><select id="b" name="building" onchange="this.form.submit()">${bOpts}</select></div>
      <div class="field"><label for="m">Month</label><input id="m" type="month" name="period" value="${esc(filters.period || '')}" onchange="this.form.submit()"></div>
      <div class="field"><label for="y">Year</label><input id="y" type="number" name="year" value="${esc(filters.year || '')}" min="2000" max="2100" onchange="this.form.submit()" style="width:110px"></div>
      <div class="field"><label for="c">Category</label><select id="c" name="category" onchange="this.form.submit()">${cOpts}</select></div>
      <div class="field"><a class="btn quiet" href="/expenses">Clear</a></div>
    </form>
    ${byCategory.length ? `<div class="figures" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">${byCategory.slice(0, 6).map(c => `<div class="figure"><div class="n" style="font-size:22px">${money0(c.total)}</div><div class="l">${esc(c.category)}</div></div>`).join('')}</div>` : ''}
    ${rows.length ? `<div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>What</th><th class="hide-m">Category</th><th class="hide-m">Building</th><th class="num">Amount</th><th class="no-print"></th></tr></thead><tbody>
      ${rows.map(e => `<tr><td>${dateShort(e.date)}<span class="sub">${e.date.slice(0, 4)}</span></td><td>${esc(e.description)}${e.vendor ? `<span class="sub">${esc(e.vendor)}</span>` : ''}${e.memo && e.source !== 'import' ? `<span class="sub">${esc(e.memo)}</span>` : ''}</td><td class="hide-m">${esc(e.category)}</td><td class="hide-m">${esc(e.building_name)}${e.unit_label ? `<span class="sub">${esc(e.unit_label)}</span>` : ''}</td><td class="num">${money(e.amount)}</td><td class="rowactions no-print"><a href="/expenses/${e.id}/edit">Edit</a></td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="4">Total</td><td class="num">${money(total)}</td><td class="no-print"></td></tr></tfoot></table></div>` :
    `<div class="empty"><h3>No expenses match</h3><p>Change the filters, or add one.</p></div>`}` });
}

function expenseForm(ctx, { e, buildings, units, isNew }) {
  const x = e || { building_id: '', unit_id: '', date: L.todayISO(), category: 'Repairs & maintenance', description: '', vendor: '', amount: '', memo: '' };
  return layout(ctx, { title: isNew ? 'Add an expense' : 'Edit expense', active: 'expenses', body: `
    <h1>${isNew ? 'Add an expense' : 'Edit expense'}</h1>
    <form class="form" method="post" action="${isNew ? '/expenses/new' : `/expenses/${e.id}/edit`}" style="margin-top:20px">${csrfField(ctx)}
      <div class="fields">
        <div class="field"><label for="b">Building</label><select id="b" name="building_id" required>${buildings.map(b => `<option value="${b.id}" ${String(b.id) === String(x.building_id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="u">Unit (optional)</label><select id="u" name="unit_id"><option value="">Whole building</option>${units.map(u => `<option value="${u.id}" data-b="${u.building_id}" ${String(u.id) === String(x.unit_id) ? 'selected' : ''}>${esc(u.building_name)} — ${esc(u.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="dt">Date</label><input id="dt" type="date" name="date" value="${esc(x.date)}" required></div>
        <div class="field"><label for="amt">Amount</label><div class="money-input"><input id="amt" type="number" step="0.01" min="0.01" name="amount" value="${x.amount === '' ? '' : Number(x.amount).toFixed(2)}" required inputmode="decimal"></div></div>
        <div class="field"><label for="cat">Category</label><select id="cat" name="category">${CATEGORIES.map(c => `<option ${c === x.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label for="v">Vendor</label><input id="v" type="text" name="vendor" value="${esc(x.vendor)}" placeholder="optional"></div>
        <div class="field wide"><label for="desc">What was it</label><input id="desc" type="text" name="description" value="${esc(x.description)}" required placeholder="e.g. New water heater, unit 3"></div>
        <div class="field wide"><label for="memo">Note</label><input id="memo" type="text" name="memo" value="${esc(x.memo)}" placeholder="optional"></div>
      </div>
      <div class="actions"><button class="btn" type="submit">${isNew ? 'Add expense' : 'Save changes'}</button><a class="btn secondary" href="/expenses">Cancel</a>${isNew ? '' : `<a class="btn danger" href="/expenses/${e.id}/delete">Delete</a>`}</div>
    </form>
    <script>
      (function(){var b=document.getElementById('b'),u=document.getElementById('u');function f(){var v=b.value;[].forEach.call(u.options,function(o){if(!o.value)return;o.hidden=o.getAttribute('data-b')!==v;if(o.hidden&&o.selected)u.value='';});}b.addEventListener('change',f);f();})();
    </script>` });
}

// ---------------------------------------------------------------- leases
function leasesPage(ctx, rows) {
  const today = L.todayISO();
  const withEnd = rows.filter(r => r.lease_end).map(r => ({ ...r, days: L.daysBetween(today, r.lease_end) })).sort((a, b) => a.days - b.days);
  const noEnd = rows.filter(r => !r.lease_end);
  const cls = d => d < 0 ? 'owed' : d <= 30 ? 'owed' : d <= 90 ? '' : '';
  const flag = d => d < 0 ? 'expired' : d <= 30 ? `${d} days` : d <= 90 ? `${d} days` : `${Math.round(d / 30)} months`;
  return layout(ctx, { title: 'Leases', active: 'leases', body: `
    <div class="page-head"><div><h1>Leases</h1><p class="lede">Soonest to end first. ${withEnd.filter(r => r.days <= 90).length} end within 90 days.</p></div></div>
    ${withEnd.length ? `<div class="table-wrap"><table class="ledger"><thead><tr><th>Tenant</th><th class="hide-m">Building</th><th>Ends</th><th class="hide-m">Started</th><th class="num">Rent</th><th class="num hide-m">Deposit</th><th class="no-print"></th></tr></thead><tbody>
      ${withEnd.map(r => `<tr class="clickable"><td><a class="row-link" href="/units/${r.unit_id}">${esc(r.tenant_name)}</a><span class="sub">${esc(unitName(r))}</span></td><td class="hide-m">${esc(r.building_name)}</td><td class="${cls(r.days)}">${dateShort(r.lease_end)} ${r.lease_end.slice(0, 4)}<span class="sub ${r.days <= 30 ? 'owed' : ''}">${flag(r.days)}</span></td><td class="hide-m">${r.lease_start ? dateShort(r.lease_start) + ' ' + r.lease_start.slice(0, 4) : ''}</td><td class="num">${money(r.rent)}</td><td class="num hide-m">${r.deposit ? money(r.deposit) : '—'}</td><td class="rowactions no-print"><a href="/tenancies/${r.tenancy_id}/edit">Renew / edit</a></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No lease end dates on file yet.</p>'}
    ${noEnd.length ? `<section class="section"><h3 style="margin-bottom:10px">No end date recorded</h3><p class="muted">These came in without a date Rollbook could read. Open each one to set it.</p><table class="ledger"><thead><tr><th>Tenant</th><th>Building</th><th>Written as</th><th></th></tr></thead><tbody>
      ${noEnd.map(r => `<tr><td><a class="row-link" href="/units/${r.unit_id}">${esc(r.tenant_name)}</a><span class="sub">${esc(unitName(r))}</span></td><td>${esc(r.building_name)}</td><td class="muted">${esc(r.lease_text || '')}</td><td class="rowactions"><a href="/tenancies/${r.tenancy_id}/edit">Set dates</a></td></tr>`).join('')}</tbody></table></section>` : ''}` });
}

// ---------------------------------------------------------------- work orders
function workPage(ctx, { open, done, buildings, units }) {
  const row = w => `<tr><td>${dateShort(w.opened_at)}<span class="sub">${w.opened_at.slice(0, 4)}</span></td><td>${esc(w.title)}${w.notes ? `<span class="sub">${esc(w.notes)}</span>` : ''}</td><td class="hide-m">${esc(w.building_name)}${w.unit_label ? `<span class="sub">${esc(w.unit_label)}</span>` : ''}</td><td class="hide-m">${esc(w.vendor)}</td><td class="num">${w.cost ? money(w.cost) : '—'}</td><td class="rowactions no-print"><a href="/work/${w.id}/edit">Edit</a>${w.status === 'open' ? `<a href="/work/${w.id}/done">Mark done</a>` : ''}</td></tr>`;
  return layout(ctx, { title: 'Work orders', active: 'work', body: `
    <div class="page-head"><div><h1>Work orders</h1><p class="lede">${open.length} open.</p></div><div class="actions"><a class="btn" href="/work/new">New work order</a></div></div>
    ${open.length ? `<div class="table-wrap"><table class="ledger"><thead><tr><th>Opened</th><th>What</th><th class="hide-m">Where</th><th class="hide-m">Vendor</th><th class="num">Cost</th><th class="no-print"></th></tr></thead><tbody>${open.map(row).join('')}</tbody></table></div>` : `<div class="empty"><h3>Nothing open</h3><p>Log a repair here when a tenant calls; when it's done, its cost can go straight to Expenses.</p></div>`}
    ${done.length ? `<section class="section"><h3 style="margin-bottom:10px">Done recently</h3><div class="table-wrap"><table class="ledger"><thead><tr><th>Opened</th><th>What</th><th class="hide-m">Where</th><th class="hide-m">Vendor</th><th class="num">Cost</th><th></th></tr></thead><tbody>${done.map(row).join('')}</tbody></table></div></section>` : ''}` });
}
function workForm(ctx, { w, buildings, units, isNew }) {
  const x = w || { building_id: '', unit_id: '', title: '', notes: '', vendor: '', opened_at: L.todayISO(), cost: '', status: 'open' };
  return layout(ctx, { title: isNew ? 'New work order' : 'Edit work order', active: 'work', body: `
    <h1>${isNew ? 'New work order' : 'Edit work order'}</h1>
    <form class="form" method="post" action="${isNew ? '/work/new' : `/work/${w.id}/edit`}" style="margin-top:20px">${csrfField(ctx)}
      <div class="fields">
        <div class="field wide"><label for="t">What needs doing</label><input id="t" type="text" name="title" value="${esc(x.title)}" required placeholder="e.g. Leak under kitchen sink"></div>
        <div class="field"><label for="b">Building</label><select id="b" name="building_id" required>${buildings.map(b => `<option value="${b.id}" ${String(b.id) === String(x.building_id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="u">Unit</label><select id="u" name="unit_id"><option value="">Whole building</option>${units.map(u => `<option value="${u.id}" data-b="${u.building_id}" ${String(u.id) === String(x.unit_id) ? 'selected' : ''}>${esc(u.building_name)} — ${esc(u.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="o">Opened</label><input id="o" type="date" name="opened_at" value="${esc(x.opened_at)}" required></div>
        <div class="field"><label for="v">Vendor</label><input id="v" type="text" name="vendor" value="${esc(x.vendor)}"></div>
        <div class="field"><label for="c">Cost so far</label><div class="money-input"><input id="c" type="number" step="0.01" min="0" name="cost" value="${x.cost === '' ? '' : Number(x.cost).toFixed(2)}"></div></div>
        <div class="field"><label for="s">Status</label><select id="s" name="status"><option value="open" ${x.status === 'open' ? 'selected' : ''}>Open</option><option value="done" ${x.status === 'done' ? 'selected' : ''}>Done</option></select></div>
        <div class="field wide"><label for="n">Notes</label><textarea id="n" name="notes">${esc(x.notes)}</textarea></div>
      </div>
      <div class="actions"><button class="btn" type="submit">${isNew ? 'Open work order' : 'Save changes'}</button><a class="btn secondary" href="/work">Cancel</a>${isNew ? '' : `<a class="btn danger" href="/work/${w.id}/delete">Delete</a>`}</div>
    </form>
    <script>(function(){var b=document.getElementById('b'),u=document.getElementById('u');function f(){var v=b.value;[].forEach.call(u.options,function(o){if(!o.value)return;o.hidden=o.getAttribute('data-b')!==v;if(o.hidden&&o.selected)u.value='';});}b.addEventListener('change',f);f();})();</script>` });
}

// ---------------------------------------------------------------- reports
function reportsPage(ctx, d) {
  const { year, buildings, months, byBuilding, byCategory, years } = d;
  const totalIn = byBuilding.reduce((s, b) => s + b.income, 0), totalOut = byBuilding.reduce((s, b) => s + b.expenses, 0);
  return layout(ctx, { title: 'Reports', active: 'reports', body: `
    <div class="page-head"><div><h1>${year} at a glance</h1><p class="lede">Income is money actually received. Expenses are everything logged, receipts included.</p></div>
      <div class="actions"><form method="get" action="/reports"><select name="year" onchange="this.form.submit()">${years.map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></form><button class="btn secondary" onclick="window.print()">Print</button><a class="btn secondary" href="/export">Excel</a></div></div>
    <div class="figures">
      <div class="figure"><div class="n green">${money0(totalIn)}</div><div class="l">rent received in ${year}</div></div>
      <div class="figure"><div class="n">${money0(totalOut)}</div><div class="l">spent in ${year}</div></div>
      <div class="figure"><div class="n ${totalIn - totalOut < 0 ? 'red' : 'green'}">${money0(totalIn - totalOut)}</div><div class="l">net, before depreciation</div></div>
    </div>
    <section><h2 style="margin-bottom:12px">By building</h2>
      <div class="table-wrap"><table class="ledger"><thead><tr><th>Building</th><th class="num">Received</th><th class="num">Spent</th><th class="num">Net</th><th class="num hide-m">Of which capital</th></tr></thead><tbody>
        ${byBuilding.map(b => `<tr><td>${esc(b.name)}</td><td class="num credit">${money(b.income)}</td><td class="num">${money(b.expenses)}</td><td class="num ${b.income - b.expenses < 0 ? 'owed' : ''}">${money(b.income - b.expenses)}</td><td class="num hide-m muted">${b.capital ? money(b.capital) : '—'}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>All buildings</td><td class="num">${money(totalIn)}</td><td class="num">${money(totalOut)}</td><td class="num ${totalIn - totalOut < 0 ? 'owed' : ''}">${money(totalIn - totalOut)}</td><td class="hide-m"></td></tr></tfoot></table></div>
      <p class="help">Capital improvements (new furnace, roof, full plumbing) are shown separately because your accountant will usually depreciate them rather than expense them in one year.</p>
    </section>
    <section class="section"><h2 style="margin-bottom:12px">Month by month</h2>
      <div class="table-wrap"><table class="ledger"><thead><tr><th>Month</th><th class="num">Due</th><th class="num">Received</th><th class="num">Spent</th><th class="num">Net</th></tr></thead><tbody>
        ${months.map(m => `<tr><td>${esc(L.periodShort(m.period))}</td><td class="num muted">${m.expected ? money(m.expected) : '—'}</td><td class="num credit">${m.collected ? money(m.collected) : '—'}</td><td class="num">${m.expenses ? money(m.expenses) : '—'}</td><td class="num ${m.collected - m.expenses < 0 && (m.collected || m.expenses) ? 'owed' : ''}">${m.collected || m.expenses ? money(m.collected - m.expenses) : '—'}</td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <section class="section"><h2 style="margin-bottom:12px">Expenses by category</h2>
      <div class="table-wrap"><table class="ledger"><thead><tr><th>Category</th>${byBuilding.map(b => `<th class="num hide-m">${esc(b.name)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
        ${byCategory.map(c => `<tr><td>${esc(c.category)}</td>${byBuilding.map(b => `<td class="num hide-m">${c.per[b.id] ? money(c.per[b.id]) : '—'}</td>`).join('')}<td class="num">${money(c.total)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td>${byBuilding.map(b => `<td class="num hide-m">${money(b.expenses)}</td>`).join('')}<td class="num">${money(totalOut)}</td></tr></tfoot></table></div>
    </section>` });
}

// ---------------------------------------------------------------- import
function importPage(ctx, { recent }) {
  return layout(ctx, { title: 'Import workbook', active: 'import', body: `
    <div class="page-head"><div><h1>Import a workbook</h1><p class="lede">One building per file, in the layout you already use: an Income tab, an Expenses tab, and the receipt log. The file is read here in your browser; only the rows you confirm are saved.</p></div></div>
    <div id="step1">
      <label class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.xlsm,.xls"><div class="big">Choose a workbook</div><div class="muted" style="margin-top:6px">or drag it here</div></label>
      <div id="loaderr" class="notice error" style="display:none;margin-top:16px"></div>
      ${recent.length ? `<section class="section"><h3 style="margin-bottom:10px">Imported before</h3><table class="ledger"><thead><tr><th>File</th><th>Building</th><th>When</th><th>Brought in</th></tr></thead><tbody>
        ${recent.map(r => { let s = {}; try { s = JSON.parse(r.summary); } catch (e) { } return `<tr><td>${esc(r.filename)}</td><td>${r.building_id ? `<a href="/units#b${r.building_id}">${esc(r.building_name || '')}</a>` : ''}</td><td>${dateShort(r.created_at.slice(0, 10))}</td><td class="muted">${s.tenants || 0} tenants, ${s.payments || 0} payments, ${(s.expenses || 0) + (s.receipts || 0)} expenses</td></tr>`; }).join('')}
      </tbody></table></section>` : ''}
    </div>
    <div id="step2" style="display:none"></div>`,
    extraHead: `<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js" crossorigin="anonymous"></script>`,
    script: `<script src="/js/parse.js"></script><script src="/js/import.js"></script>` });
}

// ---------------------------------------------------------------- export
function exportPage(ctx, buildings) {
  const yr = new Date().getFullYear();
  return layout(ctx, { title: 'Export to Excel', active: 'export', body: `
    <div class="page-head"><div><h1>Export to Excel</h1><p class="lede">Every export is built right here in your browser from the live ledger. Nothing is sent anywhere.</p></div></div>
    <section>
      <h2 style="margin-bottom:10px">One building, your layout</h2>
      <p class="muted">The same Income / Expenses / Summary / Receipts tabs as your current workbook, filled from Rollbook.</p>
      <div class="filters"><div class="field"><label for="xb">Building</label><select id="xb">${buildings.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="xy">Year</label><input id="xy" type="number" value="${yr}" min="2000" max="2100" style="width:110px"></div>
        <div class="field"><button class="btn" id="btn-building" ${buildings.length ? '' : 'disabled'}>Download workbook</button></div></div>
    </section>
    <section class="section" id="delinquency">
      <h2 style="margin-bottom:10px">Whole portfolio</h2>
      <div class="actions" style="gap:10px">
        <button class="btn secondary" id="btn-rentroll">Rent roll (all units)</button>
        <button class="btn secondary" id="btn-delinquency">Who owes</button>
        <button class="btn secondary" id="btn-yearend">Year-end by building</button>
        <button class="btn secondary" id="btn-expenses">All expenses</button>
      </div>
    </section>
    <section class="section">
      <h2 style="margin-bottom:10px">Backup</h2>
      <p class="muted">A copy of the entire Rollbook database file. Keep one somewhere safe now and then.</p>
      <a class="btn secondary" href="/backup.sqlite">Download backup</a>
    </section>
    <div id="xerr" class="notice error" style="display:none;margin-top:16px"></div>`,
    extraHead: `<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js" crossorigin="anonymous"></script>`,
    script: `<script src="/js/export.js"></script>` });
}

// ---------------------------------------------------------------- settings
function settingsPage(ctx, s, demoCount) {
  return layout(ctx, { title: 'Settings', active: 'settings', body: `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="two-col">
      <form class="form" method="post" action="/settings">${csrfField(ctx)}
        <h2 style="margin-bottom:12px">Rent rules</h2>
        <div class="fields">
          <div class="field"><label for="pn">Portfolio name</label><input id="pn" type="text" name="portfolio_name" value="${esc(s.portfolio_name)}"></div>
          <div class="field"><label for="on">Your name</label><input id="on" type="text" name="owner_name" value="${esc(s.owner_name)}"></div>
          <div class="field"><label for="dd">Rent due on day</label><input id="dd" type="number" name="rent_due_day" min="1" max="28" value="${esc(s.rent_due_day)}"></div>
          <div class="field"><label for="gd">Grace days before a late fee</label><input id="gd" type="number" name="grace_days" min="0" max="31" value="${esc(s.grace_days)}"></div>
          <div class="field"><label for="lk">Late fee</label><select id="lk" name="late_fee_kind"><option value="flat" ${s.late_fee_kind === 'flat' ? 'selected' : ''}>Flat amount</option><option value="percent" ${s.late_fee_kind === 'percent' ? 'selected' : ''}>Percent of rent</option></select></div>
          <div class="field"><label for="la">Amount</label><input id="la" type="number" step="0.01" min="0" name="late_fee_amount" value="${esc(s.late_fee_amount)}"></div>
        </div>
        <button class="btn" type="submit">Save settings</button>
      </form>
      <div>
        <form class="form" method="post" action="/settings/password">${csrfField(ctx)}
          <h2 style="margin-bottom:12px">Password</h2>
          <div class="field"><label for="cp">Current password</label><input id="cp" type="password" name="current" autocomplete="current-password" required></div>
          <div class="field"><label for="np">New password</label><input id="np" type="password" name="password" autocomplete="new-password" required minlength="8"></div>
          <div class="field"><label for="np2">New password again</label><input id="np2" type="password" name="password2" autocomplete="new-password" required minlength="8"></div>
          <button class="btn secondary" type="submit">Change password</button>
        </form>
        <section class="section">
          <h2 style="margin-bottom:12px">Demo data</h2>
          ${demoCount ? `<p class="muted">${demoCount} demo ${demoCount === 1 ? 'building is' : 'buildings are'} loaded, marked with a <span class="chip demo">demo</span> tag. Clearing removes them and everything under them; your own buildings are untouched.</p><a class="btn danger" href="/settings/clear-demo">Clear demo data</a>` :
            `<p class="muted">No demo data loaded.</p><form method="post" action="/settings/seed-demo">${csrfField(ctx)}<button class="btn secondary" type="submit">Load demo portfolio</button></form>`}
        </section>
        <section class="section">
          <h2 style="margin-bottom:12px">About</h2>
          <p class="muted small">Rollbook keeps one file on disk. Download a backup from <a href="/export">Export</a> whenever you like. Built by NormalGuyAI.</p>
        </section>
      </div>
    </div>` });
}

module.exports = { expensesPage, expenseForm, leasesPage, workPage, workForm, reportsPage, importPage, exportPage, settingsPage };
