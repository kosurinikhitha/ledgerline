# LedgerLine API

Base URL: `http://localhost:3000` locally, or your Render API URL.
Auth: `Authorization: Bearer <jwt>` (from `/auth/login`). Roles: `admin`, `account_holder`, `auditor`.
Every request re-reads the user from the database, so deactivation and role changes apply immediately.

## Money-moving requests (deposit, withdrawal, transfer, adjust)

- Require header `Idempotency-Key` (8–128 chars of `A-Za-z0-9_.:-`). Missing/invalid → `400`.
- Same key + same body from the same user → the **first response is returned** (`"duplicate": true`) and nothing moves again.
- Same key + different body → `422` and nothing moves.
- Keys are per user and never expire.
- A refused request (e.g. insufficient funds) is also stored: replaying it returns the same `422`.
- Amounts: JSON numbers, > 0, ≤ 10,000,000, at most 2 decimals. Returned balances are decimal strings.

Success body: `{ transactionId, type, status, amount, fromBalance?, toBalance?, idempotencyKey, duplicate }`

## Errors

`{ "error": "<CODE>", "message": "...", "statusCode": n }`

| Code | Meaning |
|------|---------|
| 400 | Validation, bad amount, missing/invalid Idempotency-Key |
| 401 | Missing/invalid token, or user deactivated |
| 403 | Authenticated but not allowed (role or account) |
| 404 | Not found |
| 409 | Account inactive |
| 422 | Refused (insufficient funds / floor), or idempotency key reused for a different request |
| 429 | Rate limited |

## Auth

| Endpoint | Who | Effect on money |
|----------|-----|-----------------|
| `POST /auth/login` `{email,password}` | public (10/min/IP) | none |
| `POST /auth/register` `{email,name,password,role}` | admin | none |
| `GET /auth/me` | any user | none |

## Accounts

| Endpoint | Who | Notes |
|----------|-----|-------|
| `GET /accounts` | admin/auditor: all. holder: own + granted | Balances visible |
| `GET /accounts/directory` | admin, holder | id/name/owner only (no balances), for choosing a transfer destination |
| `POST /accounts` `{name,currency?,overdraft_limit?,owner_id?}` | admin, holder | Creates an empty account; no money moves. Only admin may set `overdraft_limit` or `owner_id` |
| `GET /accounts/:id` | owner, granted viewer, admin, auditor | |
| `GET /accounts/:id/statement?page&limit` | same | `entries` (every debit/credit with `running_balance`, initiator, type) and `refused_attempts` (reason, `balance_at_attempt`, initiator) |
| `GET /accounts/:id/permissions` | admin | |
| `POST /accounts/:id/permissions` `{user_id,can_view,can_deposit,can_withdraw,can_transfer}` | admin | Per-account grants for non-owners |

## Transactions

| Endpoint | Who | Effect on money |
|----------|-----|-----------------|
| `POST /transactions/deposit` `{account_id,amount,description?}` | admin; owner; holder with `can_deposit`. Never auditor | **Credits** the account. Total of all balances **rises** by `amount` (external inflow) |
| `POST /transactions/withdrawal` `{account_id,amount,description?}` | admin; owner; holder with `can_withdraw`. Never auditor | **Debits** the account if `balance - amount >= -overdraft_limit`, else `422`. Total **falls** by `amount` (external outflow) |
| `POST /transactions/transfer` `{from_account_id,to_account_id,amount,description?}` | admin; owner of the source; holder with `can_transfer` on the source. Never auditor | Debits source and credits destination atomically. Total of all balances **unchanged**. Same currency required |
| `GET /transactions` | admin/auditor: all. holder: those touching their accounts | none |
| `GET /transactions/:id` | admin/auditor; holder with access to an involved account | Includes both ledger entries |

A `403` on these routes is itself written to `refused_attempts` with reason code `FORBIDDEN`.

## Admin (role `admin` only)

| Endpoint | Effect |
|----------|--------|
| `GET /admin/users`, `PATCH /admin/users/:id {is_active}` | Activate/deactivate (cannot deactivate yourself) |
| `GET /admin/conservation` | Integrity report: ledger net = sum of balances; per-account balance = sum of postings; every transfer nets to zero with 2 postings; hash chain intact. `balanced:false` lists the offenders |
| `GET /admin/audit-log`, `GET /admin/refused-attempts` | Read |
| `POST /admin/accounts/:id/adjust` `{amount (signed), description (10+ chars)}` + `Idempotency-Key` | Posts a credit (positive) or debit (negative) to the ledger. Obeys the floor. Appears as type `ADJUSTMENT` |
| `PATCH /admin/accounts/:id/deactivate` | Blocks further movements on the account |

## Auditor (roles `auditor`, `admin`; every handler is a read)

| Endpoint | Returns |
|----------|---------|
| `GET /auditor/ledger?account_id&page&limit` | Every posting, with `prev_hash` / `entry_hash` |
| `GET /auditor/conservation` | Same integrity report as admin |
| `GET /auditor/all-accounts` | All accounts and balances |
| `GET /auditor/refused-attempts` | All refusals |
| `GET /auditor/idempotency-keys` | Stored keys with `replay_count`: which requests were duplicates |

## Role matrix

| | admin | account_holder | auditor |
|---|---|---|---|
| Create users | yes | no | no |
| View accounts | all | own + granted | all (read) |
| Create account | any owner, can set overdraft | own, no overdraft | no |
| Deposit / withdraw / transfer | any account | own, or per-account grant | **never** |
| Adjust balance | yes | no | no |
| Ledger, integrity, idempotency log | yes | no | yes |
| Grant permissions / deactivate users | yes | no | no |
