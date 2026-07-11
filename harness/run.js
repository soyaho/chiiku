#!/usr/bin/env node
'use strict';
/*
 * てんびん E2E 検証ハーネス（v0.4: 自由遊び・ラウンド制）
 *
 * 実インターフェース主義: 操作は canvas への実マウスイベント（タッチのフォールバック経路）
 * のみで行い、内部状態 window.__tenbin は「読み取り」だけに使う（docs/test-hooks.md 参照）。
 * テスト入力の注入は ?seed / ?timescale / ?game の3つのみ。
 * タイトル→メニュー→ゲームの実経路はナビゲーションシナリオが実タップで通し、
 * 個別テストは ?game 直接入場で安定化する。
 *
 * 実行: node harness/run.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---- playwright 解決（グローバル導入をフォールバックで拾う） ----
function requirePlaywright() {
  try { return require('playwright'); } catch (_) {}
  const globalRoot = execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}
const { chromium } = requirePlaywright();

const ROOT = path.resolve(__dirname, '..');
const SEED = 7;
const TIMESCALE = 8;

// ---- ミニテストフレーム ----
const results = [];
let page, ctx, browser, baseURL;

async function test(name, fn, timeoutMs = 120_000) {
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok    ${name} (${Date.now() - started}ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, err: e });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---- ページ状態の読み取りヘルパ（読み取りのみ） ----
async function snap() {
  return page.evaluate(() => {
    const t = window.__tenbin;
    if (!t) return null;
    return {
      screen: t.screen, game: t.game, menuTiles: t.menuTiles, homeButton: t.homeButton,
      phase: t.phase, round: t.round, apples: t.apples, plates: t.plates, mouths: t.mouths,
      balance: t.balance, counts: t.counts,
      orientationBlocked: t.orientationBlocked, menuOpen: t.menuOpen,
      menuRegions: t.menuRegions, celebrationType: t.celebrationType,
      session: t.session, theme: t.theme, bgmEnabled: t.bgmEnabled, hintActive: t.hintActive,
    };
  });
}
async function toClient(x, y) {
  return page.evaluate(([x, y]) => window.__tenbin.toClient(x, y), [x, y]);
}
async function waitFor(fn, desc, timeoutMs = 30_000, intervalMs = 60) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${desc}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
// 実マウスイベントでのドラッグ（論理座標指定）
async function drag(fromL, toL, { steps = 10, settleMs = 120 } = {}) {
  const a = await toClient(fromL.x, fromL.y);
  const b = await toClient(toL.x, toL.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await new Promise(r => setTimeout(r, 60));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
    await new Promise(r => setTimeout(r, 16));
  }
  await new Promise(r => setTimeout(r, settleMs)); // lerp追従の収束待ち
  await page.mouse.up();
}
async function tap(logical) {
  const c = await toClient(logical.x, logical.y);
  await page.mouse.click(c.x, c.y);
}
async function tapRegion(r) {
  return tap({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
}
async function pressHold(logical, holdMs) {
  const c = await toClient(logical.x, logical.y);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await new Promise(r => setTimeout(r, holdMs));
  await page.mouse.up();
}
function readLogs(key = 'tenbin_logs') {
  return page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]'), key);
}
// 静止している自由な果物（field、なければ静止確認済みの ground）を1個返す。無ければ null
async function findFreeFruit() {
  const s = await snap();
  const f = s.apples.find(a => a.state === 'field');
  if (f) return f;
  const g = s.apples.find(a => a.state === 'ground');
  if (!g) return null;
  const settled = await waitFor(async () => {
    const s1 = await snap();
    const a1 = s1.apples.find(x => x.id === g.id);
    if (!a1 || a1.state !== 'ground') return { skip: true };
    await new Promise(r => setTimeout(r, 80));
    const s2 = await snap();
    const a2 = s2.apples.find(x => x.id === g.id);
    if (!a2 || a2.state !== 'ground') return { skip: true };
    return (Math.abs(a2.y - a1.y) < 2 && Math.abs(a2.x - a1.x) < 2) ? a2 : null;
  }, `ground fruit ${g.id} comes to rest`, 15_000);
  if (settled.skip) return findFreeFruit();
  return settled;
}
// 果物1個を皿に載せる（counts の合計が増えるまで待つ）
async function placeOne(apple, plateKey) {
  const before = await snap();
  const total = before.counts.left + before.counts.right;
  const fresh = before.apples.find(a => a.id === apple.id) || apple;
  await drag({ x: fresh.x, y: fresh.y }, before.plates[plateKey]);
  try {
    await waitFor(async () => {
      const s = await snap();
      return s.counts.left + s.counts.right > total;
    }, `fruit ${apple.id} lands on plate ${plateKey}`, 15_000);
  } catch (e) {
    const s = await snap();
    const states = s.apples.map(a => ({ id: a.id, st: a.state, p: a.plate, x: Math.round(a.x), y: Math.round(a.y) }));
    throw new Error(`${e.message} | phase=${s.phase} counts=${s.counts.left}/${s.counts.right} apples=${JSON.stringify(states)}`);
  }
}
// 果物1個を動物に食べさせる（fed カウントが増えるまで待つ）
async function feedOne(apple, side) {
  const before = await snap();
  const fedBefore = before.round[side === 'L' ? 'fedL' : 'fedR'];
  const fresh = before.apples.find(a => a.id === apple.id) || apple;
  await drag({ x: fresh.x, y: fresh.y }, { x: before.mouths[side].x, y: before.mouths[side].y });
  await waitFor(async () => {
    const s = await snap();
    return s.round && s.round[side === 'L' ? 'fedL' : 'fedR'] > fedBefore;
  }, `fruit ${apple.id} eaten by animal ${side}`, 15_000);
}
// 現在のラウンドを完了させる。assign(apple, s) → 'L' | 'R' | 'feedL' | 'feedR'
async function completeRound(assign) {
  for (;;) {
    const s = await snap();
    if (s.phase !== 'play') break;
    const free = await findFreeFruit();
    if (!free) break;
    const what = assign(free, await snap());
    if (what === 'feedL' || what === 'feedR') await feedOne(free, what === 'feedL' ? 'L' : 'R');
    else await placeOne(free, what);
  }
  return waitFor(async () => {
    const s = await snap();
    return (s.phase === 'celebrate' || s.phase === 'transition' || s.phase === 'interlude') ? s : null;
  }, 'round completion', 90_000);
}
async function waitForRound(index) {
  return waitFor(async () => {
    const s = await snap();
    return (s.phase === 'play' && s.round && s.round.index === index) ? s : null;
  }, `round ${index} starts`, 90_000);
}
async function openParentMenu() {
  const c = await toClient(28, 28);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await new Promise(r => setTimeout(r, Math.ceil(2000 / TIMESCALE) + 400));
  await page.mouse.up();
  return waitFor(async () => {
    const st = await snap();
    return st.menuOpen ? st : null;
  }, 'parent menu opens', 5_000);
}

// ---- 静的サーバ ----
function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      const ext = path.extname(file);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.md': 'text/plain' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---- 本体 ----
(async () => {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error('index.html がまだ存在しない');
    process.exit(1);
  }
  const server = await serve();
  baseURL = `http://127.0.0.1:${server.address().port}`;

  browser = await chromium.launch();
  ctx = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
    hasTouch: false,
  });
  // 文字ガード（v0.4）: ゲームプレイ中（screen==='game' かつ親メニュー非表示）の
  // fillText/strokeText を違反として数える。title/menu では正方向（文字が実在する）も検証する
  await ctx.addInitScript(() => {
    const rec = { violations: 0, samples: [], titleCalls: 0, menuScreenCalls: 0 };
    Object.defineProperty(window, '__textStats', { value: rec });
    for (const m of ['fillText', 'strokeText']) {
      const orig = CanvasRenderingContext2D.prototype[m];
      CanvasRenderingContext2D.prototype[m] = function (...a) {
        const t = window.__tenbin;
        const screen = t ? t.screen : null;
        const menuOpen = t ? t.menuOpen : false;
        if (!t || (screen === 'game' && !menuOpen)) {
          rec.violations++;
          if (rec.samples.length < 5) rec.samples.push(`${screen}:${String(a[0])}`);
        } else if (screen === 'title') { rec.titleCalls++; }
        else if (screen === 'menu') { rec.menuScreenCalls++; }
        return orig.apply(this, a);
      };
    }
  });
  const pageErrors = [];
  page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`); });

  console.log('tenbin E2E harness (v0.4)');

  // ==== 触感（低速ページ） ====
  await test('spring: fruit placement causes visible oscillation (non-critical damping)', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=2&game=tenbin`);
    const first = await waitFor(snap, '__tenbin exposed', 10_000);
    assert(first.plates.L.x > 0 && first.plates.R.x > first.plates.L.x,
      `plates valid from first exposure, got ${JSON.stringify(first.plates)}`);
    const s = await waitForRound(0);
    const apple = s.apples.find(a => a.state === 'field');
    assert(apple, 'field fruit exists');
    await drag({ x: apple.x, y: apple.y }, s.plates.R);
    await waitFor(async () => (await snap()).counts.right === 1, 'fruit lands on plate R before sampling', 5_000, 15);
    const series = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const b = (await snap()).balance;
      series.push(b.angle - b.target);
      await new Promise(r => setTimeout(r, 25));
    }
    let flips = 0, prev = 0;
    for (const d of series) {
      const sg = Math.abs(d) < 0.05 ? 0 : Math.sign(d);
      if (sg !== 0 && prev !== 0 && sg !== prev) flips++;
      if (sg !== 0) prev = sg;
    }
    assert(flips >= 2, `expected >=2 overshoot flips, got ${flips}`);
  });

  await test('grab during celebration: input gated, game never freezes', async () => {
    await completeRound(() => 'R');
    const st = await snap();
    const target = [...st.apples].reverse().find(a => a.state === 'plate');
    if (target) {
      await drag({ x: target.x, y: target.y }, { x: 512, y: 200 }, { steps: 4, settleMs: 40 });
    }
    await waitForRound(1);
  });

  // ==== 本編（高速ページ） ====
  await test('boot: free-play round, mouths exposed, valid theme', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=tenbin`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    const s = await waitForRound(0);
    assert(s.round.fruitsTotal >= 4 && s.round.fruitsTotal <= 9,
      `fruitsTotal in 4..9, got ${s.round.fruitsTotal}`);
    assert(s.apples.length === s.round.fruitsTotal, `pile matches fruitsTotal`);
    assert(s.mouths && s.mouths.L.r > 0 && s.mouths.R.r > 0, 'mouth zones exposed');
    assert(['apple', 'orange', 'peach'].includes(s.theme?.fruit), `valid theme, got ${JSON.stringify(s.theme)}`);
    assert(s.round.dots === 0, `dots start at 0, got ${s.round.dots}`);
  });

  await test('geometry invariant: mouth zones never overlap plate catch bands', async () => {
    const s = await snap();
    const fruitR = s.apples[0].r;
    const lOk = s.mouths.L.x + s.mouths.L.r + fruitR <= s.plates.L.x - s.plates.catchHalfW;
    const rOk = s.mouths.R.x - s.mouths.R.r - fruitR >= s.plates.R.x + s.plates.catchHalfW;
    assert(lOk && rOk, `non-overlap: mouthL=${JSON.stringify(s.mouths.L)} plateL=${JSON.stringify(s.plates.L)} halfW=${s.plates.catchHalfW} → L=${lOk} R=${rOk}`);
  });

  await test('idle hint: ghost hand appears after 5s idle, hides on touch', async () => {
    await waitFor(async () => (await snap()).hintActive === true, 'hint appears after idle', 15_000);
    await tap({ x: 512, y: 730 });
    await waitFor(async () => (await snap()).hintActive === false, 'hint hides on touch', 5_000);
  });

  await test('place on plates: counts + tilt direction + drop from above', async () => {
    let f = await findFreeFruit();
    await placeOne(f, 'L');
    const s1 = await snap();
    assert(s1.counts.left === 1 && s1.counts.right === 0, `counts 1/0, got ${s1.counts.left}/${s1.counts.right}`);
    await waitFor(async () => (await snap()).balance.target < 0, 'target tilts left');
    // 皿の上空150pxから落としても皿が捕捉する
    f = await findFreeFruit();
    const s2 = await snap();
    await drag({ x: f.x, y: f.y }, { x: s2.plates.R.x, y: s2.plates.R.y - 150 });
    await waitFor(async () => {
      const s = await snap();
      const a = s.apples.find(x => x.id === f.id);
      return a.state === 'plate' && s.counts.right === 1;
    }, 'fruit dropped from above lands on plate R');
  });

  await test('balance celebration: fires once when level, debounced until counts change', async () => {
    // counts 1/1 の水平静止 → 祝福1回
    await waitFor(async () => {
      const s = await snap();
      return s.round.balanceCelebrations >= 1;
    }, 'balance celebration fires at 1/1', 20_000);
    const n = (await snap()).round.balanceCelebrations;
    await new Promise(r => setTimeout(r, 1200)); // ≈10s シミュ時間そのまま水平
    assert((await snap()).round.balanceCelebrations === n,
      'no re-fire while counts composition unchanged (debounce)');
  });

  await test('drop outside: falls to ground, counted on rest, still usable', async () => {
    const f = await findFreeFruit();
    const before = (await snap()).round.dropOutside;
    await drag({ x: f.x, y: f.y }, { x: 512, y: 180 });
    await waitFor(async () => (await snap()).round.dropOutside === before + 1,
      'dropOutside increments on ground rest');
    const g = await findFreeFruit();
    assert(g, 'ground fruit still usable');
  });

  await test('feed from field: animal always eats, fed counted, plates unchanged', async () => {
    const s0 = await snap();
    const f = await findFreeFruit();
    await feedOne(f, 'L');
    const s = await snap();
    assert(s.round.fedL >= 1, `fedL counted, got ${s.round.fedL}`);
    const eaten = s.apples.find(a => a.id === f.id);
    assert(eaten.state === 'eaten', `fruit state eaten, got ${eaten.state}`);
    assert(s.counts.left === s0.counts.left && s.counts.right === s0.counts.right,
      'plate counts unchanged by feeding from field');
  });

  await test('feed from plate (subtraction): counts drop, balance reacts, debounce re-arms', async () => {
    // 右皿に1個足して 1/2 → 右の皿から1個食べさせて 1/1 に戻す（引き算→比較）
    const f = await findFreeFruit();
    await placeOne(f, 'R');
    await waitFor(async () => (await snap()).counts.right === 2, 'counts 1/2', 10_000);
    const nBefore = (await snap()).round.balanceCelebrations;
    const s = await snap();
    const onPlate = s.apples.find(a => a.state === 'plate' && a.plate === 'R');
    const rmBefore = s.round.removedFromPlate;
    await feedOne(onPlate, 'R');
    const s2 = await snap();
    assert(s2.counts.right === 1, `counts back to 1/1, got ${s2.counts.left}/${s2.counts.right}`);
    assert(s2.round.removedFromPlate === rmBefore + 1, 'removedFromPlate counted');
    // 構成が変わったのでデバウンス解除 → 再度水平で祝福が増える
    // （果物総数が少ないシードでは、ここで全部さばけて釣り合い完了が先に来ることも正: どちらかを待つ）
    await waitFor(async () => {
      const s = await snap();
      return s.phase !== 'play' || (s.round && s.round.balanceCelebrations > nBefore);
    }, 'balance re-fires or balanced round completes', 20_000);
  });

  await test('subtraction strategy: clear the round balanced (hidden math reachable)', async () => {
    // 残りを左右交互に置き、余り1個は食べさせて同数で完了させる
    await completeRound((a, s) => {
      const remaining = s.apples.filter(x => x.state === 'field' || x.state === 'ground').length;
      if (remaining === 1 && s.counts.left === s.counts.right) return 'feedL'; // 余り1個は食べさせる
      return s.counts.left <= s.counts.right ? 'L' : 'R';
    });
    const done = await snap();
    if (done.celebrationType) {
      assert(done.celebrationType === 'balance', `balanced clear is top celebration, got ${done.celebrationType}`);
    }
    await waitForRound(1);
    const logs = await readLogs();
    const sess = logs[logs.length - 1];
    const r0 = sess.rounds[0];
    assert(r0 && r0.endedBy === 'cleared' && r0.clearedBalanced === true,
      `round 0 logged as balanced clear, got ${JSON.stringify(r0)}`);
    assert(r0.fedL + r0.fedR >= 1 && r0.balanceCelebrations >= 1, 'subtraction & celebrations recorded');
  });

  await test('all-fed round: feeding everything completes the round (no dead end)', async () => {
    let flip = false;
    const done = await completeRound(() => { flip = !flip; return flip ? 'feedL' : 'feedR'; });
    if (done.celebrationType) {
      assert(done.celebrationType === 'fed', `fed variant celebration, got ${done.celebrationType}`);
    }
    await waitForRound(2);
    // ログが一次証拠: ラウンド1は全部食べさせで完了した
    const sess = (await readLogs()).slice(-1)[0];
    const r1 = sess.rounds[1];
    assert(r1 && r1.fedL + r1.fedR === r1.fruitsTotal && r1.endedBy === 'cleared',
      `round 1 all-fed in log, got ${JSON.stringify(r1)}`);
  });

  await test('all on one plate: target clamped to ±30°, heavier side celebrates', async () => {
    const done = await completeRound(() => 'R');
    assert(done.balance === null || (done.balance.target <= 30.0001 && done.balance.target > 0),
      `target clamped, got ${JSON.stringify(done.balance)}`);
    const st = await waitFor(async () => {
      const x = await snap();
      return x.celebrationType ? x : null;
    }, 'celebration type set', 15_000);
    assert(st.celebrationType === 'right', `right celebrates, got ${st.celebrationType}`);
    await waitForRound(3);
  });

  await test('interlude: 5 lit dots → star interlude → play resumes, dots reset', async () => {
    await completeRound(() => 'R');
    await waitForRound(4);
    await completeRound(() => 'R');
    await waitFor(async () => (await snap()).phase === 'interlude', 'interlude after 5th round', 60_000);
    const s = await waitForRound(5);
    assert(s.round.dots === 0, `dots reset after interlude, got ${s.round.dots}`);
  });

  await test('home mid-round: partial round + session endedBy recorded (log v2)', async () => {
    const f = await findFreeFruit();
    await feedOne(f, 'L');
    const s = await snap();
    const hb = { x: s.homeButton.x + s.homeButton.w / 2, y: s.homeButton.y + s.homeButton.h / 2 };
    await tap(hb); // 短タップでは戻らない
    await new Promise(r => setTimeout(r, 300));
    assert((await snap()).screen === 'game', 'short tap does not leave game');
    await pressHold(hb, Math.ceil(800 / TIMESCALE) + 400);
    await waitFor(async () => (await snap()).screen === 'menu', 'hold returns to menu', 5_000);
    const logs = await readLogs();
    const sess = logs[logs.length - 1];
    assert(sess.v === 2 && sess.endedBy === 'home', `session endedBy home, got ${JSON.stringify({ v: sess.v, endedBy: sess.endedBy })}`);
    assert(sess.rounds.length === 6, `5 cleared + 1 partial rounds, got ${sess.rounds.length}`);
    const partial = sess.rounds[5];
    assert(partial.endedBy === 'home' && partial.fedL >= 1, `partial round recorded, got ${JSON.stringify(partial)}`);
    sess.rounds.slice(0, 5).forEach((r, i) => {
      assert(r.endedBy === 'cleared' && typeof r.durationMs === 'number' && r.durationMs > 0 &&
        typeof r.fruitsTotal === 'number' && typeof r.balanceCelebrations === 'number' &&
        typeof r.clearedBalanced === 'boolean', `round ${i} schema, got ${JSON.stringify(r)}`);
    });
  });

  await test('re-enter from menu tile: fresh session, round 0', async () => {
    const m = await snap();
    assert(m.menuTiles && m.menuTiles.tenbin && !m.menuTiles.wakekko,
      `single tenbin tile (wakekko retired), got ${JSON.stringify(m.menuTiles)}`);
    await tapRegion(m.menuTiles.tenbin);
    await waitForRound(0);
  });

  // ==== 画面遷移・文字 ====
  await test('navigation: title (with logo text) → menu (with label) → game (no text)', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}`);
    const first = await waitFor(snap, '__tenbin exposed', 10_000);
    assert(first.screen === 'title', `boots to title, got ${first.screen}`);
    await new Promise(r => setTimeout(r, 300)); // タイトルを数フレーム描かせる
    const stats1 = await page.evaluate(() => ({ t: window.__textStats.titleCalls }));
    assert(stats1.t > 0, 'title actually draws text (logo)');
    await tap({ x: 512, y: 400 });
    const m = await waitFor(async () => {
      const s = await snap();
      return s.screen === 'menu' ? s : null;
    }, 'menu after title tap', 5_000);
    await new Promise(r => setTimeout(r, 300));
    const stats2 = await page.evaluate(() => ({ m: window.__textStats.menuScreenCalls }));
    assert(stats2.m > 0, 'menu actually draws text (labels)');
    await tapRegion(m.menuTiles.tenbin);
    await waitForRound(0);
  });

  await test('?game=wakekko falls back to tenbin (legacy param safe)', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=wakekko`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    const s = await waitFor(async () => {
      const x = await snap();
      return x.screen === 'game' ? x : null;
    }, 'enters a game', 5_000);
    assert(s.game === 'tenbin', `falls back to tenbin, got ${s.game}`);
  });

  await test('goHome during celebration: no stale state leaks to menu', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=tenbin`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    await waitForRound(0);
    await completeRound(() => 'R');
    const c = await waitFor(async () => {
      const st = await snap();
      return st.phase === 'celebrate' ? st : null;
    }, 'celebration in progress', 15_000);
    const hb = { x: c.homeButton.x + c.homeButton.w / 2, y: c.homeButton.y + c.homeButton.h / 2 };
    await pressHold(hb, Math.ceil(800 / TIMESCALE) + 400);
    const m = await waitFor(async () => {
      const st = await snap();
      return st.screen === 'menu' ? st : null;
    }, 'back to menu from celebration', 5_000);
    assert(m.phase === 'play' && m.celebrationType === null,
      `no stale celebration state on menu, got phase=${m.phase} celebration=${m.celebrationType}`);
    await tapRegion(m.menuTiles.tenbin);
    await waitForRound(0);
  });

  await test('orientation: portrait shows rotate prompt, landscape restores', async () => {
    await page.setViewportSize({ width: 700, height: 1000 });
    await waitFor(async () => (await snap()).orientationBlocked === true, 'portrait blocked', 5_000);
    await page.setViewportSize({ width: 1280, height: 960 });
    await waitFor(async () => (await snap()).orientationBlocked === false, 'landscape restored', 5_000);
  });

  // ==== 親メニュー・ログ・設定 ====
  await test('legacy & corrupted logs: v0.3 problems format + wakekko preserved, menu safe', async () => {
    await page.evaluate(() => {
      localStorage.setItem('tenbin_logs', JSON.stringify([
        { sessionStart: '2026-07-10T00:00:00Z', completed: true, retried: false, problems: [{ level: 0, firstTouchMs: 1, durationMs: 2, dropOutside: 0, removedFromPlate: 0 }] },
        null, 42, 'x',
      ]));
      localStorage.setItem('wakekko_logs', JSON.stringify([
        { sessionStart: '2026-07-11T00:00:00Z', completed: false, problems: [] },
      ]));
    });
    await page.reload();
    await waitFor(snap, '__tenbin after legacy reload', 10_000);
    await waitForRound(0);
    // legacy レコードが保持されている（新セッションの persist で消えない）
    const tlogs = await readLogs();
    assert(tlogs.some(x => x && Array.isArray(x.problems)), 'v0.3 legacy session preserved');
    assert(tlogs.every(x => x && typeof x === 'object'), 'corrupt entries sanitized');
    const wlogs = await readLogs('wakekko_logs');
    assert(wlogs.length === 1, 'wakekko legacy logs untouched');
    // 親メニューが開ける（破損データでフリーズしない）＋コピーに両キーが含まれる
    const menu = await openParentMenu();
    assert(menu.menuRegions.copy && menu.menuRegions.clear && menu.menuRegions.close && menu.menuRegions.bgm,
      'menu regions exposed');
    await tapRegion(menu.menuRegions.copy);
    await new Promise(r => setTimeout(r, 400));
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    if (clip) {
      const parsed = JSON.parse(clip);
      assert(Array.isArray(parsed.tenbin) && Array.isArray(parsed.wakekko),
        'copied JSON contains tenbin + legacy wakekko');
    }
    // 消去は両キー
    await tapRegion(menu.menuRegions.clear);
    await waitFor(async () => (await readLogs()).length === 0 && (await readLogs('wakekko_logs')).length === 0,
      'both log keys cleared', 5_000);
    await tapRegion(menu.menuRegions.close);
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes', 5_000);
  });

  await test('bgm: menu toggle persists via tenbin_prefs across reload', async () => {
    assert((await snap()).bgmEnabled === true, 'bgm enabled by default');
    let m = await openParentMenu();
    await tapRegion(m.menuRegions.bgm);
    await waitFor(async () => (await snap()).bgmEnabled === false, 'bgm toggled off', 5_000);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('tenbin_prefs') || '{}'));
    assert(prefs.bgm === false, `prefs persisted at toggle moment, got ${JSON.stringify(prefs)}`);
    await tapRegion(m.menuRegions.close);
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes', 5_000);
    await page.reload();
    await waitFor(snap, '__tenbin after reload', 10_000);
    assert((await snap()).bgmEnabled === false, 'bgm stays off after reload');
    m = await openParentMenu();
    await tapRegion(m.menuRegions.bgm);
    await waitFor(async () => (await snap()).bgmEnabled === true, 'bgm back on', 5_000);
    await tapRegion(m.menuRegions.close);
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes again', 5_000);
  });

  await test('persistence: theme deterministic per seed across reload', async () => {
    const t1 = (await snap()).theme;
    await page.reload();
    await waitFor(snap, '__tenbin after reload', 10_000);
    const t2 = (await snap()).theme;
    assert(t1.fruit === t2.fruit && t1.animals === t2.animals,
      `theme deterministic, got ${JSON.stringify(t1)} vs ${JSON.stringify(t2)}`);
  });

  await test('no text during gameplay (guard) & no page errors', async () => {
    const stats = await page.evaluate(() => window.__textStats);
    assert(stats.violations === 0,
      `text drawn during gameplay: ${stats.violations} calls, samples=${JSON.stringify(stats.samples)}`);
    assert(pageErrors.length === 0, `errors: ${pageErrors.slice(0, 5).join(' | ')}`);
  });

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
