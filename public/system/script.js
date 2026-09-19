// ── Device name ──────────────────────────────────────────────────────────
// A per-device label (persisted server-side, keyed by deviceId) shown in
// Radio's "Play on…" device list instead of a generic device ID.
function loadDeviceName() {
  const input = document.getElementById('device-name-input');
  if (!input) return;
  fetch(BASE_PATH + '/api/device-name?device=' + deviceId).then(r => r.json()).then(d => {
    input.value = d.name || '';
  }).catch(() => {});
}
function saveDeviceName() {
  const input  = document.getElementById('device-name-input');
  const status = document.getElementById('device-name-status');
  if (!input) return;
  const name = input.value.trim();
  fetch(BASE_PATH + '/api/device-name?device=' + deviceId, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }).then(r => r.json()).then(() => {
    if (!status) return;
    status.textContent = 'Saved';
    setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1500);
  }).catch(() => { if (status) status.textContent = 'Could not save'; });
}

