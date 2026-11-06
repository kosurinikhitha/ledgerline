import '../env';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const isLocal = /@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);

export const sql = postgres(DATABASE_URL, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 30,
  ssl: isLocal ? false : 'require',
  onnotice: () => {},
});

export default sql;
