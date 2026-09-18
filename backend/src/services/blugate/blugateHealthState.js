/**
 * Shared BluGate gateway access state.
 *
 * Every call made through blugateRequest() (blugate.http.js) reports its
 * outcome here. A 401 means the BluGate client account has lost access
 * (rate limit / quota exhausted / deactivated) — this is account-wide, not
 * per-platform, so one shared state covers Facebook/Instagram/X/YouTube.
 *
 * There is no separate polling probe: monitorService keeps retrying real
 * scans on a short cadence while unauthorized, and the first call that
 * comes back 200 flips this back to healthy.
 */

const UNAUTHORIZED_MESSAGE =
  'Your API limit has been exceeded. Please renew your API limits to continue receiving live content.';

let state = {
  status: 'unknown', // 'unknown' | 'ok' | 'unauthorized'
  message: null,
  since: null,
  lastCheckedAt: null,
  lastError: null,
};

const markHealthy = () => {
  if (state.status !== 'ok') {
    state = {
      status: 'ok',
      message: null,
      since: new Date(),
      lastCheckedAt: new Date(),
      lastError: null,
    };
    return;
  }
  state.lastCheckedAt = new Date();
};

const markUnauthorized = (err) => {
  const detail = err?.message || 'BluGate returned HTTP 401';
  if (state.status !== 'unauthorized') {
    state = {
      status: 'unauthorized',
      message: UNAUTHORIZED_MESSAGE,
      since: new Date(),
      lastCheckedAt: new Date(),
      lastError: detail,
    };
    return;
  }
  state.lastCheckedAt = new Date();
  state.lastError = detail;
};

const getState = () => ({ ...state });

const isUnauthorized = () => state.status === 'unauthorized';

module.exports = {
  UNAUTHORIZED_MESSAGE,
  markHealthy,
  markUnauthorized,
  getState,
  isUnauthorized,
};
