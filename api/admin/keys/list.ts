import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.get('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });

    // Mask the key field - show only first 7 + last 4 chars
    const maskedKeys = keys.map((key) => ({
      ...key,
      key: key.key.length > 11
        ? `${key.key.slice(0, 7)}...${key.key.slice(-4)}`
        : key.key,
    }));

    res.json(maskedKeys);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

export default router;
