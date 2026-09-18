'use strict';
const crypto = require('node:crypto');
const { db, now, getSetting, setSetting } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'rollbook_session';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const a = Buffer.from(keyHex, 'hex');
  return a.length === key.length && crypto.timingSafeEqual(a, key);
}

function isSetUp() { return !!getSetting('password_hash'); }
function setPassword(pw) { setSetting('password_hash', hashPassword(pw)); }

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token, created_at, expires_at) VALUES (?,?,?)').run(token, now(), exp);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  return token;
}
function destroySession(token) { if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
function destroyAllSessions() { db.exec('DELETE FROM sessions'); }
function sessionValid(token) {
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  return !!row && row.expires_at > now();
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function cookieHeader(token, req, clear = false) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') || process.env.FORCE_SECURE_COOKIE === '1';
  const parts = [`${COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`);
  return parts.join('; ');
}

// Login throttle: 8 failures per 10 minutes per IP.
const fails = new Map();
function tooManyFails(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 600000) { fails.delete(ip); return false; }
  return f.n >= 8;
}
function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 600000) fails.set(ip, { first: Date.now(), n: 1 });
  else f.n++;
}
function clearFails(ip) { fails.delete(ip); }

// CSRF: every session gets a token derived from the session token via HMAC with a server secret.
function serverSecret() {
  let s = getSetting('server_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('server_secret', s); }
  return s;
}
function csrfFor(token) {
  return crypto.createHmac('sha256', serverSecret()).update(token || 'anon').digest('base64url').slice(0, 32);
}

module.exports = { COOKIE, isSetUp, setPassword, verifyPassword, createSession, destroySession, destroyAllSessions, sessionValid, parseCookies, cookieHeader, tooManyFails, recordFail, clearFails, csrfFor, getSetting };
