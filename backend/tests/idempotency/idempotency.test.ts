/**
 * Idempotency: the same key must move money once and return the first answer.
 * Break the ON CONFLICT claim in runIdempotent() and the concurrent test fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';
import { resetDatabase, seedUsers, createFundedAccount, balanceOf, assertBooksBalance, loginToken, closeDb, testSql, uid } from '../setup';
import { withdrawal, transfer, deposit } from '../../src/services/transfer.service';

describe('Idempotency', () => {
  let users: Awaited<ReturnType<typeof seedUsers>>;
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

  it('replaying a transfer returns the first result and moves money once', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 5000);
    const b = await createFundedAccount(users.bob.id, users.admin.id, 0);
    const key = `rep-${uid()}`;
    const input = { fromAccountId: a.id, toAccountId: b.id, amount: 200, description: 'rent', initiatedBy: users.alice.id, idempotencyKey: key };

    const first = await transfer(input);
    const second = await transfer(input);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await balanceOf(a.id)).toBe(4800);
    expect(await balanceOf(b.id)).toBe(200);

    const [{ n }] = await testSql`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = ${key}`;
    expect(n).toBe(1);
    const [{ r }] = await testSql`SELECT COUNT(*)::int AS r FROM idempotency_replays WHERE key = ${key} AND outcome = 'REPLAYED'`;
    expect(r).toBe(1); // the duplicate is visible in the data
  });

  it('10 concurrent requests with the SAME key: one transaction, one movement, all get the same answer', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 5000);
    const key = `conc-${uid()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withdrawal({ accountId: a.id, amount: 1000, description: 'double click', initiatedBy: users.alice.id, idempotencyKey: key })
      )
    );
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await balanceOf(a.id)).toBe(4000);
    const [{ n }] = await testSql`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = ${key}`;
    expect(n).toBe(1);
  });

  it('same key through the HTTP API twice (simulated timeout retry): identical body, one debit', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 5000);
    const token = await loginToken(app, 'alice@test.com');
    const call = () =>
      app.inject({
        method: 'POST', url: '/transactions/withdrawal',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'http-retry-key-1' + a.id.slice(0, 8) },
        payload: { account_id: a.id, amount: 750 },
      });
    const r1 = await call();
    const r2 = await call();
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().transactionId).toBe(r1.json().transactionId);
    expect(r1.json().duplicate).toBe(false);
    expect(r2.json().duplicate).toBe(true);
    expect(await balanceOf(a.id)).toBe(4250);
  });

  it('reusing a key for a DIFFERENT request is rejected and moves nothing', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 5000);
    const key = `mismatch-${uid()}`;
    await withdrawal({ accountId: a.id, amount: 100, description: 'x', initiatedBy: users.alice.id, idempotencyKey: key });
    await expect(
      withdrawal({ accountId: a.id, amount: 4000, description: 'x', initiatedBy: users.alice.id, idempotencyKey: key })
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await balanceOf(a.id)).toBe(4900);
  });

  it('keys are scoped per user: another user cannot replay or collide with my key', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 1000);
    const b = await createFundedAccount(users.bob.id, users.admin.id, 1000);
    const key = `shared-${uid()}`;
    const r1 = await withdrawal({ accountId: a.id, amount: 100, description: 'a', initiatedBy: users.alice.id, idempotencyKey: key });
    const r2 = await withdrawal({ accountId: b.id, amount: 100, description: 'b', initiatedBy: users.bob.id, idempotencyKey: key });
    expect(r2.transactionId).not.toBe(r1.transactionId);
    expect(r2.duplicate).toBe(false);
    expect(await balanceOf(b.id)).toBe(900);
  });

  it('a refused request replayed returns the same refusal and does not log a second refusal', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 100);
    const key = `refuse-${uid()}`;
    const input = { accountId: a.id, amount: 500, description: 'too much', initiatedBy: users.alice.id, idempotencyKey: key };
    await expect(withdrawal(input)).rejects.toMatchObject({ statusCode: 422 });
    await expect(withdrawal(input)).rejects.toMatchObject({ statusCode: 422 });
    const [{ n }] = await testSql`SELECT COUNT(*)::int AS n FROM refused_attempts WHERE idempotency_key = ${key}`;
    expect(n).toBe(1);
    expect(await balanceOf(a.id)).toBe(100);
  });

  it('a request missing the Idempotency-Key header is refused outright', async () => {
    const a = await createFundedAccount(users.alice.id, users.admin.id, 100);
    const token = await loginToken(app, 'alice@test.com');
    const res = await app.inject({
      method: 'POST', url: '/transactions/deposit',
      headers: { authorization: `Bearer ${token}` }, payload: { account_id: a.id, amount: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(await balanceOf(a.id)).toBe(100);
  });

  it('retries never break the books', async () => {
    await deposit({ accountId: (await createFundedAccount(users.bob.id, users.admin.id, 0)).id, amount: 5, description: 'x', initiatedBy: users.bob.id, idempotencyKey: `z-${uid()}` });
    expect((await assertBooksBalance()).ok).toBe(true);
  });
});
