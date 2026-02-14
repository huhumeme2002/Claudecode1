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

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.usageLog.findMany({
        where: { apiKeyId: req.apiKey.id },
        include: { model: { select: { displayName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.usageLog.count({ where: { apiKeyId: req.apiKey.id } }),
    ]);

    res.json({
      logs: logs.map(l => ({
        created_at: l.createdAt,
        model_display: l.model.displayName,
        input_tokens: l.inputTokens,
        output_tokens: l.outputTokens,
        total_cost: l.cost,
      })),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recent logs' });
  }
});

export default router;
