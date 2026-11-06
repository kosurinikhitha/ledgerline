import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import sql from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../services/transfer.service';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  password: z.string().min(8).max(200),
  role: z.enum(['admin', 'account_holder', 'auditor']).default('account_holder'),
});

// A real bcrypt hash of a random string, compared when the email is unknown so
// that response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export default async function authRoutes(app: FastifyInstance) {
  /** POST /auth/login  (public) */
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message, 'VALIDATION');
    const { email, password } = parsed.data;

    const [user] = await sql`SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = ${email.toLowerCase()}`;
    const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !user.is_active || !valid) throw new AppError(401, 'Invalid credentials', 'BAD_CREDENTIALS');

    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: '8h' });
    await sql`INSERT INTO audit_log (user_id, action, details) VALUES (${user.id}, 'LOGIN', ${sql.json({ ip: request.ip })})`;
    return reply.send({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  /** POST /auth/register  (admin only) */
  app.post('/auth/register', { preHandler: requireRole('admin') }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message, 'VALIDATION');
    const { email, name, password, role } = parsed.data;
    const hash = await bcrypt.hash(password, 10);
    try {
      const [user] = await sql`
        INSERT INTO users (email, name, password_hash, role)
        VALUES (${email.toLowerCase()}, ${name}, ${hash}, ${role})
        RETURNING id, email, name, role, created_at`;
      await sql`INSERT INTO audit_log (user_id, action, resource, resource_id, details)
                VALUES (${request.user.sub}, 'CREATE_USER', 'users', ${user.id}, ${sql.json({ email, role })})`;
      return reply.status(201).send(user);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'Email already registered', 'DUPLICATE');
      throw err;
    }
  });

  /** GET /auth/me  (any authenticated user) */
  app.get('/auth/me', { preHandler: authenticate }, async (request) => {
    const [user] = await sql`SELECT id, email, name, role, is_active, created_at FROM users WHERE id = ${request.user.sub}`;
    return user;
  });
}
