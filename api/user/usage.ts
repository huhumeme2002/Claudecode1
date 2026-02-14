import { Router, Response } from 'express';
import { verifyApiKey } from '../../lib/auth';
import { AuthenticatedRequest } from '../../lib/types';
import prisma from '../../lib/db';

const router = Router();

router.get('/', verifyApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.usageLog.findMany({
        where: { apiKeyId: req.apiKey.id },
        include: {
          model: {
            select: { displayName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.usageLog.count({
        where: { apiKeyId: req.apiKey.id },
      }),
    ]);

    const formattedLogs = logs.map((log) => ({
      id: log.id,
      modelName: log.model.displayName,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      cost: log.cost,
      createdAt: log.createdAt,
    }));

    res.json({
      logs: formattedLogs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch usage logs' });
  }
});

export default router;
