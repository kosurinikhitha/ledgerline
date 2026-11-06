import { readFileSync } from 'fs';
import { join } from 'path';
import sql from './connection';

// schema.sql lives in src/ and is read from there for both ts-node and compiled (dist) runs.
const SCHEMA_PATH = join(__dirname, '..', '..', 'src', 'db', 'schema.sql');

async function migrate() {
  console.log('Running migrations...');
  await sql.unsafe(readFileSync(SCHEMA_PATH, 'utf-8'));
  console.log('Migrations complete.');
  await sql.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
