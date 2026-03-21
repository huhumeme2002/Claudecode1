import { Router, Request, Response } from 'express';
import prisma from '../../lib/db';
import logger from '../../lib/logger';

const router = Router();

/**
 * POST /api/combo/create
 *
 * Verify a Sepay transaction by matching reference_number or content.
 * User must paste their transfer details so the bot can extract a reference.
 *
 * Body: {
 *   reference: string,      // reference number or content snippet to match
 *   min_amount: number,      // minimum required amount
 * }
 *
 * Returns the matched transaction if valid and unprocessed.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    // Auth
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

    const { reference, min_amount } = req.body;

    if (!reference) {
      res.status(400).json({ success: false, error: 'Missing reference (mã tham chiếu hoặc nội dung CK)' });
      return;
    }

    const minAmt = Number(min_amount) || 0;

    // Try to match by: sepayId, referenceNumber, or content substring
    const ref = String(reference).trim();

    let transaction = await prisma.sepayTransaction.findFirst({
      where: {
        processed: false,
        transferType: 'in',
        referenceNumber: ref,
      },
    });

    // Fallback: match by sepayId
    if (!transaction && /^\d+$/.test(ref)) {
      transaction = await prisma.sepayTransaction.findFirst({
        where: {
          processed: false,
          transferType: 'in',
          sepayId: Number(ref),
        },
      });
    }

    // Fallback: match by content containing the reference
    if (!transaction) {
      transaction = await prisma.sepayTransaction.findFirst({
        where: {
          processed: false,
          transferType: 'in',
          content: { contains: ref },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!transaction) {
      res.status(404).json({
        success: false,
        error: `Không tìm thấy giao dịch với mã "${ref}". Kiểm tra lại hoặc chờ vài phút để hệ thống cập nhật.`,
      });
      return;
    }

    // Check amount
    if (minAmt > 0 && transaction.transferAmount < minAmt) {
      res.status(400).json({
        success: false,
        error: `Số tiền ${transaction.transferAmount.toLocaleString('vi-VN')}đ chưa đủ (cần >= ${minAmt.toLocaleString('vi-VN')}đ).`,
        amount: transaction.transferAmount,
        required: minAmt,
      });
      return;
    }

    // Mark as processed
    await prisma.sepayTransaction.update({
      where: { id: transaction.id },
      data: { processed: true },
    });

    logger.info('Bill verified', {
      sepayId: transaction.sepayId,
      amount: transaction.transferAmount,
      reference: ref,
    });

    res.json({
      success: true,
      transaction: {
        id: transaction.sepayId,
        amount: transaction.transferAmount,
        content: transaction.content,
        date: transaction.transactionDate,
        reference: transaction.referenceNumber,
      },
    });
  } catch (err) {
    logger.error('Combo verify error', { error: err });
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export default router;
