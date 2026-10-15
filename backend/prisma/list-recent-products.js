/**
 * READ-ONLY. Lists the most recently created catalogue products (sellerId = null)
 * so we can identify which ones were inserted by add-products.js.
 *
 * Uses a standalone Prisma client reading DATABASE_URL directly (no env.js).
 *
 * Run in production (the VPS):
 *   Postgres is not reachable from outside the VPS, so run the script inside
 *   the backend container over SSH. It gets DATABASE_URL (and the other
 *   secrets) from /opt/krushisarva/env/backend.env, and it runs the copy baked
 *   into the image (the root Dockerfile copies backend/, prisma/ included).
 *     cd /opt/krushisarva && docker compose run --rm backend node prisma/list-recent-products.js
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const LIMIT = Number(process.env.LIMIT || 30);

async function main() {
  const rows = await prisma.product.findMany({
    where: { sellerId: null },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
    select: {
      id: true, name: true, price: true, createdAt: true,
      category: { select: { name: true } },
      _count: { select: { orderItems: true, cartItems: true, reviews: true } },
    },
  });

  console.log(`\nMost recent ${rows.length} catalogue products (sellerId = null):\n`);
  for (const r of rows) {
    const refs = `orders:${r._count.orderItems} cart:${r._count.cartItems} reviews:${r._count.reviews}`;
    console.log(`  ${r.createdAt.toISOString()}  ₹${r.price}  [${r.category?.name}]  ${r.name}  (${refs})`);
    console.log(`      id=${r.id}`);
  }

  const total = await prisma.product.count({ where: { sellerId: null } });
  console.log(`\nTotal catalogue (sellerId=null) products: ${total}`);
}

main()
  .catch((err) => { console.error('❌ Failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
