/**
 * Shared Blugate gateway HTTP helpers.
 *
 * Ported from the multitenancy branch's services/blugate/blugate.http.js.
 * The ONLY change from that branch: auth there is resolved per-tenant from
 * a Postgres `platforms` table (encrypted secrets, via lib/platformSecrets).
 * This app is single-tenant with no Postgres/Prisma, so auth here is a
 * single Blugate credential pair read from env vars instead. Everything
 * else — base URL resolution, request shape, header names, error
 * formatting — is identical.
 *
 * Auth:
 *   Authorization: Bearer <BLUGATE_ACCESS_KEY>
 *   x-client-id: <BLUGATE_CLIENT_ID>
 * Base URL from .env (BLUGATE_<PLATFORM>_HOST / BLUGATE_BASE_URL).
 */

const axios = require('axios');
const blugateHealthState = require('./blugateHealthState');

const normalizeBaseUrl = (raw) => {
  const value = String(raw || '').trim().replace(/\/$/, '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
};

/**
 * Resolve gateway base URL for a platform segment (facebook|instagram|youtube|twitter).
 * Prefers BLUGATE_<PLATFORM>_HOST, then BLUGATE_BASE_URL + /api/gateway/<segment>.
 */
const resolveGatewayBaseUrl = (segment, envKeys = []) => {
  for (const key of envKeys) {
    const fromEnv = normalizeBaseUrl(process.env[key]);
    if (fromEnv) return fromEnv;
  }
  const root = normalizeBaseUrl(process.env.BLUGATE_BASE_URL || process.env.BLUGATE_HOST || '');
  if (!root) return '';
  if (new RegExp(`/api/gateway/${segment}/?$`, 'i').test(root)) return root.replace(/\/$/, '');
  if (/\/api\/gateway$/i.test(root)) return `${root}/${segment}`;
  return `${root}/api/gateway/${segment}`;
};

/**
 * Single-tenant credential pair for the Blugate gateway.
 *
 * Adapted from authFromPlatformRow(row) in the reference branch — same
 * contract (throws a 400-flagged Error when unset, returns
 * { accessKey, clientId} when configured), but the source is env vars
 * rather than a decrypted Postgres row, since there is no per-tenant
 * platforms table here.
 */
const authFromEnv = (platformLabel = 'platform') => {
  const accessKey = String(process.env.BLUGATE_ACCESS_KEY || '').trim();
  const clientId = String(process.env.BLUGATE_CLIENT_ID || '').trim();
  if (!accessKey) {
    const err = new Error(
      `Blugate access key missing for ${platformLabel}. Set BLUGATE_ACCESS_KEY in .env.`
    );
    err.status = 400;
    throw err;
  }
  if (!clientId) {
    const err = new Error(
      `Blugate client id missing for ${platformLabel}. Set BLUGATE_CLIENT_ID in .env.`
    );
    err.status = 400;
    throw err;
  }
  return { accessKey, clientId };
};

/** True once a base URL and both credentials are present — used to gate the RapidAPI-direct fallback. */
const isBlugateConfigured = () => {
  const hasBase = Boolean(
    process.env.BLUGATE_BASE_URL || process.env.BLUGATE_HOST ||
    process.env.BLUGATE_FACEBOOK_HOST || process.env.BLUGATE_INSTAGRAM_HOST ||
    process.env.BLUGATE_TWITTER_HOST || process.env.BLUGATE_X_HOST
  );
  return hasBase
    && Boolean(String(process.env.BLUGATE_ACCESS_KEY || '').trim())
    && Boolean(String(process.env.BLUGATE_CLIENT_ID || '').trim());
};

const formatAxiosError = (err, label, endpointKey) => {
  const status = err.response?.status;
  const data = err.response?.data;
  let detail = '';
  if (typeof data === 'string') detail = data.slice(0, 300);
  else if (data && typeof data === 'object') {
    detail = data.message || data.error || data.detail || JSON.stringify(data).slice(0, 300);
  } else {
    detail = err.message;
  }
  if (/incorrect header check/i.test(String(err.message || ''))) {
    detail = 'Gateway returned a compressed body that could not be decoded.';
  }
  const enriched = new Error(
    status
      ? `Blugate ${label} ${endpointKey} HTTP ${status}: ${detail}`
      : `Blugate ${label} ${endpointKey}: ${detail}`
  );
  enriched.status = status || 502;
  enriched.response = err.response;
  enriched.code = err.code;
  return enriched;
};

/**
 * Call Blugate gateway with Bearer + x-client-id.
 * @param {{ baseUrl: string, path: string, method?: string, params?: object, auth: {accessKey, clientId}, timeout?: number, label?: string, endpointKey?: string }} opts
 */
const blugateRequest = async ({
  baseUrl,
  path,
  method = 'GET',
  params = {},
  auth,
  timeout = 45000,
  label = 'API',
  endpointKey = '',
}) => {
  const accessKey = String(auth?.accessKey || '').trim();
  const clientId = String(auth?.clientId || '').trim();
  if (!accessKey || !clientId) {
    throw new Error(
      'Blugate credentials required: BLUGATE_ACCESS_KEY and BLUGATE_CLIENT_ID must be set in .env'
    );
  }
  if (!baseUrl) {
    throw new Error(`Blugate ${label} base URL is not configured`);
  }

  const cleanPath = String(path || '');
  const suffix = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
  const requestUrl = `${String(baseUrl).replace(/\/$/, '')}${suffix}`;
  const verb = String(method || 'GET').toUpperCase();
  const isBodyMethod = verb !== 'GET' && verb !== 'DELETE' && verb !== 'HEAD';
  const headers = {
    Authorization: `Bearer ${accessKey}`,
    'x-client-id': clientId,
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
  };
  if (isBodyMethod) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await axios({
      method: verb,
      url: requestUrl,
      params: !isBodyMethod ? params : undefined,
      data: isBodyMethod ? params : undefined,
      headers,
      timeout,
      decompress: false,
      responseType: 'text',
      transformResponse: [
        (raw) => {
          if (raw == null || raw === '') return raw;
          if (typeof raw === 'object') return raw;
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        },
      ],
      validateStatus: (s) => s >= 200 && s < 300,
    });
    blugateHealthState.markHealthy();
    return response.data;
  } catch (err) {
    const enriched = formatAxiosError(err, label, endpointKey || verb);
    if (enriched.status === 401) {
      blugateHealthState.markUnauthorized(enriched);
    }
    throw enriched;
  }
};

module.exports = {
  normalizeBaseUrl,
  resolveGatewayBaseUrl,
  authFromEnv,
  isBlugateConfigured,
  blugateRequest,
};
