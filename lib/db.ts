import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL || '';
const poolParams = 'connection_limit=10&pool_timeout=30';
const separator = databaseUrl.includes('?') ? '&' : '?';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl + separator + poolParams,
    },
  },
});

export default prisma;
