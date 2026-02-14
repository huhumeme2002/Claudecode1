import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { clearModelCache } from '../../../lib/cache';

const router = Router();

router.delete('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.body.id || req.query.id;

    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Missing model id' });
      return;
    }

    await prisma.modelMapping.delete({
      where: { id },
    });

    clearModelCache();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete model' });
  }
});

export default router;
