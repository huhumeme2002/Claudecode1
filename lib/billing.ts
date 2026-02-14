import prisma from './db';
import { UsageLogEntry } from './types';
import logger from './logger';

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputPrice: number,
  outputPrice: number
): number {
  const inputCost = (inputTokens / 1_000_000) * inputPrice;
  const outputCost = (outputTokens / 1_000_000) * outputPrice;
  return Math.round((inputCost + outputCost) * 1e8) / 1e8;
}

export interface BudgetResult {
  allowed: boolean;
  remaining: number;
  type: 'flat' | 'rate';
  windowResetAt?: Date;
}

interface RateLimitKey {
  rateLimitAmount: number | null;
  rateLimitIntervalHours: number | null;
  rateLimitWindowStart: Date | null;
  rateLimitWindowSpent: number | null;
  balance: number;
}

export function getEffectiveBudget(key: RateLimitKey): BudgetResult {
  if (key.rateLimitAmount != null && key.rateLimitIntervalHours != null) {
    const now = new Date();
    const windowMs = key.rateLimitIntervalHours * 3600_000;

    // Window expired or never started → full budget available
    if (!key.rateLimitWindowStart || now.getTime() - key.rateLimitWindowStart.getTime() >= windowMs) {
      return {
        allowed: true,
        remaining: key.rateLimitAmount,
        type: 'rate',
        windowResetAt: new Date(now.getTime() + windowMs),
      };
    }

    // Within active window
    const spent = key.rateLimitWindowSpent ?? 0;
    const remaining = key.rateLimitAmount - spent;
    return {
      allowed: remaining > 0,
      remaining,
      type: 'rate',
      windowResetAt: new Date(key.rateLimitWindowStart.getTime() + windowMs),
    };
  }

  // Flat plan
  return { allowed: key.balance > 0, remaining: key.balance, type: 'flat' };
}

export async function deductAndLog(entry: UsageLogEntry & { type?: 'flat' | 'rate' }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const apiKey = await tx.apiKey.findUniqueOrThrow({
      where: { id: entry.apiKeyId },
    });

    const isRate = entry.type === 'rate' ||
      (apiKey.rateLimitAmount != null && apiKey.rateLimitIntervalHours != null);

    if (isRate) {
      const now = new Date();
      const windowMs = apiKey.rateLimitIntervalHours! * 3600_000;
      const windowExpired = !apiKey.rateLimitWindowStart ||
        now.getTime() - apiKey.rateLimitWindowStart.getTime() >= windowMs;

      const currentSpent = windowExpired ? 0 : (apiKey.rateLimitWindowSpent ?? 0);
      const balanceBefore = apiKey.rateLimitAmount! - currentSpent;
      const balanceAfter = balanceBefore - entry.cost;

      await tx.apiKey.update({
        where: { id: entry.apiKeyId },
        data: {
          rateLimitWindowStart: windowExpired ? now : undefined,
          rateLimitWindowSpent: windowExpired ? entry.cost : { increment: entry.cost },
          totalSpent: { increment: entry.cost },
          totalTokens: { increment: entry.inputTokens + entry.outputTokens },
        },
      });

      await tx.usageLog.create({
        data: {
          apiKeyId: entry.apiKeyId,
          modelId: entry.modelId,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cost: entry.cost,
          balanceBefore,
          balanceAfter,
        },
      });

      logger.info('Billing recorded (rate)', {
        apiKeyId: entry.apiKeyId,
        modelId: entry.modelId,
        cost: entry.cost,
        windowRemaining: balanceAfter,
      });
    } else {
      const balanceBefore = apiKey.balance;
      const balanceAfter = balanceBefore - entry.cost;

      await tx.apiKey.update({
        where: { id: entry.apiKeyId },
        data: {
          balance: balanceAfter,
          totalSpent: { increment: entry.cost },
          totalTokens: { increment: entry.inputTokens + entry.outputTokens },
        },
      });

      await tx.usageLog.create({
        data: {
          apiKeyId: entry.apiKeyId,
          modelId: entry.modelId,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cost: entry.cost,
          balanceBefore,
          balanceAfter,
        },
      });

      logger.info('Billing recorded (flat)', {
        apiKeyId: entry.apiKeyId,
        modelId: entry.modelId,
        cost: entry.cost,
        balanceAfter,
      });
    }
  });
}
