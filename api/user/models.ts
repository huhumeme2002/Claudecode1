import { Router, Response } from 'express';
import { verifyApiKey } from '../../lib/auth';
import { AuthenticatedRequest } from '../../lib/types';
import prisma from '../../lib/db';

const router = Router();

router.get('/', verifyApiKey, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const models = await prisma.modelMapping.findMany({
      where: { enabled: true },
      select: {
        displayName: true,
        inputPrice: true,
        outputPrice: true,
      },
      orderBy: { displayName: 'asc' },
    });

    res.json(models);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

export default router;
