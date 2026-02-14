import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { clearModelCache } from '../../../lib/cache';

const router = Router();

router.put('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, ...updateData } = req.body;

    if (!id) {
      res.status(400).json({ error: 'Missing model id' });
      return;
    }

    const model = await prisma.modelMapping.update({
      where: { id },
      data: updateData,
    });

    clearModelCache();
    res.json(model);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update model' });
  }
});

export default router;
