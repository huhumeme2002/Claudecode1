import { Router, Response } from 'express';
import { verifyAdmin, invalidateApiKeyCache } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';

const router = Router();

router.delete('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.body.id || req.query.id;

    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Missing API key id' });
      return;
    }

    await prisma.$transaction([
      prisma.usageLog.deleteMany({ where: { apiKeyId: id } }),
      prisma.apiKey.delete({ where: { id } }),
    ]);

    // Invalidate cache for deleted key
    invalidateApiKeyCache();

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

export default router;
