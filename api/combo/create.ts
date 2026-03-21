import { Router, Request, Response } from 'express';
import prisma from '../../lib/db';
import logger from '../../lib/logger';

const router = Router();

const COMBO_PRICES: Record<string, { minAmount: number; label: string }> = {
  '7':  { minAmount: 120000, label: 'Combo 7 ngày' },
  '30': { minAmount: 300000, label: 'Combo 30 ngày' },
};

/**
 * POST /api/combo/create
 *
 * Body: { duration: "7" | "30", provision_secret: string }
 *
 * Finds an unused sepay transaction with sufficient amount,
 * marks it as processed, and returns OK for the bot to create the combo key.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    // Auth — reuse PROVISION_SECRET
    const secret = process.env.PROVISION_SECRET;
    if (!secret) {
      res.status(500).json({ success: false, error: 'PROVISION_SECRET not configured' });
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { duration } = req.body;
    const dur = String(duration || '7');

    const priceInfo = COMBO_PRICES[dur];
    if (!priceInfo) {
      res.status(400).json({
        success: false,
        error: `Invalid duration. Use "7" or "30"`,
      });
      return;
    }

    // Find the most recent unprocessed incoming transaction >= minAmount
    const transaction = await prisma.sepayTransaction.findFirst({
      where: {
        processed: false,
        transferType: 'in',
        transferAmount: { gte: priceInfo.minAmount },
        orderId: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!transaction) {
      res.status(404).json({
        success: false,
        error: `Không tìm thấy bill thanh toán >= ${priceInfo.minAmount.toLocaleString('vi-VN')}đ. Vui lòng chuyển khoản trước.`,
        min_amount: priceInfo.minAmount,
      });
      return;
    }

    // Mark as processed
    await prisma.sepayTransaction.update({
      where: { id: transaction.id },
      data: { processed: true },
    });

    logger.info('Combo: transaction verified', {
      transactionId: transaction.sepayId,
      amount: transaction.transferAmount,
      duration: dur,
      content: transaction.content,
    });

    res.json({
      success: true,
      duration: dur,
      label: priceInfo.label,
      transaction: {
        id: transaction.sepayId,
        amount: transaction.transferAmount,
        content: transaction.content,
        date: transaction.transactionDate,
      },
    });
  } catch (err) {
    logger.error('Combo create error', { error: err });
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export default router;
