# Wholesale Real-Estate CRM

A runnable, multi-user CRM for a wholesale real-estate investing business.
Node.js + Express backend, built-in SQLite database (no compiler needed),
and a zero-dependency vanilla-JS front end.

## What it does
- **Multi-user logins with roles.** Each user sees only their own contacts,
  tasks, and activity. An **admin** sees everyone's.
- **9-stage deal pipeline** (Prospect → Offer Delivered → Offer Accepted →
  Property Analyzer Run → BOG Walk Through → EMD Sent → Dispo → Assigned →
  Closed) with drag-and-drop.
- **Contacts** with name, email, phone, property, Zillow link, listing-agent
  info, notes, and key dates (executed contract, closing, due diligence,
  inspection expires).
- **Two messaging modes:** manual tap-to-text / click-to-call from your own
  phone (no setup), and an automated **4-message text sequence** + **ringless
  voicemail** that send through a business number once you add API keys.
- **Unified activity log** — calls, texts, emails, RVMs, and stage changes all
  recorded under each contact.
- **Tasks** with `.ics` export to Google Tasks / Apple Reminders / Outlook.
- **Compliance fields** — Do-Not-Call flag and SMS/RVM consent per contact.

## Requirements
- **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module — no native
  build tools required).

## Run it
```
npm install
npm start
```
Then open **http://localhost:3000** in your browser.

### Demo logins (created automatically on first run)
- Admin: `admin@demo.com` / `admin123`
- User:  `marisa@demo.com` / `demo123`
- User:  `rep@demo.com` / `demo123`

## Turning on real texting / calling / RVM
Out of the box the app runs in **stub mode**: it logs messages instead of
sending them, so you can try everything safely. To send for real, copy
`.env.example` to `.env` and fill in your keys:
```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+1XXXXXXXXXX      # your A2P-registered business number
RVM_API_KEY=...              # Slybroadcast / Drop Cowboy, for ringless voicemail
```
Automated SMS from a US number requires **A2P 10DLC registration** (a one-time
carrier step). Manual tap-to-text from your own phone does not. See the build
spec document for details.

## Data & backups
Your database lives in `./data/crm.db`. Back it up by copying that file.
To reset to a clean slate, stop the server and delete the `data` folder.

## Deploying online (so your team can log in from anywhere)
This runs locally today. To host it, deploy to any Node host (Render, Railway,
Fly.io, etc.), set a strong `JWT_SECRET` env var, and point `CRM_DATA_DIR` at a
persistent disk (or migrate the DB layer to managed Postgres — the schema in
`db.js` maps over directly).

## Project layout
```
server.js         Express app + static hosting + SPA fallback
db.js             SQLite schema, seed data, shared constants
auth.js           JWT auth middleware
integrations.js   Twilio / RVM adapters (stub unless keys present)
routes/           auth, contacts, tasks, users, helpers
public/           front end: index.html, app.js, styles.css
```

## Security notes
- Passwords are hashed (bcrypt). Set a real `JWT_SECRET` before deploying.
- Every query is scoped to the signed-in user; admins bypass the filter.
- This is a solid foundation; have a developer add HTTPS, rate limiting, and a
  managed database before production use with real client data.
