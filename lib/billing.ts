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

export async function deductAndLog(entry: UsageLogEntry): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const apiKey = await tx.apiKey.findUniqueOrThrow({
      where: { id: entry.apiKeyId },
    });

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

    logger.info('Billing recorded', {
      apiKeyId: entry.apiKeyId,
      modelId: entry.modelId,
      cost: entry.cost,
      balanceAfter,
    });
  });
}
