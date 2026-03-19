import { Router, Response } from 'express';
import { verifyApiKey } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { LRUCache } from 'lru-cache';

const router = Router();

// Response cache: 60s per page
const recentCache = new LRUCache<string, any>({ max: 500, ttl: 60_000 });
// Count cache: 5 min — COUNT(*) is expensive on large tables, total changes slowly
const countCache = new LRUCache<string, number>({ max: 500, ttl: 300_000 });

router.get('/', verifyApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.apiKey) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const cacheKey = `${req.apiKey.id}:${page}:${limit}`;

    const cached = recentCache.get(cacheKey);
    if (cached) { res.json(cached); return; }

    const skip = (page - 1) * limit;

    // Use cached count to avoid expensive COUNT(*) on every request
    const cachedTotal = countCache.get(req.apiKey.id);

    const [logs, total] = await Promise.all([
      prisma.usageLog.findMany({
        where: { apiKeyId: req.apiKey.id },
        include: { model: { select: { displayName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      cachedTotal !== undefined
        ? Promise.resolve(cachedTotal)
        : prisma.usageLog.count({ where: { apiKeyId: req.apiKey.id } }),
    ]);

    if (cachedTotal === undefined) {
      countCache.set(req.apiKey.id, total);
    }

    const data = {
      logs: logs.map(l => ({
        created_at: l.createdAt,
        model_display: l.model.displayName,
        input_tokens: l.inputTokens,
        output_tokens: l.outputTokens,
        total_cost: l.cost,
      })),
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };

    recentCache.set(cacheKey, data);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recent logs' });
  }
});

export default router;
