'use strict';
// Photos are resized in the browser and arrive as JPEG data URLs. We check the magic bytes,
// write the file under DATA_DIR/photos with a random name, and keep a row pointing at it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, PHOTO_DIR, now } = require('./db');

const MAX_BYTES = 3 * 1024 * 1024;

function decodeJpeg(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Expected a JPEG photo.' };
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100) return { error: 'That photo is empty.' };
  if (buf.length > MAX_BYTES) return { error: 'That photo is too large even after resizing.' };
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return { error: 'That file is not a JPEG.' };
  return { buf };
}

function save(dataUrl) {
  const { buf, error } = decodeJpeg(dataUrl);
  if (error) return { error };
  const name = crypto.randomBytes(12).toString('hex') + '.jpg';
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  return { name };
}

// Save up to `max` photos and attach them to a record.
function attach(kind, refId, dataUrls, max = 4) {
  const saved = [];
  for (const d of (dataUrls || []).slice(0, max)) {
    const { name, error } = save(d);
    if (error) continue;
    db.prepare('INSERT INTO photos(kind, ref_id, filename, created_at) VALUES (?,?,?,?)').run(kind, refId, name, now());
    saved.push(name);
  }
  return saved;
}

function forRef(kind, refId) {
  return db.prepare('SELECT * FROM photos WHERE kind = ? AND ref_id = ? ORDER BY id').all(kind, refId);
}
function forRefs(kind, ids) {
  if (!ids.length) return {};
  const rows = db.prepare(`SELECT * FROM photos WHERE kind = ? AND ref_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(kind, ...ids);
  const out = {};
  for (const r of rows) (out[r.ref_id] ||= []).push(r);
  return out;
}
function removeOne(id) {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!row) return null;
  try { fs.unlinkSync(path.join(PHOTO_DIR, row.filename)); } catch (e) { }
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  return row;
}
function removeRef(kind, refId) {
  for (const r of forRef(kind, refId)) removeOne(r.id);
}

module.exports = { save, attach, forRef, forRefs, removeOne, removeRef, decodeJpeg };
