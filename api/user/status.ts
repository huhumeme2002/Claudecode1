import { Router, Response } from 'express';
import { verifyApiKey } from '../../lib/auth';
import { getEffectiveBudget } from '../../lib/billing';
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
      _sum: { cost: true, inputTokens: true, outputTokens: true },
    });

    const budget = getEffectiveBudget(req.apiKey);
    const isRate = budget.type === 'rate';

    const now = new Date();
    const expiryDate = req.apiKey.expiry ? new Date(req.apiKey.expiry) : null;
    let daysRemaining: number | null = null;
    let expired = false;
    if (expiryDate) {
      const diffMs = expiryDate.getTime() - now.getTime();
      daysRemaining = Math.ceil(diffMs / 86400_000);
      expired = diffMs <= 0;
    }

    // Mask key
    const k = req.apiKey.key;
    const keyMasked = k.length > 11
      ? `${k.slice(0, 7)}...${k.slice(-4)}`
      : k;

    res.json({
      name: req.apiKey.name,
      key_masked: keyMasked,
      plan_type: budget.type,
      balance: isRate ? null : req.apiKey.balance,
      rate_limit_amount: req.apiKey.rateLimitAmount,
      rate_limit_interval_hours: req.apiKey.rateLimitIntervalHours,
      rate_limit_window_spent: req.apiKey.rateLimitWindowSpent,
      rate_limit_window_remaining: isRate ? budget.remaining : null,
      rate_limit_window_resets_at: isRate ? budget.windowResetAt : null,
      total_spent: usageStats._sum.cost || 0,
      total_input_tokens: usageStats._sum.inputTokens || 0,
      total_output_tokens: usageStats._sum.outputTokens || 0,
      expiry: req.apiKey.expiry,
      days_remaining: daysRemaining,
      expired,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

export default router;
