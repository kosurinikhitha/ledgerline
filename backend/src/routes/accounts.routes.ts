import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sql from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../services/transfer.service';

const uuid = z.string().uuid();

const createAccountSchema = z.object({
  name: z.string().min(2).max(100),
  currency: z.string().length(3).default('INR'),
  overdraft_limit: z.number().min(0).max(10_000_000).optional(),
  owner_id: uuid.optional(),
});

/** Admin and auditor may view everything; holders only accounts they own or were granted. */
export async function canViewAccount(userId: string, role: string, accountId: string): Promise<boolean> {
  if (role === 'admin' || role === 'auditor') return true;
  const rows = await sql`
    SELECT 1 FROM accounts WHERE id = ${accountId} AND owner_id = ${userId}
    UNION ALL
    SELECT 1 FROM account_permissions WHERE account_id = ${accountId} AND user_id = ${userId} AND can_view = TRUE`;
  return rows.length > 0;
}

/** Decided by the server on every request. Auditors can never move money. */
export async function canOperateAccount(
  userId: string,
  role: string,
  accountId: string,
  operation: 'deposit' | 'withdraw' | 'transfer'
): Promise<boolean> {
  if (role === 'admin') return true;
  if (role !== 'account_holder') return false;
  const owned = await sql`SELECT 1 FROM accounts WHERE id = ${accountId} AND owner_id = ${userId}`;
  if (owned.length > 0) return true;
  const col = { deposit: 'can_deposit', withdraw: 'can_withdraw', transfer: 'can_transfer' }[operation];
  const perm = await sql`
    SELECT 1 FROM account_permissions WHERE account_id = ${accountId} AND user_id = ${userId} AND ${sql(col)} = TRUE`;
  return perm.length > 0;
}

export default async function accountRoutes(app: FastifyInstance) {
  /** GET /accounts */
  app.get('/accounts', { preHandler: authenticate }, async (request) => {
    const { sub: userId, role } = request.user;
    if (role === 'admin' || role === 'auditor') {
      return sql`SELECT a.*, u.name AS owner_name, u.email AS owner_email
                 FROM accounts a JOIN users u ON a.owner_id = u.id ORDER BY a.created_at DESC`;
    }
    return sql`
      SELECT a.*, u.name AS owner_name, u.email AS owner_email
      FROM accounts a JOIN users u ON a.owner_id = u.id
      WHERE a.owner_id = ${userId}
         OR EXISTS (SELECT 1 FROM account_permissions ap WHERE ap.account_id = a.id AND ap.user_id = ${userId} AND ap.can_view)
      ORDER BY a.created_at DESC`;
  });

  /**
   * GET /accounts/directory  — id/name/owner only, so a holder can pick a transfer
   * destination without seeing other people's balances.
   */
  app.get('/accounts/directory', { preHandler: requireRole('admin', 'account_holder') }, async () => {
    return sql`SELECT a.id, a.name, a.currency, u.name AS owner_name
               FROM accounts a JOIN users u ON a.owner_id = u.id WHERE a.is_active ORDER BY u.name, a.name`;
  });

  /** POST /accounts  — creates an empty account. No money moves. */
  app.post('/accounts', { preHandler: requireRole('admin', 'account_holder') }, async (request, reply) => {
    const { sub: userId, role } = request.user;
    const parsed = createAccountSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message, 'VALIDATION');
    const { name, currency, overdraft_limit, owner_id } = parsed.data;

    // Only an administrator can grant credit. A holder must never authorise their own overdraft.
    if (role !== 'admin' && (overdraft_limit ?? 0) > 0) {
      throw new AppError(403, 'Only an administrator can set an overdraft limit', 'FORBIDDEN');
    }
    if (role !== 'admin' && owner_id && owner_id !== userId) {
      throw new AppError(403, 'Cannot create accounts for other users', 'FORBIDDEN');
    }
    const ownerId = role === 'admin' && owner_id ? owner_id : userId;

    try {
      const [account] = await sql`
        INSERT INTO accounts (owner_id, name, currency, overdraft_limit)
        VALUES (${ownerId}, ${name}, ${currency.toUpperCase()}, ${overdraft_limit ?? 0}) RETURNING *`;
      await sql`INSERT INTO audit_log (user_id, action, resource, resource_id, details)
                VALUES (${userId}, 'CREATE_ACCOUNT', 'accounts', ${account.id}, ${sql.json({ name, owner_id: ownerId, overdraft_limit: overdraft_limit ?? 0 })})`;
      return reply.status(201).send(account);
    } catch (err) {
      if ((err as { code?: string }).code === '23503') throw new AppError(400, 'Owner does not exist', 'VALIDATION');
      throw err;
    }
  });

  /** GET /accounts/:id */
  app.get('/accounts/:id', { preHandler: authenticate }, async (request) => {
    const id = uuid.parse((request.params as { id: string }).id);
    const { sub: userId, role } = request.user;
    if (!(await canViewAccount(userId, role, id))) throw new AppError(403, 'Access denied to this account', 'FORBIDDEN');
    const [account] = await sql`SELECT a.*, u.name AS owner_name, u.email AS owner_email
                                FROM accounts a JOIN users u ON a.owner_id = u.id WHERE a.id = ${id}`;
    if (!account) throw new AppError(404, 'Account not found', 'NOT_FOUND');
    return account;
  });

  /**
   * GET /accounts/:id/statement
   * Postings (debit/credit with running balance and initiator) and refused attempts.
   */
  app.get('/accounts/:id/statement', { preHandler: authenticate }, async (request) => {
    const id = uuid.parse((request.params as { id: string }).id);
    const { sub: userId, role } = request.user;
    const q = request.query as { page?: string; limit?: string };
    if (!(await canViewAccount(userId, role, id))) throw new AppError(403, 'Access denied to this account', 'FORBIDDEN');

    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10) || 50));
    const offset = (page - 1) * limit;

    const entries = await sql`
      SELECT le.id, le.seq, le.transaction_id, le.entry_type, le.amount, le.running_balance, le.description,
             le.created_at, u.name AS initiated_by_name, t.type AS transaction_type,
             t.from_account_id, t.to_account_id
      FROM ledger_entries le
      JOIN transactions t ON t.id = le.transaction_id
      JOIN users u ON u.id = le.initiated_by
      WHERE le.account_id = ${id}
      ORDER BY le.seq DESC LIMIT ${limit} OFFSET ${offset}`;

    const refused = await sql`
      SELECT ra.id, ra.operation, ra.amount, ra.reason, ra.reason_code, ra.balance_at_attempt,
             ra.created_at, u.name AS attempted_by_name
      FROM refused_attempts ra JOIN users u ON u.id = ra.attempted_by
      WHERE ra.account_id = ${id}
      ORDER BY ra.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM ledger_entries WHERE account_id = ${id}`;
    return {
      entries,
      refused_attempts: refused,
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    };
  });

  /** GET /accounts/:id/permissions  (admin) */
  app.get('/accounts/:id/permissions', { preHandler: requireRole('admin') }, async (request) => {
    const id = uuid.parse((request.params as { id: string }).id);
    return sql`SELECT ap.*, u.name AS user_name, u.email AS user_email
               FROM account_permissions ap JOIN users u ON ap.user_id = u.id WHERE ap.account_id = ${id}`;
  });

  /** POST /accounts/:id/permissions  (admin) */
  app.post('/accounts/:id/permissions', { preHandler: requireRole('admin') }, async (request, reply) => {
    const id = uuid.parse((request.params as { id: string }).id);
    const parsed = z
      .object({
        user_id: uuid,
        can_deposit: z.boolean().default(false),
        can_withdraw: z.boolean().default(false),
        can_transfer: z.boolean().default(false),
        can_view: z.boolean().default(true),
      })
      .safeParse(request.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message, 'VALIDATION');
    const p = parsed.data;
    const [perm] = await sql`
      INSERT INTO account_permissions (account_id, user_id, can_deposit, can_withdraw, can_transfer, can_view, granted_by)
      VALUES (${id}, ${p.user_id}, ${p.can_deposit}, ${p.can_withdraw}, ${p.can_transfer}, ${p.can_view}, ${request.user.sub})
      ON CONFLICT (account_id, user_id) DO UPDATE SET
        can_deposit = EXCLUDED.can_deposit, can_withdraw = EXCLUDED.can_withdraw,
        can_transfer = EXCLUDED.can_transfer, can_view = EXCLUDED.can_view, granted_by = EXCLUDED.granted_by
      RETURNING *`;
    await sql`INSERT INTO audit_log (user_id, action, resource, resource_id, details)
              VALUES (${request.user.sub}, 'GRANT_PERMISSION', 'accounts', ${id}, ${sql.json(p)})`;
    return reply.status(201).send(perm);
  });
}
