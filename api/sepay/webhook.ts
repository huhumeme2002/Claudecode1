import { Router, Request, Response } from 'express';
import prisma from '../../lib/db';
import { getSepayApiKey } from '../../lib/sepay';
import { activateOrder } from '../../lib/checkout-routes';
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
      logger.info('Sepay webhook: no order code found in content', { content, description });
      res.json({ success: true, message: 'No order code found' });
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

export default router;
