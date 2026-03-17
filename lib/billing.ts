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
  try {
    // Use raw SQL for atomic update — avoids interactive transaction lock contention
    // This is much faster under high concurrency than $transaction read-then-write
    const isRate = entry.type === 'rate';
    const totalTokens = entry.inputTokens + entry.outputTokens;

    if (isRate) {
      // Atomic rate-limit update + get balance info in one query
      const result = await prisma.$queryRawUnsafe<Array<{
        rate_limit_amount: number;
        old_spent: number;
        window_expired: boolean;
      }>>(
        `UPDATE api_keys SET
          rate_limit_window_start = CASE
            WHEN rate_limit_window_start IS NULL
              OR EXTRACT(EPOCH FROM (NOW() - rate_limit_window_start)) * 1000 >= rate_limit_interval_hours * 3600000
            THEN NOW()
            ELSE rate_limit_window_start
          END,
          rate_limit_window_spent = CASE
            WHEN rate_limit_window_start IS NULL
              OR EXTRACT(EPOCH FROM (NOW() - rate_limit_window_start)) * 1000 >= rate_limit_interval_hours * 3600000
            THEN $1
            ELSE COALESCE(rate_limit_window_spent, 0) + $1
          END,
          total_spent = total_spent + $1,
          total_tokens = total_tokens + $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING
          rate_limit_amount,
          COALESCE(rate_limit_window_spent, 0) - $1 as old_spent,
          (rate_limit_window_start IS NULL
            OR EXTRACT(EPOCH FROM (NOW() - rate_limit_window_start)) * 1000 >= rate_limit_interval_hours * 3600000
          ) as window_expired`,
        entry.cost,
        totalTokens,
        entry.apiKeyId,
      );

      const row = result[0];
      const oldSpent = row?.window_expired ? 0 : (row?.old_spent ?? 0);
      const balanceBefore = (row?.rate_limit_amount ?? 0) - oldSpent;
      const balanceAfter = balanceBefore - entry.cost;

      // Insert usage log (non-blocking, separate query)
      await prisma.usageLog.create({
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
      // Atomic flat-plan deduction
      const result = await prisma.$queryRawUnsafe<Array<{ balance: number }>>(
        `UPDATE api_keys SET
          balance = balance - $1,
          total_spent = total_spent + $1,
          total_tokens = total_tokens + $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING balance + $1 as balance`,
        entry.cost,
        totalTokens,
        entry.apiKeyId,
      );

      const balanceBefore = result[0]?.balance ?? 0;
      const balanceAfter = balanceBefore - entry.cost;

      await prisma.usageLog.create({
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
  } catch (err) {
    logger.error('Billing deduction failed (usage may be missed)', {
      apiKeyId: entry.apiKeyId,
      modelId: entry.modelId,
      cost: entry.cost,
      error: err,
    });
  }
}
