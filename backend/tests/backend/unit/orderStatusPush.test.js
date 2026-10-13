/**
 * Order-status pushes (claude.md §45).
 *
 * §45 lists order status among the things push exists for. It had no caller:
 * before today the only sendPushToUser sites were animaltrade chat, crop-report
 * shares, admin broadcast and the security paths.
 *
 * These assert the copy table's rules, which are the part with judgement in
 * them. The wiring itself is covered by catalogSplit.api.test.js, which drives a
 * real multi-seller order through CONFIRMED → SHIPPED → DELIVERED.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';

const SRC = readFileSync(new URL('../../../src/routes/agristore.routes.js', import.meta.url), 'utf8');
const SCHEMA = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

// The buyer's order-status push, located by its notification type.
const PUSH_TYPE = "type: 'ORDER_UPDATE'";

/** The values of `enum NotificationType` in schema.prisma. */
function notificationTypes() {
  const start = SCHEMA.indexOf('enum NotificationType {');
  const block = SCHEMA.slice(start, SCHEMA.indexOf('}', start));
  return block.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
}

describe('order push notification types', () => {
  it('uses a type the notifications table accepts', () => {
    // `Notification.type` is a Postgres enum. The push used to say
    // 'ORDER_STATUS', which is not a member: the device push still went out, but
    // the in-app row was refused on every send, so the farmer's inbox never
    // showed an order update. Nothing failed loudly — the insert is best-effort.
    const types = notificationTypes();
    expect(types).toContain('ORDER_UPDATE');
    expect(SRC).toContain(PUSH_TYPE);
    expect(SRC).not.toContain("type: 'ORDER_STATUS'");
  });

  it('every literal push type in the shop routes is a member of the enum', () => {
    const types = notificationTypes();
    const used = [...SRC.matchAll(/sendPushToUser\(\{[^}]*?type: '([A-Za-z_]+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((t) => !types.includes(t))).toEqual([]);
  });

  it('the seller\'s new-order push uses a member of the enum too', () => {
    const service = readFileSync(new URL('../../../src/services/orderDelivery.service.js', import.meta.url), 'utf8');
    expect(service).toContain("type: 'NEW_ORDER'");
    expect(notificationTypes()).toContain('NEW_ORDER');
  });
});

describe('ORDER_STATUS_PUSH copy', () => {
  it('covers the four statuses a buyer cannot see without opening the app', () => {
    for (const s of ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) {
      expect(SRC).toMatch(new RegExp(`${s}:\\s*\\{\\s*title:`));
    }
  });

  it('deliberately omits PENDING', () => {
    // PENDING is the state an order is CREATED in. Pushing it would notify a
    // farmer about something they just did on the screen in front of them.
    expect(SRC).not.toMatch(/PENDING:\s*\{\s*title:/);
  });

  it('carries no uuid in the body', () => {
    // Orders have no human-readable number; the only id is a uuid, and a uuid
    // fragment on a lock screen is noise. Identity rides in data.orderId, which
    // is what gets the farmer to the right screen.
    const block = SRC.slice(SRC.indexOf('const ORDER_STATUS_PUSH'), SRC.indexOf('/** Sorts that depend on OFFER'));
    expect(block).not.toMatch(/orderNumber|orderId|\$\{/);
  });

  it('sends only on a real rollup transition', () => {
    // One seller confirming their half of a two-seller order does not change the
    // ORDER's status. Pushing on every item update would send "your order is
    // confirmed" twice, which trains people to ignore the one that matters.
    expect(SRC).toMatch(/result\.orderStatus !== result\.previousStatus/);
  });

  it('pushes outside the Serializable transaction', () => {
    // A push is not worth holding a Serializable transaction open for, and a
    // queue hiccup must not roll back a status change the seller was already
    // told succeeded.
    const txEnd = SRC.indexOf("{ isolationLevel: 'Serializable' }");
    const push  = SRC.indexOf(PUSH_TYPE);
    expect(push).toBeGreaterThan(txEnd);
  });

  it('never lets a push failure fail the request', () => {
    const idx = SRC.indexOf(PUSH_TYPE);
    expect(idx).toBeGreaterThan(-1);
    expect(SRC.slice(idx, idx + 400)).toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  it('deep-links to the order', () => {
    const idx = SRC.indexOf(PUSH_TYPE);
    expect(idx).toBeGreaterThan(-1);
    const block = SRC.slice(idx, idx + 400);
    expect(block).toMatch(/orderId/);
    expect(block).toMatch(/screen: 'OrderDetail'/);
  });
});
