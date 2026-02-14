import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
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
      rateLimitAmount: key.rateLimitAmount,
      rateLimitIntervalHours: key.rateLimitIntervalHours,
      rateLimitWindowStart: key.rateLimitWindowStart,
      rateLimitWindowSpent: key.rateLimitWindowSpent,
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

export default router;
