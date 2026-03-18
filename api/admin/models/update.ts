import { Router, Response } from 'express';
import { verifyAdmin } from '../../../lib/auth';
import { AuthenticatedRequest } from '../../../lib/types';
import prisma from '../../../lib/db';
import { clearModelCache } from '../../../lib/cache';

const router = Router();

router.put('/', verifyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, displayName, actualModel, apiUrl, apiKey, apiFormat,
            inputPrice, outputPrice, systemPrompt, disableSystem, enabled } = req.body;

    if (!id) {
      res.status(400).json({ error: 'Missing model id' });
      return;
    }

    if (apiFormat !== undefined && apiFormat !== 'openai' && apiFormat !== 'anthropic') {
      res.status(400).json({ error: 'apiFormat must be "openai" or "anthropic"' });
      return;
    }

    const existing = await prisma.modelMapping.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    // Only allow whitelisted fields to prevent overwriting id, createdAt, etc.
    const data: Record<string, any> = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (actualModel !== undefined) data.actualModel = actualModel;
    if (apiUrl !== undefined) data.apiUrl = apiUrl;
    if (apiKey !== undefined) data.apiKey = apiKey;
    if (apiFormat !== undefined) data.apiFormat = apiFormat;
    if (inputPrice !== undefined) data.inputPrice = inputPrice;
    if (outputPrice !== undefined) data.outputPrice = outputPrice;
    if (systemPrompt !== undefined) data.systemPrompt = systemPrompt;
    if (disableSystem !== undefined) data.disableSystem = disableSystem;
    if (enabled !== undefined) data.enabled = enabled;

    const model = await prisma.modelMapping.update({
      where: { id },
      data,
    });

    clearModelCache();
    res.json(model);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update model' });
  }
});

export default router;
