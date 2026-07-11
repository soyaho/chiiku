# テストフック契約（index.html ⇔ harness/run.js）

検証ハーネスは**実インターフェース**（canvas への pointer/mouse イベント）だけで操作し、
内部状態は**読み取りのみ**行う。この契約は index.html が公開する読み取り面と、
テスト入力の注入手段を定める。**ここに無い書き込み手段を追加しない。**

## テスト入力の注入（URLクエリパラメータ）

| パラメータ | 意味 |
|---|---|
| `?seed=<uint>` | 乱数シード（mulberry32等）。配置・果物総数・テーマを決定的にする。省略時は非決定 |
| `?timescale=<float>` | シミュレーション時間の倍率（既定1）。固定タイムステップ（1/120s）の積分回数を増やして加速する。**物理のdtは変えない**。ゲーム内の全タイマー（静止判定・釣り合い判定1.2s・遷移・幕間・長押し・おうち押し込み・演出・ログms計測）はシミュレーション時間基準 |
| `?game=tenbin` | タイトル/メニューを飛ばして直接入場。未知の値（旧 `wakekko` 含む）は tenbin にフォールバック。実経路（タイトル→メニュー→ゲーム）はナビゲーションシナリオが実タップで別途通す |

## 読み取り面 `window.__tenbin`（全て読み取り専用）

```js
window.__tenbin = {
  // --- 画面遷移 ---
  screen,           // 'title' | 'menu' | 'game'
  game,             // 'tenbin' | null（screen==='game' 以外は null）
  menuTiles,        // screen==='menu' 時のみ {tenbin:{x,y,w,h}}（論理座標）。他は null
  homeButton,       // screen==='game' 時のみ {x,y,w,h}。他は null

  // --- ゲーム（v0.4: 自由遊び・ラウンド制） ---
  phase,            // 'play' | 'celebrate' | 'transition' | 'interlude'
  round,            // 進行中ラウンドのライブビュー（操作の瞬間に確定した値）:
                    //   {index, fruitsTotal, fedL, fedR, balanceCelebrations,
                    //    dropOutside, removedFromPlate, dots}
                    //   dots = 現サイクルで点灯している進行ドット数(0..5)。ゲーム外は null
  apples,           // [{id, x, y, r, state, plate}] 論理座標。
                    //   state: 'field'|'drag'|'plate'|'ground'|'eaten'
  plates,           // {L:{x,y}, R:{x,y}, catchHalfW} 皿中心の現在論理座標（傾き反映後）＋捕捉半幅
  mouths,           // {L:{x,y,r,footY}, R:{...}} 動物の食べさせ捕捉域。
                    //   (x,y)〜(x,footY) を軸とする半径 r の縦カプセル（体のどこに渡しても食べる）
  balance,          // {angle, vel, target}（度。angle>0 = 右が下）。ゲーム外は null
  counts,           // {left, right} 皿に載っている個数
  orientationBlocked, // 縦持ちブロック中か
  menuOpen,         // 親メニュー表示中か
  menuRegions,      // menuOpen時のみ {copy, clear, close, bgm} 各 {x,y,w,h}。非表示時 null
  theme,            // {fruit, animals} 現セッションのテーマid。同seedなら決定的
  bgmEnabled,       // BGM設定（tenbin_prefs に永続）
  hintActive,       // 無操作ヒント（ゴーストハンド）表示中か
  celebrationType,  // 'left' | 'right' | 'balance' | 'fed' | null
  session,          // 記録中のセッションログ（生オブジェクト参照）。ゲーム外は null
  toClient(x, y),   // 論理座標 → クライアント座標 {x,y}
}
```

getter で実装し、ハーネス側からの代入で内部状態が変わらないこと。

## ハーネス側の観測規約

- **文字ガード（v0.4 改訂）**: ハーネスが `fillText/strokeText` をラップし、
  **`screen==='game'` かつ親メニュー非表示の間**の呼び出しを違反として数える。
  タイトル・メニュー・親メニューでは文字（ひらがな中心）を使用してよい——
  ハーネスはタイトル/メニューで文字が実際に描かれること（ラベルの存在）も正方向で検証する
- **幾何 invariant**: 口ゾーン（`mouths`）と皿の捕捉帯（`plates.catchHalfW`）は
  水平方向に重ならないこと（果物半径ぶんのマージン込み）をハーネスが検証する
- ログ検証: `localStorage.getItem('tenbin_logs')` / `wakekko_logs`（legacy）を直接読む
- 設定検証: `localStorage.getItem('tenbin_prefs')` を直接読む。
  保存データの注入（`setItem` してからリロード）はテスト入力として可
