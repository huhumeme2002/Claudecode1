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

    if (!key.rateLimitWindowStart || now.getTime() - key.rateLimitWindowStart.getTime() >= windowMs) {
      return {
        allowed: true,
        remaining: key.rateLimitAmount,
        type: 'rate',
        windowResetAt: new Date(now.getTime() + windowMs),
      };
    }

    const spent = key.rateLimitWindowSpent ?? 0;
    const remaining = key.rateLimitAmount - spent;
    return {
      allowed: remaining > 0,
      remaining,
      type: 'rate',
      windowResetAt: new Date(key.rateLimitWindowStart.getTime() + windowMs),
    };
  }

  return { allowed: key.balance > 0, remaining: key.balance, type: 'flat' };
}

// ─── Batch Billing Queue ──────────────────────────────────────────
// Instead of writing to DB on every request (100+ writes/second),
// we accumulate entries in memory and flush every FLUSH_INTERVAL_MS.
// This reduces DB operations by ~98%.

interface QueuedEntry {
  apiKeyId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  type: 'flat' | 'rate';
  timestamp: Date;
}

const billingQueue: QueuedEntry[] = [];
const FLUSH_INTERVAL_MS = 5_000; // Flush every 5 seconds
const MAX_QUEUE_SIZE = 200;      // Force flush if queue gets too large
const MAX_RETRY_QUEUE_SIZE = 500; // Hard cap after retry re-inserts — drop oldest if exceeded
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Queue a billing entry for batch processing.
 * This is O(1) — no DB hit, just pushes to an array.
 */
export function deductAndLog(entry: UsageLogEntry & { type?: 'flat' | 'rate' }): void {
  billingQueue.push({
    apiKeyId: entry.apiKeyId,
    modelId: entry.modelId,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cost: entry.cost,
    type: entry.type || 'flat',
    timestamp: new Date(),
  });

  logger.debug('Billing queued', {
    apiKeyId: entry.apiKeyId,
    modelId: entry.modelId,
    cost: entry.cost,
    queueSize: billingQueue.length,
  });

  // Force flush if queue is too large
  if (billingQueue.length >= MAX_QUEUE_SIZE) {
    flushBillingQueue();
  }
}

/**
 * Flush all queued billing entries to the database.
 * Groups by apiKeyId for efficient batch UPDATEs.
 */
async function flushBillingQueue(): Promise<void> {
  if (billingQueue.length === 0) return;

  // Drain the queue atomically
  const entries = billingQueue.splice(0);
  const startTime = Date.now();

  try {
    // Group entries by apiKeyId for efficient batch updates
    const byKey = new Map<string, {
      totalCost: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      type: 'flat' | 'rate';
      entries: QueuedEntry[];
    }>();

    for (const e of entries) {
      let group = byKey.get(e.apiKeyId);
      if (!group) {
        group = { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, type: e.type, entries: [] };
        byKey.set(e.apiKeyId, group);
      }
      group.totalCost += e.cost;
      group.totalInputTokens += e.inputTokens;
      group.totalOutputTokens += e.outputTokens;
      group.entries.push(e);
    }

    // Process each apiKey group
    const updatePromises: Promise<void>[] = [];

    for (const [apiKeyId, group] of byKey) {
      updatePromises.push(processKeyGroup(apiKeyId, group));
    }

    await Promise.allSettled(updatePromises);

    const elapsed = Date.now() - startTime;
    logger.info(`Billing flush completed`, {
      entries: entries.length,
      keys: byKey.size,
      elapsed: `${elapsed}ms`,
    });
  } catch (err) {
    logger.error('Billing flush failed', { entries: entries.length, error: err });
    // Put entries back at the front of the queue for retry
    billingQueue.unshift(...entries);

    // Hard cap: if queue exceeds limit after retry re-insert, drop oldest entries to prevent OOM
    if (billingQueue.length > MAX_RETRY_QUEUE_SIZE) {
      const dropped = billingQueue.splice(MAX_RETRY_QUEUE_SIZE);
      logger.error(`Billing queue overflow — dropped ${dropped.length} entries to prevent OOM. Persistent DB failure suspected.`);
    }
  }
}

async function processKeyGroup(
  apiKeyId: string,
  group: {
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    type: 'flat' | 'rate';
    entries: QueuedEntry[];
  }
): Promise<void> {
  try {
    const totalTokens = group.totalInputTokens + group.totalOutputTokens;

    if (group.type === 'rate') {
      // Single atomic UPDATE for all rate-limited entries in this group
      const result = await prisma.$queryRawUnsafe<Array<{
        rate_limit_amount: number;
        new_spent: number;
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
          COALESCE(rate_limit_window_spent, 0) as new_spent`,
        group.totalCost,
        totalTokens,
        apiKeyId,
      );

      const row = result[0];
      const currentSpent = row?.new_spent ?? 0;
      const rateAmount = row?.rate_limit_amount ?? 0;

      // Build usage log entries with approximate balance values
      let runningSpent = currentSpent - group.totalCost; // rewind to before batch
      const logData = group.entries.map(e => {
        const balanceBefore = rateAmount - runningSpent;
        runningSpent += e.cost;
        const balanceAfter = rateAmount - runningSpent;
        return {
          apiKeyId: e.apiKeyId,
          modelId: e.modelId,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cost: e.cost,
          balanceBefore,
          balanceAfter,
          createdAt: e.timestamp,
        };
      });

      // Batch INSERT all usage logs at once
      await prisma.usageLog.createMany({ data: logData });

    } else {
      // Single atomic UPDATE for flat-plan entries
      const result = await prisma.$queryRawUnsafe<Array<{ balance: number }>>(
        `UPDATE api_keys SET
          balance = balance - $1,
          total_spent = total_spent + $1,
          total_tokens = total_tokens + $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING balance as balance`,
        group.totalCost,
        totalTokens,
        apiKeyId,
      );

      const currentBalance = result[0]?.balance ?? 0;

      // Build usage log entries
      let runningBalance = currentBalance + group.totalCost; // rewind
      const logData = group.entries.map(e => {
        const balanceBefore = runningBalance;
        runningBalance -= e.cost;
        return {
          apiKeyId: e.apiKeyId,
          modelId: e.modelId,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cost: e.cost,
          balanceBefore,
          balanceAfter: runningBalance,
          createdAt: e.timestamp,
        };
      });

      await prisma.usageLog.createMany({ data: logData });
    }
  } catch (err) {
    logger.error('Billing flush failed for key', {
      apiKeyId,
      cost: group.totalCost,
      entries: group.entries.length,
      error: err,
    });
  }
}

// Start the flush timer
function startBillingFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushBillingQueue().catch(err => {
      logger.error('Billing flush timer error', { error: err });
    });
  }, FLUSH_INTERVAL_MS);

  // Ensure flush on process exit (PM2 restart, SIGINT, etc.)
  const gracefulFlush = () => {
    logger.info('Flushing billing queue before exit...');
    flushBillingQueue()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', gracefulFlush);
  process.on('SIGTERM', gracefulFlush);
}

// Auto-start the timer when this module loads
startBillingFlushTimer();
