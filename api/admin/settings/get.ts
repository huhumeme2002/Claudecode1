import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const settings = await prisma.setting.findMany();

    const settingsObject = settings.reduce((acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    }, {} as Record<string, string>);

    res.json(settingsObject);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

export default router;
