import { Router, Request, Response } from 'express';
import prisma from './db';
import { generateApiKey } from './utils';
import { getPlan } from './plans';
import { buildSepayForm, generateOrderCode } from './sepay';
import { sendTelegramNotification, buildOrderPaidMessage } from './telegram';
import { invalidateApiKeyCache } from './auth';
import logger from './logger';

const router = Router();

// ─── Create Order ──────────────────────────────────────────────────────────
router.post('/create-order', async (req: Request, res: Response) => {
  try {
    const { plan_id, customer_name, customer_phone, customer_email } = req.body;

    if (!plan_id || !customer_name) {
      res.status(400).json({ error: 'plan_id và customer_name là bắt buộc' });
      return;
    }

    const plan = getPlan(plan_id);
    if (!plan) {
      res.status(400).json({ error: 'Gói dịch vụ không hợp lệ' });
      return;
    }

    const orderCode = generateOrderCode();

    await prisma.order.create({
      data: {
        orderCode,
        planId: plan.id,
        amount: plan.amount,
        customerName: customer_name,
        customerEmail: customer_email || null,
        customerPhone: customer_phone || null,
        paymentMethod: 'sepay',
        status: 'pending',
      },
    });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = `${protocol}://${req.get('host')}`;
    const customerId = customer_phone || customer_name;

    const { params, actionUrl } = buildSepayForm(
      orderCode,
      plan.amount,
      plan.name,
      customerId,
      baseUrl
    );

    res.json({ actionUrl, params });
  } catch (err) {
    logger.error('Create order failed', { error: err });
    res.status(500).json({ error: 'Không thể tạo đơn hàng' });
  }
});

// ─── Activate Order (shared logic) ────────────────────────────────────────
async function activateOrder(orderCode: string): Promise<{ apiKey: string; order: any } | null> {
  const order = await prisma.order.findUnique({ where: { orderCode } });
  if (!order) return null;

  // Already paid — return existing key
  if (order.status === 'paid' && order.apiKeyId) {
    const existingKey = await prisma.apiKey.findUnique({ where: { id: order.apiKeyId } });
    return existingKey ? { apiKey: existingKey.key, order } : null;
  }

  if (order.status !== 'pending') return null;

  const plan = getPlan(order.planId);
  if (!plan) return null;

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + plan.durationDays);

  // Create API key + update order in transaction
  const newKey = generateApiKey();
  const [apiKeyRecord] = await prisma.$transaction([
    prisma.apiKey.create({
      data: {
        name: `${plan.name} - ${order.customerName}`,
        key: newKey,
        balance: 0,
        enabled: true,
        expiry,
        rateLimitAmount: plan.rateLimitAmount,
        rateLimitIntervalHours: plan.rateLimitIntervalHours,
        rateLimitWindowStart: new Date(),
        rateLimitWindowSpent: 0,
      },
    }),
    prisma.order.update({
      where: { orderCode },
      data: { status: 'paid', apiKeyId: undefined }, // apiKeyId set below
    }),
  ]);

  // Link order to the new key
  await prisma.order.update({
    where: { orderCode },
    data: { status: 'paid', apiKeyId: apiKeyRecord.id },
  });

  // Telegram notification (fire-and-forget)
  sendTelegramNotification(
    buildOrderPaidMessage(
      orderCode,
      plan.name,
      order.amount,
      order.customerName,
      order.customerEmail,
      newKey.substring(0, 12)
    )
  ).catch(() => {});

  return { apiKey: newKey, order: { ...order, status: 'paid' } };
}

// ─── Success Redirect ──────────────────────────────────────────────────────
router.get('/success/:orderCode', async (req: Request, res: Response) => {
  try {
    const orderCode = req.params.orderCode as string;
    const result = await activateOrder(orderCode);

    if (!result) {
      res.status(404).send(renderPage('Đơn hàng không tìm thấy', '<p>Mã đơn hàng không hợp lệ hoặc đã hết hạn.</p>', false));
      return;
    }

    const plan = getPlan(result.order.planId);
    res.send(renderPage(
      'Thanh toán thành công!',
      `
        <div class="success-icon">&#10003;</div>
        <h2>Thanh toán thành công!</h2>
        <p>Đơn hàng <strong>${result.order.orderCode}</strong> đã được xác nhận.</p>
        <div class="info-card">
          <div class="info-row"><span>Gói dịch vụ</span><strong>${plan?.name || result.order.planId}</strong></div>
          <div class="info-row"><span>Số tiền</span><strong>${result.order.amount.toLocaleString('vi-VN')}đ</strong></div>
          <div class="info-row"><span>Thời hạn</span><strong>${plan?.durationDays || '?'} ngày</strong></div>
        </div>
        <div class="key-box">
          <p class="key-label">API Key của bạn</p>
          <div class="key-value" id="apiKey">${result.apiKey}</div>
          <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('apiKey').textContent).then(()=>{this.textContent='Đã copy!'});setTimeout(()=>{this.textContent='Copy API Key'},2000)">Copy API Key</button>
        </div>
        <p class="warning">&#9888; Hãy lưu API key này ngay. Bạn sẽ không thể xem lại sau khi rời trang.</p>
        <a href="/dashboard" class="btn-primary">Vào Dashboard &rarr;</a>
      `,
      true
    ));
  } catch (err) {
    logger.error('Checkout success error', { error: err });
    res.status(500).send(renderPage('Lỗi', '<p>Đã xảy ra lỗi. Vui lòng liên hệ admin.</p>', false));
  }
});

// ─── Error Redirect ────────────────────────────────────────────────────────
router.get('/error/:orderCode', (_req: Request, res: Response) => {
  res.send(renderPage(
    'Thanh toán thất bại',
    `
      <div class="error-icon">&#10007;</div>
      <h2>Thanh toán thất bại</h2>
      <p>Giao dịch không thành công. Vui lòng thử lại hoặc liên hệ admin.</p>
      <a href="/#plans" class="btn-primary">Thử lại</a>
    `,
    false
  ));
});

// ─── Cancel Redirect ───────────────────────────────────────────────────────
router.get('/cancel/:orderCode', (_req: Request, res: Response) => {
  res.redirect('/#plans');
});

// ─── HTML Renderer ─────────────────────────────────────────────────────────
function renderPage(title: string, body: string, isSuccess: boolean): string {
  const accent = isSuccess ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - TobiStore API</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,sans-serif;background:#0a0a0f;color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{max-width:500px;width:100%;text-align:center}
.success-icon,.error-icon{font-size:48px;width:80px;height:80px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px;font-weight:700}
.success-icon{background:rgba(34,197,94,0.15);color:#22c55e}
.error-icon{background:rgba(239,68,68,0.15);color:#ef4444}
h2{font-size:28px;font-weight:800;margin-bottom:12px}
p{color:#94a3b8;font-size:15px;margin-bottom:20px;line-height:1.6}
.info-card{background:#111318;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:20px;margin:24px 0;text-align:left}
.info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)}
.info-row:last-child{border-bottom:none}
.info-row span{color:#64748b;font-size:14px}
.info-row strong{color:#f1f5f9;font-size:14px}
.key-box{background:#111318;border:2px solid ${accent};border-radius:14px;padding:24px;margin:24px 0}
.key-label{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.key-value{font-family:'JetBrains Mono','Consolas',monospace;font-size:13px;color:#f1f5f9;word-break:break-all;background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;margin-bottom:16px;user-select:all}
.copy-btn{background:${accent};color:#fff;border:none;padding:10px 24px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.2s}
.copy-btn:hover{filter:brightness(1.15)}
.warning{color:#fbbf24;font-size:13px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);border-radius:10px;padding:12px;margin:20px 0}
.btn-primary{display:inline-block;background:#f97316;color:#fff;padding:14px 32px;border-radius:12px;font-size:15px;font-weight:700;text-decoration:none;transition:all 0.2s;margin-top:8px}
.btn-primary:hover{filter:brightness(1.15);transform:translateY(-2px)}
</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

export { activateOrder };
export default router;
