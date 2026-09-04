const dns = require('dns').promises;
const net = require('net');
const axios = require('axios');

// Blocks outbound requests to loopback/private/link-local ranges (including the
// 169.254.169.254 cloud metadata address) so a server-side fetch of an
// attacker-influenced URL (link previews, media downloads) can't be redirected
// at the ingestion server or internal network.
const isPrivateIPv4 = (ip) => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
};

const isPrivateIPv6 = (ip) => {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIPv4(normalized.slice(7));
  return false;
};

const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
};

// Resolves the hostname and rejects it if it points at a private/internal address.
const assertPublicHost = async (urlString) => {
  const parsed = new URL(urlString);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-http(s) URL scheme: ${parsed.protocol}`);
  }
  if (parsed.hostname === 'localhost') {
    throw new Error('Blocked request to localhost');
  }
  const { address } = await dns.lookup(parsed.hostname);
  if (isPrivateIp(address)) {
    throw new Error(`Blocked request to private/internal address (${address})`);
  }
};

// GET a URL while validating every redirect hop against the private-IP blocklist,
// so a public URL that 30x's to an internal service cannot be used as an SSRF pivot.
// Returns { response, finalUrl } — finalUrl is the URL that actually served the response.
const safeGet = async (urlString, config = {}, maxRedirects = 5) => {
  let currentUrl = urlString;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHost(currentUrl);
    const response = await axios.get(currentUrl, { ...config, maxRedirects: 0, validateStatus: () => true });
    const isRedirect = response.status >= 300 && response.status < 400 && response.headers.location;
    if (!isRedirect) return { response, finalUrl: currentUrl };
    currentUrl = new URL(response.headers.location, currentUrl).toString();
  }
  throw new Error('Too many redirects');
};

module.exports = { assertPublicHost, isPrivateIp, safeGet };
