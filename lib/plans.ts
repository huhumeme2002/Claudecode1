export interface Plan {
  id: string;
  name: string;
  amount: number; // VND
  durationDays: number;
  rateLimitAmount: number; // credit per window
  rateLimitIntervalHours: number;
}

export const PLANS: Record<string, Plan> = {
  trial:  { id: 'trial',  name: 'Dùng thử', amount: 50000,  durationDays: 1,  rateLimitAmount: 20,  rateLimitIntervalHours: 5 },
  week:   { id: 'week',   name: 'Gói Tuần',  amount: 150000, durationDays: 7,  rateLimitAmount: 50,  rateLimitIntervalHours: 5 },
  pro:    { id: 'pro',    name: 'Pro',        amount: 159000, durationDays: 30, rateLimitAmount: 20,  rateLimitIntervalHours: 5 },
  max5x:  { id: 'max5x',  name: 'Max 5x',    amount: 250000, durationDays: 30, rateLimitAmount: 50,  rateLimitIntervalHours: 5 },
  max20x: { id: 'max20x', name: 'Max 20x',   amount: 450000, durationDays: 30, rateLimitAmount: 100, rateLimitIntervalHours: 5 },
};

export function getPlan(planId: string): Plan | undefined {
  return PLANS[planId];
}
