import { PrismaClient } from '@prisma/client';

function buildDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL || '';
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '8');
    if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', '30');
    return url.toString();
  } catch {
    // Fallback for non-standard URL formats
    const sep = raw.includes('?') ? '&' : '?';
    return raw + sep + 'connection_limit=8&pool_timeout=30';
  }
}

const prisma = new PrismaClient({
  datasources: { db: { url: buildDatabaseUrl() } },
});

export default prisma;
