'use strict';
// Tenant-facing online payments via Stripe Checkout.
// The tenant never has an account: a private link opens a page showing what they owe, they choose
// bank or card, and Stripe's hosted page takes the details. Stripe tells us the result by webhook,
// and only then does a payment land on the ledger.

const crypto = require('node:crypto');
const { db, now, getSetting, transaction } = require('./db');
const L = require('./ledger');
const stripe = require('./stripe');
const { esc, money, bname, dateLong, dateShort } = require('./util');
const photos = require('./photos');

const CARD_PCT = 0.029, CARD_FIXED = 0.30;

function r2(n) { return Math.round(n * 100) / 100; }
function cents(n) { return Math.round(n * 100); }

// ---- pay links ---------------------------------------------------------------------------
function tokenFor(tenancyId) {
  const t = db.prepare('SELECT pay_token FROM tenancies WHERE id = ?').get(tenancyId);
  if (!t) return null;
  if (t.pay_token) return t.pay_token;
  const tok = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
  db.prepare('UPDATE tenancies SET pay_token = ? WHERE id = ?').run(tok, tenancyId);
  return tok;
}
function resetToken(tenancyId) {
  db.prepare("UPDATE tenancies SET pay_token = '' WHERE id = ?").run(tenancyId);
  return tokenFor(tenancyId);
}
function tenancyByToken(tok) {
  if (!/^[A-Za-z0-9]{8,20}$/.test(tok || '')) return null;
  return db.prepare(`SELECT t.*, u.label AS unit_label, u.kind AS unit_kind, b.id AS building_id, b.name AS name, b.name AS building_name, b.display_name, b.address
                     FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN buildings b ON b.id = u.building_id WHERE t.pay_token = ?`).get(tok);
}
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function payUrl(req, tok) { return `${baseUrl(req)}/pay/${tok}`; }

// The fee added to a card payment so the owner nets the full amount.
function cardSurcharge(amount) {
  if (getSetting('pay_card_fee_to_tenant', '1') !== '1') return 0;
  const total = (amount + CARD_FIXED) / (1 - CARD_PCT);
  return r2(total - amount);
}
function methods() {
  return { bank: getSetting('pay_bank', '1') === '1', card: getSetting('pay_card', '1') === '1' };
}

// ---- pending online payments for a tenancy ---------------------------------------------------
function pendingFor(tenancyId) {
  return db.prepare(`SELECT * FROM online_payments WHERE tenancy_id = ? AND status IN ('started','pending') AND created_at > ? ORDER BY created_at DESC`)
    .all(tenancyId, new Date(Date.now() - 14 * 86400000).toISOString());
}
function pendingAll() {
  const rows = db.prepare(`SELECT tenancy_id, SUM(amount) v FROM online_payments WHERE status = 'pending' GROUP BY tenancy_id`).all();
  const out = {}; for (const r of rows) out[r.tenancy_id] = r2(r.v); return out;
}

// ---- checkout ----------------------------------------------------------------------------------
async function startCheckout(req, t, amount, method) {
  const m = methods();
  if (method === 'card' && !m.card) throw new Error('Card payments are not offered.');
  if (method === 'bank' && !m.bank) throw new Error('Bank payments are not offered.');
  if (!(amount >= 1 && amount <= 50000)) throw new Error('Amount must be between $1 and $50,000.');
  const fee = method === 'card' ? cardSurcharge(amount) : 0;
  const label = `${t.unit_kind === 'apartment' ? 'Unit ' : ''}${t.unit_label}, ${bname(t)}`;
  const tok = t.pay_token;
  const line_items = [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents(amount), product_data: { name: `Rent — ${label}` } } }];
  if (fee > 0) line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: cents(fee), product_data: { name: 'Card processing fee' } } });
  const params = {
    mode: 'payment',
    payment_method_types: [method === 'card' ? 'card' : 'us_bank_account'],
    line_items,
    success_url: `${baseUrl(req)}/pay/${tok}/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl(req)}/pay/${tok}`,
    metadata: { tenancy_id: String(t.id), rent_amount: amount.toFixed(2), fee: fee.toFixed(2), rollbook: '1' },
    payment_intent_data: { description: `Rent — ${label} — ${t.tenant_name}`, metadata: { tenancy_id: String(t.id) } },
  };
  if (t.email) params.customer_email = t.email;
  if (method === 'bank') params.payment_method_options = { us_bank_account: { verification_method: 'automatic' } };
  const session = await stripe.request('POST', '/v1/checkout/sessions', params);
  db.prepare(`INSERT INTO online_payments(session_id, tenancy_id, amount, fee, method, status, detail, created_at, updated_at) VALUES (?,?,?,?,?,'started','',?,?)`)
    .run(session.id, t.id, amount, fee, method === 'card' ? 'Online (card)' : 'Online (bank)', now(), now());
  return session;
}

// ---- webhook -------------------------------------------------------------------------------------
// Returns a short string describing what happened, for the log.
function handleEvent(event) {
  if (!event || !event.id || !event.type) return 'ignored: malformed';
  const dup = db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id);
  if (dup) return 'duplicate';
  db.prepare('INSERT INTO stripe_events(id, type, received_at) VALUES (?,?,?)').run(event.id, event.type, now());
  const obj = event.data && event.data.object;
  if (!obj || obj.object !== 'checkout.session') return `ignored: ${event.type}`;
  const op = db.prepare('SELECT * FROM online_payments WHERE session_id = ?').get(obj.id);
  if (!op) return `ignored: unknown session ${obj.id}`;
  const ts = now();
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.payment_status === 'paid') return settle(op, obj, ts);
      // Bank debits complete the session first and pay days later.
      db.prepare(`UPDATE online_payments SET status = 'pending', detail = 'Bank debit started', updated_at = ? WHERE session_id = ?`).run(ts, obj.id);
      return 'pending';
    case 'checkout.session.async_payment_succeeded':
      return settle(op, obj, ts);
    case 'checkout.session.async_payment_failed':
      db.prepare(`UPDATE online_payments SET status = 'failed', detail = 'Bank debit failed', updated_at = ? WHERE session_id = ?`).run(ts, obj.id);
      return 'failed';
    case 'checkout.session.expired':
      db.prepare(`UPDATE online_payments SET status = 'expired', updated_at = ? WHERE session_id = ?`).run(ts, obj.id);
      return 'expired';
    default:
      return `ignored: ${event.type}`;
  }
}
function settle(op, obj, ts) {
  return transaction(() => {
    const exists = db.prepare('SELECT 1 FROM payments WHERE stripe_id = ?').get(op.session_id);
    if (!exists) {
      const date = L.todayISO();
      db.prepare(`INSERT INTO payments(tenancy_id, date, amount, method, reference, memo, source, created_at, stripe_id) VALUES (?,?,?,?,?,?,'online',?,?)`)
        .run(op.tenancy_id, date, op.amount, op.method, (obj.payment_intent || '').slice(-8), op.fee > 0 ? `Tenant paid ${money(op.amount + op.fee)} incl. ${money(op.fee)} card fee` : 'Paid online', ts, op.session_id);
    }
    db.prepare(`UPDATE online_payments SET status = 'paid', detail = '', updated_at = ? WHERE session_id = ?`).run(ts, op.session_id);
    return exists ? 'already recorded' : 'recorded';
  });
}

// After the tenant returns from Stripe, look the session up directly so the page is right even if the
// webhook is late or not set up yet.
async function syncSession(sessionId) {
  const op = db.prepare('SELECT * FROM online_payments WHERE session_id = ?').get(sessionId);
  if (!op) return null;
  if (op.status === 'paid') return op;
  try {
    const sess = await stripe.request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    const ts = now();
    if (sess.payment_status === 'paid') settle(op, sess, ts);
    else if (sess.status === 'complete') db.prepare(`UPDATE online_payments SET status = 'pending', detail = 'Bank debit started', updated_at = ? WHERE session_id = ?`).run(ts, sessionId);
    else if (sess.status === 'expired') db.prepare(`UPDATE online_payments SET status = 'expired', updated_at = ? WHERE session_id = ?`).run(ts, sessionId);
  } catch (e) { /* leave as is; the webhook will catch up */ }
  return db.prepare('SELECT * FROM online_payments WHERE session_id = ?').get(sessionId);
}

// ---- repair requests ------------------------------------------------------------------------
const URGENCY = { emergency: 'Emergency', urgent: 'Soon', normal: 'When you can' };

function requestsFor(tenancyId) {
  return db.prepare(`SELECT * FROM work_orders WHERE tenancy_id = ? AND source = 'tenant' ORDER BY id DESC LIMIT 10`).all(tenancyId);
}
function tooManyRequests(tenancyId) {
  const open = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE tenancy_id = ? AND source = 'tenant' AND status = 'open'`).get(tenancyId).c;
  const today = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE tenancy_id = ? AND source = 'tenant' AND substr(reported_at,1,10) = ?`).get(tenancyId, L.todayISO()).c;
  return open >= 6 || today >= 5;
}
function createRequest(t, { title, notes, urgency, photoData }) {
  const ts = now();
  const u = URGENCY[urgency] ? urgency : 'normal';
  const id = Number(db.prepare(`INSERT INTO work_orders(building_id, unit_id, title, notes, vendor, status, opened_at, closed_at, cost, created_at, urgency, source, tenancy_id, reported_at, tenant_note, seen)
                                VALUES (?,?,?,?,'','open',?,NULL,0,?,?, 'tenant', ?, ?, '', 0)`)
    .run(t.building_id, t.unit_id, title, notes, L.todayISO(), ts, u, t.id, ts).lastInsertRowid);
  const saved = photos.attach('work_order', id, photoData, 4);
  return { id, photos: saved.length };
}

// ---- tenant pages --------------------------------------------------------------------------------
function page({ title, body, portfolio }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/app.css">
<style>.paywrap{max-width:520px;margin:0 auto;padding:28px 20px 60px}.payhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:1px solid var(--rule-2);padding-bottom:12px;margin-bottom:22px}.payhead .p{font-family:var(--display);font-size:20px}.owe{font-family:var(--display);font-size:52px;line-height:1;font-variation-settings:'opsz' 72,'SOFT' 20,'wght' 500;letter-spacing:-.01em}.owe.red{color:var(--red)}.owe.green{color:var(--green)}.choice{display:block;border:1px solid var(--rule-2);border-radius:var(--radius);padding:14px 16px;margin-bottom:10px;background:var(--sheet);cursor:pointer}.choice:has(input:checked){border-color:var(--ink);background:#fff}.choice input{margin-right:10px}.choice .t{font-weight:500}.choice .s{display:block;font-size:13px;color:var(--ink-3);margin-top:2px;margin-left:24px}.payfoot{margin-top:40px;font-size:12.5px;color:var(--ink-3)}</style></head>
<body><div class="paywrap"><div class="payhead"><span class="p">${esc(portfolio)}</span></div>${body}<p class="payfoot">Payments are handled by Stripe. Your bank or card details are entered on Stripe's secure page and are never seen by your landlord.</p></div></body></html>`;
}

function payPage(t, opts) {
  const bal = L.tenancyBalance(t.id);
  const reqs = opts.requestsOn ? requestsFor(t.id) : [];
  const pending = pendingFor(t.id);
  const pendingSum = r2(pending.reduce((s, p) => s + p.amount, 0));
  const owed = r2(Math.max(0, bal.balance - pendingSum));
  const m = methods();
  const fee = cardSurcharge(owed || t.rent);
  const label = `${t.unit_kind === 'apartment' ? 'Unit ' : ''}${esc(t.unit_label)}, ${esc(bname(t))}`;
  const setup = opts.configured;
  const body = `
    <p class="muted" style="margin-bottom:4px">${esc(t.tenant_name)} · ${label}</p>
    <div class="owe ${owed > 0 ? 'red' : 'green'}">${owed > 0 ? money(owed) : '$0.00'}</div>
    <p class="muted" style="margin:8px 0 22px">${owed > 0 ? `owed as of ${esc(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))}${bal.aging.oldest ? `, oldest charge ${esc(dateLong(bal.aging.oldest))}` : ''}` : bal.credit > 0 ? `You have a credit of ${money(bal.credit)}.` : 'You are paid up. Thank you.'}${pendingSum ? ` A bank payment of ${money(pendingSum)} is on its way and will clear in a few days.` : ''}</p>
    ${opts.error ? `<div class="notice error">${esc(opts.error)}</div>` : ''}
    ${!setup ? `<div class="notice warn">Online payments are not switched on yet. Please pay your landlord the usual way.</div>` : (!m.bank && !m.card) ? `<div class="notice warn">No online payment methods are offered right now.</div>` : `
    <form method="post" action="/pay/${esc(t.pay_token)}/checkout">
      <div class="field"><label for="amt">Amount</label><div class="money-input"><input id="amt" type="number" name="amount" step="0.01" min="1" max="50000" value="${(owed > 0 ? owed : t.rent).toFixed(2)}" required inputmode="decimal"></div><div class="help">${owed > 0 ? 'Pay the full balance, or change the amount to pay part of it.' : 'Nothing is due; you can pay ahead.'}</div></div>
      ${m.bank ? `<label class="choice"><input type="radio" name="method" value="bank" checked><span class="t">Bank account</span><span class="s">No extra fee. You'll sign in to your bank on the next page. Clears in a few business days.</span></label>` : ''}
      ${m.card ? `<label class="choice"><input type="radio" name="method" value="card" ${m.bank ? '' : 'checked'}><span class="t">Debit or credit card</span><span class="s">${fee > 0 ? `A processing fee is added (about ${money(fee)} on ${money(owed || t.rent)}). ` : ''}Posts right away.</span></label>` : ''}
      <button class="btn" type="submit" style="width:100%;justify-content:center;padding:12px;font-size:15px;margin-top:8px">Continue to payment</button>
    </form>`}
    ${opts.requestsOn ? `<div class="section" id="fix">
      <h3 style="margin-bottom:8px">Something need fixing?</h3>
      ${reqs.length ? `<table class="ledger" style="margin-bottom:12px"><tbody>${reqs.map(r => `<tr><td>${esc(dateShort(r.opened_at))}<span class="sub">${esc(URGENCY[r.urgency] || '')}</span></td><td>${esc(r.title)}${r.tenant_note ? `<span class="sub">${esc(r.tenant_note)}</span>` : ''}</td><td class="num">${r.status === 'done' ? '<span class="status paid">Fixed</span>' : '<span style="color:var(--amber)">Reported</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
      <a class="btn secondary" href="/pay/${esc(t.pay_token)}/fix" style="width:100%;justify-content:center;padding:10px">Report a repair</a>
    </div>` : ''}
    ${bal.payments.length ? `<div class="section"><h3 style="margin-bottom:8px">Recent payments</h3><table class="ledger"><tbody>${bal.payments.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6).map(p => `<tr><td>${esc(dateLong(p.date))}</td><td>${esc(p.method)}</td><td class="num">${money(p.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  return page({ title: `Pay rent — ${label}`, body, portfolio: opts.portfolio });
}

function donePage(t, op, opts) {
  const label = `${t.unit_kind === 'apartment' ? 'Unit ' : ''}${esc(t.unit_label)}, ${esc(bname(t))}`;
  let headline, text;
  if (!op) { headline = 'Thank you'; text = 'Your payment has been submitted.'; }
  else if (op.status === 'paid') { headline = 'Paid'; text = `${money(op.amount)} has been received and recorded. ${op.fee ? `A ${money(op.fee)} card fee was added.` : ''}`; }
  else if (op.status === 'pending' || op.status === 'started') { headline = 'On its way'; text = `Your bank payment of ${money(op.amount)} has started. It usually clears in 3 to 5 business days and shows on your ledger when it does.`; }
  else if (op.status === 'failed') { headline = 'That did not go through'; text = 'Your bank declined the payment. Please try again or contact your landlord.'; }
  else { headline = 'Not completed'; text = 'This payment was not completed.'; }
  return page({ title: headline, portfolio: opts.portfolio, body: `<p class="muted">${esc(t.tenant_name)} · ${label}</p><h1 style="margin:6px 0 10px">${esc(headline)}</h1><p>${esc(text)}</p>${op && op.status === 'paid' && t.email ? '<p class="muted small">A receipt has been emailed to you by Stripe.</p>' : ''}<p style="margin-top:24px"><a class="btn secondary" href="/pay/${esc(t.pay_token)}">Back to your balance</a></p>` });
}

function fixPage(t, opts) {
  const label = `${t.unit_kind === 'apartment' ? 'Unit ' : ''}${esc(t.unit_label)}, ${esc(bname(t))}`;
  const body = `
    <p class="muted" style="margin-bottom:4px">${esc(t.tenant_name)} · ${label}</p>
    <h1 style="font-size:26px;margin:6px 0 16px">Report a repair</h1>
    ${opts.error ? `<div class="notice error">${esc(opts.error)}</div>` : ''}
    <form id="fixform" onsubmit="return false">
      <div class="field"><label for="what">What is wrong?</label><input id="what" type="text" maxlength="120" placeholder="e.g. Kitchen sink is leaking" required></div>
      <div class="field"><label for="notes">Anything else we should know?</label><textarea id="notes" maxlength="1200" placeholder="When it started, where exactly, whether it still works"></textarea></div>
      <div class="field"><label for="urg">How soon?</label><select id="urg">
        <option value="normal">When you can get to it</option>
        <option value="urgent">Soon, it is a problem</option>
        <option value="emergency">Emergency (flooding, no heat, no power, gas)</option>
      </select><div class="help" id="emerg" style="display:none">${opts.emergencyPhone ? `For a real emergency, call ${esc(opts.emergencyPhone)} now. Do not wait for this form.` : 'For a real emergency, call your landlord directly as well. Do not wait for this form.'}</div></div>
      <div class="field"><label for="pics">Photos (up to 4)</label><input id="pics" type="file" accept="image/*" multiple><div class="help" id="picstatus">A photo saves a phone call. They are resized on your phone before sending.</div></div>
      <button class="btn" id="send" type="button" style="width:100%;justify-content:center;padding:12px;font-size:15px">Send it</button>
      <div id="fixerr" class="notice error" style="display:none;margin-top:14px"></div>
    </form>
    <p style="margin-top:20px"><a href="/pay/${esc(t.pay_token)}">Back to your balance</a></p>
    <script>
    (function(){
      var pics=[], f=document.getElementById('pics'), st=document.getElementById('picstatus'), urg=document.getElementById('urg');
      urg.addEventListener('change',function(){document.getElementById('emerg').style.display=urg.value==='emergency'?'block':'none';});
      f.addEventListener('change',function(){
        pics=[]; var files=[].slice.call(f.files).slice(0,4); if(!files.length){st.textContent='';return;}
        st.textContent='Preparing '+files.length+' photo'+(files.length>1?'s':'')+'…'; var done=0;
        files.forEach(function(file){
          var img=new Image(), url=URL.createObjectURL(file);
          img.onload=function(){var max=1400,sc=Math.min(1,max/Math.max(img.width,img.height));var c=document.createElement('canvas');c.width=Math.round(img.width*sc);c.height=Math.round(img.height*sc);c.getContext('2d').drawImage(img,0,0,c.width,c.height);pics.push(c.toDataURL('image/jpeg',0.8));URL.revokeObjectURL(url);if(++done===files.length)st.textContent=pics.length+' photo'+(pics.length>1?'s':'')+' ready.';};
          img.onerror=function(){if(++done===files.length)st.textContent=pics.length+' photo'+(pics.length===1?'':'s')+' ready.';};
          img.src=url;
        });
      });
      document.getElementById('send').addEventListener('click',function(){
        var btn=this, err=document.getElementById('fixerr'), what=document.getElementById('what');
        err.style.display='none';
        if(!what.value.trim()){err.style.display='block';err.textContent='Tell us what is wrong first.';what.focus();return;}
        btn.disabled=true; btn.textContent='Sending…';
        fetch('/pay/${esc(t.pay_token)}/fix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:what.value,notes:document.getElementById('notes').value,urgency:urg.value,photos:pics})})
          .then(function(r){return r.json()})
          .then(function(r){ if(!r.ok){err.style.display='block';err.textContent=r.error||'Could not send that.';btn.disabled=false;btn.textContent='Send it';return;} location.href='/pay/${esc(t.pay_token)}/fix?sent=1'; })
          .catch(function(){err.style.display='block';err.textContent='Could not reach the server. Try again.';btn.disabled=false;btn.textContent='Send it';});
      });
    })();
    </script>`;
  return page({ title: 'Report a repair', body, portfolio: opts.portfolio });
}

function fixSentPage(t, opts) {
  return page({ title: 'Sent', portfolio: opts.portfolio, body: `
    <h1 style="margin:6px 0 10px">Sent</h1>
    <p>Your landlord has it, with your photos. You can check back on this page to see when it is marked fixed.</p>
    ${opts.emergencyPhone ? `<p class="muted small">If this is an emergency, call ${esc(opts.emergencyPhone)} as well.</p>` : ''}
    <p style="margin-top:24px"><a class="btn secondary" href="/pay/${esc(t.pay_token)}">Back to your balance</a></p>` });
}

module.exports = { fixPage, fixSentPage, createRequest, requestsFor, tooManyRequests, URGENCY, syncSession, tokenFor, resetToken, tenancyByToken, payUrl, baseUrl, cardSurcharge, methods, pendingFor, pendingAll, startCheckout, handleEvent, payPage, donePage };
