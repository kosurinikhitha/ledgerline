import { FastifyInstance } from 'fastify';
import sql from '../db/connection';
import { requireRole } from '../middleware/auth';
import { integrityReport } from './admin.routes';

/** Read-only. Every handler is a SELECT. */
export default async function auditorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireRole('admin', 'auditor'));

  app.get('/auditor/ledger', async (request) => {
    const q = request.query as { account_id?: string; page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50', 10) || 50));
    const accountId = q.account_id && /^[0-9a-f-]{36}$/i.test(q.account_id) ? q.account_id : null;
    const entries = await sql`
      SELECT le.*, u.name AS initiated_by_name, a.name AS account_name, t.type AS transaction_type
      FROM ledger_entries le
      JOIN users u ON le.initiated_by = u.id
      JOIN accounts a ON le.account_id = a.id
      JOIN transactions t ON le.transaction_id = t.id
      WHERE (${accountId}::uuid IS NULL OR le.account_id = ${accountId})
      ORDER BY le.seq DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM ledger_entries WHERE (${accountId}::uuid IS NULL OR account_id = ${accountId})`;
    return { entries, pagination: { page, limit, total: count } };
  });

  app.get('/auditor/conservation', async () => integrityReport());

  app.get('/auditor/all-accounts', async () =>
    sql`SELECT a.*, u.name AS owner_name, u.email AS owner_email FROM accounts a JOIN users u ON a.owner_id = u.id ORDER BY a.created_at`
  );

  app.get('/auditor/refused-attempts', async () =>
    sql`SELECT ra.*, u.name AS user_name, a.name AS account_name
        FROM refused_attempts ra JOIN users u ON ra.attempted_by = u.id
        LEFT JOIN accounts a ON ra.account_id = a.id ORDER BY ra.created_at DESC LIMIT 500`
  );

  /** Stored keys + how many times each was served again. Shows which requests were duplicates. */
  app.get('/auditor/idempotency-keys', async () =>
    sql`SELECT ik.user_id, ik.key, ik.status, ik.response_status, ik.created_at, ik.completed_at, u.name AS user_name,
               (SELECT COUNT(*)::int FROM idempotency_replays r WHERE r.user_id = ik.user_id AND r.key = ik.key AND r.outcome = 'REPLAYED') AS replay_count
        FROM idempotency_keys ik JOIN users u ON ik.user_id = u.id ORDER BY ik.created_at DESC LIMIT 500`
  );
}
