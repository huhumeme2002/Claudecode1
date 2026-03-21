import { Router, Response } from 'express';
import { verifyAdmin, invalidateApiKeyCache } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { key_id, key: keyString, duration_days, set_expiry } = req.body;

    if ((!key_id && !keyString) || (!duration_days && !set_expiry)) {
      res.status(400).json({ error: 'Missing key_id/key and duration_days/set_expiry' });
      return;
    }

    // Support lookup by key string (sk-...) or by UUID key_id
    const key = keyString
      ? await prisma.apiKey.findUnique({ where: { key: keyString } })
      : await prisma.apiKey.findUnique({ where: { id: key_id } });
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    let newExpiry: Date;

    if (set_expiry) {
      // Set exact expiry date (e.g. "2026-07-21")
      newExpiry = new Date(set_expiry);
      if (isNaN(newExpiry.getTime())) {
        res.status(400).json({ error: 'Invalid set_expiry date format' });
        return;
      }
    } else {
      // Add/subtract days from current expiry (supports negative values)
      const now = new Date();
      const currentExpiry = key.expiry ? new Date(key.expiry) : now;
      const baseDate = currentExpiry > now ? currentExpiry : now;
      newExpiry = new Date(baseDate);
      newExpiry.setDate(newExpiry.getDate() + duration_days);
    }

    await prisma.apiKey.update({
      where: { id: key.id },
      data: { expiry: newExpiry },
    });

    invalidateApiKeyCache(key.key);

    res.json({
      success: true,
      data: {
        key_id: key.id,
        old_expiry: key.expiry,
        new_expiry: newExpiry,
        days_added: duration_days,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to extend API key' });
  }
});

export default router;
