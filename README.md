# RepReceipts

Track what U.S. members of Congress say in committee hearings, with word-level transcript timestamps.

- **Backend:** Node.js + Express + Postgres (`backend/`)
- **Frontend:** React + Vite + TypeScript + Tailwind (`frontend/`)
- **Shared types:** `shared/types`
- **Database:** Postgres 16 via Docker Compose

## Prerequisites

- Node.js 18+ and npm
- Docker Desktop (for Postgres)

## First-time setup

From the project root:

### 1. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
cd ..
```

### 2. Create the root `.env`

Copy the example and fill in the two secrets:

```bash
cp .env.example .env
```

Generate a random 64-char hex value for **each** secret and paste them into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it twice — once for `JWT_SECRET`, once for `CSRF_SECRET`. The `.env` should end up looking like:

```
DATABASE_URL=postgres://rep_receipts:rep_receipts@localhost:5432/rep_receipts
PORT=3000
NODE_ENV=development
JWT_SECRET=<64 hex chars>
CSRF_SECRET=<64 hex chars>
```

`DATABASE_URL` matches the credentials in `docker-compose.yml` — leave it as-is unless you change the compose file.

### 3. Start Postgres, migrate, seed

```bash
docker compose up -d
cd backend
npm run migrate
npm run seed
```

The seed loads 3 committees, 6 members, 4 hearings, and 2 transcripts (one with word-level timestamps).

## Running the app

Open two terminals.

**Backend** (port 3000):
```bash
cd backend && npm run dev
```

**Frontend** (port 5173):
```bash
cd frontend && npm run dev
```

Then visit http://localhost:5173.

Sanity check the backend directly:
```bash
curl http://localhost:3000/api/members
```

## Common tasks

| Task | Command |
| --- | --- |
| Stop the database | `docker compose down` |
| Reset the database (drops data) | `docker compose down -v && docker compose up -d` then re-run migrate + seed |
| Re-run migrations | `cd backend && npm run migrate` |
| Re-seed | `cd backend && npm run seed` |
| Backend with file watching | `cd backend && npm run dev` |
| Frontend production build | `cd frontend && npm run build` |

## Project layout

```
backend/
  db/
    migrate.js          migration runner
    migrations/         versioned .sql files
    seeds/seed.js       dev fixture data
  src/                  app, routes, controllers, services
frontend/
  src/                  React app
shared/types/           shared TS types
docker-compose.yml      Postgres service
.env.example            template for root .env
```

## Notes

- The backend reads `.env` from the **project root**, not from `backend/`.
- Both `JWT_SECRET` and `CSRF_SECRET` are required — the backend exits on startup if either is missing.
- `node_modules/` and `.env` are gitignored, so a fresh clone always needs steps 1–3 above.
