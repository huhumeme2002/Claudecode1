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
    const totalRequests = await prisma.usageLog.count();

    const revenueResult = await prisma.usageLog.aggregate({
      _sum: { cost: true },
    });
    const totalRevenue = revenueResult._sum.cost || 0;

    // Get usage from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentLogs = await prisma.usageLog.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        createdAt: true,
        inputTokens: true,
        outputTokens: true,
        cost: true,
      },
    });

    // Group by date
    const usageByDate = new Map<string, { requests: number; inputTokens: number; outputTokens: number; cost: number }>();

    recentLogs.forEach((log) => {
      const date = log.createdAt.toISOString().split('T')[0];
      const existing = usageByDate.get(date) || { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      existing.requests += 1;
      existing.inputTokens += log.inputTokens;
      existing.outputTokens += log.outputTokens;
      existing.cost += log.cost;
      usageByDate.set(date, existing);
    });

    const recentUsage = Array.from(usageByDate.entries())
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      totalKeys,
      activeKeys,
      totalModels,
      totalRequests,
      totalRevenue,
      recentUsage,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

export default router;
