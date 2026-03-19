import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

// Cache key list for 5 seconds — admin doesn't need real-time data on F5
let keysCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL_MS = 30_000;

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = Date.now();
    if (keysCache && (now - keysCache.timestamp) < CACHE_TTL_MS) {
      res.json(keysCache.data);
      return;
    }

    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });

    // Mask key and convert BigInt to Number
    const result = keys.map((key) => ({
      ...key,
      key: key.key.length > 11
        ? `${key.key.slice(0, 7)}...${key.key.slice(-4)}`
        : key.key,
      totalTokens: Number(key.totalTokens),
      expiry: key.expiry,
      rateLimitAmount: key.rateLimitAmount,
      rateLimitIntervalHours: key.rateLimitIntervalHours,
      rateLimitWindowStart: key.rateLimitWindowStart,
      rateLimitWindowSpent: key.rateLimitWindowSpent,
    }));

    keysCache = { data: result, timestamp: now };
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

export default router;
