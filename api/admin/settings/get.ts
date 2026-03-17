import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

let settingsCache: { data: any; ts: number } | null = null;

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = Date.now();
    if (settingsCache && (now - settingsCache.ts) < 60_000) {
      res.json(settingsCache.data);
      return;
    }
    const settings = await prisma.setting.findMany();
    const settingsObject = settings.reduce((acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    }, {} as Record<string, string>);

    settingsCache = { data: settingsObject, ts: now };
    res.json(settingsObject);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

export default router;
