import { Router, Response } from 'express';
import { verifyAdmin, invalidateApiKeyCache } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import logger from '../../../lib/logger';

const router = Router();

router.delete('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.body.id || req.query.id;

    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Missing API key id' });
      return;
    }

    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
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
    logger.error('Failed to delete API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

export default router;
