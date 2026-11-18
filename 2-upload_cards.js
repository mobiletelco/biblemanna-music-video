// upload_cards.js <cardsDir> <style> <chatId>
// POSTs rendered JPEGs to the Apps Script router callback in chunks bounded by
// MEASURED ENCODED request size, not file count. Google's documented 50 MB POST
// quota covers OUTBOUND UrlFetch only; incoming doPost bodies have no published
// limit and practitioner tests only confirm ~24 MB passes, so every request is
// asserted under 19 MB encoded (base64 inflates ~37%).
// Env: CALLBACK_URL, CALLBACK_SECRET. Logs never print either.
const fs = require('fs');
const path = require('path');

const [dir, style, chatId] = process.argv.slice(2);
const { CALLBACK_URL, CALLBACK_SECRET } = process.env;
if (!CALLBACK_URL || !CALLBACK_SECRET) throw new Error('callback config missing');

const MAX_REQ_BYTES = 19 * 1024 * 1024; // encoded JSON budget per request
const MAX_FILE_BYTES = 6 * 1024 * 1024; // card ceiling (1080x1350 JPEG ~0.5 MB)

// Caption rules ported from the user's "BibleManna Images to Drive.gs"
function captionFromFilename(fileName) {
  let name = fileName.replace(/\s*\.(jpg|jpeg|png|webp)$/i, '')
    .replace(/—/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const verseMatch = name.match(/\b([A-Za-z]+\s\d+[-:]\d+(?:[–-]\d+)?)\b/);
  let verse = verseMatch ? verseMatch[1] : '';
  if (verse) name = name.replace(verse, '').trim();
  if (verse.includes('-')) verse = verse.replace('-', ':');
  const tagMatch = name.match(/-(LORD|GOD|JESUS CHRIST|JESUS|CHRIST)\b/i);
  const tag = tagMatch ? '-' + tagMatch[1].toUpperCase() : '';
  if (tagMatch) name = name.replace(tagMatch[0], '').trim();
  let out = name;
  if (verse) out += '\n' + verse;
  if (tag) out += '\n' + tag;
  return out;
}

(async () => {
  const names = fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f)).sort();
  const items = names.map(f => {
    const size = fs.statSync(path.join(dir, f)).size;
    if (size > MAX_FILE_BYTES) throw new Error(`card too large for callback route: ${f} (${size} bytes)`);
    return { name: f, caption: captionFromFilename(f), b64: fs.readFileSync(path.join(dir, f)).toString('base64') };
  });
  let chunk = [], chunkBytes = 0, sent = 0, idx = 0;
  const flush = async (done) => {
    if (!chunk.length) return;
    idx++;
    const payload = { callback_secret: CALLBACK_SECRET, kind: 'cards', style, chat_id: chatId,
                      count: chunk.length, done, files: chunk };
    const body = JSON.stringify(payload);
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_REQ_BYTES) throw new Error(`encoded request ${bytes} bytes exceeds budget - chunker bug`);
    const res = await fetch(CALLBACK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error('callback failed: ' + res.status);
    sent += chunk.length;
    console.log(`chunk ${idx}: ${chunk.length} cards, ${bytes} bytes encoded, accepted`);
    chunk = []; chunkBytes = 0;
  };
  for (const it of items) {
    const entryBytes = it.b64.length + Buffer.byteLength(it.name) + Buffer.byteLength(it.caption) + 64;
    if (chunkBytes + entryBytes > MAX_REQ_BYTES * 0.95) await flush(false);
    chunk.push(it); chunkBytes += entryBytes;
  }
  await flush(true);
  console.log(`uploaded ${sent}/${items.length} cards via callback`);
})().catch(e => { console.error('upload failed:', e.message); process.exit(1); });
