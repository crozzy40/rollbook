'use strict';
// Rollbook — rent roll and ledger for a self-managing landlord.
// Zero dependencies: node:http + node:sqlite. Run with `node server.js`.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { db, DB_PATH, PHOTO_DIR, now, getSetting, setSetting, transaction } = require('./lib/db');
const L = require('./lib/ledger');
const auth = require('./lib/auth');
const importer = require('./lib/importer');
const demo = require('./lib/demo');
const pay = require('./lib/pay');
const photos = require('./lib/photos');
const stripe = require('./lib/stripe');
const V = require('./lib/views');
const V2 = require('./lib/views2');
const { CATEGORIES, PAYMENT_METHODS, UNIT_KINDS, esc, bname } = require('./lib/util');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

// ---------------------------------------------------------------- tiny router
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}
const get = (p, h) => route('GET', p, h);
const post = (p, h) => route('POST', p, h);

// ---------------------------------------------------------------- helpers
function redirect(res, to, flash) {
  const headers = { Location: to };
  if (flash) headers['Set-Cookie'] = `rollbook_flash=${encodeURIComponent(JSON.stringify(flash))}; Path=/; Max-Age=30; SameSite=Lax; HttpOnly`;
  res.writeHead(303, headers); res.end();
}
function html(res, body, status = 200, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extra });
  res.end(body);
}
function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function notFound(req, res, ctx) { html(res, V.layout(ctx, { title: 'Not found', active: '', body: `<h1>Not found</h1><p class="lede">There's nothing at ${esc(req.url)}.</p><p><a href="/">Back to today</a></p>` }), 404); }

const readBodyCache = new WeakMap();
function readBody(req) {
  // The dispatcher reads the body once for CSRF; handlers get the cached copy.
  if (readBodyCache.has(req)) return Promise.resolve(readBodyCache.get(req));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const b = Buffer.concat(chunks); readBodyCache.set(req, b); resolve(b); });
    req.on('error', reject);
  });
}
function parseForm(buf) {
  const out = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v;
  return out;
}
const S = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const N = v => { const n = Number(String(v || '').replace(/[$,]/g, '')); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const D = v => (/^\d{4}-\d{2}-\d{2}$/.test(S(v)) ? S(v) : null);
const M = v => (/^\d{4}-\d{2}$/.test(S(v)) ? S(v) : null);

function ctxFor(req, token) {
  const rows = token ? L.portfolioRows() : [];
  const owedBy = {};
  for (const r of rows) if (r.balance > 0) owedBy[r.building_id] = (owedBy[r.building_id] || 0) + r.balance;
  const buildings = token ? buildingsAll().map(b => ({ ...b, owed: owedBy[b.id] || 0 })) : [];
  return {
    csrf: auth.csrfFor(token),
    portfolioName: getSetting('portfolio_name', 'My properties'),
    ownerName: getSetting('owner_name', ''),
    owedCount: rows.filter(r => r.balance > 0).length,
    newReports: token ? db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE source = 'tenant' AND status = 'open' AND seen = 0`).get().c : 0,
    buildings,
    buildingId: null,
    building: null,
    flash: null,
  };
}
function inBuilding(ctx, id) { ctx.buildingId = Number(id); ctx.building = (ctx.buildings || []).find(b => b.id === Number(id)) || buildingById(id); return ctx; }

function servePhoto(req, res, name) {
  if (!/^[a-f0-9]{24}\.jpg$/.test(name)) return false;
  const file = path.join(PHOTO_DIR, name);
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  fs.createReadStream(file).pipe(res);
  return true;
}
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const type = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------------------------------------------------------------- data helpers
function buildingsAll() { return db.prepare('SELECT * FROM buildings ORDER BY sort, name').all(); }
function unitsAll() { return db.prepare('SELECT u.*, COALESCE(NULLIF(b.display_name, \'\'), b.name) AS building_name FROM units u JOIN buildings b ON b.id = u.building_id ORDER BY b.sort, b.name, u.sort, u.label').all(); }
function unitById(id) { return db.prepare('SELECT * FROM units WHERE id = ?').get(id); }
function buildingById(id) { return db.prepare('SELECT * FROM buildings WHERE id = ?').get(id); }
function activeTenancy(unitId) { return db.prepare(`SELECT * FROM tenancies WHERE unit_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`).get(unitId); }
function tenancyById(id) { return db.prepare('SELECT * FROM tenancies WHERE id = ?').get(id); }
function expenseRowsFor(filters) {
  const where = [], args = [];
  if (filters.building) { where.push('e.building_id = ?'); args.push(Number(filters.building)); }
  if (filters.period) { where.push('substr(e.date,1,7) = ?'); args.push(filters.period); }
  else if (filters.year) { where.push('substr(e.date,1,4) = ?'); args.push(String(filters.year)); }
  if (filters.category) { where.push('e.category = ?'); args.push(filters.category); }
  return db.prepare(`SELECT e.*, COALESCE(NULLIF(b.display_name, ''), b.name) AS building_name, u.label AS unit_label FROM expenses e JOIN buildings b ON b.id = e.building_id LEFT JOIN units u ON u.id = e.unit_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date DESC, e.id DESC LIMIT 2000`).all(...args);
}

// ---------------------------------------------------------------- auth pages
get('/setup', (req, res, ctx) => {
  if (auth.isSetUp()) return redirect(res, '/login');
  html(res, V.setupPage(ctx));
});
post('/setup', async (req, res, ctx) => {
  if (auth.isSetUp()) return redirect(res, '/login');
  const f = parseForm(await readBody(req));
  if (f._csrf !== ctx.csrf) return html(res, V.setupPage(ctx, 'The form expired. Try again.'));
  if ((f.password || '').length < 8) return html(res, V.setupPage(ctx, 'Password needs at least 8 characters.'));
  if (f.password !== f.password2) return html(res, V.setupPage(ctx, 'The two passwords do not match.'));
  auth.setPassword(f.password);
  if (S(f.owner_name)) setSetting('owner_name', S(f.owner_name, 80));
  if (S(f.portfolio_name)) setSetting('portfolio_name', S(f.portfolio_name, 80));
  if (f.demo === '1') demo.seed();
  const token = auth.createSession();
  res.writeHead(303, { Location: '/', 'Set-Cookie': auth.cookieHeader(token, req) }); res.end();
});
get('/login', (req, res, ctx) => {
  if (!auth.isSetUp()) return redirect(res, '/setup');
  html(res, V.loginPage(ctx));
});
post('/login', async (req, res, ctx) => {
  if (!auth.isSetUp()) return redirect(res, '/setup');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  if (auth.tooManyFails(ip)) return html(res, V.loginPage(ctx, 'Too many tries. Wait ten minutes.'), 429);
  const f = parseForm(await readBody(req));
  if (f._csrf !== ctx.csrf) return html(res, V.loginPage(ctx, 'The form expired. Try again.'));
  if (!auth.verifyPassword(f.password || '', getSetting('password_hash'))) { auth.recordFail(ip); return html(res, V.loginPage(ctx, 'That password is not right.'), 401); }
  auth.clearFails(ip);
  const token = auth.createSession();
  res.writeHead(303, { Location: '/', 'Set-Cookie': auth.cookieHeader(token, req) }); res.end();
});
get('/logout', (req, res, ctx, token) => {
  auth.destroySession(token);
  res.writeHead(303, { Location: '/login', 'Set-Cookie': auth.cookieHeader('', req, true) }); res.end();
});

// ---------------------------------------------------------------- dashboard
get('/', (req, res, ctx) => {
  const rows = L.portfolioRows();
  const board = L.unitBoard();
  const cur = L.currentPeriod();
  const month = L.monthSummary(cur);
  const today = L.todayISO();
  const leases = rows.filter(r => r.lease_end).map(r => ({ ...r, days: L.daysBetween(today, r.lease_end) })).filter(r => r.days <= 90).sort((a, b) => a.days - b.days);
  const work = db.prepare(`SELECT w.*, COALESCE(NULLIF(b.display_name, ''), b.name) AS building_name, u.label AS unit_label FROM work_orders w JOIN buildings b ON b.id = w.building_id LEFT JOIN units u ON u.id = w.unit_id WHERE w.status = 'open' ORDER BY w.opened_at DESC LIMIT 5`).all();
  const collectedBy = {}; const dueBy = {};
  for (const r of db.prepare(`SELECT b.id, COALESCE(SUM(p.amount),0) v FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id JOIN buildings b ON b.id = u.building_id WHERE substr(p.date,1,7) = ? GROUP BY b.id`).all(cur)) collectedBy[r.id] = r.v;
  for (const r of db.prepare(`SELECT b.id, COALESCE(SUM(c.amount),0) v FROM charges c JOIN tenancies t ON t.id = c.tenancy_id JOIN units u ON u.id = t.unit_id JOIN buildings b ON b.id = u.building_id WHERE c.period = ? AND t.status = 'active' GROUP BY b.id`).all(cur)) dueBy[r.id] = r.v;
  const buildings = board.map(b => ({ id: b.id, name: b.name, display_name: b.display_name, photo: b.photo, demo: b.demo, units: b.units.length, occupied: b.units.filter(u => !u.vacant).length, due: dueBy[b.id] || 0, collected: collectedBy[b.id] || 0, owed: b.units.reduce((s, u) => s + (u.balance > 0 ? u.balance : 0), 0) }));
  const vacantCount = board.reduce((s, b) => s + b.units.filter(u => u.vacant).length, 0);
  html(res, V.dashboard(ctx, { month, rows, leases, work, buildings, vacantCount }));
});

// ---------------------------------------------------------------- delinquency
get('/delinquency', (req, res, ctx, token, q) => {
  let rows = L.portfolioRows();
  const buildingId = S(q.get('building') || '');
  if (buildingId) { rows = rows.filter(r => String(r.building_id) === buildingId); inBuilding(ctx, buildingId); }
  const pendingBy = pay.pendingAll(); rows = rows.map(r => ({ ...r, pendingOnline: pendingBy[r.tenancy_id] || 0 }));
  html(res, V.delinquency(ctx, rows, { buildings: buildingsAll(), buildingId, graceDays: getSetting('grace_days'), lateFeeKind: getSetting('late_fee_kind'), lateFeeAmount: getSetting('late_fee_amount'), rentDueDay: getSetting('rent_due_day') }));
});

// ---------------------------------------------------------------- units & buildings
get('/units', (req, res, ctx) => html(res, V.unitBoardPage(ctx, L.unitBoard())));
get('/units/new-building', (req, res, ctx) => html(res, V.buildingPage(ctx, {}, [], true)));
post('/buildings/new', async (req, res, ctx) => {
  const f = parseForm(await readBody(req));
  if (!S(f.name)) return redirect(res, '/units/new-building', { kind: 'error', text: 'Give the building a name.' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort),0) s FROM buildings').get().s + 1;
  const r = db.prepare('INSERT INTO buildings(name,address,notes,sort,demo,created_at) VALUES (?,?,?,?,0,?)').run(S(f.name, 80), S(f.address), S(f.notes, 2000), sort, now());
  redirect(res, `/buildings/${r.lastInsertRowid}/edit#units`, { text: 'Building added. Now add its units.' });
});
function buildingUnits(bid) {
  return db.prepare(`SELECT u.*, (SELECT tenant_name FROM tenancies t WHERE t.unit_id = u.id AND t.status = 'active' ORDER BY id DESC LIMIT 1) AS tenant_name FROM units u WHERE u.building_id = ? ORDER BY u.sort, u.label`).all(bid);
}
get('/buildings/:id', (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return notFound(req, res, ctx);
  inBuilding(ctx, b.id);
  const cur = L.currentPeriod(), today = L.todayISO();
  const board = L.unitBoard().find(x => x.id === b.id);
  const units = board ? board.units : [];
  const rows = L.portfolioRows().filter(r => r.building_id === b.id);
  const owedRows = rows.filter(r => r.balance > 0).sort((a, c) => c.balance - a.balance);
  const due = db.prepare(`SELECT COALESCE(SUM(c.amount),0) v FROM charges c JOIN tenancies t ON t.id = c.tenancy_id JOIN units u ON u.id = t.unit_id WHERE u.building_id = ? AND c.period = ? AND t.status = 'active'`).get(b.id, cur).v;
  const collected = db.prepare(`SELECT COALESCE(SUM(p.amount),0) v FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id WHERE u.building_id = ? AND substr(p.date,1,7) = ?`).get(b.id, cur).v;
  const spent = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE building_id = ? AND substr(date,1,7) = ?`).get(b.id, cur).v;
  const since30 = L.todayISO(new Date(Date.now() - 30 * 86400000)), since60 = L.todayISO(new Date(Date.now() - 60 * 86400000));
  const recentPayments = db.prepare(`SELECT p.date, p.amount, p.method, t.tenant_name, u.id AS unit_id, u.label AS unit_label, u.kind AS unit_kind FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id WHERE u.building_id = ? AND p.date >= ? ORDER BY p.date DESC, p.id DESC LIMIT 8`).all(b.id, since30);
  const expenses = db.prepare(`SELECT * FROM expenses WHERE building_id = ? AND date >= ? ORDER BY date DESC, id DESC LIMIT 8`).all(b.id, since60);
  const work = db.prepare(`SELECT w.*, u.label AS unit_label FROM work_orders w LEFT JOIN units u ON u.id = w.unit_id WHERE w.building_id = ? AND w.status = 'open' ORDER BY CASE w.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, w.opened_at DESC LIMIT 8`).all(b.id);
  const leases = rows.filter(r => r.lease_end).map(r => ({ ...r, days: L.daysBetween(today, r.lease_end) })).filter(r => r.days <= 90).sort((a, c) => a.days - c.days).slice(0, 8);
  html(res, V.buildingHome(ctx, { b, units, month: { period: cur, due: L.round2(due), collected: L.round2(collected), expenses: L.round2(spent) }, owedRows, expenses, work, leases, recentPayments }));
});
get('/buildings/:id/edit', (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return notFound(req, res, ctx);
  inBuilding(ctx, b.id);
  const all = buildingsAll(); const i = all.findIndex(x => x.id === b.id);
  html(res, V.buildingPage(ctx, b, buildingUnits(b.id), false, { canUp: i > 0, canDown: i >= 0 && i < all.length - 1 }));
});
post('/buildings/:id', async (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  db.prepare('UPDATE buildings SET name = ?, display_name = ?, address = ?, notes = ? WHERE id = ?').run(S(f.name, 80) || b.name, S(f.display_name, 60), S(f.address), S(f.notes, 2000), b.id);
  redirect(res, `/buildings/${b.id}`, { text: 'Saved.' });
});
post('/buildings/:id/units', async (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  const label = S(f.label, 40);
  if (!label) return redirect(res, `/buildings/${b.id}/edit#units`, { kind: 'error', text: 'The unit needs a label.' });
  if (db.prepare('SELECT 1 FROM units WHERE building_id = ? AND lower(label) = lower(?)').get(b.id, label)) return redirect(res, `/buildings/${b.id}/edit#units`, { kind: 'error', text: `There is already a unit called "${label}" here.` });
  const sort = db.prepare('SELECT COALESCE(MAX(sort),0) s FROM units WHERE building_id = ?').get(b.id).s + 1;
  db.prepare('INSERT INTO units(building_id,label,kind,notes,sort) VALUES (?,?,?,?,?)').run(b.id, label, UNIT_KINDS.includes(f.kind) ? f.kind : 'apartment', '', sort);
  redirect(res, `/buildings/${b.id}/edit#units`, { text: `Unit ${label} added.` });
});
post('/buildings/:id/move', async (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  const all = buildingsAll(); const i = all.findIndex(x => x.id === b.id);
  const j = f.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < all.length) {
    transaction(() => { all.forEach((x, k) => db.prepare('UPDATE buildings SET sort = ? WHERE id = ?').run(k + 1, x.id)); // normalize
      db.prepare('UPDATE buildings SET sort = ? WHERE id = ?').run(j + 1, b.id); db.prepare('UPDATE buildings SET sort = ? WHERE id = ?').run(i + 1, all[j].id); });
  }
  redirect(res, `/buildings/${b.id}/edit`, { text: 'Order updated.' });
});
// Photo arrives as a JPEG data URL, already resized in the browser. Saved under a random name; the old one is removed.
post('/buildings/:id/photo', async (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return json(res, { ok: false, error: 'No such building.' }, 404);
  let body; try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(res, { ok: false, error: 'Could not read the photo.' }, 400); }
  if (body._csrf !== ctx.csrf) return json(res, { ok: false, error: 'The page expired. Reload and try again.' }, 403);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
  if (!m) return json(res, { ok: false, error: 'Expected a JPEG photo.' }, 400);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > 3 * 1024 * 1024) return json(res, { ok: false, error: 'Photo must be under 3 MB after resizing.' }, 400);
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return json(res, { ok: false, error: 'That is not a JPEG.' }, 400);
  const name = crypto.randomBytes(12).toString('hex') + '.jpg';
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  if (b.photo) { try { fs.unlinkSync(path.join(PHOTO_DIR, b.photo)); } catch (e) { } }
  db.prepare('UPDATE buildings SET photo = ? WHERE id = ?').run(name, b.id);
  json(res, { ok: true, photo: name });
});
post('/buildings/:id/photo/delete', (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return notFound(req, res, ctx);
  if (b.photo) { try { fs.unlinkSync(path.join(PHOTO_DIR, b.photo)); } catch (e) { } }
  db.prepare("UPDATE buildings SET photo = '' WHERE id = ?").run(b.id);
  redirect(res, `/buildings/${b.id}/edit`, { text: 'Photo removed.' });
});
get('/buildings/:id/delete', (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return notFound(req, res, ctx);
  inBuilding(ctx, b.id);
  const n = db.prepare('SELECT COUNT(*) c FROM units WHERE building_id = ?').get(b.id).c;
  html(res, V.confirmDelete(ctx, { title: `Delete ${bname(b)}?`, text: `This removes the building, its ${n} unit(s), every tenant ledger, and every expense logged to it. There is no undo. Download a backup first if you are unsure.`, action: `/buildings/${b.id}/delete`, back: `/buildings/${b.id}/edit` }));
});
post('/buildings/:id/delete', (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id);
  if (b && b.photo) { try { fs.unlinkSync(path.join(PHOTO_DIR, b.photo)); } catch (e) { } }
  db.prepare('DELETE FROM buildings WHERE id = ?').run(p.id);
  redirect(res, '/units', { text: 'Building deleted.' });
});

get('/units/:id', (req, res, ctx, token, q, p) => {
  const unit = unitById(p.id); if (!unit) return notFound(req, res, ctx);
  const building = buildingById(unit.building_id); inBuilding(ctx, building.id);
  const tenancy = activeTenancy(unit.id);
  const bal = tenancy ? L.tenancyBalance(tenancy.id) : null;
  const past = db.prepare(`SELECT * FROM tenancies WHERE unit_id = ? AND status = 'ended' ORDER BY move_out DESC`).all(unit.id).map(t => ({ ...t, balance: L.tenancyBalance(t.id).balance }));
  const payLink = tenancy ? pay.payUrl(req, pay.tokenFor(tenancy.id)) : null;
  const pending = tenancy ? pay.pendingFor(tenancy.id) : [];
  html(res, V.unitPage(ctx, { unit, building, tenancy, bal, past, payLink, pending, online: stripe.isConfigured() }));
});
get('/units/:id/edit', (req, res, ctx, token, q, p) => {
  const unit = unitById(p.id); if (!unit) return notFound(req, res, ctx);
  inBuilding(ctx, unit.building_id);
  html(res, V.unitEdit(ctx, unit, buildingById(unit.building_id)));
});
post('/units/:id/edit', async (req, res, ctx, token, q, p) => {
  const unit = unitById(p.id); if (!unit) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  db.prepare('UPDATE units SET label = ?, kind = ?, notes = ? WHERE id = ?').run(S(f.label, 40) || unit.label, UNIT_KINDS.includes(f.kind) ? f.kind : unit.kind, S(f.notes, 2000), unit.id);
  redirect(res, `/units/${unit.id}`, { text: 'Saved.' });
});
get('/units/:id/delete', (req, res, ctx, token, q, p) => {
  const unit = unitById(p.id); if (!unit) return notFound(req, res, ctx);
  html(res, V.confirmDelete(ctx, { title: `Delete unit ${unit.label}?`, text: 'This removes the unit and every tenant ledger under it. There is no undo.', action: `/units/${unit.id}/delete`, back: `/units/${unit.id}` }));
});
post('/units/:id/delete', (req, res, ctx, token, q, p) => {
  const unit = unitById(p.id); if (!unit) return notFound(req, res, ctx);
  db.prepare('DELETE FROM units WHERE id = ?').run(unit.id);
  redirect(res, `/buildings/${unit.building_id}`, { text: 'Unit deleted.' });
});

// ---------------------------------------------------------------- tenancies
get('/units/:id/move-in', (req, res, ctx, token, q, p) => {
  const unit = unitById(p.id); if (!unit) return notFound(req, res, ctx);
  if (activeTenancy(unit.id)) return redirect(res, `/units/${unit.id}`, { kind: 'warn', text: 'Someone already lives here. Move them out first.' });
  inBuilding(ctx, unit.building_id);
  html(res, V.tenancyForm(ctx, { unit, building: buildingById(unit.building_id), tenancy: null, isNew: true }));
});
function tenancyFromForm(f) {
  return { tenant_name: S(f.tenant_name, 120), phone: S(f.phone, 40), email: S(f.email, 120), rent: N(f.rent), deposit: N(f.deposit),
    lease_start: D(f.lease_start), lease_end: D(f.lease_end), charges_from: M(f.charges_from) || L.currentPeriod(), notes: S(f.notes, 2000) };
}
post('/units/:id/move-in', async (req, res, ctx, token, q, p) => {
  const unit = unitById(p.id); if (!unit) return notFound(req, res, ctx);
  if (activeTenancy(unit.id)) return redirect(res, `/units/${unit.id}`, { kind: 'warn', text: 'Someone already lives here.' });
  const t = tenancyFromForm(parseForm(await readBody(req)));
  if (!t.tenant_name) return redirect(res, `/units/${unit.id}/move-in`, { kind: 'error', text: 'Tenant needs a name.' });
  if (t.charges_from > L.currentPeriod()) t.charges_from = L.currentPeriod();
  db.prepare(`INSERT INTO tenancies(unit_id,tenant_name,phone,email,rent,deposit,lease_start,lease_end,lease_text,charges_from,status,notes,created_at) VALUES (?,?,?,?,?,?,?,?,'',?,'active',?,?)`)
    .run(unit.id, t.tenant_name, t.phone, t.email, t.rent, t.deposit, t.lease_start, t.lease_end, t.charges_from, t.notes, now());
  L.postRentCharges();
  redirect(res, `/units/${unit.id}`, { text: `${t.tenant_name} moved in. Rent is on the ledger.` });
});
get('/tenancies/:id/edit', (req, res, ctx, token, q, p) => {
  const t = tenancyById(p.id); if (!t) return notFound(req, res, ctx);
  const unit = unitById(t.unit_id); inBuilding(ctx, unit.building_id);
  html(res, V.tenancyForm(ctx, { unit, building: buildingById(unit.building_id), tenancy: t, isNew: false }));
});
post('/tenancies/:id/edit', async (req, res, ctx, token, q, p) => {
  const t0 = tenancyById(p.id); if (!t0) return notFound(req, res, ctx);
  const t = tenancyFromForm(parseForm(await readBody(req)));
  if (!t.tenant_name) return redirect(res, `/tenancies/${t0.id}/edit`, { kind: 'error', text: 'Tenant needs a name.' });
  if (t.charges_from > L.currentPeriod()) t.charges_from = L.currentPeriod();
  transaction(() => {
    db.prepare('UPDATE tenancies SET tenant_name=?, phone=?, email=?, rent=?, deposit=?, lease_start=?, lease_end=?, charges_from=?, notes=? WHERE id = ?')
      .run(t.tenant_name, t.phone, t.email, t.rent, t.deposit, t.lease_start, t.lease_end, t.charges_from, t.notes, t0.id);
    // Rent changed: update this month's and future unpaid rent charges to the new amount; history is left alone.
    if (t.rent !== t0.rent) db.prepare(`UPDATE charges SET amount = ? WHERE tenancy_id = ? AND kind = 'rent' AND period >= ?`).run(t.rent, t0.id, L.currentPeriod());
    // charges_from moved earlier: remove nothing, just let posting fill in. Moved later: drop rent charges before it that have no payment attached.
    if (t.charges_from > t0.charges_from) db.prepare(`DELETE FROM charges WHERE tenancy_id = ? AND kind = 'rent' AND period < ?`).run(t0.id, t.charges_from);
  });
  L.postRentCharges();
  redirect(res, `/units/${t0.unit_id}`, { text: 'Saved.' });
});
get('/tenancies/:id/move-out', (req, res, ctx, token, q, p) => {
  const t = tenancyById(p.id); if (!t) return notFound(req, res, ctx);
  const unit = unitById(t.unit_id); inBuilding(ctx, unit.building_id);
  html(res, V.moveOutPage(ctx, t, unit, L.tenancyBalance(t.id)));
});
post('/tenancies/:id/move-out', async (req, res, ctx, token, q, p) => {
  const t = tenancyById(p.id); if (!t) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  const mo = D(f.move_out) || L.todayISO();
  transaction(() => {
    db.prepare(`UPDATE tenancies SET status = 'ended', move_out = ? WHERE id = ?`).run(mo, t.id);
    // Remove rent charges for months after the move-out month that nobody paid.
    db.prepare(`DELETE FROM charges WHERE tenancy_id = ? AND kind = 'rent' AND period > ?`).run(t.id, mo.slice(0, 7));
  });
  redirect(res, `/units/${t.unit_id}`, { text: `${t.tenant_name} moved out. The unit is vacant.` });
});

// ---------------------------------------------------------------- payments & charges
post('/tenancies/:id/payments', async (req, res, ctx, token, q, p) => {
  const t = tenancyById(p.id); if (!t) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  const amount = N(f.amount);
  if (amount <= 0) return redirect(res, `/units/${t.unit_id}#pay`, { kind: 'error', text: 'Enter an amount above zero.' });
  const date = D(f.date) || L.todayISO();
  const method = PAYMENT_METHODS.includes(f.method) ? f.method : 'Other';
  db.prepare(`INSERT INTO payments(tenancy_id,date,amount,method,reference,memo,source,created_at) VALUES (?,?,?,?,?,?,'manual',?)`).run(t.id, date, amount, method, S(f.reference, 60), S(f.memo, 300), now());
  const bal = L.tenancyBalance(t.id);
  redirect(res, `/units/${t.unit_id}`, { text: `Recorded ${fmt(amount)} from ${t.tenant_name} by ${method}. ${bal.balance > 0 ? `Still owes ${fmt(bal.balance)}.` : bal.credit > 0 ? `Credit of ${fmt(bal.credit)} on account.` : 'Paid up.'}` });
});
post('/tenancies/:id/charges', async (req, res, ctx, token, q, p) => {
  const t = tenancyById(p.id); if (!t) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  const amount = N(f.amount);
  if (amount <= 0) return redirect(res, `/units/${t.unit_id}#charge`, { kind: 'error', text: 'Enter an amount above zero.' });
  const date = D(f.date) || L.todayISO();
  const kind = f.kind === 'late_fee' ? 'late_fee' : 'other';
  db.prepare(`INSERT INTO charges(tenancy_id,date,period,kind,amount,memo,created_at) VALUES (?,?,?,?,?,?,?)`).run(t.id, date, date.slice(0, 7), kind, amount, S(f.memo, 300), now());
  redirect(res, `/units/${t.unit_id}`, { text: `${kind === 'late_fee' ? 'Late fee' : 'Charge'} of ${fmt(amount)} added.` });
});
function fmt(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
for (const kind of ['payments', 'charges']) {
  get(`/${kind}/:id/delete`, (req, res, ctx, token, q, p) => {
    const row = db.prepare(`SELECT x.*, t.unit_id, t.tenant_name FROM ${kind} x JOIN tenancies t ON t.id = x.tenancy_id WHERE x.id = ?`).get(p.id);
    if (!row) return notFound(req, res, ctx);
    html(res, V.confirmDelete(ctx, { title: `Remove this ${kind === 'payments' ? 'payment' : 'charge'}?`, text: `${fmt(row.amount)} on ${row.date} for ${row.tenant_name}. ${kind === 'charges' && row.kind === 'rent' ? 'This is a monthly rent charge; if the tenant still lives here it will post again on the next visit. To stop rent for a month, change "Charge rent starting" on the tenant instead.' : 'The ledger balance will change.'}`, action: `/${kind}/${row.id}/delete`, back: `/units/${row.unit_id}` }));
  });
  post(`/${kind}/:id/delete`, (req, res, ctx, token, q, p) => {
    const row = db.prepare(`SELECT x.id, t.unit_id FROM ${kind} x JOIN tenancies t ON t.id = x.tenancy_id WHERE x.id = ?`).get(p.id);
    if (!row) return notFound(req, res, ctx);
    db.prepare(`DELETE FROM ${kind} WHERE id = ?`).run(row.id);
    redirect(res, `/units/${row.unit_id}`, { text: 'Removed.' });
  });
}

// ---------------------------------------------------------------- pay links (owner side)
post('/tenancies/:id/pay-link/reset', (req, res, ctx, token, q, p) => {
  const t = tenancyById(p.id); if (!t) return notFound(req, res, ctx);
  pay.resetToken(t.id);
  redirect(res, `/units/${t.unit_id}#paylink`, { text: 'New pay link made. The old one no longer works.' });
});
post('/settings/stripe', async (req, res, ctx) => {
  const f = parseForm(await readBody(req));
  const sk = S(f.stripe_secret_key, 200), wh = S(f.stripe_webhook_secret, 200);
  if (sk && !/^sk_(test|live)_[A-Za-z0-9]+$/.test(sk)) return redirect(res, '/settings#online', { kind: 'error', text: 'The secret key should start with sk_live_ or sk_test_.' });
  if (wh && !/^whsec_[A-Za-z0-9]+$/.test(wh)) return redirect(res, '/settings#online', { kind: 'error', text: 'The webhook signing secret should start with whsec_.' });
  if (sk) setSetting('stripe_secret_key', sk); else if (f.clear_keys === '1') setSetting('stripe_secret_key', '');
  if (wh) setSetting('stripe_webhook_secret', wh); else if (f.clear_keys === '1') setSetting('stripe_webhook_secret', '');
  setSetting('pay_bank', f.pay_bank === '1' ? '1' : '0');
  setSetting('pay_card', f.pay_card === '1' ? '1' : '0');
  setSetting('pay_card_fee_to_tenant', f.pay_card_fee_to_tenant === '1' ? '1' : '0');
  if (!getSetting('stripe_secret_key')) return redirect(res, '/settings#online', { text: 'Saved.' });
  try {
    const acct = await stripe.request('GET', '/v1/account');
    redirect(res, '/settings#online', { text: `Connected to Stripe as ${acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name || acct.business_profile && acct.business_profile.name || acct.id}${stripe.isTestMode() ? ' (test mode)' : ''}.` });
  } catch (e) {
    redirect(res, '/settings#online', { kind: 'error', text: `Saved, but Stripe rejected the key: ${e.message}` });
  }
});

// ---------------------------------------------------------------- expenses
get('/expenses', (req, res, ctx, token, q) => {
  const filters = { building: S(q.get('building') || ''), period: M(q.get('period') || '') || '', year: /^\d{4}$/.test(q.get('year') || '') ? q.get('year') : '', category: CATEGORIES.includes(q.get('category')) ? q.get('category') : '' };
  if (filters.building) inBuilding(ctx, filters.building);
  const rows = expenseRowsFor(filters);
  const total = L.round2(rows.reduce((s, e) => s + e.amount, 0));
  const cats = {};
  for (const e of rows) cats[e.category] = L.round2((cats[e.category] || 0) + e.amount);
  const byCategory = Object.entries(cats).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
  html(res, V2.expensesPage(ctx, { rows, buildings: buildingsAll(), filters, byCategory, total }));
});
get('/expenses/new', (req, res, ctx, token, q) => {
  const buildings = buildingsAll();
  if (!buildings.length) return redirect(res, '/units/new-building', { kind: 'warn', text: 'Add a building before logging expenses.' });
  const pre = /^\d+$/.test(q.get('building') || '') ? { building_id: Number(q.get('building')) } : null;
  if (pre) inBuilding(ctx, pre.building_id);
  html(res, V2.expenseForm(ctx, { e: pre ? { ...pre, unit_id: '', date: L.todayISO(), category: 'Repairs & maintenance', description: '', vendor: '', amount: '', memo: '' } : null, buildings, units: unitsAll(), isNew: true }));
});
function expenseFromForm(f) {
  return { building_id: Number(f.building_id) || 0, unit_id: Number(f.unit_id) || null, date: D(f.date) || L.todayISO(), category: CATEGORIES.includes(f.category) ? f.category : 'Other', description: S(f.description, 200), vendor: S(f.vendor, 120), amount: N(f.amount), memo: S(f.memo, 300) };
}
post('/expenses/new', async (req, res, ctx) => {
  const e = expenseFromForm(parseForm(await readBody(req)));
  if (!buildingById(e.building_id)) return redirect(res, '/expenses/new', { kind: 'error', text: 'Pick a building.' });
  if (e.amount <= 0 || !e.description) return redirect(res, '/expenses/new', { kind: 'error', text: 'An expense needs a description and an amount.' });
  if (e.unit_id && !(unitById(e.unit_id) || {}).building_id === e.building_id) e.unit_id = null;
  db.prepare(`INSERT INTO expenses(building_id,unit_id,date,category,description,vendor,amount,memo,source,created_at) VALUES (?,?,?,?,?,?,?,?,'manual',?)`).run(e.building_id, e.unit_id, e.date, e.category, e.description, e.vendor, e.amount, e.memo, now());
  redirect(res, `/expenses?period=${e.date.slice(0, 7)}`, { text: `Logged ${fmt(e.amount)} for ${e.description}.` });
});
get('/expenses/:id/edit', (req, res, ctx, token, q, p) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(p.id); if (!e) return notFound(req, res, ctx);
  inBuilding(ctx, e.building_id);
  html(res, V2.expenseForm(ctx, { e, buildings: buildingsAll(), units: unitsAll(), isNew: false }));
});
post('/expenses/:id/edit', async (req, res, ctx, token, q, p) => {
  const e0 = db.prepare('SELECT * FROM expenses WHERE id = ?').get(p.id); if (!e0) return notFound(req, res, ctx);
  const e = expenseFromForm(parseForm(await readBody(req)));
  if (e.amount <= 0 || !e.description) return redirect(res, `/expenses/${e0.id}/edit`, { kind: 'error', text: 'An expense needs a description and an amount.' });
  db.prepare('UPDATE expenses SET building_id=?, unit_id=?, date=?, category=?, description=?, vendor=?, amount=?, memo=? WHERE id = ?').run(e.building_id || e0.building_id, e.unit_id, e.date, e.category, e.description, e.vendor, e.amount, e.memo, e0.id);
  redirect(res, `/expenses?period=${e.date.slice(0, 7)}`, { text: 'Saved.' });
});
get('/expenses/:id/delete', (req, res, ctx, token, q, p) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(p.id); if (!e) return notFound(req, res, ctx);
  html(res, V.confirmDelete(ctx, { title: 'Delete this expense?', text: `${fmt(e.amount)} on ${e.date}: ${e.description}.`, action: `/expenses/${e.id}/delete`, back: `/expenses/${e.id}/edit` }));
});
post('/expenses/:id/delete', (req, res, ctx, token, q, p) => { db.prepare('DELETE FROM expenses WHERE id = ?').run(p.id); redirect(res, '/expenses', { text: 'Deleted.' }); });

// ---------------------------------------------------------------- leases
get('/leases', (req, res, ctx) => html(res, V2.leasesPage(ctx, L.portfolioRows())));
get('/more', (req, res, ctx) => html(res, V.morePage(ctx)));

// ---------------------------------------------------------------- work orders
get('/work', (req, res, ctx, token, q) => {
  const all = db.prepare(`SELECT w.*, COALESCE(NULLIF(b.display_name, ''), b.name) AS building_name, u.label AS unit_label, t.tenant_name
                          FROM work_orders w JOIN buildings b ON b.id = w.building_id LEFT JOIN units u ON u.id = w.unit_id LEFT JOIN tenancies t ON t.id = w.tenancy_id
                          ORDER BY CASE w.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, w.opened_at DESC, w.id DESC`).all();
  const open = all.filter(w => w.status === 'open');
  const done = all.filter(w => w.status === 'done').slice(0, 25);
  const pics = photos.forRefs('work_order', [...open, ...done].map(w => w.id));
  if (open.some(w => !w.seen)) db.prepare(`UPDATE work_orders SET seen = 1 WHERE status = 'open' AND seen = 0`).run();
  html(res, V2.workPage(ctx, { open, done, pics, buildings: buildingsAll(), units: unitsAll() }));
});
get('/work/new', (req, res, ctx, token, q) => {
  const buildings = buildingsAll();
  if (!buildings.length) return redirect(res, '/units/new-building', { kind: 'warn', text: 'Add a building first.' });
  const pre = /^\d+$/.test(q.get('building') || '') ? { building_id: Number(q.get('building')), unit_id: '', title: '', notes: '', vendor: '', opened_at: L.todayISO(), cost: '', status: 'open' } : null;
  if (pre) inBuilding(ctx, pre.building_id);
  html(res, V2.workForm(ctx, { w: pre, buildings, units: unitsAll(), isNew: true }));
});
function workFromForm(f) {
  return { building_id: Number(f.building_id) || 0, unit_id: Number(f.unit_id) || null, title: S(f.title, 200), notes: S(f.notes, 2000), vendor: S(f.vendor, 120), opened_at: D(f.opened_at) || L.todayISO(), cost: N(f.cost), status: f.status === 'done' ? 'done' : 'open', urgency: ['emergency', 'urgent', 'normal'].includes(f.urgency) ? f.urgency : 'normal', tenant_note: S(f.tenant_note, 300) };
}
post('/work/new', async (req, res, ctx) => {
  const w = workFromForm(parseForm(await readBody(req)));
  if (!w.title || !buildingById(w.building_id)) return redirect(res, '/work/new', { kind: 'error', text: 'Say what needs doing and where.' });
  db.prepare(`INSERT INTO work_orders(building_id,unit_id,title,notes,vendor,status,opened_at,closed_at,cost,created_at,urgency,source,seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,'owner',1)`).run(w.building_id, w.unit_id, w.title, w.notes, w.vendor, w.status, w.opened_at, w.status === 'done' ? L.todayISO() : null, w.cost, now(), w.urgency);
  redirect(res, '/work', { text: 'Work order opened.' });
});
get('/work/:id/edit', (req, res, ctx, token, q, p) => {
  const w = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(p.id); if (!w) return notFound(req, res, ctx);
  inBuilding(ctx, w.building_id);
  w.pics = photos.forRef('work_order', w.id);
  if (w.tenancy_id) w.reporter = (db.prepare('SELECT tenant_name FROM tenancies WHERE id = ?').get(w.tenancy_id) || {}).tenant_name;
  html(res, V2.workForm(ctx, { w, buildings: buildingsAll(), units: unitsAll(), isNew: false }));
});
post('/work/:id/edit', async (req, res, ctx, token, q, p) => {
  const w0 = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(p.id); if (!w0) return notFound(req, res, ctx);
  const w = workFromForm(parseForm(await readBody(req)));
  if (!w.title) return redirect(res, `/work/${w0.id}/edit`, { kind: 'error', text: 'Say what needs doing.' });
  db.prepare('UPDATE work_orders SET building_id=?, unit_id=?, title=?, notes=?, vendor=?, status=?, opened_at=?, closed_at=?, cost=?, urgency=?, tenant_note=? WHERE id = ?')
    .run(w.building_id || w0.building_id, w.unit_id, w.title, w.notes, w.vendor, w.status, w.opened_at, w.status === 'done' ? (w0.closed_at || L.todayISO()) : null, w.cost, w.urgency, w.tenant_note, w0.id);
  redirect(res, '/work', { text: 'Saved.' });
});
get('/work/:id/done', (req, res, ctx, token, q, p) => {
  const w = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(p.id); if (!w) return notFound(req, res, ctx);
  html(res, V.layout(ctx, { title: 'Mark done', active: 'work', body: `
    <h1>Done: ${esc(w.title)}</h1><p class="lede" style="margin:6px 0 20px">Close it out. If it cost something, the amount can go straight into Expenses.</p>
    <form class="form" method="post" action="/work/${w.id}/done">${V.csrfField(ctx)}
      <div class="fields"><div class="field"><label for="c">Final cost</label><div class="money-input"><input id="c" type="number" step="0.01" min="0" name="cost" value="${w.cost ? w.cost.toFixed(2) : ''}"></div></div>
      <div class="field"><label for="cat">Expense category</label><select id="cat" name="category">${CATEGORIES.map(c => `<option ${c === 'Repairs & maintenance' ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label for="d">Completed on</label><input id="d" type="date" name="closed_at" value="${L.todayISO()}"></div></div>
      ${w.tenancy_id ? `<div class="field"><label for="tn">Note the tenant sees</label><input id="tn" type="text" name="tenant_note" maxlength="300" value="Fixed" placeholder="e.g. Fixed, new faucet installed"><div class="help">Shown on their pay link beside this repair.</div></div>` : ''}
      <div class="checkline" style="margin-bottom:16px"><input type="checkbox" id="ae" name="add_expense" value="1" checked><label for="ae" style="margin:0">Also log the cost as an expense</label></div>
      <div class="actions"><button class="btn" type="submit">Mark done</button><a class="btn secondary" href="/work">Cancel</a></div></form>` }));
});
post('/work/:id/done', async (req, res, ctx, token, q, p) => {
  const w = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(p.id); if (!w) return notFound(req, res, ctx);
  const f = parseForm(await readBody(req));
  const cost = N(f.cost), closed = D(f.closed_at) || L.todayISO();
  transaction(() => {
    db.prepare(`UPDATE work_orders SET status = 'done', closed_at = ?, cost = ?, tenant_note = ? WHERE id = ?`).run(closed, cost, S(f.tenant_note, 300), w.id);
    if (f.add_expense === '1' && cost > 0) db.prepare(`INSERT INTO expenses(building_id,unit_id,date,category,description,vendor,amount,memo,source,created_at) VALUES (?,?,?,?,?,?,?,?,'manual',?)`)
      .run(w.building_id, w.unit_id, closed, CATEGORIES.includes(f.category) ? f.category : 'Repairs & maintenance', w.title, w.vendor, cost, 'From work order', now());
  });
  redirect(res, '/work', { text: `Done.${f.add_expense === '1' && cost > 0 ? ` ${fmt(cost)} logged to expenses.` : ''}` });
});
get('/work/:id/delete', (req, res, ctx, token, q, p) => {
  const w = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(p.id); if (!w) return notFound(req, res, ctx);
  html(res, V.confirmDelete(ctx, { title: 'Delete this work order?', text: w.title, action: `/work/${w.id}/delete`, back: '/work' }));
});
post('/work/:id/delete', (req, res, ctx, token, q, p) => { photos.removeRef('work_order', Number(p.id)); db.prepare('DELETE FROM work_orders WHERE id = ?').run(p.id); redirect(res, '/work', { text: 'Deleted.' }); });
post('/work/:id/photos/:pid/delete', (req, res, ctx, token, q, p) => {
  const row = db.prepare('SELECT * FROM photos WHERE id = ? AND kind = ? AND ref_id = ?').get(p.pid, 'work_order', p.id);
  if (!row) return notFound(req, res, ctx);
  photos.removeOne(row.id);
  redirect(res, `/work/${p.id}/edit`, { text: 'Photo removed.' });
});

// ---------------------------------------------------------------- reports
function yearReport(year) {
  const y = String(year);
  const buildings = buildingsAll();
  const income = {}; const spent = {}; const capital = {};
  for (const r of db.prepare(`SELECT b.id, COALESCE(SUM(p.amount),0) v FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id JOIN buildings b ON b.id = u.building_id WHERE substr(p.date,1,4) = ? GROUP BY b.id`).all(y)) income[r.id] = r.v;
  for (const r of db.prepare(`SELECT building_id id, COALESCE(SUM(amount),0) v FROM expenses WHERE substr(date,1,4) = ? GROUP BY building_id`).all(y)) spent[r.id] = r.v;
  for (const r of db.prepare(`SELECT building_id id, COALESCE(SUM(amount),0) v FROM expenses WHERE substr(date,1,4) = ? AND category = 'Capital improvements' GROUP BY building_id`).all(y)) capital[r.id] = r.v;
  const byBuilding = buildings.map(b => ({ id: b.id, name: bname(b), income: L.round2(income[b.id] || 0), expenses: L.round2(spent[b.id] || 0), capital: L.round2(capital[b.id] || 0) }));
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(L.monthSummary(`${y}-${String(m).padStart(2, '0')}`));
  const per = {};
  for (const r of db.prepare(`SELECT category, building_id, COALESCE(SUM(amount),0) v FROM expenses WHERE substr(date,1,4) = ? GROUP BY category, building_id`).all(y)) { (per[r.category] ||= { total: 0, per: {} }); per[r.category].per[r.building_id] = L.round2(r.v); per[r.category].total = L.round2(per[r.category].total + r.v); }
  const byCategory = CATEGORIES.filter(c => per[c]).map(c => ({ category: c, ...per[c] }));
  const yrs = new Set([new Date().getFullYear()]);
  for (const r of db.prepare(`SELECT DISTINCT substr(date,1,4) y FROM payments UNION SELECT DISTINCT substr(date,1,4) FROM expenses`).all()) yrs.add(Number(r.y));
  return { year: Number(year), buildings, months, byBuilding, byCategory, years: [...yrs].sort((a, b) => b - a) };
}
get('/reports', (req, res, ctx, token, q) => {
  const year = /^\d{4}$/.test(q.get('year') || '') ? Number(q.get('year')) : new Date().getFullYear();
  html(res, V2.reportsPage(ctx, yearReport(year)));
});

// ---------------------------------------------------------------- import
get('/import', (req, res, ctx) => {
  const recent = db.prepare("SELECT i.*, COALESCE(NULLIF(b.display_name, ''), b.name) AS building_name FROM imports i LEFT JOIN buildings b ON b.id = i.building_id ORDER BY i.id DESC LIMIT 20").all();
  html(res, V2.importPage(ctx, { recent }));
});
post('/api/import', async (req, res, ctx) => {
  let payload;
  try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(res, { ok: false, errors: ['Could not read the import data.'] }, 400); }
  if (payload._csrf !== ctx.csrf) return json(res, { ok: false, errors: ['The page expired. Reload and try again.'] }, 403);
  try {
    const out = importer.apply(payload, Number(getSetting('rent_due_day', '1')) || 1);
    L.postRentCharges();
    json(res, { ok: true, ...out });
  } catch (e) {
    json(res, { ok: false, errors: e.errors || [e.message] }, 400);
  }
});
// A dry run: same validation, nothing written.
post('/api/import/check', async (req, res, ctx) => {
  let payload;
  try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(res, { ok: false, errors: ['Could not read the import data.'] }, 400); }
  const errors = importer.validate(payload);
  const existing = payload && payload.building_name ? db.prepare('SELECT id, name FROM buildings WHERE lower(name) = lower(?) AND demo = 0').get(String(payload.building_name).trim()) : null;
  json(res, { ok: !errors.length, errors, existing: existing ? { id: existing.id, name: existing.name } : null });
});

// ---------------------------------------------------------------- export (JSON feeds for the browser-side workbook builder)
get('/export', (req, res, ctx) => html(res, V2.exportPage(ctx, buildingsAll())));
get('/api/export/building/:id', (req, res, ctx, token, q, p) => {
  const b = buildingById(p.id); if (!b) return json(res, { error: 'No such building' }, 404);
  const year = /^\d{4}$/.test(q.get('year') || '') ? q.get('year') : String(new Date().getFullYear());
  const tenancies = db.prepare(`SELECT t.*, u.label AS unit_label, u.kind AS unit_kind FROM tenancies t JOIN units u ON u.id = t.unit_id WHERE u.building_id = ? ORDER BY t.status = 'ended', u.sort, u.label, t.id`).all(b.id);
  const pays = db.prepare(`SELECT p.tenancy_id, substr(p.date,1,7) period, SUM(p.amount) v FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id WHERE u.building_id = ? AND substr(p.date,1,4) = ? GROUP BY p.tenancy_id, period`).all(b.id, year);
  const byT = {}; for (const r of pays) (byT[r.tenancy_id] ||= {})[r.period] = r.v;
  const expenses = db.prepare(`SELECT e.*, u.label AS unit_label FROM expenses e LEFT JOIN units u ON u.id = e.unit_id WHERE e.building_id = ? AND substr(e.date,1,4) = ? ORDER BY e.date, e.id`).all(b.id, year);
  json(res, { building: b, year: Number(year), tenancies: tenancies.filter(t => t.status === 'active' || byT[t.id]).map(t => ({ ...t, months: Array.from({ length: 12 }, (_, i) => (byT[t.id] || {})[`${year}-${String(i + 1).padStart(2, '0')}`] || 0) })), expenses, categories: CATEGORIES });
});
get('/api/export/rentroll', (req, res) => json(res, { asOf: L.todayISO(), rows: L.unitBoard().flatMap(b => b.units.map(u => ({ building: bname(b), address: b.address, unit: u.unit_label, kind: u.unit_kind, tenant: u.vacant ? '' : u.tenant_name, phone: u.phone || '', email: u.email || '', rent: u.vacant ? 0 : u.rent, deposit: u.vacant ? 0 : u.deposit, lease_start: u.lease_start || '', lease_end: u.lease_end || '', status: u.status, balance: u.balance || 0, last_payment: u.lastPayment ? u.lastPayment.date : '', last_method: u.lastPayment ? u.lastPayment.method : '' }))) }));
get('/api/export/delinquency', (req, res) => json(res, { asOf: L.todayISO(), rows: L.portfolioRows().filter(r => r.balance > 0).map(r => ({ tenant: r.tenant_name, building: r.building_name, unit: r.unit_label, phone: r.phone, rent: r.rent, owed: r.balance, unpaid_since: r.aging.oldest, days_late: r.aging.daysLate, current: r.aging.current, d30: r.aging.d30, d60: r.aging.d60, d90: r.aging.d90, last_payment: r.lastPayment ? r.lastPayment.date : '', last_amount: r.lastPayment ? r.lastPayment.amount : 0 })) }));
get('/api/export/yearend', (req, res, ctx, token, q) => json(res, yearReport(/^\d{4}$/.test(q.get('year') || '') ? Number(q.get('year')) : new Date().getFullYear())));
get('/api/export/expenses', (req, res, ctx, token, q) => json(res, { rows: expenseRowsFor({ year: /^\d{4}$/.test(q.get('year') || '') ? q.get('year') : '' }) }));
get('/backup.sqlite', (req, res) => {
  // WAL is checkpointed so the single file is complete.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const stamp = L.todayISO();
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="rollbook-backup-${stamp}.sqlite"`, 'Cache-Control': 'no-store' });
  fs.createReadStream(DB_PATH).pipe(res);
});

// ---------------------------------------------------------------- settings
function settingsObj() { return { portfolio_name: getSetting('portfolio_name'), owner_name: getSetting('owner_name'), rent_due_day: getSetting('rent_due_day'), grace_days: getSetting('grace_days'), late_fee_kind: getSetting('late_fee_kind'), late_fee_amount: getSetting('late_fee_amount'), requests_on: getSetting('requests_on', '1'), emergency_phone: getSetting('emergency_phone', '') }; }
get('/settings', (req, res, ctx) => html(res, V2.settingsPage(ctx, settingsObj(), db.prepare('SELECT COUNT(*) c FROM buildings WHERE demo = 1').get().c, {
  configured: stripe.isConfigured(), testMode: stripe.isTestMode(), hasWebhook: !!getSetting('stripe_webhook_secret', ''), keyTail: (getSetting('stripe_secret_key', '') || '').slice(-4),
  webhookUrl: `${pay.baseUrl(req)}/stripe/webhook`, pay_bank: getSetting('pay_bank', '1'), pay_card: getSetting('pay_card', '1'), pay_card_fee_to_tenant: getSetting('pay_card_fee_to_tenant', '1'),
  recent: db.prepare(`SELECT o.*, t.tenant_name FROM online_payments o JOIN tenancies t ON t.id = o.tenancy_id ORDER BY o.created_at DESC LIMIT 10`).all() })));
// Each settings form says which section it is, so saving one never clears another's switches.
post('/settings', async (req, res, ctx) => {
  const f = parseForm(await readBody(req));
  const section = f.section === 'requests' ? 'requests' : 'rules';
  if (section === 'rules') {
    setSetting('portfolio_name', S(f.portfolio_name, 80) || 'My properties');
    setSetting('owner_name', S(f.owner_name, 80));
    setSetting('rent_due_day', String(Math.min(28, Math.max(1, Number(f.rent_due_day) || 1))));
    setSetting('grace_days', String(Math.min(31, Math.max(0, Number(f.grace_days) || 0))));
    setSetting('late_fee_kind', f.late_fee_kind === 'percent' ? 'percent' : 'flat');
    setSetting('late_fee_amount', String(Math.max(0, N(f.late_fee_amount))));
  } else {
    setSetting('requests_on', f.requests_on === '1' ? '1' : '0');
    setSetting('emergency_phone', S(f.emergency_phone, 40));
  }
  redirect(res, section === 'requests' ? '/settings#requests' : '/settings', { text: 'Settings saved.' });
});
post('/settings/password', async (req, res, ctx, token) => {
  const f = parseForm(await readBody(req));
  if (!auth.verifyPassword(f.current || '', getSetting('password_hash'))) return redirect(res, '/settings', { kind: 'error', text: 'Current password is not right.' });
  if ((f.password || '').length < 8 || f.password !== f.password2) return redirect(res, '/settings', { kind: 'error', text: 'New password needs 8+ characters and both entries must match.' });
  auth.setPassword(f.password);
  auth.destroyAllSessions();
  const t = auth.createSession();
  res.writeHead(303, { Location: '/settings', 'Set-Cookie': [auth.cookieHeader(t, req), `rollbook_flash=${encodeURIComponent(JSON.stringify({ text: 'Password changed. Other signed-in devices were signed out.' }))}; Path=/; Max-Age=30; SameSite=Lax; HttpOnly`] }); res.end();
});
get('/settings/clear-demo', (req, res, ctx) => html(res, V.confirmDelete(ctx, { title: 'Clear demo data?', text: 'Removes the demo buildings and everything under them. Your own buildings are not touched.', action: '/settings/clear-demo', back: '/settings' })));
post('/settings/clear-demo', (req, res) => { const n = demo.clear(); redirect(res, '/settings', { text: `Cleared ${n} demo building(s).` }); });
post('/settings/seed-demo', (req, res) => { demo.seed(); redirect(res, '/units', { text: 'Demo portfolio loaded.' }); });

// ---------------------------------------------------------------- public: pay pages + webhook
const payHits = new Map();
function payThrottled(ip) {
  const f = payHits.get(ip) || { t: Date.now(), n: 0 };
  if (Date.now() - f.t > 60000) { f.t = Date.now(); f.n = 0; }
  f.n++; payHits.set(ip, f);
  return f.n > 60;
}
async function handlePublic(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  const portfolio = getSetting('portfolio_name', 'Rent');
  if (url.pathname === '/stripe/webhook') {
    if (req.method !== 'POST') return json(res, { error: 'POST only' }, 405);
    const raw = (await readBody(req)).toString('utf8');
    const secret = getSetting('stripe_webhook_secret', '');
    if (!stripe.verifyWebhook(raw, req.headers['stripe-signature'], secret)) return json(res, { error: 'bad signature' }, 400);
    let event; try { event = JSON.parse(raw); } catch (e) { return json(res, { error: 'bad json' }, 400); }
    const result = pay.handleEvent(event);
    console.log(`stripe ${event.type} ${event.id}: ${result}`);
    return json(res, { received: true, result });
  }
  if (payThrottled(ip)) return html(res, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:40px">Too many requests. Try again in a minute.</p>', 429);
  const m = url.pathname.match(/^\/pay\/([A-Za-z0-9]{8,20})(?:\/(checkout|done|fix))?$/);
  if (!m) return html(res, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:40px">This link is not valid.</p>', 404);
  const t = pay.tenancyByToken(m[1]);
  if (!t || t.status !== 'active') return html(res, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:40px">This payment link is no longer active. Please contact your landlord.</p>', 404);
  L.postRentCharges();
  const configured = stripe.isConfigured();
  const requestsOn = getSetting('requests_on', '1') === '1';
  const emergencyPhone = getSetting('emergency_phone', '');
  if (!m[2] && req.method === 'GET') return html(res, pay.payPage(t, { portfolio, configured, requestsOn }), 200, { 'X-Robots-Tag': 'noindex' });
  if (m[2] === 'fix') {
    if (!requestsOn) return redirect(res, `/pay/${m[1]}`);
    if (req.method === 'GET') {
      if (url.searchParams.get('sent') === '1') return html(res, pay.fixSentPage(t, { portfolio, emergencyPhone }), 200, { 'X-Robots-Tag': 'noindex' });
      return html(res, pay.fixPage(t, { portfolio, emergencyPhone }), 200, { 'X-Robots-Tag': 'noindex' });
    }
    if (req.method === 'POST') {
      let body; try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return json(res, { ok: false, error: 'Could not read that.' }, 400); }
      const title = S(body.title, 120);
      if (!title) return json(res, { ok: false, error: 'Tell us what is wrong first.' }, 400);
      if (pay.tooManyRequests(t.id)) return json(res, { ok: false, error: 'You have several repairs open already. Please call your landlord about anything urgent.' }, 429);
      const out = pay.createRequest(t, { title, notes: S(body.notes, 1200), urgency: S(body.urgency, 20), photoData: Array.isArray(body.photos) ? body.photos : [] });
      console.log(`repair reported: ${title} (unit ${t.unit_label}, ${out.photos} photo(s))`);
      return json(res, { ok: true, id: out.id });
    }
  }
  if (m[2] === 'checkout' && req.method === 'POST') {
    const f = parseForm(await readBody(req));
    const amount = N(f.amount);
    try {
      if (!configured) throw new Error('Online payments are not switched on yet.');
      const session = await pay.startCheckout(req, t, amount, f.method === 'card' ? 'card' : 'bank');
      res.writeHead(303, { Location: session.url }); return res.end();
    } catch (e) {
      console.error('checkout failed:', e.message);
      return html(res, pay.payPage(t, { portfolio, configured, error: `Could not start the payment: ${e.message}` }), 400);
    }
  }
  if (m[2] === 'done' && req.method === 'GET') {
    const sid = url.searchParams.get('session_id') || '';
    const op = /^cs_[A-Za-z0-9_]+$/.test(sid) ? await pay.syncSession(sid) : null;
    if (op && op.tenancy_id !== t.id) return html(res, '<!doctype html><meta charset="utf-8"><p>Not found.</p>', 404);
    return html(res, pay.donePage(t, op, { portfolio }));
  }
  return html(res, '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:40px">Not found.</p>', 404);
}

// ---------------------------------------------------------------- dispatch
const OPEN = new Set(['/setup', '/login']);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/app.css' || pathname.startsWith('/js/'))) { if (serveStatic(req, res, pathname)) return; }
    if (req.method === 'GET' && pathname.startsWith('/photos/')) {
      const cookies0 = auth.parseCookies(req.headers.cookie);
      if (!auth.sessionValid(cookies0[auth.COOKIE])) return redirect(res, '/login');
      if (servePhoto(req, res, pathname.slice(8))) return;
      return notFound(req, res, ctxFor(req, null));
    }
    const cookies = auth.parseCookies(req.headers.cookie);
    const token = auth.sessionValid(cookies[auth.COOKIE]) ? cookies[auth.COOKIE] : null;
    if (pathname === '/health') return json(res, { ok: true });

    // ---- tenant-facing, no login: pay pages and the Stripe webhook
    if (pathname.startsWith('/pay/') || pathname === '/stripe/webhook') return handlePublic(req, res, url);

    if (!auth.isSetUp() && !OPEN.has(pathname)) return redirect(res, '/setup');
    if (!token && !OPEN.has(pathname)) return redirect(res, '/login');
    if (token && OPEN.has(pathname)) return redirect(res, '/');

    // Post any rent that has come due since the last visit.
    if (token && req.method === 'GET') L.postRentCharges();

    const ctx = ctxFor(req, token);
    if (cookies.rollbook_flash) {
      try { ctx.flash = JSON.parse(decodeURIComponent(cookies.rollbook_flash)); } catch (e) { }
      res.setHeader('Set-Cookie', 'rollbook_flash=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = {}; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      // CSRF for every POST except the JSON import endpoints, which check the token in their body.
      if (req.method === 'POST' && !pathname.startsWith('/api/')) {
        const buf = await readBody(req);
        const isJson = /application\/json/.test(req.headers['content-type'] || '');
        let tok = null;
        if (isJson) { try { tok = JSON.parse(buf.toString('utf8'))._csrf; } catch (e) { tok = null; } }
        else tok = parseForm(buf)._csrf;
        if (tok !== ctx.csrf) {
          if (isJson) return json(res, { ok: false, error: 'The page expired. Reload and try again.' }, 403);
          return html(res, V.layout(ctx, { title: 'Expired', active: '', body: '<h1>That form expired</h1><p class="lede">Go back and try again.</p>' }), 403);
        }
      }
      return await r.handler(req, res, ctx, token, url.searchParams, params);
    }
    notFound(req, res, ctx);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h1>Something went wrong</h1><p>Rollbook hit an error. Reload the page; if it keeps happening, the details are in the server log.</p>');
  }
});
server.listen(PORT, () => console.log(`Rollbook listening on http://localhost:${PORT}  (data: ${DB_PATH})`));
