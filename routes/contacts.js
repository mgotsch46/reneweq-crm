/**
 * routes/contacts.js — contacts, per-contact activities, and messaging actions.
 * All routes here run behind requireAuth (mounted in server.js).
 *
 * TENANT ISOLATION: every query below scopes by owner via ownerScope()/
 * canTouch() from ./helpers — non-admins only ever see or mutate their own
 * rows. See routes/helpers.js for the boundary definition.
 */
'use strict';

const express = require('express');
const { db, uid, now, STAGES, DEFAULT_TEXTS, DEFAULT_RVM } = require('../db');
const { sendSms, sendRvm } = require('../integrations');
const { isAdmin, ownerScope, canTouch, renderTemplate, parseContact } = require('./helpers');

const router = express.Router();

/** Fields a client may set on a contact (owner_id deliberately excluded for non-admins). */
const CONTACT_FIELDS = [
  'name', 'email', 'phone', 'property', 'zillow',
  'agentName', 'agentPhone', 'agentEmail', 'stage', 'notes',
  'executedContract', 'closing', 'dueDiligence', 'inspectionExpires',
  'source', 'dnc', 'consent_sms', 'consent_rvm', 'texts', 'textStatus',
  'rvm', 'rvmStatus',
  // Real-estate lead fields
  'beds', 'baths', 'sqft', 'agentCompany', 'isFsbo', 'sellerName',
  'fsboPhone', 'fsboEmail', 'daysOnMarket', 'priceChanges', 'propertyTax',
  'photoUrl', 'sourceUrl', 'keywords', 'city', 'state', 'listingDescription',
  // Lead Engine fields
  'zip', 'price', 'zpid', 'listingDate', 'grade', 'importDate', 'dateFound',
  'propertyType', 'lead_status', 'status_locked',
  // Wholesale workflow fields
  'wholesale_fee', 'lead_source', 'offerAcceptedDate', 'archived',
  'dead_reason', 'dead_notes',
  // Deal price fields (List Price reuses `price` above)
  'offerPrice', 'finalPrice', 'suggestedOffer',
  // Contact classification (agent / fsbo / colleague / title / bog)
  'contact_type',
];

/** Lead Engine triage statuses. */
const LEAD_STATUSES = ['NEW', 'IN QUEUE', 'WORKING'];

const NUMERIC_FIELDS = ['beds', 'baths', 'sqft', 'daysOnMarket', 'price', 'wholesale_fee', 'offerPrice', 'finalPrice', 'suggestedOffer'];
const BOOL_FIELDS = ['dnc', 'consent_sms', 'consent_rvm', 'rvmStatus', 'isFsbo', 'status_locked', 'archived'];

/** Coerce loose client input to a number or null (node:sqlite rejects '' / NaN). */
function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce loose client input to 0/1 (node:sqlite rejects JS booleans). */
function toBit(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

/** Load a contact ONLY if the requester is allowed to touch it (else null). */
function getOwnedContact(id, user) {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  return canTouch(user, row) ? row : null; // isolation check
}

function logActivity({ contact, user, type, mode, direction, body, status, provider_id, duration_sec }) {
  const dur = parseInt(duration_sec, 10);
  const act = {
    id: uid(),
    contact_id: contact.id,
    owner_id: contact.owner_id,
    type,
    mode: mode || 'manual',
    direction: direction || 'outbound',
    body: body || null,
    status: status || null,
    provider_id: provider_id || null,
    duration_sec: Number.isFinite(dur) && dur >= 0 ? dur : null,
    created_by: user.id,
    created_at: now(),
  };
  db.prepare(`
    INSERT INTO activities (id, contact_id, owner_id, type, mode, direction, body, status, provider_id, duration_sec, created_by, created_at)
    VALUES (@id, @contact_id, @owner_id, @type, @mode, @direction, @body, @status, @provider_id, @duration_sec, @created_by, @created_at)
  `).run(act);
  return act;
}

/**
 * A call went out to this contact (logged call, manual call path, or RVM
 * drop): set called=1 and move Lead Engine leads out of the NEW / IN QUEUE
 * triage state into WORKING.
 */
function markCalled(contact) {
  // Keep-as-NEW lock: record the call, but NEVER auto-change lead_status on
  // a locked lead — it keeps whatever status the admin pinned.
  if (contact.status_locked) {
    db.prepare('UPDATE contacts SET called = 1, updated_at = ? WHERE id = ?')
      .run(now(), contact.id);
    return;
  }
  if (contact.source === 'Lead Engine' || contact.lead_status) {
    db.prepare(
      "UPDATE contacts SET called = 1, lead_status = 'WORKING', updated_at = ? WHERE id = ?"
    ).run(now(), contact.id);
  } else {
    db.prepare('UPDATE contacts SET called = 1, updated_at = ? WHERE id = ?')
      .run(now(), contact.id);
  }
}

// ---------------------------------------------------------------------------
// Contacts CRUD
// ---------------------------------------------------------------------------

/**
 * GET /api/contacts — own contacts; admin sees all (with owner name).
 * Optional query-string filters (all AND-combined, still owner-scoped):
 *   q      case-insensitive LIKE across name/property/city/keywords/agentName/sellerName
 *   city   LIKE city
 *   state  exact-ish (case-insensitive) state
 *   agent  LIKE agentName
 *   fsbo   'true' | 'false' → isFsbo = 1 | 0
 *   stage  exact pipeline stage
 */
router.get('/', (req, res) => {
  const s = ownerScope(req.user, 'c'); // ISOLATION: owner filter
  const where = [];
  const params = [];
  if (s.where) {
    where.push(s.where.replace(/^WHERE\s+/, ''));
    params.push(...s.params);
  }

  const qp = req.query || {};

  // ADMIN LEAD VIEW: admins see everyone by default, but can narrow the view.
  //   ?owner=<userId>  → only that user's leads
  //   ?mine=true       → only the admin's own leads
  // (Non-admins are already hard-scoped to themselves above; these are ignored.)
  if (isAdmin(req.user)) {
    if (qp.mine === 'true' || qp.mine === '1') {
      where.push('c.owner_id = ?'); params.push(req.user.id);
    } else if (qp.owner) {
      where.push('c.owner_id = ?'); params.push(String(qp.owner));
    }
  }
  if (qp.q) {
    const raw = String(qp.q);
    const like = '%' + raw + '%';
    // Address / seller / listing agent / name / city / keywords / phones.
    const textCols = [
      'c.name', 'c.property', 'c.city', 'c.keywords', 'c.agentName',
      'c.sellerName', 'c.agentCompany', 'c.phone', 'c.agentPhone', 'c.fsboPhone',
    ];
    const clauses = textCols.map((col) => `${col} LIKE ? COLLATE NOCASE`);
    const qParams = textCols.map(() => like);
    // Digits-only phone compare: "5552013344" matches "555-201-3344".
    const digits = raw.replace(/\D+/g, '');
    if (digits.length >= 4) {
      const stripped = (col) =>
        `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),'-',''),' ',''),'(',''),')',''),'.',''),'+','')`;
      for (const col of ['c.phone', 'c.agentPhone', 'c.fsboPhone']) {
        clauses.push(`${stripped(col)} LIKE ?`);
        qParams.push('%' + digits + '%');
      }
    }
    where.push('(' + clauses.join(' OR ') + ')');
    params.push(...qParams);
  }
  if (qp.city) { where.push('c.city LIKE ? COLLATE NOCASE'); params.push('%' + String(qp.city) + '%'); }
  if (qp.state) { where.push('c.state LIKE ? COLLATE NOCASE'); params.push(String(qp.state)); }
  if (qp.agent) { where.push('c.agentName LIKE ? COLLATE NOCASE'); params.push('%' + String(qp.agent) + '%'); }
  if (qp.fsbo === 'true' || qp.fsbo === 'false') {
    where.push('c.isFsbo = ?');
    params.push(qp.fsbo === 'true' ? 1 : 0);
  }
  if (qp.stage) { where.push('c.stage = ?'); params.push(String(qp.stage)); }
  if (qp.grade) { where.push('c.grade = ? COLLATE NOCASE'); params.push(String(qp.grade)); }
  if (qp.lead_status) { where.push('c.lead_status = ? COLLATE NOCASE'); params.push(String(qp.lead_status)); }
  if (qp.source) { where.push('c.lead_source = ? COLLATE NOCASE'); params.push(String(qp.source)); }

  // ARCHIVE: dead/archived deals are hidden from active views by default.
  //   (default)          → only active (archived = 0)
  //   ?archived=true     → only the archive (archived = 1)
  //   ?archived=all      → everything
  if (qp.archived === 'true' || qp.archived === '1') {
    where.push('COALESCE(c.archived,0) = 1');
  } else if (qp.archived !== 'all') {
    where.push('COALESCE(c.archived,0) = 0');
  }

  // SORTING: newest (default) | stage (pipeline order) | source (tag) | address
  const stageOrderCase = 'CASE c.stage ' +
    STAGES.map((s, i) => `WHEN '${s.replace(/'/g, "''")}' THEN ${i}`).join(' ') +
    ' ELSE 999 END';
  let orderBy = 'c.created_at DESC';
  if (qp.sort === 'stage') orderBy = stageOrderCase + ' ASC, c.created_at DESC';
  else if (qp.sort === 'source') orderBy = "COALESCE(c.lead_source,'') COLLATE NOCASE ASC, c.created_at DESC";
  else if (qp.sort === 'address') orderBy = "COALESCE(c.property,'') COLLATE NOCASE ASC";
  else if (qp.sort === 'oldest') orderBy = 'c.created_at ASC';

  const rows = db.prepare(`
    SELECT c.*, u.name AS ownerName
    FROM contacts c JOIN users u ON u.id = c.owner_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
  `).all(...params);
  res.json(rows.map(parseContact));
});

/**
 * GET /api/contacts/feed/conversations — unified inbox feed of texts + calls
 * across the requester's contacts (admin sees all), newest first, each row
 * carrying the contact's name/phone/property so the UI can build threads.
 *   ?kind=sms  → texts only    ?kind=call → calls + voicemails only
 */
router.get('/feed/conversations', (req, res) => {
  const s = ownerScope(req.user, 'c');
  const where = [];
  const params = [];
  if (s.where) { where.push(s.where.replace(/^WHERE\s+/, '')); params.push(...s.params); }
  const kind = (req.query || {}).kind;
  if (kind === 'sms') { where.push("a.type = 'sms'"); }
  else if (kind === 'call') { where.push("a.type IN ('call','rvm')"); }
  else { where.push("a.type IN ('sms','call','rvm','email')"); }
  const rows = db.prepare(`
    SELECT a.id, a.contact_id, a.type, a.direction, a.mode, a.body, a.status,
           a.provider_id, a.duration_sec, a.read_at, a.created_at, a.created_by,
           c.name AS contactName, c.phone AS contactPhone, c.property AS contactProperty,
           c.stage AS contactStage
    FROM activities a JOIN contacts c ON c.id = a.contact_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.created_at DESC
    LIMIT 1000
  `).all(...params);
  res.json(rows);
});

/** Build a full contact row object from a request body (all columns present). */
function buildContact(body, ownerId) {
  const ts = now();
  return {
    id: uid(),
    owner_id: ownerId,
    name: body.name,
    email: body.email || null,
    phone: body.phone || null,
    property: body.property || null,
    zillow: body.zillow || null,
    agentName: body.agentName || null,
    agentPhone: body.agentPhone || null,
    agentEmail: body.agentEmail || null,
    stage: body.stage || 'New',
    notes: body.notes || null,
    executedContract: body.executedContract || null,
    closing: body.closing || null,
    dueDiligence: body.dueDiligence || null,
    inspectionExpires: body.inspectionExpires || null,
    source: body.source || null,
    dnc: toBit(body.dnc),
    consent_sms: toBit(body.consent_sms),
    consent_rvm: toBit(body.consent_rvm),
    texts: JSON.stringify(Array.isArray(body.texts) ? body.texts : DEFAULT_TEXTS),
    textStatus: JSON.stringify(
      Array.isArray(body.textStatus) ? body.textStatus : [false, false, false, false]
    ),
    rvm: body.rvm || DEFAULT_RVM,
    rvmStatus: 0,
    // Lead fields
    beds: toNum(body.beds),
    baths: toNum(body.baths),
    sqft: toNum(body.sqft),
    agentCompany: body.agentCompany || null,
    isFsbo: toBit(body.isFsbo),
    sellerName: body.sellerName || null,
    fsboPhone: body.fsboPhone || null,
    fsboEmail: body.fsboEmail || null,
    daysOnMarket: toNum(body.daysOnMarket),
    priceChanges: body.priceChanges || null,
    propertyTax: body.propertyTax !== undefined && body.propertyTax !== null && body.propertyTax !== ''
      ? String(body.propertyTax) : null,
    photoUrl: body.photoUrl || null,
    sourceUrl: body.sourceUrl || null,
    keywords: Array.isArray(body.keywords) ? body.keywords.join(', ') : (body.keywords || null),
    city: body.city || null,
    state: body.state || null,
    listingDescription: body.listingDescription || null,
    // Wholesale workflow fields — default new leads/contacts to a $5,000 est. fee
    wholesale_fee: (body.wholesale_fee === undefined || body.wholesale_fee === null || body.wholesale_fee === '')
      ? 5000 : toNum(body.wholesale_fee),
    lead_source: body.lead_source || null,
    offerAcceptedDate: body.offerAcceptedDate || null,
    archived: toBit(body.archived),
    dead_reason: body.dead_reason || null,
    dead_notes: body.dead_notes || null,
    // Deal price fields (price = List Price)
    price: toNum(body.price),
    offerPrice: toNum(body.offerPrice),
    finalPrice: toNum(body.finalPrice),
    suggestedOffer: toNum(body.suggestedOffer),
    contact_type: body.contact_type || null,
    created_at: ts,
    updated_at: ts,
  };
}

function insertContactRow(contact) {
  db.prepare(`
    INSERT INTO contacts (
      id, owner_id, name, email, phone, property, zillow,
      agentName, agentPhone, agentEmail, stage, notes,
      executedContract, closing, dueDiligence, inspectionExpires, source,
      dnc, consent_sms, consent_rvm, texts, textStatus, rvm, rvmStatus,
      beds, baths, sqft, agentCompany, isFsbo, sellerName, fsboPhone, fsboEmail,
      daysOnMarket, priceChanges, propertyTax, photoUrl, sourceUrl, keywords,
      city, state, listingDescription,
      wholesale_fee, lead_source, offerAcceptedDate, archived, dead_reason, dead_notes,
      price, offerPrice, finalPrice, suggestedOffer, contact_type,
      created_at, updated_at
    ) VALUES (
      @id, @owner_id, @name, @email, @phone, @property, @zillow,
      @agentName, @agentPhone, @agentEmail, @stage, @notes,
      @executedContract, @closing, @dueDiligence, @inspectionExpires, @source,
      @dnc, @consent_sms, @consent_rvm, @texts, @textStatus, @rvm, @rvmStatus,
      @beds, @baths, @sqft, @agentCompany, @isFsbo, @sellerName, @fsboPhone, @fsboEmail,
      @daysOnMarket, @priceChanges, @propertyTax, @photoUrl, @sourceUrl, @keywords,
      @city, @state, @listingDescription,
      @wholesale_fee, @lead_source, @offerAcceptedDate, @archived, @dead_reason, @dead_notes,
      @price, @offerPrice, @finalPrice, @suggestedOffer, @contact_type,
      @created_at, @updated_at
    )
  `).run(contact);
}

/**
 * Normalize a property address for duplicate comparison:
 * lowercase, punctuation → space, collapse whitespace, trim.
 * "123 Maple St., Dallas, TX" and "123 maple st  Dallas TX" compare equal.
 */
function normAddr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Company-wide duplicate check on the property address. Returns the existing
 * contact row (id, owner_id, name, property) if another contact already has
 * the same normalized address, else null. `excludeId` skips a row (for edits).
 */
function findDuplicateProperty(property, excludeId) {
  const target = normAddr(property);
  if (!target) return null; // blank addresses are never treated as duplicates
  const rows = db.prepare(
    "SELECT id, owner_id, name, property FROM contacts WHERE property IS NOT NULL AND property != ''"
  ).all();
  for (const r of rows) {
    if (excludeId && String(r.id) === String(excludeId)) continue;
    if (normAddr(r.property) === target) return r;
  }
  return null;
}

/** Build a 409 duplicate response body (privacy-aware for cross-owner rows). */
function duplicatePropertyError(req, dup) {
  const ownedByRequester = String(dup.owner_id) === String(req.user.id);
  if (ownedByRequester || isAdmin(req.user)) {
    return {
      error: `This property address is already in the CRM ("${dup.name || 'contact'}"). It wasn't added again.`,
      duplicateId: dup.id,
      ownedByRequester,
    };
  }
  return {
    error: 'This property address is already in the CRM (added by another team member). It wasn’t added again.',
    ownedByRequester: false,
  };
}

/** ISOLATION: owner is the requester; only an admin may assign another owner. */
function resolveOwnerId(req, body) {
  if (isAdmin(req.user) && body.owner_id) {
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(body.owner_id);
    if (!target) return { error: 'owner_id does not exist' };
    return { ownerId: body.owner_id };
  }
  return { ownerId: req.user.id };
}

/** POST /api/contacts */
router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  if (body.stage && !STAGES.includes(body.stage)) {
    return res.status(400).json({ error: `stage must be one of: ${STAGES.join(', ')}` });
  }

  const owner = resolveOwnerId(req, body); // ISOLATION
  if (owner.error) return res.status(400).json({ error: owner.error });

  // Company-wide duplicate guard on the property address.
  const dup = findDuplicateProperty(body.property);
  if (dup) return res.status(409).json(duplicatePropertyError(req, dup));

  const contact = buildContact(body, owner.ownerId);
  insertContactRow(contact);
  res.status(201).json(parseContact(contact));
});

// ---------------------------------------------------------------------------
// Bulk admin actions — ADMIN ONLY (non-admins get 403).
// ---------------------------------------------------------------------------

/** Coerce {ids:[...]} to a clean array of non-empty string ids (or null). */
function cleanIds(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const ids = v.map((x) => String(x)).filter((x) => x.trim() !== '');
  return ids.length ? ids : null;
}

/**
 * POST /api/contacts/bulk-assign {ids:[...], owner_id} — ADMIN only.
 * Sets owner_id on each id. Deliberately touches NOTHING else: lead_status,
 * opened, called and grade are all preserved exactly as they are.
 */
router.post('/bulk-assign', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  const body = req.body || {};
  const ids = cleanIds(body.ids);
  if (!ids) return res.status(400).json({ error: 'ids must be a non-empty array' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(String(body.owner_id || ''));
  if (!target) return res.status(400).json({ error: 'owner_id does not exist' });

  let updated = 0;
  const ts = now();
  // On (re)assignment, the lead shows up as NEW and unopened in the
  // assignee's dashboard so they know it's freshly handed to them.
  const setOwner = db.prepare(
    "UPDATE contacts SET owner_id = ?, lead_status = 'NEW', opened = 0, opened_at = NULL, updated_at = ? WHERE id = ?"
  );
  const setActOwner = db.prepare('UPDATE activities SET owner_id = ? WHERE contact_id = ?');
  db.transaction(() => {
    for (const id of ids) {
      const r = setOwner.run(target.id, ts, id); // assign + flag as NEW for the new owner
      if (Number(r.changes)) {
        setActOwner.run(target.id, id); // keep activity rows consistent
        updated++;
      }
    }
  })();
  res.json({ updated });
});

/**
 * POST /api/contacts/bulk-lock {ids:[...], locked:0|1} — ADMIN only.
 * Locks (or unlocks) the Keep-as-NEW pin on many leads at once.
 */
router.post('/bulk-lock', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  const body = req.body || {};
  const ids = cleanIds(body.ids);
  if (!ids) return res.status(400).json({ error: 'ids must be a non-empty array' });
  const locked = toBit(body.locked);

  let updated = 0;
  const ts = now();
  const setLock = db.prepare('UPDATE contacts SET status_locked = ?, updated_at = ? WHERE id = ?');
  db.transaction(() => {
    for (const id of ids) {
      const r = setLock.run(locked, ts, id);
      updated += Number(r.changes) || 0;
    }
  })();
  res.json({ updated, locked });
});

/** GET /api/contacts/:id — also records the "open": first detail view sets
 * opened=1/opened_at, and NEW / IN QUEUE leads move to WORKING (unless the
 * lead's status is locked via Keep-as-NEW). */
router.get('/:id', (req, res) => {
  let contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const needsOpen = !contact.opened;
  // Keep-as-NEW lock: a locked lead may still record opened/opened_at, but
  // its lead_status is never auto-changed by the open transition.
  const needsStatus = !contact.status_locked &&
    (contact.lead_status === 'NEW' || contact.lead_status === 'IN QUEUE');
  if (needsOpen || needsStatus) {
    const ts = now();
    db.prepare(`
      UPDATE contacts SET
        opened = 1,
        opened_at = COALESCE(opened_at, @ts),
        lead_status = CASE WHEN status_locked = 0 AND lead_status IN ('NEW','IN QUEUE')
                           THEN 'WORKING' ELSE lead_status END,
        updated_at = @ts
      WHERE id = @id
    `).run({ ts, id: contact.id });
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
  }

  res.json(parseContact(contact));
});

/** PATCH /api/contacts/:id */
router.patch('/:id', (req, res) => {
  const contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const body = req.body || {};
  if (body.stage && !STAGES.includes(body.stage)) {
    return res.status(400).json({ error: `stage must be one of: ${STAGES.join(', ')}` });
  }
  if (body.lead_status !== undefined && body.lead_status !== null && body.lead_status !== '' &&
      !LEAD_STATUSES.includes(body.lead_status)) {
    return res.status(400).json({ error: `lead_status must be one of: ${LEAD_STATUSES.join(', ')}` });
  }

  // If the property address is being changed, keep it company-wide unique.
  if ('property' in body && normAddr(body.property) !== normAddr(contact.property)) {
    const dup = findDuplicateProperty(body.property, contact.id);
    if (dup) return res.status(409).json(duplicatePropertyError(req, dup));
  }

  const sets = [];
  const params = {};
  for (const f of CONTACT_FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (f === 'texts' || f === 'textStatus') v = JSON.stringify(v);
    if (BOOL_FIELDS.includes(f)) v = toBit(v);
    if (NUMERIC_FIELDS.includes(f)) v = toNum(v);
    if (f === 'keywords' && Array.isArray(v)) v = v.join(', ');
    if (f === 'lead_status' && !v) v = null;
    if (v === undefined) v = null;
    sets.push(`${f} = @${f}`);
    params[f] = v;
  }

  // ---- Wholesale stage side-effects ------------------------------------
  if (body.stage && body.stage !== contact.stage) {
    // Moving INTO "Offer Accepted" auto-stamps the accepted date (Important
    // Dates) if the client didn't supply one and it isn't already set.
    if (body.stage === 'Offer Accepted' && !('offerAcceptedDate' in body) && !contact.offerAcceptedDate) {
      sets.push('offerAcceptedDate = @offerAcceptedDate');
      params.offerAcceptedDate = now().slice(0, 10);
    }
    // Moving INTO "Dead Deal" archives the contact (filed away, hidden from
    // active views). Moving OUT of Dead Deal reactivates it.
    if (body.stage === 'Dead Deal' && !('archived' in body)) {
      sets.push('archived = @archived'); params.archived = 1;
    } else if (contact.stage === 'Dead Deal' && body.stage !== 'Dead Deal' && !('archived' in body)) {
      sets.push('archived = @archived'); params.archived = 0;
    }
  }

  // ASSIGN-TO-USER: only an ADMIN may change owner_id (the tenant-isolation
  // key) to assign a lead to a user; non-admins can never reassign.
  let assignedToNewOwner = false;
  if ('owner_id' in body && String(body.owner_id) !== String(contact.owner_id)) {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: 'Only an admin can reassign a contact' });
    }
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(String(body.owner_id));
    if (!target) return res.status(400).json({ error: 'owner_id does not exist' });
    sets.push('owner_id = @owner_id');
    params.owner_id = target.id;
    assignedToNewOwner = true;
    // Keep activity rows consistent with the new owner.
    db.prepare('UPDATE activities SET owner_id = ? WHERE contact_id = ?').run(target.id, contact.id);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields supplied' });

  params.updated_at = now();
  params.id = contact.id;
  db.prepare(`UPDATE contacts SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);

  // A freshly-assigned lead shows as NEW and unopened in the assignee's
  // dashboard (applied after the main update so it wins over any prior value).
  if (assignedToNewOwner) {
    db.prepare("UPDATE contacts SET lead_status = 'NEW', opened = 0, opened_at = NULL WHERE id = ?")
      .run(contact.id);
  }

  // Log a stage-change activity when the pipeline stage moves.
  if (body.stage && body.stage !== contact.stage) {
    logActivity({
      contact, user: req.user, type: 'stage', mode: 'manual',
      body: `Stage changed: ${contact.stage} → ${body.stage}`, status: 'ok',
    });
  }

  const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
  res.json(parseContact(updated));
});

/** DELETE /api/contacts/:id — cascades activities, unlinks tasks. */
router.delete('/:id', (req, res) => {
  const contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  db.transaction(() => {
    db.prepare('DELETE FROM activities WHERE contact_id = ?').run(contact.id);
    db.prepare('UPDATE tasks SET contact_id = NULL WHERE contact_id = ?').run(contact.id);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  })();

  res.json({ ok: true, deleted: contact.id });
});

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

/** GET /api/contacts/:id/activities — chronological. */
router.get('/:id/activities', (req, res) => {
  const contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const rows = db.prepare(
    'SELECT * FROM activities WHERE contact_id = ? ORDER BY created_at ASC, id ASC'
  ).all(contact.id);
  res.json(rows);
});

/**
 * DELETE /api/contacts/:id/activities/:actId — remove one activity-log entry.
 * ADMIN ONLY (regular users cannot delete history).
 */
router.delete('/:id/activities/:actId', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an admin can delete activity entries' });
  const contact = getOwnedContact(req.params.id, req.user);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const act = db.prepare('SELECT id FROM activities WHERE id = ? AND contact_id = ?').get(req.params.actId, contact.id);
  if (!act) return res.status(404).json({ error: 'Activity not found' });
  db.prepare('DELETE FROM activities WHERE id = ?').run(act.id);
  res.json({ ok: true, deleted: act.id });
});

const ACTIVITY_TYPES = ['call', 'sms', 'email', 'rvm', 'note', 'stage'];

/** POST /api/contacts/:id/activities {type,body,mode,direction} */
router.post('/:id/activities', (req, res) => {
  const contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const { type, body, mode, direction, status, duration_sec } = req.body || {};
  if (!ACTIVITY_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${ACTIVITY_TYPES.join(', ')}` });
  }
  const act = logActivity({
    contact, user: req.user, type, body,
    mode: mode === 'automated' ? 'automated' : 'manual',
    direction: direction === 'inbound' ? 'inbound' : 'outbound',
    status: status ? String(status) : 'logged',
    duration_sec,
  });
  if (type === 'call') markCalled(contact); // call logged -> WORKING
  res.status(201).json(act);
});

/** POST /api/contacts/:id/log {type,body} — manual log shortcut. */
router.post('/:id/log', (req, res) => {
  const contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  let { type, body } = req.body || {};
  if (type === 'text') type = 'sms'; // convenience alias
  if (!['call', 'sms', 'email', 'note'].includes(type)) {
    return res.status(400).json({ error: 'type must be call, text/sms, email or note' });
  }
  const act = logActivity({
    contact, user: req.user, type, body, mode: 'manual', status: 'logged',
  });
  if (type === 'call') markCalled(contact); // call logged -> WORKING
  res.status(201).json(act);
});

// ---------------------------------------------------------------------------
// Messaging actions (adapters in integrations.js — stub unless creds set)
// ---------------------------------------------------------------------------

/** POST /api/contacts/:id/send-text {index} — render template #index and send. */
router.post('/:id/send-text', async (req, res) => {
  const contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const index = Number((req.body || {}).index);
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    return res.status(400).json({ error: 'index must be 0-3' });
  }
  if (!contact.phone) return res.status(400).json({ error: 'Contact has no phone number' });
  if (contact.dnc) return res.status(400).json({ error: 'Contact is on the Do-Not-Contact list' });

  const parsed = parseContact(contact);
  const template = parsed.texts[index] || DEFAULT_TEXTS[index];
  const rendered = renderTemplate(template, contact, req.user.name);

  const result = await sendSms({
    to: contact.phone,
    body: rendered,
    from: req.user.business_number || process.env.TWILIO_FROM,
  });

  // Mark textStatus[index] = true
  const status = parsed.textStatus.slice();
  while (status.length < 4) status.push(false);
  status[index] = true;
  db.prepare('UPDATE contacts SET textStatus = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(status), now(), contact.id);

  const act = logActivity({
    contact, user: req.user, type: 'sms', mode: 'automated',
    body: rendered, status: result.status, provider_id: result.sid,
  });

  res.json({ ok: true, index, message: rendered, result, activity: act });
});

/** POST /api/contacts/:id/send-rvm — drop the ringless voicemail. */
router.post('/:id/send-rvm', async (req, res) => {
  const contact = getOwnedContact(req.params.id, req.user); // isolation check
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!contact.phone) return res.status(400).json({ error: 'Contact has no phone number' });
  if (contact.dnc) return res.status(400).json({ error: 'Contact is on the Do-Not-Contact list' });

  const rendered = renderTemplate(contact.rvm || DEFAULT_RVM, contact, req.user.name);
  const result = await sendRvm({ to: contact.phone, body: rendered });

  db.prepare('UPDATE contacts SET rvmStatus = 1, updated_at = ? WHERE id = ?')
    .run(now(), contact.id);
  markCalled(contact); // RVM drop counts as a call -> WORKING

  const act = logActivity({
    contact, user: req.user, type: 'rvm', mode: 'automated',
    body: rendered, status: result.status, provider_id: result.sid,
  });

  res.json({ ok: true, message: rendered, result, activity: act });
});

// ---------------------------------------------------------------------------
// Leads — /api/leads (mounted in server.js behind requireAuth)
//
// COMPLIANCE NOTE: this app NEVER fetches or scrapes Zillow / Realtor.com /
// Homes.com or any other listing site (their ToS prohibit it). Lead data
// comes only from text the user pastes in, or (later) a licensed data
// provider via integrations.fetchLicensedListings().
// ---------------------------------------------------------------------------

const leadsRouter = express.Router();

/** Motivated-seller keywords we flag when found in pasted listing text. */
const LEAD_KEYWORDS = [
  'fixer upper', 'as-is', 'handyman special', 'investor special', 'tlc',
  'needs work', 'needs updating', 'cash only', 'motivated seller', 'must sell',
  'estate sale', 'probate', 'inherited', 'foreclosure', 'short sale',
  'price reduced', 'diamond in the rough', 'tenant occupied',
];

/**
 * parseListingText(text) — best-effort heuristic parse of PASTED listing
 * text into a draft lead. Pure string work: no network calls of any kind.
 */
function parseListingText(text) {
  const t = String(text).replace(/\r/g, '');
  const lower = t.toLowerCase();
  const draft = {};

  // Street address like "123 Maple St, Dallas, TX 75201"
  const addr = t.match(
    /\d{1,6}\s+[A-Za-z0-9.'\- ]+?\b(?:St(?:reet)?|Ave(?:nue)?|R(?:oa)?d|Dr(?:ive)?|Lane|Ln|Blvd|Boulevard|Ct|Court|Way|Pl(?:ace)?|Ter(?:race)?|Cir(?:cle)?|Pkwy|Parkway|Trail|Trl|Loop)\b\.?(?:\s*,\s*[A-Za-z.'\- ]+)?(?:\s*,\s*[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?/
  );
  if (addr) draft.property = addr[0].trim();

  // City / state from ", Dallas, TX 75201"
  const cs = t.match(/,\s*([A-Za-z.'\- ]+?)\s*,\s*([A-Z]{2})\b(?:\s+\d{5})?/);
  if (cs) { draft.city = cs[1].trim(); draft.state = cs[2]; }

  const beds = t.match(/(\d+(?:\.\d+)?)\s*(?:bd|bds|beds?|bedrooms?)\b/i);
  if (beds) draft.beds = Number(beds[1]);

  const baths = t.match(/(\d+(?:\.\d+)?)\s*(?:ba|baths?|bathrooms?)\b/i);
  if (baths) draft.baths = Number(baths[1]);

  const sqft = t.match(/([\d,]{3,})\s*(?:sq\.?\s*\.?ft\.?|sqft|square\s+feet)/i);
  if (sqft) draft.sqft = Number(sqft[1].replace(/,/g, ''));

  const price = t.match(/\$\s?([\d,]{4,}(?:\.\d+)?)/);
  if (price) draft.price = Number(price[1].replace(/,/g, ''));

  const dom =
    t.match(/(\d+)\s*days?\s+on\s+(?:the\s+)?market/i) ||
    t.match(/\bdom[:\s]+(\d+)/i) ||
    t.match(/on\s+market[:\s]+(\d+)/i);
  if (dom) draft.daysOnMarket = Number(dom[1]);

  const tax =
    t.match(/(?:property|annual)\s+tax(?:es)?[:\s]*\$?\s*([\d,]+(?:\.\d+)?)/i) ||
    t.match(/tax(?:es)?[:\s]+\$\s*([\d,]+(?:\.\d+)?)/i);
  if (tax) draft.propertyTax = tax[1].replace(/,/g, '');

  const priceChanges = t.match(/price\s+(?:reduced|cut|drop(?:ped)?|improvement)[^.\n]*/gi);
  if (priceChanges) draft.priceChanges = priceChanges.map((s) => s.trim()).join('; ');

  const phone = t.match(/(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/);
  const email = t.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);

  draft.isFsbo = /for\s+sale\s+by\s+owner|\bfsbo\b/i.test(t);

  const agent = t.match(
    /(?:[Ll]isted\s+[Bb]y|[Ll]isting\s+[Aa]gent|[Aa]gent)[:\s]+([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,2})/
  );
  const company =
    t.match(/(?:brokered\s+by|brokerage|courtesy\s+of|company)[:\s]+([^,\n]+)/i) ||
    t.match(/,\s*([A-Za-z.'\- ]*(?:Realty|Real\s+Estate|Brokerage|Properties|Group|Associates|Homes)(?:\s+[A-Za-z.'\-]+)*)/);

  if (draft.isFsbo) {
    const seller = t.match(
      /(?:[Oo]wner|[Ss]eller|[Cc]ontact)[:\s]+([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,2})/
    );
    if (seller) draft.sellerName = seller[1].trim();
    if (phone) draft.fsboPhone = phone[0].trim();
    if (email) draft.fsboEmail = email[0].trim();
  } else {
    if (agent) draft.agentName = agent[1].trim();
    if (company) draft.agentCompany = company[1].trim();
    if (phone) draft.agentPhone = phone[0].trim();
    if (email) draft.agentEmail = email[0].trim();
  }

  draft.keywords = LEAD_KEYWORDS.filter((k) => lower.includes(k));
  return draft;
}

/**
 * POST /api/leads/parse { url, text } — parse PASTED listing text into a
 * draft lead for the user to review. Never fetches `url`; it is only kept
 * as sourceUrl. Nothing is saved here — the frontend POSTs /api/leads after
 * the user reviews the draft.
 */
leadsRouter.post('/parse', (req, res) => {
  const { url, text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'text is required — paste the listing description' });
  }
  const draft = parseListingText(text);
  draft.sourceUrl = url ? String(url) : null; // stored, never fetched
  draft.listingDescription = String(text);
  res.json(draft);
});

/**
 * POST /api/leads — create a NEW LEAD contact.
 * Stage is forced to 'Prospect'. Owner is the requester; an admin may pass
 * body.owner_id to assign the lead to a specific user (that user then has
 * exclusive access under the normal tenant-isolation rules).
 */
leadsRouter.post('/', (req, res) => {
  const body = req.body || {};

  const owner = resolveOwnerId(req, body); // ISOLATION
  if (owner.error) return res.status(400).json({ error: owner.error });

  // Company-wide duplicate guard on the property address.
  const dup = findDuplicateProperty(body.property);
  if (dup) return res.status(409).json(duplicatePropertyError(req, dup));

  const name =
    body.name || body.sellerName || body.agentName || body.property || 'New Lead';

  const contact = buildContact(
    { ...body, name, stage: 'New', source: body.source || 'Lead' },
    owner.ownerId
  );
  insertContactRow(contact);
  res.status(201).json(parseContact(contact));
});

module.exports = router;
module.exports.leadsRouter = leadsRouter;
