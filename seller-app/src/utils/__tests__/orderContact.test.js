import { deliveryPhone, dialableNumber, mapQuery, mapUrls, telUrl } from '../orderContact';
import { openExternalUrl } from '../openUrl';

const address = {
  name: 'Sunita Patil', phone: '+91 98765 43210',
  flat: 'House 12', street: 'Mandir Road', landmark: 'Near Hanuman Mandir',
  city: 'Kasegaon', state: 'Maharashtra', pincode: '413304',
};

describe('dialableNumber', () => {
  test('dials the last ten digits of whatever checkout accepted', () => {
    expect(dialableNumber('+91 98765 43210')).toBe('+919876543210');
    expect(dialableNumber('09876543210')).toBe('+919876543210');
    expect(dialableNumber('98765-43210')).toBe('+919876543210');
    expect(dialableNumber(9876543210)).toBe('+919876543210');
  });

  test('refuses anything that is not a whole number', () => {
    expect(dialableNumber('98765')).toBeNull();
    expect(dialableNumber('')).toBeNull();
    expect(dialableNumber(null)).toBeNull();
    expect(dialableNumber('not a phone')).toBeNull();
  });
});

describe('deliveryPhone', () => {
  const user = { phone: '9123456780' };

  test('the phone typed at checkout wins over the account phone', () => {
    expect(deliveryPhone({ deliveryAddress: address, user })).toBe('+919876543210');
  });

  test('falls back to the buyer\'s account phone', () => {
    expect(deliveryPhone({ deliveryAddress: { ...address, phone: '' }, user })).toBe('+919123456780');
    expect(deliveryPhone({ deliveryAddress: { ...address, phone: '12345' }, user })).toBe('+919123456780');
    expect(deliveryPhone({ deliveryAddress: null, user })).toBe('+919123456780');
    // An address that arrives as a string is not read character by character.
    expect(deliveryPhone({ deliveryAddress: 'Kasegaon', user })).toBe('+919123456780');
  });

  test('null when there is nobody to call, so no Call button is drawn', () => {
    expect(deliveryPhone({ deliveryAddress: { city: 'Kasegaon' }, user: {} })).toBeNull();
    expect(deliveryPhone(undefined)).toBeNull();
    expect(telUrl(deliveryPhone(undefined))).toBeNull();
  });

  test('telUrl is a link the dialler opens', () => {
    expect(telUrl('+919876543210')).toBe('tel:+919876543210');
  });
});

describe('mapQuery', () => {
  test('house to PIN code, without the name, the phone or a "Landmark:" label', () => {
    expect(mapQuery(address))
      .toBe('House 12, Mandir Road, Near Hanuman Mandir, Kasegaon, Maharashtra, 413304');
  });

  test('skips what the farmer left empty', () => {
    expect(mapQuery({ street: ' Mandir Road ', city: 'Kasegaon', pincode: '413304' }))
      .toBe('Mandir Road, Kasegaon, 413304');
  });

  test('reads addressLine only for an old order with no flat or street', () => {
    expect(mapQuery({ addressLine: 'Gat 44, Wadi', city: 'Kasegaon' })).toBe('Gat 44, Wadi, Kasegaon');
    expect(mapQuery({ flat: 'House 12', addressLine: 'Gat 44, Wadi', city: 'Kasegaon' })).toBe('House 12, Kasegaon');
  });

  test('empty when there is no address to search', () => {
    expect(mapQuery(null)).toBe('');
    expect(mapQuery('Kasegaon')).toBe('');
    expect(mapQuery({ name: 'Sunita Patil', phone: '9876543210' })).toBe('');
  });
});

describe('mapUrls', () => {
  const q = 'House%2012%2C%20Mandir%20Road%2C%20Near%20Hanuman%20Mandir%2C%20Kasegaon%2C%20Maharashtra%2C%20413304';

  test('Android opens the seller\'s own map app, then the web map', () => {
    expect(mapUrls(address, 'android')).toEqual([
      `geo:0,0?q=${q}`,
      `https://www.google.com/maps/search/?api=1&query=${q}`,
    ]);
  });

  test('iOS has no geo: link', () => {
    expect(mapUrls(address, 'ios')).toEqual([
      `https://maps.apple.com/?q=${q}`,
      `https://www.google.com/maps/search/?api=1&query=${q}`,
    ]);
  });

  test('anything else gets the web map only', () => {
    expect(mapUrls(address, 'web')).toEqual([`https://www.google.com/maps/search/?api=1&query=${q}`]);
  });

  test('an address typed in Marathi, or with & and #, cannot break out of the query', () => {
    const [geo] = mapUrls({ street: 'गट #44 & वाडी', city: 'कासेगाव' }, 'android');
    expect(geo.startsWith('geo:0,0?q=')).toBe(true);
    expect(geo.slice('geo:0,0?q='.length)).not.toMatch(/[&#\s]/);
    expect(decodeURIComponent(geo.slice('geo:0,0?q='.length))).toBe('गट #44 & वाडी, कासेगाव');
  });

  test('no address, no links — the Map button is not drawn', () => {
    expect(mapUrls(null, 'android')).toEqual([]);
    expect(mapUrls({ name: 'Sunita Patil' }, 'android')).toEqual([]);
  });

  // The screen walks the list through openExternalUrl until one opens.
  test('a phone with no map app falls through geo: to the web map', async () => {
    const linking = {
      canOpenURL: jest.fn(async () => true),
      openURL: jest.fn(async (url) => { if (url.startsWith('geo:')) throw new Error('No Activity found'); }),
    };
    let opened = null;
    for (const url of mapUrls(address, 'android')) {
      // eslint-disable-next-line no-await-in-loop
      if (await openExternalUrl(url, linking)) { opened = url; break; }
    }
    expect(opened).toBe(`https://www.google.com/maps/search/?api=1&query=${q}`);
    // geo: is tried without the canOpenURL probe that Android 11+ answers false.
    expect(linking.canOpenURL).toHaveBeenCalledTimes(1);
  });
});
