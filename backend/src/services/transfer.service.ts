/**
 * The only place balances change.
 *
 * For every operation, inside ONE database transaction (READ COMMITTED + row locks):
 *   1. claim the idempotency key (INSERT ... ON CONFLICT DO NOTHING)
 *   2. lock the account row(s) with SELECT ... FOR UPDATE (ordered by id: no deadlocks)
 *   3. check the floor in SQL against the locked balance
 *   4. UPDATE balance in SQL (balance = balance +/- amount), write transaction + ledger rows
 *   5. store the response against the idempotency key
 * Then COMMIT. A refusal is written in the same transaction and COMMITS (so it is
 * kept), while no balance changes. Anything unexpected rolls everything back,
 * including the key, so a retry is safe.
 *
 * Amounts are never added or compared in JavaScript: they travel as decimal strings
 * and PostgreSQL NUMERIC does the arithmetic.
 */
import { createHash } from 'crypto';
import type postgres from 'postgres';
import sql from '../db/connection';

type Tx = postgres.TransactionSql<{}>;

export class AppError extends Error {
  constructor(public statusCode: number, message: string, public code = 'ERROR') {
    super(message);
    this.name = 'AppError';
  }
}

export interface OperationResult {
  transactionId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'ADJUSTMENT';
  status: 'COMPLETED';
  amount: string;
  fromBalance?: string;
  toBalance?: string;
  idempotencyKey: string;
  duplicate: boolean;
}

interface WorkResult {
  status: number;
  body: Record<string, unknown>;
}

/** Validates and normalises an amount to a 2-decimal string. Throws on anything odd. */
export function toAmountString(n: number, allowNegative = false): string {
  if (!Number.isFinite(n)) throw new AppError(400, 'Amount must be a finite number', 'BAD_AMOUNT');
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new AppError(400, 'Amount may have at most 2 decimal places', 'BAD_AMOUNT');
  if (!allowNegative && cents <= 0) throw new AppError(400, 'Amount must be positive', 'BAD_AMOUNT');
  if (allowNegative && cents === 0) throw new AppError(400, 'Amount must be non-zero', 'BAD_AMOUNT');
  return (cents / 100).toFixed(2);
}

function requestHash(fingerprint: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

async function runIdempotent(
  userId: string,
  key: string,
  fingerprint: Record<string, unknown>,
  work: (tx: Tx) => Promise<WorkResult>
): Promise<OperationResult> {
  const hash = requestHash(fingerprint);

  const out = await sql.begin(async (tx) => {
    // Atomic claim. A concurrent request with the same (user,key) BLOCKS here until
    // the first transaction commits or rolls back, then either sees the stored
    // result (commit) or claims the key itself (rollback).
    const claimed = await tx`
      INSERT INTO idempotency_keys (user_id, key, request_hash)
      VALUES (${userId}, ${key}, ${hash})
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING key`;

    if (claimed.length === 0) {
      const [ex] = await tx`
        SELECT request_hash, response_status, response_body
        FROM idempotency_keys WHERE user_id = ${userId} AND key = ${key}`;
      if (ex.request_hash !== hash) {
        await tx`INSERT INTO idempotency_replays (user_id, key, outcome) VALUES (${userId}, ${key}, 'REJECTED_MISMATCH')`;
        return {
          status: 422,
          body: { error: 'Idempotency Key Reuse', message: 'This Idempotency-Key was already used for a different request' },
          duplicate: false,
        };
      }
      await tx`INSERT INTO idempotency_replays (user_id, key, outcome) VALUES (${userId}, ${key}, 'REPLAYED')`;
      return { status: ex.response_status as number, body: ex.response_body as Record<string, unknown>, duplicate: true };
    }

    const r = await work(tx);
    await tx`
      UPDATE idempotency_keys
      SET status = ${r.status < 400 ? 'COMPLETE' : 'FAILED'},
          response_status = ${r.status},
          response_body = ${tx.json(r.body as postgres.JSONValue)},
          completed_at = now()
      WHERE user_id = ${userId} AND key = ${key}`;
    return { ...r, duplicate: false };
  });

  if (out.status >= 400) {
    throw new AppError(out.status, String(out.body.message ?? out.body.error), String(out.body.code ?? 'REFUSED'));
  }
  return { ...(out.body as unknown as OperationResult), duplicate: out.duplicate };
}

interface LockedAccount {
  id: string;
  balance: string;
  currency: string;
  is_active: boolean;
  can_debit: boolean;
}

/** Locks the given accounts in id order (one consistent global order => no deadlocks). */
async function lockAccounts(tx: Tx, ids: string[], amt: string): Promise<Map<string, LockedAccount>> {
  const rows = await tx`
    SELECT id, balance, currency, is_active,
           (balance - ${amt}::numeric >= -overdraft_limit) AS can_debit
    FROM accounts
    WHERE id = ANY(${ids}::uuid[])
    ORDER BY id
    FOR UPDATE`;
  return new Map(rows.map((r) => [r.id as string, r as unknown as LockedAccount]));
}

function refuse(
  tx: Tx,
  p: { accountId: string; userId: string; operation: string; amt: string; balance: string; key: string; reason: string; code: string }
): Promise<WorkResult> {
  return tx`
    INSERT INTO refused_attempts (account_id, attempted_by, operation, amount, reason, reason_code, balance_at_attempt, idempotency_key)
    VALUES (${p.accountId}, ${p.userId}, ${p.operation}, ${p.amt}::numeric, ${p.reason}, ${p.code}, ${p.balance}::numeric, ${p.key})`
    .then(() => ({ status: 422, body: { error: 'Refused', code: p.code, message: p.reason } }));
}

async function post(
  tx: Tx,
  p: {
    type: OperationResult['type'];
    from?: string;
    to?: string;
    amt: string;
    description: string;
    userId: string;
    key: string;
  }
): Promise<WorkResult> {
  const [t] = await tx`
    INSERT INTO transactions (idempotency_key, type, status, from_account_id, to_account_id, amount, description, initiated_by, completed_at)
    VALUES (${p.key}, ${p.type}, 'COMPLETED', ${p.from ?? null}, ${p.to ?? null}, ${p.amt}::numeric, ${p.description}, ${p.userId}, now())
    RETURNING id`;

  let fromBalance: string | undefined;
  let toBalance: string | undefined;

  if (p.from) {
    const [u] = await tx`UPDATE accounts SET balance = balance - ${p.amt}::numeric, updated_at = now() WHERE id = ${p.from} RETURNING balance`;
    fromBalance = u.balance as string;
    await tx`
      INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount, running_balance, description, initiated_by)
      VALUES (${t.id}, ${p.from}, 'DEBIT', ${p.amt}::numeric, ${fromBalance}::numeric, ${p.description}, ${p.userId})`;
  }
  if (p.to) {
    const [u] = await tx`UPDATE accounts SET balance = balance + ${p.amt}::numeric, updated_at = now() WHERE id = ${p.to} RETURNING balance`;
    toBalance = u.balance as string;
    await tx`
      INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount, running_balance, description, initiated_by)
      VALUES (${t.id}, ${p.to}, 'CREDIT', ${p.amt}::numeric, ${toBalance}::numeric, ${p.description}, ${p.userId})`;
  }

  const body: Record<string, unknown> = {
    transactionId: t.id,
    type: p.type,
    status: 'COMPLETED',
    amount: p.amt,
    idempotencyKey: p.key,
    ...(fromBalance !== undefined && { fromBalance }),
    ...(toBalance !== undefined && { toBalance }),
  };
  return { status: 200, body };
}

function need(map: Map<string, LockedAccount>, id: string, label = 'Account'): LockedAccount {
  const a = map.get(id);
  if (!a) throw new AppError(404, `${label} not found`, 'NOT_FOUND');
  if (!a.is_active) throw new AppError(409, `${label} is inactive`, 'INACTIVE');
  return a;
}

// ---------------------------------------------------------------- DEPOSIT
export interface DepositInput {
  accountId: string;
  amount: number;
  description: string;
  initiatedBy: string;
  idempotencyKey: string;
}

export function deposit(i: DepositInput): Promise<OperationResult> {
  const amt = toAmountString(i.amount);
  return runIdempotent(i.initiatedBy, i.idempotencyKey, { op: 'DEPOSIT', account: i.accountId, amt, d: i.description }, async (tx) => {
    const locked = await lockAccounts(tx, [i.accountId], amt);
    need(locked, i.accountId);
    return post(tx, { type: 'DEPOSIT', to: i.accountId, amt, description: i.description, userId: i.initiatedBy, key: i.idempotencyKey });
  });
}

// ------------------------------------------------------------- WITHDRAWAL
export type WithdrawalInput = DepositInput;

export function withdrawal(i: WithdrawalInput): Promise<OperationResult> {
  const amt = toAmountString(i.amount);
  return runIdempotent(i.initiatedBy, i.idempotencyKey, { op: 'WITHDRAWAL', account: i.accountId, amt, d: i.description }, async (tx) => {
    const locked = await lockAccounts(tx, [i.accountId], amt);
    const acc = need(locked, i.accountId);
    if (!acc.can_debit) {
      return refuse(tx, {
        accountId: i.accountId, userId: i.initiatedBy, operation: 'WITHDRAWAL', amt, balance: acc.balance,
        key: i.idempotencyKey, reason: 'Insufficient funds', code: 'INSUFFICIENT_FUNDS',
      });
    }
    return post(tx, { type: 'WITHDRAWAL', from: i.accountId, amt, description: i.description, userId: i.initiatedBy, key: i.idempotencyKey });
  });
}

// --------------------------------------------------------------- TRANSFER
export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  description: string;
  initiatedBy: string;
  idempotencyKey: string;
}

export function transfer(i: TransferInput): Promise<OperationResult> {
  const amt = toAmountString(i.amount);
  if (i.fromAccountId === i.toAccountId) throw new AppError(400, 'Cannot transfer to the same account', 'SAME_ACCOUNT');
  return runIdempotent(
    i.initiatedBy, i.idempotencyKey,
    { op: 'TRANSFER', from: i.fromAccountId, to: i.toAccountId, amt, d: i.description },
    async (tx) => {
      const locked = await lockAccounts(tx, [i.fromAccountId, i.toAccountId], amt);
      const from = need(locked, i.fromAccountId, 'Source account');
      const to = need(locked, i.toAccountId, 'Destination account');
      if (from.currency !== to.currency) throw new AppError(400, 'Currency mismatch between accounts', 'CURRENCY_MISMATCH');
      if (!from.can_debit) {
        return refuse(tx, {
          accountId: i.fromAccountId, userId: i.initiatedBy, operation: 'TRANSFER', amt, balance: from.balance,
          key: i.idempotencyKey, reason: 'Insufficient funds', code: 'INSUFFICIENT_FUNDS',
        });
      }
      return post(tx, {
        type: 'TRANSFER', from: i.fromAccountId, to: i.toAccountId, amt,
        description: i.description, userId: i.initiatedBy, key: i.idempotencyKey,
      });
    }
  );
}

// ------------------------------------------------------------- ADJUSTMENT
export interface AdjustInput {
  accountId: string;
  amount: number; // signed
  description: string;
  initiatedBy: string;
  idempotencyKey: string;
}

/** Admin correction. Still obeys the floor. Positive = credit, negative = debit. */
export function adjust(i: AdjustInput): Promise<OperationResult> {
  const signed = toAmountString(i.amount, true);
  const credit = !signed.startsWith('-');
  const amt = signed.replace('-', '');
  return runIdempotent(i.initiatedBy, i.idempotencyKey, { op: 'ADJUSTMENT', account: i.accountId, signed, d: i.description }, async (tx) => {
    const locked = await lockAccounts(tx, [i.accountId], amt);
    const acc = need(locked, i.accountId);
    if (!credit && !acc.can_debit) {
      return refuse(tx, {
        accountId: i.accountId, userId: i.initiatedBy, operation: 'ADJUSTMENT', amt, balance: acc.balance,
        key: i.idempotencyKey, reason: 'Adjustment would breach the account floor', code: 'INSUFFICIENT_FUNDS',
      });
    }
    return post(tx, {
      type: 'ADJUSTMENT', ...(credit ? { to: i.accountId } : { from: i.accountId }),
      amt, description: i.description, userId: i.initiatedBy, key: i.idempotencyKey,
    });
  });
}

/** Records a refusal that happens before the money transaction (e.g. authorisation). */
export async function recordRefusal(p: {
  accountId: string | null;
  userId: string;
  operation: string;
  amount?: number | null;
  reason: string;
  code: string;
  idempotencyKey?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO refused_attempts (account_id, attempted_by, operation, amount, reason, reason_code, idempotency_key)
    VALUES ((SELECT id FROM accounts WHERE id = ${p.accountId}::uuid), ${p.userId}, ${p.operation}, ${p.amount ?? null}, ${p.reason}, ${p.code}, ${p.idempotencyKey ?? null})`;
}
