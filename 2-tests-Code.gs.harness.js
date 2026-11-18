// Node regression harness for router/Code.gs with stubbed Apps Script services.
const fs = require('fs');
const src = fs.readFileSync('/downloads/bm-auto/repo/router/Code.gs', 'utf8');

let store, fetches, driveCalls, sheetCalls, sharingCalls, createdFiles;
let sheets;

function reset(mode) {
  store = {
    BOT_TOKEN: 'tok', OWNER_CHAT_ID: '111', GITHUB_TOKEN: 'ght',
    GITHUB_REPO: 'o/r', CALLBACK_SECRET: 'cbsec', WEBHOOK_SECRET: 'whsec', MODE: mode
  };
  fetches = []; driveCalls = []; sheetCalls = []; sharingCalls = []; createdFiles = [];
  sheets = {
    'BibleManna': { values: [[], ['url', 'existing caption']], name: 'BibleManna' },
    'Verse Video': { values: [[]], name: 'Verse Video' },
    'Story Video': { values: [[]], name: 'Story Video' }
  };
}

const PropertiesService = { getScriptProperties: () => ({
  getProperty: k => (k in store ? store[k] : null),
  setProperty: (k, v) => { store[k] = String(v); },
  getProperties: () => ({ ...store }),
  deleteProperty: k => { delete store[k]; }
})};
const UrlFetchApp = { fetch: (url, opts) => { fetches.push({ url, opts }); return { getResponseCode: () => 204 }; } };
function makeSheet(sh) {
  return {
    getDataRange: () => ({ getValues: () => sh.values }),
    getLastRow: () => sh.values.length,
    getRange: (r, c, nr, nc) => ({ setValues: rows => { sheetCalls.push({ tab: sh.name, rows }); for (const row of rows) sh.values.push(row); } })
  };
}
const SpreadsheetApp = { openById: () => ({ getSheetByName: n => sheets[n] ? makeSheet(sheets[n]) : null }) };
function makeFolder(id) {
  return {
    createFile: blob => {
      const file = { id: 'fileid-' + (createdFiles.length + 1), name: blob.name,
        getId() { return this.id; },
        setSharing: (a, p) => { sharingCalls.push({ name: blob.name, a, p }); } };
      createdFiles.push({ folderId: id, name: blob.name, mime: blob.mime, bytes: blob.bytes.length });
      driveCalls.push({ op: 'createFile', folderId: id, name: blob.name });
      return file;
    },
    getFiles: () => { const names = ['already-done.mp4', 'done-card.jpeg']; let i = 0;
      return { hasNext: () => i < names.length, next: () => ({ getName: () => names[i++] }) }; }
  };
}
const DriveApp = { getFolderById: makeFolder, Access: { ANYONE_WITH_LINK: 'AWL' }, Permission: { VIEW: 'V' } };
const Utilities = {
  newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
  base64Decode: s => Buffer.from(s, 'base64'),
  formatDate: () => '18-Nov-2026 | 12:00:00'
};
const HtmlService = { createHtmlOutput: t => ({ html: t }) };

const load = () => new Function('PropertiesService', 'UrlFetchApp', 'DriveApp', 'SpreadsheetApp',
  'Utilities', 'HtmlService', src + '\nreturn { doPost, doGet, tick, parseRawList_, cardsToListText_, rawAppend_, rawLoad_, rawExpire_, rawMeta_ };')(
  PropertiesService, UrlFetchApp, DriveApp, SpreadsheetApp, Utilities, HtmlService);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
const tgUpdate = (id, fromId, text, doc) => ({ update_id: id, message: { from: { id: fromId }, chat: { id: 111 }, text, document: doc } });
const post = (body, params) => ({ postData: { contents: JSON.stringify(body) }, parameter: params || {} });
const noSecretsLeaked = () => fetches.every(f => !f.url.includes('whsec') && !f.url.includes('cbsec') &&
  !(f.opts && f.opts.payload && (f.opts.payload.includes('whsec') || f.opts.payload.includes('cbsec'))));

// 1. wrong webhook secret: dropped, nothing happens
reset('LIVE');
let app = load();
app.doPost(post(tgUpdate(100, 111, '/verse_cards x'), { secret: 'wrong' }));
check('wrong webhook secret dropped', fetches.length === 0);

// 2. non-owner: dropped silently
reset('LIVE'); app = load();
app.doPost(post(tgUpdate(100, 999, '/verse_cards x'), { secret: 'whsec' }));
check('non-owner dropped silently', fetches.length === 0);

// 3. owner /verse_cards dispatches render-cards
reset('LIVE'); app = load();
app.doPost(post(tgUpdate(100, 111, '/verse_cards Line one. Psalm 24:1'), { secret: 'whsec' }));
const disp = fetches.find(f => f.url.includes('api.github.com'));
check('render-cards dispatched', !!disp && JSON.parse(disp.opts.payload).event_type === 'render-cards');
check('dispatch style black + list text', disp && JSON.parse(disp.opts.payload).client_payload.style === 'black' &&
  JSON.parse(disp.opts.payload).client_payload.list_text.includes('Psalm 24:1'));
check('ack sent to owner chat', fetches.some(f => f.url.includes('api.telegram.org') && f.opts.payload.includes('"chat_id":"111"')));

// 4. replay same update_id: no second dispatch
app.doPost(post(tgUpdate(100, 111, '/verse_cards Line one. Psalm 24:1'), { secret: 'whsec' }));
check('update_id replay ignored', fetches.filter(f => f.url.includes('api.github.com')).length === 1);
// 5. older update_id ignored
app.doPost(post(tgUpdate(99, 111, '/verse_cards again'), { secret: 'whsec' }));
check('older update_id ignored', fetches.filter(f => f.url.includes('api.github.com')).length === 1);
// 6. newer update_id accepted
app.doPost(post(tgUpdate(101, 111, '/verse_cards more'), { secret: 'whsec' }));
check('newer update_id accepted', fetches.filter(f => f.url.includes('api.github.com')).length === 2);

// 7. wrong callback secret: nothing happens
reset('LIVE'); app = load();
app.doPost(post({ callback_secret: 'nope', kind: 'cards', style: 'black', chat_id: '111', count: 1, done: true,
  files: [{ name: 'n.jpeg', caption: 'cap', b64: 'AA==' }] }));
check('wrong callback secret dropped', fetches.length === 0 && driveCalls.length === 0 && sheetCalls.length === 0);

// 8. OFF mode callback: count-only, zero writes, zero Telegram/GitHub side effects (hard guard)
reset('OFF'); app = load();
app.doPost(post({ callback_secret: 'cbsec', kind: 'cards', style: 'black', chat_id: '111', count: 2, done: true,
  files: [{ name: 'a.jpeg', caption: 'cap a', b64: 'AA==' }, { name: 'b.jpeg', caption: 'cap b', b64: 'AA==' }] }));
check('OFF mode: no Drive writes', driveCalls.length === 0);
check('OFF mode: no sheet writes', sheetCalls.length === 0);
check('OFF mode: no sharing changes', sharingCalls.length === 0);
check('OFF mode: hard guard - NO Telegram calls at all', !fetches.some(f => f.url.includes('api.telegram.org')));
check('OFF mode: hard guard - NO GitHub dispatch', !fetches.some(f => f.url.includes('api.github.com')));

// 8b. OFF intake: gates still classify, side effects suppressed, readouts prove accepted vs rejected
reset('OFF'); app = load();
app.doPost(post(tgUpdate(200, 111, '/verse_cards x'), { secret: 'wrong' }));
check('OFF intake wrong secret readout', (store.OFF_LAST_INTAKE || '').includes('rejected=secret'));
app.doPost(post(tgUpdate(201, 999, '/verse_cards x'), { secret: 'whsec' }));
check('OFF intake non-owner readout', (store.OFF_LAST_INTAKE || '').includes('rejected=non_owner'));
app.doPost(post(tgUpdate(202, 111, 'hello there'), { secret: 'whsec' }));
check('OFF intake owner non-command readout', (store.OFF_LAST_INTAKE || '').includes('accepted cmd=none'));
app.doPost(post(tgUpdate(203, 111, '/verse_cards Line one. Psalm 24:1'), { secret: 'whsec' }));
check('OFF intake command accepted but suppressed', (store.OFF_LAST_INTAKE || '').includes('accepted cmd=cards') && (store.OFF_LAST_INTAKE || '').includes('suppressed_OFF'));
check('OFF intake: zero fetches across all four probes', fetches.length === 0);
app.doPost(post(tgUpdate(203, 111, '/verse_cards Line one. Psalm 24:1'), { secret: 'whsec' }));
check('OFF intake redelivery readout', (store.OFF_LAST_INTAKE || '').includes('rejected=redelivery'));

// 8c. LIVE intake still works with guard in place (guard only blocks MODE!=LIVE)
reset('LIVE'); app = load();
app.doPost(post(tgUpdate(300, 111, '/verse_cards Line one. Psalm 24:1'), { secret: 'whsec' }));
check('LIVE intake still dispatches + acks', fetches.some(f => f.url.includes('api.github.com')) && fetches.some(f => f.url.includes('api.telegram.org')));
check('LIVE intake readout effects=sent', (store.OFF_LAST_INTAKE || '').includes('effects=sent'));

// 8d. OFF demo: callback with DEMO_OUTPUT_FOLDER_ID saves to demo folder only
reset('OFF'); app = load();
store.DEMO_OUTPUT_FOLDER_ID = 'demo-folder';
app.doPost(post({ callback_secret: 'cbsec', kind: 'cards', style: 'black', chat_id: '111', count: 1, done: true,
  files: [{ name: 'demo-card.jpeg', caption: 'cap', b64: 'AA==' }] }));
check('demo: file saved to demo folder', createdFiles.length === 1 && createdFiles[0].folderId === 'demo-folder');
check('demo: no sharing set', sharingCalls.length === 0);
check('demo: no sheet rows', sheetCalls.length === 0);
check('demo: no fetches (TG/GitHub suppressed)', fetches.length === 0);
check('demo: OFF_LAST_DEMO readout', (store.OFF_LAST_DEMO || '').includes('saved=1') && (store.OFF_LAST_DEMO || '').includes('demo-card.jpeg'));

// 8e. OFF callback WITHOUT demo flag: count-only, nothing saved
reset('OFF'); app = load();
app.doPost(post({ callback_secret: 'cbsec', kind: 'cards', style: 'black', chat_id: '111', count: 1, done: true,
  files: [{ name: 'x.jpeg', caption: 'cap', b64: 'AA==' }] }));
check('no demo flag: nothing saved', createdFiles.length === 0 && driveCalls.length === 0);

// 9. LIVE cards callback with dedupe: existing caption + done-name skipped, 1 new
reset('LIVE'); app = load();
app.doPost(post({ callback_secret: 'cbsec', kind: 'cards', style: 'black', chat_id: '111', count: 3, done: true, files: [
  { name: 'dup1.jpeg', caption: 'existing caption', b64: 'AA==' },
  { name: 'done-card.jpeg', caption: 'some caption', b64: 'AA==' },
  { name: 'new-card.jpeg', caption: 'brand new caption', b64: Buffer.from('jpegdata').toString('base64') }
] }));
check('dedupe: only 1 file created', createdFiles.length === 1 && createdFiles[0].name === 'new-card.jpeg');
check('created in black folder', createdFiles[0] && createdFiles[0].folderId === '1xCZFm15btt2vljTjUTuReEnApp-l1miH');
check('sharing set anyone-with-link view', sharingCalls.length === 1 && sharingCalls[0].a === 'AWL' && sharingCalls[0].p === 'V');
check('one 13-col row appended to BibleManna', sheetCalls.length === 1 && sheetCalls[0].tab === 'BibleManna' && sheetCalls[0].rows[0].length === 13);
check('row has lh3 url + caption + label', sheetCalls[0].rows[0][0].startsWith('https://lh3.googleusercontent.com/d/fileid-') &&
  sheetCalls[0].rows[0][1] === 'brand new caption' && sheetCalls[0].rows[0][9] === 'Bible Images');
check('TG done summary mentions skip', fetches.some(f => f.opts.payload && f.opts.payload.includes('duplicates skipped')));

// 10. LIVE videos callback: folder + tab routing
reset('LIVE'); app = load();
app.doPost(post({ callback_secret: 'cbsec', kind: 'videos', style: 'white', chat_id: '111', count: 2, done: true, files: [
  { name: 'v1.mp4', fmt: 'post', b64: Buffer.from('mp4post').toString('base64') },
  { name: 'v1.mp4', fmt: 'story', b64: Buffer.from('mp4story').toString('base64') }
] }));
check('videos: 2 created, right folders', createdFiles.length === 2 &&
  createdFiles[0].folderId === '1qTb0z6LjIejtHSchW6QyDFtOl3Qfiwkq' && createdFiles[1].folderId === '1EkyXCCVZNRc89YgFfe4KZv5nqv_q50OD');
check('videos: rows to both tabs, 12 cols', sheetCalls.length === 2 &&
  sheetCalls.every(s => s.rows[0].length === 12) &&
  sheetCalls.some(s => s.tab === 'Verse Video') && sheetCalls.some(s => s.tab === 'Story Video'));
check('videos: uc export links', sheetCalls.every(s => s.rows[0][0].startsWith('https://drive.google.com/uc?export=download&id=')));

// 11. video batch flow: /biblemanna_video -> documents -> /go -> dispatch
reset('LIVE'); app = load();
app.doPost(post(tgUpdate(200, 111, '/biblemanna_video'), { secret: 'whsec' }));
app.doPost(post(tgUpdate(201, 111, undefined, { file_name: 'song.mp3', file_id: 'aud1' }), { secret: 'whsec' }));
app.doPost(post(tgUpdate(202, 111, undefined, { file_name: 'img.png', file_id: 'img1' }), { secret: 'whsec' }));
app.doPost(post(tgUpdate(203, 111, '/go'), { secret: 'whsec' }));
const vdisp = fetches.filter(f => f.url.includes('api.github.com'));
check('video batch dispatched', vdisp.length === 1 && JSON.parse(vdisp[0].opts.payload).event_type === 'render-videos');
const job = vdisp.length && JSON.parse(JSON.parse(vdisp[0].opts.payload).client_payload.job);
check('job carries ids + style', job && job.images[0] === 'img1' && job.audios[0] === 'aud1' && job.style === 'black' && job.chat_id === '111');

// 12. tick(): fresh batch untouched, stale batch closed
reset('LIVE'); app = load();
app.doPost(post(tgUpdate(300, 111, '/biblemanna_video'), { secret: 'whsec' }));
app.doPost(post(tgUpdate(301, 111, undefined, { file_name: 'a.mp3', file_id: 'a1' }), { secret: 'whsec' }));
app.doPost(post(tgUpdate(302, 111, undefined, { file_name: 'i.png', file_id: 'i1' }), { secret: 'whsec' }));
app.tick();
check('tick leaves fresh batch open', fetches.filter(f => f.url.includes('api.github.com')).length === 0);
store.VIDEO_BATCH = JSON.stringify({ images: ['i1'], audios: ['a1'], style: 'black', chat_id: '111', ts: Date.now() - 61000 });
app.tick();
check('tick auto-closes stale batch', fetches.filter(f => f.url.includes('api.github.com')).length === 1);

// 13. secrets never appear in any outgoing fetch URL or payload
check('secrets never logged/forwarded in fetches', noSecretsLeaked());

// 14. raw-list parser: real user batches (verse/black and quotes/white)
const batch1 = JSON.parse(fs.readFileSync('/tmp/batch1.json', 'utf8')).rows[0][0];
const batch2 = JSON.parse(fs.readFileSync('/tmp/batch2.json', 'utf8')).rows[0][0];
reset('OFF'); app = load();
const p1 = app.parseRawList_(batch1);
check('verse batch parses', !!p1 && p1.style === 'black');
check('verse batch count from parsed original', p1 && p1.cards.length === 101, p1 && p1.cards.length);
check('verse card 1 verbatim', p1 && p1.cards[0].body.startsWith('You shall remember the LORD your GOD') && p1.cards[0].ref === 'Deuteronomy 8:18');
check('verse card 101 ref', p1 && p1.cards[100].ref.length > 0 && /\d+:\d+/.test(p1.cards[100].ref), p1 && p1.cards[100].ref);
const p2 = app.parseRawList_(batch2);
check('quotes batch parses', !!p2 && p2.style === 'white');
check('quotes batch count from parsed original', p2 && p2.cards.length === 101, p2 && p2.cards.length);
check('quotes card 1 verbatim + attribution kept', p2 && p2.cards[0].body === 'I am teaching you to trust Me with what you cannot control' && p2.cards[0].ref === '-GOD');
check('quotes attributions only GOD/JESUS/LORD/CHRIST', p2 && p2.cards.every(c => /^-(GOD|JESUS|LORD|CHRIST)$/.test(c.ref)));

// 15. fragment safety: char-boundary splits (incl. mid-line) reassemble identically
const cuts = [4000, 8000];
const frags = [batch1.slice(0, cuts[0]), batch1.slice(cuts[0], cuts[1]), batch1.slice(cuts[1])];
const p1j = app.parseRawList_(frags.join(''));
check('mid-line split reassembles exactly', JSON.stringify(p1j) === JSON.stringify(p1));
const frags2 = [batch2.slice(0, 3333), batch2.slice(3333)];
check('quotes split reassembles exactly', JSON.stringify(app.parseRawList_(frags2.join(''))) === JSON.stringify(p2));

// 16. parser rejects non-lists and incomplete input instead of guessing
check('greeting is not a list', app.parseRawList_('hello there') === null);
check('bullet without ref rejected', app.parseRawList_(' * body line\n') === null);
check('attribution without body rejected', app.parseRawList_('-GOD') === null);

// 17. intake batching OFF: fragments buffered, nothing rendered until done, close suppressed
reset('OFF'); app = load();
app.doPost(post(tgUpdate(400, 111, frags[0]), { secret: 'whsec' }));
check('fragment 1 buffered', (store.OFF_LAST_INTAKE || '').includes('cmd=raw_fragment n=1') && !!store.RAW_BATCH_META);
check('fragment 1 renders nothing', fetches.filter(f => f.url.includes('api.github.com')).length === 0);
app.doPost(post(tgUpdate(401, 111, frags[1]), { secret: 'whsec' }));
app.doPost(post(tgUpdate(402, 111, frags[2]), { secret: 'whsec' }));
check('all 3 fragments buffered', (store.OFF_LAST_INTAKE || '').includes('cmd=raw_fragment n=3'));
check('full 11.6k batch chunked across properties', JSON.parse(store.RAW_BATCH_META).n >= 2 &&
  JSON.parse(store.RAW_BATCH_META).chars === batch1.length);
app.doPost(post(tgUpdate(403, 111, 'done'), { secret: 'whsec' }));
check('OFF close: parsed 101, suppressed, buffer cleared',
  (store.OFF_LAST_INTAKE || '').includes('cmd=raw_close style=black count=101 effects=suppressed_OFF') && !store.RAW_BATCH_META);
check('OFF close: no dispatch, no TG sends', fetches.length === 0);

// 17b. chunked storage round-trips both real batches byte-exactly
reset('OFF'); app = load();
const spStub = PropertiesService.getScriptProperties();
frags.forEach(f => app.rawAppend_(spStub, f, '111'));
check('verse batch chunked round-trip byte-exact', app.rawLoad_(spStub).text === batch1);
reset('OFF'); app = load();
const sp2 = PropertiesService.getScriptProperties();
frags2.forEach(f => app.rawAppend_(sp2, f, '111'));
check('quotes batch chunked round-trip byte-exact', app.rawLoad_(sp2).text === batch2);

// 18. intake batching LIVE: one dispatch, minimal acks, canonical list_text round-trips
reset('LIVE'); app = load();
app.doPost(post(tgUpdate(500, 111, frags[0]), { secret: 'whsec' }));
app.doPost(post(tgUpdate(501, 111, frags[1]), { secret: 'whsec' }));
app.doPost(post(tgUpdate(502, 111, frags[2]), { secret: 'whsec' }));
app.doPost(post(tgUpdate(503, 111, 'done'), { secret: 'whsec' }));
const cdisp = fetches.filter(f => f.url.includes('api.github.com'));
check('LIVE close: exactly one render-cards dispatch', cdisp.length === 1 && JSON.parse(cdisp[0].opts.payload).event_type === 'render-cards');
const cp = cdisp.length && JSON.parse(cdisp[0].opts.payload).client_payload;
check('dispatch style black, chat carried', cp && cp.style === 'black' && cp.chat_id === '111');
const round = cp && cp.list_text.split('\n\n').map(chunk => { const p = chunk.split('\n'); return { body: p[0], ref: p[1] }; });
check('canonical list_text round-trips to same 101 cards', JSON.stringify(round) === JSON.stringify(p1.cards));
check('LIVE: only first-fragment ack + render notice', fetches.filter(f => f.url.includes('sendMessage')).length === 2);

// 19. done with no open batch is a no-op; expiry preserves data and tells the user
reset('LIVE'); app = load();
app.doPost(post(tgUpdate(600, 111, 'done'), { secret: 'whsec' }));
check('done without batch = cmd=none, no effects', (store.OFF_LAST_INTAKE || '').includes('cmd=none') && fetches.length === 0);
app.rawAppend_(PropertiesService.getScriptProperties(), ' * old body\n   Old 1:1\n', '111');
store.RAW_BATCH_META = JSON.stringify({ n: 1, chars: 23, parts: 1, ts: Date.now() - 31 * 60 * 1000, chat_id: '111' });
app.doPost(post(tgUpdate(601, 111, 'done'), { secret: 'whsec' }));
check('expired batch not rendered, reported', (store.OFF_LAST_INTAKE || '').includes('cmd=none expired_parts=1') &&
  fetches.filter(f => f.url.includes('api.github.com')).length === 0);
check('expiry readout + fragments preserved', !!store.RAW_EXPIRED && (store.RAW_EXPIRED_0 || '').includes('old body'));
check('user told about expiry', fetches.some(f => f.url.includes('sendMessage') && f.opts.payload.includes('set aside')));
app.doPost(post(tgUpdate(602, 111, ' * incomplete body with no ref line'), { secret: 'whsec' }));
check('fresh fragment after expiry is n=1', (store.OFF_LAST_INTAKE || '').includes('cmd=raw_fragment n=1'));
app.doPost(post(tgUpdate(603, 111, 'done'), { secret: 'whsec' }));
check('incomplete close = rejected=parse, no dispatch', (store.OFF_LAST_INTAKE || '').includes('rejected=parse') &&
  fetches.filter(f => f.url.includes('api.github.com')).length === 0);

// 20. strict rejection of merged lines from manual splits
reset('OFF'); app = load();
check('ref containing bullet char rejected', app.parseRawList_(' * body\n   Psalm 24:1 * merged next body') === null);
check('ref without chapter:verse rejected', app.parseRawList_(' * body\n   not a ref') === null);
check('merged body+attribution rejected', app.parseRawList_('Some quote body text here-GOD\n\nNext quote\n-LORD') === null);
check('no secret leakage across raw-list tests', noSecretsLeaked());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
