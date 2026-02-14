import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { generateApiKey, generateId } from '../../../lib/utils';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, balance } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Missing name field' });
      return;
    }

    const key = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        id: generateId(),
        name,
        key,
        balance: balance || 0,
        enabled: true,
      },
    });

    res.json({
      ...apiKey,
      totalTokens: Number(apiKey.totalTokens),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

export default router;
