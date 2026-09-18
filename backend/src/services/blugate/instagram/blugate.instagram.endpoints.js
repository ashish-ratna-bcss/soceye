/**
 * Instagram Blugate gateway routes (ig-downloader-api docs only).
 * Base: https://blugate.blurasaga.com/api/gateway/instagram/api/instagram
 * Full paths are /api/instagram/<name> (see blugateapis/ig-downloader-api-*.json).
 * Profile preview uses USER_INFO only.
 *
 * Ported verbatim from the multitenancy branch's
 * services/blugate/instagram/blugate.instagram.endpoints.js.
 */
const INSTAGRAM_ENDPOINTS = {
  LINKS: {
    method: 'POST',
    path: '/links',
    usedFor: 'Direct media download links from a post/reel URL',
  },
  MEDIA_BY_SHORTCODE: {
    method: 'POST',
    path: '/mediaByShortcode',
    usedFor: 'Post/reel detail by shortcode',
  },
  PROFILE: {
    method: 'POST',
    path: '/profile',
    usedFor: 'Public profile by username',
  },
  USER_INFO: {
    method: 'POST',
    path: '/userInfo',
    usedFor: 'Public profile by username or userId — preview identity',
  },
  POSTS: {
    method: 'POST',
    path: '/posts',
    usedFor: 'User posts feed (paginate with maxId)',
  },
  REELS: {
    method: 'POST',
    path: '/reels',
    usedFor: 'User reels feed (paginate with maxId)',
  },
  TAGGED_POSTS: {
    method: 'POST',
    path: '/taggedPosts',
    usedFor: 'Posts tagging a user',
  },
  STORIES: {
    method: 'POST',
    path: '/stories',
    usedFor: 'Active stories for a username',
  },
  STORY: {
    method: 'POST',
    path: '/story',
    usedFor: 'Single story by username + storyId',
  },
  HIGHLIGHTS: {
    method: 'POST',
    path: '/highlights',
    usedFor: 'Highlight collections for a username',
  },
  HIGHLIGHT_STORIES: {
    method: 'POST',
    path: '/highlightStories',
    usedFor: 'Stories inside a highlight collection',
  },
  COMMENTS: {
    method: 'POST',
    path: '/comments',
    usedFor: 'Comments on a post URL',
  },
  FOLLOWERS: {
    method: 'POST',
    path: '/followers',
    usedFor: 'Followers of a user',
  },
  FOLLOWINGS: {
    method: 'POST',
    path: '/followings',
    usedFor: 'Accounts a user follows',
  },
  // ── Legacy/alternate provider shapes ────────────────────────────────────
  // Older route spellings this app still tries as fallbacks when the primary
  // shape above returns nothing. Routed through Blugate (which passes them to
  // the same upstream provider) so nothing falls back to direct RapidAPI.
  USER_POSTS_LEGACY: {
    method: 'POST',
    path: '/user/posts',
    usedFor: 'User posts feed — legacy route spelling, fallback for /posts',
  },
  MEDIA_LEGACY: {
    method: 'POST',
    path: '/media',
    usedFor: 'Post/reel media payload — legacy route spelling',
  },
  USER_INFO_LEGACY: {
    method: 'POST',
    path: '/user/info',
    usedFor: 'Public profile — legacy route spelling, fallback for /userInfo',
  },
  USER_INFO_BY_ID: {
    method: 'POST',
    path: '/userInfoById',
    usedFor: 'Public profile by numeric user id',
  },
  USER_INFO_BY_ID_LEGACY: {
    method: 'POST',
    path: '/user/info/by/id',
    usedFor: 'Public profile by numeric user id — legacy route spelling',
  },
  POST_INFO: {
    method: 'POST',
    path: '/postInfo',
    usedFor: 'Single post detail by shortcode/url',
  },
  POST_INFO_LEGACY: {
    method: 'POST',
    path: '/post/info',
    usedFor: 'Single post detail — legacy route spelling',
  },
  MEDIA_INFO_LEGACY: {
    method: 'POST',
    path: '/media/info',
    usedFor: 'Single post/media detail — legacy route spelling',
  },
};

module.exports = { INSTAGRAM_ENDPOINTS };
