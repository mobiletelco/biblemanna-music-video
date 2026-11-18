/**
 * BibleManna Auto - Telegram <-> GitHub <-> Drive router (NO n8n).
 * New standalone Apps Script project, deployed as web app (execute as: Me,
 * access: Anyone) with the NEW bot's webhook pointing at its /exec URL.
 * Never edit the existing "BibleManna Images" / "Story Video" projects.
 *
 * Script Properties (Project Settings, never committed):
 *   BOT_TOKEN       - new bot token (collected via Instinct secure form)
 *   OWNER_CHAT_ID   - owner's numeric Telegram chat ID (allowlist)
 *   GITHUB_TOKEN    - fine-grained PAT, contents+actions RW on the repo
 *   GITHUB_REPO     - e.g. mobiletelco/biblemanna-music-video
 *   CALLBACK_SECRET - random string, same value as the repo secret
 *   WEBHOOK_SECRET  - random string required as ?secret= on the webhook URL
 *   MODE            - OFF (render + Telegram reply only) or LIVE (Drive/sheet writes)
 */

const CFG = () => PropertiesService.getScriptProperties().getProperties();
const SHEET_ID = '17_Vknpgh0E1mA4jIyzlRoFRakTJ7uuxhgUc2hC4eSKg';
const IMAGE_FOLDERS = {
  black: { id: '1xCZFm15btt2vljTjUTuReEnApp-l1miH', label: 'Bible Images' },
  white: { id: '1ExkB3LGEFje98MXwtX777GBUyy6q47HT', label: 'Verse Images' }
};
const VIDEO_FOLDERS = {
  'black-post': { id: '1YT1M7VR9AN-UgVVc_Cs0WfjKgO7wFQZn', label: 'Verse Post', tab: 'Verse Video' },
  'white-post': { id: '1qTb0z6LjIejtHSchW6QyDFtOl3Qfiwkq', label: 'Quotes Post', tab: 'Verse Video' },
  'black-story': { id: '19XHOsLIe09vVlCnxYvK_4gvLnU89ZLL2', label: 'Verse Story', tab: 'Story Video' },
  'white-story': { id: '1EkyXCCVZNRc89YgFfe4KZv5nqv_q50OD', label: 'Quotes Story', tab: 'Story Video' }
};
const DONE_FOLDER = '17wlQ1YOl_YntJy-SCAKcQWhZHVOEUwau';

// Parse a raw pasted list into cards. Verse format: heading/blank/other lines ignored,
// ' * body' immediately followed by an indented ref line. Quotes format: body line
// immediately followed by a '-ATTRIBUTION' line; unpaired lines (headings, trailing
// chat text) are ignored. Returns { style, cards: [{body, ref}] } or null when the
// text is not a recognizable complete list. Verse text and attributions stay verbatim.
// Strict by design: any structural anomaly (missing ref, merged lines from a manual
// message split, unknown attribution shape) rejects the whole batch instead of
// rendering guessed or altered cards.
function parseRawList_(text) {
  const lines = String(text).split('\n');
  if (lines.some(l => /^\s*\*\s+/.test(l))) {
    const cards = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*\*\s+(.*\S)\s*$/);
      if (!m) continue;
      const nxt = i + 1 < lines.length ? lines[i + 1] : '';
      if (!/^\s+\S/.test(nxt)) return null; // bullet without indented ref: incomplete input, never guess
      const ref = nxt.trim();
      if (ref.indexOf('*') !== -1) return null;   // merged lines from a manual split
      if (!/\d+:\d+/.test(ref)) return null;      // ref must look like Book chapter:verse
      cards.push({ body: m[1], ref: ref });
      i++;
    }
    return cards.length ? { style: 'black', cards: cards } : null;
  }
  if (lines.some(l => /^-\S/.test(l))) {
    const cards = [];
    let pending = null;
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      if (/-(GOD|JESUS|LORD|CHRIST)$/.test(t) && !/^-[A-Za-z]{2,15}$/.test(t)) return null; // merged body+attribution
      if (/^-[A-Za-z]{2,15}$/.test(t)) {
        if (pending === null) return null; // attribution without a body
        cards.push({ body: pending, ref: t });
        pending = null;
      } else pending = t; // latest non-attribution line wins: headings get overwritten
    }
    return cards.length ? { style: 'white', cards: cards } : null;
  }
  return null;
}

function cardsToListText_(cards) {
  return cards.map(c => c.body + '\n' + c.ref).join('\n\n');
}

// Raw batch storage. Script Properties have a small per-value cap (verified live by
// propertyQuotaProbe), so the buffered text is chunked across RAW_BATCH_0..N-1 with
// a RAW_BATCH_META index. Expiry never drops data silently: rawExpire_ moves the
// fragments to RAW_EXPIRED_* and records a readout so an abandoned batch stays
// recoverable and the user is told on their next message.
const RAW_CHUNK_SIZE_ = 7000;
function rawMeta_(sp) { try { return JSON.parse(sp.getProperty('RAW_BATCH_META') || 'null'); } catch (e) { return null; } }
function rawAppend_(sp, text, chatId) {
  const prev = rawLoad_(sp);
  const full = (prev ? prev.text : '') + text;
  const oldN = prev ? prev.meta.n : 0;
  const chunks = [];
  for (let i = 0; i < full.length; i += RAW_CHUNK_SIZE_) chunks.push(full.slice(i, i + RAW_CHUNK_SIZE_));
  for (let i = chunks.length; i < oldN; i++) sp.deleteProperty('RAW_BATCH_' + i);
  chunks.forEach((c, i) => sp.setProperty('RAW_BATCH_' + i, c));
  sp.setProperty('RAW_BATCH_META', JSON.stringify({ n: chunks.length, chars: full.length, parts: (prev ? prev.meta.parts : 0) + 1, ts: Date.now(), chat_id: chatId }));
  return rawMeta_(sp);
}
function rawLoad_(sp) {
  const m = rawMeta_(sp);
  if (!m) return null;
  let t = '';
  for (let i = 0; i < m.n; i++) t += sp.getProperty('RAW_BATCH_' + i) || '';
  return { text: t, meta: m };
}
function rawClear_(sp) {
  const m = rawMeta_(sp);
  const n = m ? m.n : 0;
  for (let i = 0; i < n; i++) sp.deleteProperty('RAW_BATCH_' + i);
  sp.deleteProperty('RAW_BATCH_META');
}
function rawExpire_(sp) {
  const b = rawLoad_(sp);
  if (!b) return null;
  rawClear_(sp);
  const chunks = [];
  for (let i = 0; i < b.text.length; i += RAW_CHUNK_SIZE_) chunks.push(b.text.slice(i, i + RAW_CHUNK_SIZE_));
  const oldN = Number(sp.getProperty('RAW_EXPIRED_N') || 0);
  for (let i = chunks.length; i < oldN; i++) sp.deleteProperty('RAW_EXPIRED_' + i);
  chunks.forEach((c, i) => sp.setProperty('RAW_EXPIRED_' + i, c));
  sp.setProperty('RAW_EXPIRED_N', String(chunks.length));
  sp.setProperty('RAW_EXPIRED', JSON.stringify({ at: new Date().toISOString(), parts: b.meta.parts, chars: b.meta.chars }));
  return b.meta;
}

// Editor-run probe: finds the real per-value Script Properties cap on this account
// and stores the outcome in QUOTA_PROBE_RESULT (secret-free). Not part of any flow.
function propertyQuotaProbe() {
  const sp = PropertiesService.getScriptProperties();
  const out = { max_ok: 0, failed_at: null };
  let size = 1000;
  try {
    for (; size <= 60000; size += 1000) {
      sp.setProperty('QUOTA_PROBE', 'x'.repeat(size));
      out.max_ok = size;
    }
  } catch (e) {
    out.failed_at = size;
    out.error = String(e).slice(0, 160);
  } finally {
    try { sp.deleteProperty('QUOTA_PROBE'); } catch (e2) {}
  }
  sp.setProperty('QUOTA_PROBE_RESULT', JSON.stringify(out));
}

function doGet() { return ok_(); }

function doPost(e) {
  const p = CFG();
  if (!e || !e.postData) return ok_();
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return ok_(); }

  // Renderer callback (cards or videos back from GitHub)
  if (body.callback_secret) {
    if (body.callback_secret !== p.CALLBACK_SECRET) return ok_();
    if (String(p.MODE) !== 'LIVE') {
      // OFF mode: count only, no Drive writes, no sheet rows, no sharing changes.
      // Readout proving the secret matched and the OFF branch ran (no secrets stored).
      const spOff = PropertiesService.getScriptProperties();
      spOff.setProperty('OFF_LAST_CALLBACK', new Date().toISOString() + ' kind=' + (body.kind || 'cards') + ' count=' + (body.count || 0) + ' done=' + !!body.done);
      spOff.setProperty('OFF_CALLBACKS_TOTAL', String(Number(spOff.getProperty('OFF_CALLBACKS_TOTAL') || 0) + 1));
      if (p.DEMO_OUTPUT_FOLDER_ID && Array.isArray(body.files) && body.files.length) {
        demoSave_(body, p, spOff); // narrow demo path: demo folder only, no sharing, no sheet, no TG
      }
      if (body.done) tg_(p, 'sendMessage', { chat_id: body.chat_id,
        text: 'OFF mode: received ' + (body.count || 0) + ' rendered file(s) from GitHub. Nothing uploaded.' });
      return ok_();
    }
    return body.kind === 'videos' ? handleVideosCallback_(body, p) : handleCardsCallback_(body, p);
  }

  // Telegram update - webhook secret gate
  if (!p.WEBHOOK_SECRET || !e.parameter || e.parameter.secret !== p.WEBHOOK_SECRET) { markIntake_('rejected=secret'); return ok_(); }

  const upd = body;
  if (upd.update_id) {
    const sp = PropertiesService.getScriptProperties();
    const last = Number(sp.getProperty('LAST_UPDATE_ID') || 0);
    if (upd.update_id <= last) { markIntake_('rejected=redelivery id=' + upd.update_id); return ok_(); } // redelivery guard
    sp.setProperty('LAST_UPDATE_ID', String(upd.update_id));
  }
  const msg = upd.message;
  if (!msg || !msg.from) { markIntake_('rejected=no_message'); return ok_(); }
  const chatId = String(msg.chat.id);
  if (String(msg.from.id) !== String(p.OWNER_CHAT_ID)) { markIntake_('rejected=non_owner'); return ok_(); } // owner allowlist

  const text = (msg.text || '').trim();
  const docs = msg.document ? [msg.document] : [];

  try {
    if (text.startsWith('/verse_cards') || text.startsWith('/quotes_cards')) {
      const style = text.startsWith('/verse_cards') ? 'black' : 'white';
      const list = text.replace(/^\/\w+_cards\s*/, '').trim();
      if (!list) { tg_(p, 'sendMessage', { chat_id: chatId, text: 'Send the list text after the command.' }); return ok_(); }
      markIntake_('accepted cmd=cards style=' + style + ' effects=' + (String(p.MODE) === 'LIVE' ? 'sent' : 'suppressed_OFF'));
      dispatch_(p, 'render-cards', { style: style, list_text: list, chat_id: chatId });
      tg_(p, 'sendMessage', { chat_id: chatId, text: 'Rendering ' + style + ' cards on GitHub. Summary follows here.' });
    } else if (text.startsWith('/biblemanna_video')) {
      markIntake_('accepted cmd=video_batch_open effects=' + (String(p.MODE) === 'LIVE' ? 'sent' : 'suppressed_OFF'));
      PropertiesService.getScriptProperties().setProperty('VIDEO_BATCH',
        JSON.stringify({ images: [], audios: [], style: text.includes('white') ? 'white' : 'black', chat_id: chatId, ts: Date.now() }));
      tg_(p, 'sendMessage', { chat_id: chatId, text: 'Send images (as files) and MP3s, then /go. 1-10 each.' });
    } else if (text === '/go') {
      markIntake_('accepted cmd=go effects=' + (String(p.MODE) === 'LIVE' ? 'sent' : 'suppressed_OFF'));
      closeVideoBatch_(p);
    } else if (docs.length) {
      markIntake_('accepted cmd=document effects=' + (String(p.MODE) === 'LIVE' ? 'sent' : 'suppressed_OFF'));
      addToVideoBatch_(p, docs, chatId);
    } else {
      // Raw pasted list intake: Telegram caps messages at 4096 chars and clients reject
      // longer sends, so the user splits a long list into parts manually. Fragments are
      // buffered verbatim (chunked, see rawAppend_), concatenated with '' and parsed
      // strictly only on the explicit completion signal 'done' - never prematurely.
      // A buffer untouched for 30 minutes is expired but preserved (rawExpire_) and the
      // user is told; nothing is silently dropped.
      const spRaw = PropertiesService.getScriptProperties();
      let batch = rawLoad_(spRaw);
      let expired = null;
      if (batch && Date.now() - Number(batch.meta.ts || 0) > 30 * 60 * 1000) { expired = rawExpire_(spRaw); batch = null; }
      const expiredNote = expired ? 'The earlier unfinished list (' + expired.parts + ' part(s)) was set aside after 30 minutes. Send the full list again, then send: done' : null;
      if (/^done$/i.test(text)) {
        if (!batch) {
          markIntake_('accepted cmd=none' + (expired ? ' expired_parts=' + expired.parts : '') + ' effects=none');
          if (expiredNote) tg_(p, 'sendMessage', { chat_id: chatId, text: expiredNote });
          return ok_();
        }
        rawClear_(spRaw);
        const parsed = parseRawList_(batch.text);
        if (!parsed) {
          markIntake_('accepted cmd=raw_close rejected=parse chars=' + batch.meta.chars);
          tg_(p, 'sendMessage', { chat_id: chatId, text: 'Could not read that list - a part may be missing or a line got split. Please send the whole list again, then send: done' });
          return ok_();
        }
        markIntake_('accepted cmd=raw_close style=' + parsed.style + ' count=' + parsed.cards.length + ' effects=' + (String(p.MODE) === 'LIVE' ? 'sent' : 'suppressed_OFF'));
        dispatch_(p, 'render-cards', { style: parsed.style, list_text: cardsToListText_(parsed.cards), chat_id: chatId });
        tg_(p, 'sendMessage', { chat_id: chatId, text: 'Rendering ' + parsed.cards.length + ' ' + parsed.style + ' cards on GitHub. Summary follows here.' });
        return ok_();
      }
      if (batch || /^\s*\*\s+/m.test(text) || /^-\S/m.test(text)) {
        const m = rawAppend_(spRaw, text, chatId);
        markIntake_('accepted cmd=raw_fragment n=' + m.parts + ' chars=' + m.chars + (expired ? ' expired_parts=' + expired.parts : '') + ' effects=' + (String(p.MODE) === 'LIVE' ? 'sent' : 'suppressed_OFF'));
        if (expiredNote) tg_(p, 'sendMessage', { chat_id: chatId, text: expiredNote });
        else if (m.parts === 1) tg_(p, 'sendMessage', { chat_id: chatId, text: 'Got part 1. Send the rest if any, then send: done' });
        return ok_();
      }
      if (expiredNote) {
        markIntake_('accepted cmd=none expired_parts=' + expired.parts + ' effects=none');
        tg_(p, 'sendMessage', { chat_id: chatId, text: expiredNote });
        return ok_();
      }
      markIntake_('accepted cmd=none effects=none');
    }
  } catch (err) {
    tg_(p, 'sendMessage', { chat_id: chatId, text: 'BibleManna Auto intake error: ' + String(err).slice(0, 200) });
  }
  return ok_();
}

function addToVideoBatch_(p, docs, chatId) {
  const sp = PropertiesService.getScriptProperties();
  const raw = sp.getProperty('VIDEO_BATCH');
  if (!raw) { tg_(p, 'sendMessage', { chat_id: chatId, text: 'Start with /biblemanna_video first.' }); return; }
  const b = JSON.parse(raw);
  for (const d of docs) {
    const name = (d.file_name || '').toLowerCase();
    if (name.endsWith('.mp3')) b.audios.push(d.file_id); else b.images.push(d.file_id);
  }
  b.ts = Date.now();
  sp.setProperty('VIDEO_BATCH', JSON.stringify(b));
  tg_(p, 'sendMessage', { chat_id: chatId, text: 'Got ' + b.images.length + ' image(s), ' + b.audios.length + ' audio(s). /go to render.' });
}

function closeVideoBatch_(p) {
  const sp = PropertiesService.getScriptProperties();
  const raw = sp.getProperty('VIDEO_BATCH');
  if (!raw) return;
  sp.deleteProperty('VIDEO_BATCH');
  const b = JSON.parse(raw);
  if (!b.images.length || !b.audios.length) {
    tg_(p, 'sendMessage', { chat_id: b.chat_id, text: 'Need at least 1 image and 1 MP3.' });
    return;
  }
  dispatch_(p, 'render-videos', { job: JSON.stringify({ chat_id: b.chat_id, images: b.images, audios: b.audios, style: b.style }) });
  tg_(p, 'sendMessage', { chat_id: b.chat_id, text: 'Rendering ' + b.images.length + ' videos (post + story) on GitHub.' });
}

/* Time-driven trigger (every minute): auto-close an idle video batch after 60s. */
function tick() {
  const raw = PropertiesService.getScriptProperties().getProperty('VIDEO_BATCH');
  if (!raw) return;
  if (Date.now() - JSON.parse(raw).ts > 60000) closeVideoBatch_(CFG());
}

function dispatch_(p, eventType, payload) {
  if (String(p.MODE) !== 'LIVE') return; // hard OFF guard: no GitHub dispatch
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + p.GITHUB_REPO + '/dispatches', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + p.GITHUB_TOKEN, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: eventType, client_payload: payload }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('GitHub dispatch failed: ' + res.getResponseCode());
}

/* Cards callback: {callback_secret, kind:'cards', style, chat_id, count, done, files:[{name,caption,b64}]} */
function handleCardsCallback_(body, p) {
  const f = IMAGE_FOLDERS[body.style];
  if (!f) return ok_();
  const folder = DriveApp.getFolderById(f.id);
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('BibleManna');
  const existing = captionSet_(sheet);
  const doneNames = doneNameSet_();
  const rows = [];
  let added = 0, skipped = 0;
  for (const file of body.files) {
    if (existing.has(file.caption) || doneNames.has(file.name)) { skipped++; continue; }
    const created = folder.createFile(Utilities.newBlob(Utilities.base64Decode(file.b64), 'image/jpeg', file.name));
    created.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    rows.push([
      'https://lh3.googleusercontent.com/d/' + created.getId() + '=w1000-h1000',
      file.caption,
      false, '', false, '', false, '',
      Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MMM-yyyy | HH:mm:ss'),
      f.label, false, '', false
    ]);
    added++;
  }
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  if (body.done) {
    tg_(p, 'sendMessage', { chat_id: body.chat_id,
      text: 'Cards done: ' + added + ' added to queue' + (skipped ? ' (' + skipped + ' duplicates skipped)' : '') + '. Folder: ' + f.label + '. The 12:18/6:18 poster picks them up automatically.' });
  }
  return ok_();
}

/* Videos callback: {callback_secret, kind:'videos', style, chat_id, count, done, files:[{name,fmt:'post'|'story',b64}]} */
function handleVideosCallback_(body, p) {
  const sheet = SpreadsheetApp.openById(SHEET_ID);
  const doneNames = doneNameSet_();
  let added = 0, skipped = 0;
  const rowsByTab = {};
  for (const file of body.files) {
    const key = body.style + '-' + file.fmt;
    const f = VIDEO_FOLDERS[key];
    if (!f) { skipped++; continue; }
    if (doneNames.has(file.name)) { skipped++; continue; }
    const created = DriveApp.getFolderById(f.id)
      .createFile(Utilities.newBlob(Utilities.base64Decode(file.b64), 'video/mp4', file.name));
    created.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    (rowsByTab[f.tab] = rowsByTab[f.tab] || []).push([
      'https://drive.google.com/uc?export=download&id=' + created.getId() + '&confirm=t',
      file.name.replace(/\.mp4$/i, ''),
      Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MMM-yyyy | HH:mm:ss'),
      f.label,
      false, '', false, '', false, '', false, ''
    ]);
    added++;
  }
  for (const tab of Object.keys(rowsByTab)) {
    const s = sheet.getSheetByName(tab);
    const rows = rowsByTab[tab];
    s.getRange(s.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  if (body.done) {
    tg_(p, 'sendMessage', { chat_id: body.chat_id,
      text: 'Videos done: ' + added + ' added to queue' + (skipped ? ' (' + skipped + ' duplicates skipped)' : '') + '.' });
  }
  return ok_();
}

function captionSet_(sheet) {
  const vals = sheet.getDataRange().getValues();
  const s = new Set();
  for (let i = 1; i < vals.length; i++) if (vals[i][1]) s.add(String(vals[i][1]));
  return s;
}

function doneNameSet_() {
  const s = new Set();
  const it = DriveApp.getFolderById(DONE_FOLDER).getFiles();
  while (it.hasNext()) s.add(it.next().getName());
  return s;
}

function tg_(p, method, payload) {
  if (String(p.MODE) !== 'LIVE') return; // hard OFF guard: no Telegram side effects
  UrlFetchApp.fetch('https://api.telegram.org/bot' + p.BOT_TOKEN + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
  });
}

/* HtmlService on purpose: ContentService text replies surface to Telegram as a
 * 302 ("Wrong response from webhook: 302 Moved Temporarily") and cause endless
 * retries. An HTML 200 reply is what Telegram accepts cleanly. */
/* Manual editor-run verification helper. Reads bot identity and current webhook
 * WITHOUT changing anything; results land in non-secret Script Property readouts.
 * Never logs or stores the token, and strips any query string from a found
 * webhook URL in case a previous owner embedded a secret in it. */
function setupBot() {
  const p = CFG();
  if (!p.BOT_TOKEN) throw new Error('BOT_TOKEN script property missing');
  const get = (m) => JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + p.BOT_TOKEN + '/' + m, { muteHttpExceptions: true }).getContentText());
  const me = get('getMe');
  const wh = get('getWebhookInfo');
  const sp = PropertiesService.getScriptProperties();
  sp.setProperty('BOT_CHECKED_AT', new Date().toISOString());
  sp.setProperty('BOT_IDENTITY', me.ok ? ('@' + me.result.username + ' id=' + me.result.id) : ('ERROR ' + (me.description || 'unknown')));
  let state = 'ERROR ' + ((wh && wh.description) || 'unknown');
  if (wh.ok) {
    state = wh.result.url ? ('SET ' + String(wh.result.url).split('?')[0]) : 'none';
    state += ' pending=' + (wh.result.pending_update_count || 0);
  }
  sp.setProperty('BOT_WEBHOOK_STATE', state);
}

/* DEMO-ONLY: save rendered callback files to the separate demo Output folder.
 * Runs only in the OFF callback branch and only when DEMO_OUTPUT_FOLDER_ID is
 * set. Never touches production folders, the sheet, sharing, or Telegram. */
function demoSave_(body, p, spOff) {
  const folder = DriveApp.getFolderById(p.DEMO_OUTPUT_FOLDER_ID);
  let saved = 0;
  for (const f of body.files) {
    const mime = f.fmt ? 'video/mp4' : 'image/jpeg';
    folder.createFile(Utilities.newBlob(Utilities.base64Decode(f.b64), mime, f.name));
    saved++;
  }
  spOff.setProperty('OFF_LAST_DEMO', new Date().toISOString() + ' saved=' + saved + ' kind=' + (body.kind || 'cards') + ' names=' + body.files.map(f => f.name).join(',').slice(0, 150));
}

/* Manual editor-run demo setup: creates the separate demo folders at Drive
 * root and stores their IDs in Script Properties. Nothing else is changed. */
function setupDemo() {
  const sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('DEMO_OUTPUT_FOLDER_ID')) {
    sp.setProperty('DEMO_OUTPUT_FOLDER_ID', DriveApp.createFolder('BibleManna Auto - Output').getId());
  }
  if (!sp.getProperty('DEMO_VIDEO_INPUT_FOLDER_ID')) {
    sp.setProperty('DEMO_VIDEO_INPUT_FOLDER_ID', DriveApp.createFolder('BibleManna Auto - Video Input').getId());
  }
  sp.setProperty('DEMO_SETUP_AT', new Date().toISOString());
}

/* One-property, secret-free intake readout: lets OFF probes prove the gate
 * distinguished accepted from rejected without any Telegram/GitHub effect. */
function markIntake_(s) {
  PropertiesService.getScriptProperties().setProperty('OFF_LAST_INTAKE', new Date().toISOString() + ' ' + s);
}

function ok_() {
  return HtmlService.createHtmlOutput('ok');
}

/* Manual editor-run OFF intake self-test. Calls doPost IN-PROCESS with synthetic
 * Telegram update events (UrlFetchApp from GAS to script.google.com gets a 401
 * interstitial, so HTTP self-probing is impossible from here; the /exec transport
 * itself is already proven by the GitHub-Actions callbacks). Secrets are read from
 * Script Properties and never logged. The hard OFF guard makes even an ACCEPTED
 * owner command side-effect-free: no Telegram reply, no GitHub dispatch - only the
 * secret-free OFF_LAST_INTAKE readout changes, which is what each case asserts.
 * Cleans LAST_UPDATE_ID and VIDEO_BATCH afterwards so a future live webhook is
 * unaffected. */
function offSelfTest() {
  const p = CFG();
  const sp = PropertiesService.getScriptProperties();
  const readout = () => (sp.getProperty('OFF_LAST_INTAKE') || '(unset)').replace(/^\S+ /, '');
  const owner = Number(p.OWNER_CHAT_ID);
  const ev = (id, fromId, text, secret) => ({
    postData: { contents: JSON.stringify({ update_id: id, message: { from: { id: fromId }, chat: { id: fromId }, text: text } }) },
    parameter: secret === null ? {} : { secret: secret }
  });
  const out = {};
  try {
    sp.deleteProperty('OFF_LAST_INTAKE');
    doPost(ev(910001, owner, '/verse_cards x', 'WRONG-SECRET'));
    out.t1_wrong_secret = readout();
    doPost(ev(910002, owner, '/verse_cards x', null));
    out.t2_no_secret = readout();
    doPost(ev(910003, 111, '/verse_cards x', p.WEBHOOK_SECRET));
    out.t3_non_owner = readout();
    doPost(ev(910004, owner, 'hello, no command', p.WEBHOOK_SECRET));
    out.t4_owner_noncommand = readout();
    doPost(ev(910005, owner, '/verse_cards body line\nref line', p.WEBHOOK_SECRET));
    out.t5_owner_command = readout();
    doPost(ev(910005, owner, '/verse_cards body line\nref line', p.WEBHOOK_SECRET));
    out.t6_redelivery = readout();
    out.mode = String(p.MODE);
    out.expect = 't1/t2 rejected=secret | t3 rejected=non_owner | t4 accepted cmd=none | t5 accepted cmd=cards suppressed_OFF | t6 rejected=redelivery';
  } finally {
    sp.deleteProperty('LAST_UPDATE_ID');
    sp.deleteProperty('VIDEO_BATCH');
  }
  sp.setProperty('OFF_SELFTEST', new Date().toISOString() + ' ' + JSON.stringify(out));
}
