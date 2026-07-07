# Deploying the Wholesale CRM to Railway (click-by-click)

This guide takes about 15 minutes and needs no coding. The app runs on
Railway with its built-in SQLite database stored on a **persistent volume**,
so your data survives every restart and redeploy.

---

## 1. Put the code on GitHub

1. Go to https://github.com and sign in as **mgotsch46**.
2. Click the **+** (top right) → **New repository**.
3. Name it `wholesale-crm`, keep it **Private**, click **Create repository**.
4. Upload the app code. Easiest way without any tools:
   - On the new repo page, click **uploading an existing file**.
   - Drag in ALL files and folders from the `crm-app` folder
     (**except** `node_modules` and `data` — those are ignored anyway).
   - Click **Commit changes**.

   Or, if you have git installed, from inside the `crm-app` folder:
   ```
   git init
   git add .
   git commit -m "Wholesale CRM"
   git branch -M main
   git remote add origin https://github.com/mgotsch46/wholesale-crm.git
   git push -u origin main
   ```

## 2. Create the Railway project

1. Go to https://railway.app and sign in (choose **Login with GitHub** —
   it makes the next step automatic).
2. Click **New Project** → **Deploy from GitHub repo**.
3. Pick **mgotsch46/wholesale-crm** (grant Railway access to the repo if asked).
4. Railway detects Node.js and starts building. The included `railway.json`
   makes it start the server with `node --experimental-sqlite server.js`.
   (Node 22.5+ is required and is already declared in `package.json` →
   `"engines": { "node": ">=22.5.0" }`.)

## 3. Add a persistent Volume (IMPORTANT — this is where your data lives)

1. In your Railway project, right-click the service (or click **+ Create**)
   and choose **Volume**.
2. Attach it to the CRM service.
3. Set **Mount path** to exactly:  `/data`
4. Save. Without this volume the database would be wiped on every deploy;
   with it, all contacts, users and leads persist.

## 4. Set the environment variables

Open the service → **Variables** tab → add these two:

| Variable       | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| `JWT_SECRET`   | A long random string (40+ characters). Example way to get one: use a password manager's generator, or run `openssl rand -hex 32`. Never reuse a password here. |
| `CRM_DATA_DIR` | `/data`  (must match the volume mount path from step 3)       |

Do **not** set `PORT` — Railway supplies it automatically and the server
already reads `process.env.PORT`.

Click **Deploy** / let it redeploy after saving the variables.

## 5. Open the app

1. Go to the service → **Settings** → **Networking** → **Generate Domain**.
2. Click the generated `*.up.railway.app` URL — the CRM login page loads.

## 6. First login — change the admin password right away

The first boot seeds a demo admin account:

- Email: `admin@demo.com`
- Password: `admin123`

**Immediately after your first login:** go to the **Team** tab, create your
own real admin user (with a strong password), log in as that new user, and
deactivate or repurpose the demo accounts (`admin@demo.com`,
`marisa@demo.com`, `rep@demo.com`). Anyone who knows the demo password could
otherwise sign in.

## 7. Done — notes

- **Data persistence:** everything is stored in SQLite at `/data/crm.db` on
  the Railway volume, so restarts, crashes and redeploys keep your data.
- **Backups:** Railway volumes support snapshots/backups from the volume's
  menu — take one before big changes.
- **No native builds needed:** all npm dependencies are pure JavaScript
  (`express`, `bcryptjs`, `cors`, `jsonwebtoken`, `node-cron`), so
  `npm install` works on Railway with no compilers.
- **Secrets:** the JWT secret lives only in the Railway Variables tab —
  it is never hardcoded in the repo.
