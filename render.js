const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
(async () => {
  const text = fs.readFileSync(process.argv[2], 'utf8');
  const outDir = process.argv[3];
  const bg = process.argv[4];
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--force-color-profile=srgb']
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  const path = require('path');
  await page.goto('file://' + path.resolve(process.env.TOOL_HTML || 'biblemanna-carousel.html'), { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 1500));
  const n = await page.evaluate((text, bg) => {
    const ps = getCurPS();
    const ta = document.getElementById('specsText');
    ta.value = text; ps.specsText = text;
    setThreadBg(bg);
    ps.igOverlayOn = false;
    const ig = document.getElementById('igOverlayOn'); if (ig) ig.checked = false;
    ps.specsSplitEnabled = true;
    const cb = document.getElementById('splitEnabled'); if (cb) cb.checked = true;
    autoSplitByVerse();
    return _getCardTexts(ps.specsText).filter(c => c.trim()).length;
  }, text, bg);
  console.log('cards:', n);
  await new Promise(r => setTimeout(r, 2500));
  for (let i = 0; i < n; i++) {
    const res = await page.evaluate(async (i) => {
      const ps = getCurPS();
      const cards = _getCardTexts(ps.specsText).filter(c => c.trim());
      let du = await _renderSplitCard(cards[i], _cardImgIdx(ps, i), 'image/jpeg', i);
      // Deterministic BibleManna watermark (replicates _renderSplitCard's intended wm block)
      const im = new Image();
      await new Promise(r => { im.onload = r; im.src = du; });
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const cx = cv.getContext('2d'); cx.drawImage(im, 0, 0);
      const W = cv.width;
      const fs2 = 60;
      const m = document.createElement('canvas').getContext('2d');
      m.font = `900 ${fs2}px 'Poppins',sans-serif`;
      const tw2 = Math.ceil(m.measureText('BibleManna').width);
      const oc2 = document.createElement('canvas'); oc2.width = tw2 + 20; oc2.height = fs2 + 20;
      const ox2 = oc2.getContext('2d');
      // pick color from target area luminance like the tool does
      const sz = Math.min(ps.wmSz || 200, W * 0.35);
      const aspect = (tw2 + 20) / (fs2 + 20);
      const ww = sz, wh = Math.round(sz / aspect), margin = 28;
      const wx = W - ww - margin, wy = margin;
      const px = cx.getImageData(Math.max(0, wx), Math.max(0, wy), 4, 4).data;
      const avg = (px[0] + px[1] + px[2]) / 3;
      const col = avg < 128 ? '#ffffff' : '#000000';
      ox2.font = `900 ${fs2}px 'Poppins',sans-serif`;
      ox2.fillStyle = col; ox2.textBaseline = 'top';
      ox2.fillText('BibleManna', 10, 8);
      const ti = new Image();
      await new Promise(r => { ti.onload = r; ti.src = oc2.toDataURL('image/png'); });
      cx.globalAlpha = (ps.wmOp || 38) / 100;
      cx.drawImage(ti, wx, wy, ww, wh);
      cx.globalAlpha = 1;
      return { name: _safeFilename(cards[i], 'full') + '.jpeg', data: cv.toDataURL('image/jpeg', 1.0) };
    }, i);
    fs.writeFileSync(path.join(outDir, res.name), Buffer.from(res.data.split(',')[1], 'base64'));
    if ((i + 1) % 25 === 0 || i === n - 1) console.log('rendered', i + 1, '/', n);
  }
  await browser.close();
  console.log('DONE', n);
})().catch(e => { console.error(e); process.exit(1); });
