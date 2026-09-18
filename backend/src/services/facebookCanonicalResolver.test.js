const assert = require('assert');
const {
  isFacebookShareUrl,
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
} = require('./facebookCanonicalResolver');

// The exact client-reported case: SOC-EYE turned this /share/v/ link into a
// bare, ownerless https://www.facebook.com/posts/pfbid... — a URL Facebook
// does not serve (404). This suite locks down that it can never happen again.
const CLIENT_SHARE_URL = 'https://www.facebook.com/share/v/19NsK6UL8b/';
const CLIENT_FABRICATED_URL = 'https://www.facebook.com/posts/pfbid0dFhL8eKBtezAQYVu5FA6BTK9wauERZa6eJsdpSHJ4nuUYZ9C2ZP7JfQEBJV9Y8rCl';
const CLIENT_PFBID = 'pfbid0dFhL8eKBtezAQYVu5FA6BTK9wauERZa6eJsdpSHJ4nuUYZ9C2ZP7JfQEBJV9Y8rCl';

const run = async (name, fn) => {
  await fn();
  console.log(`  ok: ${name}`);
};

const main = async () => {
  // ---- Client case: never fabricate an ownerless /posts/<pfbid> ----

  await run('client case: buildCanonicalPfbidUrl refuses to fabricate without a known owner', async () => {
    // No owner can be derived from the /share/v/ URL itself.
    const result = buildCanonicalPfbidUrl(CLIENT_SHARE_URL, CLIENT_PFBID);
    assert.strictEqual(result, '', 'must return empty string, never a bare /posts/<pfbid> URL');
    assert.notStrictEqual(result, CLIENT_FABRICATED_URL);
  });

  await run('client case: chooseCanonicalUrl never fabricates the reported bad URL', async () => {
    // Worst case: no og:url, no owned-pfbid-in-html, resolver only has the
    // pfbid token and the unresolved /share/v/ URL as "finalUrl".
    const picked = chooseCanonicalUrl({
      ogUrl: '',
      finalUrl: CLIENT_SHARE_URL,
      pfbid: CLIENT_PFBID,
      ownedPfbidUrl: ''
    });
    assert.notStrictEqual(picked, CLIENT_FABRICATED_URL);
    assert.ok(!/^https:\/\/www\.facebook\.com\/posts\//.test(picked), `must not be an ownerless /posts/ URL, got: ${picked}`);
  });

  await run('client case: chooseCanonicalUrl accepts an owner-bearing og:url when present', async () => {
    const picked = chooseCanonicalUrl({
      ogUrl: 'https://www.facebook.com/somepage.official/videos/9988776655443322/',
      finalUrl: CLIENT_SHARE_URL,
      pfbid: '',
      ownedPfbidUrl: ''
    });
    assert.strictEqual(picked, 'https://www.facebook.com/somepage.official/videos/9988776655443322');
  });

  await run('client case: chooseCanonicalUrl accepts an owned pfbid (owner + pfbid seen together)', async () => {
    const picked = chooseCanonicalUrl({
      ogUrl: '',
      finalUrl: CLIENT_SHARE_URL,
      pfbid: CLIENT_PFBID,
      ownedPfbidUrl: `https://www.facebook.com/somepage.official/posts/${CLIENT_PFBID}`
    });
    assert.strictEqual(picked, `https://www.facebook.com/somepage.official/posts/${CLIENT_PFBID}`);
  });

  await run('client case: an ownerless reel og:url is accepted as-is (real, working link)', async () => {
    const picked = chooseCanonicalUrl({
      ogUrl: 'https://www.facebook.com/reel/9988776655443322/',
      finalUrl: CLIENT_SHARE_URL,
      pfbid: '',
      ownedPfbidUrl: ''
    });
    assert.strictEqual(picked, 'https://www.facebook.com/reel/9988776655443322');
  });

  // ---- URL-shape regression matrix (PR #2 coverage) ----

  await run('isFacebookShareUrl recognizes /share/v/, /share/p/, /share/r/', async () => {
    assert.strictEqual(isFacebookShareUrl('https://www.facebook.com/share/v/19NsK6UL8b/'), true);
    assert.strictEqual(isFacebookShareUrl('https://www.facebook.com/share/p/1EaP2MtgCS/'), true);
    assert.strictEqual(isFacebookShareUrl('https://www.facebook.com/share/r/1EaP2MtgCS/'), true);
    assert.strictEqual(isFacebookShareUrl('https://www.facebook.com/somepage/posts/123456789012345'), false);
  });

  await run('extractOwnerSegment: page/profile owners accepted, routes rejected', async () => {
    assert.strictEqual(extractOwnerSegment('https://www.facebook.com/saiyadav.hindu.52/videos/123'), 'saiyadav.hindu.52');
    assert.strictEqual(extractOwnerSegment('https://www.facebook.com/profile.php?id=100012345'), 'profile.php?id=100012345');
    assert.strictEqual(extractOwnerSegment('https://www.facebook.com/reel/9988776655443322/'), '');
    assert.strictEqual(extractOwnerSegment('https://www.facebook.com/watch/?v=123'), '');
    assert.strictEqual(extractOwnerSegment('https://www.facebook.com/posts/pfbidXYZ'), '');
  });

  await run('extractOwnerHandle: numeric id for profile.php, raw slug otherwise', async () => {
    assert.strictEqual(extractOwnerHandle('https://www.facebook.com/profile.php?id=100012345'), '100012345');
    assert.strictEqual(extractOwnerHandle('https://www.facebook.com/saiyadav.hindu.52/videos/123'), 'saiyadav.hindu.52');
  });

  await run('extractNumericPostIdFromUrl: posts/reel/videos/watch/photo/permalink', async () => {
    assert.strictEqual(extractNumericPostIdFromUrl('https://www.facebook.com/page/posts/123456789012345'), '123456789012345');
    assert.strictEqual(extractNumericPostIdFromUrl('https://www.facebook.com/reel/9988776655443322/'), '9988776655443322');
    assert.strictEqual(extractNumericPostIdFromUrl('https://www.facebook.com/page/videos/some-long-slug/998877665544/'), '998877665544');
    assert.strictEqual(extractNumericPostIdFromUrl('https://www.facebook.com/watch/?v=112233445566'), '112233445566');
    assert.strictEqual(extractNumericPostIdFromUrl('https://www.facebook.com/photo/?fbid=112233445566'), '112233445566');
    assert.strictEqual(extractNumericPostIdFromUrl('https://www.facebook.com/share/v/19NsK6UL8b/'), '');
  });

  await run('extractPfbidFromText: pulls pfbid token from a posts URL', async () => {
    const pfbid = 'pfbid02LnRd8kKFNy4iYMyrkC1bLbVvX12UTQvWx4KWCYGEDnNWbdpSW2bKTT2sio5fyCvRl';
    assert.strictEqual(extractPfbidFromText(`https://www.facebook.com/somepage/posts/${pfbid}`), pfbid);
    assert.strictEqual(extractPfbidFromText('https://www.facebook.com/reel/123/'), '');
  });

  await run('buildCanonicalPfbidUrl: builds owner/posts/pfbid when owner is known', async () => {
    const pfbid = 'pfbid02LnRd8kKFNy4iYMyrkC1bLbVvX12UTQvWx4KWCYGEDnNWbdpSW2bKTT2sio5fyCvRl';
    const url = buildCanonicalPfbidUrl('https://www.facebook.com/somepage/posts/other-slug', pfbid);
    assert.strictEqual(url, `https://www.facebook.com/somepage/posts/${pfbid}`);
  });

  await run('extractOwnedPfbidUrlFromHtml: only trusts owner/posts/pfbid pairs, rejects route names as owner', async () => {
    const pfbid = 'pfbid02LnRd8kKFNy4iYMyrkC1bLbVvX12UTQvWx4KWCYGEDnNWbdpSW2bKTT2sio5fyCvRl';
    const goodHtml = `<script>"url":"https:\\/\\/www.facebook.com\\/somepage.official\\/posts\\/${pfbid}"</script>`;
    const { url, pfbid: foundPfbid } = extractOwnedPfbidUrlFromHtml(goodHtml);
    assert.strictEqual(url, `https://www.facebook.com/somepage.official/posts/${pfbid}`);
    assert.strictEqual(foundPfbid, pfbid);

    const routeHtml = `<script>"url":"https:\\/\\/www.facebook.com\\/reel\\/posts\\/${pfbid}"</script>`;
    const rejected = extractOwnedPfbidUrlFromHtml(routeHtml);
    assert.strictEqual(rejected.url, '');
  });

  await run('stripFacebookUrl: preserves identity query params, normalizes m./mbasic. hosts', async () => {
    assert.strictEqual(
      stripFacebookUrl('https://m.facebook.com/profile.php?id=100012345&sk=about'),
      'https://www.facebook.com/profile.php?id=100012345'
    );
    assert.strictEqual(
      stripFacebookUrl('https://mbasic.facebook.com/watch/?v=112233445566&ref=x'),
      'https://www.facebook.com/watch?v=112233445566'
    );
  });

  await run('compactPermalinkPath: collapses long video slug to /<owner>/videos/<id>', async () => {
    const longSlug = 'a'.repeat(120);
    assert.strictEqual(
      compactPermalinkPath(`/somepage/videos/${longSlug}/9988776655443322`),
      '/somepage/videos/9988776655443322'
    );
  });

  await run('scoreSnapshot: owner+id=3, owner-only=2, id-only=1 (ownerless reel), share-url=0', async () => {
    assert.strictEqual(scoreSnapshot({ canonicalUrl: 'https://www.facebook.com/somepage/posts/123456789012345' }), 3);
    assert.strictEqual(scoreSnapshot({ canonicalUrl: 'https://www.facebook.com/somepage' }), 2);
    // /reel/<id> carries no owner segment by definition (NON_OWNER_SEGMENTS) —
    // it is addressable but anonymous, so it scores 1, same as a bare id.
    assert.strictEqual(scoreSnapshot({ canonicalUrl: 'https://www.facebook.com/reel/123456789012345/' }), 1);
    assert.strictEqual(scoreSnapshot({ canonicalUrl: 'https://www.facebook.com/somepage/videos/123456789012345' }), 3);
    assert.strictEqual(scoreSnapshot({ canonicalUrl: 'https://www.facebook.com/share/v/19NsK6UL8b/' }), 0);
    assert.strictEqual(scoreSnapshot({ canonicalUrl: '' }), 0);
  });

  console.log('facebookCanonicalResolver.test.js: all tests passed');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
