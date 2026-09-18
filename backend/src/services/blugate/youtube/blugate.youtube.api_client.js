// Blugate YouTube gateway client.
//
// curl -X GET 'https://blugate.blurasaga.com/api/gateway/youtube/videos?part=snippet&id=VIDEO_ID' \
//   -H 'Authorization: Bearer <ACCESS_KEY>' \
//   -H 'x-client-id: <CLIENT_CODE>'
//
// Adapted from the multitenancy branch's blugate.youtube.api_client.js:
// same endpoint catalog, same request shape. Only the auth source changed
// (authFromEnv() here vs. a per-tenant Postgres row there) — see
// ../blugate.http.js.

const env = require('./blugate.youtube.env');
const { YOUTUBE_ENDPOINTS } = require('./blugate.youtube.endpoints');
const { authFromEnv, blugateRequest } = require('../blugate.http');

const authFromYouTubePlatform = () => authFromEnv('YouTube');

const callYouTubeApi = async (endpointKey, params = {}, auth = null) => {
  const endpoint = YOUTUBE_ENDPOINTS[endpointKey];
  if (!endpoint) {
    throw new Error(
      `Unknown YouTube endpoint "${endpointKey}". Valid keys: ${Object.keys(YOUTUBE_ENDPOINTS).join(', ')}`
    );
  }

  return blugateRequest({
    baseUrl: env.getYouTubeBaseUrl(),
    path: endpoint.path,
    method: endpoint.method,
    params,
    auth: auth || authFromYouTubePlatform(),
    timeout: Number(process.env.YOUTUBE_API_TIMEOUT_MS) || 45000,
    label: 'YouTube',
    endpointKey,
  });
};

callYouTubeApi.authFromPlatformRow = authFromYouTubePlatform;

module.exports = callYouTubeApi;
module.exports.authFromPlatformRow = authFromYouTubePlatform;
module.exports.callYouTubeApi = callYouTubeApi;
module.exports.YOUTUBE_ENDPOINTS = YOUTUBE_ENDPOINTS;
