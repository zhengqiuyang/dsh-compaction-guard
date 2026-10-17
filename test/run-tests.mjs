/**
 * Unit tests for the pure constraint extraction/survival logic — no DSH host.
 */
import assert from 'node:assert/strict';
import {
  collectText,
  extractConstraints,
  isConstraintLine,
  summarizeVerdicts,
  verifySurvival,
} from '../lib/constraints.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(err.message);
  }
}

console.log('extraction');

await test('directive lines recognized (en + zh), noise rejected', () => {
  assert.equal(isConstraintLine('Never commit directly to main branch.'), true);
  assert.equal(isConstraintLine('You must run the full test suite before every release.'), true);
  assert.equal(isConstraintLine('发布前必须跑完整测试。'), true);
  assert.equal(isConstraintLine('不要把密钥写进代码。'), true);
  assert.equal(isConstraintLine('Run the tests in watch mode.'), false);
  assert.equal(isConstraintLine('must'), false);
  assert.equal(isConstraintLine('see https://example.com/never-must-see'), false);
});

await test('extractConstraints keeps seq provenance', () => {
  const out = extractConstraints([
    { text: 'normal line', seq: 1 },
    { text: 'Always ask before deleting files.', seq: 2 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 2);
});

console.log('survival');

const C1 = { text: 'Never commit directly to main branch.', seq: 3 };
const C2 = { text: 'You must run the full test suite before every release.', seq: 5 };
const C3 = { text: '发布前必须跑完整测试。', seq: 7 };

await test('verbatim survival with whitespace differences', () => {
  const v = verifySurvival([C1], 'Earlier rules:\nnever commit  directly to MAIN branch.\nEnd of summary.');
  assert.equal(v[0].kept, true);
  assert.equal(v[0].how, 'verbatim');
});

await test('substance survival via word coverage', () => {
  // Vocabulary-preserving rewording (synonym swaps like run->perform are
  // deliberately out of scope: word coverage tracks words, not meaning).
  const summary = 'Reminder from earlier: the full test suite before every release is required.';
  const v = verifySurvival([C2], summary, 0.6);
  assert.equal(v[0].kept, true);
  assert.match(v[0].how, /^coverage:/);
});

await test('lost constraint reported with seq', () => {
  const v = verifySurvival([C3], 'The session discussed release workflow and branch naming.', 0.6);
  assert.equal(v[0].kept, false);
  const s = summarizeVerdicts(v);
  assert.ok(s.includes('LOST'));
  assert.ok(s.includes('seq 7'));
});

await test('CJK constraints survive CJK summaries', () => {
  const v = verifySurvival([C3], '用户强调:发布前必须跑完整测试,并复查变更。');
  assert.equal(v[0].kept, true);
});

await test('all-kept summary reads green', () => {
  const s = summarizeVerdicts(verifySurvival([C1], 'never commit directly to main branch'));
  assert.ok(s.includes('all 1 constraint(s) survived'));
});

console.log('collectText');

await test('defensive extraction from unknown payload shapes', () => {
  const payload = {
    message: {
      content: [
        { type: 'text', text: 'You must never push without review.' },
        { type: 'text', text: 'ok' },
      ],
      id: 'skip-ids-are-not-text',
    },
    seq: 42,
  };
  const texts = collectText(payload);
  assert.deepEqual(texts, ['You must never push without review.']);
  assert.equal(collectText('short').length, 0);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
