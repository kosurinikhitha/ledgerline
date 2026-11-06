/**
 * Authorisation through the real HTTP layer. Remove canOperateAccount() from a
 * route and the matching test here fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';
import { resetDatabase, seedUsers, createFundedAccount, balanceOf, loginToken, closeDb, testSql, uid } from '../setup';

describe('Authorisation', () => {
  let users: Awaited<ReturnType<typeof seedUsers>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let aliceAcc: { id: string };
  let bobAcc: { id: string };
  let tok: Record<'admin' | 'alice' | 'bob' | 'auditor', string>;

  const call = (token: string, url: string, payload: object, method: 'POST' | 'PATCH' = 'POST') =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': `a-${uid()}` }, payload });

  beforeAll(async () => {
    await resetDatabase();
    users = await seedUsers();
    app = await buildApp();
    aliceAcc = await createFundedAccount(users.alice.id, users.admin.id, 10000);
    bobAcc = await createFundedAccount(users.bob.id, users.admin.id, 10000);
    tok = {
      admin: await loginToken(app, 'admin@test.com'),
      alice: await loginToken(app, 'alice@test.com'),
      bob: await loginToken(app, 'bob@test.com'),
      auditor: await loginToken(app, 'auditor@test.com'),
    };
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("Bob cannot transfer money OUT of Alice's account (even into his own)", async () => {
    const res = await call(tok.bob, '/transactions/transfer', { from_account_id: aliceAcc.id, to_account_id: bobAcc.id, amount: 100 });
    expect(res.statusCode).toBe(403);
    expect(await balanceOf(aliceAcc.id)).toBe(10000);
    expect(await balanceOf(bobAcc.id)).toBe(10000);
  });

  it("Bob cannot withdraw from or deposit to Alice's account", async () => {
    expect((await call(tok.bob, '/transactions/withdrawal', { account_id: aliceAcc.id, amount: 100 })).statusCode).toBe(403);
    expect((await call(tok.bob, '/transactions/deposit', { account_id: aliceAcc.id, amount: 100 })).statusCode).toBe(403);
    expect(await balanceOf(aliceAcc.id)).toBe(10000);
  });

  it('the denied attempt is recorded as a refused attempt on the victim account', async () => {
    const rows = await testSql`SELECT * FROM refused_attempts WHERE account_id = ${aliceAcc.id} AND reason_code = 'FORBIDDEN' AND attempted_by = ${users.bob.id}`;
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('Alice CAN move her own money', async () => {
    const res = await call(tok.alice, '/transactions/transfer', { from_account_id: aliceAcc.id, to_account_id: bobAcc.id, amount: 100 });
    expect(res.statusCode).toBe(200);
    expect(await balanceOf(aliceAcc.id)).toBe(9900);
  });

  it('an auditor can read everything but can never move money', async () => {
    expect((await call(tok.auditor, '/transactions/deposit', { account_id: aliceAcc.id, amount: 100 })).statusCode).toBe(403);
    expect((await call(tok.auditor, '/transactions/withdrawal', { account_id: aliceAcc.id, amount: 100 })).statusCode).toBe(403);
    expect((await call(tok.auditor, '/transactions/transfer', { from_account_id: aliceAcc.id, to_account_id: bobAcc.id, amount: 1 })).statusCode).toBe(403);
    expect((await call(tok.auditor, `/admin/accounts/${aliceAcc.id}/adjust`, { amount: 100, description: 'auditor tries to adjust' })).statusCode).toBe(403);
    const read = await app.inject({ method: 'GET', url: '/auditor/ledger', headers: { authorization: `Bearer ${tok.auditor}` } });
    expect(read.statusCode).toBe(200);
  });

  it('a holder cannot reach admin or auditor endpoints', async () => {
    for (const url of ['/admin/users', '/admin/conservation', '/auditor/ledger']) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok.alice}` } });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("Bob cannot read Alice's account or statement; unauthenticated requests get 401", async () => {
    expect((await app.inject({ method: 'GET', url: `/accounts/${aliceAcc.id}`, headers: { authorization: `Bearer ${tok.bob}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/accounts/${aliceAcc.id}/statement`, headers: { authorization: `Bearer ${tok.bob}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/accounts' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/transactions/transfer', payload: {} })).statusCode).toBe(401);
  });

  it('a holder cannot grant themselves an overdraft (on create)', async () => {
    const res = await call(tok.alice, '/accounts', { name: 'Free credit', overdraft_limit: 1000000 });
    expect(res.statusCode).toBe(403);
    const ok = await call(tok.alice, '/accounts', { name: 'Normal' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().overdraft_limit).toBe('0.0000');
  });

  it('a holder cannot create an account owned by someone else, or grant themselves permissions', async () => {
    expect((await call(tok.alice, '/accounts', { name: 'Hijack', owner_id: users.bob.id })).statusCode).toBe(403);
    expect((await call(tok.alice, `/accounts/${bobAcc.id}/permissions`, { user_id: users.alice.id, can_transfer: true })).statusCode).toBe(403);
  });

  it('an explicit per-account grant works only for the granted operation', async () => {
    const grant = await call(tok.admin, `/accounts/${bobAcc.id}/permissions`, { user_id: users.alice.id, can_view: true, can_deposit: true });
    expect(grant.statusCode).toBe(201);
    expect((await call(tok.alice, '/transactions/deposit', { account_id: bobAcc.id, amount: 5 })).statusCode).toBe(200);
    expect((await call(tok.alice, '/transactions/withdrawal', { account_id: bobAcc.id, amount: 5 })).statusCode).toBe(403);
    expect((await call(tok.alice, '/transactions/transfer', { from_account_id: bobAcc.id, to_account_id: aliceAcc.id, amount: 5 })).statusCode).toBe(403);
  });

  it('a deactivated user is locked out immediately, even with a still-valid token', async () => {
    await call(tok.admin, `/admin/users/${users.bob.id}`, { is_active: false }, 'PATCH');
    const res = await app.inject({ method: 'GET', url: '/accounts', headers: { authorization: `Bearer ${tok.bob}` } });
    expect(res.statusCode).toBe(401);
    expect((await call(tok.bob, '/transactions/withdrawal', { account_id: bobAcc.id, amount: 1 })).statusCode).toBe(401);
  });

  it('input that tries to create money is rejected (negative, zero, NaN-ish, too many decimals)', async () => {
    for (const amount of [-100, 0, 0.001, 1e12]) {
      const res = await call(tok.alice, '/transactions/deposit', { account_id: aliceAcc.id, amount });
      expect(res.statusCode, String(amount)).toBe(400);
    }
    const s = await call(tok.alice, '/transactions/deposit', { account_id: aliceAcc.id, amount: '100' });
    expect(s.statusCode).toBe(400);
    expect(await balanceOf(aliceAcc.id)).toBe(9900);
  });
});
