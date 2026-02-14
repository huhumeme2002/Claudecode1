import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { generateApiKey, generateId } from '../../../lib/utils';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, balance, rateLimitAmount, rateLimitIntervalHours } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Missing name field' });
      return;
    }

    const isRatePlan = rateLimitAmount != null && rateLimitIntervalHours != null;

    if (isRatePlan && (rateLimitAmount <= 0 || rateLimitIntervalHours <= 0)) {
      res.status(400).json({ error: 'Rate limit amount and interval must be positive' });
      return;
    }

    const key = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        id: generateId(),
        name,
        key,
        balance: isRatePlan ? 0 : (balance || 0),
        enabled: true,
        ...(isRatePlan ? {
          rateLimitAmount: parseFloat(rateLimitAmount),
          rateLimitIntervalHours: parseFloat(rateLimitIntervalHours),
          rateLimitWindowSpent: 0,
        } : {}),
      },
    });

    res.json({
      ...apiKey,
      totalTokens: Number(apiKey.totalTokens),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

export default router;
