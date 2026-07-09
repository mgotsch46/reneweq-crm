/**
 * db.js — SQLite database bootstrap for the Wholesale CRM.
 *
 * Opens ./data/crm.db (creating ./data at runtime), creates all tables
 * if they don't exist, and seeds demo data on first run (only when the
 * users table is empty).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Constants shared across the app
// ---------------------------------------------------------------------------

/** Pipeline stages, in exact order. */
const STAGES = [
  'New',
  'Contacted',
  'Qualified',
  'Offer Sent',
  'Negotiation',
  'Offer Accepted',
  'Property Analyzer',
  'BOG Walk Through',
  'EMD Sent',
  'Dispo',
  'Assigned',
  'Closed',
  'Dead Deal',
];

/** Reasons a deal died (Dead Deal stage → archived). */
const DEAD_REASONS = ['Did not accept offer', 'Sold', 'Other'];

/** Lead-source tags. Custom sources are also allowed (free text). */
const LEAD_SOURCES = ['Manual Upload', 'Zillow', 'Referral', 'Email Campaign', 'Custom'];

/**
 * Map legacy stage names → new stage names (applied once at boot so existing
 * leads land on the closest new stage).
 */
const STAGE_REMAP = {
  'Prospect': 'New',
  'Offer Delivered': 'Offer Sent',
  'Property Analyzer Run': 'Property Analyzer',
  // Offer Accepted, BOG Walk Through, EMD Sent, Dispo, Assigned, Closed keep their names.
};

/** Default 4-touch SMS drip templates. Tokens: {name} {property} {agent} */
const DEFAULT_TEXTS = [
  "Hi {name}, this is {agent} — I came across your listing at {property} and I'm a local cash buyer. Would you consider an offer? No fees, quick close.",
  'Hi {name}, following up on {property}. I can close fast and as-is. Is the property still available?',
  "{name}, still interested in a strong cash offer on {property}. What's the best number to reach you?",
  "Last note, {name} — if {property} is still on the market I'd love to send an offer this week. Just reply YES.",
];

/** Default ringless-voicemail script. */
const DEFAULT_RVM =
  'Hi {name}, this is {agent}, a local investor interested in {property}. I can pay cash — call me back when you get a chance. Thanks!';

/** Generate a unique id for any row. */
const uid = () => crypto.randomUUID();

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Open database (create ./data dir at runtime)
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'crm.db'));
try { db.exec('PRAGMA journal_mode = WAL'); }
catch (e) { /* some filesystems (network/overlay mounts) reject WAL; default rollback journal is fine */ }
db.exec('PRAGMA foreign_keys = ON');

// Compatibility shim: node:sqlite has no .transaction() helper like
// better-sqlite3. Replicate the same API — db.transaction(fn) returns a
// function that runs fn inside BEGIN/COMMIT (ROLLBACK on throw).
if (typeof db.transaction !== 'function') {
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  business_number TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id),
  name              TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  property          TEXT,
  zillow            TEXT,
  agentName         TEXT,
  agentPhone        TEXT,
  agentEmail        TEXT,
  stage             TEXT NOT NULL DEFAULT 'New',
  notes             TEXT,
  executedContract  TEXT,
  closing           TEXT,
  dueDiligence      TEXT,
  inspectionExpires TEXT,
  source            TEXT,
  dnc               INTEGER NOT NULL DEFAULT 0,
  consent_sms       INTEGER NOT NULL DEFAULT 0,
  consent_rvm       INTEGER NOT NULL DEFAULT 0,
  texts             TEXT,          -- JSON array of 4 strings
  textStatus        TEXT,          -- JSON array of 4 bools
  rvm               TEXT,
  rvmStatus         INTEGER NOT NULL DEFAULT 0,
  beds              REAL,
  baths             REAL,
  sqft              INTEGER,
  agentCompany      TEXT,
  isFsbo            INTEGER NOT NULL DEFAULT 0,
  sellerName        TEXT,
  fsboPhone         TEXT,
  fsboEmail         TEXT,
  daysOnMarket      INTEGER,
  priceChanges      TEXT,
  propertyTax       TEXT,
  photoUrl          TEXT,
  sourceUrl         TEXT,
  keywords          TEXT,
  city              TEXT,
  state             TEXT,
  listingDescription TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('call','sms','email','rvm','note','stage')),
  mode        TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','automated')),
  direction   TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  body        TEXT,
  status      TEXT,
  provider_id TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  due_date     TEXT,
  done         INTEGER NOT NULL DEFAULT 0,
  contact_id   TEXT,
  external_ref TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  stored      TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER,
  uploaded_by TEXT,
  created_at  TEXT NOT NULL
);

-- Recorded ringless-voicemail audio clips (stored on the volume, like documents).
CREATE TABLE IF NOT EXISTS rvm_recordings (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  label       TEXT,
  stored      TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER,
  duration_ms INTEGER,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

-- Ringless voicemails queued to send now or at a scheduled time.
CREATE TABLE IF NOT EXISTS scheduled_rvms (
  id           TEXT PRIMARY KEY,
  contact_id   TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL,
  recording_id TEXT REFERENCES rvm_recordings(id) ON DELETE SET NULL,
  phone        TEXT NOT NULL,
  script       TEXT,
  send_at      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled',
  provider_ref TEXT,
  error        TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner   ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner      ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_contact ON documents(contact_id);
-- Web Push subscriptions (PWA push notifications), one row per device.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  sub        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rvmrec_contact ON rvm_recordings(contact_id);
CREATE INDEX IF NOT EXISTS idx_schedrvm_due ON scheduled_rvms(status, send_at);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

// Native (Android/iOS) push tokens — Firebase Cloud Messaging registration
// tokens, one row per device. Separate from web-push subscriptions above.
db.exec(`
CREATE TABLE IF NOT EXISTS native_push_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  platform   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_push_user ON native_push_tokens(user_id);
`);

// ---------------------------------------------------------------------------
// Idempotent migration — add real-estate lead columns to `contacts`.
// Fresh installs get them via CREATE TABLE above; existing DBs get ALTERed
// here. Safe to run on every startup (only adds columns that are missing).
// ---------------------------------------------------------------------------

const LEAD_COLUMNS = [
  ['beds', 'REAL'],
  ['baths', 'REAL'],
  ['sqft', 'INTEGER'],
  ['agentCompany', 'TEXT'],
  ['isFsbo', 'INTEGER NOT NULL DEFAULT 0'],
  ['sellerName', 'TEXT'],
  ['fsboPhone', 'TEXT'],
  ['fsboEmail', 'TEXT'],
  ['daysOnMarket', 'INTEGER'],
  ['priceChanges', 'TEXT'],
  ['propertyTax', 'TEXT'],
  ['photoUrl', 'TEXT'],
  ['sourceUrl', 'TEXT'],
  ['keywords', 'TEXT'],
  ['city', 'TEXT'],
  ['state', 'TEXT'],
  ['listingDescription', 'TEXT'],
];

{
  const existing = new Set(
    db.prepare('PRAGMA table_info(contacts)').all().map((col) => col.name)
  );
  for (const [name, type] of LEAD_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${name} ${type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotent migration — Lead Engine columns (same pattern as LEAD_COLUMNS).
// ---------------------------------------------------------------------------

const LEAD_ENGINE_COLUMNS = [
  ['zip', 'TEXT'],
  ['price', 'REAL'],
  ['zpid', 'TEXT'],
  ['listingDate', 'TEXT'],
  ['grade', 'TEXT'],
  ['importDate', 'TEXT'],
  ['dateFound', 'TEXT'],
  ['propertyType', 'TEXT'],
];

{
  const existing = new Set(
    db.prepare('PRAGMA table_info(contacts)').all().map((col) => col.name)
  );
  for (const [name, type] of LEAD_ENGINE_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${name} ${type}`);
    }
  }
}

// Fast dedupe lookups for the Lead Engine sync.
db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_zpid ON contacts(zpid)');

// ---------------------------------------------------------------------------
// Idempotent migration — lead status / triage columns (same pattern as the
// LEAD_ENGINE_COLUMNS block above).
// ---------------------------------------------------------------------------

const LEAD_STATUS_COLUMNS = [
  ['lead_status', 'TEXT'],                       // 'NEW' | 'IN QUEUE' | 'WORKING'
  ['opened', 'INTEGER NOT NULL DEFAULT 0'],
  ['opened_at', 'TEXT'],
  ['called', 'INTEGER NOT NULL DEFAULT 0'],
  ['imported_at', 'TEXT'],                       // first import timestamp
  ['updated_from_sheet_at', 'TEXT'],             // last time the sheet changed this lead
  ['change_log', 'TEXT'],                        // append-only dated lines of what changed
];

{
  const existing = new Set(
    db.prepare('PRAGMA table_info(contacts)').all().map((col) => col.name)
  );
  for (const [name, type] of LEAD_STATUS_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${name} ${type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotent migration — Keep-as-NEW lock (same pattern as the blocks above).
// status_locked=1 means NO automatic process may change this lead's
// lead_status: sync aging, the open transition and call/RVM transitions all
// skip it. Admins toggle it via PATCH /api/contacts/:id or bulk-lock.
// ---------------------------------------------------------------------------

{
  const existing = new Set(
    db.prepare('PRAGMA table_info(contacts)').all().map((col) => col.name)
  );
  if (!existing.has('status_locked')) {
    db.exec('ALTER TABLE contacts ADD COLUMN status_locked INTEGER NOT NULL DEFAULT 0');
  }
}

// ---------------------------------------------------------------------------
// Idempotent migration — Google integration (same pattern as the blocks
// above). google_accounts stores per-user OAuth tokens; tasks gain the ids
// of their synced Google Task / Calendar event.
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  email         TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  token_expiry  TEXT,
  connected_at  TEXT
)`);

// Per-user Microsoft (Graph) OAuth tokens — same shape as google_accounts.
db.exec(`
CREATE TABLE IF NOT EXISTS microsoft_accounts (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  email         TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  token_expiry  TEXT,
  connected_at  TEXT
)`);

const GOOGLE_TASK_COLUMNS = [
  ['google_task_id', 'TEXT'],
  ['google_event_id', 'TEXT'],
  ['due_time', 'TEXT'],       // optional HH:MM start time (24h) for the task
  ['duration_min', 'INTEGER'], // optional length in minutes (used with due_time)
  ['ms_todo_id', 'TEXT'],     // synced Microsoft To Do task id
  ['ms_event_id', 'TEXT'],    // synced Outlook Calendar event id
];

{
  const existing = new Set(
    db.prepare('PRAGMA table_info(tasks)').all().map((col) => col.name)
  );
  for (const [name, type] of GOOGLE_TASK_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
  }
}

// Activities gain a call duration (seconds) for auto-logged Twilio calls,
// plus read_at for "unlistened voicemail" tracking.
{
  const existing = new Set(
    db.prepare('PRAGMA table_info(activities)').all().map((col) => col.name)
  );
  if (!existing.has('duration_sec')) {
    db.exec('ALTER TABLE activities ADD COLUMN duration_sec INTEGER');
  }
  if (!existing.has('read_at')) {
    db.exec('ALTER TABLE activities ADD COLUMN read_at TEXT');
  }
}

// RVM recordings gain direction (outbound clip vs inbound voicemail) + the
// Twilio recording SID (to match async transcriptions).
{
  const existing = new Set(
    db.prepare('PRAGMA table_info(rvm_recordings)').all().map((col) => col.name)
  );
  if (!existing.has('direction')) {
    db.exec("ALTER TABLE rvm_recordings ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'");
  }
  if (!existing.has('twilio_sid')) {
    db.exec('ALTER TABLE rvm_recordings ADD COLUMN twilio_sid TEXT');
  }
}

// ---------------------------------------------------------------------------
// Idempotent migration — wholesale workflow columns on `contacts`:
//   wholesale_fee       — estimated assignment fee ($)
//   lead_source         — tag for where the lead came from (Manual Upload,
//                         Zillow, or a custom value)
//   offerAcceptedDate   — auto-filled when the stage moves to "Offer Accepted"
//   archived            — 1 = filed away (Dead Deal) and hidden from active views
//   dead_reason         — Did not accept offer | Sold | Other
//   dead_notes          — free-text notes for a dead/archived deal
// ---------------------------------------------------------------------------

const WHOLESALE_COLUMNS = [
  ['wholesale_fee', 'REAL'],
  ['lead_source', 'TEXT'],
  ['offerAcceptedDate', 'TEXT'],
  ['archived', 'INTEGER NOT NULL DEFAULT 0'],
  ['dead_reason', 'TEXT'],
  ['dead_notes', 'TEXT'],
];

{
  const existing = new Set(
    db.prepare('PRAGMA table_info(contacts)').all().map((col) => col.name)
  );
  for (const [name, type] of WHOLESALE_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${name} ${type}`);
    }
  }
}

// One-time stage remap: move any legacy stage names to the new set.
{
  const upd = db.prepare('UPDATE contacts SET stage = ? WHERE stage = ?');
  for (const [oldName, newName] of Object.entries(STAGE_REMAP)) {
    try { upd.run(newName, oldName); } catch (e) { /* ignore */ }
  }
  // Any contact currently on the "Dead Deal" stage should also be archived.
  try { db.exec("UPDATE contacts SET archived = 1 WHERE stage = 'Dead Deal'"); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Idempotent migration — per-user security & account columns.
//   password_enc          — AES-encrypted copy of the password so an admin can
//                           reveal it (per product decision). Login still uses
//                           the bcrypt password_hash; this is never used to auth.
//   totp_secret           — base32 TOTP secret (2FA). Present but not yet
//                           confirmed until totp_enabled = 1.
//   totp_enabled          — 1 once the user has verified a code.
//   vm_greeting_text      — this user's own inbound voicemail greeting (spoken).
//   vm_greeting_recording_id — id of this user's recorded greeting clip.
// ---------------------------------------------------------------------------

const USER_SECURITY_COLUMNS = [
  ['password_enc', 'TEXT'],
  ['totp_secret', 'TEXT'],
  ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['vm_greeting_text', 'TEXT'],
  ['vm_greeting_recording_id', 'TEXT'],
  ['timezone', "TEXT NOT NULL DEFAULT 'America/New_York'"], // each user's own tz
  ['sending_number', 'TEXT'], // this user's own Twilio number (E.164) for texts + calls
];

// tasks gain a `reminded` flag so timed-task push reminders only fire once.
{
  const existing = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));
  if (!existing.has('reminded')) db.exec('ALTER TABLE tasks ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0');
}

{
  const existing = new Set(
    db.prepare('PRAGMA table_info(users)').all().map((col) => col.name)
  );
  for (const [name, type] of USER_SECURITY_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reversible encryption (AES-256-GCM) for the admin-viewable password copy.
// Key is derived from APP_SECRET (falls back to JWT_SECRET, then a constant so
// dev still works). Format stored: "v1:<iv_hex>:<tag_hex>:<cipher_hex>".
// ---------------------------------------------------------------------------

const ENC_KEY = crypto
  .createHash('sha256')
  .update(String(process.env.APP_SECRET || process.env.JWT_SECRET || 'deal-flow-pro-dev-secret'))
  .digest(); // 32 bytes

/** encryptSecret(plain) -> string token (or null for empty input). */
function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

/** decryptSecret(token) -> plaintext string, or null if unset/undecryptable. */
function decryptSecret(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const data = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings — simple key/value store (Lead Engine auto-import config, etc.).
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
)`);

/** getSetting(key) -> string | null */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
  return row ? row.value : null;
}

/** setSetting(key, value) — upsert; value is stored as TEXT (null clears). */
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updated_at)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run({
    key: String(key),
    value: value === null || value === undefined ? null : String(value),
    updated_at: now(),
  });
}

// ---------------------------------------------------------------------------
// Seed demo data (only if users table is empty)
// ---------------------------------------------------------------------------

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return; // already seeded

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, password_hash, password_enc, role, business_number, active, created_at)
    VALUES (@id, @name, @email, @password_hash, @password_enc, @role, @business_number, 1, @created_at)
  `);

  const insertContact = db.prepare(`
    INSERT INTO contacts (
      id, owner_id, name, email, phone, property, zillow,
      agentName, agentPhone, agentEmail, stage, notes, source,
      texts, textStatus, rvm, rvmStatus, created_at, updated_at
    ) VALUES (
      @id, @owner_id, @name, @email, @phone, @property, @zillow,
      @agentName, @agentPhone, @agentEmail, @stage, @notes, @source,
      @texts, @textStatus, @rvm, 0, @created_at, @updated_at
    )
  `);

  const insertActivity = db.prepare(`
    INSERT INTO activities (id, contact_id, owner_id, type, mode, direction, body, status, created_by, created_at)
    VALUES (@id, @contact_id, @owner_id, @type, @mode, @direction, @body, @status, @created_by, @created_at)
  `);

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, owner_id, title, due_date, done, contact_id, created_at)
    VALUES (@id, @owner_id, @title, @due_date, 0, @contact_id, @created_at)
  `);

  const ts = now();

  db.transaction(() => {
    // --- Users -----------------------------------------------------------
    const adminId = uid();
    insertUser.run({
      id: adminId,
      name: 'Admin',
      email: 'admin@demo.com',
      password_hash: bcrypt.hashSync('admin123', 10),
      password_enc: encryptSecret('admin123'),
      role: 'admin',
      business_number: null,
      created_at: ts,
    });

    const marisaId = uid();
    insertUser.run({
      id: marisaId,
      name: 'Marisa',
      email: 'marisa@demo.com',
      password_hash: bcrypt.hashSync('demo123', 10),
      password_enc: encryptSecret('demo123'),
      role: 'user',
      business_number: null,
      created_at: ts,
    });

    const repId = uid();
    insertUser.run({
      id: repId,
      name: 'Sample Rep',
      email: 'rep@demo.com',
      password_hash: bcrypt.hashSync('demo123', 10),
      password_enc: encryptSecret('demo123'),
      role: 'user',
      business_number: null,
      created_at: ts,
    });

    // --- Marisa's sample contact ------------------------------------------
    const johnId = uid();
    insertContact.run({
      id: johnId,
      owner_id: marisaId,
      name: 'John Seller',
      email: null,
      phone: '555-201-3344',
      property: '123 Maple St, Dallas, TX 75201',
      zillow: 'https://www.zillow.com/homedetails/123-Maple-St',
      agentName: null,
      agentPhone: null,
      agentEmail: null,
      stage: 'Offer Sent',
      notes: 'Motivated seller — relocating for work.',
      source: 'Zillow',
      texts: JSON.stringify(DEFAULT_TEXTS),
      textStatus: JSON.stringify([false, false, false, false]),
      rvm: DEFAULT_RVM,
      created_at: ts,
      updated_at: ts,
    });

    insertActivity.run({
      id: uid(),
      contact_id: johnId,
      owner_id: marisaId,
      type: 'call',
      mode: 'manual',
      direction: 'outbound',
      body: 'Intro call — John is open to a cash offer, wants to close within 30 days.',
      status: 'completed',
      created_by: marisaId,
      created_at: ts,
    });

    insertTask.run({
      id: uid(),
      owner_id: marisaId,
      title: 'Follow up with John Seller',
      due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      contact_id: johnId,
      created_at: ts,
    });

    // --- Sample Rep's contact (proves tenant isolation) --------------------
    insertContact.run({
      id: uid(),
      owner_id: repId,
      name: 'Rita Owner',
      email: 'rita.owner@example.com',
      phone: '555-887-2210',
      property: '456 Oak Ave, Fort Worth, TX 76102',
      zillow: 'https://www.zillow.com/homedetails/456-Oak-Ave',
      agentName: 'Bill Broker',
      agentPhone: '555-300-1188',
      agentEmail: 'bill.broker@example.com',
      stage: 'New',
      notes: 'FSBO listing — reached out via listing phone number.',
      source: 'Zillow',
      texts: JSON.stringify(DEFAULT_TEXTS),
      textStatus: JSON.stringify([false, false, false, false]),
      rvm: DEFAULT_RVM,
      created_at: ts,
      updated_at: ts,
    });
  })();
}

seed();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  db, uid, now, DATA_DIR, STAGES, DEAD_REASONS, LEAD_SOURCES, DEFAULT_TEXTS, DEFAULT_RVM,
  getSetting, setSetting, encryptSecret, decryptSecret,
};
