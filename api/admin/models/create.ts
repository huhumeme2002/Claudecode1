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
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'A model with this display name already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create model', details: error?.message });
  }
});

export default router;
