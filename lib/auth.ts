import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from './db';
import { AuthenticatedRequest } from './types';
import logger from './logger';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

export function generateToken(): string {
  return jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    jwt.verify(token, JWT_SECRET);
    req.adminAuth = true;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export async function verifyApiKey(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const key = authHeader.slice(7);
  try {
    const apiKey = await prisma.apiKey.findUnique({ where: { key } });
    if (!apiKey || !apiKey.enabled) {
      res.status(401).json({ error: 'Invalid or disabled API key' });
      return;
    }
    req.apiKey = {
      id: apiKey.id,
      name: apiKey.name,
      key: apiKey.key,
      balance: apiKey.balance,
      enabled: apiKey.enabled,
    };
    next();
  } catch (err) {
    logger.error('API key verification failed', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
}
