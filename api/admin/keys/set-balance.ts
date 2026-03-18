import { Router, Response } from 'express';
import { verifyAdmin, invalidateApiKeyCache } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, balance } = req.body;

    if (!id || balance === undefined) {
      res.status(400).json({ error: 'Missing id or balance field' });
      return;
    }

    if (typeof balance !== 'number') {
      res.status(400).json({ error: 'Balance must be a number' });
      return;
    }

    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const apiKey = await prisma.apiKey.update({
      where: { id },
      data: { balance },
    });

    invalidateApiKeyCache(apiKey.key);
    res.json({ ...apiKey, totalTokens: Number(apiKey.totalTokens) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to set balance' });
  }
});

export default router;
