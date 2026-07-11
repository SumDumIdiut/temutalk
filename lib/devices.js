const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const DEVICES_FILE = path.join(__dirname, '..', 'devices.json');

// Per-device Spotify credentials (clientId, clientSecret)
const deviceCredentials = new Map();

const devices = (function loadDevices() {
  try {
    const obj = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    const map = new Map();
    for (const [k, v] of Object.entries(obj)) {
      const { creds, ...rest } = v;
      map.set(k, rest);
      if (creds?.clientId) deviceCredentials.set(k, creds);
    }
    return map;
  } catch { return new Map(); }
})();

function saveDevices() {
  const obj = {};
  for (const [k, v] of devices) {
    obj[k] = { ...v };
    const creds = deviceCredentials.get(k);
    if (creds) obj[k].creds = creds;
  }
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(obj, null, 2));
}

function resolveDevice(req) {
  return req.query.device || req.headers['x-device-id'] || null;
}

// Spotify refresh tokens rotate (each refresh call both consumes the old one
// and issues a new one) — if several requests race in to getDeviceToken()
// for the same device while its token is expired, each would try to redeem
// the same refresh_token independently, and only the first actually
// succeeds; the rest fail with invalid_grant purely from the race, not
// because the token was really dead. In-flight de-duplication (one shared
// promise per device) makes concurrent callers await the same refresh
// instead of each starting their own.
const _refreshInFlight = new Map(); // deviceId -> Promise<string|null>

async function getDeviceToken(deviceId) {
  const dev = devices.get(deviceId);
  if (!dev?.tokens?.access_token) return null;
  if (Date.now() > dev.tokens.expires_at - 60_000) {
    if (_refreshInFlight.has(deviceId)) return _refreshInFlight.get(deviceId);
    const refreshPromise = (async () => {
      const creds = deviceCredentials.get(deviceId);
      if (!creds) return null;
      try {
        const r = await axios.post(
          'https://accounts.spotify.com/api/token',
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: dev.tokens.refresh_token,
            client_id: creds.clientId,
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        dev.tokens.access_token  = r.data.access_token;
        dev.tokens.expires_at    = Date.now() + r.data.expires_in * 1000;
        if (r.data.refresh_token) dev.tokens.refresh_token = r.data.refresh_token;
        saveDevices();
        return dev.tokens.access_token;
      } catch (e) {
        console.error(`[device:${deviceId}] Token refresh failed:`, e.response?.data?.error || e.message);
        dev.tokens.access_token = null;
        saveDevices();
        return null;
      } finally {
        _refreshInFlight.delete(deviceId);
      }
    })();
    _refreshInFlight.set(deviceId, refreshPromise);
    return refreshPromise;
  }
  return dev.tokens.access_token;
}

module.exports = { devices, deviceCredentials, saveDevices, resolveDevice, getDeviceToken };
