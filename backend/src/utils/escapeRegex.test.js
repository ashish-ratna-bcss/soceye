/**
 * Unit checks for escapeRegex — prevents Mongo $regex NoSQL-injection/ReDoS
 * from unsanitized query-string input.
 * Run: node src/utils/escapeRegex.test.js
 */
const assert = require('assert');
const { escapeRegex } = require('./escapeRegex');

const run = () => {
  // A malicious ".*" should no longer act as a wildcard once escaped.
  const pattern = new RegExp(escapeRegex('a.*b'), 'i');
  assert.ok(pattern.test('a.*b'), 'escaped pattern must still match the literal string');
  assert.ok(!pattern.test('aXXXb'), 'escaped pattern must NOT match as a wildcard anymore');

  // Regex metacharacters that could otherwise break out of the intended match.
  assert.strictEqual(escapeRegex('(a|b)'), '\\(a\\|b\\)');
  assert.strictEqual(escapeRegex('1+1=2'), '1\\+1=2');

  console.log('escapeRegex.test.js: PASS');
};

run();
