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

/** Which ringless-voicemail provider to use. */
function rvmProvider() {
  return String(process.env.RVM_PROVIDER || 'slybroadcast').toLowerCase();
}

/** True when the selected RVM provider has credentials configured. */
function rvmConfigured() {
  if (process.env.RVM_API_KEY) return true; // back-compat generic key
  if (rvmProvider() === 'dropcowboy') {
    return Boolean(process.env.DROP_COWBOY_TEAM_ID && (process.env.DROP_COWBOY_SECRET || process.env.RVM_API_KEY));
  }
  // default: slybroadcast
  return Boolean(process.env.SLYBROADCAST_EMAIL && process.env.SLYBROADCAST_PASSWORD);
}

/** 'live' if an RVM provider is configured, else 'stub'. */
function rvmMode() {
  return rvmConfigured() ? 'live' : 'stub';
}

/** Format a JS Date for Slybroadcast's c_date field (its server timezone). */
function slyDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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
 * sendRvm({ to, body, audioUrl, from, sendAt }) → { sid, status }
 *
 * Drops a ringless voicemail via the configured provider. `audioUrl` is a
 * publicly-fetchable recording (preferred — see routes/rvm.js); `body` is a
 * TTS script fallback. `sendAt` (Date) schedules at the provider when it
 * supports it (Slybroadcast); otherwise the CRM scheduler fires it.
 * Never throws — provider failures come back in { status }.
 */
async function sendRvm({ to, body, audioUrl, from, sendAt }) {
  if (!rvmConfigured()) {
    console.log(`[RVM:STUB] to=${to} audio=${audioUrl || '(none)'} script="${body || ''}"`);
    return { sid: stubSid('STUB-RVM'), status: 'stubbed' };
  }

  const digits = String(to || '').replace(/[^0-9]/g, '');
  try {
    if (rvmProvider() === 'dropcowboy') {
      // Drop Cowboy RVM API (JSON). Uses a pre-uploaded recording_id when
      // available, else TTS text.
      const payload = {
        team_id: process.env.DROP_COWBOY_TEAM_ID,
        secret: process.env.DROP_COWBOY_SECRET || process.env.RVM_API_KEY,
        phone_number: '+' + digits,
        foreign_id: 'crm',
      };
      if (process.env.DROP_COWBOY_RECORDING_ID) payload.recording_id = process.env.DROP_COWBOY_RECORDING_ID;
      else if (audioUrl) payload.audio_url = audioUrl;
      else payload.tts = body || '';
      const res = await fetch('https://api.dropcowboy.com/v1/rvm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { sid: null, status: `failed: ${data.message || 'HTTP ' + res.status}` };
      return { sid: data.rvm_id || data.id || stubSid('DC'), status: sendAt ? 'scheduled' : 'queued' };
    }

    // Default provider: Slybroadcast (form-encoded gateway). Broadcasts a
    // hosted audio file (audioUrl); c_date schedules or sends now.
    const params = new URLSearchParams();
    params.set('c_uid', process.env.SLYBROADCAST_EMAIL || '');
    params.set('c_password', process.env.SLYBROADCAST_PASSWORD || '');
    params.set('c_phone', digits);
    params.set('c_callerID', String(from || process.env.TWILIO_FROM || '').replace(/[^0-9]/g, ''));
    params.set('c_date', sendAt instanceof Date ? slyDate(sendAt) : 'now');
    params.set('mobile_only', '0');
    if (audioUrl) {
      params.set('c_url', audioUrl);            // hosted audio file URL
      params.set('c_audio_type', 'audio/mpeg');
    } else {
      params.set('c_record_audio', body || ''); // TTS fallback text
    }
    const res = await fetch('https://www.mobile-sphere.com/gateway/vmb.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await res.text().catch(() => '');
    if (/OK/i.test(text) && !/error/i.test(text)) {
      const m = text.match(/session_id\s*=\s*(\w+)/i);
      return { sid: m ? m[1] : stubSid('SLY'), status: sendAt ? 'scheduled' : 'queued' };
    }
    return { sid: null, status: `failed: ${(text || 'provider error').slice(0, 120)}` };
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

module.exports = { sendSms, sendRvm, messagingMode, rvmMode, rvmProvider, rvmConfigured, fetchLicensedListings };
