// Runs before every test file. Points the application (src/db/connection.ts) at the
// TEST database so the service under test and the test helpers use the same DB.
try {
  (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile();
} catch {
  /* no .env */
}
const testUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledgerline_test';
if (!/test/i.test(new URL(testUrl).pathname)) {
  throw new Error(`Refusing to run tests: TEST_DATABASE_URL must point at a database whose name contains "test" (got ${testUrl})`);
}
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : 'test-secret-test-secret-test-secret-123';
