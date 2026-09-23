/**
 * Buying AI credits — the parts that, got wrong, charge a farmer twice.
 *
 * ── What is exercised, and why it is the hook and not the screen ─────────────
 * jest.config.js runs a node environment with a `react-native` stub that exports
 * Platform and nothing else, so AICreditsScreen.js — full of <View> — cannot be
 * rendered here at all. That is exactly why the purchase logic was kept out of
 * it: `useCreditPurchase` imports no react-native, so the decisions that matter
 * (what is SENT, what is SAID, how many gateway orders a double tap raises) are
 * all reachable from a plain react-test-renderer probe.
 *
 * The screen is then a thin shell over this hook: `handleBuy` opens the picker
 * when `packsState === READY`, `CreditPackSheet` renders `purchase.packs`, and
 * the balance card re-reads `data.balance` from whatever `onCredited` hands it.
 *
 * ── The pack fixture is deliberately NOT the real catalogue ──────────────────
 * The live packs are 100/500/1000/5000 credits at ₹49/₹199/₹349/₹1499. The
 * fixture below uses figures that appear nowhere in the codebase, so a pack list
 * or a price that ever came from a local constant instead of the server would
 * fail these assertions rather than quietly agreeing with them (§51).
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// React 18+ only treats `act()` as supported when this global is set, and warns
// on every update outside one otherwise. Set here rather than in a shared setup
// file because this is currently the only suite that renders anything — the rest
// of the pure-logic config deliberately has no React runtime.
global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../../services/paymentClient', () => ({
  fetchPaymentConfig: jest.fn(),
  fetchCreditPacks: jest.fn(),
  initiateCreditPurchase: jest.fn(),
  confirmCreditPurchase: jest.fn(),
  fetchCreditPurchaseStatus: jest.fn(),
}));

import {
  fetchPaymentConfig, fetchCreditPacks,
  initiateCreditPurchase, confirmCreditPurchase, fetchCreditPurchaseStatus,
} from '../../../services/paymentClient';
import useCreditPurchase, {
  PACKS, normalizeCreditPacks, readCreditResult, creditPurchaseNotice,
} from '../components/CreditPurchase';
import { PAYMENT_STATE } from '../../../components/payments/usePaymentFlow';

// Figures found nowhere else in the repo. See the header.
const SERVER_PACKS = [
  { id: 'pack_test_a', credits: 42, priceInr: 7, pricePaise: 700, label: 'Test Pack A' },
  { id: 'pack_test_b', credits: 900, priceInr: 111, pricePaise: 11100, label: 'Test Pack B' },
];

const ORDER = {
  razorpayOrderId: 'order_TEST123',
  amount: 111,
  amountInPaise: 11100,
  currency: 'INR',
  receipt: 'rcpt_1',
  pack: { id: 'pack_test_b', credits: 900, priceInr: 111, label: 'Test Pack B' },
  mock: false,
};

/** Drive the hook from a probe component that renders nothing. */
function mountHook(opts) {
  const probe = { current: null };
  function Probe() {
    probe.current = useCreditPurchase(opts);
    return null;
  }
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
  return { probe, unmount: () => act(() => renderer.unmount()) };
}

/** Let the mount-time Promise.all (and anything else pending) settle. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/** Mounted, packs loaded, gateway on. */
async function mountReady(opts) {
  const h = mountHook(opts);
  await flush();
  return h;
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchPaymentConfig.mockResolvedValue({ onlineEnabled: true, keyId: 'rzp_test_key', methods: ['upi'] });
  fetchCreditPacks.mockResolvedValue(SERVER_PACKS);
  initiateCreditPurchase.mockResolvedValue(ORDER);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the packs come from the server', () => {
  test('renders exactly what GET /ai/credits/packs returned — no local catalogue', async () => {
    const { probe, unmount } = await mountReady();

    expect(fetchCreditPacks).toHaveBeenCalledTimes(1);
    expect(probe.current.packsState).toBe(PACKS.READY);
    expect(probe.current.packs).toEqual([
      { id: 'pack_test_a', credits: 42, priceInr: 7, pricePaise: 700, label: 'Test Pack A' },
      { id: 'pack_test_b', credits: 900, priceInr: 111, pricePaise: 11100, label: 'Test Pack B' },
    ]);
    // The real catalogue's ids would only be here if something local supplied
    // them, which is the failure this fixture exists to catch.
    expect(probe.current.packs.map((p) => p.id)).not.toContain('pack_100');
    expect(probe.current.keyId).toBe('rzp_test_key');
    unmount();
  });

  test('only ONE catalogue load per mount — not one per focus (§42)', async () => {
    const { unmount } = await mountReady();
    await flush();
    expect(fetchCreditPacks).toHaveBeenCalledTimes(1);
    expect(fetchPaymentConfig).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('a failed packs call keeps the screen on "not available yet"', async () => {
    fetchCreditPacks.mockRejectedValue(new Error('offline'));
    const { probe, unmount } = await mountReady();

    expect(probe.current.packsState).toBe(PACKS.UNAVAILABLE);
    expect(probe.current.packs).toEqual([]);
    // openSheet is inert in that state, so no empty picker can appear.
    act(() => probe.current.openSheet());
    expect(probe.current.sheetOpen).toBe(false);
    unmount();
  });

  test('onlineEnabled false means unavailable, even with packs in hand', async () => {
    fetchPaymentConfig.mockResolvedValue({ onlineEnabled: false, keyId: null, methods: [] });
    const { probe, unmount } = await mountReady();

    expect(probe.current.packsState).toBe(PACKS.UNAVAILABLE);
    unmount();
  });

  test('normalizeCreditPacks drops a pack it cannot identify or price', () => {
    const out = normalizeCreditPacks([
      { id: 'ok', credits: 5, priceInr: 9 },
      { credits: 5, priceInr: 9 },            // no id — cannot be bought
      { id: 'no_price', credits: 5 },          // no price — must not be invented
      { id: 'no_credits', priceInr: 9 },
    ]);
    expect(out.map((p) => p.id)).toEqual(['ok']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the initiate body carries a pack id and nothing else', () => {
  test('sends { packId } — no amount, no price, no credits', async () => {
    const { probe, unmount } = await mountReady();

    await act(async () => { probe.current.buy('pack_test_b'); });

    expect(initiateCreditPurchase).toHaveBeenCalledTimes(1);
    const [body] = initiateCreditPurchase.mock.calls[0];
    expect(body).toEqual({ packId: 'pack_test_b' });
    expect(Object.keys(body)).toEqual(['packId']);

    // Nothing money-shaped reached the wire under any spelling.
    const wire = JSON.stringify(initiateCreditPurchase.mock.calls);
    for (const word of ['amount', 'price', 'paise', 'Inr', 'inr', 'credits', 'total']) {
      expect(wire).not.toContain(word);
    }
    unmount();
  });

  test('a missing pack id starts nothing', async () => {
    const { probe, unmount } = await mountReady();
    await act(async () => { probe.current.buy(undefined); });
    expect(initiateCreditPurchase).not.toHaveBeenCalled();
    unmount();
  });

  test('the checkout opens on the server order id alone', async () => {
    const { probe, unmount } = await mountReady();
    await act(async () => { probe.current.buy('pack_test_b'); });

    expect(probe.current.checkoutProps.visible).toBe(true);
    expect(probe.current.checkoutProps.orderId).toBe('order_TEST123');
    // Display only — the gateway charges what the ORDER says. It is the
    // server's figure either way, never one this app computed.
    expect(probe.current.checkoutProps.amountPaise).toBe(11100);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('double tap', () => {
  test('two taps in one frame raise ONE gateway order', async () => {
    const { probe, unmount } = await mountReady();

    // Both presses land before React can re-render, which is precisely why the
    // guard is a ref and not `busy` state: state would still read false on the
    // second tap and a second gateway order would be minted.
    await act(async () => {
      probe.current.buy('pack_test_b');
      probe.current.buy('pack_test_b');
    });

    expect(initiateCreditPurchase).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('a third tap while the checkout sheet is open is ignored too', async () => {
    const { probe, unmount } = await mountReady();
    await act(async () => { probe.current.buy('pack_test_b'); });
    expect(probe.current.busy).toBe(true);

    await act(async () => { probe.current.buy('pack_test_a'); });
    expect(initiateCreditPurchase).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a dismissed checkout asks the server instead of assuming failure', () => {
  test('closing the sheet triggers a status check, not a failure message', async () => {
    fetchCreditPurchaseStatus.mockResolvedValue({
      status: 'PAID', paid: true, amount: 111, credited: 900, balance: 942,
    });
    const credited = jest.fn();
    const { probe, unmount } = await mountReady({ onCredited: credited });

    await act(async () => { probe.current.buy('pack_test_b'); });
    // The farmer backgrounded the app mid-UPI and came back to a closed sheet.
    await act(async () => { await probe.current.checkoutProps.onDismiss(); });

    expect(fetchCreditPurchaseStatus).toHaveBeenCalledTimes(1);
    expect(fetchCreditPurchaseStatus.mock.calls[0][0]).toBe('order_TEST123');
    // They HAD paid. Telling them it failed is how they pay twice.
    expect(probe.current.notice.tone).toBe('success');
    expect(probe.current.notice.mayRetry).toBe(false);
    expect(credited).toHaveBeenCalledWith(expect.objectContaining({ balance: 942 }));
    unmount();
  });

  test('the dismissal path never posts a confirm of its own', async () => {
    fetchCreditPurchaseStatus.mockResolvedValue({ status: 'PAID', paid: true, credited: 900, balance: 942 });
    const { probe, unmount } = await mountReady();

    await act(async () => { probe.current.buy('pack_test_b'); });
    await act(async () => { await probe.current.checkoutProps.onDismiss(); });

    expect(confirmCreditPurchase).not.toHaveBeenCalled();
    unmount();
  });

  test('an unresolvable dismissal is "we could not confirm" — never "try again"', async () => {
    // PENDING every time: the poll budget is spent and the server still cannot
    // say. The one honest answer, and the only one that does not risk a second
    // charge. Delays are jittered from [0,1500,3000,6000]; fake timers keep the
    // suite instant.
    jest.useFakeTimers();
    fetchCreditPurchaseStatus.mockResolvedValue({ status: 'attempted', paid: false });
    const { probe, unmount } = await mountReady();

    await act(async () => { probe.current.buy('pack_test_b'); });

    let done = false;
    await act(async () => {
      probe.current.checkoutProps.onDismiss().then(() => { done = true; });
      // Run the four backoff waits through.
      for (let i = 0; i < 6; i += 1) {
        jest.runOnlyPendingTimers();
        await Promise.resolve();
        await Promise.resolve();
      }
    });

    expect(done).toBe(true);
    expect(fetchCreditPurchaseStatus).toHaveBeenCalledTimes(4);
    expect(probe.current.notice.tone).toBe('warning');
    expect(probe.current.notice.moneyMayHaveMoved).toBe(true);
    expect(probe.current.notice.mayRetry).toBe(false);
    jest.useRealTimers();
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('alreadyProcessed is a success, not a warning', () => {
  test('the webhook getting there first shows the same success state', async () => {
    confirmCreditPurchase.mockResolvedValue({ credited: 900, balance: 942, alreadyProcessed: true });
    const credited = jest.fn();
    const { probe, unmount } = await mountReady({ onCredited: credited });

    await act(async () => { probe.current.buy('pack_test_b'); });
    await act(async () => {
      await probe.current.checkoutProps.onSuccess({
        razorpayOrderId: 'order_TEST123',
        razorpayPaymentId: 'pay_TEST',
        razorpaySignature: 'sig_TEST',
      });
    });

    expect(probe.current.notice.tone).toBe('success');
    expect(probe.current.notice.mayRetry).toBe(false);
    expect(probe.current.notice.moneyMayHaveMoved).toBe(false);
    expect(probe.current.notice.vars).toEqual({ credits: 900, balance: 942 });
    // And the balance shown is the SERVER's, not one computed here.
    expect(credited).toHaveBeenCalledWith(expect.objectContaining({ balance: 942, alreadyProcessed: true }));
    expect(probe.current.sheetOpen).toBe(false);
    unmount();
  });

  test('a first-time credit reads identically to an already-processed one', async () => {
    const first = creditPurchaseNotice({
      state: PAYMENT_STATE.DONE, result: { credited: 900, balance: 942, alreadyProcessed: false },
    });
    const again = creditPurchaseNotice({
      state: PAYMENT_STATE.DONE, result: { credited: 900, balance: 942, alreadyProcessed: true },
    });
    expect(again).toEqual(first);
    expect(again.tone).toBe('success');
  });

  test('readCreditResult keeps alreadyProcessed strictly boolean', () => {
    expect(readCreditResult({ credited: 1, balance: 2, alreadyProcessed: true }).alreadyProcessed).toBe(true);
    expect(readCreditResult({ credited: 1, balance: 2 }).alreadyProcessed).toBe(false);
    expect(readCreditResult(null)).toEqual({ credited: null, balance: null, alreadyProcessed: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the balance shown is the one the server reported', () => {
  test('onCredited carries the server balance, and nothing is derived from it', async () => {
    confirmCreditPurchase.mockResolvedValue({ credited: 900, balance: 1234, alreadyProcessed: false });
    const credited = jest.fn();
    const { probe, unmount } = await mountReady({ onCredited: credited });

    await act(async () => { probe.current.buy('pack_test_b'); });
    await act(async () => {
      await probe.current.checkoutProps.onSuccess({
        razorpayOrderId: 'order_TEST123', razorpayPaymentId: 'p', razorpaySignature: 's',
      });
    });

    // 1234, not 900 + whatever the screen happened to be showing.
    expect(credited).toHaveBeenCalledWith({ credited: 900, balance: 1234, alreadyProcessed: false });
    expect(probe.current.notice.vars.balance).toBe(1234);
    unmount();
  });

  test('a confirm with no balance reports success without inventing a figure', async () => {
    confirmCreditPurchase.mockResolvedValue({ alreadyProcessed: true });
    const credited = jest.fn();
    const { probe, unmount } = await mountReady({ onCredited: credited });

    await act(async () => { probe.current.buy('pack_test_b'); });
    await act(async () => {
      await probe.current.checkoutProps.onSuccess({
        razorpayOrderId: 'order_TEST123', razorpayPaymentId: 'p', razorpaySignature: 's',
      });
    });

    expect(probe.current.notice.tone).toBe('success');
    expect(probe.current.notice.vars).toBeNull();
    expect(credited).not.toHaveBeenCalled();   // no made-up balance on the card
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a payment that genuinely failed', () => {
  test('a gateway failure is the one place "try again" is offered', async () => {
    const { probe, unmount } = await mountReady();
    await act(async () => { probe.current.buy('pack_test_b'); });
    await act(async () => { probe.current.checkoutProps.onFailure({ code: 'BAD_CARD', reason: 'Declined' }); });

    expect(probe.current.notice.tone).toBe('error');
    expect(probe.current.notice.mayRetry).toBe(true);
    expect(probe.current.notice.moneyMayHaveMoved).toBe(false);
    unmount();
  });

  test('a checkout script that would not load is a connection problem, not a failed payment', async () => {
    const { probe, unmount } = await mountReady();
    await act(async () => { probe.current.buy('pack_test_b'); });
    await act(async () => { probe.current.checkoutProps.onFailure({ code: 'SCRIPT_LOAD' }); });

    expect(probe.current.notice.titleKey).toBe('aiCredits.purchaseNoNetwork');
    expect(probe.current.notice.moneyMayHaveMoved).toBe(false);
    unmount();
  });

  test('after a failure the guard has released, so a retry can start', async () => {
    const { probe, unmount } = await mountReady();
    await act(async () => { probe.current.buy('pack_test_b'); });
    await act(async () => { probe.current.checkoutProps.onFailure({ code: 'BAD_CARD' }); });
    await act(async () => { probe.current.dismissNotice(); });

    await act(async () => { probe.current.buy('pack_test_b'); });
    expect(initiateCreditPurchase).toHaveBeenCalledTimes(2);
    unmount();
  });
});
