/**
 * routes/helpers.js — shared helpers for all route modules.
 *
 * =========================================================================
 * TENANT ISOLATION BOUNDARY
 * =========================================================================
 * Every data read AND write in this app must go through the helpers below
 * (or replicate their logic). The rule:
 *
 *   - role 'user'  → rows are visible/mutable ONLY when owner_id = req.user.id
 *   - role 'admin' → no owner filter (sees and can modify everything)
 *
 * Ownership is always checked SERVER-SIDE against the row already in the
 * database — client-supplied ids/owner fields are never trusted.
 * =========================================================================
 */
'use strict';

const isAdmin = (user) => user && user.role === 'admin';

/**
 * SQL fragment + params scoping a query to the requesting user.
 * Usage:  const s = ownerScope(req.user, 'c');
 *         db.prepare(`SELECT * FROM contacts c ${s.where}`).all(...s.params)
 */
function ownerScope(user, alias) {
  const col = (alias ? alias + '.' : '') + 'owner_id';
  return isAdmin(user)
    ? { where: '', and: '', params: [] }
    : { where: `WHERE ${col} = ?`, and: `AND ${col} = ?`, params: [user.id] };
}

/** True if `user` may read/modify a row owned by row.owner_id. */
function canTouch(user, row) {
  return Boolean(row) && (isAdmin(user) || row.owner_id === user.id);
}

/**
 * renderTemplate — substitute {name}, {property}, {agent} tokens.
 * `agentName` is the CRM user sending the message (not the listing agent).
 */
function renderTemplate(str, contact, agentName) {
  return String(str || '')
    .replaceAll('{name}', contact.name || 'there')
    .replaceAll('{property}', contact.property || 'your property')
    .replaceAll('{agent}', agentName || 'your local buyer');
}

/** Parse JSON-string columns on a contact row into real arrays. */
function parseContact(row) {
  if (!row) return row;
  const safe = (s, fallback) => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    ...row,
    texts: safe(row.texts, []),
    textStatus: safe(row.textStatus, [false, false, false, false]),
  };
}

module.exports = { isAdmin, ownerScope, canTouch, renderTemplate, parseContact };
