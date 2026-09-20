/**
 * Maharashtra districts the state renamed, and every spelling each one goes by.
 *
 * The farmer app's district list and India Post use the new names (Dharashiv);
 * the seller app's picker, and every row written before the rename, use the old
 * ones (Osmanabad). Matching a buyer's district against a seller's or a
 * listing's by one spelling missed the other side: a Dharashiv farmer never
 * found an Osmanabad Kendra, and the reverse.
 *
 * Mirrors RENAMED_DISTRICTS in shared/constants/locations.js — the backend does
 * not import shared/, so keep the two in step.
 */
import { Prisma } from '@prisma/client';

const RENAMED_DISTRICT_GROUPS = [
  ['Dharashiv', 'Osmanabad'],
  ['Ahilyanagar', 'Ahilya Nagar', 'Ahmednagar'],
  ['Chhatrapati Sambhajinagar', 'Aurangabad'],
];

const key = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const GROUP_BY_KEY = new Map(
  RENAMED_DISTRICT_GROUPS.flatMap((group) => group.map((name) => [key(name), group])),
);

/**
 * Every spelling of `district`, found case-insensitively: the trimmed input
 * first, then its other names. [] for a blank input, [input] for a district
 * that was never renamed. No two entries differ only by case.
 */
export function districtSpellings(district) {
  const raw = district == null ? '' : String(district).trim();
  if (!raw) return [];
  const group = GROUP_BY_KEY.get(key(raw));
  if (!group) return [raw];
  return [raw, ...group.filter((name) => key(name) !== key(raw))];
}

/**
 * Prisma string filter matching any spelling of `district`, case-insensitively
 * (`LOWER(col) IN (...)`). A blank input matches nothing — never `undefined`,
 * which Prisma would read as "no condition" and match everything.
 */
export function districtIn(district) {
  return { in: districtSpellings(district), mode: 'insensitive' };
}

/**
 * The same filter for a TALUKA column.
 *
 * Each renamed district's headquarters taluka was renamed with it and is spelled
 * exactly like the district — Osmanabad taluka is now Dharashiv taluka,
 * Aurangabad taluka is Chhatrapati Sambhajinagar taluka, Ahmednagar taluka is
 * Ahilyanagar taluka — so the district groups above cover talukas too. Every
 * other taluka kept its name, and for those this is the plain case-insensitive
 * equality it replaces.
 *
 * The two sides genuinely disagree: the taluka pickers in both apps offer only
 * the old spelling (shared getTalukas() keys the taluka table by the old district
 * name), while PIN autofill writes whatever India Post returns for the block,
 * which can be the new one. So a taluka-scoped offer saved as "Osmanabad" was
 * invisible to exactly the buyers it was meant for.
 */
export function talukaIn(taluka) {
  return districtIn(taluka);
}

/**
 * Prisma `where` fragment: `field` CONTAINS any spelling of `district`,
 * case-insensitively — for the free-text location columns (rent, animals).
 * Pass an already-sanitized term (sanitizeSearch); the aliases add no wildcards.
 */
export function districtContainsAny(field, district) {
  return { OR: districtSpellings(district).map((d) => ({ [field]: { contains: d, mode: 'insensitive' } })) };
}

/**
 * The same predicate as raw SQL, for the hand-written geo queries. `column` is
 * inlined, so it must be a constant from the caller, never user input.
 */
export function districtContainsAnySql(column, district) {
  const spellings = districtSpellings(district);
  if (!spellings.length) return Prisma.sql`FALSE`;
  const col = Prisma.raw(column);
  return Prisma.sql`(${Prisma.join(spellings.map((d) => Prisma.sql`${col} ILIKE '%' || ${d} || '%'`), ' OR ')})`;
}

/** True when `a` and `b` name the same district under any spelling. */
export function isSameDistrict(a, b) {
  const as = districtSpellings(a);
  if (!as.length) return false;
  const bKey = b == null ? '' : key(String(b));
  return as.some((name) => key(name) === bKey);
}
