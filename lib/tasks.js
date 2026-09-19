'use strict';
// What gets sent, and when. runDue() is safe to call as often as you like: every message carries a
// dedupe key, so nothing goes out twice. A timer calls it every fifteen minutes while the app runs.

const { db, now, getSetting } = require('./db');
const L = require('./ledger');
const pay = require('./pay');
const notify = require('./notify');
const { money, money0, dateLong, bname } = require('./util');

function localParts(d = new Date()) {
  // The server runs in the owner's time zone (TZ is set on Render), so local time is her time.
  return { iso: L.todayISO(d), hour: d.getHours(), dow: d.getDay() };
}
function on(key, dflt = '1') { return getSetting(key, dflt) === '1'; }
function baseUrlSetting() { return (getSetting('app_url', '') || '').replace(/\/+$/, ''); }
function linkFor(tenancyId) {
  const base = baseUrlSetting();
  if (!base) return null;
  return `${base}/pay/${pay.tokenFor(tenancyId)}`;
}

// Tenants who should hear from us, with their balance and how to reach them.
function tenantRows() {
  return L.portfolioRows().map(r => ({ ...r, notify: r.notify || 'both' }));
}
function channelsFor(r) {
  const pref = r.notify || 'both';
  if (pref === 'off') return [];
  const out = [];
  const wantEmail = pref === 'both' || pref === 'email';
  const wantSms = pref === 'both' || pref === 'sms';
  if (wantEmail && notify.emailOk(r.email) && notify.emailReady() && on('notify_email')) out.push('email');
  if (wantSms && notify.phoneOk(r.phone) && notify.smsReady() && on('notify_sms')) out.push('sms');
  return out;
}

function firstName(n) { return String(n || '').trim().split(/[\s,&]+/)[0] || 'there'; }

// ---- message bodies ------------------------------------------------------------------------
function dueMessage(r, link) {
  const what = `${r.unit_kind === 'apartment' ? 'Unit ' : ''}${r.unit_label} at ${r.building_name}`;
  const owed = r.balance > 0 ? r.balance : r.rent;
  const text = `Hi ${firstName(r.tenant_name)}, rent for ${what} is due today: ${money(owed)}.` +
    (link ? ` You can see your balance and pay here: ${link}` : '') +
    (getSetting('sign_off', '') ? `\n\n${getSetting('sign_off', '')}` : '');
  return { subject: `Rent due today — ${what}`, text };
}
function lateMessage(r, link) {
  const what = `${r.unit_kind === 'apartment' ? 'Unit ' : ''}${r.unit_label} at ${r.building_name}`;
  const fee = L.lateFeeFor(r.rent);
  const text = `Hi ${firstName(r.tenant_name)}, we haven't received rent for ${what}. The balance is ${money(r.balance)}, ${r.aging.daysLate} days past due.` +
    (fee > 0 ? ` A late fee of ${money(fee)} may apply.` : '') +
    (link ? ` You can pay here: ${link}` : '') +
    ` If you've already paid or need to talk about it, please reply.` +
    (getSetting('sign_off', '') ? `\n\n${getSetting('sign_off', '')}` : '');
  return { subject: `Rent past due — ${what}`, text };
}
function digest(rows) {
  const owed = rows.filter(r => r.balance > 0).sort((a, b) => b.balance - a.balance);
  const total = owed.reduce((s, r) => s + r.balance, 0);
  const weekAgo = L.todayISO(new Date(Date.now() - 7 * 86400000));
  const collected = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE date >= ?`).get(weekAgo).v;
  const today = L.todayISO();
  const leases = rows.filter(r => r.lease_end).map(r => ({ ...r, days: L.daysBetween(today, r.lease_end) })).filter(r => r.days >= 0 && r.days <= 60).sort((a, b) => a.days - b.days);
  const open = db.prepare(`SELECT w.*, u.label AS unit_label FROM work_orders w LEFT JOIN units u ON u.id = w.unit_id WHERE w.status = 'open' ORDER BY CASE w.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, w.opened_at`).all();
  const lines = [];
  lines.push(`Collected in the last 7 days: ${money(collected)}`);
  lines.push(`Owed right now: ${money(total)} across ${owed.length} ${owed.length === 1 ? 'tenant' : 'tenants'}`);
  if (owed.length) {
    lines.push('');
    for (const r of owed.slice(0, 12)) lines.push(`  ${money(r.balance)}  ${r.tenant_name} — ${r.unit_label}, ${r.building_name} (${r.aging.daysLate}d)`);
    if (owed.length > 12) lines.push(`  and ${owed.length - 12} more`);
  }
  if (open.length) {
    lines.push('', `Open repairs: ${open.length}`);
    for (const w of open.slice(0, 6)) lines.push(`  ${w.urgency === 'emergency' ? '[EMERGENCY] ' : w.urgency === 'urgent' ? '[soon] ' : ''}${w.title}${w.unit_label ? ` — ${w.unit_label}` : ''}`);
  }
  if (leases.length) {
    lines.push('', `Leases ending within 60 days: ${leases.length}`);
    for (const l of leases.slice(0, 6)) lines.push(`  ${dateLong(l.lease_end)}  ${l.tenant_name} — ${l.unit_label}, ${l.building_name}`);
  }
  const base = baseUrlSetting();
  if (base) lines.push('', `${base}/delinquency`);
  return { subject: `Rollbook: ${money0(total)} owed, ${money0(collected)} collected this week`, text: lines.join('\n') };
}

// ---- the run ----------------------------------------------------------------------------------
// dryRun returns what would be sent without sending it, for the preview button.
async function runDue({ at = new Date(), dryRun = false, force = null } = {}) {
  const { iso, hour, dow } = localParts(at);
  const sendHour = Math.min(23, Math.max(0, Number(getSetting('notify_hour', '9')) || 9));
  const planned = [];

  if (force === 'due' || (on('notify_due') && hour >= sendHour && Number(getSetting('rent_due_day', '1')) === Number(iso.slice(8, 10)))) {
    for (const r of tenantRows()) {
      if (r.balance <= 0) continue;
      const link = linkFor(r.tenancy_id);
      const msg = dueMessage(r, link);
      for (const ch of channelsFor(r)) planned.push({ kind: 'rent_due', dedupeKey: `due:${r.tenancy_id}:${iso.slice(0, 7)}:${ch}`, channel: ch, to: ch === 'sms' ? r.phone : r.email, tenancyId: r.tenancy_id, ...msg });
    }
  }

  if (force === 'late' || (on('notify_late') && hour >= sendHour)) {
    const grace = Number(getSetting('grace_days', '5')) || 0;
    for (const r of tenantRows()) {
      if (r.balance <= 0 || r.aging.daysLate <= grace) continue;
      const link = linkFor(r.tenancy_id);
      const msg = lateMessage(r, link);
      // At most one past-due notice per tenant per month.
      for (const ch of channelsFor(r)) planned.push({ kind: 'rent_late', dedupeKey: `late:${r.tenancy_id}:${iso.slice(0, 7)}:${ch}`, channel: ch, to: ch === 'sms' ? r.phone : r.email, tenancyId: r.tenancy_id, ...msg });
    }
  }

  if (force === 'digest' || (on('notify_digest') && hour >= sendHour && dow === 1)) {
    const to = getSetting('owner_email', '');
    if (notify.emailOk(to) && notify.emailReady()) {
      const msg = digest(tenantRows());
      planned.push({ kind: 'digest', dedupeKey: `digest:${iso}`, channel: 'email', to, ...msg });
    }
  }

  if (dryRun) return { planned, sent: 0, failed: 0, skipped: 0 };
  let sent = 0, failed = 0, skipped = 0;
  for (const m of planned) {
    const out = await notify.deliver(m);
    if (out.sent) sent++; else if (out.skipped) skipped++; else failed++;
  }
  return { planned, sent, failed, skipped };
}

// Tell the owner as soon as a tenant reports something urgent.
async function alertOwner(workOrder, tenancy, buildingName) {
  if (!on('notify_reports')) return { skipped: 'off' };
  const urgent = workOrder.urgency === 'emergency' || workOrder.urgency === 'urgent';
  if (workOrder.urgency === 'normal' && getSetting('notify_reports_when', 'urgent') === 'urgent') return { skipped: 'not urgent' };
  const where = `${tenancy.unit_kind === 'apartment' ? 'Unit ' : ''}${tenancy.unit_label}, ${buildingName}`;
  const head = workOrder.urgency === 'emergency' ? 'EMERGENCY' : workOrder.urgency === 'urgent' ? 'Soon' : 'New';
  const base = baseUrlSetting();
  const text = `${head}: ${tenancy.tenant_name} at ${where} reported "${workOrder.title}".` +
    (workOrder.notes ? `\n\n${workOrder.notes}` : '') +
    (tenancy.phone ? `\n\nTheir number: ${tenancy.phone}` : '') +
    (base ? `\n\n${base}/work` : '');
  const out = [];
  const email = getSetting('owner_email', '');
  if (notify.emailOk(email) && notify.emailReady()) out.push(await notify.deliver({ kind: 'report_alert', dedupeKey: `report:${workOrder.id}:email`, channel: 'email', to: email, subject: `${head} repair — ${where}`, text }));
  const phone = getSetting('owner_phone', '');
  if (urgent && notify.phoneOk(phone) && notify.smsReady()) out.push(await notify.deliver({ kind: 'report_alert', dedupeKey: `report:${workOrder.id}:sms`, channel: 'sms', to: phone, text: text.split('\n\n').slice(0, 2).join(' ') }));
  return { results: out };
}

let timer = null;
function start() {
  if (timer || process.env.ROLLBOOK_NO_SCHEDULER === '1') return;
  const tick = () => runDue().then(r => { if (r.sent || r.failed) console.log(`reminders: ${r.sent} sent, ${r.failed} failed`); }).catch(e => console.error('reminder run failed:', e.message));
  timer = setInterval(tick, 15 * 60 * 1000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 20000).unref && setTimeout(tick, 20000);
}

module.exports = { runDue, alertOwner, start, digest, dueMessage, lateMessage, channelsFor, linkFor };
