import bcrypt from 'bcryptjs';
import sql from './connection';
import { deposit } from '../services/transfer.service';

/**
 * Idempotent seed: safe to run on every deploy. Opening balances are real DEPOSIT
 * postings (so the ledger explains every rupee), keyed so they only happen once.
 */
async function ensureUser(email: string, name: string, role: string, hash: string): Promise<string> {
  // The demo users are public on purpose, so anyone could deactivate them. Re-running the
  // seed (every deploy and every wake-up of the free instance) restores them.
  const [u] = await sql`
    INSERT INTO users (email, name, password_hash, role) VALUES (${email}, ${name}, ${hash}, ${role})
    ON CONFLICT (email) DO UPDATE SET is_active = TRUE, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
    RETURNING id`;
  return u.id as string;
}

async function ensureAccount(ownerId: string, name: string, overdraft: number): Promise<string> {
  const [existing] = await sql`SELECT id FROM accounts WHERE owner_id = ${ownerId} AND name = ${name}`;
  if (existing) {
    await sql`UPDATE accounts SET is_active = TRUE WHERE id = ${existing.id}`;
    return existing.id as string;
  }
  const [a] = await sql`INSERT INTO accounts (owner_id, name, currency, overdraft_limit)
                        VALUES (${ownerId}, ${name}, 'INR', ${overdraft}) RETURNING id`;
  return a.id as string;
}

async function seed() {
  console.log('Seeding database...');
  const hash = await bcrypt.hash('Password123!', 10);

  const adminId = await ensureUser('admin@ledgerline.dev', 'Alice Admin', 'admin', hash);
  const bobId = await ensureUser('bob@ledgerline.dev', 'Bob Holder', 'account_holder', hash);
  const carolId = await ensureUser('carol@ledgerline.dev', 'Carol Holder', 'account_holder', hash);
  await ensureUser('auditor@ledgerline.dev', 'Dave Auditor', 'auditor', hash);

  const accounts: Array<[string, string, number, number, string]> = [
    [bobId, 'Bob Main Account', 0, 50000, 'seed-open-bob-main'],
    [bobId, 'Bob Savings', 0, 100000, 'seed-open-bob-savings'],
    [carolId, 'Carol Main Account', 5000, 75000, 'seed-open-carol-main'],
    [adminId, 'Operations Account', 0, 1000000, 'seed-open-admin-ops'],
  ];
  for (const [owner, name, overdraft, opening, key] of accounts) {
    const id = await ensureAccount(owner, name, overdraft);
    await deposit({ accountId: id, amount: opening, description: 'Opening balance', initiatedBy: adminId, idempotencyKey: key });
  }

  console.log('Seed complete. Password for all users: Password123!');
  console.log('  admin@ledgerline.dev  bob@ledgerline.dev  carol@ledgerline.dev  auditor@ledgerline.dev');
  await sql.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
