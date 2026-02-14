import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { key_id, duration_days } = req.body;

    if (!key_id || !duration_days || duration_days <= 0) {
      res.status(400).json({ error: 'Missing or invalid key_id / duration_days' });
      return;
    }

    const key = await prisma.apiKey.findUnique({ where: { id: key_id } });
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const now = new Date();
    const currentExpiry = key.expiry ? new Date(key.expiry) : now;
    const baseDate = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + duration_days);

    await prisma.apiKey.update({
      where: { id: key_id },
      data: { expiry: newExpiry },
    });

    res.json({
      success: true,
      data: {
        key_id,
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
