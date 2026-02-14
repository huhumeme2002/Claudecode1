import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const models = await prisma.modelMapping.findMany({
      orderBy: { displayName: 'asc' },
    });
    res.json(models);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

export default router;
