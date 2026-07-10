# wanoku-navi 代表テストケース

最終確認日: 2026-07-09  
対象実装: `wanoku-navi/wanoku navi v27 yakou.html`  
関連資料: `docs/wanoku-storage.md`、`docs/recovery-and-backup-policy.md`、`wanoku-navi/SETUP 自動取得.md`

## 1. 目的と分類

この文書は、スコアリング、潮汐、外部情報取得、学習、UIを将来分離またはTypeScript化するときの回帰基準である。現在の実装から確認できる仕様だけを扱う。

期待値は次の種類に分ける。

- **確定値**: 固定入力から数値、文字列、真偽値を一意に算出できる。
- **期待する性質**: 日時、外部応答、複数レイヤー等に依存するため、範囲、順序、不変条件で確認する。
- **現行特性**: 不自然に見えても現行コードが実際に返す値。変更する場合はリファクタリングではなく仕様変更として扱う。

推測や将来構想は末尾へ分離する。

## 2. 将来自動化時の共通条件

- ケースごとにグローバル `S`、`Store`、`_SC`、`_TH` を初期化する。
- `Date.now()`、`nowJST()`、乱数、fetch、localStorageをテストダブルへ置き換える。
- 日時はwanoku-naviの `jstWall()` 表現に合わせる。これはJSTの壁時計値を `Date.UTC()` で表す。
- スコア比較前に `clrSC()` を呼び、キャッシュによる前ケースの影響を除く。
- 通信テストでは実ネットワークを使わず、fetchのURL、メソッド、ヘッダー、本文、失敗伝播を検証する。

推奨許容差:

- 整数スコア、時刻、件数、通知文: 完全一致
- 潮位: `1e-6 cm`
- 潮位変化: `1e-9 cm/min`
- 距離: `1e-6 km`
- 回帰・比率: `1e-9`
- `Math.round()` 後の値: 完全一致

固定潮汐fixtureでは `jstWall(2026, 7, 9, h, m)` を使用する。

## 3. 保存・復旧

根拠処理: `Store.load()`、`Store.set()`、`Store.mode`、`Store.isBlocked()`、`archiveCorrupt()`、`notifyStoreResult()`。
破損退避キーの一般形は `<元キー>.corrupt.<timestamp>` である。

### WSTOR-001 localStorage正常保存

- 種別: 確定値
- 前提: localStorage試験書込と本書込が成功、`window.storage` なし
- 実行: `Store.set("settings", value)`
- 期待値:
  - `Store.mode === "local"`
  - 戻り値 `true`
  - キー `"settings"` に `JSON.stringify(value)` を保存
  - `[wanoku storage] save attempt` を `console.info` へ出す
  - `notifyStoreResult(true, "保存しました", "settings")` は `"保存しました"`

### WSTOR-002 初期化時のメモリモード

- 種別: 確定値
- 前提: localStorage試験書込が例外
- 期待値:
  - `Store.mode === "mem"`
  - `[wanoku storage] localStorage unavailable; using memory only` を `console.warn`
  - 画面に「このセッション限りの保存」とバックアップ案内
  - `Store.set()` は値をメモリへ保持して `false`
  - 通知は `"一時保存です。このセッション限りの保存です"`

### WSTOR-003 保存途中の失敗

- 種別: 確定値
- 前提: 初期化は成功し、本番の `localStorage.setItem()` が例外
- 期待値:
  - 失敗した値をページ内メモリへ保持
  - `Store.mode` が `"local"` から `"mem"` へ変わる
  - 戻り値 `false`
  - `[wanoku storage] persistent write failed; switched to memory` を `console.error`
  - 再起動前のバックアップを書き出すよう表示

### WSTOR-004 破損データ退避とロック

- 種別: 確定値
- 前提: `logs` の値が `"{broken"`
- 実行: `await Store.load(["logs"])`
- 期待値:
  - 元文字列を `logs.corrupt.<timestamp>` へ保存
  - 元の `logs` は変更しない
  - `Store.get("logs") === null`
  - `Store.isBlocked("logs") === true`
  - `[wanoku storage] corrupt data archived` を `console.warn`
  - `[wanoku storage] corrupt data detected; automatic overwrite blocked` を `console.error`
  - 画面に「破損データを退避しました」

### WSTOR-005 破損ロック中の書込

- 種別: 確定値
- 前提: `Store.isBlocked("logs") === true`
- 実行: `Store.set("logs", [])`
- 期待値:
  - 戻り値 `false`
  - 元キーへ書き込まない
  - `[wanoku storage] write blocked for corrupt key` を `console.warn`
  - 通知は `"破損データ保護中のため保存を停止しています"`
  - 他の非ロックキーは引き続き保存可能

### WSTOR-006 複数キー保存の一部失敗

- 種別: 確定値
- 前提: `settings` は成功、`logs` は失敗
- 期待値:
  - 結果配列は `[true, false]`
  - `results.every(Boolean) === false`
  - 成功通知を出さず、一時保存または破損保護通知
  - 先に成功した `settings` はロールバックされない
- 実装事実: 複数キー保存はトランザクションではない。

### WSTOR-007 window.storage受付

- 種別: 現行特性
- 前提: `window.storage.set()` がPromiseを返す
- 期待値:
  - Promiseの完了前に `Store.set()` は `true`
  - `Store.mode === "ws"` では通知が `"保存処理を受け付けました"`
  - 後からPromiseがrejectした場合は `mem` へ移る

## 4. 風向差

根拠関数: `angleDiff()`、`windFacingFit()`。
必須回帰条件は `angleDiff(350, 10) === 20`、`angleDiff(10, 350) === 20`、`angleDiff(90, 270) === 180` である。

### WIND-001 350°と10°

- 種別: 確定値
- 入力: `angleDiff(350, 10)`
- 期待値: `20`

### WIND-002 10°と350°

- 種別: 確定値
- 入力: `angleDiff(10, 350)`
- 期待値: `20`

### WIND-003 反対方向

- 種別: 確定値
- 入力: `angleDiff(90, 270)`
- 期待値: `180`

### WIND-004 360°を超える入力

- 種別: 確定値
- 入力:
  - `angleDiff(-10, 370)`
  - `angleDiff(720, 0)`
- 期待値:
  - `20`
  - `0`
- 確認観点: 現在残っている正規化版の定義を使う。

### WIND-005 風表・風裏・横風

- 種別: 確定値
- スポット: `facing:180`
- ケース:
  - 風向180°、8m/s、シーバス → `onshore === true`、`score === 0.72`
  - 風向90°、6m/s → `cross === true`、`score === 0.78`
  - 風向0°、4m/s → `offshore === true`、内部値1.04だが `clamp01()` 後は `score === 1`
  - `wx === null` → `score === 0.8`

## 5. 潮汐

根拠関数: `tideHeight()`、`tideFlow()`、`dayExtrema()`、`tidePhaseAt()`、`tideHeightSpot()`、`tideFlowSpot()`、`spotTideFit()`。

### TIDE-001 固定日の潮種と潮位

- 種別: 確定値
- 日付: 2026-07-09
- 期待値:
  - `tideType(jstWall(2026,7,9,0,0)) === "小"`
  - 00:00の潮位 `168.32515372863014 cm`
  - 09:00の潮位 `103.85171317691197 cm`
  - 12:00の潮位 `143.98925628595913 cm`
- 許容差: 潮位 `1e-6`

### TIDE-002 上げ

- 種別: 確定値
- 時刻: 2026-07-09 09:00
- 期待値:
  - `tideFlow() = 0.3092706859068675 cm/min`
  - `tidePhaseAt().phase === "rising"`
  - `strength === "mod"`
  - `phaseLabel(...) === "上げ潮"`

### TIDE-003 下げ

- 種別: 確定値
- 時刻: 2026-07-09 03:00
- 期待値:
  - `tideFlow() = -0.3682721380339596 cm/min`
  - `phase === "falling"`
  - `strength === "mod"`
  - 表示は `"下げ潮"`

### TIDE-004 満潮前後

- 種別: 確定値
- 時刻: 2026-07-09 12:30
- 期待値:
  - `nearH === true`
  - `nearL === false`
  - `Math.abs(flow) < 0.12` のため `phase === "slack"`
  - `phaseLabel(...) === "満潮前後"`
- 境界: 満潮時刻との差が50分未満。50分ちょうどは対象外。

### TIDE-005 干潮前後

- 種別: 確定値
- 時刻: 2026-07-09 06:00
- 期待値:
  - `nearL === true`
  - `nearH === false`
  - `phase === "slack"`
  - `phaseLabel(...) === "干潮前後"`

### TIDE-006 日内極値

- 種別: 確定値
- `dayExtrema(jstWall(2026,7,9))` の期待順:
  1. 干潮 06:00、約70.2029cm
  2. 満潮 12:30、約145.2939cm
  3. 干潮 17:15、約118.9611cm
  4. 満潮 23:30、約173.5774cm
- 許容差: 高さ0.001cm、時刻完全一致
- 現行特性: 15分刻みの極値探索で保持する値と `tideHeight(extreme.ms)` はわずかに異なる場合がある。

### TIDE-007 場所別補正

- 種別: 確定値
- 時刻: 2026-07-09 09:00
- スポット:
  - `s3` 花見川河口: `offsetMin=10`、`heightCm=-10`
  - `s5` 千葉港: 補正なし
- 期待値:
  - `tideHeightSpot(s3) = 90.76059507351945 cm`
  - `tideFlowSpot(s3) = 0.3068718496982375 cm/min`
  - `tideHeightSpot(s5) = 103.85171317691197 cm`

### TIDE-008 スポット別潮位適合

- 種別: 確定値
- 入力: TIDE-007の花見川河口、7月、上げ
- 期待値:
  - シーバスの `spotTideFit().score = 0.835229723126901`
  - アジの `score = 0.9420868850753945`
- 理由: ライトゲームは流速正規化の分母が0.35、その他は0.48。河口かつ5〜7月の上げでは+0.05。

## 6. 魚種別スコア

根拠処理: `SPECIES`、`SEASON`、`FISH_KB`、`_scat()`、`scoreDecomp()`。

フルスコアは季節、潮汐、光、風、雨、水温、地形、ベイト、実績、外部情報、学習値を合成するため、多くのケースでは固定総得点よりレイヤーの性質を確認する。

### FISH-001 スコア範囲

- 種別: 確定値
- 対象: すべての `_scat()` 結果
- 期待値:
  - `total` は整数
  - `0 <= total <= 100`
  - `parts` は季節、潮、時間、風、雨、水温、地形を含む

### FISH-002 シーバス

- 種別: 確定値
- 実装値:
  - 適水温13〜22℃
  - 許容水温8〜27℃
  - 夜適性0.9
  - 構造依存0.9
  - ベイト依存1.0
  - 10月の季節値0.95
- 期待する性質: 明暗、橋脚、河口、適度な流れ、ナイト、ベイト一致が正方向の根拠になり得る。

### FISH-003 チニング

- 種別: 実装事実
- UIと保存上の魚種キーは `"チヌ"`。`"チニング"` という魚種キーはない。
- `"チヌ"` の実装値:
  - 適水温16〜26℃
  - 汽水適性0.9
  - 夜適性0.5
  - 5月の季節値0.8
- テストでは「チニング」をシナリオ名に使っても、入力キーは `"チヌ"` とする。

### FISH-004 アジ

- 種別: 確定値
- 実装値:
  - 適水温18〜24℃
  - 夜適性0.85
  - 常夜灯依存0.95
  - 7月の季節値0.85
- 期待する性質: 夜の常夜灯スポットは、同条件の消灯スポットより時間レイヤーが高くなる。

### FISH-005 メバル

- 種別: 確定値
- 実装値:
  - 適水温10〜17℃
  - 夜適性0.95
  - 常夜灯依存0.85
  - 構造依存0.8
  - 1月の季節値0.85
- 期待する性質: 低水温期、夜、常夜灯、テトラ・根等のカバーが正方向。

### FISH-006 ハゼ

- 種別: 現行特性
- `"ハゼ"` は `SPECIES`、`SEASON`、`FISH_KB` に存在せず、対象魚UIには出ない。
- ハゼはベイト知識、スポット説明、公開実績パターンとして使われる。
- `_scat(spot, ms, "ハゼ")` を直接呼ぶと、魚種特性と季節値はシーバスへフォールバックする。
- 確認観点: ハゼを第一級対象魚として追加する場合は新機能であり、現行回帰テストの期待値変更が必要。

### FISH-007 スコア分解

- 種別: 確定値
- 入力: `season=baitLink=terrain=tempS=sup=tide=lt=rain=wind=1`、`cm.score=1`、`confidence=50`
- 期待値:
  - presence `100`
  - bite `100`
  - fishability `100`
  - confidence `50`
- 入力を0〜1に固定した純粋な `scoreDecomp()` テストとして使用する。

### FISH-008 対象魚サポート

- 種別: 確定値
- 期待値:
  - `spot.targets` に対象魚がある場合 `sup=1`
  - ない場合 `sup=0.55`
- 確認観点: 少なくとも季節レイヤーとpresence分解値が下がる。フルスコア差は他レイヤー依存。

## 7. 釣行判断

根拠処理: `windowRangeMs()`、`qwinBestForSpot()`、`cockpitDecision()`、`renderRouteCoach()`、`planRoute()`、`hourlyScores()`、`goldenWindows()`、`render7Day()`。

### DEC-001 短時間枠

- 種別: 確定値
- 入力:
  - `start="21:30"`、`end="23:30"` → `dur=120`
  - `start="23:30"`、`end="01:30"` → 翌日へ繰越し、`dur=120`
- 確認観点: 終了が開始以下なら24時間加算する。

### DEC-002 短時間スポット総合値

- 種別: 確定値
- `qwinBestForSpot()` の合成入力:
  - best total 80
  - avg 60
  - 上位3平均75
  - confidence 70
  - 外部シグナル2件
  - 移動10分
- 期待計算:

```text
80×0.70 + 60×0.12 + 75×0.10 + 70×0.04 + 2×1.2 + 近距離ボーナス2
= 77.9 → Math.round → 78
```

- 期待値: `final === 78`

### DEC-003 短時間判断境界

- 種別: 確定値
- `cockpitDecision(score, fishable, top)`:
  - `top == null` → `"情報不足"`
  - 現地時間24分 → `"見送り寄り"`
  - 25分以上かつscore 78以上 → `"GO推奨"`
  - score 64〜77 → `"条件付きGO"`
  - score 52〜63 → `"偵察寄り"`
  - score 51以下 → `"見送り寄り"`

### DEC-004 2時間ランガン

- 種別: 期待する性質
- `planRoute()`:
  - 上位8スポットだけを候補にする
  - 1〜3スポットの重複なし順列を全探索
  - 各スポット滞在は固定60分
  - 到着20分後の `scat()` を評価
  - ルート価値は各 `score - travelMinutes×0.25` の合計を整数丸め
  - 最大価値のルートを返す
- 現行特性: 2時間枠へ収まるかを `planRoute()` 自体は制約しない。

### DEC-005 撤退時刻

- 種別: 確定値
- `renderRouteCoach()` の第1判断時間:
  - 現地時間95分以上 → 到着から40分
  - 65〜94分 → 32分
  - 64分以下 → 25分
  - ただし終了20分前を超えず、最低15分確保
- 第2地点へ移る条件: 判断時刻から移動後、終了まで22分以上。

### DEC-006 24時間スコア

- 種別: 確定値
- 実行: `hourlyScores(spot, dayStart, 24, 1)`
- 期待値:
  - 24要素
  - 時刻は0〜23時間
  - 各要素は `{ms, t}`
  - `scat()` が例外なら当該 `t=0`

### DEC-007 48時間ゴールデンウィンドウ

- 種別: 確定値
- 対象: 上位3スポット、2時間刻み、48時間で各24点
- 閾値: `max(52, 48時間平均 + 7)`
- 期待する性質:
  - 閾値以上の連続点を一つの区間へ統合
  - 区間内最高値と時刻を保持
  - 最大4区間
  - 同一スポットでピーク時刻差2.5時間未満の重複候補を除外
  - 最終結果は開始時刻順

### DEC-008 7日予測

- 種別: 確定値
- `render7Day()` の評価範囲:
  - 今日から7日
  - `S.spots.slice(0,5)` の5スポットだけ
  - 各日4時、12時、17時、20時、22時の5時刻
  - 25評価中の最高スコアと時刻を表示
- 確認観点: 全スポット・全時刻の探索ではない。

## 8. スポット評価

根拠処理: `STRUCT_KB`、`FISH_KB`、`windFacingFit()`、`trav()`、`trav2()`、`spotProfile()`、`SPOT_INTEL`、`_scat()`。

### SPOT-001 常夜灯

- 種別: 確定値
- 夜の常夜灯加算: `0.12 × fish.light + 0.04`
- 加算値:
  - シーバス `0.124`
  - アジ `0.154`
  - メバル `0.142`
- 結果の時間レイヤーは最大1。

### SPOT-002 地形

- 種別: 確定値
- `STRUCT_KB`:
  - 明暗: `ambush=1.0`
  - 橋脚: `ambush=1.0`、`flow=0.6`
  - 潮通し: `flow=1.0`
  - テトラ・根: `cover=1.0`
- 期待する性質:
  - シーバスは `ambush×0.55 + flow×0.45`
  - アジも通常魚種式を使う
  - メバルは `cover×0.6 + ambush×0.4`
  - 青物はflowだけを使う

### SPOT-003 風表・風裏

- 種別: 確定値
- WIND-005と同じ分類をスポット評価で使用する。
- 期待値:
  - 正面強風8m/s以上 → 0.72
  - 横風6m/s以上 → 0.78
  - 背負える風4m/s以上 → clamp後1
  - シーバス/青物の無風1.5m/s未満 → 既存スコアに0.92を乗算

### SPOT-004 移動時間

- 種別: 確定値
- 式: `round(distanceKm / modeSpeed × 60 × 1.25)`
- 速度: 徒歩4.8km/h、自転車15km/h、車28km/h
- 距離を1kmにスタブした期待値:
  - 徒歩16分
  - 自転車5分
  - 車3分
- 同一座標は距離0、移動0分。

### SPOT-005 足場

- 種別: 実装事実
- 足場、安全、柵、立入可否は `note`、`SPOT_INTEL.avoid`、警告文等のテキスト情報として存在する。
- 独立した `footing` フィールドや足場数値スコアはない。
- `note` 内の「足場良好」「柵なし」だけを変更しても、現行 `_scat()` はそれを直接数値化しない。
- 確認観点: UI分離後も安全注意文を失わない。数値化は別仕様変更。

### SPOT-006 スポット別プロファイル

- 種別: 確定値
- 例:
  - `"花見川河口"` は `hanami_mouth`
  - `"美浜大橋"` は `mihama_bridge`
  - `"堀江ドック"` は `oldedo_mai`
- 期待する性質: 名前の部分一致でプロファイルを選び、得意潮位相、風向、ベイト、撤退案を利用する。

### SPOT-007 候補距離

- 種別: 確定値
- `candidateSpots()` の通常距離上限:
  - 徒歩8km
  - 自転車28km
  - 車95km
- 上限外でも30日以内のシグナルがあるスポット、または `SPOT_TIDE_PROFILE` 登録スポットは候補に残る。

## 9. 外部情報

根拠処理: `relayBase()`、`fetchRelayIntel()`、`aiEndpoint()`、`aiCall()`、`runExternalIntel()`。Worker前提は `SETUP 自動取得.md`。

### EXT-001 Workerなし

- 種別: 確定値
- 前提: 接続モードがproxyでない、またはproxy URLが空
- 期待値:
  - `relayBase() === null`
  - `fetchRelayIntel()` はfetchを呼ばず `null`
  - silentでなければ `"プロキシ(Worker)が未設定です"` を表示

### EXT-002 /intelリクエスト

- 種別: 確定値
- 前提: proxy base `https://example.workers.dev/`
- 期待値:
  - URL `https://example.workers.dev/intel`
  - `POST`
  - `Content-Type: application/json`
  - 本文 `{feeds, target, area:"東京湾奥〜千葉湾岸", useSearch}`
  - HTTP非成功は `"HTTP <status>"` の例外

### EXT-003 /intel応答

- 種別: 期待する性質
- 期待値:
  - `items` の釣果候補を `ingestRelayResponse()` で分類
  - `searchCatches` を外部釣果へ投入
  - `searchEnv` を環境情報へ投入
  - 返却値は `{catch, env, sources}`
  - 実行履歴を `extIntel.runs` の先頭へ追加し、最大30件

### EXT-004 /v1/messages

- 種別: 確定値
- proxy URL `https://example.workers.dev` の期待:
  - `aiEndpoint().url === "https://example.workers.dev/v1/messages"`
  - ヘッダーは `Content-Type: application/json`
- `aiCall()`:
  - `POST`
  - model `"claude-sonnet-4-6"`
  - `max_tokens:1000`
  - `useSearch` 時のみ `web_search_20250305` を追加
  - content中のtextブロックだけを改行結合

### EXT-005 CORS失敗

- 種別: 確定値
- 前提: fetchがreject
- 期待値:
  - `fetchRelayIntel()` または `aiCall()` のPromiseがreject
  - 呼出元UIが失敗トーストまたは接続エラーを表示
  - 成功件数を表示しない
- 現行実装にCORSを回避するクライアント側処理はない。

### EXT-006 APIキー未設定

- 種別: 現行特性
- `mode:"apikey"` でも `apiKey` が空なら、`aiEndpoint()` は既定のAnthropic URLと `Content-Type` だけを返す。
- 事前の「APIキー未設定」例外は投げない。
- 実通信は認証またはブラウザ制約で失敗する可能性が高く、呼出元のエラー表示で判明する。

### EXT-007 JSON・APIエラー

- 種別: 確定値
- `aiCall()`:
  - JSON解析不能 → `"JSON応答なし(HTTP<status>)"`
  - JSONに `error` → `error.message` または `"APIエラー"`
  - contentにtextがない → 空文字列
- `/intel` は `response.json()` 失敗をそのままrejectする。

## 10. 学習・ログ

根拠処理: ログ保存イベント、`parseCatchText()`、`parseCatchBulk()`、`saveForecastSnapshot()`、`validateForecast()`、`validationStats()`、`learnFromLogs()`、`tuningPlan()`、`learnSourceReliability()`。

### LEARN-001 釣果ログ

- 種別: 確定値
- 保存項目:
  - `id`、`spotId`、`ms`、`target`、`quality`、`pin`、観察フラグ、`memo`
  - `snap.month`
  - `snap.tideType`
  - `snap.height`
  - `snap.temp`
- 期待値: `Store.set("logs", S.logs)` の結果を通知へ反映し、成功時だけ `"記録しました"`。

### LEARN-002 釣果テキスト取込

- 種別: 確定値
- 固定現在日: 2026-07-09
- 入力:

```text
7/8 花見川 シーバス 65cm 2本 VJ-16 小潮 下げ ナイト
```

- 期待値:
  - `sp === "シーバス"`
  - `size_cm === 65`
  - `count === 2`
  - `date === "2026-07-08"`
  - `lure === "VJ-16"`
  - `tide === "小潮 下げ"`
  - `light === "ナイト"`
  - 花見川スポットへ部分一致
  - `conf === 0.85`

### LEARN-003 一括取込の重複除外

- 種別: 確定値
- `parseCatchBulk()` の重複キー:

```text
date + spotId + fish + size + count + lure先頭8文字
```

- 同じキーの行は1件だけ残す。
- 空文字列は0件。

### LEARN-004 ログ学習の最低件数

- 種別: 確定値
- 対象: `_ai` でなく、quality 1以上、snapあり
- 3件未満:
  - `S.learn === null`
  - `S.learnInsights === null`

### LEARN-005 ログ学習倍率

- 種別: 確定値
- 入力: 良好ログ3件すべてが大潮または中潮、明暗/常夜灯/橋脚スポット、`bait` あり
- 期待値:
  - `S.learn.tide === 1.15`
  - `lightTime === 1.14`
  - `structure === 1.18`
  - `bait === 1.14`

### LEARN-006 予測保存

- 種別: 確定値
- ID式:

```text
date|target|mode|window.start|window.end
```

- 同一IDは置換、新規IDは先頭追加。
- `createdAt` 降順、最大120件。
- 上位3スポットの順位、スコア、時刻、移動、信頼度、分解値、根拠を保存。

### LEARN-007 予測検証

- 種別: 確定値
- 予測日0:00から3日間を照合。
- 期待値:
  - 1位スポットに正反応 → `hit1`
  - 2位または3位に正反応 → `hit3`
  - 予測から2日未満で自分の不釣果ログなし → `wait`
  - それ以外 → `miss`
- 自分のログはquality 1以上を正反応、quality 0以下を不釣果として扱う。

### LEARN-008 検証率

- 種別: 確定値
- 入力ステータス: `[hit1, hit3, miss, wait]`
- 期待値:
  - checked 3件
  - top1 1件
  - top3 2件
  - top1Rate `33`
  - top3Rate `67`
- `wait` は分母から除く。

### LEARN-009 重み調整

- 種別: 確定値
- 期待値:
  - 検証済み3件未満 → `ready === false`、items空
  - 個別deltaは-5〜+5
  - 適用後の重みは0〜40
  - 過大評価軸と的中率35%以下のレイヤーは減算候補
  - 的中率65%以上のレイヤーは加算候補

### LEARN-010 sourceRep

- 種別: 確定値
- 1件の外部主張、36時間以上経過、同スポット±2日:
  - 自分の正釣果あり: `score=1`、`rate=65`、`mult=1.09`
  - 他ソースだけで裏取り: `score=0.6`、`rate=53`、`mult=1.02`
  - 裏取りなし: `score=0`、`rate=35`、`mult=0.91`
- 式:

```text
rate = (score + 1.2) / (n + 2.4)
mult = Math.max(0.6, Math.min(1.25, 0.7 + 0.6 × rate))
```

### LEARN-011 sourceRep除外

- 種別: 確定値
- 次は学習対象外:
  - 環境情報
  - `manual_catch`
  - 気象庁を含むソース
  - spotIdまたは時刻なし
  - 36時間未満の新しい主張

### LEARN-012 重み適用の保存

- 種別: 確定値
- `applyTuningPlan()`:
  - 変更前後と理由を `tuningHistory` 先頭へ追加
  - 履歴最大50件
  - `settings` と `tuningHistory` の両方を保存
  - 両方成功した場合だけ成功通知

## 11. 自動テスト化の優先順位

### 優先度1: 純粋関数

- `angleDiff()`
- `haversine()`、移動時間式
- `scoreDecomp()`
- `microScore()`
- `cockpitDecision()`
- `forecastSnapshotKey()`
- `sourceReliabilityMult()`

理由: DOM、通信、現在時刻への依存が少なく、固定値を直接比較できる。

### 優先度2: 保存・復旧

- localStorage正常保存
- メモリモード
- 破損退避とキー単位ロック
- 複数キー部分失敗
- 保存通知

理由: データ保護へ直結し、既にStore単体をテストダブルで実行できる構造がある。

### 優先度3: 潮汐

- 固定日時の潮位・流速
- 上げ/下げ/潮止まり
- 満干前後
- 場所別補正

理由: 計算は決定的で、固定日時のゴールデン値を作りやすい。時刻表現と15分探索の現行特性を同時に固定できる。

### 優先度4: 学習・検証

- 釣果テキストパーサ
- 予測照合
- sourceRep
- 重み調整境界

理由: 時刻とStoreを注入すれば決定的。ユーザー履歴から予測へ戻る重要な循環を保護できる。

### 優先度5: スコアと釣行判断

- 魚種知識定数
- レイヤー単位のスコア
- 短時間合成
- 24/48時間ウィンドウ
- 7日予測
- ルート順列

理由: 依存が多いため、フルスコアの巨大なゴールデン値より、レイヤーごとのテストダブルを先に作る。

### 優先度6: 外部通信とUI

- `/intel`
- `/v1/messages`
- CORS・HTTP・JSON失敗
- 描画後のイベント再付与

理由: fetchとDOMの境界分離後に安定する。まずリクエスト契約と失敗伝播を固定する。

## 12. 実装から固定値を確定しなかった箇所

次は実装処理を確認できるが、入力全体を固定できないため単一数値にしていない。

- 実際の日付・スポット・天気・水温・月齢を合成した魚種別最終スコア
- 外部シグナル、実釣ログ、公式情報を含むランキング順位
- 実環境の24/48時間ゴールデンウィンドウ
- 実スポット間の2時間ランガン最適ルート
- 実天気を含む撤退時刻とGO判断
- 実Workerの `/intel` レスポンス内容
- 実Anthropic APIの応答本文
- ブラウザ、Worker設定、許可オリジンに依存するCORS結果
- 実ログから生成されるチューニング提案
- iPhone Safariでの地図、Canvas、ファイル、ストレージ、通信挙動

これらは期待する性質を先に自動化し、匿名化fixtureまたは固定レスポンスが用意できた段階でゴールデン値を追加する。

## 13. 推測・将来構想

以下は現行機能ではなく、自動テスト化時の構成案である。

- 潮汐、魚種レイヤー、移動、判断をDOMから純粋関数として分離する。
- 時計、天気、水温、外部シグナル、Storeを引数またはアダプターで注入する。
- フルスコアは代表日時・代表スポット・代表魚種のJSON fixtureで現行版と比較する。
- Workerは実通信せず、契約fixtureで `/intel` と `/v1/messages` を検証する。
- TypeScript移行時は同一fixtureを旧JavaScript版と新実装へ流して差分を比較する。

スコア、潮汐、API、保存形式を変更する提案ではない。
