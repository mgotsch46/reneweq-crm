/**
 * server.js — Wholesale Real-Estate CRM backend.
 *
 * Single-process Express server:
 *   - REST API under /api (JWT auth, tenant-isolated per owner)
 *   - static frontend from ./public (built by another team)
 *   - SPA fallback: any non-/api GET serves public/index.html, or a
 *     placeholder page if the frontend hasn't been built yet.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const { requireAuth, requireAdmin } = require('./auth');
const { messagingMode } = require('./integrations');
const { STAGES, DEFAULT_TEXTS, DEFAULT_RVM } = require('./db');

const authRoutes = require('./routes/auth');
const contactRoutes = require('./routes/contacts');
const taskRoutes = require('./routes/tasks');
const userRoutes = require('./routes/users');
const leadEngineRoutes = require('./routes/leadengine');
const scheduler = require('./scheduler'); // Lead Engine daily auto-import

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Public: register / login
app.use('/api/auth', authRoutes);

// Current user (requireAuth already strips password_hash)
app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// Config for the frontend: is messaging live or stubbed? Plus useful constants.
app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    messagingMode: messagingMode(), // 'live' only if Twilio env vars present
    stages: STAGES,
    defaultTexts: DEFAULT_TEXTS,
    defaultRvm: DEFAULT_RVM,
  });
});

// Tenant-scoped resources (isolation enforced inside each router — see
// routes/helpers.js for the TENANT ISOLATION BOUNDARY).
app.use('/api/contacts', requireAuth, contactRoutes);
app.use('/api/leads', requireAuth, contactRoutes.leadsRouter);
app.use('/api/tasks', requireAuth, taskRoutes);
app.use('/api/leadengine', requireAuth, leadEngineRoutes);

// Admin-only user management
app.use('/api/users', requireAuth, requireAdmin, userRoutes);

// API 404 (must come before the SPA fallback)
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// JSON error handler (bad JSON bodies, unexpected throws)
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('[api] error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Static frontend + SPA fallback
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

const PLACEHOLDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Wholesale CRM</title></head>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Frontend loading…</h1>
<p>The API is running. Drop the frontend build into <code>./public</code>.</p></div>
</body></html>`;

// SPA fallback: any non-/api GET → index.html if present, else placeholder.
app.get('*', (req, res) => {
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(200).type('html').send(PLACEHOLDER_HTML);
});

// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Wholesale CRM backend running at http://localhost:${PORT}`);
  console.log(`Messaging mode: ${messagingMode()}`);
  // Schedule the Lead Engine daily auto-import (reads settings; never throws,
  // and a failed fetch inside a run is caught + logged — it can't crash us).
  try { scheduler.start(); }
  catch (e) { console.error('[leadengine:auto] failed to start scheduler:', e.message); }
});
