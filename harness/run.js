#!/usr/bin/env node
'use strict';
/*
 * てんびん E2E 検証ハーネス
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

async function test(name, fn, timeoutMs = 90_000) {
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
      phase: t.phase, problemIndex: t.problemIndex, levels: t.levels,
      apples: t.apples, plates: t.plates, balance: t.balance, counts: t.counts,
      orientationBlocked: t.orientationBlocked, menuOpen: t.menuOpen,
      menuRegions: t.menuRegions, celebrationType: t.celebrationType,
      session: t.session, problemLog: t.problemLog,
      theme: t.theme, bgmEnabled: t.bgmEnabled, hintActive: t.hintActive,
      screen: t.screen, game: t.game, menuTiles: t.menuTiles,
      homeButton: t.homeButton, wants: t.wants,
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
// 未搭載のりんご1個を指定皿へ載せる。載った個数が増えるまで待つ
async function placeOneApple(apple, plateKey) {
  const before = await snap();
  const total = before.counts.left + before.counts.right;
  // 座標は最新スナップショットから取り直す（渡された座標は古い可能性がある）
  const fresh = before.apples.find(a => a.id === apple.id) || apple;
  await drag({ x: fresh.x, y: fresh.y }, before.plates[plateKey]);
  try {
    await waitFor(async () => {
      const s = await snap();
      return s.counts.left + s.counts.right > total;
    }, `apple ${apple.id} lands on plate ${plateKey}`, 15_000);
  } catch (e) {
    // 失敗時は診断用に全状態を添える
    const s = await snap();
    const states = s.apples.map(a => ({ id: a.id, st: a.state, p: a.plate, x: Math.round(a.x), y: Math.round(a.y) }));
    throw new Error(`${e.message} | phase=${s.phase} counts=${s.counts.left}/${s.counts.right} plates=${JSON.stringify(s.plates)} apples=${JSON.stringify(states)}`);
  }
}
// 現在の問題を完了させる。assign(apple)→'L'|'R'
async function completeProblem(assign) {
  for (;;) {
    const s = await snap();
    if (s.phase !== 'play') break;
    // field（静止）を優先。ground は落下中かもしれないので静止を確認してから拾う
    let free = s.apples.find(a => a.state === 'field');
    if (!free) {
      const g = s.apples.find(a => a.state === 'ground');
      if (!g) break;
      const settled = await waitFor(async () => {
        const s1 = await snap();
        const a1 = s1.apples.find(x => x.id === g.id);
        if (!a1 || a1.state !== 'ground') return { skip: true }; // 落下中に皿へ捕捉された等 → 外のループへ
        await new Promise(r => setTimeout(r, 80));
        const s2 = await snap();
        const a2 = s2.apples.find(x => x.id === g.id);
        if (!a2 || a2.state !== 'ground') return { skip: true };
        return (Math.abs(a2.y - a1.y) < 2 && Math.abs(a2.x - a1.x) < 2) ? a2 : null;
      }, `ground apple ${g.id} comes to rest`, 15_000);
      if (settled.skip) continue;
      free = settled;
    }
    await placeOneApple(free, assign(free, s));
  }
  return waitFor(async () => {
    const s = await snap();
    return (s.phase === 'celebrate' || s.phase === 'sessionEnd' || s.phase === 'transition') ? s : null;
  }, 'problem completion (celebrate)', 60_000);
}
async function waitForProblem(index) {
  return waitFor(async () => {
    const s = await snap();
    return (s.phase === 'play' && s.problemIndex === index) ? s : null;
  }, `problem ${index} starts`, 60_000);
}
function readLogs(key = 'tenbin_logs') {
  return page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]'), key);
}
// 領域 {x,y,w,h} の中心をタップ
async function tapRegion(r) {
  return tap({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
}
// 指定位置を実時間 holdMs 押し込み続ける
async function pressHold(logical, holdMs) {
  const c = await toClient(logical.x, logical.y);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await new Promise(r => setTimeout(r, holdMs));
  await page.mouse.up();
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
    console.error('index.html がまだ存在しない（検証の器のみ整備済み）');
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
  // 文字禁止の監視: 親メニュー非表示中の fillText/strokeText 呼び出しを違反として数える
  await ctx.addInitScript(() => {
    const rec = { violations: 0, samples: [] };
    Object.defineProperty(window, '__textViolations', { value: rec });
    for (const m of ['fillText', 'strokeText']) {
      const orig = CanvasRenderingContext2D.prototype[m];
      CanvasRenderingContext2D.prototype[m] = function (...a) {
        const t = window.__tenbin;
        if (!t || !t.menuOpen) {
          rec.violations++;
          if (rec.samples.length < 5) rec.samples.push(String(a[0]));
        }
        return orig.apply(this, a);
      };
    }
  });
  const pageErrors = [];
  page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`); });

  console.log('tenbin E2E harness');

  // --- 揺れの触感（非臨界減衰）: 低速で1個載せて角度の目標横断を観測 ---
  await test('spring: apple placement causes visible oscillation (non-critical damping)', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=2&game=tenbin`);
    const first = await waitFor(snap, '__tenbin exposed', 10_000);
    // 回帰ガード: 公開読み取り面は最初のフレーム前でも未初期化値を返さない
    assert(first.plates.L.x > 0 && first.plates.R.x > first.plates.L.x,
      `plates valid from first exposure, got ${JSON.stringify(first.plates)}`);
    const s = await waitForProblem(0);
    const apple = s.apples.find(a => a.state === 'field');
    assert(apple, 'field apple exists');
    await drag({ x: apple.x, y: apple.y }, s.plates.R);
    // 着地（＝バネへの入力）を確認してからサンプリング開始
    await waitFor(async () => {
      const st = await snap();
      return st.counts.right === 1 ? st : null;
    }, 'apple lands on plate R before sampling', 5_000, 15);
    // 角度サンプリング: (angle - target) の符号反転回数 >= 2 で「ゆらっ」を確認
    const series = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const b = (await snap()).balance;
      series.push(b.angle - b.target);
      await new Promise(r => setTimeout(r, 25));
    }
    let flips = 0;
    let prev = 0;
    for (const d of series) {
      const sg = Math.abs(d) < 0.05 ? 0 : Math.sign(d);
      if (sg !== 0 && prev !== 0 && sg !== prev) flips++;
      if (sg !== 0) prev = sg;
    }
    const lo = Math.min(...series).toFixed(2), hi = Math.max(...series).toFixed(2);
    assert(flips >= 2, `expected >=2 overshoot flips, got ${flips} (angle-target range [${lo}, ${hi}], n=${series.length})`);
  });

  // --- 監査所見1: 演出中に皿のりんごをつまんでもゲームが死なない ---
  await test('grab during celebration: input gated, game never freezes', async () => {
    // spring テストの続き（timescale=2、皿にりんご1個載っている状態）。残りを全部載せて演出へ
    await completeProblem(() => 'R');
    // 演出中に「まだ食べられていない」皿上のりんごをつまんで外へ捨てようとする
    // （旧実装: plate から外れた id が食べキューに残り TypeError → rAF ループ恒久停止）
    const st = await snap();
    const target = [...st.apples].reverse().find(a => a.state === 'plate');
    if (target) {
      await drag({ x: target.x, y: target.y }, { x: 512, y: 200 }, { steps: 4, settleMs: 40 });
    }
    // ゲームが生きていて次問へ自動遷移すること（フリーズすればここでタイムアウト）
    await waitForProblem(1);
  }, 120_000);

  // --- 本編セッション（高速） ---
  let bootTheme = null;
  await test('boot: play phase, level table, landscape ok, valid theme', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=tenbin`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    const s = await waitForProblem(0);
    assert(s.levels.length === 5, `levels=5, got ${s.levels.length}`);
    const lv = s.levels[0];
    assert(s.apples.length === lv.left + lv.right, `apples=${lv.left + lv.right}, got ${s.apples.length}`);
    assert(!s.orientationBlocked, 'not blocked in landscape');
    assert(['apple', 'orange', 'peach'].includes(s.theme?.fruit) &&
      ['bear-rabbit', 'cat-chick', 'panda-frog'].includes(s.theme?.animals),
      `valid theme, got ${JSON.stringify(s.theme)}`);
    bootTheme = s.theme;
  });

  // --- v0.2: 無操作ヒント（ゴーストハンド） ---
  await test('idle hint: ghost hand appears after 5s idle, hides on touch', async () => {
    await waitFor(async () => (await snap()).hintActive === true, 'hint appears after 5s (sim) idle', 15_000);
    await tap({ x: 950, y: 700 }); // りんごも隅もない場所へのタッチ
    await waitFor(async () => (await snap()).hintActive === false, 'hint hides on touch', 5_000);
    await waitFor(async () => (await snap()).hintActive === true, 'hint re-appears after another idle period', 15_000);
  });

  await test('drag to plate: snap + counts + tilt direction', async () => {
    const s = await snap();
    const apple = s.apples.find(a => a.state === 'field');
    await placeOneApple(apple, 'L');
    const s2 = await snap();
    assert(s2.counts.left === 1 && s2.counts.right === 0, `counts L1/R0, got ${s2.counts.left}/${s2.counts.right}`);
    const placed = s2.apples.find(a => a.id === apple.id);
    assert(placed.state === 'plate' && placed.plate === 'L', 'apple is child of plate L');
    await waitFor(async () => (await snap()).balance.target < 0, 'target tilts left (angle>0 = right down)');
  });

  // --- v0.2: 統一落下物理 —— 皿の真上から落としても載る ---
  await test('drop from above: falling apple is caught by the plate', async () => {
    const s = await snap();
    const apple = s.apples.find(a => a.state === 'field');
    const total = s.counts.left + s.counts.right;
    // 皿中心の 150px 上空でリリース → 落下して皿が捕捉すること
    await drag({ x: apple.x, y: apple.y }, { x: s.plates.R.x, y: s.plates.R.y - 150 });
    await waitFor(async () => {
      const st = await snap();
      const a = st.apples.find(x => x.id === apple.id);
      return a.state === 'plate' && st.counts.left + st.counts.right > total;
    }, 'apple dropped from above lands on plate R');
  });

  await test('drop outside plate: falls to ground, no penalty, still usable', async () => {
    const s = await snap();
    const apple = s.apples.find(a => a.state === 'field');
    const before = s.problemLog.dropOutside;
    await drag({ x: apple.x, y: apple.y }, { x: 512, y: 180 }); // 皿から遠い中空で放す
    // v0.2: dropOutside は「地面静止が確定した瞬間」にカウントされる
    await waitFor(async () => (await snap()).problemLog.dropOutside === before + 1,
      `dropOutside increments on ground rest (${before} -> ${before + 1})`);
    const g = await waitFor(async () => {
      const st = await snap();
      const a = st.apples.find(x => x.id === apple.id);
      return (a.state === 'ground' || a.state === 'field') && a.y > 300 ? a : null;
    }, 'apple rests on ground');
    const countsBefore = (await snap()).counts;
    await placeOneApple(g, 'R'); // ペナルティなし: そのまま拾って載せられる
    const s3 = await snap();
    assert(s3.counts.right === countsBefore.right + 1, 'ground apple can still be placed');
  });

  // --- v0.2監査 所見A: 皿の真下（動物・地面）でのリリースは皿へワープしない ---
  await test('release on animal below plate: falls to ground, no warp to plate', async () => {
    const s = await snap();
    const apple = s.apples.find(a => a.state === 'field');
    const before = s.counts;
    await drag({ x: apple.x, y: apple.y }, { x: 190, y: 640 }); // 左の動物の体の上で放す
    await waitFor(async () => {
      const st = await snap();
      const x = st.apples.find(z => z.id === apple.id);
      return (x.state === 'ground' && x.y > 600) ? x : null;
    }, 'apple falls to ground near animal (not onto plate)', 10_000);
    const s2 = await snap();
    assert(s2.counts.left === before.left && s2.counts.right === before.right,
      `counts unchanged, got ${s2.counts.left}/${s2.counts.right} was ${before.left}/${before.right}`);
  });

  await test('remove from plate: reversible + removedFromPlate count', async () => {
    const s = await snap();
    const onPlate = s.apples.find(a => a.state === 'plate' && a.plate === 'L');
    const before = s.problemLog.removedFromPlate;
    await drag({ x: onPlate.x, y: onPlate.y }, { x: 512, y: 200 });
    await waitFor(async () => {
      const st = await snap();
      return st.counts.left === 0;
    }, 'apple removed from plate L');
    const s2 = await snap();
    const after = s2.problemLog.removedFromPlate;
    assert(after === before + 1, `removedFromPlate ${before}->${after}`);
  });

  await test('problem 0: all on one plate → clamp ±30°, celebrate, auto-advance', async () => {
    const done = await completeProblem(() => 'R'); // 全部右へ → 差が最大
    // clamp: 目標角は+30を超えない
    assert(done.balance.target <= 30.0001 && done.balance.target > 0, `target clamped to +30, got ${done.balance.target}`);
    assert(done.celebrationType === 'right', `celebrationType right, got ${done.celebrationType}`);
    await waitForProblem(1);
  });

  await test('problem 1: split by side, heavier side celebrates', async () => {
    await completeProblem(a => (a.x < 512 ? 'L' : 'R'));
    const s = await waitFor(async () => {
      const st = await snap();
      return st.celebrationType ? st : null;
    }, 'celebrationType set');
    const expected = s.counts.left === s.counts.right ? 'balance' : (s.counts.left > s.counts.right ? 'left' : 'right');
    assert(s.celebrationType === expected, `celebration=${expected}, got ${s.celebrationType}`);
    await waitForProblem(2);
  });

  await test('problem 2: completes', async () => {
    await completeProblem(a => (a.x < 512 ? 'L' : 'R'));
    await waitForProblem(3);
  });

  await test('problem 3 (5v5): balance celebration fires', async () => {
    const s = await snap();
    const lv = s.levels[3];
    assert(lv.left === lv.right, 'level 3 is the equal-count level');
    // 明示的に5個ずつ載せる（散布位置に依らず同数を保証）
    let toL = lv.left;
    await completeProblem(() => (toL-- > 0 ? 'L' : 'R'));
    const st = await waitFor(async () => {
      const x = await snap();
      return x.celebrationType ? x : null;
    }, 'celebrationType set');
    assert(st.counts.left === st.counts.right, `equal counts, got ${st.counts.left}/${st.counts.right}`);
    assert(st.celebrationType === 'balance', `celebrationType balance, got ${st.celebrationType}`);
    await waitForProblem(4);
  });

  await test('problem 4: completes → session end', async () => {
    await completeProblem(a => (a.x < 512 ? 'L' : 'R'));
    await waitFor(async () => (await snap()).phase === 'sessionEnd', 'session end screen', 60_000);
  });

  await test('logs: schema + values persisted at completion', async () => {
    const logs = await readLogs();
    assert(logs.length >= 1, `>=1 session logged, got ${logs.length}`);
    const sess = logs[logs.length - 1];
    assert(sess.completed === true, 'completed=true');
    assert(typeof sess.sessionStart === 'string' && !Number.isNaN(Date.parse(sess.sessionStart)), 'sessionStart is ISO string');
    assert(Array.isArray(sess.problems) && sess.problems.length === 5, `5 problems, got ${sess.problems?.length}`);
    sess.problems.forEach((p, i) => {
      assert(p.level === i, `problem ${i} level index`);
      assert(typeof p.firstTouchMs === 'number' && p.firstTouchMs >= 0, `firstTouchMs number (p${i})`);
      assert(typeof p.durationMs === 'number' && p.durationMs > 0, `durationMs > 0 (p${i})`);
      assert(typeof p.dropOutside === 'number' && typeof p.removedFromPlate === 'number', `counters numeric (p${i})`);
    });
    assert(sess.problems[0].dropOutside >= 1, 'dropOutside recorded in problem 0');
    assert(sess.problems[0].removedFromPlate >= 1, 'removedFromPlate recorded in problem 0');
  });

  // --- 監査所見4: 終了画面でも親メニューに到達できる（誤リスタートしない） ---
  await test('sessionEnd: corner long-press opens menu, no accidental restart', async () => {
    const c = await toClient(28, 28);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await new Promise(r => setTimeout(r, Math.ceil(2000 / TIMESCALE) + 400));
    await page.mouse.up();
    const s = await waitFor(async () => {
      const st = await snap();
      return st.menuOpen ? st : null;
    }, 'menu opens at sessionEnd (not restart)', 5_000);
    assert(s.phase === 'sessionEnd', `phase stays sessionEnd, got ${s.phase}`);
    await tap({ x: s.menuRegions.close.x + s.menuRegions.close.w / 2, y: s.menuRegions.close.y + s.menuRegions.close.h / 2 });
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes', 5_000);
    assert((await snap()).phase === 'sessionEnd', 'closing menu does not restart');
  });

  await test('retry: tap on end screen restarts session, retried=true', async () => {
    await tap({ x: 512, y: 384 });
    await waitForProblem(0);
    const logs = await readLogs();
    const completedSessions = logs.filter(s => s.completed);
    assert(completedSessions.length >= 1 && completedSessions[completedSessions.length - 1].retried === true,
      'previous completed session marked retried');
  });

  await test('persistence: logs survive reload, theme deterministic per seed', async () => {
    await page.reload();
    await waitFor(snap, '__tenbin after reload', 10_000);
    const logs = await readLogs();
    assert(logs.some(s => s.completed === true), 'completed session persists after reload');
    // v0.2: 同 seed の初回セッションのテーマは決定的
    const s = await snap();
    assert(s.theme.fruit === bootTheme.fruit && s.theme.animals === bootTheme.animals,
      `theme deterministic for same seed: boot=${JSON.stringify(bootTheme)} reload=${JSON.stringify(s.theme)}`);
  });

  await test('orientation: portrait shows rotate prompt, landscape restores', async () => {
    await page.setViewportSize({ width: 700, height: 1000 });
    await waitFor(async () => (await snap()).orientationBlocked === true, 'portrait blocked', 5_000);
    await page.setViewportSize({ width: 1280, height: 960 });
    await waitFor(async () => (await snap()).orientationBlocked === false, 'landscape restored', 5_000);
  });

  await test('no text outside parent menu (fillText/strokeText guard)', async () => {
    const rec = await page.evaluate(() => window.__textViolations);
    assert(rec.violations === 0, `text drawn outside menu: ${rec.violations} calls, samples=${JSON.stringify(rec.samples)}`);
  });

  await test('parent menu: 2s long-press opens; clear wipes logs; close', async () => {
    const c = await toClient(28, 28);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await new Promise(r => setTimeout(r, Math.ceil(2000 / TIMESCALE) + 400)); // 2s(シミュ時間)＋余裕
    await page.mouse.up();
    const s = await waitFor(async () => {
      const st = await snap();
      return st.menuOpen ? st : null;
    }, 'menu opens after long-press', 5_000);
    assert(s.menuRegions && s.menuRegions.copy && s.menuRegions.clear && s.menuRegions.close && s.menuRegions.bgm,
      'menu regions exposed (incl. bgm)');
    // コピー（クリップボード権限は付与済み。失敗してもクラッシュしないこと）
    await tap({ x: s.menuRegions.copy.x + s.menuRegions.copy.w / 2, y: s.menuRegions.copy.y + s.menuRegions.copy.h / 2 });
    await new Promise(r => setTimeout(r, 300));
    // 全消去
    await tap({ x: s.menuRegions.clear.x + s.menuRegions.clear.w / 2, y: s.menuRegions.clear.y + s.menuRegions.clear.h / 2 });
    await waitFor(async () => (await readLogs()).length === 0, 'logs cleared', 5_000);
    // 閉じる
    const s2 = await snap();
    await tap({ x: s2.menuRegions.close.x + s2.menuRegions.close.w / 2, y: s2.menuRegions.close.y + s2.menuRegions.close.h / 2 });
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes', 5_000);
  });

  // --- v0.2: BGM トグルが tenbin_prefs に永続する ---
  await test('bgm: menu toggle persists via tenbin_prefs across reload', async () => {
    assert((await snap()).bgmEnabled === true, 'bgm enabled by default');
    const openMenu = async () => {
      const c = await toClient(28, 28);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await new Promise(r => setTimeout(r, Math.ceil(2000 / TIMESCALE) + 400));
      await page.mouse.up();
      return waitFor(async () => {
        const st = await snap();
        return st.menuOpen ? st : null;
      }, 'menu opens', 5_000);
    };
    const tapRegion = async (r) => tap({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    let m = await openMenu();
    await tapRegion(m.menuRegions.bgm);
    await waitFor(async () => (await snap()).bgmEnabled === false, 'bgm toggled off', 5_000);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('tenbin_prefs') || '{}'));
    assert(prefs.bgm === false, `prefs persisted at toggle moment, got ${JSON.stringify(prefs)}`);
    await tapRegion(m.menuRegions.close);
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes', 5_000);
    await page.reload();
    await waitFor(snap, '__tenbin after reload', 10_000);
    assert((await snap()).bgmEnabled === false, 'bgm stays off after reload');
    m = await openMenu();
    await tapRegion(m.menuRegions.bgm);
    await waitFor(async () => (await snap()).bgmEnabled === true, 'bgm toggled back on', 5_000);
    await tapRegion(m.menuRegions.close);
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes again', 5_000);
  });

  // --- 監査所見3: 破損した保存データ（非オブジェクト要素）でもメニューが死なない ---
  await test('resilience: corrupted tenbin_logs entries do not freeze menu', async () => {
    // 保存データの注入（テスト入力。内部状態の直書きではない）
    await page.evaluate(() => localStorage.setItem('tenbin_logs', '[null,{"completed":true},42,"x"]'));
    await page.reload();
    await waitFor(snap, '__tenbin after corrupt-logs reload', 10_000);
    const c = await toClient(28, 28);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await new Promise(r => setTimeout(r, Math.ceil(2000 / TIMESCALE) + 400));
    await page.mouse.up();
    const s = await waitFor(async () => {
      const st = await snap();
      return st.menuOpen ? st : null;
    }, 'menu opens with corrupted logs (no freeze)', 5_000);
    const clean = await readLogs();
    assert(clean.every(x => x && typeof x === 'object' && !Array.isArray(x)),
      `logs sanitized to objects, got ${JSON.stringify(clean)}`);
    await tap({ x: s.menuRegions.close.x + s.menuRegions.close.w / 2, y: s.menuRegions.close.y + s.menuRegions.close.h / 2 });
    await waitFor(async () => (await snap()).menuOpen === false, 'menu closes', 5_000);
  });

  // ==== v0.3: 画面遷移（実経路: タイトル→メニュー→ゲーム→おうち→別ゲーム） ====
  await test('navigation: title → menu → tenbin (real taps)', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}`);
    const first = await waitFor(snap, '__tenbin exposed', 10_000);
    assert(first.screen === 'title', `boots to title, got ${first.screen}`);
    await tap({ x: 512, y: 400 }); // タイトルはどこでもタップで進む
    const m = await waitFor(async () => {
      const s = await snap();
      return s.screen === 'menu' ? s : null;
    }, 'menu screen after title tap', 5_000);
    assert(m.menuTiles && m.menuTiles.tenbin && m.menuTiles.wakekko,
      `menu tiles exposed, got ${JSON.stringify(m.menuTiles)}`);
    await tapRegion(m.menuTiles.tenbin);
    const g = await waitFor(async () => {
      const s = await snap();
      return (s.screen === 'game' && s.game === 'tenbin' && s.phase === 'play') ? s : null;
    }, 'tenbin starts from menu tile', 5_000);
    assert(g.homeButton && g.homeButton.w > 0, 'home button exposed in game');
    assert(g.session, 'session starts at game entry');
  });

  await test('home button: short tap stays, 0.8s hold returns to menu', async () => {
    const s = await snap();
    const hb = { x: s.homeButton.x + s.homeButton.w / 2, y: s.homeButton.y + s.homeButton.h / 2 };
    await tap(hb); // 短タップでは戻らない（誤タップ耐性）
    await new Promise(r => setTimeout(r, 300));
    assert((await snap()).screen === 'game', 'short tap does not leave game');
    await pressHold(hb, Math.ceil(800 / TIMESCALE) + 400); // 0.8s（シミュ時間）押し込み
    await waitFor(async () => (await snap()).screen === 'menu', 'hold returns to menu', 5_000);
  });

  // ==== v0.3: わけっこ ====
  await test('wakekko: enter from menu tile, wants exposed, pile matches', async () => {
    const m = await snap();
    await tapRegion(m.menuTiles.wakekko);
    const s = await waitFor(async () => {
      const st = await snap();
      return (st.screen === 'game' && st.game === 'wakekko' && st.phase === 'play') ? st : null;
    }, 'wakekko starts from menu tile', 5_000);
    assert(s.wants && s.wants.left > 0 && s.wants.right > 0, `wants exposed, got ${JSON.stringify(s.wants)}`);
    assert(s.balance === null, 'balance is null in wakekko');
    assert(s.apples.length === s.wants.left + s.wants.right,
      `pile = wants sum, got ${s.apples.length} vs ${s.wants.left + s.wants.right}`);
  });

  await test('wakekko: correct split → both celebrate → next problem', async () => {
    await completeProblem((a, s) => (s.counts.left < s.wants.left ? 'L' : 'R'));
    const st = await waitFor(async () => {
      const x = await snap();
      return x.celebrationType ? x : null;
    }, 'celebration starts', 10_000);
    assert(st.celebrationType === 'both', `celebrationType both, got ${st.celebrationType}`);
    await waitForProblem(1);
  });

  await test('wakekko: wrong split waits quietly (no ✗), fix → celebrate', async () => {
    // 全部を欲しい数と違う配分で置く（多い側に寄せる）
    const s0 = await snap();
    const overSide = s0.wants.left >= s0.wants.right ? 'L' : 'R';
    await (async () => {
      for (;;) {
        const s = await snap();
        if (s.phase !== 'play') break;
        const free = s.apples.find(a => a.state === 'field' || a.state === 'ground');
        if (!free) break;
        await placeOneApple(free, overSide); // 全部同じ側 → 必ず不一致
      }
    })();
    // 世界は静かに待つ: 完了(celebrate)は発火しない
    await new Promise(r => setTimeout(r, 1500)); // ≈12s シミュ時間
    const sWait = await snap();
    assert(sWait.phase === 'play' && !sWait.celebrationType,
      `stays in play quietly, got phase=${sWait.phase} celebration=${sWait.celebrationType}`);
    // 可逆: 置きすぎた側から正しい配分へ移し替える
    for (;;) {
      const s = await snap();
      if (s.phase !== 'play') break;
      const overKey = s.counts.left > s.wants.left ? 'L' : (s.counts.right > s.wants.right ? 'R' : null);
      if (!overKey) break;
      const underKey = overKey === 'L' ? 'R' : 'L';
      const onPlate = s.apples.find(a => a.state === 'plate' && a.plate === overKey);
      await drag({ x: onPlate.x, y: onPlate.y }, s.plates[underKey]);
      await waitFor(async () => {
        const st = await snap();
        const a = st.apples.find(x => x.id === onPlate.id);
        return a.plate === underKey || st.phase !== 'play';
      }, 'apple moved to the other plate', 15_000);
    }
    const st = await waitFor(async () => {
      const x = await snap();
      return (x.phase === 'celebrate' || x.phase === 'transition') ? x : null;
    }, 'celebrate after fixing the split', 15_000);
    assert(st.celebrationType === null || st.celebrationType === 'both', 'both-type celebration');
    await waitForProblem(2);
  });

  await test('wakekko: session completes, wakekko_logs schema persisted', async () => {
    for (let i = 2; i < 5; i++) {
      await completeProblem((a, s) => (s.counts.left < s.wants.left ? 'L' : 'R'));
      if (i < 4) await waitForProblem(i + 1);
    }
    await waitFor(async () => (await snap()).phase === 'sessionEnd', 'wakekko session end', 60_000);
    const logs = await readLogs('wakekko_logs');
    assert(logs.length >= 1, `wakekko session logged, got ${logs.length}`);
    const sess = logs[logs.length - 1];
    assert(sess.completed === true, 'completed=true');
    assert(Array.isArray(sess.problems) && sess.problems.length === 5, `5 problems, got ${sess.problems?.length}`);
    sess.problems.forEach((p, i) => {
      assert(p.level === i && typeof p.durationMs === 'number' && p.durationMs > 0, `problem ${i} schema`);
      assert(typeof p.firstTouchMs === 'number' && typeof p.dropOutside === 'number' &&
        typeof p.removedFromPlate === 'number', `problem ${i} counters`);
    });
  });

  // --- v0.3監査 所見1: 演出の最中におうちで離脱しても演出状態が画面外へ漏れ残らない ---
  await test('goHome during celebration: no stale phase/celebration leaks to menu', async () => {
    await page.goto(`${baseURL}/index.html?seed=${SEED}&timescale=${TIMESCALE}&game=tenbin`);
    await waitFor(snap, '__tenbin exposed', 10_000);
    await waitForProblem(0);
    await completeProblem(() => 'R');
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
    // 演出状態（BGMダッキングの導出元・celebrationType）がメニューに漏れ残らない
    assert(m.phase === 'play' && m.celebrationType === null,
      `no stale celebration state on menu, got phase=${m.phase} celebration=${m.celebrationType}`);
    // 再入場は正常
    await tapRegion(m.menuTiles.tenbin);
    await waitForProblem(0);
  });

  await test('no page errors during entire run', async () => {
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
