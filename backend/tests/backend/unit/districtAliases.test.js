/**
 * districtAliases — every spelling of a renamed Maharashtra district.
 *
 * The farmer app stores the new names (Dharashiv), the seller app the old ones
 * (Osmanabad); discovery queries match on this list so neither side misses the
 * other.
 */
import {
  districtSpellings, districtIn, districtContainsAny, districtContainsAnySql, isSameDistrict,
} from '../../../src/utils/districtAliases.js';

describe('districtSpellings', () => {
  it('expands a new name to the old one, input first', () => {
    expect(districtSpellings('Dharashiv')).toEqual(['Dharashiv', 'Osmanabad']);
    expect(districtSpellings('Chhatrapati Sambhajinagar')).toEqual(['Chhatrapati Sambhajinagar', 'Aurangabad']);
  });

  it('expands an old name to the new ones', () => {
    expect(districtSpellings('Osmanabad')).toEqual(['Osmanabad', 'Dharashiv']);
    expect(districtSpellings('Ahmednagar')).toEqual(['Ahmednagar', 'Ahilyanagar', 'Ahilya Nagar']);
    expect(districtSpellings('Aurangabad')).toEqual(['Aurangabad', 'Chhatrapati Sambhajinagar']);
  });

  it('looks the name up case- and whitespace-insensitively, without case duplicates', () => {
    expect(districtSpellings('  dharashiv ')).toEqual(['dharashiv', 'Osmanabad']);
    expect(districtSpellings('AHILYA   NAGAR')).toEqual(['AHILYA   NAGAR', 'Ahilyanagar', 'Ahmednagar']);
  });

  it('leaves a district that was never renamed alone', () => {
    expect(districtSpellings('Pune')).toEqual(['Pune']);
    expect(districtSpellings(' Solapur ')).toEqual(['Solapur']);
  });

  it('returns nothing for a blank district', () => {
    expect(districtSpellings('')).toEqual([]);
    expect(districtSpellings('   ')).toEqual([]);
    expect(districtSpellings(null)).toEqual([]);
    expect(districtSpellings(undefined)).toEqual([]);
  });
});

describe('districtIn', () => {
  it('is a case-insensitive IN over every spelling', () => {
    expect(districtIn('Dharashiv')).toEqual({ in: ['Dharashiv', 'Osmanabad'], mode: 'insensitive' });
    expect(districtIn('Pune')).toEqual({ in: ['Pune'], mode: 'insensitive' });
  });

  it('matches nothing for a blank district, rather than everything', () => {
    // `undefined` would be read by Prisma as "no condition".
    expect(districtIn('  ')).toEqual({ in: [], mode: 'insensitive' });
  });
});

describe('districtContainsAny / districtContainsAnySql', () => {
  it('ORs a case-insensitive contains per spelling', () => {
    expect(districtContainsAny('sellerLocation', 'Osmanabad')).toEqual({
      OR: [
        { sellerLocation: { contains: 'Osmanabad', mode: 'insensitive' } },
        { sellerLocation: { contains: 'Dharashiv', mode: 'insensitive' } },
      ],
    });
  });

  it('builds a parameterised ILIKE per spelling — the names are values, not SQL', () => {
    const sql = districtContainsAnySql('district', 'Dharashiv');
    expect(sql.sql).toBe("(district ILIKE '%' || ? || '%' OR district ILIKE '%' || ? || '%')");
    expect(sql.values).toEqual(['Dharashiv', 'Osmanabad']);
  });

  it('is FALSE for a blank district', () => {
    expect(districtContainsAnySql('district', '').sql).toBe('FALSE');
  });
});

describe('isSameDistrict', () => {
  it('treats the old and new names as one district, in either order and any case', () => {
    expect(isSameDistrict('Dharashiv', 'Osmanabad')).toBe(true);
    expect(isSameDistrict('osmanabad', 'DHARASHIV')).toBe(true);
    expect(isSameDistrict('Aurangabad', 'Chhatrapati Sambhajinagar')).toBe(true);
    expect(isSameDistrict('Pune', 'pune')).toBe(true);
  });

  it('keeps different districts apart', () => {
    expect(isSameDistrict('Dharashiv', 'Pune')).toBe(false);
    expect(isSameDistrict('Osmanabad', 'Ahmednagar')).toBe(false);
    expect(isSameDistrict('', '')).toBe(false);
    expect(isSameDistrict(null, 'Pune')).toBe(false);
  });
});
