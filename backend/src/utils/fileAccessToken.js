const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/security');

// Scoped, non-session capability token: grants read access to exactly one
// stored file path (report PDF / upload). Unlike a user's session JWT, a
// leaked file-access token cannot be replayed against any other API route.
// Long-lived because generated reports/uploads must stay reachable for the
// life of the case they belong to.
const signFileAccessToken = (key) =>
  jwt.sign({ purpose: 'file-access', key }, getJwtSecret(), { expiresIn: '3650d' });

const isValidFileAccessToken = (token, key) => {
  if (!token || !key) return false;
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    return !!decoded && decoded.purpose === 'file-access' && decoded.key === key;
  } catch (_) {
    return false;
  }
};

const withFileAccessToken = (url, key) => {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(signFileAccessToken(key))}`;
};

module.exports = { signFileAccessToken, isValidFileAccessToken, withFileAccessToken };
