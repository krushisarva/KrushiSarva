/**
 * OrderTimeline — "where is my order?", drawn as the road it has travelled.
 *
 *   ✓ Order placed              12 Oct, 2:32 pm
 *   ✓ Confirmed by the shop     12 Oct, 4:10 pm
 *   ● Out for delivery          13 Oct, 9:05 am
 *   ○ Delivered                 Arriving by 15 Oct
 *
 * Shown inside an order's opened detail on My Orders. Every decision — which
 * steps exist, which is the current one, what a cancelled order shows, when a
 * refund is mentioned — is made in screens/AgriStore/orderTracking.js, where it
 * is unit-tested. This file only draws the answer.
 *
 * HOW A STEP IS TOLD APART — never by colour alone:
 *   done      a filled circle with a tick
 *   current   a larger ringed circle, and the title in bold
 *   upcoming  an empty circle, the title in grey, and "not yet" for a screen reader
 *   failed    a red circle with a cross, and its title says what went wrong
 *
 * An order from several shops gets one timeline per shop, each under the
 * shop's name: the deliveries move separately, and a farmer has to be able to
 * tell which one is at the door.
 *
 * Built only when the detail is opened (the parent mounts it then), so a list
 * of closed cards works none of this out.
 */
import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '@krushisarva/shared/constants/colors';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { orderTracking } from '../screens/AgriStore/orderTracking';

/** The mark on the rail for each kind of step. */
function Dot({ step }) {
  if (step.state === 'failed') {
    return <View style={[s.dot, s.dotFailed]}><Ionicons name="close" size={13} color={COLORS.white} /></View>;
  }
  if (step.state === 'done') {
    return <View style={[s.dot, s.dotDone]}><Ionicons name="checkmark" size={13} color={COLORS.white} /></View>;
  }
  if (step.state === 'current') {
    // A refund that is still on its way is waiting, not travelling.
    const waiting = step.tone === 'wait';
    return (
      <View style={[s.dot, s.dotCurrent, waiting && s.dotWaiting]}>
        {waiting
          ? <Ionicons name="time-outline" size={13} color={COLORS.white} />
          : <View style={s.dotCore} />}
      </View>
    );
  }
  return <View style={[s.dot, s.dotUpcoming]} />;
}

const Step = memo(function Step({ step, next, say, notYet }) {
  const title = say(step.title);
  const note = say(step.note);
  const upcoming = step.state === 'upcoming';
  // The stretch of road below this step has been travelled only if the order
  // got through this step and reached the next one. Around a step that ended
  // the delivery (cancelled, could not be delivered) the line stays plain: green
  // there would read as progress.
  const travelled = step.state === 'done' && next && (next.state === 'done' || next.state === 'current');

  return (
    <View
      style={s.step}
      accessible
      accessibilityRole="text"
      accessibilityLabel={[
        [title, step.time, upcoming ? notYet : null].filter(Boolean).join(', '),
        note,
      ].filter(Boolean).join('. ')}
    >
      <View style={s.rail}>
        <Dot step={step} />
        {next ? <View style={[s.line, travelled && s.lineTravelled]} /> : null}
      </View>
      <View style={[s.body, next && s.bodySpaced]}>
        <Text
          style={[
            s.stepTitle,
            step.state === 'current' && s.stepTitleCurrent,
            upcoming && s.stepTitleUpcoming,
            step.state === 'failed' && s.stepTitleFailed,
          ]}
        >
          {title}
        </Text>
        {step.time ? <Text style={s.time}>{step.time}</Text> : null}
        {note ? <Text style={[s.note, step.tone === 'late' && s.noteLate]}>{note}</Text> : null}
      </View>
    </View>
  );
});

function OrderTimeline({ order }) {
  const { t } = useLanguage();
  const tracking = useMemo(() => orderTracking(order), [order]);

  // A title or note from orderTracking.js → words. `key: null` is a status this
  // build has no translation for; its readable fallback is shown as it is.
  // Stable between renders, so a memoised Step is skipped when nothing changed.
  const say = useCallback((part) => {
    if (!part) return null;
    if (!part.key) return part.fallback || null;
    return t(part.key, { ...(part.vars || {}), defaultValue: part.fallback });
  }, [t]);

  if (!tracking.shipments.length) return null;
  const notYet = t('orders.trackNotYet', 'Not yet');

  return (
    <View style={s.root}>
      <Text style={s.title} accessibilityRole="header">{t('orders.trackTitle', 'Order tracking')}</Text>

      {tracking.shipments.map((ship) => (
        <View key={ship.key} style={tracking.single ? null : s.shipment}>
          {tracking.single ? null : (
            <View style={s.shopRow}>
              <Ionicons name="storefront-outline" size={15} color={COLORS.textMedium} />
              <Text style={s.shop} numberOfLines={2}>
                {ship.name || t('orders.shopNumbered', { n: ship.ordinal, defaultValue: 'Shop {{n}}' })}
              </Text>
            </View>
          )}

          {ship.steps.map((step, i) => (
            <Step
              // The id is unique within one delivery's timeline.
              key={step.id}
              step={step}
              next={ship.steps[i + 1] || null}
              say={say}
              notYet={notYet}
            />
          ))}

          {ship.partCancelled ? (
            <Text style={s.part}>{t('orders.trackSomeCancelled', 'Part of this delivery was cancelled.')}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export default memo(OrderTimeline);

const DOT = 22;

const s = StyleSheet.create({
  root: { gap: 10 },
  title: { fontSize: 13, fontWeight: '700', color: COLORS.textDark },

  // Only when there is more than one shop: the box is what keeps one shop's
  // steps from being read as the next one's.
  shipment: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 12,
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12,
  },
  shopRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  shop: { flex: 1, fontSize: 13, fontWeight: '700', color: COLORS.textDark },

  step: { flexDirection: 'row', gap: 12 },
  // The rail is as tall as the step's text, so the line always reaches the
  // next dot however many lines the words above it run to.
  rail: { width: DOT, alignItems: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, justifyContent: 'center', alignItems: 'center' },
  dotDone: { backgroundColor: COLORS.primary },
  dotCurrent: { backgroundColor: COLORS.primary, borderWidth: 4, borderColor: COLORS.primaryPale },
  dotCore: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.white },
  dotWaiting: { backgroundColor: COLORS.orange700, borderWidth: 0 },
  dotFailed: { backgroundColor: COLORS.errorDark },
  dotUpcoming: { backgroundColor: COLORS.surface, borderWidth: 2, borderColor: COLORS.borderMedium },
  line: { flex: 1, width: 2, minHeight: 10, marginVertical: 2, borderRadius: 1, backgroundColor: COLORS.borderMedium },
  lineTravelled: { backgroundColor: COLORS.primary },

  body: { flex: 1, minWidth: 0, paddingTop: 1 },
  bodySpaced: { paddingBottom: 14 },
  stepTitle: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: COLORS.textDark },
  stepTitleCurrent: { fontWeight: '800' },
  stepTitleUpcoming: { fontWeight: '500', color: COLORS.textMedium },
  // errorDark: red500 on white is 3.8:1, and this is the line that says the
  // order is not coming.
  stepTitleFailed: { fontWeight: '700', color: COLORS.errorDark },
  time: { fontSize: 12, lineHeight: 17, color: COLORS.textMedium },
  note: { fontSize: 12, lineHeight: 17, color: COLORS.textBody, marginTop: 1 },
  // orange700 on white is 5.6:1 — "running late" must be readable, not pale.
  noteLate: { fontWeight: '700', color: COLORS.orange700 },

  part: { fontSize: 12, lineHeight: 17, color: COLORS.textBody, marginTop: 8 },
});
