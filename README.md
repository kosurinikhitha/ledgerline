# LedgerLine

Money movement with a ledger you can prove. Books always balance, the same request never pays twice, and nothing in the ledger can be quietly changed.

- Live app: https://ledgerline-12x0.onrender.com
- Live API health: https://ledgerline-api-uvk2.onrender.com/health
- Free hosting sleeps when idle: the first request can take up to a minute.
- Docs: [API.md](./API.md), [THREATS.md](./THREATS.md), [PROMPTS.md](./PROMPTS.md)

## Seed accounts (password for all: `Password123!`)

| Role | Email | Notes |
|------|-------|-------|
| Admin | `admin@ledgerline.dev` | Creates users, adjusts balances, sets overdrafts, sees everything |
| Account holder | `bob@ledgerline.dev` | "Bob Main Account" ₹50,000, "Bob Savings" ₹1,00,000 |
| Account holder | `carol@ledgerline.dev` | "Carol Main Account" ₹75,000 with a ₹5,000 admin-granted overdraft |
| Auditor | `auditor@ledgerline.dev` | Read-only: ledger, integrity proof, idempotency log |

Opening balances are real deposit postings, so the ledger explains every rupee.

## Stack and why

| | |
|---|---|
| Backend | Node 22, TypeScript, Fastify |
| Database | PostgreSQL 16, raw SQL via `postgres.js` (no ORM, so every lock and transaction boundary is visible) |
| Frontend | React, Vite, Tailwind |
| Tests | Vitest against a real PostgreSQL (races need a real database) |
| Host | Render (Blueprint in `render.yaml`) |

## How the money stays correct

Everything that changes a balance is in `backend/src/services/transfer.service.ts`. One operation is one database transaction at READ COMMITTED with explicit row locks:

1. `INSERT INTO idempotency_keys … ON CONFLICT (user_id, key) DO NOTHING`. If the key already exists, return the stored response (or 422 if the body differs). A concurrent duplicate blocks on this row until the first transaction finishes.
2. `SELECT … FROM accounts WHERE id = ANY(...) ORDER BY id FOR UPDATE`. Locks are always taken in id order, so opposite transfers cannot deadlock.
3. Check the floor **in SQL** on the locked row: `balance - amount >= -overdraft_limit`.
4. If it fails: write a `refused_attempts` row and the stored 422, **commit** (no balance changes).
5. If it passes: `UPDATE accounts SET balance = balance ± amount … RETURNING balance`, insert the `transactions` row and the two ledger postings (debit and credit), store the response against the key.
6. Commit. Balance, postings and idempotency record become visible together or not at all.

Where the balance is checked and where the debit is written: both inside step 2–5, same transaction, same locked row. Two requests that race on one account serialize on step 2.

Ledger model: **double-entry**. A transfer is one debit and one credit of the same amount. A deposit or withdrawal is one posting against the account (the counter-side is "outside the system"). Invariant, checked live at `/admin/conservation`:

- sum of all postings = sum of all balances
- each account's balance = sum of its own postings
- each transfer = exactly two postings that net to zero
- every account's hash chain is intact

What stops a quiet edit: triggers reject UPDATE, DELETE and TRUNCATE on `ledger_entries` (and on refused attempts and the audit log); a database trigger also chains each posting to the previous one with SHA-256, so even someone who disables the trigger and edits a row is caught by `ledger_chain_check`. They are only *detected*, not prevented, if they can also recompute every later hash. See THREATS.md, risk 1.

Overdraft: an account has `overdraft_limit` (default 0). Only an admin can set it. Enforced in SQL and by a `CHECK` constraint on the table.

## Run it locally

Prerequisites: Node 22, PostgreSQL 16.

```powershell
# 1. databases
psql -U postgres -c "CREATE DATABASE ledgerline;"
psql -U postgres -c "CREATE DATABASE ledgerline_test;"

# 2. backend
cd backend
copy ..\.env.example .env        # then edit DATABASE_URL, TEST_DATABASE_URL, JWT_SECRET (32+ chars)
npm install
npm run migrate:dev              # creates tables, triggers, views (safe to re-run)
npm run seed:dev                 # idempotent
npm run dev                      # http://localhost:3000

# 3. frontend (new terminal)
cd frontend
npm install
npm run dev                      # http://localhost:5173 (proxies /api to :3000)
```

### Tests

```powershell
cd backend
npm test          # 41 tests; uses TEST_DATABASE_URL and WIPES that database
npm run typecheck
```

`TEST_DATABASE_URL` must point at a database whose name contains `test`; otherwise the suite refuses to run.

What the suites prove (and where):

| File | Proves |
|------|--------|
| `tests/concurrency` | 20 parallel withdrawals leave exactly 10 successes and balance 0 (service and HTTP); overdraft floor holds under a race; two transfers can't jointly overdraw; opposite transfers don't deadlock; mixed storm keeps every invariant |
| `tests/idempotency` | replay returns the first result; 10 concurrent same-key requests move money once; key reuse with a different body is rejected; keys are per user; refusals replay as refusals |
| `tests/authorization` | another user cannot deposit/withdraw/transfer from my account; auditor can never move money; holder can't self-grant overdraft; deactivated users are cut off immediately; denials are recorded |
| `tests/integrity` | conservation for each operation type; atomic failure; exact decimals; UPDATE/DELETE/TRUNCATE blocked; hash chain detects tampering even with the trigger disabled |

## Deploy to Render

1. Push this repo to GitHub (public).
2. Render → New → Blueprint → select the repo. It reads `render.yaml` and creates the Postgres database, the API and the static site.
3. When the first deploy finishes, note the API's real URL. Render adds a random suffix when a name is taken (mine is `https://ledgerline-api-uvk2.onrender.com`). Put that URL in `render.yaml` as `VITE_API_URL` and push; Render re-applies the Blueprint and rebuilds the static site. `CORS_ORIGIN` uses a wildcard (`https://ledgerline*.onrender.com`), so the static site's suffix does not matter.
4. The API's start command runs `migrate` and `seed` on every boot; both are idempotent.

The free plan sleeps when idle, so the first request after a pause can take about a minute. Wake it before a demo.

## What I did not build

Multi-currency conversion (accounts carry a currency and transfers between different currencies are refused), holds/authorisations, reversals and refunds (corrections are admin adjustments), scheduled or batch transfers, per-day limits, two-person approval for adjustments, MFA, password reset, AI anomaly flagging. Each is a deliberate cut to keep the money path small enough to reason about.

## Known gaps (also in THREATS.md)

- A holder can deposit into their own account with no external verification (simulation).
- No external anchor for the hash chain, so someone with full database ownership could rebuild the chain.
- Frontend has no automated tests; the per-intent idempotency key was reviewed by reading, not by a browser test.
- Demo credentials are public by design (the brief requires them), so anyone with the link can sign in. Demo users are restored on each restart; set `VITE_SHOW_DEMO_ACCOUNTS=false` to hide the login panel after evaluation.
- Statement shows ledger entries and refused attempts as two lists, not one merged timeline.
- Login rate limiting and SQL-injection resistance are not covered by tests.
- No self sign-up, by design: only an admin can create users. Because a holder can deposit into their own account, open sign-up would let anyone create accounts and add money with no approval.
- The commit history covers a short period rather than the whole week.
