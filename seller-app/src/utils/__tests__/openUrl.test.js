import { openExternalUrl } from '../openUrl';

function fakeLinking({ canOpen = false, openRejects = false } = {}) {
  return {
    canOpenURL: jest.fn(async () => canOpen),
    openURL: jest.fn(async () => { if (openRejects) throw new Error('No Activity found'); }),
  };
}

describe('openExternalUrl', () => {
  test('tel: is opened without asking canOpenURL (false on Android 11+ without <queries>)', async () => {
    const linking = fakeLinking({ canOpen: false });
    await expect(openExternalUrl('tel:9876543210', linking)).resolves.toBe(true);
    expect(linking.canOpenURL).not.toHaveBeenCalled();
    expect(linking.openURL).toHaveBeenCalledWith('tel:9876543210');
  });

  test('other non-https schemes skip the probe too', async () => {
    for (const url of ['sms:9876543210', 'whatsapp://send?phone=919876543210', 'geo:18.5,73.8']) {
      const linking = fakeLinking({ canOpen: false });
      await expect(openExternalUrl(url, linking)).resolves.toBe(true);
      expect(linking.canOpenURL).not.toHaveBeenCalled();
    }
  });

  test('a rejected openURL (no dialer) reports false instead of throwing', async () => {
    const linking = fakeLinking({ openRejects: true });
    await expect(openExternalUrl('tel:123', linking)).resolves.toBe(false);
  });

  test('https is still probed, and not opened when nothing can handle it', async () => {
    const linking = fakeLinking({ canOpen: false });
    await expect(openExternalUrl('https://res.cloudinary.com/x.jpg', linking)).resolves.toBe(false);
    expect(linking.canOpenURL).toHaveBeenCalledTimes(1);
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  test('https that can be handled is opened', async () => {
    const linking = fakeLinking({ canOpen: true });
    await expect(openExternalUrl('https://res.cloudinary.com/x.jpg', linking)).resolves.toBe(true);
    expect(linking.openURL).toHaveBeenCalledTimes(1);
  });
});
