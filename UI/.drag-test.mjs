// Standalone test: uses puppeteer-core + system Chrome to test drag.
// No Electron needed.
import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI = __dirname;
const OUT = path.join(UI, '.drag-test');
const log = (...a) => console.log('[drag-test]', ...a);

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  // Drive puppeteer-core against the same Vite URL.
  // (Electron's renderer is the same Chromium with the same React/dnd-kit code;
  // we've already proved the modifier fix, now we re-verify in a clean run.)
  log('Launching puppeteer Chrome against http://localhost:3000');
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + path.join(OUT, '.chrome-profile'),
      ],
      defaultViewport: { width: 1280, height: 800 },
    });
  const p = await browser.newPage();
  p.on('console', (msg) => log('PAGE:', msg.text()));
  p.on('pageerror', (err) => log('PAGE-ERROR:', err.message));

  await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('Page loaded:', p.url());

  await p.waitForSelector('.sf-history-card', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2000));

  const startInfo = await p.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.sf-history-card'));
    const idx = Math.min(2, Math.max(0, cards.length - 1));
    const card = cards[idx];
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      w: r.width,
      h: r.height,
      cardText: card.textContent ? card.textContent.slice(0, 40) : '',
    };
  });
  log('startInfo:', startInfo);
  if (!startInfo) throw new Error('no card found');

  await p.screenshot({ path: path.join(OUT, '01-before.png') });

  await p.evaluate(() => {
    if (window.__dragDebug) {
      window.__dragDebug.active = false;
      window.__dragDebug.samples = [];
    }
  });

  log('mouse down at', startInfo.x, startInfo.y);
  await p.mouse.move(startInfo.x, startInfo.y);
  await p.mouse.down();
  await new Promise((r) => setTimeout(r, 60));

  await p.mouse.move(startInfo.x + 5, startInfo.y + 5, { steps: 1 });
  await new Promise((r) => setTimeout(r, 150));

  const moves = [
    { dx: 30, dy: 10 },
    { dx: 80, dy: 40 },
    { dx: 150, dy: 90 },
    { dx: 250, dy: 180 },
    { dx: 400, dy: 300 },
  ];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    await p.mouse.move(startInfo.x + m.dx, startInfo.y + m.dy, { steps: 10 });
    await new Promise((r) => setTimeout(r, 80));
    const snap = await p.evaluate(() => {
      if (!window.__dragDebug) return { count: 0, last: null, debug: 'no __dragDebug' };
      const samples = window.__dragDebug.samples;
      const last = samples[samples.length - 1];
      return { count: samples.length, last };
    });
    const mx = startInfo.x + m.dx;
    const my = startInfo.y + m.dy;
    log(`step ${i} mouse(${mx.toFixed(0)},${my.toFixed(0)}) samples=${snap.count}`);
    if (snap.last) {
      const s = snap.last;
      log(`  OUTER style="${(s.outer.style || '').slice(0, 160)}"`);
      log(`  OUTER rect=(${s.outer.rect.x},${s.outer.rect.y} ${s.outer.rect.w}x${s.outer.rect.h})`);
      if (s.inner) {
        log(`  INNER style="${(s.inner.style || '').slice(0, 100)}"`);
        log(`  INNER rect=(${s.inner.rect.x},${s.inner.rect.y} ${s.inner.rect.w}x${s.inner.rect.h})`);
      }
      if (s.lifted) {
        log(`  LIFTED rect=(${s.lifted.rect.x},${s.lifted.rect.y} ${s.lifted.rect.w}x${s.lifted.rect.h})`);
      }
    }
    await p.screenshot({ path: path.join(OUT, `02-step-${i}.png`) });
  }

  log('mouse up');
  await p.mouse.up();
  await new Promise((r) => setTimeout(r, 1000));

  const all = await p.evaluate(() => ({
    samples: window.__dragDebug ? window.__dragDebug.samples : [],
    active: window.__dragDebug ? window.__dragDebug.active : false,
  }));
  log('Total samples:', all.samples.length);
  fs.writeFileSync(path.join(OUT, 'samples.json'), JSON.stringify(all.samples, null, 2));

  if (all.samples.length > 2) {
    const first = all.samples[2];
    const last = all.samples[all.samples.length - 1];
    log('=== VERDICT ===');
    log('first activated sample:');
    log('  mouse=', first.mouse);
    log('  OUTER rect=', first.outer && first.outer.rect);
    log('  OUTER style=', first.outer && (first.outer.style || '').slice(0, 100));
    if (first.outer && first.mouse) {
      const dx = first.outer.rect.x + first.outer.rect.w / 2 - first.mouse.x;
      const dy = first.outer.rect.y + first.outer.rect.h / 2 - first.mouse.y;
      log('  OUTER_center - mouse = (' + dx.toFixed(1) + ', ' + dy.toFixed(1) + ')');
    }
    log('last sample:');
    log('  mouse=', last.mouse);
    log('  OUTER rect=', last.outer && last.outer.rect);
    log('  OUTER style=', last.outer && (last.outer.style || '').slice(0, 100));
    if (last.outer && last.mouse) {
      const dx = last.outer.rect.x + last.outer.rect.w / 2 - last.mouse.x;
      const dy = last.outer.rect.y + last.outer.rect.h / 2 - last.mouse.y;
      log('  OUTER_center - mouse = (' + dx.toFixed(1) + ', ' + dy.toFixed(1) + ')');
    }
  }
  await p.screenshot({ path: path.join(OUT, '03-final.png') });
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});