const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../utils/logger');
const { extractFacebookPostToken } = require('./rapidApiFacebookService');

const FACEBOOK_CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const FACEBOOK_FACEBOT_UA = 'Facebot';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const isFacebookShareUrl = (value) => /\/share\/(?:v|r|p)\//i.test(String(value || ''));

// Query params that are part of a post's identity and must survive normalisation.
// Dropping these turned `profile.php?id=...` into `/profile.php` and `watch/?v=...`
// into `/watch`, both of which are dead links.
const IDENTITY_QUERY_KEYS = ['id', 'story_fbid', 'fbid', 'v', 'video_id'];

// First path segment values that are Facebook routes, not page/profile owners.
// The auth routes matter as much as the content ones: Facebook answers some
// share links with a login wall, and if 'login' counted as an owner that
// snapshot scored 2 and beat the real owner-less /reel/<id>/ answer (score 1),
// so a valid reel resolved to facebook.com/login and failed verification.
const NON_OWNER_SEGMENTS = new Set([
  'reel', 'reels', 'watch', 'video', 'videos', 'posts', 'post', 'photo', 'photos',
  'permalink.php', 'story.php', 'share', 'groups', 'events', 'marketplace', 'media',
  'pages', 'people', 'p', 'story', 'l.php', 'login.php', 'plugins', 'ajax', 'search',
  'privacy', 'help', 'policies', 'watchparty', 'gaming', 'live',
  'login', 'checkpoint', 'recover', 'authentication', 'home.php', 'logout.php'
]);

const safeParseUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
};

const buildFacebookShareCandidates = (url) => {
  const candidates = new Set([url]);
  const parsed = safeParseUrl(url);
  if (!parsed) return Array.from(candidates);

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || '';
  if (/\/share\/(?:v|r|p)\//i.test(path) && host.includes('facebook.com')) {
    const mUrl = new URL(parsed.href);
    mUrl.hostname = host.replace(/^www\./i, 'm.');
    candidates.add(mUrl.href);

    const mbasicUrl = new URL(parsed.href);
    mbasicUrl.hostname = host.replace(/^www\./i, 'mbasic.');
    candidates.add(mbasicUrl.href);
  }

  return Array.from(candidates);
};

const extractPfbidFromText = (value) => {
  const match = String(value || '').match(/(pfbid[a-z0-9]+)/i);
  return match?.[1] || '';
};

/**
 * Owner (page / profile) segment of a Facebook URL.
 *   https://www.facebook.com/saiyadav.hindu.52/videos/...  -> 'saiyadav.hindu.52'
 *   https://www.facebook.com/profile.php?id=123            -> 'profile.php?id=123'
 *   https://www.facebook.com/reel/2508059666357345/        -> ''  (owner-less route)
 */
const extractOwnerSegment = (value) => {
  const parsed = safeParseUrl(value);
  if (!parsed) return '';
  if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) return '';

  const parts = (parsed.pathname || '').split('/').filter(Boolean);
  if (parts.length === 0) return '';

  let first;
  try {
    first = decodeURIComponent(parts[0]);
  } catch {
    first = parts[0];
  }

  const lowered = first.toLowerCase();

  if (lowered === 'profile.php') {
    const id = parsed.searchParams.get('id');
    return id && /^\d+$/.test(id) ? `profile.php?id=${id}` : '';
  }

  if (NON_OWNER_SEGMENTS.has(lowered)) return '';
  // A bare numeric first segment is an entity id, which is a valid owner.
  return first;
};

/** Display handle for the owner - the numeric id for profile.php URLs. */
const extractOwnerHandle = (value) => {
  const segment = extractOwnerSegment(value);
  if (!segment) return '';
  const profileMatch = segment.match(/^profile\.php\?id=(\d+)$/i);
  return profileMatch ? profileMatch[1] : segment;
};

/**
 * Post id for every Facebook permalink shape we ingest - not just `/posts/<id>`.
 * Reels and videos were previously invisible here, so identityIsCanonical()
 * could never verify them and the resolver fell back to hunting for a pfbid.
 */
const extractNumericPostIdFromUrl = (value) => {
  const parsed = safeParseUrl(value);
  if (!parsed) return '';
  const pathname = parsed.pathname || '';

  // /<owner>/posts/<id>  |  /posts/<id>
  const postsMatch = pathname.match(/\/posts\/(\d{6,})(?:\/|$)/i);
  if (postsMatch?.[1]) return postsMatch[1];

  // /reel/<id> | /videos/<id> | /watch/<id> | /photo/<id> | /permalink/<id>
  const mediaMatch = pathname.match(/\/(?:reels?|videos?|watch|photos?|permalink)\/(\d{6,})(?:\/|$)/i);
  if (mediaMatch?.[1]) return mediaMatch[1];

  // /<owner>/videos/<slug>/<id>/ - the shape Facebot returns for reels
  const trailingMatch = pathname.match(/\/(?:reels?|videos?|photos?)\/[^/]+\/(\d{6,})(?:\/|$)/i);
  if (trailingMatch?.[1]) return trailingMatch[1];

  for (const key of IDENTITY_QUERY_KEYS) {
    if (key === 'id') continue; // `id` on profile.php is the page, not the post
    const q = parsed.searchParams.get(key);
    if (q && /^\d{6,}$/.test(q)) return q;
  }

  return '';
};

/**
 * Collapse /<owner>/videos/<very-long-slug>/<id> to /<owner>/videos/<id>.
 * Facebook resolves both to the same post, but the slug form runs to ~700
 * characters for a non-Latin caption, which is unusable in a WhatsApp share
 * or a printed PDF report.
 */
const compactPermalinkPath = (pathname) => String(pathname || '').replace(
  /^\/([^/]+)\/(videos?|reels?|photos?)\/[^/]+\/(\d{6,})$/i,
  (_match, owner, kind, id) => `/${owner}/${kind}/${id}`
);

/** Normalise to https://www.facebook.com/<path>, preserving identity query params. */
const stripFacebookUrl = (value) => {
  const parsed = safeParseUrl(value);
  if (!parsed) return String(value || '').trim();

  const path = compactPermalinkPath((parsed.pathname || '').replace(/\/+$/, ''));
  const host = parsed.hostname.replace(/^(m|mbasic|web)\./i, 'www.');

  const kept = new URLSearchParams();
  for (const key of IDENTITY_QUERY_KEYS) {
    const val = parsed.searchParams.get(key);
    if (val) kept.set(key, val);
  }
  const query = kept.toString();

  return `https://${host}${path}${query ? `?${query}` : ''}`;
};

/**
 * Place a pfbid under its owning page. Returns '' when no owner is known.
 *
 * It previously returned `https://www.facebook.com/posts/<token>` in that case,
 * which is not a Facebook route at all - that synthesised URL is what shipped to
 * operators as "Review Original Source" and 404'd.
 */
const buildCanonicalPfbidUrl = (finalUrl, pfbid) => {
  const token = pfbid || extractPfbidFromText(finalUrl);
  if (!token) return '';

  const parsed = safeParseUrl(finalUrl);
  if (!parsed) return '';

  const pathParts = (parsed.pathname || '').split('/').filter(Boolean);
  const postsIdx = pathParts.findIndex((p) => p.toLowerCase() === 'posts');
  if (postsIdx > 0) {
    const owner = pathParts.slice(0, postsIdx).join('/');
    return `https://www.facebook.com/${owner}/posts/${token}`;
  }

  const owner = extractOwnerSegment(finalUrl);
  if (owner) return `https://www.facebook.com/${owner}/posts/${token}`;

  return '';
};

/**
 * A pfbid is only this post's identity when it arrives attached to its owner.
 * The previous `html.match(/pfbid[a-z0-9]+/gi)[0]` took the first pfbid anywhere
 * in ~480 KB of markup - routinely a suggested reel or a neighbouring post.
 */
const extractOwnedPfbidUrlFromHtml = (html) => {
  const match = String(html || '').match(
    /facebook\.com\\?\/([A-Za-z0-9.\-%]{3,60})\\?\/posts\\?\/(pfbid[a-z0-9]+)/i
  );
  if (!match) return { url: '', pfbid: '' };

  const owner = match[1];
  if (NON_OWNER_SEGMENTS.has(owner.toLowerCase())) return { url: '', pfbid: '' };

  return { url: `https://www.facebook.com/${owner}/posts/${match[2]}`, pfbid: match[2] };
};

const extractOgMedia = (html) => {
  const $ = cheerio.load(html || '');
  const readMeta = (...selectors) => {
    for (const selector of selectors) {
      const value = $(selector).attr('content');
      if (value && String(value).trim()) return String(value).trim();
    }
    return '';
  };

  const image = readMeta(
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]'
  );
  const video = readMeta('meta[property="og:video"]', 'meta[property="og:video:url"]');

  const media = [];
  if (image) media.push({ type: 'photo', url: image });
  if (video) media.push({ type: 'video', url: video });

  return media;
};

/**
 * Pick the canonical URL, strongest evidence first.
 * og:url is Facebook's own answer and must outrank anything we assemble.
 */
const chooseCanonicalUrl = ({ ogUrl, finalUrl, pfbid, ownedPfbidUrl }) => {
  const ogCandidate = ogUrl && !isFacebookShareUrl(ogUrl) ? stripFacebookUrl(ogUrl) : '';

  // 1. og:url that names its owner - best possible answer.
  if (ogCandidate && extractOwnerSegment(ogCandidate)) return ogCandidate;

  // 2. A pfbid seen together with its owner.
  if (ownedPfbidUrl) return stripFacebookUrl(ownedPfbidUrl);

  // 3. pfbid placed under an owner taken from the resolved URL.
  const built = buildCanonicalPfbidUrl(finalUrl, pfbid);
  if (built) return built;

  // 4. Owner-less og:url (e.g. /reel/<id>/). A real, working Facebook link.
  if (ogCandidate) return ogCandidate;

  // 5. The redirect target, if it escaped /share/.
  if (finalUrl && !isFacebookShareUrl(finalUrl)) return stripFacebookUrl(finalUrl);

  return '';
};

const fetchFacebookPageSnapshot = async (url, userAgent) => {
  const response = await axios.get(url, {
    timeout: 25000,
    maxRedirects: 10,
    responseType: 'text',
    validateStatus: () => true,
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const finalUrl = response?.request?.res?.responseUrl
    || response?.request?.responseURL
    || url;
  const html = typeof response?.data === 'string' ? response.data : '';
  const $ = cheerio.load(html);

  const readMeta = (selector) => {
    const value = $(selector).attr('content');
    return value && String(value).trim() ? String(value).trim() : '';
  };

  const ogUrl = readMeta('meta[property="og:url"]') || $('link[rel="canonical"]').attr('href') || '';
  const absoluteOgUrl = ogUrl
    ? (ogUrl.startsWith('http') ? ogUrl : new URL(ogUrl, finalUrl).href)
    : '';

  const owned = extractOwnedPfbidUrlFromHtml(html);
  const pfbid = extractPfbidFromText(finalUrl)
    || extractPfbidFromText(absoluteOgUrl)
    || owned.pfbid
    || '';

  const canonicalUrl = chooseCanonicalUrl({
    ogUrl: absoluteOgUrl,
    finalUrl,
    pfbid,
    ownedPfbidUrl: owned.url
  });

  const numericId = extractNumericPostIdFromUrl(canonicalUrl)
    || extractNumericPostIdFromUrl(absoluteOgUrl)
    || extractNumericPostIdFromUrl(finalUrl);

  const ownerSlug = extractOwnerHandle(canonicalUrl)
    || extractOwnerHandle(absoluteOgUrl)
    || extractOwnerHandle(finalUrl);

  // og:site_name is "Facebook" (or empty) on post pages, never the poster.
  // og:title on a reel is "2.1K views - 58 reactions | <post text>" - it is the
  // post, not the author, and must never be promoted to an author name.
  const siteName = readMeta('meta[property="og:site_name"]');
  const authorName = siteName && siteName.toLowerCase() !== 'facebook' ? siteName : '';

  return {
    status: response.status,
    inputUrl: url,
    finalUrl,
    ogUrl: absoluteOgUrl,
    canonicalUrl,
    pfbid,
    numericId,
    ownerSlug,
    authorName,
    title: readMeta('meta[property="og:title"]') || $('title').text().trim(),
    description: readMeta('meta[property="og:description"]')
      || readMeta('meta[name="description"]'),
    author: authorName,
    media: extractOgMedia(html),
    htmlLen: html.length,
    userAgent
  };
};

/**
 * How much do we trust this snapshot's canonical identity?
 *   3 - owner + post id (fully addressable permalink)
 *   2 - owner only
 *   1 - post id only (e.g. /reel/<id>/ - works, but anonymous)
 *   0 - unusable
 */
const scoreSnapshot = (snapshot) => {
  const canonical = snapshot?.canonicalUrl || '';
  if (!canonical || isFacebookShareUrl(canonical)) return 0;

  const hasOwner = Boolean(extractOwnerSegment(canonical));
  const hasId = Boolean(
    snapshot.pfbid || snapshot.numericId || extractNumericPostIdFromUrl(canonical)
  );

  if (hasOwner && hasId) return 3;
  if (hasOwner) return 2;
  if (hasId) return 1;
  return 0;
};

/**
 * Resolve a Facebook post URL (especially /share/...) to its canonical identity.
 *
 * Every host/UA combination is scored and the best one wins, rather than the
 * first that merely escaped /share/. For reels the crawler UA answers with the
 * owner-less /reel/<id>/ while Facebot answers with
 * /<owner>/videos/<slug>/<id>/ - only the latter carries the poster's handle.
 */
const resolveFacebookCanonicalPost = async (url) => {
  const input = String(url || '').trim();
  const result = {
    originalUrl: input,
    canonicalUrl: input,
    pfbid: '',
    numericId: '',
    ownerSlug: '',
    ogUrl: '',
    title: '',
    description: '',
    author: '',
    media: [],
    resolvedVia: 'unresolved',
    snapshot: null
  };

  if (!input) return result;

  const candidates = buildFacebookShareCandidates(input);
  const userAgents = isFacebookShareUrl(input)
    ? [FACEBOOK_FACEBOT_UA, FACEBOOK_CRAWLER_UA, CHROME_UA]
    : [CHROME_UA, FACEBOOK_CRAWLER_UA, FACEBOOK_FACEBOT_UA];

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    for (const userAgent of userAgents) {
      try {
        const snapshot = await fetchFacebookPageSnapshot(candidate, userAgent);
        const score = scoreSnapshot(snapshot);

        if (score > bestScore) {
          bestScore = score;
          best = snapshot;
        }

        // Owner + id is as good as it gets; stop paying for more round trips.
        if (bestScore === 3) break;
      } catch (error) {
        logger.info(`[FacebookCanonical] Snapshot failed for ${candidate}: ${error.message}`);
      }
    }
    if (bestScore === 3) break;
  }

  if (!best || bestScore === 0) {
    logger.warn(
      `[FacebookCanonical] Unresolved ${input} - no candidate produced an addressable post URL`
    );
    return result;
  }

  const resolvedVia = best.userAgent === FACEBOOK_CRAWLER_UA || best.userAgent === FACEBOOK_FACEBOT_UA
    ? 'crawler_ua'
    : 'browser_ua';

  const resolved = {
    ...result,
    canonicalUrl: best.canonicalUrl,
    pfbid: best.pfbid,
    numericId: best.numericId,
    ownerSlug: best.ownerSlug,
    ogUrl: best.ogUrl,
    title: best.title,
    description: best.description,
    // Deliberately NOT snapshot.title - see fetchFacebookPageSnapshot.
    author: best.authorName || best.ownerSlug || '',
    media: best.media,
    resolvedVia,
    snapshot: best
  };

  logger.info(
    `[FacebookCanonical] Resolved ${input} -> ${resolved.canonicalUrl} `
    + `(owner=${resolved.ownerSlug || 'n/a'}, pfbid=${resolved.pfbid || 'n/a'}, `
    + `numeric=${resolved.numericId || 'n/a'}, score=${bestScore}, via=${resolvedVia})`
  );

  return resolved;
};

module.exports = {
  FACEBOOK_CRAWLER_UA,
  FACEBOOK_FACEBOT_UA,
  isFacebookShareUrl,
  fetchFacebookPageSnapshot,
  resolveFacebookCanonicalPost,
  extractPfbidFromText,
  buildCanonicalPfbidUrl,
  extractNumericPostIdFromUrl,
  extractOwnerSegment,
  extractOwnerHandle,
  extractOwnedPfbidUrlFromHtml,
  chooseCanonicalUrl,
  stripFacebookUrl,
  compactPermalinkPath,
  scoreSnapshot
};
