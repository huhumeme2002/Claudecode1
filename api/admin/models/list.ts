import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

let modelsCache: { data: any; ts: number } | null = null;

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = Date.now();
    if (modelsCache && (now - modelsCache.ts) < 30_000) {
      res.json(modelsCache.data);
      return;
    }
    const models = await prisma.modelMapping.findMany({
      orderBy: { displayName: 'asc' },
    });
    modelsCache = { data: models, ts: now };
    res.json(models);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

export default router;
