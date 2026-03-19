import crypto from 'crypto';

const SEPAY_MERCHANT_ID = process.env.SEPAY_MERCHANT_ID || '';
const SEPAY_SECRET_KEY = process.env.SEPAY_SECRET_KEY || '';
const SEPAY_ENV = process.env.SEPAY_ENV || 'sandbox';
const SEPAY_API_KEY = process.env.SEPAY_API_KEY || '';

export function getSepayCheckoutUrl(): string {
  return SEPAY_ENV === 'production'
    ? 'https://pay.sepay.vn/v1/checkout/init'
    : 'https://pay-sandbox.sepay.vn/v1/checkout/init';
}

export function getSepayApiKey(): string {
  return SEPAY_API_KEY;
}

export function generateOrderCode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DH${ts}${rand}`;
}

export interface SepayFormParams {
  merchant: string;
  operation: string;
  payment_method: string;
  order_amount: number;
  currency: string;
  order_invoice_number: string;
  order_description: string;
  customer_id: string;
  success_url: string;
  error_url: string;
  cancel_url: string;
}

export function buildSepayForm(
  orderCode: string,
  amount: number,
  description: string,
  customerId: string,
  baseUrl: string
): { params: SepayFormParams & { signature: string }; actionUrl: string } {
  const params: SepayFormParams = {
    merchant: SEPAY_MERCHANT_ID,
    operation: 'PURCHASE',
    payment_method: 'BANK_TRANSFER',
    order_amount: amount,
    currency: 'VND',
    order_invoice_number: orderCode,
    order_description: description,
    customer_id: customerId,
    success_url: `${baseUrl}/checkout/success/${orderCode}`,
    error_url: `${baseUrl}/checkout/error/${orderCode}`,
    cancel_url: `${baseUrl}/checkout/cancel/${orderCode}`,
  };

  const signString = [
    `merchant=${params.merchant}`,
    `operation=${params.operation}`,
    `payment_method=${params.payment_method}`,
    `order_amount=${params.order_amount}`,
    `currency=${params.currency}`,
    `order_invoice_number=${params.order_invoice_number}`,
    `order_description=${params.order_description}`,
    `customer_id=${params.customer_id}`,
    `success_url=${params.success_url}`,
    `error_url=${params.error_url}`,
    `cancel_url=${params.cancel_url}`,
  ].join(',');

  const signature = crypto
    .createHmac('sha256', SEPAY_SECRET_KEY)
    .update(signString)
    .digest('base64');

  return {
    params: { ...params, signature },
    actionUrl: getSepayCheckoutUrl(),
  };
}
