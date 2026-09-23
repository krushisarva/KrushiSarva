/**
 * Every source file must survive the bundler's parser.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * This project's Jest config runs in a node environment with a stub for
 * `react-native`, so screens cannot be rendered in a test. That is a reasonable
 * trade — the logic lives in pure modules that ARE tested — but it has one
 * sharp edge: a screen no test imports is never parsed by Jest either. A syntax
 * error in it passes the whole suite and fails at `expo start`, with a Babel
 * stack trace and no file name near the top.
 *
 * That happened: a comment containing a backtick was added INSIDE the template
 * literal that builds the Razorpay checkout page. The backtick closed the
 * template early, the file stopped parsing, and 571 tests stayed green while
 * the app would not bundle at all.
 *
 * Parsing is not type-checking and it is not a render. It only answers "would
 * Metro choke on this", which is exactly the question the rest of the suite
 * cannot answer.
 */
import fs from 'fs';
import path from 'path';
import * as babel from '@babel/core';

// __dirname, not import.meta.url: babel-jest transforms these files to CJS, so
// import.meta is a syntax error here even though the app's own source is ESM.
const SRC = path.resolve(__dirname, '..');
const PRESET = require.resolve('babel-preset-expo');

/** Every .js/.jsx under src/, bundler-visible ones included. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.jsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC);

describe('every source file parses', () => {
  test('the sweep actually found the app', () => {
    // Guards against the walk silently returning nothing — a passing test over
    // zero files is worse than no test, because it reads as coverage.
    expect(FILES.length).toBeGreaterThan(100);
  });

  test.each(FILES.map((f) => [path.relative(SRC, f), f]))('%s', (_rel, file) => {
    const code = fs.readFileSync(file, 'utf8');
    expect(() => babel.parseSync(code, { filename: file, presets: [PRESET] })).not.toThrow();
  });
});
