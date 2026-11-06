import { FastifyRequest } from 'fastify';
import sql from '../db/connection';
import { AppError } from '../services/transfer.service';
import { Role } from '../types';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: Role };
    user: { sub: string; email: string; role: Role };
  }
}

/**
 * Verifies the JWT, then re-reads the user from the database so that a
 * deactivated user or a changed role takes effect immediately, not at token expiry.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new AppError(401, 'Invalid or missing token', 'UNAUTHENTICATED');
  }
  const [u] = await sql`SELECT role, is_active FROM users WHERE id = ${request.user.sub}`;
  if (!u || !u.is_active) throw new AppError(401, 'Account disabled or not found', 'UNAUTHENTICATED');
  request.user = { ...request.user, role: u.role as Role };
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest): Promise<void> => {
    await authenticate(request);
    if (!roles.includes(request.user.role)) {
      throw new AppError(403, `Requires one of: ${roles.join(', ')}`, 'FORBIDDEN');
    }
  };
}
