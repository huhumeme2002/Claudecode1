import { Router, Response } from 'express';
import { verifyAdmin } from '../../lib/auth';
import { AuthenticatedRequest } from '../../lib/types';
import prisma from '../../lib/db';

const router = Router();

// Cache dashboard stats for 2 minutes — admin doesn't need real-time
let dashboardCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL_MS = 120_000; // 2 minutes

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = Date.now();
    if (dashboardCache && (now - dashboardCache.timestamp) < CACHE_TTL_MS) {
      res.json(dashboardCache.data);
      return;
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Use api_keys table (small, fast) for revenue instead of scanning usage_logs
    // api_keys.total_spent is already maintained by billing - no need to SUM usage_logs
    const [keyStats, totalModels, recentUsage] = await Promise.all([
      prisma.$queryRaw<any[]>`
        SELECT
          COUNT(*)::int as total_keys,
          COUNT(*) FILTER (WHERE enabled = true)::int as active_keys,
          COALESCE(SUM(total_spent), 0)::float as total_revenue,
          COALESCE(SUM(total_tokens), 0)::bigint as total_tokens_all
        FROM api_keys
      `,
      prisma.modelMapping.count(),
      prisma.$queryRaw<any[]>`
        SELECT
          DATE(created_at) as date,
          COUNT(*)::int as requests,
          COALESCE(SUM(input_tokens), 0)::int as "inputTokens",
          COALESCE(SUM(output_tokens), 0)::int as "outputTokens",
          COALESCE(SUM(cost), 0)::float as cost
        FROM usage_logs
        WHERE created_at >= ${thirtyDaysAgo}
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `,
    ]);

    const ks = keyStats[0];

    // Approximate total requests from recent usage (avoid full table COUNT)
    const totalRequests = recentUsage.reduce((sum: number, r: any) => sum + Number(r.requests), 0);

    const formattedUsage = recentUsage.map((r: any) => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      requests: Number(r.requests),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cost: Number(r.cost),
    }));

    const data = {
      totalKeys: ks?.total_keys || 0,
      activeKeys: ks?.active_keys || 0,
      totalModels,
      totalRequests,
      totalRevenue: ks?.total_revenue || 0,
      recentUsage: formattedUsage,
    };

    dashboardCache = { data, timestamp: now };
    res.json(data);
  } catch (error) {
    // If DB is overloaded, return stale cache if available
    if (dashboardCache) {
      res.json(dashboardCache.data);
      return;
    }
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

export default router;
