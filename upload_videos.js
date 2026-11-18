// upload_videos.js <outDir> <style> <chatId>
// POSTs rendered MP4s (post/ and story/ subdirs) to the Apps Script router
// callback in chunks bounded by MEASURED ENCODED request size. Google's 50 MB
// POST quota covers OUTBOUND UrlFetch only; incoming doPost bodies have no
// published limit and practitioner tests only confirm ~24 MB passes, so every
// request is asserted under 19 MB encoded (base64 inflates ~37%).
// A single file above the per-file ceiling fails loudly by name instead of
// producing an oversized request. Under the user's render semantics (30s cap,
// ~2.2 Mbps total) an MP4 is ~8 MB, so the ceiling has headroom.
// Env: CALLBACK_URL, CALLBACK_SECRET. Logs never print either.
const fs = require('fs');
const path = require('path');

const [outDir, style, chatId] = process.argv.slice(2);
const { CALLBACK_URL, CALLBACK_SECRET } = process.env;
if (!CALLBACK_URL || !CALLBACK_SECRET) throw new Error('callback config missing');

const MAX_REQ_BYTES = 19 * 1024 * 1024;  // encoded JSON budget per request
const MAX_FILE_BYTES = 14 * 1024 * 1024; // single-video ceiling (~8 MB expected)

(async () => {
  const files = [];
  for (const fmt of ['post', 'story']) {
    const d = path.join(outDir, fmt);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter(x => x.endsWith('.mp4')).sort()) {
      files.push({ name: f, fmt, path: path.join(d, f), size: fs.statSync(path.join(d, f)).size });
    }
  }
  if (!files.length) throw new Error('no videos found');
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES)
      throw new Error(`video too large for callback route: ${f.name} (${f.size} bytes) - needs a different delivery route`);
  }

  let chunk = [], chunkBytes = 0, sent = 0, idx = 0;
  const flush = async (done) => {
    if (!chunk.length) return;
    idx++;
    const payload = { callback_secret: CALLBACK_SECRET, kind: 'videos', style, chat_id: chatId,
                      count: chunk.length, done,
                      files: chunk.map(f => ({ name: f.name, fmt: f.fmt, b64: fs.readFileSync(f.path).toString('base64') })) };
    const body = JSON.stringify(payload);
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_REQ_BYTES) throw new Error(`encoded request ${bytes} bytes exceeds budget - chunker bug`);
    const res = await fetch(CALLBACK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error('callback failed: ' + res.status);
    sent += chunk.length;
    console.log(`chunk ${idx}: ${chunk.length} videos, ${bytes} bytes encoded, accepted`);
    chunk = []; chunkBytes = 0;
  };

  for (const f of files) {
    const entryBytes = Math.ceil(f.size / 3) * 4 + Buffer.byteLength(f.name) + 32;
    if (chunkBytes + entryBytes > MAX_REQ_BYTES * 0.95) await flush(false);
    chunk.push(f); chunkBytes += entryBytes;
  }
  await flush(true);
  console.log(`uploaded ${sent}/${files.length} videos via callback`);
})().catch(e => { console.error('video upload failed:', e.message); process.exit(1); });
