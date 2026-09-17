import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/common/crypto.js';

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password || password === 'replace-before-production') {
    throw new Error('Set ADMIN_USERNAME and a non-default ADMIN_PASSWORD before seeding');
  }

  await prisma.admin.upsert({
    where: { username },
    create: { username, passwordHash: await hashPassword(password) },
    update: { passwordHash: await hashPassword(password), isActive: true }
  });
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
