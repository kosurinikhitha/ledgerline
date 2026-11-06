import { FastifyRequest } from 'fastify';
import { AppError } from '../services/transfer.service';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Every money-moving endpoint requires a client-generated Idempotency-Key header. */
export function getIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || !KEY_PATTERN.test(key)) {
    throw new AppError(400, 'Idempotency-Key header is required (8-128 chars: letters, digits, _ . : -)', 'BAD_IDEMPOTENCY_KEY');
  }
  return key;
}
