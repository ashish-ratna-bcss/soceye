// Facebook Blugate gateway base URL.
//   BLUGATE_FACEBOOK_HOST=https://blugate.blurasaga.com/api/gateway/facebook
//   or BLUGATE_BASE_URL=https://blugate.blurasaga.com
//
// (Reference branch note: "credentials from platforms table" — this app has
// no per-tenant platforms table; see ../blugate.http.js authFromEnv().)

const { resolveGatewayBaseUrl } = require('../blugate.http');

const getFacebookBaseUrl = () =>
  resolveGatewayBaseUrl('facebook', [
    'BLUGATE_FACEBOOK_HOST',
    'FACEBOOK_BASE_URL',
  ]);

module.exports = {
  getFacebookBaseUrl,
};
