/**
 * routes/leadengine.js — Lead Engine: sync real-estate leads from a
 * USER-PROVIDED CSV (a Google Sheets link — edit or published-CSV — or
 * pasted CSV text), grade them A-F, dedupe by ZPID/address, change-track
 * updates, and drop them into the pipeline as Prospect contacts.
 *
 * Lead statuses (triage):
 *   NEW       — just imported, or the sheet changed something on this lead
 *   IN QUEUE  — was NEW on a previous import, still never opened/called
 *   WORKING   — a rep opened the lead detail or logged a call
 *
 * COMPLIANCE: this module NEVER scrapes listing sites (Zillow / Realtor /
 * Homes etc.). The only network call is fetching the CSV URL the user
 * explicitly supplies (a sheet they published or shared themselves).
 *
 * TENANT ISOLATION: every lookup / insert / update below is scoped to the
 * import owner — the requester, the saved import_owner_id (admin-config),
 * or an admin-supplied owner_id (validated).
 */
'use strict';

const express = require('express');
const cron = require('node-cron');
const { db, uid, now, DEFAULT_TEXTS, DEFAULT_RVM, getSetting, setSetting } = require('../db');
const { isAdmin } = require('./helpers');
const { computeGrade } = require('../grade');
const scheduler = require('../scheduler');

const router = express.Router();

// --------------------------- CSV parsing (RFC-4180) ------------------------

/**
 * parseCsv(text) -> string[][]
 * Character-by-character parser: handles quoted fields containing commas,
 * escaped quotes ("") and newlines inside quotes. No external libraries.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop rows that are entirely empty.
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// --------------------------- Sheet URL normalization ------------------------

/**
 * normalizeSheetUrl(url) — convert a Google Sheets EDIT url like
 *   https://docs.google.com/spreadsheets/d/<ID>/edit?gid=<GID>#gid=<GID>
 * into its CSV export form:
 *   https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>
 * Published-CSV links and plain CSV urls are returned unchanged.
 */
function normalizeSheetUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/(?:edit|view)\b/i);
  if (!m) return s; // already a published-CSV / export / plain CSV url
  const gid = (s.match(/[?#&]gid=(\d+)/) || [])[1];
  return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/export?format=csv' +
    (gid ? '&gid=' + gid : '');
}

// --------------------------- Column mapping --------------------------------

/** Sheet header (trimmed, lower-cased) -> lead field. */
const HEADER_MAP = {
  'address': 'property',
  'city': 'city',
  'state': 'state',
  'zip': 'zip',
  'listing price': 'price',
  'beds': 'beds',
  'baths': 'baths',
  'sq ft': 'sqft',
  'sqft': 'sqft',
  'property type': 'propertyType',
  'days on market': 'daysOnMarket',
  'listing date': 'listingDate',
  'listing agent': 'agentName',
  'agent phone': 'agentPhone',
  'agent email': 'agentEmail',
  'brokerage': 'agentCompany',
  'fsbo': 'isFsbo',
  'keyword found': 'keywords',
  'source': 'csvSource',
  'listing url': 'sourceUrl',
  'zpid': 'zpid',
  'notes': 'listingDescription',
  'price updated': 'priceUpdated',
  'price change': 'priceChanges',
  'import date': 'importDate',
  'date found': 'dateFound',
  // --- Zillow export aliases (headers normalized: units in "(...)" stripped) ---
  'street address': 'property',
  'property price': 'price',
  'bedrooms': 'beds',
  'bathrooms': 'baths',
  'living area': 'sqft',
  'number of days on zillow': 'daysOnMarket',
  'date listed': 'listingDate',
  'property url': 'sourceUrl',
  'listing description': 'listingDescription',
  'price cut amount': '_priceCutAmt',
  'price cut date': '_priceCutDate',
  'price was cut': '_priceWasCut',
};

/** '$34,000' -> 34000; '' -> null (node:sqlite rejects NaN). */
function toNum(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Trimmed string or null. */
function str(v) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s === '' ? null : s;
}

/** Map one CSV data row (per the normalized header row) to a lead object. */
function mapRow(headers, cells) {
  const raw = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP[h];
    if (key) raw[key] = cells[i] !== undefined ? String(cells[i]).trim() : '';
  });

  const lead = {};
  lead.property = str(raw.property);
  lead.city = str(raw.city);
  lead.state = str(raw.state);
  lead.zip = str(raw.zip);
  lead.price = toNum(raw.price);
  lead.beds = toNum(raw.beds);
  lead.baths = toNum(raw.baths);
  lead.sqft = toNum(raw.sqft);
  lead.propertyType = str(raw.propertyType);

  let dom = toNum(raw.daysOnMarket);
  if (dom !== null && dom < 0) dom = null; // "-1" sentinel => treat as blank
  lead.daysOnMarket = dom;

  lead.listingDate = str(raw.listingDate);
  lead.agentName = str(raw.agentName);
  lead.agentPhone = str(raw.agentPhone);
  lead.agentEmail = str(raw.agentEmail);
  lead.agentCompany = str(raw.agentCompany);
  lead.isFsbo = /^(yes|true|1)$/i.test(String(raw.isFsbo || '').trim()) ? 1 : 0;
  lead.keywords = str(raw.keywords);
  lead.sourceUrl = str(raw.sourceUrl);
  lead.zillow = lead.sourceUrl; // Listing URL feeds both fields
  lead.zpid = str(raw.zpid);
  // Zillow listing URLs contain the zpid (…/<zpid>_zpid/) — derive it if not given.
  if (!lead.zpid && lead.sourceUrl) {
    const zm = lead.sourceUrl.match(/(\d+)_zpid/);
    if (zm) lead.zpid = zm[1];
  }
  lead.listingDescription = str(raw.listingDescription);
  lead.importDate = str(raw.importDate);
  lead.dateFound = str(raw.dateFound);

  // Price Change text; keep the "Price Updated" date as a note on it.
  let pc = str(raw.priceChanges);
  const pu = str(raw.priceUpdated);
  if (pu) pc = pc ? pc + ' (price updated ' + pu + ')' : '(price updated ' + pu + ')';
  // Zillow price-cut columns → a price-change note (motivated-seller signal).
  const cutAmt = str(raw._priceCutAmt);
  if (cutAmt) {
    const cutDate = str(raw._priceCutDate);
    const note = 'Price cut $' + String(cutAmt).replace(/[$,]/g, '') + (cutDate ? ' on ' + cutDate : '');
    pc = pc ? pc + '; ' + note : note;
  }
  lead.priceChanges = pc;

  // Display name: agent > FSBO owner > Unknown.
  lead.name = lead.agentName || (lead.isFsbo ? 'Owner (FSBO)' : 'Unknown');
  return lead;
}

// --------------------------- Change tracking --------------------------------

/** Fields compared between the stored lead and the incoming sheet row. */
const CHANGE_FIELDS = [
  ['price', 'Price'],
  ['daysOnMarket', 'Days on Market'],
  ['agentName', 'Agent'],
  ['agentPhone', 'Agent Phone'],
  ['agentEmail', 'Agent Email'],
  ['agentCompany', 'Agent Company'],
  ['keywords', 'Keywords'],
  ['priceChanges', 'Price Changes'],
  ['beds', 'Beds'],
  ['baths', 'Baths'],
  ['sqft', 'Sqft'],
];

const NUMERIC_CHANGE_FIELDS = ['price', 'daysOnMarket', 'beds', 'baths', 'sqft'];

/** Normalized comparison value (numbers compared numerically, blanks equal). */
function cmpVal(field, v) {
  if (v === undefined || v === null) return '';
  if (NUMERIC_CHANGE_FIELDS.indexOf(field) !== -1) {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : '';
  }
  return String(v).trim();
}

/** Human-readable value for change_log lines ($-formatted for price). */
function fmtChangeVal(field, v) {
  if (v === undefined || v === null || String(v).trim() === '') return '(blank)';
  if (field === 'price') {
    const n = Number(v);
    if (Number.isFinite(n)) return '$' + n.toLocaleString('en-US');
  }
  return String(v);
}

/** Today as M/D/YYYY for change_log stamps. */
function stampMDY() {
  const d = new Date();
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
}

/** diffLead(existing, lead) -> ["[M/D/YYYY] Price: $42,000 -> $22,500", ...] */
function diffLead(existing, lead) {
  const lines = [];
  for (const [field, label] of CHANGE_FIELDS) {
    if (cmpVal(field, existing[field]) !== cmpVal(field, lead[field])) {
      lines.push(
        '[' + stampMDY() + '] ' + label + ': ' +
        fmtChangeVal(field, existing[field]) + ' -> ' + fmtChangeVal(field, lead[field])
      );
    }
  }
  return lines;
}

// --------------------------- Prepared statements ----------------------------

const findByZpid = db.prepare(
  'SELECT * FROM contacts WHERE owner_id = @owner_id AND zpid = @zpid'
);
const findByProperty = db.prepare(
  'SELECT * FROM contacts WHERE owner_id = @owner_id AND property = @property COLLATE NOCASE'
);

const insertLead = db.prepare(`
  INSERT INTO contacts (
    id, owner_id, name, stage, notes, source,
    property, zillow, city, state, zip, price, beds, baths, sqft,
    propertyType, daysOnMarket, listingDate,
    agentName, agentPhone, agentEmail, agentCompany, isFsbo,
    keywords, sourceUrl, zpid, listingDescription, priceChanges,
    importDate, dateFound, grade,
    lead_status, opened, called, imported_at,
    dnc, consent_sms, consent_rvm, texts, textStatus, rvm, rvmStatus,
    created_at, updated_at
  ) VALUES (
    @id, @owner_id, @name, @stage, @notes, @source,
    @property, @zillow, @city, @state, @zip, @price, @beds, @baths, @sqft,
    @propertyType, @daysOnMarket, @listingDate,
    @agentName, @agentPhone, @agentEmail, @agentCompany, @isFsbo,
    @keywords, @sourceUrl, @zpid, @listingDescription, @priceChanges,
    @importDate, @dateFound, @grade,
    'NEW', 0, 0, @imported_at,
    0, 0, 0, @texts, @textStatus, @rvm, 0,
    @created_at, @updated_at
  )
`);

/* PRESERVES stage, notes, name, owner and opened/called flags — refreshes
   listing data + grade, resets triage status to NEW and appends change_log. */
const updateLead = db.prepare(`
  UPDATE contacts SET
    property = @property, zillow = @zillow, city = @city, state = @state,
    zip = @zip, price = @price, beds = @beds, baths = @baths, sqft = @sqft,
    propertyType = @propertyType, daysOnMarket = @daysOnMarket,
    listingDate = @listingDate,
    agentName = @agentName, agentPhone = @agentPhone,
    agentEmail = @agentEmail, agentCompany = @agentCompany, isFsbo = @isFsbo,
    keywords = @keywords, sourceUrl = @sourceUrl, zpid = @zpid,
    priceChanges = @priceChanges, importDate = @importDate,
    dateFound = @dateFound, grade = @grade,
    lead_status = CASE WHEN status_locked = 1 THEN lead_status ELSE 'NEW' END,
    updated_from_sheet_at = @updated_from_sheet_at,
    change_log = @change_log, updated_at = @updated_at
  WHERE id = @id
`);

const insertNoteActivity = db.prepare(`
  INSERT INTO activities (id, contact_id, owner_id, type, mode, direction, body, status, created_by, created_at)
  VALUES (@id, @contact_id, @owner_id, 'note', 'automated', 'outbound', @body, 'ok', @created_by, @created_at)
`);

// --------------------------- Core sync -------------------------------------

/** Error helper carrying an HTTP status for the route handler. */
function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

/**
 * syncFromCsv({ csvText?, csvUrl?, ownerId }) -> {
 *   inserted, updated, unchanged, queued, total, errors
 * }
 *
 * Shared by POST /api/leadengine/sync and the cron auto-import (scheduler.js).
 *   - NEW rows insert as lead_status='NEW' (imported_at = now).
 *   - EXISTING rows are diffed field-by-field; changes keep the new value,
 *     append dated lines to change_log, reset lead_status to 'NEW', stamp
 *     updated_from_sheet_at, recompute the grade and log a 'note' activity.
 *     Unchanged rows are left completely alone.
 *   - After the row loop the queue is aged: still-NEW leads that were NOT
 *     touched this run and were never opened/called become 'IN QUEUE'.
 */
async function syncFromCsv({ csvText, csvUrl, ownerId }) {
  if (!ownerId) throw httpError(400, 'No import owner available');

  // CSV text comes from the user's sheet URL or pasted text — never scraped.
  let text = typeof csvText === 'string' ? csvText : '';
  if (csvUrl && String(csvUrl).trim()) {
    const rawUrl = String(csvUrl).trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      throw httpError(400, 'csvUrl must start with http:// or https://');
    }
    const url = normalizeSheetUrl(rawUrl); // edit link -> CSV export link
    let resp;
    try {
      resp = await fetch(url, { redirect: 'follow' });
    } catch (e) {
      throw httpError(400, 'Could not fetch CSV URL: ' + (e && e.message ? e.message : 'network error'));
    }
    if (!resp.ok) {
      throw httpError(400, 'Could not fetch CSV URL (HTTP ' + resp.status +
        '). Publish the sheet to the web as CSV, or share it as "anyone with link can view".');
    }
    text = await resp.text();
    setSetting('leadengine_csv_url', rawUrl); // remember for the daily auto-import
  }
  if (!text.trim()) {
    throw httpError(400, 'Provide csvUrl (Google Sheet link) or csvText (pasted CSV)');
  }

  const table = parseCsv(text);
  if (table.length < 2) {
    throw httpError(400, 'CSV needs a header row plus at least one data row');
  }
  // Normalize headers: lower-case, drop parenthetical units like "(USD)" /
  // "(MM/DD/YYYY)", collapse spaces — so Zillow-style headers map cleanly.
  const headers = table[0].map((h) =>
    String(h).trim().toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim());
  if (!headers.some((h) => HEADER_MAP[h])) {
    throw httpError(400, 'No recognized columns in the CSV header row');
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let queued = 0;
  const errors = [];
  const touched = []; // lead ids inserted or updated this run

  const runBatch = db.transaction(() => {
    for (let r = 1; r < table.length; r++) {
      try {
        const lead = mapRow(headers, table[r]);
        if (!lead.property && !lead.zpid) {
          errors.push('Row ' + (r + 1) + ': no Address or ZPID — skipped');
          continue;
        }

        // Dedupe within this owner: zpid preferred, then property address.
        let existing = null;
        if (lead.zpid) existing = findByZpid.get({ owner_id: ownerId, zpid: lead.zpid });
        if (!existing && lead.property) {
          existing = findByProperty.get({ owner_id: ownerId, property: lead.property });
        }

        const { grade } = computeGrade(lead); // price-drop detection included
        const ts = now();

        if (existing) {
          const changes = diffLead(existing, lead);
          if (changes.length === 0) {
            unchanged++; // nothing changed: do NOT touch the lead at all
            continue;
          }
          const changeLog = (existing.change_log ? existing.change_log + '\n' : '') + changes.join('\n');
          updateLead.run({
            id: existing.id,
            property: lead.property || existing.property,
            zillow: lead.zillow || existing.zillow,
            city: lead.city, state: lead.state, zip: lead.zip,
            price: lead.price, beds: lead.beds, baths: lead.baths, sqft: lead.sqft,
            propertyType: lead.propertyType, daysOnMarket: lead.daysOnMarket,
            listingDate: lead.listingDate,
            agentName: lead.agentName, agentPhone: lead.agentPhone,
            agentEmail: lead.agentEmail, agentCompany: lead.agentCompany,
            isFsbo: lead.isFsbo,
            keywords: lead.keywords, sourceUrl: lead.sourceUrl,
            zpid: lead.zpid || existing.zpid,
            priceChanges: lead.priceChanges,
            importDate: lead.importDate, dateFound: lead.dateFound,
            grade,
            updated_from_sheet_at: ts,
            change_log: changeLog,
            updated_at: ts,
          });
          insertNoteActivity.run({
            id: uid(),
            contact_id: existing.id,
            owner_id: existing.owner_id,
            body: changes.join('\n'),
            created_by: ownerId,
            created_at: ts,
          });
          updated++;
          touched.push(existing.id);
        } else {
          const id = uid();
          insertLead.run({
            id,
            owner_id: ownerId,
            name: lead.name,
            stage: 'Prospect',
            notes: null,
            source: 'Lead Engine',
            property: lead.property, zillow: lead.zillow,
            city: lead.city, state: lead.state, zip: lead.zip,
            price: lead.price, beds: lead.beds, baths: lead.baths, sqft: lead.sqft,
            propertyType: lead.propertyType, daysOnMarket: lead.daysOnMarket,
            listingDate: lead.listingDate,
            agentName: lead.agentName, agentPhone: lead.agentPhone,
            agentEmail: lead.agentEmail, agentCompany: lead.agentCompany,
            isFsbo: lead.isFsbo,
            keywords: lead.keywords, sourceUrl: lead.sourceUrl, zpid: lead.zpid,
            listingDescription: lead.listingDescription,
            priceChanges: lead.priceChanges,
            importDate: lead.importDate, dateFound: lead.dateFound,
            grade,
            imported_at: ts,
            texts: JSON.stringify(DEFAULT_TEXTS),
            textStatus: JSON.stringify([false, false, false, false]),
            rvm: DEFAULT_RVM,
            created_at: ts,
            updated_at: ts,
          });
          inserted++;
          touched.push(id);
        }
      } catch (e) {
        errors.push('Row ' + (r + 1) + ': ' + (e && e.message ? e.message : String(e)));
      }
    }

    // Age the queue: leads that were NEW before this run, were NOT in this
    // run's touched set, and were never opened/called become 'IN QUEUE'.
    // ISOLATION: scoped to this import owner.
    const ts = now();
    const notIn = touched.length
      ? ' AND id NOT IN (' + touched.map(() => '?').join(',') + ')'
      : '';
    const aged = db.prepare(
      "UPDATE contacts SET lead_status = 'IN QUEUE', updated_at = ? " +
      "WHERE source = 'Lead Engine' AND lead_status = 'NEW' " +
      'AND opened = 0 AND called = 0 AND status_locked = 0 AND owner_id = ?' + notIn
    ).run(ts, ownerId, ...touched);
    queued = Number(aged.changes) || 0;
  });

  runBatch();

  const result = { inserted, updated, unchanged, queued, total: table.length - 1, errors };
  setSetting('last_import_at', now());
  setSetting('last_import_counts', JSON.stringify({
    inserted, updated, unchanged, queued, total: result.total, errorCount: errors.length,
  }));
  return result;
}

// --------------------------- Sync endpoint ---------------------------------

/**
 * POST /api/leadengine/sync { csvUrl?, csvText?, owner_id? (admin only) }
 * Returns { inserted, updated, unchanged, queued, total, errors }.
 */
router.post('/sync', async (req, res) => {
  const body = req.body || {};

  // ISOLATION: new leads are owned by the requester. Admins may configure a
  // default import owner (settings.import_owner_id) or pass owner_id
  // explicitly; non-admins always import into their own pool.
  let ownerId = req.user.id;
  if (isAdmin(req.user)) {
    const savedOwner = getSetting('import_owner_id');
    if (savedOwner) {
      const target = db.prepare('SELECT id FROM users WHERE id = ?').get(String(savedOwner));
      if (target) ownerId = target.id;
    }
    if (body.owner_id) {
      const target = db.prepare('SELECT id FROM users WHERE id = ?').get(String(body.owner_id));
      if (!target) return res.status(400).json({ error: 'owner_id does not exist' });
      ownerId = target.id;
    }
  }

  try {
    const out = await syncFromCsv({ csvText: body.csvText, csvUrl: body.csvUrl, ownerId });
    res.json(out);
  } catch (e) {
    res.status(e.statusCode || 500).json({
      error: (e.statusCode ? '' : 'Sync failed: ') + (e && e.message ? e.message : String(e)),
    });
  }
});

// --------------------------- Settings endpoints ----------------------------

function settingsPayload() {
  let lastCounts = null;
  try { lastCounts = JSON.parse(getSetting('last_import_counts') || 'null'); }
  catch (e) { lastCounts = null; }
  return {
    csvUrl: getSetting('leadengine_csv_url') || '',
    cron: getSetting('leadengine_cron') || scheduler.DEFAULT_CRON,
    autoimport: getSetting('leadengine_autoimport') || 'off',
    lastImportAt: getSetting('last_import_at') || null,
    lastCounts,
    importOwnerId: getSetting('import_owner_id') || null,
  };
}

/** GET /api/leadengine/settings (admin only). */
router.get('/settings', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  res.json(settingsPayload());
});

/**
 * POST /api/leadengine/settings {csvUrl?, cron?, autoimport?, importOwnerId?}
 * (admin only) — saves and reschedules the auto-import live.
 */
router.post('/settings', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  const body = req.body || {};

  if ('csvUrl' in body) {
    const u = String(body.csvUrl || '').trim();
    if (u && !/^https?:\/\//i.test(u)) {
      return res.status(400).json({ error: 'csvUrl must start with http:// or https://' });
    }
    setSetting('leadengine_csv_url', u || null);
  }
  if ('cron' in body) {
    const spec = String(body.cron || '').trim() || scheduler.DEFAULT_CRON;
    if (!cron.validate(spec)) {
      return res.status(400).json({ error: 'Invalid cron expression: ' + spec });
    }
    setSetting('leadengine_cron', spec);
  }
  if ('autoimport' in body) {
    const on = body.autoimport === 'on' || body.autoimport === true || body.autoimport === 1 || body.autoimport === '1';
    setSetting('leadengine_autoimport', on ? 'on' : 'off');
  }
  if ('importOwnerId' in body) {
    const v = String(body.importOwnerId || '').trim();
    if (v) {
      // Daily auto-import may ONLY feed an admin's pool — reps get their leads
      // by uploading their own CSV instead.
      const target = db.prepare("SELECT id, role FROM users WHERE id = ?").get(v);
      if (!target) return res.status(400).json({ error: 'importOwnerId does not exist' });
      if (target.role !== 'admin') {
        return res.status(400).json({ error: 'The daily auto-import can only be assigned to an admin' });
      }
      setSetting('import_owner_id', target.id);
    } else {
      setSetting('import_owner_id', null);
    }
  }

  scheduler.reschedule(); // apply the new schedule live
  res.json(settingsPayload());
});

// --------------------------- Per-user CSV upload ---------------------------

// Canonical template columns (friendly headers that HEADER_MAP recognizes),
// with one example row so users know exactly what to paste in each column.
const TEMPLATE_HEADERS = [
  'Address', 'City', 'State', 'Zip', 'Listing Price', 'Beds', 'Baths', 'Sq Ft',
  'Property Type', 'Days on Market', 'Listing Date', 'Listing Agent',
  'Agent Phone', 'Agent Email', 'Brokerage', 'FSBO', 'Keyword Found',
  'Source', 'Listing URL', 'ZPID', 'Notes',
];
const TEMPLATE_EXAMPLE = [
  '123 Maple St', 'Dallas', 'TX', '75201', '285000', '3', '2', '1650',
  'Single Family', '84', '2026-05-01', 'Jane Agent', '555-201-3344',
  'jane@brokerage.com', 'Acme Realty', 'No', 'motivated seller',
  'Zillow', 'https://www.zillow.com/homedetails/123-Maple-St', '', 'Vacant, needs work',
];

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

/** GET /api/leadengine/template.csv — downloadable blank template + example. */
router.get('/template.csv', (req, res) => {
  const csv = TEMPLATE_HEADERS.map(csvCell).join(',') + '\r\n' +
              TEMPLATE_EXAMPLE.map(csvCell).join(',') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="Deal-Flow-Pro-lead-template.csv"');
  res.send(csv);
});

/**
 * POST /api/leadengine/upload {csvText} — import a user's OWN CSV of leads.
 * Available to every user; leads are always assigned to the uploader (never
 * anyone else) and are visible only to that user and the admin. Does NOT touch
 * the global daily-import settings.
 */
router.post('/upload', async (req, res) => {
  const csvText = (req.body || {}).csvText;
  if (!csvText || !String(csvText).trim()) {
    return res.status(400).json({ error: 'Paste CSV text or upload a .csv file first' });
  }
  try {
    const out = await syncFromCsv({ csvText: String(csvText), ownerId: req.user.id });
    res.json(out);
  } catch (e) {
    res.status(e.statusCode || 500).json({
      error: (e.statusCode ? '' : 'Import failed: ') + (e && e.message ? e.message : String(e)),
    });
  }
});

module.exports = router;
module.exports.syncFromCsv = syncFromCsv;
module.exports.normalizeSheetUrl = normalizeSheetUrl;
module.exports.parseCsv = parseCsv;
