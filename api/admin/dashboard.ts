import { Router, Response } from 'express';
import { verifyAdmin } from '../../lib/auth';
import { AuthenticatedRequest } from '../../lib/types';
import prisma from '../../lib/db';

const router = Router();

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const totalKeys = await prisma.apiKey.count();
    const activeKeys = await prisma.apiKey.count({ where: { enabled: true } });
    const totalModels = await prisma.modelMapping.count();

    // Single query for both count and revenue (avoids two full-table scans)
    const usageStats: any[] = await prisma.$queryRaw`
      SELECT COUNT(*)::int as total_requests, COALESCE(SUM(cost), 0)::float as total_revenue
      FROM usage_logs
    `;
    const totalRequests = usageStats[0]?.total_requests || 0;
    const totalRevenue = usageStats[0]?.total_revenue || 0;

    // Get usage from last 30 days using SQL GROUP BY (much faster than loading all rows)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentUsage: any[] = await prisma.$queryRaw`
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
    `;

    const formattedUsage = recentUsage.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      requests: Number(r.requests),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cost: Number(r.cost),
    }));

    res.json({
      totalKeys,
      activeKeys,
      totalModels,
      totalRequests,
      totalRevenue,
      recentUsage: formattedUsage,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

export default router;
