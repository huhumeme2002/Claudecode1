require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const models = await prisma.modelMapping.findMany({
    where: { enabled: true },
    select: { displayName: true, actualModel: true, apiFormat: true }
  });
  console.log(JSON.stringify(models, null, 2));
  await prisma.$disconnect();
}

main().catch(console.error);
