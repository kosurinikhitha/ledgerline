// Loads backend/.env into process.env when the file exists (local dev).
// On Render the variables come from the dashboard, so a missing file is fine.
try {
  (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile();
} catch {
  /* no .env file: rely on real environment variables */
}
