import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  apiKey?: {
    id: string;
    name: string;
    key: string;
    balance: number;
    enabled: boolean;
    rateLimitAmount: number | null;
    rateLimitIntervalHours: number | null;
    rateLimitWindowStart: Date | null;
    rateLimitWindowSpent: number | null;
  };
  adminAuth?: boolean;
}

export interface UsageLogEntry {
  apiKeyId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface DashboardStats {
  totalKeys: number;
  activeKeys: number;
  totalModels: number;
  totalRequests: number;
  totalTokens: number;
  totalRevenue: number;
  recentUsage: Array<{
    date: string;
    requests: number;
    tokens: number;
    cost: number;
  }>;
}

export interface EffectiveSettings {
  globalSystemPrompt: string;
  systemPromptEnabled: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
