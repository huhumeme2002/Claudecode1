import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { clearModelCache } from '../../../lib/cache';
import logger from '../../../lib/logger';

const router = Router();

router.delete('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.body.id || req.query.id;

    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Missing model id' });
      return;
    }

    const existing = await prisma.modelMapping.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    await prisma.$transaction([
      prisma.usageLog.deleteMany({ where: { modelId: id } }),
      prisma.modelMapping.delete({ where: { id } }),
    ]);

    clearModelCache();
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete model:', error);
    res.status(500).json({ error: 'Failed to delete model' });
  }
});

export default router;
