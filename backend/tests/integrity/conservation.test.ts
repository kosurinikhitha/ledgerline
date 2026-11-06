/**
 * Conservation + ledger integrity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDatabase, seedUsers, createFundedAccount, balanceOf, assertBooksBalance, closeDb, testSql, uid } from '../setup';
import { deposit, withdrawal, transfer, adjust } from '../../src/services/transfer.service';

async function total(): Promise<number> {
  const [r] = await testSql`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts`;
  return parseFloat(r.s);
}

describe('Conservation', () => {
  let users: Awaited<ReturnType<typeof seedUsers>>;
  beforeAll(async () => {
    await resetDatabase();
    users = await seedUsers();
  });

  it('a transfer changes the total of all balances by exactly zero', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 10000);
    const b = await createFundedAccount(users.bob.id, users.admin.id, 10000);
    const before = await total();
    await transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 3000.25, description: 't', initiatedBy: users.alice.id, idempotencyKey: `c-${uid()}` });
    expect(await total()).toBe(before);
    expect(await balanceOf(a.id)).toBe(6999.75);
    expect(await balanceOf(b.id)).toBe(13000.25);
  });

  it('deposits and withdrawals change the total by exactly the external flow', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 1000);
    const t0 = await total();
    await deposit({ accountId: a.id, amount: 500, description: 'in', initiatedBy: users.alice.id, idempotencyKey: `c-${uid()}` });
    expect(await total()).toBe(t0 + 500);
    await withdrawal({ accountId: a.id, amount: 200, description: 'out', initiatedBy: users.alice.id, idempotencyKey: `c-${uid()}` });
    expect(await total()).toBe(t0 + 300);
  });

  it('a refused transfer changes no balance and writes no postings', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 100);
    const b = await createFundedAccount(users.bob.id, users.admin.id, 100);
    const [{ n: before }] = await testSql`SELECT COUNT(*)::int AS n FROM ledger_entries`;
    await expect(
      transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 5000, description: 'x', initiatedBy: users.alice.id, idempotencyKey: `c-${uid()}` })
    ).rejects.toMatchObject({ statusCode: 422 });
    const [{ n: after }] = await testSql`SELECT COUNT(*)::int AS n FROM ledger_entries`;
    expect(after).toBe(before);
    expect(await balanceOf(a.id)).toBe(100);
    expect(await balanceOf(b.id)).toBe(100);
  });

  it('a transfer to a missing account fails atomically: the debit is NOT left behind', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 1000);
    await expect(
      transfer({ fromAccountId: a.id, toAccountId: uid(), amount: 100, description: 'x', initiatedBy: users.alice.id, idempotencyKey: `c-${uid()}` })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await balanceOf(a.id)).toBe(1000);
  });

  it('decimal money is exact (0.10 + 0.20 == 0.30, no float drift over 1000 postings)', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 0);
    for (let i = 0; i < 1000; i++) {
      await deposit({ accountId: a.id, amount: 0.1, description: 'tick', initiatedBy: users.alice.id, idempotencyKey: `d-${uid()}` });
    }
    const [r] = await testSql`SELECT balance::text AS b FROM accounts WHERE id = ${a.id}`;
    expect(r.b).toBe('100.0000');
  }, 120000);

  it('every transfer has exactly two postings (one debit, one credit) of equal amount', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 1000);
    const b = await createFundedAccount(users.bob.id, users.admin.id, 0);
    const r = await transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 123.45, description: 'x', initiatedBy: users.alice.id, idempotencyKey: `c-${uid()}` });
    const rows = await testSql`SELECT entry_type, amount::text, running_balance::text FROM ledger_entries WHERE transaction_id = ${r.transactionId} ORDER BY seq`;
    expect(rows.map((x) => x.entry_type)).toEqual(['DEBIT', 'CREDIT']);
    expect(rows[0].amount).toBe(rows[1].amount);
    expect(rows[0].running_balance).toBe('876.5500');
    expect(rows[1].running_balance).toBe('123.4500');
  });

  it('admin adjustments are postings too, and still cannot breach the floor', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 100);
    await adjust({ accountId: a.id, amount: 50, description: 'credit correction ref 1', initiatedBy: users.admin.id, idempotencyKey: `adj-${uid()}` });
    expect(await balanceOf(a.id)).toBe(150);
    await expect(
      adjust({ accountId: a.id, amount: -1000, description: 'debit correction ref 2', initiatedBy: users.admin.id, idempotencyKey: `adj-${uid()}` })
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await balanceOf(a.id)).toBe(150);
  });

  it('the database itself refuses a balance below the floor (backstop if the app is bypassed)', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 100);
    await expect(testSql`UPDATE accounts SET balance = -1 WHERE id = ${a.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('after everything above, all proof views are clean', async () => {
    const r = await assertBooksBalance();
    expect(r.ok, JSON.stringify(r.detail)).toBe(true);
  });
});

describe('Ledger tamper resistance', () => {
  let users: Awaited<ReturnType<typeof seedUsers>>;
  let accId: string;
  beforeAll(async () => {
    await resetDatabase();
    users = await seedUsers();
    accId = (await createFundedAccount(users.alice.id, users.admin.id, 1000)).id;
    await withdrawal({ accountId: accId, amount: 100, description: 'w', initiatedBy: users.alice.id, idempotencyKey: `t-${uid()}` });
    await testSql`INSERT INTO audit_log (user_id, action) VALUES (${users.admin.id}, 'TEST')`;
    // create one real refusal so the append-only trigger has a row to act on
    await withdrawal({ accountId: accId, amount: 999999, description: 'refused', initiatedBy: users.alice.id, idempotencyKey: `t-${uid()}` }).catch(() => undefined);
    const [{ n }] = await testSql`SELECT COUNT(*)::int AS n FROM refused_attempts`;
    expect(n).toBeGreaterThan(0);
  });
  afterAll(closeDb); // last describe in the file: close the shared connection once

  it('UPDATE on a ledger row is rejected', async () => {
    await expect(testSql`UPDATE ledger_entries SET amount = 1 WHERE account_id = ${accId}`).rejects.toThrow(/append-only/);
  });
  it('DELETE on a ledger row is rejected', async () => {
    await expect(testSql`DELETE FROM ledger_entries WHERE account_id = ${accId}`).rejects.toThrow(/append-only/);
  });
  it('TRUNCATE of the ledger is rejected', async () => {
    await expect(testSql`TRUNCATE ledger_entries CASCADE`).rejects.toThrow(/append-only/);
  });
  it('refused_attempts and audit_log are append-only too', async () => {
    await expect(testSql`UPDATE audit_log SET action = 'x'`).rejects.toThrow(/append-only/);
    await expect(testSql`DELETE FROM audit_log`).rejects.toThrow(/append-only/);
    await expect(testSql`DELETE FROM refused_attempts`).rejects.toThrow(/append-only/);
  });

  it('even a privileged user who DISABLES the trigger and edits a row is caught by the hash chain', async () => {
    const before = await testSql`SELECT * FROM ledger_chain_check`;
    expect(before).toHaveLength(0);

    const flagged = await testSql
      .begin(async (tx) => {
        await tx`ALTER TABLE ledger_entries DISABLE TRIGGER enforce_ledger_immutability`;
        await tx`UPDATE ledger_entries SET amount = 1 WHERE account_id = ${accId} AND entry_type = 'DEBIT'`;
        const bad = await tx`SELECT * FROM ledger_chain_check`;
        throw Object.assign(new Error('rollback'), { bad });
      })
      .catch((e: { bad?: unknown[] }) => e.bad);

    expect(flagged && flagged.length).toBeGreaterThan(0); // tampering is detected
    expect(await testSql`SELECT * FROM ledger_chain_check`).toHaveLength(0); // and the test left no damage
  });

  it('a tampered balance is also caught by the per-account reconciliation view', async () => {
    const flagged = await testSql
      .begin(async (tx) => {
        await tx`UPDATE accounts SET balance = balance + 999 WHERE id = ${accId}`;
        const bad = await tx`SELECT * FROM account_balance_mismatches`;
        throw Object.assign(new Error('rollback'), { bad });
      })
      .catch((e: { bad?: unknown[] }) => e.bad);
    expect(flagged && flagged.length).toBe(1);
  });
});
