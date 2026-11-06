/**
 * Concurrency: these tests fire requests at the same instant (Promise.all) and then
 * check the DATABASE, not just the responses. Remove FOR UPDATE from lockAccounts()
 * and the overdraft / lost-update tests below fail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';
import { resetDatabase, seedUsers, createFundedAccount, balanceOf, assertBooksBalance, loginToken, closeDb, testSql, uid } from '../setup';
import { withdrawal, transfer, deposit } from '../../src/services/transfer.service';

type Users = Awaited<ReturnType<typeof seedUsers>>;

describe('Concurrency', () => {
  let users: Users;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await resetDatabase();
    users = await seedUsers();
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const settle = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);

  it('20 simultaneous withdrawals of 1000 from a 10000 account: exactly 10 succeed, balance is exactly 0', async () => {
    const acc = await createFundedAccount(users.alice.id, users.admin.id, 10000);
    const results = await settle(
      Array.from({ length: 20 }, () =>
        withdrawal({ accountId: acc.id, amount: 1000, description: 'race', initiatedBy: users.alice.id, idempotencyKey: `w-${uid()}` })
      )
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toBe(10);
    expect(refused).toHaveLength(10);
    expect(await balanceOf(acc.id)).toBe(0);

    const [{ n }] = await testSql`SELECT COUNT(*)::int AS n FROM refused_attempts WHERE account_id = ${acc.id} AND reason_code = 'INSUFFICIENT_FUNDS'`;
    expect(n).toBe(10); // every refusal is on the record
    expect((await assertBooksBalance()).ok).toBe(true);
  });

  it('same race through the HTTP API: 15 parallel requests, 10 x 200, 5 x 422, balance never negative', async () => {
    const acc = await createFundedAccount(users.alice.id, users.admin.id, 10000);
    const token = await loginToken(app, 'alice@test.com');
    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        app.inject({
          method: 'POST', url: '/transactions/withdrawal',
          headers: { authorization: `Bearer ${token}`, 'idempotency-key': `h-${uid()}` },
          payload: { account_id: acc.id, amount: 1000 },
        })
      )
    );
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 422)).toHaveLength(5);
    expect(await balanceOf(acc.id)).toBe(0);
  });

  it('overdraft limit is enforced under a race: balance 500, limit 1000, 10 x 300 => exactly 5 succeed, floor -1000', async () => {
    const acc = await createFundedAccount(users.alice.id, users.admin.id, 500, 1000);
    const results = await settle(
      Array.from({ length: 10 }, () =>
        withdrawal({ accountId: acc.id, amount: 300, description: 'od', initiatedBy: users.alice.id, idempotencyKey: `od-${uid()}` })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await balanceOf(acc.id)).toBe(-1000);
  });

  it('two transfers that together would overdraw the source: exactly one wins', async () => {
    const src = await createFundedAccount(users.alice.id, users.admin.id, 1000);
    const d1 = await createFundedAccount(users.bob.id, users.admin.id, 0);
    const d2 = await createFundedAccount(users.bob.id, users.admin.id, 0);
    const results = await settle([
      transfer({ fromAccountId: src.id, toAccountId: d1.id, amount: 800, description: 't', initiatedBy: users.alice.id, idempotencyKey: `t-${uid()}` }),
      transfer({ fromAccountId: src.id, toAccountId: d2.id, amount: 800, description: 't', initiatedBy: users.alice.id, idempotencyKey: `t-${uid()}` }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(src.id)).toBe(200);
    expect((await balanceOf(d1.id)) + (await balanceOf(d2.id))).toBe(800);
  });

  it('opposite-direction transfers between the same two accounts do not deadlock and conserve money', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 5000);
    const b = await createFundedAccount(users.bob.id, users.admin.id, 5000);
    const results = await settle(
      Array.from({ length: 40 }, (_, i) =>
        transfer({
          fromAccountId: i % 2 ? a.id : b.id, toAccountId: i % 2 ? b.id : a.id, amount: 100,
          description: 'ping-pong', initiatedBy: users.alice.id, idempotencyKey: `pp-${uid()}`,
        })
      )
    );
    // every request must complete cleanly (no deadlock errors)
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await balanceOf(a.id)) + (await balanceOf(b.id))).toBe(10000);
    expect((await assertBooksBalance()).ok).toBe(true);
  });

  it('mixed storm of deposits, withdrawals and transfers keeps every invariant', async () => {
    const accs = [
      await createFundedAccount(users.alice.id, users.admin.id, 3000),
      await createFundedAccount(users.bob.id, users.admin.id, 3000),
      await createFundedAccount(users.alice.id, users.admin.id, 3000),
    ];
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      const a = accs[i % 3], b = accs[(i + 1) % 3];
      const k = `storm-${uid()}`;
      if (i % 3 === 0) ops.push(transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 700, description: 's', initiatedBy: users.alice.id, idempotencyKey: k }));
      else if (i % 3 === 1) ops.push(withdrawal({ accountId: a.id, amount: 500, description: 's', initiatedBy: users.alice.id, idempotencyKey: k }));
      else ops.push(deposit({ accountId: a.id, amount: 250.5, description: 's', initiatedBy: users.alice.id, idempotencyKey: k }));
    }
    await settle(ops);
    const report = await assertBooksBalance();
    expect(report.ok, JSON.stringify(report.detail)).toBe(true);
  });
});
