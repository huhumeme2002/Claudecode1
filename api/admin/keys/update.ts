import { Router, Response } from 'express';
import { verifyAdmin, invalidateApiKeyCache } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.put('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, name, rateLimitAmount, rateLimitIntervalHours, balance, enabled } = req.body;

    if (!id) {
      res.status(400).json({ error: 'Missing key id' });
      return;
    }

    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const data: Record<string, any> = {};

    // Update name if provided
    if (name != null) {
      data.name = name;
    }

    // Update enabled status if provided
    if (enabled != null) {
      data.enabled = Boolean(enabled);
    }

    // Update rate plan fields
    if (rateLimitAmount != null) {
      if (rateLimitAmount <= 0) {
        res.status(400).json({ error: 'Rate limit amount must be positive' });
        return;
      }
      data.rateLimitAmount = parseFloat(rateLimitAmount);
    }

    if (rateLimitIntervalHours != null) {
      if (rateLimitIntervalHours <= 0) {
        res.status(400).json({ error: 'Rate limit interval must be positive' });
        return;
      }
      data.rateLimitIntervalHours = parseFloat(rateLimitIntervalHours);
    }

    // Update flat balance if provided
    if (balance != null) {
      data.balance = parseFloat(balance);
    }

    const updated = await prisma.apiKey.update({
      where: { id },
      data,
    });

    // Invalidate cache so updated key takes effect immediately
    invalidateApiKeyCache(existing.key);

    res.json({
      ...updated,
      totalTokens: Number(updated.totalTokens),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

export default router;
