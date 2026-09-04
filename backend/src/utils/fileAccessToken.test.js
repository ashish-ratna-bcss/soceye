/**
 * Unit checks for the per-file capability token used to gate /files and /api/files.
 * Run: node src/utils/fileAccessToken.test.js
 */
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const { signFileAccessToken, isValidFileAccessToken, withFileAccessToken } = require('./fileAccessToken');

const run = () => {
  const key = 'grievance-reports/abc-123.pdf';
  const token = signFileAccessToken(key);

  assert.ok(isValidFileAccessToken(token, key), 'token must validate for the key it was signed for');
  assert.ok(!isValidFileAccessToken(token, 'other-key.pdf'), 'token must NOT validate for a different key');
  assert.ok(!isValidFileAccessToken('not-a-jwt', key), 'garbage token must be rejected');
  assert.ok(!isValidFileAccessToken(null, key), 'missing token must be rejected');
  assert.ok(!isValidFileAccessToken(token, null), 'missing key must be rejected');

  const url = withFileAccessToken('https://example.com/files/' + key, key);
  assert.ok(url.includes('?token='), 'withFileAccessToken must append a token query param');

  const urlWithExistingQuery = withFileAccessToken('https://example.com/files/x?foo=1', 'x');
  assert.ok(urlWithExistingQuery.includes('&token='), 'must use & when the URL already has a query string');

  console.log('fileAccessToken.test.js: PASS');
};

run();
