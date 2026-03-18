import { Router, Request, Response } from 'express';
import { generateToken } from '../../lib/auth';

const router = Router();

// Brute-force protection: max 10 failed attempts per IP per 15 minutes
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

router.post('/', (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (record) {
    if (now < record.resetAt && record.count >= MAX_ATTEMPTS) {
      const retryAfterSecs = Math.ceil((record.resetAt - now) / 1000);
      res.status(429).json({ error: `Too many login attempts. Try again in ${retryAfterSecs} seconds.` });
      return;
    }
    if (now >= record.resetAt) {
      loginAttempts.delete(ip);
    }
  }

  const { password } = req.body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    const existing = loginAttempts.get(ip);
    if (existing && now < existing.resetAt) {
      existing.count++;
    } else {
      loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    }
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  // Success — clear failed attempts for this IP
  loginAttempts.delete(ip);
  const token = generateToken();
  res.json({ token });
});

export default router;
