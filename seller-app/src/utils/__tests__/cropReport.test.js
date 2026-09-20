import {
  confidencePercent, treatmentLabel, treatmentLabels,
  isHighRisk, offerUnavailableReason, pickerProducts, mergeSavedReply, droppedProductCount,
} from '../cropReport';

describe('confidencePercent', () => {
  test('reads the stored 0–1 fraction as a percent', () => {
    // What both write paths in ai.routes.js store: pipeline percent / 100.
    expect(confidencePercent(0.87)).toBe(87);
    expect(confidencePercent(0.9)).toBe(90);
    expect(confidencePercent(0.005)).toBe(1);
    expect(confidencePercent(0)).toBe(0);
    expect(confidencePercent(1)).toBe(100);
  });

  test('a value above 1 is already a percent, not 8,700%', () => {
    expect(confidencePercent(87)).toBe(87);
    expect(confidencePercent(42.6)).toBe(43);
  });

  test('clamps to 0–100', () => {
    expect(confidencePercent(250)).toBe(100);
    expect(confidencePercent(-0.2)).toBe(0);
  });

  test('accepts a numeric string (Prisma Decimal / JSON)', () => {
    expect(confidencePercent('0.75')).toBe(75);
  });

  test('no usable score is null, not 0%', () => {
    expect(confidencePercent(null)).toBeNull();
    expect(confidencePercent(undefined)).toBeNull();
    expect(confidencePercent('')).toBeNull();
    expect(confidencePercent('abc')).toBeNull();
    expect(confidencePercent(NaN)).toBeNull();
  });
});

// Shaped like treatment.v1.md → report.treatment.chemical / .organic entries.
const fastapiChemical = {
  product: 'Mancozeb 75% WP',
  active_ingredient: 'Mancozeb',
  dosage: '2.5 g per litre water',
  dosage_per_acre: '600–800 g in 200–300 L water',
  application_method: 'Foliar spray — early morning or evening',
};
const fastapiOrganic = {
  product: 'Pseudomonas fluorescens',
  dosage: '10 g per litre water',
  application_method: 'Foliar spray or seed treatment',
};

describe('treatmentLabel', () => {
  test('FastAPI chemical entry: product — dosage (application method)', () => {
    expect(treatmentLabel(fastapiChemical))
      .toBe('Mancozeb 75% WP — 2.5 g per litre water (Foliar spray — early morning or evening)');
  });

  test('FastAPI organic entry', () => {
    expect(treatmentLabel(fastapiOrganic))
      .toBe('Pseudomonas fluorescens — 10 g per litre water (Foliar spray or seed treatment)');
  });

  test('falls back to active_ingredient, then a biological agent', () => {
    expect(treatmentLabel({ active_ingredient: 'Copper oxychloride', dosage: '3 g/L' }))
      .toBe('Copper oxychloride — 3 g/L');
    expect(treatmentLabel({ agent: 'Trichoderma viride', dosage: '5 g/L' }))
      .toBe('Trichoderma viride — 5 g/L');
  });

  test('per-acre dosage when there is no per-litre one', () => {
    expect(treatmentLabel({ product: 'Neem oil', dosage_per_acre: '1 L in 200 L water' }))
      .toBe('Neem oil — 1 L in 200 L water');
  });

  test('legacy keys still work: name / dose / timing', () => {
    expect(treatmentLabel({ name: 'Carbendazim', dose: '1 g/L', timing: 'at first symptoms' }))
      .toBe('Carbendazim — 1 g/L (at first symptoms)');
    expect(treatmentLabel({ chemical: 'Sulphur' })).toBe('Sulphur');
    expect(treatmentLabel({ method: 'Remove infected leaves' })).toBe('Remove infected leaves');
  });

  test('a string entry is used as-is', () => {
    expect(treatmentLabel('  Spray neem oil 5 ml/L  ')).toBe('Spray neem oil 5 ml/L');
  });

  test('nothing to name → empty, never a bare dose', () => {
    expect(treatmentLabel({ dosage: '2 g/L', application_method: 'spray' })).toBe('');
    expect(treatmentLabel({ product: '   ' })).toBe('');
    expect(treatmentLabel({ product: { en: 'x' } })).toBe('');
    expect(treatmentLabel({})).toBe('');
    expect(treatmentLabel(null)).toBe('');
    expect(treatmentLabel(42)).toBe('');
    expect(treatmentLabel('   ')).toBe('');
  });

  test('blank optional parts leave no dangling separators', () => {
    expect(treatmentLabel({ product: 'Mancozeb', dosage: '', application_method: '  ' })).toBe('Mancozeb');
  });
});

describe('treatmentLabels', () => {
  test('drops entries that produce no text', () => {
    expect(treatmentLabels([fastapiOrganic, {}, null, { dosage: '2 g/L' }, 'Neem oil']))
      .toEqual([
        'Pseudomonas fluorescens — 10 g per litre water (Foliar spray or seed treatment)',
        'Neem oil',
      ]);
  });

  test('empties do not consume the cap', () => {
    expect(treatmentLabels([{}, {}, 'A', {}, 'B', 'C'], 2)).toEqual(['A', 'B']);
  });

  test('not a list → empty', () => {
    expect(treatmentLabels(undefined)).toEqual([]);
    expect(treatmentLabels('Mancozeb')).toEqual([]);
    expect(treatmentLabels({ product: 'Mancozeb' })).toEqual([]);
  });
});

describe('isHighRisk', () => {
  test('HIGH and CRITICAL are both high', () => {
    expect(isHighRisk('HIGH')).toBe(true);
    expect(isHighRisk('CRITICAL')).toBe(true);
    expect(isHighRisk('critical')).toBe(true);
  });

  test('everything else is not', () => {
    for (const level of ['LOW', 'MODERATE', 'MEDIUM', '', null, undefined]) {
      expect(isHighRisk(level)).toBe(false);
    }
  });
});

// One /agristore/seller/products row: `status` is the product's QC state,
// `isActive` / `stock` are the listing's.
const row = (over = {}) => ({ id: 'p1', listingId: 'l1', name: 'Mancozeb', status: 'APPROVED', isActive: true, stock: 5, ...over });

describe('offerUnavailableReason — mirrors what the reply route keeps', () => {
  test('approved, active and in stock is recommendable', () => {
    expect(offerUnavailableReason(row())).toBeNull();
  });

  test('out of stock (including an OUT_OF_STOCK listing, which reads isActive=false)', () => {
    expect(offerUnavailableReason(row({ stock: 0 }))).toBe('outOfStock');
    expect(offerUnavailableReason(row({ stock: 0, isActive: false }))).toBe('outOfStock');
    expect(offerUnavailableReason(row({ stock: null }))).toBe('outOfStock');
  });

  test('a paused listing with stock is hidden', () => {
    expect(offerUnavailableReason(row({ isActive: false }))).toBe('hidden');
  });

  test('a product still in QC (or rejected / merged) is not approved', () => {
    expect(offerUnavailableReason(row({ status: 'PENDING_QC' }))).toBe('notApproved');
    expect(offerUnavailableReason(row({ status: 'REJECTED', stock: 0 }))).toBe('notApproved');
  });
});

describe('pickerProducts', () => {
  test('one row per product; a product is pickable when any of its packs is', () => {
    const out = pickerProducts([
      row({ id: 'a', listingId: 'a-250g', stock: 0 }),
      row({ id: 'b', listingId: 'b-1kg' }),
      row({ id: 'a', listingId: 'a-1kg', stock: 3 }),
    ]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b']); // first-seen order kept
    expect(out[0]).toMatchObject({ listingId: 'a-1kg', unavailable: null });
    expect(out[1]).toMatchObject({ listingId: 'b-1kg', unavailable: null });
  });

  test('keeps the first pack when none is pickable', () => {
    const out = pickerProducts([
      row({ id: 'a', listingId: 'a1', stock: 0 }),
      row({ id: 'a', listingId: 'a2', isActive: false }),
    ]);
    expect(out).toEqual([expect.objectContaining({ listingId: 'a1', unavailable: 'outOfStock' })]);
  });

  test('tolerates junk', () => {
    expect(pickerProducts(undefined)).toEqual([]);
    expect(pickerProducts([null, {}, row()])).toHaveLength(1);
  });
});

describe('mergeSavedReply', () => {
  const before = {
    id: 's1', status: 'PENDING', sellerReply: null, recommendedSku: 'Old SKU',
    recommendedProductIds: [], available: false, report: { id: 'r1' },
  };

  test('a first reply keeps "in stock" and the kept products', () => {
    const saved = {
      id: 's1', status: 'REPLIED', sellerReply: 'Spray Mancozeb.', recommendedSku: null,
      recommendedProductIds: ['p1', 'p2'], available: true, repliedAt: '2026-09-19T10:00:00.000Z',
    };
    expect(mergeSavedReply(before, saved)).toEqual({
      ...before,
      status: 'REPLIED',
      sellerReply: 'Spray Mancozeb.',
      recommendedSku: null, // cleared, not left as the old value
      recommendedProductIds: ['p1', 'p2'],
      available: true,
      repliedAt: '2026-09-19T10:00:00.000Z',
    });
  });

  test('an update carries the new text; the report itself is untouched', () => {
    const merged = mergeSavedReply(
      { ...before, status: 'REPLIED', sellerReply: 'Old advice' },
      { status: 'REPLIED', sellerReply: 'New advice', recommendedProductIds: [], available: false },
    );
    expect(merged.sellerReply).toBe('New advice');
    expect(merged.report).toBe(before.report);
  });

  test('nothing to merge → the share unchanged', () => {
    expect(mergeSavedReply(before, undefined)).toBe(before);
    expect(mergeSavedReply(null, { status: 'REPLIED' })).toBeNull();
  });
});

describe('droppedProductCount', () => {
  test('counts ids the server left out', () => {
    expect(droppedProductCount(['a', 'b', 'c'], { recommendedProductIds: ['a'] })).toBe(2);
    expect(droppedProductCount(['a'], { recommendedProductIds: ['a'] })).toBe(0);
    expect(droppedProductCount([], { recommendedProductIds: [] })).toBe(0);
  });

  test('an unexpected response never claims products were dropped', () => {
    expect(droppedProductCount(['a'], {})).toBe(0);
    expect(droppedProductCount(['a'], undefined)).toBe(0);
  });
});
