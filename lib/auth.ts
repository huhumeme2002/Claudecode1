import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { LRUCache } from 'lru-cache';
import prisma from './db';
import { AuthenticatedRequest } from './types';
import logger from './logger';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Cache API key lookups to avoid DB hit on every proxy request
// TTL 30s = key changes take up to 30s to propagate (acceptable trade-off)
interface CachedApiKey {
  id: string;
  name: string;
  key: string;
  balance: number;
  enabled: boolean;
  expiry: Date | null;
  rateLimitAmount: number | null;
  rateLimitIntervalHours: number | null;
  rateLimitWindowStart: Date | null;
  rateLimitWindowSpent: number | null;
  totalSpent: number;
  totalTokens: number;
}

const NOT_FOUND = Symbol('NOT_FOUND');
type CacheValue = CachedApiKey | typeof NOT_FOUND;

const apiKeyCache = new LRUCache<string, CacheValue>({
  max: 1000,
  ttl: 30_000,
});

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
  // Support both OpenAI-style (Authorization: Bearer) and Anthropic-style (x-api-key)
  // Prioritize x-api-key because some clients (OpenClaw) send a dummy Bearer token alongside
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'] as string | undefined;

  let key: string | undefined;
  if (xApiKey) {
    key = xApiKey;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    key = authHeader.slice(7);
  }

  if (!key) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  try {
    // Check cache first
    const cached = apiKeyCache.get(key);
    if (cached === NOT_FOUND) {
      // Cached negative — key doesn't exist
      res.status(401).json({ error: 'Invalid or disabled API key' });
      return;
    }
    if (cached !== undefined) {
      // Cache hit — key exists, check enabled
      if (!cached.enabled) {
        res.status(401).json({ error: 'Invalid or disabled API key' });
        return;
      }

      // Always fetch fresh budget-critical fields from DB to avoid stale
      // balance/window data causing wrong reset times or false "invalid key"
      // errors across PM2 cluster instances with independent caches.
      try {
        const freshBudget = await prisma.apiKey.findUnique({
          where: { id: cached.id },
          select: {
            balance: true,
            enabled: true,
            rateLimitWindowStart: true,
            rateLimitWindowSpent: true,
          },
        });

        if (!freshBudget || !freshBudget.enabled) {
          apiKeyCache.set(key, NOT_FOUND);
          res.status(401).json({ error: 'Invalid or disabled API key' });
          return;
        }

        req.apiKey = {
          ...cached,
          balance: freshBudget.balance,
          enabled: freshBudget.enabled,
          rateLimitWindowStart: freshBudget.rateLimitWindowStart,
          rateLimitWindowSpent: freshBudget.rateLimitWindowSpent,
        };
      } catch (err) {
        // If DB is unreachable, fall back to cached data rather than failing
        logger.error('Fresh budget fetch failed, using cached data', { error: err });
        req.apiKey = cached;
      }

      next();
      return;
    }

    // Cache miss — query DB
    const apiKey = await prisma.apiKey.findUnique({ where: { key } });
    if (!apiKey || !apiKey.enabled) {
      apiKeyCache.set(key, NOT_FOUND);
      res.status(401).json({ error: 'Invalid or disabled API key' });
      return;
    }

    const entry: CachedApiKey = {
      id: apiKey.id,
      name: apiKey.name,
      key: apiKey.key,
      balance: apiKey.balance,
      enabled: apiKey.enabled,
      expiry: apiKey.expiry,
      rateLimitAmount: apiKey.rateLimitAmount,
      rateLimitIntervalHours: apiKey.rateLimitIntervalHours,
      rateLimitWindowStart: apiKey.rateLimitWindowStart,
      rateLimitWindowSpent: apiKey.rateLimitWindowSpent,
      totalSpent: apiKey.totalSpent,
      totalTokens: Number(apiKey.totalTokens),
    };
    apiKeyCache.set(key, entry);

    req.apiKey = entry;
    next();
  } catch (err) {
    logger.error('API key verification failed', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Invalidate a specific key from cache (call after key update/disable)
export function invalidateApiKeyCache(key?: string): void {
  if (key) {
    apiKeyCache.delete(key);
  } else {
    apiKeyCache.clear();
  }
}
