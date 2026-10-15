/**
 * Where "Report" and "Block" live in the farmer app, and that each one asks the
 * server for the right thing (Google Play: AI output and user content must be
 * reportable in-app; a 1:1 chat must offer blocking).
 *
 * The screens cannot be rendered under this Jest config (see
 * sourceParses.test.js), so — like govNotice.test.js — the source is read. The
 * sheet itself is rendered and tapped in ReportSheet.test.js.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
// Read, not imported: importing the sheet pulls in react-native, which this
// config cannot parse.
// The sheet itself lives in shared/ (the seller app uses it too); this file's
// components/ReportSheet.js is only the farmer wrapper.
const SHEET_REASON_KEYS = [...fs.readFileSync(path.join(SRC, '..', '..', 'shared', 'components', 'ReportSheet.js'), 'utf8').matchAll(/\{ key: '([a-z_]+)',\s+tKey:/g)].map((m) => m[1]);
const BACKEND_REPORTS = path.join(SRC, '..', '..', 'backend', 'src', 'services', 'userReport.service.js');

/** Every screen that opens the sheet, and the target types it may send. */
const SCREENS = {
  'screens/AI/AIChatScreen.js':            ['AI_MESSAGE'],
  'screens/AI/VoiceChatScreen.js':         ['AI_VOICE_MESSAGE'],
  'screens/AI/DiagnosisResultScreen.js':   ['AI_DIAGNOSIS'],
  'screens/AI/PastReportScreen.js':        ['AI_DIAGNOSIS'],
  'screens/AnimalTrade/ChatScreen.js':     ['USER'],
  'screens/Rent/MachineryDetail.js':       ['MACHINERY_LISTING'],
  'screens/Rent/LabourDetail.js':          ['LABOUR_LISTING'],
  'screens/AgriStore/ProductReviews.js':   ['PRODUCT_REVIEW'],
};

const targetTypesIn = (src) => [...src.matchAll(/targetType:\s*'([A-Z_]+)'/g)].map((m) => m[1]);

describe.each(Object.entries(SCREENS))('%s', (file, expected) => {
  const src = read(file);

  test('mounts the one ReportSheet, closed until something is picked', () => {
    expect(src).toMatch(/import ReportSheet from '\.\.\/\.\.\/components\/ReportSheet';/);
    expect(src).toMatch(/<ReportSheet target=\{reportTarget\} onClose=\{\(\) => setReportTarget\(null\)\} \/>/);
    expect(src).toMatch(/useState\(null\)/);
  });

  test(`reports as ${expected.join(', ')}`, () => {
    expect([...new Set(targetTypesIn(src))].sort()).toEqual([...expected].sort());
  });
});

describe('AI results carry what the farmer was shown', () => {
  test('a saved scan result is reported by its id, with a summary line as the snapshot', () => {
    const src = read('screens/AI/PastReportScreen.js');
    const open = src.slice(src.indexOf('const openReport'), src.indexOf('return (', src.indexOf('const openReport')));
    expect(open).toMatch(/targetType: 'AI_DIAGNOSIS',/);
    expect(open).toMatch(/targetId: row\.id \|\| reportId \|\| undefined,/);
    // The disease line is always there, so the snapshot is never empty.
    expect(open).toMatch(/snapshot: \[\s*`\$\{row\.cropType \|\| 'Crop'\}: \$\{fields\.diseaseName\}/);
    expect(src).toMatch(/onPress=\{openReport\}/);
  });

  test('voice: Report waits until the reply has finished arriving', () => {
    const src = read('screens/AI/VoiceChatScreen.js');
    expect(src).toMatch(/\{aiReply && userTranscript && replyDone && !isProcessing && !isRecording \? \(/);
    // Cleared when a new turn starts…
    const start = src.slice(src.indexOf('const startRecording'), src.indexOf('const startRecording') + 1500);
    expect(start).toMatch(/setReplyDone\(false\)/);
    // …and set only where the reply stops arriving: done, stream error, stall,
    // a failed request, the one-shot HTTP reply, or a hard stop.
    const onDone = src.slice(src.indexOf('const onDone'), src.indexOf('const onStreamErr'));
    expect(onDone).toMatch(/setReplyDone\(true\)/);
    const onDelta = src.slice(src.indexOf('const onDelta'), src.indexOf('const onChunk'));
    expect(onDelta).not.toMatch(/setReplyDone/);
    expect((src.match(/setReplyDone\(true\)/g) || []).length).toBe(6);
  });
});

describe('the contract with the server', () => {
  const backend = fs.existsSync(BACKEND_REPORTS) ? fs.readFileSync(BACKEND_REPORTS, 'utf8') : null;
  const list = (name) => {
    const m = backend.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]) : [];
  };

  test('every target type a screen sends is one the server accepts', () => {
    if (!backend) return; // the farmer app shipped on its own
    const accepted = list('REPORT_TARGET_TYPES');
    expect(accepted.length).toBeGreaterThan(0);
    for (const types of Object.values(SCREENS)) {
      for (const type of types) expect(accepted).toContain(type);
    }
  });

  test('the sheet offers exactly the reasons the server accepts', () => {
    if (!backend) return;
    expect(SHEET_REASON_KEYS.length).toBe(6);
    expect([...SHEET_REASON_KEYS].sort()).toEqual(list('REPORT_REASONS').sort());
  });
});

describe('nobody is offered a report on their own content', () => {
  test('rental listings: the link is hidden on your own listing', () => {
    for (const file of ['screens/Rent/MachineryDetail.js', 'screens/Rent/LabourDetail.js']) {
      expect(read(file)).toMatch(/\{!isOwner && user && [^?]+\? \(\s*<TouchableOpacity\s+style=\{D\.reportLink\}/);
    }
  });

  test('product reviews: no Report on a review you wrote', () => {
    const src = read('screens/AgriStore/ProductReviews.js');
    expect(src).toMatch(/const canReport = !!user\?\.id && !!r\.id && r\.user\?\.id !== user\.id;/);
    expect(src).toMatch(/\{canReport \? \(/);
    expect(src).toMatch(/targetType: 'PRODUCT_REVIEW', targetId: r\.id/);
  });
});

describe('animal chat: report and block the other person', () => {
  const src = read('screens/AnimalTrade/ChatScreen.js');

  test('the menu only appears once we know who the other person is, and never for ourselves', () => {
    expect(src).toMatch(/return id && id !== user\?\.id \? String\(id\) : null;/);
    expect(src).toMatch(/\{otherUserId \? \(\s*<TouchableOpacity\s+onPress=\{openSafetyMenu\}/);
  });

  test('both callers pass the other person\'s id', () => {
    expect(read('screens/AnimalTrade/AnimalDetail.js')).toMatch(/peerId: listing\.sellerId/);
    expect(read('screens/AnimalTrade/MyAnimalChatsScreen.js')).toMatch(/peerId: row\.counterpart\?\.id/);
  });

  test('"Report user" reports the person by id', () => {
    expect(src).toMatch(/targetType: 'USER',\s*targetId: otherUserId,/);
  });

  test('"Block user" asks first, then uses the existing block endpoint', () => {
    const confirm = src.slice(src.indexOf('const confirmBlock'), src.indexOf('const openSafetyMenu'));
    expect(confirm).toMatch(/style: 'cancel'/);
    expect(confirm).toMatch(/style: 'destructive', onPress: blockUser/);
    expect(src).toMatch(/api\.post\(`\/animals\/sellers\/\$\{otherUserId\}\/block`, \{\}\)/);
  });

  test('after blocking it says what changed, then leaves the chat', () => {
    const block = src.slice(src.indexOf('const blockUser'), src.indexOf('const confirmBlock'));
    expect(block).toMatch(/report\.blockedBody/);
    expect(block).toMatch(/no longer message each other/);
    expect(block).toMatch(/navigation\?\.goBack\?\.\(\)/);
    // A double tap on "Block" is one request.
    expect(block).toMatch(/if \(!otherUserId \|\| blockingRef\.current\) return;/);
  });
});

describe('copy', () => {
  // Translations are added separately; until then every string must still read
  // as English rather than as a raw key.
  const files = ['components/ReportSheet.js', ...Object.keys(SCREENS)];

  test('every report.* string carries an English fallback', () => {
    const bare = [];
    let found = 0;
    for (const file of files) {
      for (const m of read(file).matchAll(/\bt\(\s*'(report\.[A-Za-z0-9_]+)'\s*(,\s*['"`])?/g)) {
        found += 1;
        if (!m[2]) bare.push(`${file}: ${m[1]}`);
      }
    }
    // tKey/fallback tables in ReportSheet are checked by the sheet's own test.
    expect(found).toBeGreaterThan(10);
    expect(bare).toEqual([]);
  });
});
