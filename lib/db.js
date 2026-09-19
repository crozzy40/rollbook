'use strict';
// Rollbook data layer. Uses Node's built-in SQLite (node:sqlite, Node 22.13+).
// One file on disk, foreign keys on, WAL mode so backups can be taken while running.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'rollbook.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buildings (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  demo       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'apartment',   -- apartment | garage | parking | storage | other
  notes       TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tenancies (
  id          INTEGER PRIMARY KEY,
  unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  tenant_name TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  rent        REAL NOT NULL DEFAULT 0,
  deposit     REAL NOT NULL DEFAULT 0,
  lease_start TEXT,                 -- YYYY-MM-DD or NULL
  lease_end   TEXT,                 -- YYYY-MM-DD or NULL
  lease_text  TEXT NOT NULL DEFAULT '',   -- the free text as she wrote it, kept verbatim
  charges_from TEXT NOT NULL,       -- YYYY-MM: first month rent is charged
  status      TEXT NOT NULL DEFAULT 'active',  -- active | ended
  move_out    TEXT,                 -- YYYY-MM-DD when status = ended
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS charges (
  id          INTEGER PRIMARY KEY,
  tenancy_id  INTEGER NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,        -- YYYY-MM-DD
  period      TEXT NOT NULL,        -- YYYY-MM the charge belongs to
  kind        TEXT NOT NULL,        -- rent | late_fee | other
  amount      REAL NOT NULL,
  memo        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS charges_rent_once ON charges(tenancy_id, period) WHERE kind = 'rent';

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY,
  tenancy_id  INTEGER NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  amount      REAL NOT NULL,
  method      TEXT NOT NULL DEFAULT 'other',
  reference   TEXT NOT NULL DEFAULT '',
  memo        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual | import
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  unit_id     INTEGER REFERENCES units(id) ON DELETE SET NULL,
  date        TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  vendor      TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL,
  memo        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  unit_id     INTEGER REFERENCES units(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  vendor      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',   -- open | done
  opened_at   TEXT NOT NULL,
  closed_at   TEXT,
  cost        REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_units_building ON units(building_id);
CREATE INDEX IF NOT EXISTS idx_tenancies_unit ON tenancies(unit_id);
CREATE INDEX IF NOT EXISTS idx_charges_tenancy ON charges(tenancy_id, date);
CREATE INDEX IF NOT EXISTS idx_payments_tenancy ON payments(tenancy_id, date);
CREATE INDEX IF NOT EXISTS idx_expenses_building ON expenses(building_id, date);
`;

db.exec(SCHEMA);

// Additive migrations for databases created by earlier versions.
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('buildings', 'display_name', "TEXT NOT NULL DEFAULT ''");
addColumn('buildings', 'photo', "TEXT NOT NULL DEFAULT ''");   // filename under DATA_DIR/photos
addColumn('tenancies', 'pay_token', "TEXT NOT NULL DEFAULT ''"); // private pay-link token; blank until first generated
addColumn('payments', 'stripe_id', "TEXT NOT NULL DEFAULT ''");  // Checkout session id, for idempotent webhooks
addColumn('work_orders', 'urgency', "TEXT NOT NULL DEFAULT 'normal'");   // emergency | urgent | normal
addColumn('work_orders', 'source', "TEXT NOT NULL DEFAULT 'owner'");     // owner | tenant
addColumn('work_orders', 'tenancy_id', 'INTEGER');                        // who reported it, when a tenant did
addColumn('work_orders', 'reported_at', 'TEXT');
addColumn('work_orders', 'tenant_note', "TEXT NOT NULL DEFAULT ''");      // what the owner wants the tenant to see
addColumn('work_orders', 'seen', "INTEGER NOT NULL DEFAULT 1");           // 0 until the owner opens a tenant report
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS tenancies_pay_token ON tenancies(pay_token) WHERE pay_token != '';
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_id ON payments(stripe_id) WHERE stripe_id != '';
CREATE TABLE IF NOT EXISTS online_payments (
  session_id  TEXT PRIMARY KEY,
  tenancy_id  INTEGER NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,           -- what lands on the ledger (rent portion)
  fee         REAL NOT NULL DEFAULT 0, -- surcharge the tenant paid on top, if any
  method      TEXT NOT NULL,           -- Bank transfer | Card
  status      TEXT NOT NULL,           -- started | pending | paid | failed | expired
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,          -- work_order
  ref_id      INTEGER NOT NULL,
  filename    TEXT NOT NULL,          -- under DATA_DIR/photos
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_ref ON photos(kind, ref_id);
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL
);`);
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---- helpers -------------------------------------------------------------

function now() { return new Date().toISOString(); }

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Defaults for settings that pages read.
const DEFAULTS = {
  portfolio_name: 'My properties',
  owner_name: '',
  rent_due_day: '1',
  grace_days: '5',
  late_fee_kind: 'flat',    // flat | percent
  late_fee_amount: '50',
  pay_bank: '1',            // offer bank debit (ACH)
  pay_card: '1',            // offer cards
  pay_card_fee_to_tenant: '1', // add the card processing fee to what the tenant pays
  requests_on: '1',            // let tenants report repairs from their link
  emergency_phone: '',         // shown to a tenant who picks "emergency"
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (getSetting(k) === null) setSetting(k, v);
}

module.exports = { db, DB_PATH, DATA_DIR, PHOTO_DIR, now, getSetting, setSetting, transaction };
