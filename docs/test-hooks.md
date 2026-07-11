# テストフック契約（index.html ⇔ harness/run.js）

検証ハーネスは**実インターフェース**（canvas への pointer/mouse イベント）だけで操作し、
内部状態は**読み取りのみ**行う。この契約は index.html が公開する読み取り面と、
テスト入力の注入手段を定める。**ここに無い書き込み手段を追加しない。**

## テスト入力の注入（URLクエリパラメータ）

| パラメータ | 意味 |
|---|---|
| `?seed=<uint>` | 乱数シード（mulberry32等）。りんご配置・左右反転を決定的にする。省略時は非決定 |
| `?timescale=<float>` | シミュレーション時間の倍率（既定1）。固定タイムステップ（1/120s）の積分回数を増やして加速する。**物理のdtは変えない**（安定性維持）。ゲーム内の全タイマー（静止判定1s・遷移1.5s・長押し2s・演出シーケンス・ログのms計測）はシミュレーション時間基準にする |

## 読み取り面 `window.__tenbin`（全て読み取り専用）

```js
window.__tenbin = {
  phase,            // 'play' | 'celebrate' | 'transition' | 'sessionEnd'
  problemIndex,     // 0..4
  levels,           // LEVELS テーブル（そのまま）
  apples,           // [{id, x, y, r, state, plate}] 論理座標。
                    //   state: 'field'|'drag'|'plate'|'ground'|'eaten'
                    //   plate: 'L'|'R'|null
  plates,           // {L:{x,y}, R:{x,y}} 皿中心の現在論理座標（傾き反映後）
  balance,          // {angle, vel, target} ラジアンでなく度。angle>0 = 右が下
  counts,           // {left, right} 皿に載っている個数
  orientationBlocked, // 縦持ちブロック中か
  menuOpen,         // 親メニュー表示中か
  menuRegions,      // menuOpen時のみ {copy, clear, close, bgm} 各 {x,y,w,h}（論理座標）。非表示時 null
  theme,            // {fruit, animals} 現セッションのテーマid（文字列）。同seedなら決定的
  bgmEnabled,       // BGM設定（親メニューでトグル。tenbin_prefs に永続）
  hintActive,       // 無操作ヒント（ゴーストハンド）表示中か
  celebrationType,  // 'left'|'right'|'balance'|null
  session,          // 記録中のセッションログ（生オブジェクト参照）
  problemLog,       // 進行中の問題の操作カウンタ（操作の瞬間に確定した値のライブビュー）
                    //   {dropOutside, removedFromPlate, firstTouched}
                    //   完了時に session.problems へ確定コピーされる
  toClient(x, y),   // 論理座標 → クライアント座標 {x,y}（イベント送出用の座標変換）
}
```

getter で実装し、ハーネス側からの代入で内部状態が変わらないこと。

## ハーネス側の観測規約

- 文字禁止の検証: ハーネスが `CanvasRenderingContext2D.prototype.fillText/strokeText` を
  ラップし、`menuOpen === false` の間の呼び出しを違反として数える。
  → ゲームは**親メニュー描画中以外で fillText/strokeText を一切呼ばない**こと
- ログ検証: `localStorage.getItem('tenbin_logs')` を直接読む（読み取りのみ）
- 設定検証: `localStorage.getItem('tenbin_prefs')` を直接読む（読み取りのみ）。
  保存データの注入（`setItem` してからリロード）はテスト入力として可
