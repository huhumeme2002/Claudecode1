import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { clearModelCache } from '../../../lib/cache';
import { generateId } from '../../../lib/utils';

const router = Router();

router.post('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      displayName,
      actualModel,
      apiUrl,
      apiKey,
      apiFormat,
      inputPrice,
      outputPrice,
      systemPrompt,
      disableSystem,
      enabled,
    } = req.body;

    if (!displayName || !actualModel || !apiUrl || !apiKey || !apiFormat) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const model = await prisma.modelMapping.create({
      data: {
        id: generateId(),
        displayName,
        actualModel,
        apiUrl,
        apiKey,
        apiFormat,
        inputPrice: inputPrice || 0,
        outputPrice: outputPrice || 0,
        systemPrompt: systemPrompt || null,
        disableSystem: disableSystem || false,
        enabled: enabled !== undefined ? enabled : true,
      },
    });

    clearModelCache();
    res.json(model);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create model' });
  }
});

export default router;
