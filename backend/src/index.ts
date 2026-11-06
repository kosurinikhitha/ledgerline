import { buildApp } from './app';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

buildApp()
  .then((app) => app.listen({ port: PORT, host: '0.0.0.0' }))
  .then((address) => console.log(`LedgerLine API listening at ${address}`))
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
