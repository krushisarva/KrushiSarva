/**
 * The on-device preferences behind "Change location" and recent searches.
 * These run against the in-memory AsyncStorage mock (see jest.config.js).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getManualLocation, setManualLocation,
  getRecentSearches, pushRecentSearch, clearRecentSearches,
  relativeTime, pincodePlace,
} from '../animalPrefs';
import { summarisePincode } from '@krushisarva/shared/utils/pincode';

const office = (name, block, district, state = 'Maharashtra') => ({
  name, block, district, state, delivery: true, branchType: null,
});

describe('pincodePlace', () => {
  const baramati = summarisePincode({
    pincode: '413102', found: true,
    postOffices: [office('Baramati', 'Baramati', 'Pune'), office('Barhanpur', 'Baramati', 'Pune')],
  });

  it('turns a PIN into a district the listing filter can match', () => {
    expect(pincodePlace(baramati)).toEqual({
      label: 'Baramati, Pune (413102)', pincode: '413102', district: 'Pune',
      taluka: 'Baramati', village: undefined, state: 'Maharashtra',
    });
  });

  it('names the village the user picked', () => {
    const place = pincodePlace(baramati, baramati.localities[1]);
    expect(place).toMatchObject({ label: 'Barhanpur, Pune (413102)', district: 'Pune', village: 'Barhanpur' });
  });

  it('a PIN spanning districts needs a village first', () => {
    const delhi = summarisePincode({
      pincode: '110001', found: true,
      postOffices: [office('Connaught Place', 'New Delhi', 'Central Delhi', 'Delhi'), office('Sansad Marg', 'New Delhi', 'New Delhi', 'Delhi')],
    });
    expect(pincodePlace(delhi)).toBeNull();
    expect(pincodePlace(delhi, delhi.localities[1])).toMatchObject({ district: 'New Delhi' });
  });

  it('does not repeat a district that is also the taluka', () => {
    const beed = summarisePincode({ pincode: '431122', found: true, postOffices: [office('Beed', 'Beed', 'Beed')] });
    expect(pincodePlace(beed).label).toBe('Beed (431122)');
  });

  it('nothing for an unknown PIN', () => {
    expect(pincodePlace(summarisePincode({ pincode: '999999', found: false, postOffices: [] }))).toBeNull();
    expect(pincodePlace(null)).toBeNull();
  });
});

beforeEach(async () => { await AsyncStorage.clear(); });

describe('manual location', () => {
  it('round-trips a hand-picked place', async () => {
    await setManualLocation({ label: 'Baramati, Pune' });
    const loc = await getManualLocation();
    expect(loc.label).toBe('Baramati, Pune');
    expect(typeof loc.savedAt).toBe('number');
  });

  it('returns null when nothing has been chosen', async () => {
    expect(await getManualLocation()).toBeNull();
  });

  it('forgets the place when cleared', async () => {
    await setManualLocation({ label: '413102', pincode: '413102' });
    await setManualLocation(null);
    expect(await getManualLocation()).toBeNull();
  });

  it('survives a corrupted stored value instead of throwing', async () => {
    // A half-written value must not crash the marketplace on launch.
    await AsyncStorage.setItem('@animals:manualLocation', '{not json');
    expect(await getManualLocation()).toBeNull();
  });
});

describe('recent searches', () => {
  it('keeps the newest first', async () => {
    await pushRecentSearch('murrah');
    await pushRecentSearch('gir');
    expect(await getRecentSearches()).toEqual(['gir', 'murrah']);
  });

  it('moves a repeated search to the front rather than duplicating it', async () => {
    await pushRecentSearch('murrah');
    await pushRecentSearch('gir');
    await pushRecentSearch('MURRAH'); // case-insensitive
    expect(await getRecentSearches()).toEqual(['MURRAH', 'gir']);
  });

  it('caps the list so it cannot grow without bound', async () => {
    for (let i = 0; i < 20; i++) await pushRecentSearch(`breed${i}`);
    const list = await getRecentSearches();
    expect(list).toHaveLength(6);
    expect(list[0]).toBe('breed19');
  });

  it('ignores one-character noise', async () => {
    await pushRecentSearch('g');
    await pushRecentSearch('  ');
    expect(await getRecentSearches()).toEqual([]);
  });

  it('clears on request', async () => {
    await pushRecentSearch('gir');
    await clearRecentSearches();
    expect(await getRecentSearches()).toEqual([]);
  });
});

describe('relativeTime', () => {
  it('describes how stale the cached listings are', () => {
    expect(relativeTime(Date.now() - 5_000)).toBe('just now');
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5 min ago');
    expect(relativeTime(Date.now() - 3 * 3_600_000)).toBe('3 hr ago');
    expect(relativeTime(Date.now() - 2 * 86_400_000)).toBe('2 d ago');
  });

  it('renders nothing when there is no timestamp', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(0)).toBe('');
  });
});
