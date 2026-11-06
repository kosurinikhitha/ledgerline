import { readFileSync } from 'fs';
import { join } from 'path';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import sql from '../src/db/connection';
import { buildApp } from '../src/app';

export const testSql = sql;
export const uid = () => randomUUID();

export async function resetDatabase() {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sql.unsafe(readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf-8'));
}

export async function seedUsers() {
  const hash = await bcrypt.hash('TestPass123!', 4);
  const mk = async (email: string, name: string, role: string) =>
    (await sql`INSERT INTO users (email, name, password_hash, role) VALUES (${email}, ${name}, ${hash}, ${role}) RETURNING *`)[0];
  return {
    admin: await mk('admin@test.com', 'Test Admin', 'admin'),
    alice: await mk('alice@test.com', 'Alice', 'account_holder'),
    bob: await mk('bob@test.com', 'Bob', 'account_holder'),
    auditor: await mk('auditor@test.com', 'Auditor', 'auditor'),
  };
}

/** Creates an account and funds it through the REAL deposit path so ledger and balance agree. */
export async function createFundedAccount(ownerId: string, funderId: string, balance = 10000, overdraft = 0, name = 'Test Account') {
  const { deposit } = await import('../src/services/transfer.service');
  const [a] = await sql`INSERT INTO accounts (owner_id, name, currency, overdraft_limit) VALUES (${ownerId}, ${name}, 'INR', ${overdraft}) RETURNING *`;
  if (balance > 0) {
    await deposit({ accountId: a.id, amount: balance, description: 'funding', initiatedBy: funderId, idempotencyKey: `fund-${uid()}` });
  }
  return a as { id: string; owner_id: string };
}

export async function balanceOf(accountId: string): Promise<number> {
  const [r] = await sql`SELECT balance FROM accounts WHERE id = ${accountId}`;
  return parseFloat(r.balance);
}

/** The full integrity proof: used at the end of tests to assert nothing was created or lost. */
export async function assertBooksBalance(): Promise<{ ok: boolean; detail: unknown }> {
  const [c] = await sql`SELECT (ledger_net = total_balance_sum) AS equal, ledger_net, total_balance_sum FROM conservation_check`;
  const mismatches = await sql`SELECT * FROM account_balance_mismatches`;
  const unbalanced = await sql`SELECT * FROM unbalanced_transfers`;
  const chain = await sql`SELECT * FROM ledger_chain_check`;
  const negative = await sql`SELECT id FROM accounts WHERE balance < -overdraft_limit`;
  const ok = c.equal && !mismatches.length && !unbalanced.length && !chain.length && !negative.length;
  return { ok, detail: { c, mismatches, unbalanced, chain, negative } };
}

export async function loginToken(app: Awaited<ReturnType<typeof buildApp>>, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'TestPass123!' } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  return res.json().token;
}

export async function closeDb() {
  await sql.end();
}
