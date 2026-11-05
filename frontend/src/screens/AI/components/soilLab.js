/**
 * soilLab — open ICAR's official list of Krishi Vigyan Kendras, which test
 * soil for farmers. There is no public lab-finder API, so we deep-link.
 *
 * The old target, services.india.gov.in's "Locate Soil Testing Laboratory",
 * no longer exists (the domain stopped resolving), and soilhealth.dac.gov.in
 * is blocked outside India, where Play reviewers test. This link must stay in
 * the store description's source list (docs/play-store/farmer-app.md); a
 * test in __tests__/govNotice.test.js enforces that.
 */
import { Linking } from 'react-native';
import { showPopup } from '../../../utils/popup';

const SOIL_LAB_LOCATOR_URL = 'https://icar.org.in/en/krishi-vigyan-kendras';

/**
 * Open the locator in the device browser.
 * @param {function} t i18n function (key, fallback)
 */
export async function openSoilLabFinder(t = (k, f) => f) {
  try {
    const ok = await Linking.canOpenURL(SOIL_LAB_LOCATOR_URL);
    if (!ok) throw new Error('cannot open');
    await Linking.openURL(SOIL_LAB_LOCATOR_URL);
  } catch {
    showPopup(
      t('soilHub.lab.cannotOpenTitle', 'Could not open the lab finder'),
      t(
        'soilHub.lab.cannotOpenBody',
        'Please visit your nearest Block Agriculture Office or Krishi Vigyan Kendra (KVK) to get your soil tested.',
      ),
    );
  }
}
