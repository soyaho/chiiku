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
      balance: t.balance, counts: t.counts, boat: t.boat,
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
// 速度を保ったままリリースするドラッグ（舟の押し出し・投擲用）
async function dragFling(fromL, toL, { steps = 6 } = {}) {
  const a = await toClient(fromL.x, fromL.y);
  const b = await toClient(toL.x, toL.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await new Promise(r => setTimeout(r, 40));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
    await new Promise(r => setTimeout(r, 12));
  }
  await page.mouse.up();
}
// 果物保存 invariant: 全果物が既知 state・総数がラウンドの果物数と一致
const OFUNE_STATES = ['field', 'drag', 'boat', 'float', 'eaten'];
function checkConservation(s) {
  assert(s.apples.length === s.round.fruitsTotal,
    `fruit conservation: count ${s.apples.length} vs total ${s.round.fruitsTotal}`);
  for (const a of s.apples) {
    assert(OFUNE_STATES.includes(a.state), `fruit ${a.id} in unknown state '${a.state}'`);
  }
}
// 自由な果物（field 優先、なければ float）を1個返す
async function findOfuneFruit() {
  const s = await snap();
  return s.apples.find(a => a.state === 'field') || s.apples.find(a => a.state === 'float') || null;
}
// 果物1個を舟の甲板へ（load 増加 or あふれ発生まで待つ）
async function loadOne(fruit) {
  const before = await snap();
  const fresh = before.apples.find(a => a.id === fruit.id) || fruit;
  await drag({ x: fresh.x, y: fresh.y }, { x: before.boat.x, y: before.boat.y - before.boat.h });
  return waitFor(async () => {
    const s = await snap();
    return (s.boat.load > before.boat.load || s.round.overflowEvents > before.round.overflowEvents) ? s : null;
  }, `fruit ${fruit.id} loaded (or overflowed)`, 15_000);
}
// 舟をゆっくり運んで実質ゼロ速度で離す（弱リリース）。x=xTarget まで
async function weakDragBoatTo(xTarget) {
  await page.mouse.up().catch(() => {});
  const s0 = await snap();
  const hullY = s0.boat.y + s0.boat.h / 3;
  const a = await toClient(s0.boat.x, hullY);
  const b = await toClient(xTarget, hullY);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await new Promise(r => setTimeout(r, 50));
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y);
    await new Promise(r => setTimeout(r, 30));
  }
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(b.x + (i % 2), b.y);
    await new Promise(r => setTimeout(r, 100));
  }
  await page.mouse.up();
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
    // ページ内 rAF で毎フレームサンプリング（読み取りのみ。ハーネス側レイテンシに影響されない）
    const series = await page.evaluate(() => new Promise(resolve => {
      const out = [];
      const t0 = performance.now();
      function sample() {
        const b = window.__tenbin.balance;
        if (b) out.push(b.angle - b.target);
        if (performance.now() - t0 < 4000) requestAnimationFrame(sample);
        else resolve(out);
      }
      requestAnimationFrame(sample);
    }));
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
      localStorage.setItem('ofune_logs', JSON.stringify([
        { sessionStart: 'y', game: 'ofune', v: 1, rounds: [{ fruitsTotal: '7', capacity: 3, trips: null }] }, null,
        { sessionStart: 'z', rounds: [{ trips: '3', overflowEvents: '2' }] }, // v/game 欠損の破損レコード（監査F2）
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
      assert(Array.isArray(parsed.tenbin) && Array.isArray(parsed.wakekko) && Array.isArray(parsed.ofune),
        'copied JSON contains tenbin + ofune + legacy wakekko');
      // 監査F2: v/game 欠損の破損レコードでも rounds の数値が正規化されている
      const z = parsed.ofune.find(x => x && x.sessionStart === 'z');
      assert(z && typeof z.rounds[0].trips === 'number' && z.rounds[0].trips === 3,
        `v-less corrupt rounds normalized, got ${JSON.stringify(z)}`);
    }
    // 消去は3キー
    await tapRegion(menu.menuRegions.clear);
    await waitFor(async () => (await readLogs()).length === 0 &&
      (await readLogs('wakekko_logs')).length === 0 && (await readLogs('ofune_logs')).length === 0,
      'all three log keys cleared', 5_000);
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

  // ==== おふね（第2ゲーム） ====
  await test('ofune spring: loading causes visible bob (non-critical damping)', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=2&game=ofune`);
    await waitFor(snap, '__tenbin exposed (ofune)', 10_000);
    const s = await waitForRound(0);
    assert(s.game === 'ofune' && s.boat && s.boat.state === 'dock', `ofune boots at dock, got ${JSON.stringify(s.boat)}`);
    const f = await findOfuneFruit();
    await loadOne(f);
    // ページ内 rAF で喫水バネをサンプリング
    const series = await page.evaluate(() => new Promise(resolve => {
      const out = [];
      const t0 = performance.now();
      function sample() {
        const b = window.__tenbin.boat;
        if (b) out.push(b.draft);
        if (performance.now() - t0 < 4000) requestAnimationFrame(sample);
        else resolve(out);
      }
      requestAnimationFrame(sample);
    }));
    const target = series[series.length - 1];
    let flips = 0, prev = 0;
    for (const d of series.map(v => v - target)) {
      const sg = Math.abs(d) < 0.2 ? 0 : Math.sign(d);
      if (sg !== 0 && prev !== 0 && sg !== prev) flips++;
      if (sg !== 0) prev = sg;
    }
    assert(flips >= 2, `boat bobs with >=2 overshoot flips, got ${flips} (n=${series.length})`);
  });

  // --- 監査F3: 荷下ろし中（静止して見える舟）の甲板にも果物は載る（すり抜けない） ---
  await test('ofune load onto unloading boat: no slip-through into water', async () => {
    // ts=2 ページの続き（spring テストで1個積載済み）。容量まで積んで出航
    for (;;) {
      const s = await snap();
      if (s.boat.load >= s.boat.capacity) break;
      const f = await findOfuneFruit();
      assert(f, 'free fruit available');
      await loadOne(f);
    }
    const s0 = await snap();
    await dragFling({ x: s0.boat.x, y: s0.boat.y + s0.boat.h / 3 },
      { x: s0.boat.x + 320, y: s0.boat.y + s0.boat.h / 3 });
    const u = await waitFor(async () => {
      const s = await snap();
      return s.boat.state === 'unloading' ? s : null;
    }, 'boat unloading at far shore', 30_000, 20);
    // 荷下ろし中の甲板に別の果物を放す（ts=2 なので窓は十分）
    const f = await findOfuneFruit();
    assert(f, 'a fruit remains on shore');
    const splashesBefore = u.round.splashes;
    const cur = await snap();
    await drag({ x: f.x, y: f.y }, { x: cur.boat.x, y: cur.boat.y - cur.boat.h });
    await waitFor(async () => {
      const s = await snap();
      const a = s.apples.find(x => x.id === f.id);
      return (a.state === 'boat' || a.state === 'eaten') ? a : null;
    }, 'fruit lands on stationary boat (not through it)', 15_000);
    assert((await snap()).round.splashes === splashesBefore, 'no splash: fruit did not slip into water');
  });

  await test('ofune boot: world exposed, tenbin-only getters null, conservation holds', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=ofune`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    const s = await waitForRound(0);
    assert(s.game === 'ofune', `game ofune, got ${s.game}`);
    assert(s.round.fruitsTotal >= 6 && s.round.fruitsTotal <= 10, `fruits 6..10, got ${s.round.fruitsTotal}`);
    assert(s.boat.capacity >= 3 && s.boat.capacity <= 5, `capacity 3..5, got ${s.boat.capacity}`);
    assert(s.boat.load === 0 && s.boat.state === 'dock', 'boat starts empty at dock');
    assert(s.plates === null && s.balance === null && s.counts === null, 'tenbin getters null in ofune');
    assert(s.mouths && s.mouths.L.r > 0 && s.mouths.R.r > 0, 'shore animal capsules exposed');
    checkConservation(s);
  });

  await test('ofune overflow: capacity+1th fruit floats back — world performs the subtraction', async () => {
    for (;;) {
      const s = await snap();
      if (s.boat.load >= s.boat.capacity) break;
      const f = await findOfuneFruit();
      assert(f, 'free fruit available while loading');
      await loadOne(f);
    }
    const before = await snap();
    assert(before.boat.load === before.boat.capacity, 'boat loaded to capacity');
    const extra = await findOfuneFruit();
    assert(extra, 'one more fruit available');
    const after = await loadOne(extra);
    assert(after.boat.load === after.boat.capacity, `load never exceeds capacity, got ${after.boat.load}/${after.boat.capacity}`);
    assert(after.round.overflowEvents >= 1, `overflowEvents counted, got ${after.round.overflowEvents}`);
    await waitFor(async () => {
      const s = await snap();
      const a = s.apples.find(x => x.id === extra.id);
      return a.state === 'field' ? a : null;
    }, 'overflowed fruit drifts back to shore', 30_000);
    checkConservation(await snap());
  });

  await test('ofune sail: heavy push crosses, animals eat, exact-full counted, boat returns', async () => {
    const before = await snap();
    const wasExactFull = before.boat.load === before.boat.capacity;
    await dragFling({ x: before.boat.x, y: before.boat.y + before.boat.h / 3 },
      { x: before.boat.x + 320, y: before.boat.y + before.boat.h / 3 });
    await waitFor(async () => (await snap()).round.trips >= 1, 'boat arrives, trip counted', 30_000);
    if (wasExactFull) {
      assert((await snap()).round.exactFullTrips >= 1, 'exact-full trip counted');
    }
    await waitFor(async () => {
      const s = await snap();
      return s.boat.state === 'dock' && s.boat.load === 0;
    }, 'empty boat drifts back to dock', 30_000);
    checkConservation(await snap());
  });

  await test('ofune water: thrown fruit splashes, floats back to shore, still usable', async () => {
    const s0 = await snap();
    const f = await findOfuneFruit();
    assert(f, 'free fruit exists');
    const splashesBefore = s0.round.splashes;
    await drag({ x: f.x, y: f.y }, { x: 560, y: 620 });
    await waitFor(async () => (await snap()).round.splashes > splashesBefore, 'splash counted', 10_000);
    await waitFor(async () => {
      const s = await snap();
      const a = s.apples.find(x => x.id === f.id);
      return a.state === 'field' ? a : null;
    }, 'floating fruit drifts back to shore', 30_000);
    checkConservation(await snap());
  });

  await test('ofune direct feed: carrying across by hand still feeds (no refusal)', async () => {
    const s0 = await snap();
    const f = await findOfuneFruit();
    const dfBefore = s0.round.directFeeds;
    await drag({ x: f.x, y: f.y }, { x: s0.mouths.L.x, y: s0.mouths.L.y });
    await waitFor(async () => (await snap()).round.directFeeds > dfBefore, 'direct feed counted', 10_000);
    checkConservation(await snap());
  });

  await test('ofune empty push: boat never strands mid-water', async () => {
    const s = await snap();
    assert(s.boat.load === 0, 'boat empty for this test');
    await dragFling({ x: s.boat.x, y: s.boat.y + s.boat.h / 3 },
      { x: s.boat.x + 260, y: s.boat.y + s.boat.h / 3 });
    await waitFor(async () => (await snap()).boat.state === 'dock', 'boat comes back to dock', 30_000);
  });

  // --- 監査F1: 弱いリリースで舟が水中に置き去りにならない（流れが必ず桟橋へ戻す） ---
  await test('ofune slow release mid-water: current brings boat back to dock', async () => {
    const s0 = await snap();
    const dockX = s0.boat.x;
    const hullY = s0.boat.y + s0.boat.h / 3;
    const a = await toClient(s0.boat.x, hullY);
    const b = await toClient(600, hullY);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 50));
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y);
      await new Promise(r => setTimeout(r, 30));
    }
    // 終端で微小ジッタ＝リリース速度を実質ゼロに（「ゆっくり離す」の再現）
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(b.x + (i % 2), b.y);
      await new Promise(r => setTimeout(r, 100));
    }
    const mid = await snap();
    assert(mid.boat.x > 520, `boat was actually dragged mid-water, got x=${Math.round(mid.boat.x)}`);
    await page.mouse.up();
    await waitFor(async () => {
      const s = await snap();
      return s.boat.state === 'dock' && Math.abs(s.boat.x - dockX) < 20;
    }, 'boat drifts back to dock after weak release', 30_000);
  });

  await test('ofune round completes (mixed means), log v1 schema, next round starts', async () => {
    let flip = false;
    for (;;) {
      const s = await snap();
      if (s.phase !== 'play') break;
      const f = await findOfuneFruit();
      if (!f) {
        const onBoat = s.apples.find(a => a.state === 'boat');
        if (!onBoat) break;
        await dragFling({ x: s.boat.x, y: s.boat.y + s.boat.h / 3 }, { x: s.boat.x + 320, y: s.boat.y + s.boat.h / 3 });
        await waitFor(async () => {
          const x = await snap();
          return x.phase !== 'play' || x.apples.every(a => a.state !== 'boat');
        }, 'boat cargo delivered', 30_000);
        continue;
      }
      flip = !flip;
      const target = flip ? 'L' : 'R';
      const m = (await snap()).mouths[target];
      await drag({ x: f.x, y: f.y }, { x: m.x, y: m.y });
      await new Promise(r => setTimeout(r, 150));
    }
    await waitFor(async () => {
      const s = await snap();
      return s.phase === 'celebrate' || s.phase === 'transition' || s.phase === 'interlude';
    }, 'ofune round completes', 90_000);
    await waitForRound(1);
    const sess = (await readLogs('ofune_logs')).slice(-1)[0];
    assert(sess && sess.game === 'ofune' && sess.v === 1, `ofune session record, got ${JSON.stringify({ game: sess?.game, v: sess?.v })}`);
    const r0 = sess.rounds[0];
    assert(r0 && r0.endedBy === 'cleared' &&
      typeof r0.fruitsTotal === 'number' && typeof r0.capacity === 'number' &&
      typeof r0.trips === 'number' && r0.trips >= 1 &&
      typeof r0.exactFullTrips === 'number' && r0.overflowEvents >= 1 &&
      typeof r0.directFeeds === 'number' && r0.directFeeds >= 1 &&
      r0.splashes >= 1 && r0.durationMs > 0,
      `round 0 schema+values, got ${JSON.stringify(r0)}`);
  });

  await test('ofune home mid-round: partial round + session endedBy recorded', async () => {
    const f = await findOfuneFruit();
    const s0 = await snap();
    await drag({ x: f.x, y: f.y }, { x: s0.mouths.R.x, y: s0.mouths.R.y });
    await waitFor(async () => (await snap()).round.directFeeds >= 1, 'one direct feed', 10_000);
    const s = await snap();
    await pressHold({ x: s.homeButton.x + s.homeButton.w / 2, y: s.homeButton.y + s.homeButton.h / 2 },
      Math.ceil(800 / TIMESCALE) + 400);
    await waitFor(async () => (await snap()).screen === 'menu', 'back to menu', 5_000);
    const sess = (await readLogs('ofune_logs')).slice(-1)[0];
    assert(sess.endedBy === 'home' && sess.rounds.slice(-1)[0].endedBy === 'home',
      `partial ofune round + session endedBy home, got ${JSON.stringify(sess.rounds.slice(-1)[0])}`);
    const m = await snap();
    assert(m.menuTiles.tenbin && m.menuTiles.ofune, `both tiles on menu, got ${JSON.stringify(m.menuTiles)}`);
    await tapRegion(m.menuTiles.ofune);
    await waitForRound(0);
  });

  // --- v0.4監査 F2: 動物の足元に放しても食べる（拒食に見える空白を残さない） ---
  await test('feed at animal feet: release low on the body still feeds', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=tenbin`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    await waitForRound(0);
    const s = await snap();
    const f = await findFreeFruit();
    const fedBefore = s.round.fedL;
    // 口ゾーン円の中心ではなく、動物の体の下端（足元）で放す
    await drag({ x: f.x, y: f.y }, { x: s.mouths.L.x, y: 690 });
    await waitFor(async () => {
      const st = await snap();
      return st.round && st.round.fedL > fedBefore;
    }, 'fruit released at feet is eaten (no refusal gap)', 10_000);
  });

  // --- v0.4監査 F1: ロールイン中（未着手）の home 離脱で空レコードを残さない ---
  await test('home during transition: untouched round is not logged', async () => {
    await completeRound(() => 'R');
    // celebrate → transition に入った瞬間に home 押し込み
    await waitFor(async () => (await snap()).phase === 'transition', 'transition begins', 30_000, 20);
    const s = await snap();
    const hb = { x: s.homeButton.x + s.homeButton.w / 2, y: s.homeButton.y + s.homeButton.h / 2 };
    await pressHold(hb, Math.ceil(800 / TIMESCALE) + 300);
    await waitFor(async () => (await snap()).screen === 'menu', 'back to menu', 5_000);
    const sess = (await readLogs()).slice(-1)[0];
    const untouched = sess.rounds.filter(r =>
      r.endedBy === 'home' && (r.fedL + r.fedR + r.dropOutside + r.removedFromPlate === 0) && !r.clearedBalanced);
    assert(untouched.length === 0,
      `no all-zero untouched round records, got ${JSON.stringify(sess.rounds)}`);
  });

  // --- v0.4監査 F3: 破損した v2 数値フィールドは読み込み時に正規化される ---
  await test('corrupt v2 numeric fields are normalized on load', async () => {
    await page.evaluate(() => {
      localStorage.setItem('tenbin_logs', JSON.stringify([
        { sessionStart: 'x', game: 'tenbin', v: 2, rounds: [{ fruitsTotal: 4, fedL: '3', fedR: null, balanceCelebrations: '1', clearedBalanced: 1, durationMs: '9', endedBy: 'cleared' }] },
      ]));
    });
    await page.reload();
    await waitFor(snap, '__tenbin after reload', 10_000);
    await waitForRound(0); // 入場時の persist でストレージが正規化された形に書き戻される
    const logs = await readLogs();
    const legacy = logs.find(x => x.sessionStart === 'x');
    assert(legacy, 'legacy session preserved');
    const r = legacy.rounds[0];
    assert(typeof r.fedL === 'number' && r.fedL === 3 && typeof r.fedR === 'number' && r.fedR === 0 &&
      typeof r.balanceCelebrations === 'number' && typeof r.durationMs === 'number' &&
      typeof r.clearedBalanced === 'boolean',
      `numeric fields normalized, got ${JSON.stringify(r)}`);
    // 親メニューも問題なく開ける
    const menu = await openParentMenu();
    await tapRegion(menu.menuRegions.close);
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes', 5_000);
  });

  // ===== v0.6 フィードバック対応（そうぞう・置き場所保持・舟の静止捕捉と可逆性） =====

  await test('branding: document.title is そうぞう', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    const t = await page.title();
    assert(t === 'そうぞう', `document.title そうぞう, got "${t}"`);
  });

  await test('tenbin: fruit stays where dropped on plate; removal does not rearrange', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=tenbin`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    await waitForRound(0);
    const offsets = [30, -25, 2]; // 旧グリッド(-36, 0, +36)のどれとも一致しない置き位置
    const placed = [];
    for (const off of offsets) {
      const f = await findFreeFruit();
      assert(f, 'free fruit available');
      const p = (await snap()).plates.L;
      await drag({ x: f.x, y: f.y }, { x: p.x + off, y: p.y - 60 });
      await waitFor(async () => {
        const st = await snap();
        const a = st.apples.find(x => x.id === f.id);
        return a && a.state === 'plate' ? a : null;
      }, `fruit ${f.id} lands on plate L`, 15_000);
      placed.push({ id: f.id, off });
    }
    const st = await snap();
    for (const q of placed) {
      const a = st.apples.find(x => x.id === q.id);
      const rel = a.x - st.plates.L.x;
      assert(Math.abs(rel - q.off) <= 20, `fruit keeps dropped offset ${q.off}, got ${rel.toFixed(1)}`);
    }
    // 1個下ろしても残りは並べ直されない
    const keep = placed.slice(0, 2).map(q => {
      const a = st.apples.find(x => x.id === q.id);
      return { id: q.id, rel: a.x - st.plates.L.x };
    });
    const victim = st.apples.find(x => x.id === placed[2].id);
    await drag({ x: victim.x, y: victim.y }, { x: 512, y: 640 });
    await waitFor(async () => {
      const s = await snap();
      const a = s.apples.find(x => x.id === placed[2].id);
      return a.state !== 'plate' ? a : null;
    }, 'fruit removed from plate', 15_000);
    const s2 = await snap();
    for (const q of keep) {
      const a = s2.apples.find(x => x.id === q.id);
      const rel = a.x - s2.plates.L.x;
      assert(Math.abs(rel - q.rel) <= 2, `remaining fruit ${q.id} not rearranged: ${q.rel.toFixed(1)} → ${rel.toFixed(1)}`);
    }
  });

  await test('ofune: fruit stays where dropped on deck (no grid teleport)', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=ofune`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    await waitForRound(0);
    const offs = [28, -35]; // 旧グリッド(-30, 0, +30)と一致しない
    for (const off of offs) {
      const f = await findOfuneFruit();
      assert(f, 'free fruit available');
      const b = (await snap()).boat;
      await drag({ x: f.x, y: f.y }, { x: b.x + off, y: b.y - b.h });
      await waitFor(async () => {
        const st = await snap();
        const a = st.apples.find(x => x.id === f.id);
        return a && a.state === 'boat' ? a : null;
      }, `fruit ${f.id} lands on deck`, 15_000);
      const st = await snap();
      const a = st.apples.find(x => x.id === f.id);
      const rel = a.x - st.boat.x;
      assert(Math.abs(rel - off) <= 18, `deck fruit keeps offset ${off}, got ${rel.toFixed(1)}`);
    }
  });

  await test('ofune: returning boat can be caught by hand (held) and carried home', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=2&game=ofune`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    await waitForRound(0);
    await weakDragBoatTo(620);
    const mid = await waitFor(async () => {
      const s = await snap();
      return (s.boat.state === 'returning' && s.boat.x > 480) ? s : null;
    }, 'boat returning mid-water', 10_000, 15);
    const c = await toClient(mid.boat.x - 45, mid.boat.y); // 移動方向に少しリードして掴む
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    try {
      await waitFor(async () => {
        const s = await snap();
        return s.boat.state === 'held' ? s : null;
      }, 'boat is held by hand', 3_000, 15);
      const d = await toClient(430, mid.boat.y);
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(c.x + (d.x - c.x) * i / 6, c.y);
        await new Promise(r => setTimeout(r, 30));
      }
      await new Promise(r => setTimeout(r, 250));
    } finally {
      await page.mouse.up();
    }
    await waitFor(async () => (await snap()).boat.state === 'dock', 'boat settles at dock', 15_000);
  });

  await test('ofune: fruit loads onto quasi-stationary returning boat near dock', async () => {
    const s0 = await waitFor(async () => {
      const s = await snap();
      return s.boat.state === 'dock' ? s : null;
    }, 'boat at dock to start', 15_000);
    const dockX = s0.boat.x;
    await weakDragBoatTo(600);
    await waitFor(async () => (await snap()).boat.state === 'returning', 'boat returning', 5_000, 10);
    // 果物を桟橋の甲板上空に構え、ほぼ帰着（まだ returning）の瞬間に放す
    const f = await findOfuneFruit();
    assert(f, 'free fruit available');
    const from = await toClient(f.x, f.y);
    const hold = await toClient(dockX, s0.boat.y - s0.boat.h - 6);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    try {
      await new Promise(r => setTimeout(r, 60));
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(from.x + (hold.x - from.x) * i / 6, from.y + (hold.y - from.y) * i / 6);
        await new Promise(r => setTimeout(r, 16));
      }
      const splashesBefore = (await snap()).round.splashes;
      await waitFor(async () => {
        const s = await snap();
        return (Math.abs(s.boat.x - dockX) < 18) ? s : null;
      }, 'boat almost home (still returning)', 15_000, 10);
      await page.mouse.up();
      await waitFor(async () => {
        const s = await snap();
        const a = s.apples.find(x => x.id === f.id);
        return a.state === 'boat' ? a : null;
      }, 'fruit loads onto the almost-stationary boat', 10_000);
      assert((await snap()).round.splashes === splashesBefore, 'no splash: fruit did not fall into water');
    } finally {
      await page.mouse.up().catch(() => {});
    }
  });

  await test('ofune: fruit can be taken back off a docked boat (reversible)', async () => {
    await waitFor(async () => (await snap()).boat.state === 'dock', 'boat docked', 15_000);
    let st = await snap();
    if (st.boat.load === 0) {
      const f = await findOfuneFruit();
      assert(f, 'free fruit to load');
      await loadOne(f);
      st = await snap();
    }
    const cargo = st.apples.find(a => a.state === 'boat');
    assert(cargo, 'a fruit is on deck');
    const loadBefore = st.boat.load;
    await drag({ x: cargo.x, y: cargo.y }, { x: 180, y: 560 });
    const after = await waitFor(async () => {
      const s = await snap();
      const a = s.apples.find(x => x.id === cargo.id);
      return (a.state === 'field') ? s : null;
    }, 'fruit taken back to shore', 15_000);
    assert(after.boat.load === loadBefore - 1, `load decremented ${loadBefore}→${after.boat.load}`);
    checkConservation(after);
  });

  await test('ofune: touching the hull grabs the boat, not nearby deck cargo', async () => {
    let st = await snap();
    if (st.boat.load === 0) {
      const f = await findOfuneFruit();
      assert(f, 'free fruit to load');
      await loadOne(f);
      st = await snap();
    }
    // 甲板の果物のタッチ円(62px)圏内だが、指は明らかに船体の上
    const c = await toClient(st.boat.x, st.boat.y + 14);
    await page.mouse.up().catch(() => {});
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    try {
      const held = await waitFor(async () => {
        const s = await snap();
        return s.boat.state === 'held' ? s : null;
      }, 'boat grabbed (not the cargo)', 3_000, 15);
      assert(held.boat.load === st.boat.load, 'cargo untouched');
    } finally {
      await page.mouse.up();
    }
    await waitFor(async () => (await snap()).boat.state === 'dock', 'boat back to dock state', 5_000);
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
