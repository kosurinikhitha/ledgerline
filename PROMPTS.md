# PROMPTS.md

How AI was used on LedgerLine, and where it was wrong.

Tool: Kiro (AI coding agent in the IDE). Method: one broad prompt ("build LedgerLine as specified"), then review, run, and attack the output. The code, and the fixes below, were AI-written; what I am claiming is the direction, the review and the testing, not that I typed the fixes.

> **What the commit links show.** The repository was first committed after entries 1–8 were found and fixed, so those links point at commits containing the *corrected* code; the original buggy versions were never committed, and the history does not show before/after for them. Entry 9 (found by attacking the live deployment) is a separate commit whose diff is the fix itself.

An honest note on this file: an early version contained invented "first attempt" code snippets. It was thrown away, and every entry below describes a defect that really existed in the generated code.

---

## 1. Refusal recorded, then rolled back with the idempotency marker — money integrity

**Date:** 2026-11-07  
**Asked:** Build the withdrawal/transfer service with row locking, idempotency and a refused-attempts log.  
**Produced:** On insufficient funds the service wrote the refusal, marked the idempotency key `FAILED`, then `throw`ed *inside* `sql.begin(...)`.  
**Wrong:** Throwing inside the transaction rolls the whole transaction back, including the `FAILED` marker. The key was never stored, so a retry re-executed instead of replaying. The refusal only survived because it was written on a separate connection, which is accidental, not designed. Also the test "failed operation marks key FAILED" would have failed.  
**Did instead:** Refusals now `return` a result from the work function and the transaction **commits**: key, refusal row and stored 422 response all land together, and no balance changes. The error is thrown only after commit. Tests: `a refused request replayed returns the same refusal and does not log a second refusal`, `20 simultaneous withdrawals…` (counts 10 refusal rows).  
**COMMIT:** [2039aff](https://github.com/kosurinikhitha/ledgerline/commit/2039aff19859132f98bbed21fb7aa5b1a7525744)

## 2. Balance arithmetic done in JavaScript — money integrity

**Date:** 2026-11-07  
**Asked:** Same service.  
**Produced:** `parseFloat(account.balance) - amount`, comparisons in JS, then `UPDATE accounts SET balance = ${newBalance}`.  
**Wrong:** Floats for money, and the new balance was computed in the app from a value read earlier. It is only safe because of the lock, and it is fragile and hard to defend. It also left decimal drift as an open question.  
**Did instead:** Amounts travel as 2-decimal strings. The floor check is `balance - $amt::numeric >= -overdraft_limit` evaluated by PostgreSQL on the locked row, and the update is `balance = balance - $amt::numeric … RETURNING balance`. The ledger `running_balance` comes from that `RETURNING`. Test: `decimal money is exact (… 1000 postings)` ends at exactly `100.0000`.  
**COMMIT:** [2039aff](https://github.com/kosurinikhitha/ledgerline/commit/2039aff19859132f98bbed21fb7aa5b1a7525744)

## 3. Idempotency keys were global and not tied to the request — idempotency

**Date:** 2026-11-07  
**Asked:** Implement idempotency for money endpoints.  
**Produced:** Primary key on `key` alone; a repeated key returned whatever was stored, whatever the new request said.  
**Wrong:** (a) User B could send user A's key and receive A's stored response. (b) A client could reuse a key with a *different* amount and silently get the first result, which looks like success for a payment that never happened. (c) The code and THREATS.md described a `PENDING`→409 state that cannot actually be observed, because the claim and the work are in one transaction.  
**Did instead:** Key is `(user_id, key)`; a SHA-256 `request_hash` is stored and a mismatch returns 422. Concurrent duplicates block on the unique-key row and then read the committed result (documented honestly). Replays are counted in `idempotency_replays`. Tests: `reusing a key for a DIFFERENT request…`, `keys are scoped per user…`, `10 concurrent requests with the SAME key…`.  
**COMMIT:** [2039aff](https://github.com/kosurinikhitha/ledgerline/commit/2039aff19859132f98bbed21fb7aa5b1a7525744) (service) and [e53661e](https://github.com/kosurinikhitha/ledgerline/commit/e53661ef60451ac2ea315340d27011c596e19170) (schema)

## 4. Frontend minted a new idempotency key on every click — idempotency

**Date:** 2026-11-07  
**Asked:** Build the transfer UI.  
**Produced:** `headers: { 'Idempotency-Key': uuidv4() }` inside the API call.  
**Wrong:** A fresh key per call means a double-click or a retry after timeout is two *different* requests, so it pays twice. The whole backend guarantee is bypassed by the client the product ships. The comment on the page even claimed the opposite.  
**Did instead:** One key per user intent, held in component state. It is re-sent on retry or double-click, and regenerated only when the user edits a field or the operation succeeds. Verified by reading the code and by the backend replay tests; **not** covered by a browser test.  
**COMMIT:** [ac0af18](https://github.com/kosurinikhitha/ledgerline/commit/ac0af1852a25ad02f4a5183e4a4bbc31211e6c84)

## 5. Tests that did not test authorisation or concurrency

**Date:** 2026-11-07  
**Asked:** Write tests for no-double-spend, IDOR, replay and conservation.  
**Produced:** An "authorization" test that expected the *service* to reject Bob withdrawing from Alice (it does not check ownership, and a comment in the test admitted that), a second test that never called the transfer at all and just asserted the DB was unchanged, and a "conservation" test that only `console.log`ged the diff.  
**Wrong:** These passed or would pass regardless of whether authorisation or conservation worked. They exercised nothing. The seed also wrote balances with no ledger entries, so the conservation view could not have shown a balanced system.  
**Did instead:** Rewrote the suite at the HTTP layer with `app.inject` for authorisation (41 tests total across 4 files), real parallel `Promise.all` races asserting exact counts and final balances, and a `assertBooksBalance()` check against four SQL proof views. The seed now creates opening balances through the real `deposit()` path. I then ran a **mutation check**: removing `FOR UPDATE` from `lockAccounts()` made 3 concurrency tests fail, then I restored it.  
**COMMIT:** [e46d5b2](https://github.com/kosurinikhitha/ledgerline/commit/e46d5b234cd3a9f8739ec6e95bf2d77eba998455)

## 6. A holder could grant themselves an overdraft — authorisation

**Date:** 2026-11-07  
**Asked:** Account creation endpoint.  
**Produced:** `POST /accounts` accepted `overdraft_limit` from any account holder.  
**Wrong:** A user could create an account with a ₹1,000,000 overdraft and withdraw it. That is the "authorised overdraft" feature, authorised by the borrower.  
**Did instead:** Only admins may set `overdraft_limit` or `owner_id`; holders get 403. Test: `a holder cannot grant themselves an overdraft`.  
**COMMIT:** [df402bf](https://github.com/kosurinikhitha/ledgerline/commit/df402bfe16a0580a8b1773295f3e34c6a92b89c7)

## 7. Smaller defects caught while running it

**Date:** 2026-11-07  
- Authorisation denials were not recorded as refused attempts (spec says every refused attempt). Fixed, tested.  
- JWT role was trusted until expiry, so a deactivated user kept working. Auth now re-reads the user each request.  
- The ledger was blocked from UPDATE/DELETE but not `TRUNCATE` (row triggers do not fire on TRUNCATE). Added statement-level triggers.  
- The AI-written tests initially pointed the service at the dev database while the helpers wiped the test database; test env now overrides `DATABASE_URL` and refuses to run unless the DB name contains "test".  
- A test for "DELETE on refused_attempts is blocked" passed vacuously because the table was empty (a row trigger cannot fire on zero rows). Added a real refusal first.  
**COMMIT:** [e53661e](https://github.com/kosurinikhitha/ledgerline/commit/e53661ef60451ac2ea315340d27011c596e19170) (schema triggers), [df402bf](https://github.com/kosurinikhitha/ledgerline/commit/df402bfe16a0580a8b1773295f3e34c6a92b89c7) (auth, refusal recording), [e46d5b2](https://github.com/kosurinikhitha/ledgerline/commit/e46d5b234cd3a9f8739ec6e95bf2d77eba998455) (tests)

## 8. Documentation that overclaimed

**Date:** 2026-11-07  
The first THREATS.md said transfers ran in a "serializable transaction" (they run at READ COMMITTED with explicit row locks), marked the in-flight idempotency race "closed" with a 409 path that cannot occur, and listed tests as covering things they did not. Rewrote THREATS.md so each claim names a real test, and added a "not tested" section.  
**COMMIT:** [f361d52](https://github.com/kosurinikhitha/ledgerline/commit/f361d5298161e17b92b2e161c0ee30ae2f87e2f9)

---

## 9. Custom error handler never ran — found by attacking the live deployment

**Date:** 2026-11-07  
**Asked:** Global error handling for the API.  
**Produced:** `app.setErrorHandler(...)` placed *after* the route plugins were registered.  
**Wrong:** Fastify plugins only inherit an error handler that already exists when they are registered, so none of the routes used it. Every error went through the framework default: a malformed account id in the URL returned **500** and echoed raw validation internals. The SQL-error mappings in the handler (floor violation → 422, bad id → 400) were dead code. The test suite missed it because it only checked status codes on paths where errors already carried a status.  
**How it was found:** a scripted attack against the deployed API on Render (`/accounts/not-a-uuid/statement` → 500).  
**Did instead:** wrote a failing test first (expects 400 and our own `VALIDATION` error shape), moved the handler above the route registrations, confirmed the test passed, and re-ran the live attack: now 400.  
**COMMIT:** [41698bc](https://github.com/kosurinikhitha/ledgerline/commit/41698bc0fd956566c16e8cbb8409784e39e293b9)

---

## 10. An approach I rejected: public self sign-up

**Date:** 2026-11-07  
**Considered:** Other submissions offer a public "Create an account" page, and I considered adding one.  
**Why I rejected it:** in LedgerLine an account holder can deposit into their own account (there is no payment rail to verify deposits). Open sign-up would let anyone create accounts and add money with no approval. Adding a new public feature the day before submission would also risk breaking the live site.  
**Did instead:** kept registration admin-only (`POST /auth/register` requires the admin role), and documented it under known gaps.  
**COMMIT:** this decision is a documentation change; no sign-up code was ever written.

---

### What I would say in the interview about AI

It was fast at scaffolding and wrong in exactly the places the brief warns about: error paths inside transactions, where the idempotency boundary sits, and tests that look like tests. Everything above was found by reading the generated SQL and by running attacks (parallel requests, replays, tampering), not by trusting the first output.
