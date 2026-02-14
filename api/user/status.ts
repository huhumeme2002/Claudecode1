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

    const usageStats = await prisma.usageLog.aggregate({
      where: { apiKeyId: req.apiKey.id },
      _sum: {
        cost: true,
        inputTokens: true,
        outputTokens: true,
      },
    });

    const now = new Date();
    const expiryDate = req.apiKey.expiry ? new Date(req.apiKey.expiry) : null;
    let daysRemaining: number | null = null;
    let expired = false;

    if (expiryDate) {
      const diffMs = expiryDate.getTime() - now.getTime();
      daysRemaining = Math.ceil(diffMs / 86400_000);
      expired = diffMs <= 0;
    }

    res.json({
      name: req.apiKey.name,
      balance: req.apiKey.balance,
      totalSpent: usageStats._sum.cost || 0,
      totalTokens: (usageStats._sum.inputTokens || 0) + (usageStats._sum.outputTokens || 0),
      expiry: req.apiKey.expiry,
      days_remaining: daysRemaining,
      expired,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

export default router;
