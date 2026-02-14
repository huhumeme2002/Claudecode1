import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { clearSettingsCache } from '../../../lib/cache';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ error: 'Missing or invalid settings object' });
      return;
    }

    // Upsert each setting
    const promises = Object.entries(settings).map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      })
    );

    await Promise.all(promises);
    clearSettingsCache();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
