import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, amount } = req.body;

    if (!id || amount === undefined) {
      res.status(400).json({ error: 'Missing id or amount field' });
      return;
    }

    const apiKey = await prisma.apiKey.update({
      where: { id },
      data: {
        balance: { increment: amount },
      },
    });

    res.json(apiKey);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add balance' });
  }
});

export default router;
