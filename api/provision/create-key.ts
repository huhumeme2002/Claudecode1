import { Router, Request, Response } from 'express';
import prisma from '../../lib/db';
import { generateApiKey } from '../../lib/utils';
import { getPlan } from '../../lib/plans';
import { sendTelegramNotification } from '../../lib/telegram';
import logger from '../../lib/logger';

const router = Router();

/**
 * POST /api/provision/create-key
 *
 * External API for partner sites to provision API keys after payment.
 * Auth: header "Authorization: Bearer <PROVISION_SECRET>"
 *
 * Body: {
 *   plan_id: string,          // e.g. "pro", "max5x", "max20x"
 *   customer_name: string,
 *   customer_email?: string,
 *   customer_phone?: string,
 *   existing_key?: string,    // if upgrading an existing key
 *   order_ref?: string,       // external order reference from partner site
 * }
 *
 * Response: { success: true, api_key: "sk-...", plan: {...}, expiry: "..." }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    // Auth check
    const secret = process.env.PROVISION_SECRET;
    if (!secret) {
      logger.error('PROVISION_SECRET not configured');
      res.status(500).json({ error: 'Provision API not configured' });
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (token !== secret) {
      res.status(401).json({ error: 'Invalid provision secret' });
      return;
    }

    const { plan_id, customer_name, customer_email, customer_phone, existing_key, order_ref } = req.body;

    if (!plan_id || !customer_name) {
      res.status(400).json({ error: 'plan_id and customer_name are required' });
      return;
    }

    const plan = getPlan(plan_id);
    if (!plan) {
      res.status(400).json({ error: `Invalid plan_id: ${plan_id}` });
      return;
    }

    let finalKey: string;
    let expiry: Date;
    let isUpgrade = false;

    // Check if upgrading existing key
    if (existing_key) {
      const existingRecord = await prisma.apiKey.findUnique({ where: { key: existing_key } });
      if (existingRecord) {
        isUpgrade = true;
        const now = new Date();
        const currentExpiry = existingRecord.expiry ? new Date(existingRecord.expiry) : now;
        const baseDate = currentExpiry > now ? currentExpiry : now;
        expiry = new Date(baseDate);
        expiry.setDate(expiry.getDate() + plan.durationDays);

        await prisma.apiKey.update({
          where: { id: existingRecord.id },
          data: {
            enabled: true,
            expiry,
            rateLimitAmount: plan.rateLimitAmount,
            rateLimitIntervalHours: plan.rateLimitIntervalHours,
            rateLimitWindowStart: now,
            rateLimitWindowSpent: 0,
          },
        });

        finalKey = existingRecord.key;
      } else {
        // Key not found, create new
        finalKey = generateApiKey();
        expiry = new Date();
        expiry.setDate(expiry.getDate() + plan.durationDays);
        await prisma.apiKey.create({
          data: {
            name: `${plan.name} - ${customer_name}`,
            key: finalKey,
            balance: 0,
            enabled: true,
            expiry,
            rateLimitAmount: plan.rateLimitAmount,
            rateLimitIntervalHours: plan.rateLimitIntervalHours,
            rateLimitWindowStart: new Date(),
            rateLimitWindowSpent: 0,
          },
        });
      }
    } else {
      // New key
      finalKey = generateApiKey();
      expiry = new Date();
      expiry.setDate(expiry.getDate() + plan.durationDays);
      await prisma.apiKey.create({
        data: {
          name: `${plan.name} - ${customer_name}`,
          key: finalKey,
          balance: 0,
          enabled: true,
          expiry,
          rateLimitAmount: plan.rateLimitAmount,
          rateLimitIntervalHours: plan.rateLimitIntervalHours,
          rateLimitWindowStart: new Date(),
          rateLimitWindowSpent: 0,
        },
      });
    }

    logger.info('Provision: key created/upgraded', {
      plan: plan_id,
      customer: customer_name,
      isUpgrade,
      orderRef: order_ref,
      keyPrefix: finalKey.substring(0, 10),
    });

    // Telegram notification
    sendTelegramNotification(
      `🔑 <b>Key provisioned${isUpgrade ? ' (gia hạn)' : ''}</b>\n` +
      `Gói: ${plan.name}\n` +
      `KH: ${customer_name}\n` +
      (customer_email ? `Email: ${customer_email}\n` : '') +
      (order_ref ? `Ref: ${order_ref}\n` : '') +
      `Key: ${finalKey.substring(0, 12)}...`
    ).catch(() => {});

    res.json({
      success: true,
      api_key: finalKey,
      is_upgrade: isUpgrade,
      plan: {
        id: plan.id,
        name: plan.name,
        credit_per_window: plan.rateLimitAmount,
        window_hours: plan.rateLimitIntervalHours,
        duration_days: plan.durationDays,
      },
      expiry: expiry!.toISOString(),
    });
  } catch (err) {
    logger.error('Provision create-key failed', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
