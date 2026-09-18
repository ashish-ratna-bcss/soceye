const {
  fetchVerifiedFacebookPostFromApi,
  fetchPageDetails,
  postMatchesTarget,
  extractFacebookPostToken,
  normalizeFacebookUrlForMatch
} = require('./rapidApiFacebookService');
const {
  resolveFacebookCanonicalPost,
  fetchFacebookPageSnapshot,
  FACEBOOK_CRAWLER_UA,
  isFacebookShareUrl,
  extractPfbidFromText,
  extractNumericPostIdFromUrl,
  extractOwnerHandle
} = require('./facebookCanonicalResolver');
const logger = require('../utils/logger');

const mapPostToMetadata = (post, contentId, originalUrl, canonicalUrl) => ({
  id: post.id || contentId || '',
  title: post.text ? String(post.text).substring(0, 120) : `Facebook post by ${post.author || 'Unknown'}`,
  text: post.text || '',
  description: post.text || '',
  author: post.author || 'Facebook User',
  // Never default to the literal 'facebook' - that is what rendered every
  // unresolved Facebook investigation as "@facebook" on the alert card.
  author_handle: post.author_handle || post.author || '',
  author_avatar: post.author_avatar || '',
  created_at: post.created_at || new Date(),
  platform: 'facebook',
  content_type: 'post',
  media: Array.isArray(post.media)
    ? post.media.map((m) => (typeof m === 'string' ? { type: 'photo', url: m } : m)).filter((m) => m?.url)
    : [],
  metrics: post.metrics || {},
  canonical_url: canonicalUrl || post.url || originalUrl,
  original_url: originalUrl,
  investigation_verified: true,
  verification_source: post.verification_source || 'rapidapi_post'
});

const pageUrlMatchesTarget = (pageUrl, originalUrl, canonicalUrl, contentId) => {
  if (!pageUrl) return false;

  const fakePost = {
    url: pageUrl,
    id: extractFacebookPostToken(pageUrl) || extractPfbidFromText(pageUrl)
  };
  const targets = [canonicalUrl, originalUrl].filter(Boolean);

  return targets.some((target) => {
    if (normalizeFacebookUrlForMatch(pageUrl) === normalizeFacebookUrlForMatch(target)) {
      return true;
    }
    return postMatchesTarget(fakePost, target, contentId);
  });
};

const postMatchesInvestigation = (post, originalUrl, canonicalUrl, contentId) => {
  const targets = [canonicalUrl, originalUrl].filter(Boolean);
  if (!targets.length) {
    return postMatchesTarget(post, '', contentId);
  }
  return targets.some((target) => postMatchesTarget(post, target, contentId));
};

const buildPostFromCanonicalSnapshot = (snapshot, canonicalUrl, postId) => {
  if (!snapshot || !canonicalUrl) return null;

  // Reels and videos carry a numeric post id and no pfbid at all. Requiring a
  // pfbid here is what made every reel investigation fall through to the
  // "identity could not be verified" path.
  const resolvedId = postId
    || extractPfbidFromText(canonicalUrl)
    || extractNumericPostIdFromUrl(canonicalUrl);
  if (!resolvedId) return null;

  const text = snapshot.description || snapshot.title || '';
  const media = Array.isArray(snapshot.media) ? snapshot.media.filter((m) => m?.url) : [];
  if (!text.trim() && media.length === 0) return null;

  const ownerSlug = snapshot.ownerSlug || extractOwnerHandle(canonicalUrl) || '';

  return {
    id: resolvedId,
    url: canonicalUrl,
    text,
    // Deliberately never snapshot.title: on a reel og:title is
    // "2.1K views - 58 reactions | <post text>" - the post, not the poster.
    author: snapshot.authorName || snapshot.author || ownerSlug || 'Facebook User',
    author_handle: ownerSlug || '',
    media,
    metrics: {},
    verification_source: 'facebook_crawler_og',
    created_at: new Date()
  };
};

const identityIsCanonical = (canonicalUrl, pfbid, numericId = '') => {
  if (!canonicalUrl || isFacebookShareUrl(canonicalUrl)) return false;
  if (pfbid && extractPfbidFromText(canonicalUrl) === pfbid) return true;

  const urlNumericId = extractNumericPostIdFromUrl(canonicalUrl);
  if (numericId && (urlNumericId === numericId || String(canonicalUrl).includes(`/${numericId}`))) {
    return true;
  }

  // A permalink that carries its own post id is addressable on its own —
  // pfbid for feed posts, a numeric id for reels / videos / photos.
  return Boolean(extractPfbidFromText(canonicalUrl) || urlNumericId);
};

/**
 * Recover the poster's display name and avatar from the owning page.
 * Best-effort: the investigation still succeeds when this lookup fails.
 */
const enrichAuthorFromOwnerPage = async (metadata, ownerSlug, pageDetailsFetcher) => {
  if (!ownerSlug || typeof pageDetailsFetcher !== 'function') return;

  // Only spend a RapidAPI call when we genuinely have no poster name — i.e. the
  // crawler-OG path, where the best we have is the raw page slug. When the
  // RapidAPI /post lookup already named the author, leave it alone.
  const unresolvedAuthor = !metadata.author
    || metadata.author === 'Facebook User'
    || metadata.author === ownerSlug;
  if (!unresolvedAuthor) return;

  try {
    const page = await pageDetailsFetcher(`https://www.facebook.com/${ownerSlug}`);
    if (page?.name && unresolvedAuthor) metadata.author = page.name;
    if (page?.image && !metadata.author_avatar) metadata.author_avatar = page.image;
    if (!metadata.author_handle) metadata.author_handle = ownerSlug;
  } catch (error) {
    logger.info(
      `[FacebookInvestigation] Page details lookup failed for ${ownerSlug}: ${error.message}`
    );
  }
};

/**
 * Resolve and verify a Facebook post for on-demand investigation.
 * Never uses /search/posts. Returns verified metadata or an unresolved result.
 */
const resolveFacebookInvestigation = async ({
  originalUrl,
  canonicalUrl,
  contentId = '',
  canonicalResolution = null,
  fetchPageMetadata = null,
  fetchPostFromApi = fetchVerifiedFacebookPostFromApi,
  resolveCanonical = resolveFacebookCanonicalPost,
  fetchOwnerPageDetails = fetchPageDetails
}) => {
  let resolved = canonicalResolution;
  if (!resolved) {
    resolved = await resolveCanonical(canonicalUrl || originalUrl);
  }

  const resolvedCanonical = resolved?.canonicalUrl || canonicalUrl || originalUrl;
  const resolvedPfbid = resolved?.pfbid || extractPfbidFromText(resolvedCanonical);
  const resolvedNumericId = resolved?.numericId || extractNumericPostIdFromUrl(resolvedCanonical);
  const resolvedOwnerSlug = resolved?.ownerSlug || extractOwnerHandle(resolvedCanonical);
  // A /share/<token> id is not a stable post identifier, so a real pfbid or
  // numeric id must outrank the caller-supplied contentId.
  const resolvedContentId = resolvedPfbid || resolvedNumericId || contentId;

  const result = {
    status: 'unresolved',
    original_url: originalUrl,
    canonical_url: resolvedCanonical,
    content_id: resolvedContentId || contentId || '',
    message: '',
    metadata: null,
    partial: null,
    resolution: resolved ? {
      resolved_via: resolved.resolvedVia,
      pfbid: resolvedPfbid || null,
      numeric_id: resolvedNumericId || null
    } : null
  };

  if (!identityIsCanonical(resolvedCanonical, resolvedPfbid, resolvedNumericId)) {
    result.message = 'Facebook post identity could not be verified. Investigation was not analyzed to avoid mismatched content.';
    result.partial = {
      original_url: originalUrl,
      canonical_url: resolvedCanonical,
      content_id: contentId || null,
      reason: 'canonical_unresolved'
    };
    return result;
  }

  let matchedPost = null;

  try {
    matchedPost = await fetchPostFromApi({
      canonicalUrl: resolvedCanonical,
      pfbid: resolvedPfbid,
      numericId: resolvedNumericId,
      originalUrl
    }, { throwOnCooldown: true });

    if (matchedPost && !postMatchesInvestigation(matchedPost, originalUrl, resolvedCanonical, resolvedContentId)) {
      logger.warn(
        `[FacebookInvestigation] Rejected RapidAPI /post result (id=${matchedPost.id || 'n/a'})`
      );
      matchedPost = null;
    }
  } catch (error) {
    if (error?.code === 'FB_RAPIDAPI_COOLDOWN' || error?.response?.status === 429) {
      throw error;
    }
  }

  if (!matchedPost) {
    const snapshot = resolved?.snapshot
      || await fetchFacebookPageSnapshot(resolvedCanonical, FACEBOOK_CRAWLER_UA);
    matchedPost = buildPostFromCanonicalSnapshot(
      snapshot,
      resolvedCanonical,
      resolvedPfbid || resolvedNumericId
    );

    if (matchedPost && !postMatchesInvestigation(matchedPost, originalUrl, resolvedCanonical, resolvedContentId)) {
      logger.warn('[FacebookInvestigation] Rejected crawler snapshot post identity mismatch');
      matchedPost = null;
    }
  }

  if (!matchedPost) {
    result.message = 'Facebook post identity could not be verified. Investigation was not analyzed to avoid mismatched content.';
    result.partial = {
      original_url: originalUrl,
      canonical_url: resolvedCanonical,
      content_id: resolvedContentId || contentId || null,
      reason: 'no_verified_post'
    };
    return result;
  }

  const verifiedCanonical = matchedPost.url || resolvedCanonical || originalUrl;
  const metadata = mapPostToMetadata(matchedPost, resolvedContentId, originalUrl, verifiedCanonical);
  const verifiedContentId = metadata.id || resolvedContentId;

  if (
    !metadata.text?.trim()
    && matchedPost.verification_source === 'rapidapi_post'
    && typeof fetchPageMetadata === 'function'
  ) {
    const scraped = await fetchPageMetadata(verifiedCanonical, 'facebook');
    const scrapePageUrl = scraped?.canonical_url || verifiedCanonical;

    if (
      scraped?.text?.trim()
      && pageUrlMatchesTarget(scrapePageUrl, originalUrl, verifiedCanonical, verifiedContentId)
    ) {
      metadata.text = scraped.text;
      metadata.description = scraped.description || scraped.text;
      metadata.title = scraped.title || metadata.title;
      metadata.og_description_fallback = true;
    }
  }

  if (
    (!metadata.media || metadata.media.length === 0)
    && matchedPost.verification_source === 'rapidapi_post'
    && typeof fetchPageMetadata === 'function'
  ) {
    const scraped = await fetchPageMetadata(verifiedCanonical, 'facebook');
    const scrapePageUrl = scraped?.canonical_url || verifiedCanonical;

    if (
      pageUrlMatchesTarget(scrapePageUrl, originalUrl, verifiedCanonical, verifiedContentId)
      && Array.isArray(scraped?.media)
      && scraped.media.length > 0
    ) {
      metadata.media = scraped.media;
      metadata.media_og_fallback = true;
    }
  }

  if (!metadata.text?.trim() && (!metadata.media || metadata.media.length === 0)) {
    result.status = 'partial';
    result.message = 'Facebook post identity was verified, but no analyzable text or media was available.';
    result.metadata = metadata;
    result.canonical_url = verifiedCanonical;
    result.content_id = verifiedContentId;
    result.partial = {
      original_url: originalUrl,
      canonical_url: verifiedCanonical,
      content_id: verifiedContentId,
      reason: 'verified_empty_content'
    };
    return result;
  }

  // The poster's real name / avatar live on the owning page, not in the post's
  // OG tags. Without this the card falls back to the raw slug.
  const ownerSlug = resolvedOwnerSlug || extractOwnerHandle(verifiedCanonical);
  if (!metadata.author_handle && ownerSlug) metadata.author_handle = ownerSlug;
  await enrichAuthorFromOwnerPage(metadata, ownerSlug, fetchOwnerPageDetails);

  result.status = 'verified';
  result.canonical_url = verifiedCanonical;
  result.content_id = verifiedContentId;
  result.metadata = metadata;
  result.owner_slug = ownerSlug || null;
  result.message = `Facebook post verified via ${metadata.verification_source}`;
  return result;
};

module.exports = {
  resolveFacebookInvestigation,
  mapPostToMetadata,
  pageUrlMatchesTarget,
  postMatchesInvestigation,
  buildPostFromCanonicalSnapshot,
  identityIsCanonical,
  enrichAuthorFromOwnerPage
};
