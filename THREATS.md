# THREATS.md

How the money or the ledger could be broken, what I did, and what I knowingly left open.
Every "closed" claim names the test that exercises it. I verified the key ones by mutation: removing `FOR UPDATE` from `lockAccounts()` makes 3 concurrency tests fail.

## Model in one paragraph

Isolation is **READ COMMITTED + explicit row locks**, not SERIALIZABLE. Each money operation is one DB transaction: claim the idempotency key, `SELECT ... FOR UPDATE` the account row(s) (ordered by id), check the floor in SQL against the locked balance, `UPDATE balance = balance ± amount` in SQL, insert the transaction and double-entry ledger rows, store the response against the key, commit. Amounts never pass through JavaScript arithmetic. The ledger is double-entry, append-only (triggers), and hash-chained per account by the database.

## Threats and status

| # | Threat | What stops it | Status | Test |
|---|--------|---------------|--------|------|
| 1 | Two withdrawals race past the balance | Row lock taken before the check, check done in SQL on the locked row | Closed | `concurrency: 20 simultaneous withdrawals…`, `…through the HTTP API` |
| 2 | Race on an overdraft account | Same lock; floor = `-overdraft_limit` computed in SQL | Closed | `overdraft limit is enforced under a race` |
| 3 | Two transfers jointly overdraw one source | Both lock the source row; second sees the reduced balance | Closed | `two transfers that together would overdraw…` |
| 4 | Deadlock on opposite transfers A→B and B→A | Rows locked in one global order (`ORDER BY id FOR UPDATE`) | Closed | `opposite-direction transfers… do not deadlock` |
| 5 | Same request twice (retry, double-click) | `INSERT … ON CONFLICT (user_id,key) DO NOTHING` inside the money transaction; replay returns the stored response | Closed | `replaying a transfer…`, `10 concurrent requests with the SAME key` |
| 6 | Retry arrives while the first is still running | The duplicate's INSERT blocks on the first's uncommitted key row, then reads the committed result. It never runs the work twice. (There is no visible PENDING state to the client.) | Closed | `10 concurrent requests with the SAME key` |
| 7 | First attempt fails halfway | Key, postings and balance are one transaction: all roll back together, so a retry runs cleanly | Closed | `a transfer to a missing account fails atomically` |
| 8 | Key reused for a different request | `request_hash` is stored; mismatch returns 422 and moves nothing | Closed | `reusing a key for a DIFFERENT request is rejected` |
| 9 | One user replays/collides with another's key | Keys are scoped `(user_id, key)` | Closed | `keys are scoped per user` |
| 10 | Duplicate evidence | Every replay is logged in `idempotency_replays`; `/auditor/idempotency-keys` shows `replay_count` | Closed | `replaying a transfer…` |
| 11 | Move money from an account you don't control (IDOR) | `canOperateAccount()` on every request, server-side, per operation; denial is recorded as a refused attempt | Closed | `Bob cannot transfer money OUT…`, `…withdraw from or deposit to…` |
| 12 | Auditor moves money | Money routes require `admin` or `account_holder`; auditor routes are SELECT-only | Closed | `an auditor can read everything but can never move money` |
| 13 | Holder grants themselves credit | Only admins may set `overdraft_limit` or `owner_id` | Closed | `a holder cannot grant themselves an overdraft` |
| 14 | Stale token after deactivation / role change | `authenticate()` re-reads user from the DB on each request | Closed | `a deactivated user is locked out immediately` |
| 15 | Negative / zero / fractional / huge amounts | Zod (positive, ≤ 10,000,000, ≤ 2 dp) plus `toAmountString()` plus DB `CHECK (amount > 0)` | Closed | `input that tries to create money is rejected` |
| 16 | Float drift | NUMERIC(20,4); arithmetic in SQL; amounts travel as strings | Closed | `decimal money is exact… 1000 postings` |
| 17 | Balance below floor if app logic is bypassed | `CHECK (balance >= -overdraft_limit)` on `accounts` | Closed | `the database itself refuses a balance below the floor` |
| 18 | Edit/delete a ledger row | Triggers block UPDATE, DELETE, and TRUNCATE on `ledger_entries`; also on `refused_attempts`, `audit_log`; `transactions` blocks UPDATE/DELETE | Closed | `Ledger tamper resistance` (4 tests) |
| 19 | Privileged user disables the trigger and edits a row | Per-account SHA-256 hash chain computed by a DB trigger; `ledger_chain_check` flags any edited row. Edited balances are flagged by `account_balance_mismatches`. | Detected, not prevented | `even a privileged user who DISABLES the trigger…` |
| 20 | Money created/lost in a transfer | Four proof views: ledger net = sum of balances; each balance = sum of its postings; each transfer = exactly 2 postings netting to 0; hash chain intact. Exposed at `/admin/conservation` and `/auditor/conservation`. | Closed (checked) | `mixed storm…`, `after everything above, all proof views are clean` |
| 21 | Refusals vanish | Refusals are written in the same transaction as the key and commit; they carry reason, balance at attempt, initiator | Closed | `20 simultaneous withdrawals…` (counts 10 refused rows) |
| 22 | Login brute force / user enumeration | 10 logins/min/IP; bcrypt compare runs even for unknown emails | Mitigated | not tested |
| 23 | SQL injection | All queries are parameterised (`postgres.js` tagged templates); the only dynamic identifier is picked from a fixed map | Closed by construction | not tested |

## Risks I knowingly accepted

1. **A database superuser can rewrite history undetectably if they recompute the whole chain.** The hash chain catches partial edits and balance changes, but there is no external anchor (for example publishing the latest hash somewhere the DBA cannot edit). I did not build that. Prevention here is a database-permissions matter: the app should connect as a role that is not the table owner. On Render's free tier the single database user owns the tables, so this is only *detected*, not *prevented*, against someone with that credential.
2. **Anyone with the `account_holder` role can deposit into their own account.** There is no payment rail to verify an "external" deposit, so a holder can mint money in this simulation. It is recorded (initiator, amount, ledger posting) and counted as external inflow in the conservation check, but it is not authorised by a second person. A real system would take deposits only from a verified rail or require admin approval above a limit.
3. **Admins can adjust any balance.** Adjustments obey the floor, require a 10+ character reason, are idempotent, and are permanent ledger postings visible to auditors. There is no four-eyes approval.
4. **The audit log row is written after the money transaction commits.** A crash in between would lose the audit row, never the ledger posting. The ledger, not the audit log, is the source of truth.
5. **No daily limits, velocity checks, holds or reversals.** Per-request cap of 10,000,000 only. A mistaken transfer is corrected by an admin adjustment, not a reversal.
6. **Idempotency keys are kept forever.** No TTL, so a key can never be reused after any time. Chosen for safety over storage.
7. **Failures that happen before the transaction writes anything** (validation errors, account not found, permission denied) are not stored against the key. A retry re-evaluates them. Nothing moved, so this is harmless.
8. **Rate limiting is in-process memory.** Fine for one instance; with several instances it would need a shared store.
9. **JWT is kept in `localStorage`.** Exposed to XSS; httpOnly cookies would be better. Tokens last 8 hours; there is no revocation list, but deactivating a user takes effect immediately (see #14).
10. **Permission is checked, then the operation runs in a second step.** If an admin revokes access in the few milliseconds between the two, that one request can still go through. The money transaction itself stays correct.
11. **Free-tier hosting** sleeps when idle, so the first request after a pause is slow.

## Attacked on the live deployment (2026-11-07)

Scripted against `https://ledgerline-api-uvk2.onrender.com` with a throwaway user, then deactivated:

| Attack | Result |
|--------|--------|
| 10 parallel withdrawals of 2,000 from 10,000 | 5 × 200, 5 × 422, final balance exactly 0 |
| Same transfer replayed 5× with one key | 1 transaction, 4 marked duplicate, money moved once |
| 8 concurrent requests with one key | 1 transaction, no errors, money moved once |
| Same key, different amount | 422, nothing moved |
| Move / withdraw / read another user's account | 403 on all three |
| Auditor deposits, holder self-grants overdraft, holder calls admin route | 403 on all three |
| Negative amount | 400 |
| Malformed id in URL | was **500** (real bug, see PROMPTS.md #9), now 400 |
| Integrity proof afterwards | balanced, 0 mismatches, 0 unbalanced transfers, 0 hash-chain breaks |

## Not tested (said plainly)

Login rate limiting, SQL injection resistance, and the frontend are not covered by automated tests. The frontend double-click protection (one idempotency key per user intent) was checked by reading the code and by the backend replay tests, not by a browser test.
