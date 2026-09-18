// YouTube Blugate gateway base URL.
//   BLUGATE_YOUTUBE_HOST=https://blugate.blurasaga.com/api/gateway/youtube
//   or BLUGATE_BASE_URL=https://blugate.blurasaga.com
//
// Ported verbatim from the multitenancy branch's
// services/blugate/youtube/blugate.youtube.env.js.

const { resolveGatewayBaseUrl } = require('../blugate.http');

const getYouTubeBaseUrl = () =>
  resolveGatewayBaseUrl('youtube', ['BLUGATE_YOUTUBE_HOST', 'YOUTUBE_BASE_URL']);

module.exports = {
  getYouTubeBaseUrl,
};
