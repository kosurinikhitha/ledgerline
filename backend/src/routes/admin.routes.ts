import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import sql from '../db/connection';
import { requireRole } from '../middleware/auth';
import { getIdempotencyKey } from '../middleware/idempotency';
import { AppError, adjust } from '../services/transfer.service';

const uuid = z.string().uuid();

export async function integrityReport() {
  const [c] = await sql`SELECT *, (ledger_net = total_balance_sum) AS equal FROM conservation_check`;
  const mismatches = await sql`SELECT * FROM account_balance_mismatches`;
  const unbalanced = await sql`SELECT * FROM unbalanced_transfers`;
  const chain = await sql`SELECT * FROM ledger_chain_check`;
  const balanced =
    c.equal === true && mismatches.length === 0 && unbalanced.length === 0 && chain.length === 0;
  return {
    balanced,
    ledger_net: c.ledger_net as string,
    total_balance_sum: c.total_balance_sum as string,
    account_balance_mismatches: mismatches,
    unbalanced_transfers: unbalanced,
    broken_hash_chain_entries: chain,
    checked_at: new Date().toISOString(),
  };
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireRole('admin'));

  app.get('/admin/users', async () =>
    sql`SELECT u.id, u.email, u.name, u.role, u.is_active, u.created_at, COUNT(a.id)::int AS account_count
        FROM users u LEFT JOIN accounts a ON a.owner_id = u.id GROUP BY u.id ORDER BY u.created_at DESC`
  );

  app.patch('/admin/users/:id', async (request) => {
    const id = uuid.parse((request.params as { id: string }).id);
    const parsed = z.object({ is_active: z.boolean() }).safeParse(request.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message, 'VALIDATION');
    if (id === request.user.sub && !parsed.data.is_active) throw new AppError(400, 'You cannot deactivate yourself', 'VALIDATION');
    const [user] = await sql`UPDATE users SET is_active = ${parsed.data.is_active}, updated_at = now()
                             WHERE id = ${id} RETURNING id, email, name, role, is_active`;
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
    await sql`INSERT INTO audit_log (user_id, action, resource, resource_id, details)
              VALUES (${request.user.sub}, 'UPDATE_USER', 'users', ${id}, ${sql.json(parsed.data)})`;
    return user;
  });

  /** Full integrity proof: conservation, per-account balances, transfer balance, hash chain. */
  app.get('/admin/conservation', async () => integrityReport());

  app.get('/admin/audit-log', async (request) => {
    const q = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50', 10) || 50));
    const logs = await sql`SELECT al.*, u.name AS user_name, u.email AS user_email
                           FROM audit_log al LEFT JOIN users u ON al.user_id = u.id
                           ORDER BY al.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM audit_log`;
    return { logs, pagination: { page, limit, total: count } };
  });

  app.get('/admin/refused-attempts', async () =>
    sql`SELECT ra.*, u.name AS user_name, a.name AS account_name
        FROM refused_attempts ra JOIN users u ON ra.attempted_by = u.id
        LEFT JOIN accounts a ON ra.account_id = a.id ORDER BY ra.created_at DESC LIMIT 200`
  );

  /** POST /admin/accounts/:id/adjust — signed correction, idempotent, floor-checked, always in the ledger. */
  app.post('/admin/accounts/:id/adjust', async (request) => {
    const id = uuid.parse((request.params as { id: string }).id);
    const key = getIdempotencyKey(request);
    const parsed = z
      .object({ amount: z.number().refine((n) => n !== 0, 'Amount must be non-zero').refine((n) => Math.abs(n) <= 10_000_000), description: z.string().min(10).max(500) })
      .safeParse(request.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message, 'VALIDATION');
    const out = await adjust({ accountId: id, amount: parsed.data.amount, description: parsed.data.description, initiatedBy: request.user.sub, idempotencyKey: key });
    if (!out.duplicate) {
      await sql`INSERT INTO audit_log (user_id, action, resource, resource_id, details)
                VALUES (${request.user.sub}, 'ADMIN_ADJUSTMENT', 'transactions', ${out.transactionId}, ${sql.json(parsed.data)})`;
    }
    return out;
  });

  app.patch('/admin/accounts/:id/deactivate', async (request) => {
    const id = uuid.parse((request.params as { id: string }).id);
    const [account] = await sql`UPDATE accounts SET is_active = FALSE, updated_at = now() WHERE id = ${id} RETURNING id, name, is_active`;
    if (!account) throw new AppError(404, 'Account not found', 'NOT_FOUND');
    await sql`INSERT INTO audit_log (user_id, action, resource, resource_id, details)
              VALUES (${request.user.sub}, 'DEACTIVATE_ACCOUNT', 'accounts', ${id}, '{}'::jsonb)`;
    return account;
  });
}
