'use strict';
// A small Stripe client. Stripe's API is plain HTTPS with form-encoded bodies, so no SDK is needed.
// The base URL can be pointed at a stand-in server for tests (STRIPE_API_BASE).

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { getSetting } = require('./db');

const API_BASE = process.env.STRIPE_API_BASE || 'https://api.stripe.com';

// Stripe's nested form encoding: { a: { b: 1 }, c: [x, y] } -> a[b]=1&c[0]=x&c[1]=y
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? encode(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

function request(method, path, params, key = getSetting('stripe_secret_key', '')) {
  return new Promise((resolve, reject) => {
    if (!key) return reject(new Error('Stripe is not set up yet. Add the secret key under Settings.'));
    const url = new URL(API_BASE + path);
    const body = method === 'POST' ? encode(params) : '';
    if (method === 'GET' && params) url.search = encode(params);
    const lib = url.protocol === 'http:' ? http : https;
    const headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Stripe-Version': '2024-06-20',
      'User-Agent': 'Rollbook/1.2',
    };
    if (method === 'POST') headers['Idempotency-Key'] = crypto.randomUUID();
    const req = lib.request(url, {
      method,
      headers,
      timeout: 20000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { return reject(new Error(`Stripe returned something unreadable (${res.statusCode}).`)); }
        if (res.statusCode >= 400) {
          const msg = parsed && parsed.error ? parsed.error.message : `Stripe error ${res.statusCode}`;
          const err = new Error(msg); err.stripe = parsed && parsed.error; err.status = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Stripe did not answer in time.')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Stripe-Signature: t=timestamp,v1=hex[,v1=hex]
function verifyWebhook(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!secret || !sigHeader) return false;
  const parts = Object.create(null);
  for (const p of String(sigHeader).split(',')) { const [k, v] = p.split('='); if (k && v) (parts[k] ||= []).push(v); }
  const t = parts.t && parts.t[0];
  const sigs = parts.v1 || [];
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
// Used by the test suite to sign a fake event the same way Stripe does.
function signWebhook(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

function isConfigured() { return !!getSetting('stripe_secret_key', ''); }
function isTestMode() { return /^sk_test_/.test(getSetting('stripe_secret_key', '')); }

module.exports = { request, encode, verifyWebhook, signWebhook, isConfigured, isTestMode };
