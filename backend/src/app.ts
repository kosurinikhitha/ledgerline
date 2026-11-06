import './env';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import authRoutes from './routes/auth.routes';
import accountRoutes from './routes/accounts.routes';
import transactionRoutes from './routes/transactions.routes';
import adminRoutes from './routes/admin.routes';
import auditorRoutes from './routes/auditor.routes';
import { AppError } from './services/transfer.service';

export async function buildApp() {
  const isTest = process.env.NODE_ENV === 'test';
  const app = Fastify({
    logger: isTest ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  });

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET (at least 32 characters) is required');

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });
  // Generous global limit (so legitimate bursts and concurrent requests are not throttled);
  // /auth/login has its own strict limit.
  await app.register(rateLimit, { max: isTest ? 100000 : 600, timeWindow: '1 minute' });
  await app.register(jwt, { secret: jwtSecret, sign: { expiresIn: '8h' } });

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(transactionRoutes);
  await app.register(adminRoutes);
  await app.register(auditorRoutes);

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message, statusCode: error.statusCode });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'VALIDATION', message: error.issues[0]?.message ?? 'Invalid input', statusCode: 400 });
    }
    const e = error as { code?: string; statusCode?: number; message?: string };
    if (e.code === '23514') return reply.status(422).send({ error: 'FLOOR_VIOLATION', message: 'Operation would breach the account floor', statusCode: 422 });
    if (e.code === '22P02') return reply.status(400).send({ error: 'VALIDATION', message: 'Malformed identifier', statusCode: 400 });
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'REQUEST_ERROR', message: e.message, statusCode: e.statusCode });
    }
    request.log.error(error);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Unexpected error', statusCode: 500 });
  });

  return app;
}
