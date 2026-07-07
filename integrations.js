/**
 * integrations.js — messaging adapters (SMS + ringless voicemail).
 *
 * LIVE mode is used only when provider credentials are present in the
 * environment; otherwise every call degrades gracefully to STUB mode
 * (console.log + fake sid). These functions NEVER throw — a provider
 * failure is captured and reported in the returned { status } field so
 * an activity row can still be logged.
 */
'use strict';

const stubSid = (prefix) =>
  prefix + '-' + Math.random().toString(36).slice(2, 10).toUpperCase();

/** True when all Twilio env vars are present → SMS goes live. */
function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM
  );
}

/** True when an RVM provider key is present. */
function rvmConfigured() {
  return Boolean(process.env.RVM_API_KEY);
}

/** 'live' if Twilio creds exist, else 'stub' — surfaced via GET /api/config. */
function messagingMode() {
  return twilioConfigured() ? 'live' : 'stub';
}

/**
 * sendSms({ to, body, from }) → { sid, status }
 * Live: Twilio REST API (Basic auth, form-encoded). Stub: console.log.
 */
async function sendSms({ to, body, from }) {
  if (!twilioConfigured()) {
    // STUB mode — no credentials, just log the outbound message.
    console.log(`[SMS:STUB] to=${to} body="${body}"`);
    return { sid: stubSid('STUB'), status: 'stubbed' };
  }

  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(
      `${sid}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const params = new URLSearchParams({
      To: to,
      From: from || process.env.TWILIO_FROM,
      Body: body,
    });

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Provider rejected the message — degrade, don't crash.
      console.error('[SMS:LIVE] Twilio error:', data.message || res.status);
      return { sid: null, status: `failed: ${data.message || 'HTTP ' + res.status}` };
    }
    return { sid: data.sid, status: data.status || 'queued' };
  } catch (err) {
    // Network / unexpected failure — degrade, don't crash.
    console.error('[SMS:LIVE] send failed:', err.message);
    return { sid: null, status: `failed: ${err.message}` };
  }
}

/**
 * sendRvm({ to, body }) → { sid, status }
 * Stub unless RVM_API_KEY is set. A real integration would call a ringless
 * voicemail provider — see the TODO below.
 */
async function sendRvm({ to, body }) {
  if (!rvmConfigured()) {
    // STUB mode — no RVM provider configured.
    console.log(`[RVM:STUB] to=${to} script="${body}"`);
    return { sid: stubSid('STUB-RVM'), status: 'stubbed' };
  }

  try {
    // TODO: real RVM integration goes here.
    // Slybroadcast:  POST https://www.mobile-sphere.com/gateway/vmb.php
    //   (form fields: c_uid, c_password/api key, c_phone=to, c_audio or
    //    c_tts text, c_date=now) — parse the session_id from the response.
    // Drop Cowboy:   POST https://api.dropcowboy.com/v1/rvm
    //   (JSON: team_id, secret=RVM_API_KEY, phone_number=to, tts body,
    //    brand_id) — parse the drop id from the response.
    // Until wired up, treat a configured key as accepted-but-simulated:
    console.log(`[RVM:LIVE(simulated)] to=${to} script="${body}"`);
    return { sid: stubSid('RVM'), status: 'queued (provider call not yet wired)' };
  } catch (err) {
    console.error('[RVM] send failed:', err.message);
    return { sid: null, status: `failed: ${err.message}` };
  }
}

/**
 * fetchLicensedListings(query) → { mode, results }
 *
 * Compliant automated ingestion goes through a LICENSED data provider.
 * We never scrape Zillow/Realtor/Homes (ToS). Lead data enters this CRM
 * only via (a) text the user pastes in themselves, or (b) this connector
 * once it is wired to a licensed feed (ATTOM, Bridge Interactive / MLS
 * RESO Web API, etc.).
 *
 * STUB unless LISTINGS_API_KEY is set — and even then the real call is a
 * TODO, so nothing is fetched from anywhere yet.
 */
async function fetchLicensedListings(query) {
  if (!process.env.LISTINGS_API_KEY) {
    // STUB mode — no licensed-data provider configured.
    console.log(`[LISTINGS:STUB] query=${JSON.stringify(query || {})}`);
    return { mode: 'stub', results: [] };
  }

  try {
    // TODO: real licensed-data API call goes here. Examples:
    // ATTOM:  GET https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail
    //   headers: { apikey: process.env.LISTINGS_API_KEY }
    //   params: address1/address2 or geoid from `query` — map the response
    //   fields (beds, bathstotal, universalsize, taxamt, ...) onto our
    //   contact/lead shape.
    // Bridge (MLS RESO Web API):  GET https://api.bridgedataoutput.com/api/v2/OData/<dataset>/Property
    //   headers: { Authorization: `Bearer ${process.env.LISTINGS_API_KEY}` }
    //   params: $filter built from `query` (City eq '...', ListPrice lt ...).
    // Until wired up, a configured key still returns no results:
    console.log(`[LISTINGS:LIVE(not wired)] query=${JSON.stringify(query || {})}`);
    return { mode: 'live (provider call not yet wired)', results: [] };
  } catch (err) {
    console.error('[LISTINGS] fetch failed:', err.message);
    return { mode: 'error', results: [], error: err.message };
  }
}

module.exports = { sendSms, sendRvm, messagingMode, fetchLicensedListings };
