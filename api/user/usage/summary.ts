import { Router, Response } from 'express';
import { verifyApiKey } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.get('/', verifyApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const days = parseInt(req.query.days as string) || 0;
    const where: any = { apiKeyId: req.apiKey.id };
    if (days > 0) {
      where.createdAt = { gte: new Date(Date.now() - days * 86400_000) };
    }

    const grouped = await prisma.usageLog.groupBy({
      by: ['modelId'],
      where,
      _sum: { inputTokens: true, outputTokens: true, cost: true },
      _count: true,
    });

    // Fetch model display names
    const modelIds = grouped.map(g => g.modelId);
    const models = await prisma.modelMapping.findMany({
      where: { id: { in: modelIds } },
      select: { id: true, displayName: true },
    });
    const modelMap = new Map(models.map(m => [m.id, m.displayName]));

    const summary = grouped.map(g => ({
      model: modelMap.get(g.modelId) || 'Unknown',
      total_requests: g._count,
      total_input_tokens: g._sum.inputTokens || 0,
      total_output_tokens: g._sum.outputTokens || 0,
      total_cost: g._sum.cost || 0,
    }));

    const totals = summary.reduce((acc, s) => ({
      requests: acc.requests + s.total_requests,
      input_tokens: acc.input_tokens + s.total_input_tokens,
      output_tokens: acc.output_tokens + s.total_output_tokens,
      cost: acc.cost + s.total_cost,
    }), { requests: 0, input_tokens: 0, output_tokens: 0, cost: 0 });

    res.json({ summary, totals });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch usage summary' });
  }
});

export default router;
