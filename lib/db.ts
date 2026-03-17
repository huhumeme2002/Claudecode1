import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL || '';
const poolParams = 'connection_limit=5&pool_timeout=10';
const separator = databaseUrl.includes('?') ? '&' : '?';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl + separator + poolParams,
    },
  },
});

export default prisma;
