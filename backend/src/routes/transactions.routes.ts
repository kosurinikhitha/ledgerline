import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import sql from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { getIdempotencyKey } from '../middleware/idempotency';
import { AppError, deposit, withdrawal, transfer, recordRefusal } from '../services/transfer.service';
import { canOperateAccount } from './accounts.routes';

const amount = z
  .number()
  .positive()
  .max(10_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Amount may have at most 2 decimal places');
const description = (d: string) => z.string().max(500).default(d);
const uuid = z.string().uuid();

const depositSchema = z.object({ account_id: uuid, amount, description: description('Deposit') });
const withdrawalSchema = z.object({ account_id: uuid, amount, description: description('Withdrawal') });
const transferSchema = z.object({
  from_account_id: uuid,
  to_account_id: uuid,
  amount,
  description: description('Transfer'),
});

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError(400, r.error.issues[0].message, 'VALIDATION');
  return r.data;
}

/** Checks permission on the server; a denial is itself recorded as a refused attempt. */
async function authorise(
  request: FastifyRequest,
  accountId: string,
  op: 'deposit' | 'withdraw' | 'transfer',
  operation: string,
  amt: number,
  key: string
): Promise<void> {
  const { sub: userId, role } = request.user;
  if (await canOperateAccount(userId, role, accountId, op)) return;
  await recordRefusal({
    accountId, userId, operation, amount: amt, idempotencyKey: key,
    reason: `Not authorised to ${op} on this account`, code: 'FORBIDDEN',
  });
  throw new AppError(403, `You are not authorised to ${op} on this account`, 'FORBIDDEN');
}

async function audit(userId: string, action: string, id: string, details: object) {
  await sql`INSERT INTO audit_log (user_id, action, resource, resource_id, details)
            VALUES (${userId}, ${action}, 'transactions', ${id}, ${sql.json(details as never)})`;
}

export default async function transactionRoutes(app: FastifyInstance) {
  /** POST /transactions/deposit — external money IN. Total of all balances rises by amount. */
  app.post('/transactions/deposit', { preHandler: requireRole('admin', 'account_holder') }, async (request) => {
    const key = getIdempotencyKey(request);
    const b = parse(depositSchema, request.body);
    await authorise(request, b.account_id, 'deposit', 'DEPOSIT', b.amount, key);
    const out = await deposit({
      accountId: b.account_id, amount: b.amount, description: b.description,
      initiatedBy: request.user.sub, idempotencyKey: key,
    });
    if (!out.duplicate) await audit(request.user.sub, 'DEPOSIT', out.transactionId, { account_id: b.account_id, amount: out.amount });
    return out;
  });

  /** POST /transactions/withdrawal — external money OUT. Total of all balances falls by amount. */
  app.post('/transactions/withdrawal', { preHandler: requireRole('admin', 'account_holder') }, async (request) => {
    const key = getIdempotencyKey(request);
    const b = parse(withdrawalSchema, request.body);
    await authorise(request, b.account_id, 'withdraw', 'WITHDRAWAL', b.amount, key);
    const out = await withdrawal({
      accountId: b.account_id, amount: b.amount, description: b.description,
      initiatedBy: request.user.sub, idempotencyKey: key,
    });
    if (!out.duplicate) await audit(request.user.sub, 'WITHDRAWAL', out.transactionId, { account_id: b.account_id, amount: out.amount });
    return out;
  });

  /** POST /transactions/transfer — internal. Total of all balances is unchanged. */
  app.post('/transactions/transfer', { preHandler: requireRole('admin', 'account_holder') }, async (request) => {
    const key = getIdempotencyKey(request);
    const b = parse(transferSchema, request.body);
    await authorise(request, b.from_account_id, 'transfer', 'TRANSFER', b.amount, key);
    const out = await transfer({
      fromAccountId: b.from_account_id, toAccountId: b.to_account_id, amount: b.amount,
      description: b.description, initiatedBy: request.user.sub, idempotencyKey: key,
    });
    if (!out.duplicate) {
      await audit(request.user.sub, 'TRANSFER', out.transactionId, {
        from_account_id: b.from_account_id, to_account_id: b.to_account_id, amount: out.amount,
      });
    }
    return out;
  });

  /** GET /transactions/:id */
  app.get('/transactions/:id', { preHandler: authenticate }, async (request) => {
    const id = uuid.parse((request.params as { id: string }).id);
    const { sub: userId, role } = request.user;

    const [tx] = await sql`
      SELECT t.*, u.name AS initiated_by_name, fa.name AS from_account_name, ta.name AS to_account_name
      FROM transactions t
      JOIN users u ON t.initiated_by = u.id
      LEFT JOIN accounts fa ON t.from_account_id = fa.id
      LEFT JOIN accounts ta ON t.to_account_id = ta.id
      WHERE t.id = ${id}`;
    if (!tx) throw new AppError(404, 'Transaction not found', 'NOT_FOUND');

    if (role !== 'admin' && role !== 'auditor') {
      const ids = [tx.from_account_id, tx.to_account_id].filter(Boolean) as string[];
      const rows = await sql`
        SELECT 1 FROM accounts WHERE id = ANY(${ids}::uuid[]) AND owner_id = ${userId}
        UNION ALL
        SELECT 1 FROM account_permissions WHERE account_id = ANY(${ids}::uuid[]) AND user_id = ${userId} AND can_view`;
      if (rows.length === 0) throw new AppError(403, 'Access denied', 'FORBIDDEN');
    }
    const entries = await sql`SELECT * FROM ledger_entries WHERE transaction_id = ${id} ORDER BY seq`;
    return { ...tx, ledger_entries: entries };
  });

  /** GET /transactions */
  app.get('/transactions', { preHandler: authenticate }, async (request) => {
    const { sub: userId, role } = request.user;
    const q = request.query as { page?: string; limit?: string; type?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '20', 10) || 20));
    const offset = (page - 1) * limit;
    const type = q.type && ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'ADJUSTMENT'].includes(q.type) ? q.type : null;

    if (role === 'admin' || role === 'auditor') {
      return sql`SELECT t.*, u.name AS initiated_by_name FROM transactions t JOIN users u ON t.initiated_by = u.id
                 WHERE (${type}::text IS NULL OR t.type = ${type})
                 ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    }
    return sql`
      SELECT t.*, u.name AS initiated_by_name
      FROM transactions t JOIN users u ON t.initiated_by = u.id
      WHERE (t.from_account_id IN (SELECT id FROM accounts WHERE owner_id = ${userId}
                                   UNION SELECT account_id FROM account_permissions WHERE user_id = ${userId} AND can_view)
          OR t.to_account_id IN (SELECT id FROM accounts WHERE owner_id = ${userId}
                                   UNION SELECT account_id FROM account_permissions WHERE user_id = ${userId} AND can_view))
        AND (${type}::text IS NULL OR t.type = ${type})
      ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  });
}
