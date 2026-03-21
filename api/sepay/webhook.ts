import { Router, Request, Response } from 'express';
import prisma from '../../lib/db';
import { getSepayApiKey } from '../../lib/sepay';
import { activateOrder } from '../../lib/checkout-routes';
import { getPlan } from '../../lib/plans';
import { generateApiKey } from '../../lib/utils';
import { sendTelegramNotification } from '../../lib/telegram';
import logger from '../../lib/logger';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  // Always return 200 to prevent Sepay retries
  try {
    // 1. Auth check (optional — skip if SEPAY_API_KEY not configured)
    const expectedKey = getSepayApiKey();
    if (expectedKey) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^(Apikey|Bearer)\s+/i, '').trim();
      if (token !== expectedKey) {
        logger.warn('Sepay webhook: invalid API key');
        res.json({ success: false, message: 'Unauthorized' });
        return;
      }
    }

    const {
      id: sepayId,
      gateway,
      transactionDate,
      accountNumber,
      transferType,
      transferAmount,
      accumulated,
      code,
      content,
      referenceNumber,
      description,
    } = req.body;

    if (!sepayId) {
      res.json({ success: false, message: 'Missing sepayId' });
      return;
    }

    // 2. Duplicate check
    const existing = await prisma.sepayTransaction.findUnique({
      where: { sepayId: Number(sepayId) },
    });
    if (existing) {
      res.json({ success: true, message: 'Already processed' });
      return;
    }

    // 3. Save transaction
    const transaction = await prisma.sepayTransaction.create({
      data: {
        sepayId: Number(sepayId),
        gateway: gateway || '',
        transactionDate: transactionDate || '',
        accountNumber: accountNumber || '',
        transferType: transferType || '',
        transferAmount: Number(transferAmount) || 0,
        accumulated: Number(accumulated) || 0,
        code: code || '',
        content: content || '',
        referenceNumber: referenceNumber || '',
        description: description || '',
      },
    });

    // 4. Only process incoming transfers
    if (transferType !== 'in') {
      res.json({ success: true, message: 'Skipped (not incoming)' });
      return;
    }

    // 5. Find order code in content/description
    const fullText = `${content || ''} ${description || ''}`.toUpperCase();
    const match = fullText.match(/DH[A-Z0-9]+/);
    if (!match) {
      // No order code — save transaction only, do NOT auto-create key.
      // Keys are created via PicoClaw bot when user pastes transfer content.
      logger.info('Sepay webhook: no order code, saved for bot processing', { content, amount: transferAmount });
      res.json({ success: true, message: 'Saved for bot processing' });
      return;
    }

    const orderCode = match[0];

    // 6. Find pending order
    const order = await prisma.order.findFirst({
      where: { orderCode, status: 'pending' },
    });

    if (!order) {
      logger.info('Sepay webhook: no pending order for code', { orderCode });
      res.json({ success: true, message: 'No pending order' });
      return;
    }

    // 7. Verify amount
    if (Number(transferAmount) < order.amount) {
      logger.warn('Sepay webhook: amount mismatch', {
        orderCode,
        expected: order.amount,
        received: transferAmount,
      });
      res.json({ success: true, message: 'Amount mismatch' });
      return;
    }

    // 8. Activate order (creates API key)
    const result = await activateOrder(orderCode);

    // 9. Link transaction to order + mark processed
    if (result) {
      await prisma.sepayTransaction.update({
        where: { id: transaction.id },
        data: { orderId: result.order.id || order.id, processed: true },
      });
      logger.info('Sepay webhook: order activated', { orderCode });
    }

    res.json({ success: true, message: 'Processed' });
  } catch (err) {
    logger.error('Sepay webhook error', { error: err });
    res.json({ success: false, message: 'Internal error' });
  }
});

// ─── Auto-create key by transfer amount (no order code) ──────────────────
// Amount → plan mapping (sorted descending so highest match wins)
const AMOUNT_PLAN_MAP = [
  { min: 450000, planId: 'max20x' },
  { min: 250000, planId: 'max5x' },
  { min: 159000, planId: 'pro' },
  { min: 150000, planId: 'week' },
  { min: 50000,  planId: 'trial' },
];

function extractCustomerName(content: string): string {
  // Try to extract name from transfer content
  // Common patterns: "NGUYEN VAN A goi pro", "TEN KHACH HANG", etc.
  const cleaned = content
    .replace(/MBVCB\.\d+\.\d+\./i, '')
    .replace(/FT\d+/gi, '')
    .replace(/PAY[A-Z0-9]+/gi, '')
    .replace(/CT\s+tu\s+\d+/gi, '')
    .replace(/toi\s+\w+/gi, '')
    .replace(/\d+/g, '')
    .replace(/[^\w\sÀ-ỹ]/gi, '')
    .trim();

  // Take first meaningful words (likely customer name)
  const words = cleaned.split(/\s+/).filter(w => w.length > 1);
  if (words.length > 0) {
    return words.slice(0, 4).join(' ');
  }
  return `Auto-${Date.now().toString(36)}`;
}

async function autoCreateKeyByAmount(
  amount: number,
  content: string,
  transactionId: string
): Promise<{ planId: string; key: string } | null> {
  // Find matching plan by amount
  const matched = AMOUNT_PLAN_MAP.find(m => amount >= m.min);
  if (!matched) return null;

  const plan = getPlan(matched.planId);
  if (!plan) return null;

  const customerName = extractCustomerName(content);
  const newKey = generateApiKey();
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + plan.durationDays);

  await prisma.apiKey.create({
    data: {
      name: `${plan.name} - ${customerName}`,
      key: newKey,
      balance: 0,
      enabled: true,
      expiry,
      rateLimitAmount: plan.rateLimitAmount,
      rateLimitIntervalHours: plan.rateLimitIntervalHours,
      rateLimitWindowStart: new Date(),
      rateLimitWindowSpent: 0,
    },
  });

  // Send key to dedicated Telegram group
  const amountStr = amount.toLocaleString('vi-VN');
  const expiryStr = expiry.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const keyGroupId = process.env.TELEGRAM_KEY_GROUP_ID || '';
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (keyGroupId && botToken) {
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: keyGroupId,
        text:
          `🔑 <b>Key tự động</b>\n` +
          `\n` +
          `Gói: <b>${plan.name}</b> ($${plan.rateLimitAmount}/${plan.rateLimitIntervalHours}h)\n` +
          `Số tiền: <b>${amountStr}đ</b>\n` +
          `KH: ${customerName}\n` +
          `Hết hạn: ${expiryStr}\n` +
          `\n` +
          `API Key:\n<code>${newKey}</code>`,
        parse_mode: 'HTML',
      }),
    }).catch(() => {});
  }

  return { planId: matched.planId, key: newKey };
}

export default router;
