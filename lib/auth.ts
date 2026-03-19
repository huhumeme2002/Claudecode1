import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { LRUCache } from 'lru-cache';
import prisma from './db';
import { AuthenticatedRequest } from './types';
import logger from './logger';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Cache API key lookups to avoid DB hit on every proxy request
// TTL 30s = key changes take up to 30s to propagate (acceptable trade-off)
// cachedAt = timestamp of last DB fetch; budget fields are re-fetched if >BUDGET_TTL_MS stale
const BUDGET_TTL_MS = 5_000; // Re-read balance/window from DB at most once per 5s per key

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
  cachedAt: number; // ms timestamp when budget fields were last fetched from DB
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
    res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } });
    return;
  }

  const token = authHeader.slice(7);
  try {
    jwt.verify(token, JWT_SECRET);
    req.adminAuth = true;
    next();
  } catch {
    res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or expired token' } });
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
    res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } });
    return;
  }

  try {
    // Check cache first
    const cached = apiKeyCache.get(key);
    if (cached === NOT_FOUND) {
      // Cached negative — key doesn't exist
      res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } });
      return;
    }
    if (cached !== undefined) {
      // Cache hit — key exists, check enabled
      if (!cached.enabled) {
        res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } });
        return;
      }

      // Re-fetch budget fields from DB at most once per BUDGET_TTL_MS (5s) per key.
      // This reduces DB load by ~99% vs fetching on every request, while keeping
      // balance/window data fresh enough for accurate rate-limit enforcement.
      // Billing is batched (5s flush), so data beyond 5s stale has no real accuracy gain.
      const now = Date.now();
      if (now - cached.cachedAt >= BUDGET_TTL_MS) {
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
            res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } });
            return;
          }

          const updated: CachedApiKey = {
            ...cached,
            balance: freshBudget.balance,
            enabled: freshBudget.enabled,
            rateLimitWindowStart: freshBudget.rateLimitWindowStart,
            rateLimitWindowSpent: freshBudget.rateLimitWindowSpent,
            cachedAt: now,
          };
          apiKeyCache.set(key, updated);
          req.apiKey = updated;
        } catch (err) {
          // If DB is unreachable, fall back to cached data rather than failing
          logger.error('Fresh budget fetch failed, using cached data', { error: err });
          req.apiKey = cached;
        }
      } else {
        req.apiKey = cached;
      }

      next();
      return;
    }

    // Cache miss — query DB
    const apiKey = await prisma.apiKey.findUnique({ where: { key } });
    if (!apiKey || !apiKey.enabled) {
      apiKeyCache.set(key, NOT_FOUND);
      res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } });
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
      cachedAt: Date.now(),
    };
    apiKeyCache.set(key, entry);

    req.apiKey = entry;
    next();
  } catch (err) {
    logger.error('API key verification failed', { error: err });
    res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'An unexpected error occurred. Please try again later.' } });
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
