// Blugate Instagram gateway client (ig-downloader-api).
//
// curl -X POST 'https://blugate.blurasaga.com/api/gateway/instagram/api/instagram/userInfo' \
//   -H 'Authorization: Bearer <ACCESS_KEY>' \
//   -H 'x-client-id: <CLIENT_CODE>' \
//   -H 'Content-Type: application/json' \
//   -d '{"username":"instagram"}'
//
// Adapted from the multitenancy branch's blugate.instagram.api_client.js:
// same endpoint catalog, same request shape. Only the auth source changed
// (authFromEnv() here vs. a per-tenant Postgres row there) — see
// ../blugate.http.js.

const env = require('./blugate.instagram.env');
const { INSTAGRAM_ENDPOINTS } = require('./blugate.instagram.endpoints');
const { authFromEnv, blugateRequest } = require('../blugate.http');

const authFromInstagramPlatform = () => authFromEnv('Instagram');

const callInstagramApi = async (endpointKey, body = {}, auth = null) => {
  const endpoint = INSTAGRAM_ENDPOINTS[endpointKey];
  if (!endpoint) {
    throw new Error(
      `Unknown Instagram endpoint "${endpointKey}". Valid keys: ${Object.keys(INSTAGRAM_ENDPOINTS).join(', ')}`
    );
  }

  return blugateRequest({
    baseUrl: env.getInstagramBaseUrl(),
    path: endpoint.path,
    method: endpoint.method,
    params: body,
    auth: auth || authFromInstagramPlatform(),
    timeout: Number(process.env.INSTAGRAM_API_TIMEOUT_MS) || 60000,
    label: 'Instagram',
    endpointKey,
  });
};

callInstagramApi.authFromPlatformRow = authFromInstagramPlatform;

module.exports = callInstagramApi;
module.exports.authFromPlatformRow = authFromInstagramPlatform;
module.exports.callInstagramApi = callInstagramApi;
module.exports.INSTAGRAM_ENDPOINTS = INSTAGRAM_ENDPOINTS;
