/**
 * Seed DEMO listings owned by ONE real account: AgriStore products, AnimalTrade
 * livestock and Rent machinery, so every marketplace screen has something to show
 * before real sellers arrive.
 *
 * Why not seed-ui-demo.js on production: that script creates ~50 fake accounts
 * whose generated 98/90/70/88/72… numbers are valid Indian mobiles, most likely
 * belonging to real strangers who would then get calls from farmers. Here every
 * listing belongs to the account you name, so every call, chat, booking and order
 * reaches you.
 *
 * Content (names, prices, descriptions, photo keywords) is the same
 * prisma/data/ui-demo-content.json. Nothing is invented on top of it: no ratings,
 * no review counts, no "verified" badges.
 *
 * Products use the catalog-split shape the seller app reads:
 *   products (APPROVED) → one product_variants row → one seller_listings offer (yours)
 * Offers are sellScope 'all_india' so every tester sees them whatever district
 * their profile says.
 *
 * Run (the phone must have logged in to the app at least once):
 *   node prisma/seed-demo-owned.js 9876543210                  seed / refresh
 *   node prisma/seed-demo-owned.js 9876543210 --clean          dry run of the removal
 *   node prisma/seed-demo-owned.js 9876543210 --clean --yes    remove
 * Against production, from backend/:
 *   node --env-file=.env.production prisma/seed-demo-owned.js 9876543210
 *
 * Idempotent: products match on normalizedKey, animals on (seller, animal, breed,
 * age), machines on (owner, name). A re-run refreshes the demo content but leaves
 * an existing offer's price and stock alone, since you may have edited them in the
 * seller app.
 *
 * --clean touches only rows matching this file's content under that owner.
 * Anything with history is deactivated instead of deleted: an offer or product
 * with orders or reviews, an animal with chats, a machine with bookings.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prisma from '../src/config/db.js';
import { decryptNumber } from '../src/utils/encrypt.js';
import { normalizeProductKey } from '../src/services/catalogMatch.service.js';
import { normalizedColumns } from '../src/utils/animalNormalize.js';
import { listingExpiry } from '../src/services/animalListing.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const content = JSON.parse(
  readFileSync(join(__dirname, 'data', 'ui-demo-content.json'), 'utf8')
);

const args      = process.argv.slice(2);
const FLAGS     = new Set(args.filter((a) => a.startsWith('--')));
const PHONE_ARG = args.find((a) => !a.startsWith('--'));
const CLEAN     = FLAGS.has('--clean');
const APPLY     = FLAGS.has('--yes');

const PRODUCTS = content.products;
const ANIMALS  = content.animalSellers.flatMap((s) => s.listings);
const MACHINES = content.machineryOwners.map((o) => o.listing);

// ── Helpers (same conventions as seed-ui-demo.js) ────────────────────────────

const decode = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// loremflickr photos with a FIXED lock per item, so a re-run writes the same URLs
// (seed-ui-demo.js uses one running counter, which shifts if content is reordered).
function images(kw, lockBase, count = 2) {
  const tags = String(kw || 'agriculture,india,farm')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .slice(0, 3);
  const path = tags.length ? tags.join(',') : 'agriculture,farm';
  return Array.from({ length: count }, (_, k) =>
    `https://loremflickr.com/800/600/${path}/all?lock=${lockBase + k}`);
}

// Small deterministic spread (≤ ~15 km) around the owner so listings don't stack
// on one map pin, and all stay inside the 50 km default search radius.
const jitter = (i, base) =>
  base == null ? null : +(base + ((i % 10) - 5) * 0.02 + (i % 4) * 0.004).toFixed(6);

// Machinery category → the lowercase chip keys the Rent UI filters on.
const MACH_CAT = {
  tractor: 'tractor', harvester: 'harvester', sprayer: 'sprayer',
  rotavator: 'rotavator', thresher: 'thresher', transplanter: 'transplanter',
  truck: 'truck', tempo: 'tempo',
  tiller: 'rotavator', baler: 'other', trailer: 'tempo', trolley: 'tempo',
  plough: 'other', seeder: 'other', cultivator: 'rotavator', drill: 'other',
};
const machCat = (c) => MACH_CAT[String(c || '').trim().toLowerCase()] || 'other';

// Animal type → the AnimalTrade chip keys (Bull → Bullock for the chip filter).
const animalCat = (a) => (/^bull$/i.test(String(a || '').trim()) ? 'Bullock' : String(a || '').trim());

const variantSku = (name) =>
  `DEMO-${decode(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)}`;

const masked = (phone) => `••••••${String(phone).slice(-4)}`;

// ── Owner ────────────────────────────────────────────────────────────────────

async function resolveOwner() {
  const ten = String(PHONE_ARG || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(ten)) {
    throw new Error('Pass the owner\'s 10-digit mobile: node prisma/seed-demo-owned.js 9876543210');
  }
  const owner = await prisma.user.findFirst({
    where: { phone: { in: [ten, `+91${ten}`, `91${ten}`] } },
    select: {
      id: true, phone: true, name: true, role: true, isActive: true,
      state: true, district: true, city: true, taluka: true, village: true, lat: true, lng: true,
    },
  });
  if (!owner) throw new Error(`No account with phone ${masked(ten)}. Log in to the app once with it, then re-run.`);
  if (!owner.isActive) throw new Error(`The account ${masked(ten)} is deactivated.`);
  return owner;
}

// users.lat / users.lng are ENCRYPTED text (utils/encrypt.js); the listing tables
// store plain floats. parseFloat on a ciphertext like "7f2f4d…" returns 7, which
// is how an earlier run of this script put every listing at lat 7, lng 1503921,
// outside every Rent / AnimalTrade radius search. Out-of-range or undecryptable →
// null, and the listing is stored without coordinates rather than somewhere wrong.
function coord(value, limit) {
  const n = decryptNumber(value);
  return n != null && Math.abs(n) <= limit ? n : null;
}

function placeOf(owner) {
  const state    = owner.state || 'Maharashtra';
  const district = owner.district || 'Pune';
  const city     = owner.city || district;
  let lat = coord(owner.lat, 90);
  let lng = coord(owner.lng, 180);
  if (lat == null || lng == null) {
    console.warn('  ⚠ Owner has no usable saved location — listings get no map position.');
    lat = lng = null;
  }
  return {
    state, district, city,
    taluka:  owner.taluka || null,
    village: owner.village || null,
    lat,
    lng,
    // "Pune, Maharashtra", not "Pune, Pune, Maharashtra" when city == district.
    label: [...new Set([city, district, state])].join(', '),
  };
}

// ── Lookups shared by seed and clean ─────────────────────────────────────────

async function categoryIds() {
  const cats = await prisma.category.findMany({ select: { id: true, name: true } });
  return new Map(cats.map((c) => [c.name, c.id]));
}

function productKey(p, categoryId) {
  return normalizeProductKey({ categoryId, brand: p.brand ?? null, manufacturer: null, name: decode(p.name) });
}

const findAnimal = (owner, l) => prisma.animalListing.findFirst({
  where: { sellerId: owner.id, animal: animalCat(l.animal), breed: l.breed, age: l.age },
  select: { id: true },
});

const findMachine = (owner, L) => prisma.machineryListing.findFirst({
  where: { ownerId: owner.id, name: decode(L.name) },
  select: { id: true },
});

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seedProducts(owner, at) {
  const catByName = await categoryIds();
  if (!catByName.size) {
    console.warn('  ⚠ No categories — run prisma/seed-categories.js first. Skipping products.');
    return;
  }
  let created = 0, updated = 0, skipped = 0, offers = 0;

  for (const [i, p] of PRODUCTS.entries()) {
    const categoryId = catByName.get(p.category);
    if (!categoryId) {
      console.warn(`  ⚠ No category "${p.category}" — skipped "${p.name}"`);
      skipped++;
      continue;
    }
    const normalizedKey = productKey(p, categoryId);
    const unit = p.unit || 'unit';
    const catalog = {
      categoryId,
      normalizedKey,
      name: decode(p.name),
      nameHi: p.nameHi ?? null,
      nameMr: p.nameMr ?? null,
      description: decode(p.description) || null,
      brand: p.brand ?? null,
      subcategory: p.subcategory ?? null,
      tags: p.tags ?? [],
      highlights: (p.highlights ?? []).map(decode),
      images: images(p.imageKeywords, 40000 + i * 10),
      unit,
      status: 'APPROVED',
      isActive: true,
      // Legacy offer columns stay empty: the price and stock live on the offer below.
      price: null,
      stock: 0,
    };

    const existing = await prisma.product.findFirst({ where: { normalizedKey }, select: { id: true } });
    const product = existing
      ? await prisma.product.update({ where: { id: existing.id }, data: catalog, select: { id: true } })
      : await prisma.product.create({ data: catalog, select: { id: true } });
    if (existing) updated++; else created++;

    const sku = variantSku(p.name);
    const variant = await prisma.productVariant.upsert({
      where: { productId_sku: { productId: product.id, sku } },
      update: { unit, isDefault: true },
      create: { productId: product.id, sku, unit, isDefault: true },
      select: { id: true },
    });

    const stockQty = p.stock ?? 0;
    await prisma.sellerListing.upsert({
      where: { sellerId_variantId: { sellerId: owner.id, variantId: variant.id } },
      update: {},
      create: {
        sellerId: owner.id,
        variantId: variant.id,
        sellingPrice: p.price,
        mrp: p.mrp ?? null,
        stockQty,
        status: stockQty > 0 ? 'ACTIVE' : 'OUT_OF_STOCK',
        isFeatured: !!p.isFeatured,
        condition: 'NEW',
        minOrderQty: 1,
        dispatchSlaDays: 2,
        sellScope: 'all_india',
        state: at.state, district: at.district, taluka: at.taluka, village: at.village,
      },
    });
    offers++;
  }
  console.log(`  ✓ products — created ${created}, updated ${updated}, skipped ${skipped}; your offers: ${offers}`);
}

async function seedAnimals(owner, at) {
  let created = 0, updated = 0;
  for (const [i, l] of ANIMALS.entries()) {
    const animal = animalCat(l.animal);
    const description = decode(l.description) || null;
    const tags = l.tags ?? [];
    const milkYield = l.milkYield ?? null;
    const data = {
      sellerId: owner.id,
      animal,
      breed: l.breed,
      age: l.age,
      gender: l.gender,
      weight: l.weight,
      price: l.price,
      milkYield,
      description,
      images: images(l.imageKeywords, 20000 + i * 10),
      tags,
      status: 'ACTIVE',
      sellerLocation: at.label,
      lat: jitter(i, at.lat),
      lng: jitter(i, at.lng),
      expiresAt: listingExpiry(),
      // The marketplace filters read these columns, not the tags (see seed-animals.js).
      vaccinated: tags.some((t) => /vaccinat/i.test(t)),
      healthCertificate: tags.some((t) => /certificate/i.test(t)),
      ...normalizedColumns({
        animal, breed: l.breed, age: l.age, weight: l.weight,
        milkYield, description, sellerLocation: at.label, tags,
      }),
    };
    const existing = await findAnimal(owner, l);
    if (existing) {
      await prisma.animalListing.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.animalListing.create({ data });
      created++;
    }
  }
  console.log(`  ✓ animals — created ${created}, updated ${updated}`);
}

async function seedMachines(owner, at) {
  let created = 0, updated = 0;
  for (const [i, L] of MACHINES.entries()) {
    const data = {
      ownerId: owner.id,
      name: decode(L.name),
      category: machCat(L.category),
      brand: decode(L.brand) || null,
      description: decode(L.description) || null,
      pricePerDay: L.pricePerDay,
      pricePerHour: L.pricePerHour ?? null,
      pricePerAcre: L.pricePerAcre ?? null,
      horsePower: L.horsePower || null,
      fuelType: L.fuelType || null,
      ageYears: L.ageYears ?? null,
      features: L.features ?? [],
      images: images(L.imageKeywords, 30000 + i * 10),
      location: [at.village, at.taluka].filter(Boolean).join(', ') || at.city,
      district: at.district,
      state: at.state,
      available: true,
      status: 'ACTIVE',
      ownerName: owner.name || null,
      // The owner's own number, which is all rent.routes.js ever stores here.
      ownerPhone: owner.phone,
      lat: jitter(i, at.lat),
      lng: jitter(i, at.lng),
    };
    const existing = await findMachine(owner, L);
    if (existing) {
      await prisma.machineryListing.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.machineryListing.create({ data });
      created++;
    }
  }
  console.log(`  ✓ rental machines — created ${created}, updated ${updated}`);
}

// ── Clean ────────────────────────────────────────────────────────────────────

function tally() {
  const t = { deleted: 0, deactivated: 0, kept: 0 };
  // Runs `fn` only with --yes; the counts are the same either way.
  t.do = async (kind, fn) => { t[kind]++; if (APPLY) await fn(); };
  t.line = (label) => console.log(`  ${label.padEnd(16)} delete ${t.deleted}, deactivate ${t.deactivated}, keep ${t.kept}`);
  return t;
}

async function cleanProducts(owner) {
  const catByName = await categoryIds();
  const offers = tally();
  const catalog = tally();

  for (const p of PRODUCTS) {
    const categoryId = catByName.get(p.category);
    if (!categoryId) continue;
    const product = await prisma.product.findFirst({
      where: { normalizedKey: productKey(p, categoryId) },
      select: { id: true },
    });
    if (!product) continue;

    const variant = await prisma.productVariant.findUnique({
      where: { productId_sku: { productId: product.id, sku: variantSku(p.name) } },
      select: { id: true },
    });
    const offer = variant && await prisma.sellerListing.findUnique({
      where: { sellerId_variantId: { sellerId: owner.id, variantId: variant.id } },
      select: { id: true },
    });
    if (offer) {
      // order_items.listingId is scalar-only, so a delete would not fail — check by hand.
      const sold = await prisma.orderItem.count({ where: { listingId: offer.id } });
      if (sold) {
        await offers.do('deactivated', () =>
          prisma.sellerListing.update({ where: { id: offer.id }, data: { status: 'INACTIVE' } }));
      } else {
        await offers.do('deleted', () => prisma.sellerListing.delete({ where: { id: offer.id } }));
      }
    }

    // The catalog row goes only when nothing else hangs off it. Other sellers may
    // have attached real offers to it; reviews would be silently orphaned (SET NULL).
    const [otherOffers, orders, reviews] = await Promise.all([
      prisma.sellerListing.count({
        where: { variant: { productId: product.id }, ...(offer ? { NOT: { id: offer.id } } : {}) },
      }),
      prisma.orderItem.count({ where: { productId: product.id } }),
      prisma.review.count({ where: { productId: product.id } }),
    ]);
    if (otherOffers) {
      await catalog.do('kept', async () => {});
    } else if (orders || reviews) {
      await catalog.do('deactivated', () =>
        prisma.product.update({ where: { id: product.id }, data: { status: 'REJECTED', isActive: false } }));
    } else {
      // Variants, cart items, compliance and recall rows cascade.
      await catalog.do('deleted', () => prisma.product.delete({ where: { id: product.id } }));
    }
  }
  offers.line('your offers:');
  catalog.line('catalog products:');
}

async function cleanAnimals(owner) {
  const t = tally();
  for (const l of ANIMALS) {
    const row = await findAnimal(owner, l);
    if (!row) continue;
    // chats.listingId is RESTRICT; deleting the chat would erase a real conversation.
    const chats = await prisma.chat.count({ where: { listingId: row.id } });
    if (chats) {
      await t.do('deactivated', () =>
        prisma.animalListing.update({ where: { id: row.id }, data: { status: 'INACTIVE' } }));
    } else {
      await t.do('deleted', () => prisma.animalListing.delete({ where: { id: row.id } }));
    }
  }
  t.line('animals:');
}

async function cleanMachines(owner) {
  const t = tally();
  for (const L of MACHINES) {
    const row = await findMachine(owner, L);
    if (!row) continue;
    // bookings.machineryListingId is SET NULL on delete, which would strip real
    // bookings of their machine — deactivate instead.
    const bookings = await prisma.booking.count({ where: { machineryListingId: row.id } });
    if (bookings) {
      await t.do('deactivated', () =>
        prisma.machineryListing.update({ where: { id: row.id }, data: { status: 'INACTIVE', available: false } }));
    } else {
      await t.do('deleted', () => prisma.machineryListing.delete({ where: { id: row.id } }));
    }
  }
  t.line('rental machines:');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const owner = await resolveOwner();
  const who = `${owner.name || 'unnamed'} (${masked(owner.phone)}, ${owner.role})`;

  if (CLEAN) {
    console.log(`${APPLY ? 'Removing' : 'DRY RUN — would remove'} demo listings owned by ${who}`);
    await cleanProducts(owner);
    await cleanAnimals(owner);
    await cleanMachines(owner);
    if (!APPLY) console.log('\nNothing changed. Re-run with --clean --yes to apply.');
    return;
  }

  const at = placeOf(owner);
  console.log(`Seeding demo listings owned by ${who}, located at ${at.label}`);
  await seedProducts(owner, at);
  await seedAnimals(owner, at);
  await seedMachines(owner, at);
  console.log('Done.');
}

main()
  .catch((err) => { console.error('❌', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
