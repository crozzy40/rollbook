'use strict';
const { esc, money, money0, dateLong, dateShort, CATEGORIES, PAYMENT_METHODS, UNIT_KINDS } = require('./util');
const L = require('./ledger');

// ---------------------------------------------------------------- layout
function layout(ctx, { title, active, body, wide = false, extraHead = '', script = '' }) {
  const owed = ctx.owedCount || 0;
  const navItems = [
    ['/', 'Today', 'home'],
    ['/delinquency', 'Who owes', 'owed'],
    ['/units', 'Units', 'units'],
    ['/leases', 'Leases', 'leases'],
    ['/expenses', 'Expenses', 'expenses'],
    ['/work', 'Work orders', 'work'],
    ['/reports', 'Reports', 'reports'],
    ['/import', 'Import workbook', 'import'],
    ['/export', 'Export to Excel', 'export'],
    ['/settings', 'Settings', 'settings'],
  ];
  const nav = navItems.map(([href, label, key]) =>
    `<a href="${href}" class="${active === key ? 'on' : ''}">${label}${key === 'owed' && owed ? `<span class="count">${owed}</span>` : ''}</a>`).join('');
  const tabs = [['/', 'Today', 'home'], ['/delinquency', 'Who owes', 'owed'], ['/units', 'Units', 'units'], ['/expenses', 'Expenses', 'expenses'], ['/more', 'More', 'more']]
    .map(([href, label, key]) => `<a href="${href}" class="${active === key || (key === 'more' && ['leases', 'work', 'reports', 'import', 'export', 'settings'].includes(active)) ? 'on' : ''}">${label}${key === 'owed' && owed ? `<span class="count">${owed}</span>` : ''}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Rollbook</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke="#1F5A38" stroke-width="2"/><rect x="3" y="7" width="10" height="2" fill="#1F5A38"/></svg>')}">
<link rel="stylesheet" href="/app.css">
${extraHead}
</head>
<body>
<div class="frame">
  <aside class="rail">
    <div class="brand"><span class="mark"></span><span class="word">Rollbook</span></div>
    <div class="portfolio">${esc(ctx.portfolioName)}</div>
    <nav class="nav">${nav}</nav>
    <div class="foot"><a href="/logout">Sign out</a></div>
  </aside>
  <main class="main"><div class="page${wide ? ' wide' : ''}">
    ${ctx.flash ? `<div class="notice ${esc(ctx.flash.kind || '')}">${ctx.flash.html || esc(ctx.flash.text)}</div>` : ''}
    ${body}
  </div></main>
</div>
<nav class="tabbar">${tabs}</nav>
<script>window.CSRF=${JSON.stringify(ctx.csrf || '')};</script>
${script}
<script>if(location.hash==='#charge'){var d=document.getElementById('charge');if(d)d.open=true;}</script>
</body>
</html>`;
}

function morePage(ctx) {
  const items = [['/leases', 'Leases', 'End dates, soonest first'], ['/work', 'Work orders', 'Repairs open and done'], ['/reports', 'Reports', 'Year at a glance'], ['/import', 'Import workbook', 'Bring in a building from Excel'], ['/export', 'Export to Excel', 'Workbooks, rent roll, backup'], ['/settings', 'Settings', 'Rent rules, password, demo data'], ['/logout', 'Sign out', '']];
  return layout(ctx, { title: 'More', active: 'more', body: `<h1>More</h1><table class="ledger" style="margin-top:16px"><tbody>${items.map(([h, t, d]) => `<tr class="clickable"><td><a class="row-link" href="${h}">${t}</a>${d ? `<span class="sub">${d}</span>` : ''}</td></tr>`).join('')}</tbody></table>` });
}

function gate({ title, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Rollbook</title><link rel="stylesheet" href="/app.css"></head>
<body><div class="gate"><div class="box"><div class="brand"><span class="mark"></span><span class="word">Rollbook</span></div>${body}</div></div></body></html>`;
}

function csrfField(ctx) { return `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`; }
function statusWord(s) { return { paid: 'Paid up', partial: 'Partial', owed: 'Owes', vacant: 'Vacant' }[s] || s; }
function unitName(row) { return row.unit_kind === 'apartment' ? `Unit ${row.unit_label}` : row.unit_label; }

// ---------------------------------------------------------------- login / setup
function setupPage(ctx, error) {
  return gate({ title: 'Set up', body: `
    <h1>Set a password</h1>
    <p class="muted">This is the only account. You'll use this password every time you open Rollbook.</p>
    ${error ? `<div class="notice error">${esc(error)}</div>` : ''}
    <form method="post" action="/setup">
      ${csrfField(ctx)}
      <div class="field"><label for="name">Your name</label><input id="name" type="text" name="owner_name" autocomplete="name"></div>
      <div class="field"><label for="pname">Portfolio name</label><input id="pname" type="text" name="portfolio_name" placeholder="e.g. Hollywood Properties"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="new-password" required minlength="8"></div>
      <div class="field"><label for="pw2">Password again</label><input id="pw2" type="password" name="password2" autocomplete="new-password" required minlength="8"></div>
      <div class="checkline"><input type="checkbox" name="demo" id="demo" value="1" checked><label for="demo" style="margin:0">Start with a small demo portfolio so I can look around (easy to clear later)</label></div>
      <div style="margin-top:18px"><button class="btn" type="submit">Open Rollbook</button></div>
    </form>` });
}
function loginPage(ctx, error) {
  return gate({ title: 'Sign in', body: `
    <h1>Sign in</h1>
    ${error ? `<div class="notice error">${esc(error)}</div>` : ''}
    <form method="post" action="/login">
      ${csrfField(ctx)}
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password" autofocus required></div>
      <div style="margin-top:14px"><button class="btn" type="submit">Sign in</button></div>
    </form>` });
}

// ---------------------------------------------------------------- dashboard
function dashboard(ctx, d) {
  const { month, rows, leases, work, buildings } = d;
  const owedRows = rows.filter(r => r.balance > 0).sort((a, b) => b.balance - a.balance);
  const owedTotal = owedRows.reduce((s, r) => s + r.balance, 0);
  const units = rows.length + d.vacantCount;
  const pct = month.expected ? Math.min(100, Math.round(month.collected / month.expected * 100)) : 0;
  const first = ctx.ownerName ? `, ${esc(ctx.ownerName.split(' ')[0])}` : '';
  const empty = !buildings.length;
  return layout(ctx, { title: 'Today', active: 'home', body: `
    <div class="page-head">
      <div><h1>${esc(L.periodLabel(month.period))}</h1><p class="lede">${dateLong(L.todayISO())}${first ? `. Good to see you${first}.` : ''}</p></div>
      <div class="actions"><a class="btn" href="/units">Record a payment</a><a class="btn secondary" href="/expenses/new">Add an expense</a></div>
    </div>
    ${empty ? `<div class="empty"><h3>Nothing here yet</h3><p>Bring in a building from one of your Excel workbooks, or add one by hand.</p><div class="actions"><a class="btn" href="/import">Import a workbook</a><a class="btn secondary" href="/units/new-building">Add a building</a></div></div>` : `
    <div class="figures">
      <div class="figure"><div class="n green">${money0(month.collected)}</div><div class="l">collected of <b>${money0(month.expected)}</b> due this month</div><div class="bar" style="margin-top:10px"><i style="width:${pct}%"></i></div></div>
      <div class="figure"><div class="n ${owedTotal > 0 ? 'red' : 'green'}">${money0(owedTotal)}</div><div class="l">owed across <b>${owedRows.length}</b> ${owedRows.length === 1 ? 'tenant' : 'tenants'}</div></div>
      <div class="figure"><div class="n">${rows.length}<span class="muted" style="font-size:18px"> / ${units}</span></div><div class="l">units occupied, <b>${d.vacantCount}</b> vacant</div></div>
      <div class="figure"><div class="n ${leases.length ? 'amber' : ''}">${leases.length}</div><div class="l">${leases.length === 1 ? 'lease ends' : 'leases end'} within 90 days</div></div>
    </div>
    <div class="two-col">
      <section>
        <div class="section-head"><h2>Still owing</h2><a href="/delinquency">Full report</a></div>
        ${owedRows.length ? `<table class="ledger"><thead><tr><th>Tenant</th><th class="hide-m">Since</th><th class="num">Owes</th></tr></thead><tbody>
          ${owedRows.slice(0, 8).map(r => `<tr class="clickable"><td><a class="row-link" href="/units/${r.unit_id}">${esc(r.tenant_name)}</a><span class="sub">${esc(r.building_name)}, ${esc(unitName(r))}</span></td><td class="hide-m">${r.aging.oldest ? dateShort(r.aging.oldest) + ` <span class="muted">(${r.aging.daysLate}d)</span>` : ''}</td><td class="num owed">${money(r.balance)}</td></tr>`).join('')}
          </tbody>${owedRows.length > 8 ? `<tfoot><tr><td colspan="2">and ${owedRows.length - 8} more</td><td class="num">${money(owedTotal)}</td></tr></tfoot>` : ''}</table>` : `<p class="muted">Everyone is paid up.</p>`}
      </section>
      <section>
        <div class="section-head"><h2>Coming up</h2><a href="/leases">All leases</a></div>
        ${leases.length || work.length ? `<ul class="timeline">
          ${leases.slice(0, 6).map(l => `<li><span class="when">${dateShort(l.lease_end)}</span><span>Lease ends: <a href="/units/${l.unit_id}">${esc(l.tenant_name)}</a> <span class="muted">${esc(l.building_name)} ${esc(unitName(l))}</span></span><span class="${l.days < 0 ? 'owed' : 'muted'}" style="${l.days < 0 ? 'color:var(--red)' : ''}">${l.days < 0 ? 'ended' : l.days + 'd'}</span></li>`).join('')}
          ${work.slice(0, 5).map(w => `<li><span class="when">${dateShort(w.opened_at)}</span><span>Open: <a href="/work">${esc(w.title)}</a> <span class="muted">${esc(w.building_name)}${w.unit_label ? ' ' + esc(w.unit_label) : ''}</span></span><span class="muted"></span></li>`).join('')}
        </ul>` : `<p class="muted">No leases ending in the next 90 days and no open work orders.</p>`}
      </section>
    </div>
    <section class="section">
      <div class="section-head"><h2>Buildings this month</h2><a href="/units">Unit board</a></div>
      <div class="table-wrap"><table class="ledger"><thead><tr><th>Building</th><th class="num">Units</th><th class="num hide-m">Due</th><th class="num">Collected</th><th class="num">Owed</th></tr></thead><tbody>
        ${buildings.map(b => `<tr class="clickable"><td><a class="row-link" href="/units#b${b.id}">${esc(b.name)}</a>${b.demo ? ' <span class="chip demo">demo</span>' : ''}</td><td class="num">${b.occupied}/${b.units}</td><td class="num hide-m">${money(b.due)}</td><td class="num">${money(b.collected)}</td><td class="num ${b.owed > 0 ? 'owed' : ''}">${b.owed > 0 ? money(b.owed) : '—'}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`}` });
}

// ---------------------------------------------------------------- delinquency
function delinquency(ctx, rows, opts) {
  const owed = rows.filter(r => r.balance > 0).sort((a, b) => b.aging.daysLate - a.aging.daysLate || b.balance - a.balance);
  const total = owed.reduce((s, r) => s + r.balance, 0);
  const ag = owed.reduce((a, r) => ({ current: a.current + r.aging.current, d30: a.d30 + r.aging.d30, d60: a.d60 + r.aging.d60, d90: a.d90 + r.aging.d90 }), { current: 0, d30: 0, d60: 0, d90: 0 });
  const grace = Number(opts.graceDays) || 0;
  const bOpts = `<option value="">All buildings</option>` + opts.buildings.map(b => `<option value="${b.id}" ${opts.buildingId === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  return layout(ctx, { title: 'Who owes', active: 'owed', body: `
    <div class="page-head">
      <div><h1>Who owes</h1><p class="lede">Every tenant with a balance, oldest first. As of ${dateLong(L.todayISO())}.</p></div>
      <div class="actions"><button class="btn secondary" onclick="window.print()">Print</button><a class="btn secondary" href="/export#delinquency">Excel</a></div>
    </div>
    <div class="hero-owed">
      <div class="total"><div class="n ${total ? '' : 'zero'}">${money0(total)}</div><div class="l">${owed.length ? `owed by ${owed.length} ${owed.length === 1 ? 'tenant' : 'tenants'}` : 'Nobody owes anything.'}</div></div>
      <div class="aging">
        <div><div class="n">${money0(ag.current)}</div><div class="l">0–30 days</div></div>
        <div><div class="n ${ag.d30 ? 'hot' : ''}">${money0(ag.d30)}</div><div class="l">31–60 days</div></div>
        <div><div class="n ${ag.d60 ? 'hot' : ''}">${money0(ag.d60)}</div><div class="l">61–90 days</div></div>
        <div><div class="n ${ag.d90 ? 'hot' : ''}">${money0(ag.d90)}</div><div class="l">over 90 days</div></div>
      </div>
    </div>
    <form class="filters" method="get" action="/delinquency"><div class="field"><label for="b">Building</label><select id="b" name="building" onchange="this.form.submit()">${bOpts}</select></div></form>
    ${owed.length ? `<div class="table-wrap"><table class="ledger">
      <thead><tr><th>Tenant</th><th class="hide-m">Building</th><th>Unpaid since</th><th class="num hide-m">Rent</th><th class="num hide-m">Last payment</th><th class="num">Owes</th><th class="no-print"></th></tr></thead>
      <tbody>${owed.map(r => {
        const lateEligible = r.aging.daysLate > grace;
        const fee = L.lateFeeFor(r.rent);
        return `<tr class="clickable">
          <td><a class="row-link" href="/units/${r.unit_id}">${esc(r.tenant_name)}</a>${r.phone ? `<span class="sub">${esc(r.phone)}</span>` : ''}</td>
          <td class="hide-m">${esc(r.building_name)}<span class="sub">${esc(unitName(r))}</span></td>
          <td>${r.aging.oldest ? `${dateShort(r.aging.oldest)}<span class="sub">${r.aging.daysLate} days</span>` : '—'}</td>
          <td class="num hide-m">${money(r.rent)}</td>
          <td class="num hide-m">${r.lastPayment ? `${money(r.lastPayment.amount)}<span class="sub">${dateShort(r.lastPayment.date)}, ${esc(r.lastPayment.method)}</span>` : '<span class="muted">never</span>'}</td>
          <td class="num owed">${money(r.balance)}</td>
          <td class="rowactions no-print"><a href="/units/${r.unit_id}#pay">Record payment</a>${lateEligible && fee > 0 ? `<a href="/units/${r.unit_id}#charge" title="Add a ${money(fee)} late fee">Late fee</a>` : ''}</td>
        </tr>`; }).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total owed</td><td class="num owed">${money(total)}</td><td class="no-print"></td></tr></tfoot>
    </table></div>
    <p class="help" style="margin-top:12px">Late fee rule: ${grace} days grace, then ${opts.lateFeeKind === 'percent' ? opts.lateFeeAmount + '% of rent' : money(opts.lateFeeAmount)}. Fees are never added automatically; use the link on a row. <a href="/settings">Change</a></p>` :
    `<div class="empty"><h3>Nothing owed</h3><p>Every active tenant is paid through today. This page fills in on its own as rent comes due on the ${Number(opts.rentDueDay) === 1 ? '1st' : opts.rentDueDay + 'th'}.</p></div>`}` });
}

// ---------------------------------------------------------------- unit board
function unitBoardPage(ctx, buildings) {
  const cur = L.currentPeriod();
  const body = `
    <div class="page-head">
      <div><h1>Units</h1><p class="lede">${esc(L.periodLabel(cur))}. Tap a unit to see its ledger or record a payment.</p></div>
      <div class="actions"><a class="btn secondary" href="/units/new-building">Add a building</a></div>
    </div>
    ${buildings.length ? buildings.map(b => {
      const occ = b.units.filter(u => !u.vacant).length;
      const owed = b.units.reduce((s, u) => s + (u.balance > 0 ? u.balance : 0), 0);
      return `<section class="building" id="b${b.id}">
        <div class="building-head"><h2><a href="/buildings/${b.id}">${esc(b.name)}</a>${b.demo ? ' <span class="chip demo">demo</span>' : ''}</h2><div class="meta">${occ} of ${b.units.length} occupied${owed ? ` · <span style="color:var(--red)">${money(owed)} owed</span>` : ' · paid up'} · <a href="/buildings/${b.id}">Edit building</a></div></div>
        ${b.units.length ? `<div class="board">${b.units.map(u => `
          <a class="tile ${u.status}" href="/units/${u.unit_id}">
            <div class="unit">${esc(u.unit_label)}${u.unit_kind !== 'apartment' ? `<small>${esc(u.unit_kind)}</small>` : ''}</div>
            <div class="who">${u.vacant ? '<span class="muted">Vacant</span>' : esc(u.tenant_name)}</div>
            <div class="foot"><span class="status ${u.status}">${statusWord(u.status)}</span><span class="amt">${u.vacant ? '' : u.balance > 0 ? money(u.balance) : u.credit > 0 ? '+' + money(u.credit) + ' credit' : `<span class="muted" style="font-weight:400">${money0(u.rent)}/mo</span>`}</span></div>
          </a>`).join('')}</div>` : `<p class="muted">No units yet. <a href="/buildings/${b.id}">Add units</a></p>`}
      </section>`; }).join('') :
    `<div class="empty"><h3>No buildings yet</h3><p>Import one of your workbooks and the units come with it, or add a building by hand.</p><div class="actions"><a class="btn" href="/import">Import a workbook</a><a class="btn secondary" href="/units/new-building">Add a building</a></div></div>`}`;
  return layout(ctx, { title: 'Units', active: 'units', body });
}

// ---------------------------------------------------------------- building edit
function buildingPage(ctx, b, units, isNew) {
  const body = `
    <div class="page-head"><div><h1>${isNew ? 'Add a building' : esc(b.name)}</h1>${isNew ? '' : `<p class="lede">${esc(b.address || 'No address yet')}</p>`}</div>${isNew ? '' : `<div class="actions"><a class="btn secondary" href="/units#b${b.id}">Unit board</a></div>`}</div>
    <div class="two-col">
      <form class="form" method="post" action="${isNew ? '/buildings/new' : `/buildings/${b.id}`}">${csrfField(ctx)}
        <div class="field"><label for="name">Name</label><input id="name" type="text" name="name" value="${esc(b.name || '')}" required placeholder="e.g. 1657 W Hollywood"></div>
        <div class="field"><label for="address">Address</label><input id="address" type="text" name="address" value="${esc(b.address || '')}"></div>
        <div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes">${esc(b.notes || '')}</textarea></div>
        <div class="actions"><button class="btn" type="submit">${isNew ? 'Add building' : 'Save changes'}</button>${isNew ? '' : `<a class="btn danger" href="/buildings/${b.id}/delete">Delete building</a>`}</div>
      </form>
      ${isNew ? '' : `<section>
        <h3 style="margin-bottom:10px">Units</h3>
        ${units.length ? `<table class="ledger"><thead><tr><th>Label</th><th>Type</th><th>Occupant</th><th></th></tr></thead><tbody>
          ${units.map(u => `<tr><td><a class="row-link" href="/units/${u.id}">${esc(u.label)}</a></td><td>${esc(u.kind)}</td><td>${u.tenant_name ? esc(u.tenant_name) : '<span class="muted">Vacant</span>'}</td><td class="rowactions"><a href="/units/${u.id}/edit">Edit</a></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No units yet.</p>'}
        <form method="post" action="/buildings/${b.id}/units" style="margin-top:14px">${csrfField(ctx)}
          <div class="fields"><div class="field"><label for="ul">New unit label</label><input id="ul" type="text" name="label" placeholder="e.g. 2B or Garage" required></div>
          <div class="field"><label for="uk">Type</label><select id="uk" name="kind">${UNIT_KINDS.map(k => `<option value="${k}">${k}</option>`).join('')}</select></div></div>
          <button class="btn secondary" type="submit">Add unit</button>
        </form>
      </section>`}
    </div>`;
  return layout(ctx, { title: isNew ? 'Add a building' : b.name, active: 'units', body });
}

function confirmDelete(ctx, { title, text, action, back }) {
  return layout(ctx, { title, active: 'units', body: `
    <h1>${esc(title)}</h1><p class="lede" style="margin:8px 0 20px">${esc(text)}</p>
    <form method="post" action="${action}">${csrfField(ctx)}<div class="actions"><button class="btn danger" type="submit">Yes, delete</button><a class="btn secondary" href="${back}">Keep it</a></div></form>` });
}

// ---------------------------------------------------------------- unit page (ledger + record payment)
function unitPage(ctx, d) {
  const { unit, building, tenancy, bal, past } = d;
  const title = `${unit.kind === 'apartment' ? 'Unit ' : ''}${unit.label}`;
  const today = L.todayISO();
  const rowsAll = tenancy ? [
    ...bal.charges.map(c => ({ date: c.date, id: c.id, kind: 'charge', what: c.kind === 'rent' ? `Rent, ${L.periodLabel(c.period)}` : c.kind === 'late_fee' ? `Late fee${c.memo ? ', ' + c.memo : ''}` : (c.memo || 'Charge'), amount: c.amount })),
    ...bal.payments.map(p => ({ date: p.date, id: p.id, kind: 'payment', what: `Payment${p.method ? ', ' + p.method : ''}${p.reference ? ' #' + p.reference : ''}`, memo: p.memo, amount: -p.amount })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? a.id - b.id : a.kind === 'charge' ? -1 : 1)) : [];
  let run = 0;
  const ledgerRows = rowsAll.map(r => { run = L.round2(run + r.amount); return { ...r, run }; }).reverse();
  const status = !tenancy ? 'vacant' : bal.balance <= 0 ? 'paid' : 'owed';
  const fee = tenancy ? L.lateFeeFor(tenancy.rent) : 0;

  const body = `
    <div class="page-head">
      <div><h1>${esc(title)}<span class="muted" style="font-size:20px"> at ${esc(building.name)}</span></h1>
        <p class="lede">${tenancy ? `${esc(tenancy.tenant_name)}${tenancy.phone ? ' · ' + esc(tenancy.phone) : ''}${tenancy.email ? ' · ' + esc(tenancy.email) : ''}` : 'Vacant'}</p></div>
      <div class="actions"><a class="btn secondary" href="/units/${unit.id}/edit">Edit unit</a>${tenancy ? `<a class="btn secondary" href="/tenancies/${tenancy.id}/edit">Edit tenant</a>` : `<a class="btn" href="/units/${unit.id}/move-in">Move someone in</a>`}</div>
    </div>
    ${tenancy ? `
    <div class="figures">
      <div class="figure"><div class="n ${bal.balance > 0 ? 'red' : 'green'}">${bal.balance > 0 ? money(bal.balance) : bal.credit > 0 ? '+' + money(bal.credit) : '$0.00'}</div><div class="l">${bal.balance > 0 ? `owed, unpaid since <b>${dateShort(bal.aging.oldest)}</b> (${bal.aging.daysLate} days)` : bal.credit > 0 ? 'credit on account' : 'paid up'}</div></div>
      <div class="figure"><div class="n">${money(tenancy.rent)}</div><div class="l">monthly rent${tenancy.deposit ? `, <b>${money(tenancy.deposit)}</b> deposit held` : ''}</div></div>
      <div class="figure"><div class="n" style="font-size:22px;padding-top:6px">${tenancy.lease_end ? dateLong(tenancy.lease_end) : '<span class="muted">not set</span>'}</div><div class="l">lease ends${tenancy.lease_end ? ` (${L.daysBetween(today, tenancy.lease_end)} days)` : ''}${tenancy.lease_text && !tenancy.lease_end ? ` · "${esc(tenancy.lease_text)}"` : ''}</div></div>
      <div class="figure"><div class="n" style="font-size:22px;padding-top:6px">${bal.lastPayment ? money(bal.lastPayment.amount) : '<span class="muted">none</span>'}</div><div class="l">${bal.lastPayment ? `last payment, <b>${dateShort(bal.lastPayment.date)}</b> by ${esc(bal.lastPayment.method)}` : 'no payments recorded yet'}</div></div>
    </div>
    <div class="two-col">
      <section id="pay">
        <h2 style="margin-bottom:12px">Record a payment</h2>
        <form method="post" action="/tenancies/${tenancy.id}/payments">${csrfField(ctx)}
          <div class="fields">
            <div class="field"><label for="amt">Amount</label><div class="money-input"><input id="amt" type="number" step="0.01" min="0.01" name="amount" value="${bal.balance > 0 ? bal.balance.toFixed(2) : tenancy.rent.toFixed(2)}" required inputmode="decimal"></div></div>
            <div class="field"><label for="dt">Date</label><input id="dt" type="date" name="date" value="${today}" required></div>
            <div class="field"><label for="method">How</label><select id="method" name="method">${PAYMENT_METHODS.map(m => `<option value="${m}" ${m === (bal.lastPayment && bal.lastPayment.method) ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
            <div class="field"><label for="ref">Check or reference #</label><input id="ref" type="text" name="reference" placeholder="optional"></div>
            <div class="field wide"><label for="memo">Note</label><input id="memo" type="text" name="memo" placeholder="optional"></div>
          </div>
          <button class="btn" type="submit">Record payment</button>
        </form>
        <details id="charge" style="margin-top:22px"><summary style="cursor:pointer;color:var(--sky)">Add a charge (late fee, damage, other)</summary>
          <form method="post" action="/tenancies/${tenancy.id}/charges" style="margin-top:12px">${csrfField(ctx)}
            <div class="fields">
              <div class="field"><label for="ck">Kind</label><select id="ck" name="kind"><option value="late_fee">Late fee</option><option value="other">Other charge</option></select></div>
              <div class="field"><label for="ca">Amount</label><div class="money-input"><input id="ca" type="number" step="0.01" min="0.01" name="amount" value="${fee ? fee.toFixed(2) : ''}" required></div></div>
              <div class="field"><label for="cd">Date</label><input id="cd" type="date" name="date" value="${today}" required></div>
              <div class="field"><label for="cm">Note</label><input id="cm" type="text" name="memo" placeholder="e.g. September rent late"></div>
            </div>
            <button class="btn secondary" type="submit">Add charge</button>
          </form>
        </details>
      </section>
      <section>
        <div class="section-head"><h2>Ledger</h2><span class="muted small">${bal.charges.length} charges, ${bal.payments.length} payments</span></div>
        ${ledgerRows.length ? `<div class="table-wrap"><table class="ledger"><thead><tr><th>Date</th><th>Entry</th><th class="num">Amount</th><th class="num">Balance</th><th class="no-print"></th></tr></thead><tbody>
          ${ledgerRows.map(r => `<tr><td>${dateShort(r.date)}<span class="sub">${r.date.slice(0, 4)}</span></td><td>${esc(r.what)}${r.memo ? `<span class="sub">${esc(r.memo)}</span>` : ''}</td><td class="num ${r.kind === 'payment' ? 'credit' : ''}">${r.kind === 'payment' ? '−' + money(-r.amount) : money(r.amount)}</td><td class="num ${r.run > 0 ? 'owed' : ''}">${money(r.run)}</td><td class="rowactions no-print"><a href="/${r.kind === 'payment' ? 'payments' : 'charges'}/${r.id}/delete" title="Remove this entry">Remove</a></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No entries yet. Rent posts on its own on the due day each month.</p>'}
      </section>
    </div>
    <section class="section">
      <div class="section-head"><h3>Tenant</h3><a href="/tenancies/${tenancy.id}/move-out" style="color:var(--red)">Move out</a></div>
      <dl class="kv">
        <dt>Lease</dt><dd>${tenancy.lease_start ? dateLong(tenancy.lease_start) : '?'} to ${tenancy.lease_end ? dateLong(tenancy.lease_end) : '?'}${tenancy.lease_text && !(tenancy.lease_start && tenancy.lease_end) ? ` <span class="muted">(written as "${esc(tenancy.lease_text)}")</span>` : ''}</dd>
        <dt>Rent charged since</dt><dd>${L.periodLabel(tenancy.charges_from)}</dd>
        ${tenancy.notes ? `<dt>Notes</dt><dd>${esc(tenancy.notes)}</dd>` : ''}
      </dl>
    </section>` : `<div class="empty"><h3>This unit is vacant</h3><p>When someone signs a lease, move them in and rent starts posting to their ledger automatically.</p><a class="btn" href="/units/${unit.id}/move-in">Move someone in</a></div>`}
    ${past.length ? `<section class="section"><h3 style="margin-bottom:10px">Past tenants</h3><table class="ledger"><thead><tr><th>Name</th><th>Moved out</th><th class="num">Left owing</th></tr></thead><tbody>
      ${past.map(p => `<tr><td>${esc(p.tenant_name)}</td><td>${p.move_out ? dateLong(p.move_out) : ''}</td><td class="num ${p.balance > 0 ? 'owed' : ''}">${money(p.balance)}</td></tr>`).join('')}</tbody></table></section>` : ''}`;
  return layout(ctx, { title: `${title} · ${building.name}`, active: 'units', body });
}

function unitEdit(ctx, unit, building) {
  return layout(ctx, { title: 'Edit unit', active: 'units', body: `
    <h1>Edit ${esc(unit.kind === 'apartment' ? 'unit ' : '')}${esc(unit.label)}</h1><p class="lede" style="margin:6px 0 20px">${esc(building.name)}</p>
    <form class="form" method="post" action="/units/${unit.id}/edit">${csrfField(ctx)}
      <div class="fields"><div class="field"><label for="label">Label</label><input id="label" type="text" name="label" value="${esc(unit.label)}" required></div>
      <div class="field"><label for="kind">Type</label><select id="kind" name="kind">${UNIT_KINDS.map(k => `<option value="${k}" ${k === unit.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></div></div>
      <div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes">${esc(unit.notes)}</textarea></div>
      <div class="actions"><button class="btn" type="submit">Save changes</button><a class="btn secondary" href="/units/${unit.id}">Cancel</a><a class="btn danger" href="/units/${unit.id}/delete">Delete unit</a></div>
    </form>` });
}

// tenancy form: used for move-in (new) and edit
function tenancyForm(ctx, { unit, building, tenancy, isNew }) {
  const t = tenancy || { tenant_name: '', phone: '', email: '', rent: '', deposit: '', lease_start: L.todayISO(), lease_end: '', lease_text: '', notes: '', charges_from: L.currentPeriod() };
  return layout(ctx, { title: isNew ? 'Move in' : 'Edit tenant', active: 'units', body: `
    <h1>${isNew ? 'Move someone in' : 'Edit tenant'}</h1><p class="lede" style="margin:6px 0 20px">${esc(unit.kind === 'apartment' ? 'Unit ' : '')}${esc(unit.label)} at ${esc(building.name)}</p>
    <form class="form" method="post" action="${isNew ? `/units/${unit.id}/move-in` : `/tenancies/${tenancy.id}/edit`}">${csrfField(ctx)}
      <div class="fields">
        <div class="field wide"><label for="n">Tenant name(s)</label><input id="n" type="text" name="tenant_name" value="${esc(t.tenant_name)}" required></div>
        <div class="field"><label for="ph">Phone</label><input id="ph" type="tel" name="phone" value="${esc(t.phone)}"></div>
        <div class="field"><label for="em">Email</label><input id="em" type="email" name="email" value="${esc(t.email)}"></div>
        <div class="field"><label for="r">Monthly rent</label><div class="money-input"><input id="r" type="number" step="0.01" min="0" name="rent" value="${t.rent === '' ? '' : Number(t.rent).toFixed(2)}" required></div></div>
        <div class="field"><label for="d">Deposit held</label><div class="money-input"><input id="d" type="number" step="0.01" min="0" name="deposit" value="${t.deposit === '' ? '' : Number(t.deposit).toFixed(2)}"></div></div>
        <div class="field"><label for="ls">Lease starts</label><input id="ls" type="date" name="lease_start" value="${esc(t.lease_start || '')}"></div>
        <div class="field"><label for="le">Lease ends</label><input id="le" type="date" name="lease_end" value="${esc(t.lease_end || '')}"></div>
        <div class="field"><label for="cf">Charge rent starting (YYYY-MM)</label><input id="cf" type="month" name="charges_from" value="${esc(t.charges_from)}" required><div class="help">First month rent is due. Months from here to today post to the ledger right away.</div></div>
        <div class="field wide"><label for="notes">Notes</label><textarea id="notes" name="notes">${esc(t.notes)}</textarea></div>
      </div>
      <div class="actions"><button class="btn" type="submit">${isNew ? 'Move in' : 'Save changes'}</button><a class="btn secondary" href="/units/${unit.id}">Cancel</a></div>
    </form>` });
}

function moveOutPage(ctx, tenancy, unit, bal) {
  return layout(ctx, { title: 'Move out', active: 'units', body: `
    <h1>Move out ${esc(tenancy.tenant_name)}</h1>
    <p class="lede" style="margin:6px 0 20px">Ends this tenancy and marks the unit vacant. The ledger is kept. ${bal.balance > 0 ? `They currently owe <b style="color:var(--red)">${money(bal.balance)}</b>; that balance stays on record.` : ''}</p>
    <form class="form" method="post" action="/tenancies/${tenancy.id}/move-out">${csrfField(ctx)}
      <div class="field"><label for="mo">Move-out date</label><input id="mo" type="date" name="move_out" value="${L.todayISO()}" required></div>
      <div class="actions"><button class="btn danger" type="submit">Move out</button><a class="btn secondary" href="/units/${unit.id}">Cancel</a></div>
    </form>` });
}

module.exports = { layout, gate, morePage, csrfField, setupPage, loginPage, dashboard, delinquency, unitBoardPage, buildingPage, confirmDelete, unitPage, unitEdit, tenancyForm, moveOutPage, statusWord, unitName };
