'use strict';
// Sending email and text messages. Both are plain HTTPS calls, so there are still no dependencies.
// Email goes through Resend, texts through Twilio. Either can be left unconfigured; nothing breaks.
// Every message is written to the messages table first with a dedupe key, so the same reminder
// can never go out twice even if the scheduler runs again.

const https = require('node:https');
const http = require('node:http');
const { db, now, getSetting } = require('./db');

const RESEND_BASE = process.env.RESEND_API_BASE || 'https://api.resend.com';
const TWILIO_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com';

function post(base, path, { body, headers, contentType }) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Rollbook/1.4', ...headers },
      timeout: 20000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try { const j = JSON.parse(data); msg = j.message || (j.error && j.error.message) || msg; } catch (e) { }
          return reject(new Error(msg));
        }
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('No answer in time.')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function emailReady() { return !!(getSetting('resend_key', '') && getSetting('from_email', '')); }
function smsReady() { return !!(getSetting('twilio_sid', '') && getSetting('twilio_token', '') && getSetting('twilio_from', '')); }

async function sendEmail(to, subject, text) {
  const key = getSetting('resend_key', ''), from = getSetting('from_email', '');
  if (!key || !from) throw new Error('Email is not set up.');
  const out = await post(RESEND_BASE, '/emails', {
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  return out.id || 'sent';
}

async function sendSms(to, text) {
  const sid = getSetting('twilio_sid', ''), tok = getSetting('twilio_token', ''), from = getSetting('twilio_from', '');
  if (!sid || !tok || !from) throw new Error('Texting is not set up.');
  const body = new URLSearchParams({ To: to, From: from, Body: text }).toString();
  const out = await post(TWILIO_BASE, `/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    contentType: 'application/x-www-form-urlencoded',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
    body,
  });
  return out.sid || 'sent';
}

function phoneOk(p) { return /^\+?[\d\s().-]{10,20}$/.test(String(p || '').trim()); }
function e164(p) {
  const d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d;
}
function emailOk(e) { return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(e || '').trim()); }

// Records the attempt and sends it. Returns { sent, skipped, error }.
// dedupeKey is what stops a message going out twice; pass null for one-offs.
async function deliver({ kind, dedupeKey, channel, to, subject, text, tenancyId = null }) {
  if (dedupeKey && db.prepare('SELECT 1 FROM messages WHERE dedupe_key = ?').get(dedupeKey)) return { skipped: 'already sent' };
  const ts = now();
  const info = db.prepare(`INSERT INTO messages(kind, dedupe_key, channel, recipient, subject, body, status, error, tenancy_id, created_at, sent_at)
                           VALUES (?,?,?,?,?,?,'sending','',?,?,NULL)`)
    .run(kind, dedupeKey || null, channel, to, subject || '', text, tenancyId, ts);
  const id = Number(info.lastInsertRowid);
  try {
    const ref = channel === 'sms' ? await sendSms(e164(to), text) : await sendEmail(to, subject, text);
    db.prepare(`UPDATE messages SET status = 'sent', sent_at = ?, error = ? WHERE id = ?`).run(now(), String(ref).slice(0, 60), id);
    return { sent: true, id };
  } catch (e) {
    db.prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`).run(String(e.message).slice(0, 300), id);
    return { error: e.message, id };
  }
}

module.exports = { deliver, sendEmail, sendSms, emailReady, smsReady, phoneOk, emailOk, e164 };
