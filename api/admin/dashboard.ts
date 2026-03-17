import { Router, Response } from 'express';
import { verifyAdmin } from '../../lib/auth';
import { AuthenticatedRequest } from '../../lib/types';
import prisma from '../../lib/db';

const router = Router();

// In-memory cache for dashboard stats — avoid hitting DB on every F5
let dashboardCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL_MS = 15_000; // 15 seconds

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = Date.now();
    if (dashboardCache && (now - dashboardCache.timestamp) < CACHE_TTL_MS) {
      res.json(dashboardCache.data);
      return;
    }

    // Run independent queries in parallel
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [totalKeys, activeKeys, totalModels, usageStats, recentUsage] = await Promise.all([
      prisma.apiKey.count(),
      prisma.apiKey.count({ where: { enabled: true } }),
      prisma.modelMapping.count(),
      prisma.$queryRaw<any[]>`
        SELECT COUNT(*)::int as total_requests, COALESCE(SUM(cost), 0)::float as total_revenue
        FROM usage_logs
      `,
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

    const totalRequests = usageStats[0]?.total_requests || 0;
    const totalRevenue = usageStats[0]?.total_revenue || 0;

    const formattedUsage = recentUsage.map((r: any) => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      requests: Number(r.requests),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cost: Number(r.cost),
    }));

    const data = {
      totalKeys,
      activeKeys,
      totalModels,
      totalRequests,
      totalRevenue,
      recentUsage: formattedUsage,
    };

    dashboardCache = { data, timestamp: now };
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

export default router;
