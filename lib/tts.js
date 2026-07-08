// Server-side text-to-speech via a bundled Piper install (bin/linux/piper).
// TTS runs here instead of the browser's speechSynthesis so that no client
// device ever needs anything installed (Firefox on Linux, for example,
// needs an OS-level speech-dispatcher/espeak backend for speechSynthesis to
// produce any audio at all) — the browser just plays back the WAV bytes we
// stream it, which works everywhere with a plain <audio> element.

const { spawn } = require('child_process');
const path = require('path');

const PIPER_BIN    = process.env.PIPER_BIN    || path.join(__dirname, '..', 'bin', 'linux', 'piper', 'piper');
const PIPER_MODEL  = process.env.PIPER_MODEL  || path.join(__dirname, '..', 'voices', 'en_US-lessac-medium.onnx');
const PIPER_LIB_DIR = path.dirname(PIPER_BIN);

// Synthesizes `text` to WAV bytes. `rate` matches the assistant's existing
// speech-rate setting (0.9 slow / 1.05 normal / 1.3 fast); Piper's
// length_scale is inversely proportional to speed, so it's just 1/rate.
function synthesize(text, rate) {
  return new Promise((resolve, reject) => {
    const lengthScale = (1 / (parseFloat(rate) || 1.05)).toFixed(3);
    const proc = spawn(PIPER_BIN, [
      '--model', PIPER_MODEL,
      '--output_file', '-',
      '--length_scale', lengthScale,
      '--quiet',
    ], { env: { ...process.env, LD_LIBRARY_PATH: PIPER_LIB_DIR } });

    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (e) => reject(new Error('Piper not available: ' + e.message)));
    proc.on('close', (code) => {
      if (code !== 0 || !chunks.length) {
        return reject(new Error('Piper synthesis failed: ' + (stderr.trim() || `exit code ${code}`)));
      }
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

module.exports = { synthesize };
