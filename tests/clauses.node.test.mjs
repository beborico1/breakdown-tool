/**
 * segmentClauses / alignClauseTranslations contract tests.
 *
 * A clause is the unit a hover dot translates, so these pin the two properties
 * the renderers depend on: clauses tile the text without gaps or overlap, and a
 * clause never spans a '\n' (the block assembler uses one as a synthetic seam
 * for a nested block or a <br>, and text either side belongs to different
 * visual blocks).
 *
 * Run: node tests/clauses.node.test.mjs
 */

import {
  segmentClauses,
  alignClauseTranslations,
  MIN_SYNTHETIC_CLAUSE_CHARS,
} from '../src/content/utils/text.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

const texts = c => c.map(x => x.text);

console.log('\nsegmentClauses: terminated clauses');
{
  const c = segmentClauses('最初の文です。次の文です。');
  check('two clauses', c.length === 2, JSON.stringify(texts(c)));
  check('each keeps its own mark',
    c[0].text === '最初の文です。' && c[1].text === '次の文です。', JSON.stringify(texts(c)));
  check('both terminated', c.every(x => x.terminated));
  check('disjoint and contiguous', c[0].end === c[1].start, `${c[0].end} vs ${c[1].start}`);
  check('mark ranges point at the marks',
    c[0].markStart === 6 && c[0].markEnd === 7, `${c[0].markStart}-${c[0].markEnd}`);
}

console.log('\nsegmentClauses: a run of marks closes one clause');
{
  const c = segmentClauses('本当に？！すごい');
  check('two clauses', c.length === 2, JSON.stringify(texts(c)));
  check('the run stays in one clause', c[0].text === '本当に？！', c[0].text);
  check('mark run spans both marks',
    c[0].markStart === 3 && c[0].markEnd === 5, `${c[0].markStart}-${c[0].markEnd}`);
  check('tail is unterminated', c[1].terminated === false && c[1].text === 'すごい', c[1].text);
}

console.log('\nsegmentClauses: unterminated text');
{
  const c = segmentClauses('まだ終わっていない');
  check('one clause', c.length === 1, JSON.stringify(texts(c)));
  check('terminated is false', c[0].terminated === false);
  check('no mark range', c[0].markStart === -1 && c[0].markEnd === -1);
  check('contentEnd is the end of the text', c[0].contentEnd === 9, String(c[0].contentEnd));
}

console.log('\nsegmentClauses: a clause never spans a newline');
{
  const c = segmentClauses('直接のテキスト\nあとのテキスト');
  check('two clauses', c.length === 2, JSON.stringify(texts(c)));
  check('neither contains the newline', c.every(x => !x.text.includes('\n')), JSON.stringify(texts(c)));
  check('newline excluded from the first', c[0].text === '直接のテキスト', c[0].text);
  check('second starts after the newline', c[1].text === 'あとのテキスト', c[1].text);
  check('both unterminated', c.every(x => x.terminated === false));
}
{
  const c = segmentClauses('終わった。\n次の段落です。');
  check('a mark then a newline does not emit an empty clause', c.length === 2,
    JSON.stringify(texts(c)));
}

console.log('\nsegmentClauses: mark policy');
{
  const ja = segmentClauses('ver 1.5 は良い。');
  check('ja ignores the ASCII dot in a decimal', ja.length === 1, JSON.stringify(texts(ja)));
  const ascii = segmentClauses('ver 1.5 は良い。', { marks: 'ja-ascii' });
  check('ja-ascii splits on it', ascii.length === 2, JSON.stringify(texts(ascii)));
  check('ja-ascii first part ends at the dot', ascii[0].text === 'ver 1.', ascii[0].text);
}
{
  const c = segmentClauses('https://example.com/a.html');
  check('a bare URL is one unterminated clause under ja', c.length === 1, JSON.stringify(texts(c)));
}

console.log('\nsegmentClauses: hasJapanese flag drives the skip rule');
{
  const c = segmentClauses('これは日本語です。Hello world');
  check('two clauses', c.length === 2, JSON.stringify(texts(c)));
  check('japanese clause flagged Japanese', c[0].hasJapanese === true, c[0].text);
  check('trailing latin clause flagged not Japanese', c[1].hasJapanese === false, c[1].text);
}
{
  // Under 'ja' an ASCII stop is not a mark, so English that runs straight into
  // Japanese is one mixed clause and gets translated whole. That is the agreed
  // granularity: only a clause with no Japanese at all is skipped.
  const c = segmentClauses('Hello world. これは日本語です。');
  check('english running into japanese stays one mixed clause under ja',
    c.length === 1 && c[0].hasJapanese === true, JSON.stringify(texts(c)));
  const ascii = segmentClauses('Hello world. これは日本語です。', { marks: 'ja-ascii' });
  check('ja-ascii separates them', ascii.length === 2, JSON.stringify(texts(ascii)));
  check('ja-ascii latin clause flagged not Japanese',
    ascii[0].hasJapanese === false, ascii[0].text);
}
{
  const c = segmentClauses('。。。');
  check('a mark-only run is not Japanese', c.every(x => x.hasJapanese === false),
    JSON.stringify(texts(c)));
}

console.log('\nsegmentClauses: whitespace and empties');
{
  const c = segmentClauses('   会議です。   ');
  check('one clause', c.length === 1, JSON.stringify(texts(c)));
  check('surrounding whitespace excluded from text', c[0].text === '会議です。', `"${c[0].text}"`);
  check('contentStart skips the leading spaces', c[0].contentStart === 3, String(c[0].contentStart));
  check('raw start is still 0', c[0].start === 0, String(c[0].start));
}
check('empty string gives no clauses', segmentClauses('').length === 0);
check('whitespace only gives no clauses', segmentClauses('   \n  ').length === 0);
check('null-ish input is safe', segmentClauses(undefined).length === 0);

console.log('\nsegmentClauses: clauses tile the input');
{
  const samples = [
    '最初の文です。次の文です。最後のことば',
    '本当に？！すごい',
    '直接のテキスト\nあとのテキスト',
    'Hello world. これは日本語です。',
    '   会議です。   ',
  ];
  let allOk = true;
  let detail = '';
  for (const s of samples) {
    const c = segmentClauses(s);
    for (let i = 0; i < c.length; i++) {
      const x = c[i];
      if (x.contentStart < x.start || x.contentEnd > x.end) { allOk = false; detail = s; }
      if (x.text !== s.slice(x.contentStart, x.contentEnd)) { allOk = false; detail = s; }
      if (i > 0 && c[i - 1].contentEnd > x.contentStart) { allOk = false; detail = s; }
    }
  }
  check('content ranges are ordered, non-overlapping and match text', allOk, detail);
}

console.log('\nalignClauseTranslations');
{
  check('2 clauses vs 2 sentences aligns 1:1',
    JSON.stringify(alignClauseTranslations(2, "I'll go. I arrived.")) ===
    JSON.stringify(["I'll go.", 'I arrived.']),
    JSON.stringify(alignClauseTranslations(2, "I'll go. I arrived.")));
  check('2 vs 1 fails closed', alignClauseTranslations(2, 'One sentence only.') === null);
  check('2 vs 3 fails closed',
    alignClauseTranslations(2, 'One. Two. Three.') === null);
  check('a closing quote after the stop still splits',
    JSON.stringify(alignClauseTranslations(2, 'He said "go." Then we left.')) ===
    JSON.stringify(['He said "go."', 'Then we left.']),
    JSON.stringify(alignClauseTranslations(2, 'He said "go." Then we left.')));
  check('single clause never aligns', alignClauseTranslations(1, 'Only one.') === null);
  check('empty english fails closed', alignClauseTranslations(2, '') === null);
  check('missing english fails closed', alignClauseTranslations(2, undefined) === null);
}

console.log('\nconstants');
check('MIN_SYNTHETIC_CLAUSE_CHARS is a positive integer',
  Number.isInteger(MIN_SYNTHETIC_CLAUSE_CHARS) && MIN_SYNTHETIC_CLAUSE_CHARS > 0,
  String(MIN_SYNTHETIC_CLAUSE_CHARS));

console.log(failures === 0 ? '\nAll clause tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
