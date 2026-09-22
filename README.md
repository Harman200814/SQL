# AntiVenom Finder — Production Database Edition

This version replaces the Render-ephemeral SQLite database with **PostgreSQL** and stores Express sessions in PostgreSQL too.

## Why this fixes the Render reset problem

The old prototype stored data in `data/antivenom.db`. Render web-service filesystems are ephemeral, so a restart/replacement could create a new empty SQLite database.

This version stores persistent application data in PostgreSQL through `DATABASE_URL` and stores login sessions in PostgreSQL through `connect-pg-simple`.

## Render deployment

### Option A — Blueprint

Use the included `render.yaml`. It creates:

- a Render Web Service
- a Render PostgreSQL database
- `DATABASE_URL` wired from the database to the web service
- generated `SESSION_SECRET`
- health check at `/api/health`

Set these manually in the web service:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`

Generate a bcrypt hash locally with:

```bash
node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD',12))"
```

Do **not** set `DEMO_MODE=true` in production.

### Option B — Existing Render service

1. Create a Render PostgreSQL database.
2. Open your web service → Environment.
3. Set `DATABASE_URL` to the database's **Internal Database URL**.
4. Set `NODE_ENV=production`.
5. Set a strong `SESSION_SECRET` (32+ random characters) or use Render's generated secret.
6. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`.
7. Redeploy.
8. Open `/api/health` and confirm `{"status":"ok","database":"connected",...}`.

The first successful startup automatically creates the required tables and antivenom reference data.

## Demo data

Demo data is now **development-only** and is never seeded automatically in production.

For local development, provide a local PostgreSQL `DATABASE_URL` and set:

```env
NODE_ENV=development
DEMO_MODE=true
```

The four demo hospitals are then inserted only when the hospitals table is empty. Demo login password: `demo1234`.

## Existing SQLite data migration

If you have an important local `data/antivenom.db` from the old version, migrate it before deleting it:

```bash
npm install
node scripts/migrate-sqlite-to-postgres.js
```

The script requires both:

- `SQLITE_PATH` (defaults to `data/antivenom.db`)
- `DATABASE_URL`

It copies hospitals, antivenoms, inventory, bite reports and doctors. It does not overwrite existing PostgreSQL rows with the same unique email/category.

## Production safety changes

- PostgreSQL replaces local SQLite.
- PostgreSQL-backed sessions replace in-memory sessions.
- Demo seeding is disabled in production.
- Database startup is idempotent and uses `CREATE TABLE IF NOT EXISTS` / `ON CONFLICT`.
- `/api/health` checks database connectivity.
- Hospital and doctor records use foreign keys with cascade cleanup.
- Production cookies use `secure` when `NODE_ENV=production`.

## Important

This is an infrastructure upgrade, not yet a clinically validated medical system. Before real patient use, medical content, hospital verification, emergency workflows, privacy controls, auditing, backups and operational procedures need appropriate professional review.
