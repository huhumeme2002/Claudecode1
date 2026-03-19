import logger from './logger';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export async function sendTelegramNotification(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    logger.error('Telegram notification failed', { error: err });
  }
}

export function buildOrderPaidMessage(
  orderCode: string,
  planName: string,
  amount: number,
  customerName: string,
  customerEmail: string | null,
  apiKeyPreview: string
): string {
  const amountStr = amount.toLocaleString('vi-VN');
  const time = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return [
    `<b>Thanh toán thành công!</b>`,
    ``,
    `Mã đơn: <code>${orderCode}</code>`,
    `Gói: <b>${planName}</b>`,
    `Số tiền: <b>${amountStr}đ</b>`,
    `Khách hàng: ${customerName}`,
    customerEmail ? `Email: ${customerEmail}` : '',
    `API Key: <code>${apiKeyPreview}...</code>`,
    `Thời gian: ${time}`,
  ].filter(Boolean).join('\n');
}
