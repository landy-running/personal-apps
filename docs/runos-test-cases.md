# RunOS 代表テストケース

最終確認日: 2026-07-09  
対象実装: `runos/RunOS v100 apex.html`  
保存仕様: `docs/runos-storage.md`

## 1. 目的と読み方

この文書は、RunOSの計算ロジックを将来JavaScriptから分離し、TypeScript化または自動テスト化するときの回帰基準である。現在の実装から確認できる仕様だけを基準にしている。

ケースの期待値は次の2種類に分ける。

- **確定値**: 現行の式と固定入力から数値または文字列を一意に算出できる。
- **期待する性質**: 日付、FIT実ファイル、他の計算結果等に依存し、単一の固定値にすべきでない。境界、型、単調性、不変条件を確認する。

「改善後はこうあるべき」という推測はテスト期待値に混ぜない。現行実装上の不自然な挙動も、変更判断が済むまでは特性テストとして明記する。

## 2. 将来のテスト共通条件

自動テスト化するときは、ケースごとにグローバル `DB`、`STORAGE_RECOVERY`、localStorage、現在日時を初期化する。

標準プロフィール:

```js
{
  sex: "m",
  hrRest: 44,
  hrMax: 189,
  thresholdPaceSec: 255,
  weightKg: 62
}
```

推奨する比較許容差:

- 秒、距離、整数化済み値: 完全一致
- TRIMP、VO2、CTL、ATL、TSB、ACWR: `1e-6`
- 回帰計算のCS、D′: `1e-9` または相対誤差 `1e-9`
- 表示文字列: 完全一致

日付依存関数ではローカルタイムを固定する。例では特記がなければ `todayISO() = "2026-07-06"`、月曜日として扱う。

## 3. ペース変換

根拠関数: `paceStr()`、`hms()`、`paceFromRun()`、`speedMPS()`、`speedMMin()`

### PACE-001 距離と時間から秒/km

- 種別: 確定値
- 入力: `{ km: 10, durSec: 3000 }`
- 実行: `paceFromRun(activity)`
- 期待値: `300`
- 確認観点: 単位は秒/km。丸めは行わない。

### PACE-002 秒/kmからmin/km表示

- 種別: 確定値
- 入力: `300`
- 実行: `paceStr(300)`
- 期待値: `"5:00"`
- 数値としてのmin/km: `300 / 60 = 5`
- 確認観点: 秒部分は2桁ゼロ埋め。

### PACE-003 平均ペースと速度の整合

- 種別: 確定値
- 入力: `{ km: 5, durSec: 1475 }`
- 期待値:
  - `paceFromRun()` = `295`
  - `paceStr()` = `"4:55"`
  - `speedMPS()` = `5000 / 1475`、約 `3.3898305085`
  - `speedMMin()` = 上記×60、約 `203.3898305085`
- 確認観点: `1000 / speedMPS` と秒/kmが一致する。

### PACE-004 表示時の丸め

- 種別: 確定値
- 入力と期待値:
  - `paceStr(299.4)` → `"4:59"`
  - `paceStr(299.6)` → `"5:00"`
  - `paceStr(0)` → `"—"`
  - `paceStr(Infinity)` → `"—"`
- 確認観点: `paceStr()` は最初に秒を整数へ丸める。

### PACE-005 不正な距離

- 種別: 期待する性質
- 入力: `{ km: 0, durSec: 3000 }`
- 現行特性: `paceFromRun()` は入力検証をせず `Infinity` になる。
- 確認観点: 将来バリデーションを追加する場合は、計算関数の仕様変更として扱う。

## 4. 保存・復旧

根拠関数: `load()`、`save()`、`archiveCorruptData()`、`notifySaveResult()`、`restartWithDemoData()`。詳細は `docs/runos-storage.md`。

### STORE-001 正常保存

- 種別: 確定値
- 前提: `STORAGE_RECOVERY = null`、`localStorage.setItem()` が成功
- 実行: `save()`
- 期待値:
  - 戻り値 `true`
  - 書込キー `"meridian.v1"`
  - 書込値は `JSON.stringify(DB)`
  - `console.info` に `[RunOS storage] save attempt`
- 確認観点: 正常なJSON形状とキー名を変えない。

### STORE-002 localStorage書込失敗

- 種別: 確定値
- 前提: `localStorage.setItem()` が `QuotaExceededError` を投げる
- 期待値:
  - `save()` は `false`
  - `console.error` に `[RunOS storage] localStorage write failed`
  - 画面に「保存に失敗しました」と概算MB数
  - バックアップ書き出しを案内
  - `notifySaveResult(false, "保存しました")` は `"保存できませんでした"` を表示

### STORE-003 破損JSONの退避

- 種別: 確定値
- 前提: `meridian.v1` の値が `"{broken"`
- 実行: `load()`
- 期待値:
  - JSON解析失敗を検知
  - `meridian.v1.corrupt.<timestamp>` へ元文字列を保存
  - 元の `meridian.v1` は変更しない
  - `STORAGE_RECOVERY.active === true`
  - `seedDemo(false)` によりデモをメモリ上へ表示
  - `console.error` に破損原因と退避キー
- 確認観点: `<timestamp>` は `Date.now()` のミリ秒値。

### STORE-004 必須配列欠落

- 種別: 確定値
- 入力例: `{"profile":{},"activities":[]}`。`wellness` が欠落。
- 期待値: JSONとしては妥当でも破損扱いとなり、STORE-003と同じ退避・ロック処理へ進む。
- 確認観点: `activities` と `wellness` は両方とも配列必須。

### STORE-005 リカバリ中の保存ブロック

- 種別: 確定値
- 前提: `STORAGE_RECOVERY = { active:true, corruptKey:"meridian.v1.corrupt.123" }`
- 実行: `save()`
- 期待値:
  - 戻り値 `false`
  - `localStorage.setItem('meridian.v1', ...)` は呼ばれない
  - `console.warn` に `[RunOS storage] save blocked until recovery choice is confirmed`
  - 通知は `"リカバリ中のため保存を停止しています"`

### STORE-006 明示的なデモ再開始

- 種別: 期待する性質
- 前提: リカバリ中、確認ダイアログに同意
- 期待する性質:
  - ユーザー同意前に主キーを書き換えない
  - 同意後のみロックを一時解除して `save()` する
  - 成功時も退避キーを削除しない
  - 保存失敗時は元のリカバリ状態を復元する

## 5. FIT取込

根拠関数: `parseFit()`、`finalize()`、`importFitFiles()`、`inferType()`。

実FITバイナリの固定fixtureはリポジトリにない。パーサ単体では合成FITまたは匿名化fixture、取込制御では `parseFit()` のスタブを使う。

### FIT-001 複数ファイルの独立処理

- 種別: 確定値
- 入力: 4ファイルを順に返すスタブ
  1. 正常なラン
  2. 1と同じ `unixStart`・距離
  3. `sport = 2` の非ラン
  4. `parseFit()` が例外
- 期待値:
  - 正常取込 `ok = 1`
  - スキップ `dup = 2`。重複と非ランが同じスキップカウンタへ入る。
  - 失敗 `fail = 1`
  - ファイルごとの失敗で後続処理を止めない
  - 全ファイル処理後に `save()` を1回呼ぶ
  - 通知は `1件取込 · 2件スキップ · 1件失敗`
- 重複ID: `fit<unixStart>_<Math.round(km * 100)>`

### FIT-002 ラップの単位変換

- 種別: 確定値
- FIT生値:

```js
{ dist: 100000, elapsed: 300000, avgSpd: 3333, avgCad: 85 }
```

- 期待値:
  - `dist = 1000` m
  - `elapsed = 300` 秒
  - `avgSpd = 3.333` m/s
  - `avgCad = 170` spm
- 確認観点: 心拍、最大心拍、パワー、上昇量は利用可能なら保持する。ラップなしは空配列。

### FIT-003 GPS

- 種別: 期待する性質
- 期待する性質:
  - 緯度・経度の両方があり、緯度が無効値でなく、該当点が11点以上なら `gps` を生成
  - 10点以下なら `gps === null`
  - semicircle値を度へ変換し、小数5桁に丸める
  - ダウンサンプル後も最後の点を必要に応じて追加する
- 現行特性: コメントは「300点以下」だが、最後の点の追加により最大301点になり得る。

### FIT-004 心拍の優先順位

- 種別: 確定値
- 期待値:
  - セッション平均心拍 `s[16]` があれば `avgHr` に採用
  - なければ移動サンプルの心拍平均を整数丸め
  - セッション最大心拍 `s[17]` があれば `maxHr` に採用
  - なければ移動サンプルの最大値
  - どちらにもなければ `null`

### FIT-005 欠損値

- 種別: 期待する性質
- ケース:
  - FIT無効値は `readField()` で `null`
  - レコードが0件なら `"レコードがありません"` の例外
  - GPS欠損は `gps === null`
  - 心拍欠損は `avgHr === null`、`maxHr === null`
  - パワー欠損は `avgPwr`、`xPower`、`VI`、`pwrCurve` が `null`
  - ラップ欠損は `laps` が空配列
- 確認観点: 一項目の欠損だけでFIT全体を失敗させない。

### FIT-006 ストリーム保存上限

- 種別: 期待する性質
- 期待値: 保存用 `stream` は `step = ceil(stream.length / 600)` で間引かれ、おおむね600点以下になる。
- 確認観点: 各点は `[経過秒, 距離m, 速度, GAP速度, 心拍, ケイデンス, パワー, 標高, 勾配]` の順。

### FIT-007 現行の時間選択に関する特性

- 種別: 現行特性
- 実装事実: 移動時間集計は `stream[i].t` を参照するが、構築したstream要素には `et` が格納されている。
- 現行の期待: `movingSec > 60` にならず、`durSec` は通常 `total_timer_time`、なければ経過時間を使う。
- 確認観点: `t`/`et` を修正する場合は計算結果が変わるため、単なるリファクタリングではなく明示的な仕様変更として扱う。

## 6. トレーニング分類

根拠関数: `categoryV77()`。標準プロフィールを使用し、`detectIntervals()` が反応しない単純入力とする。

分類の主な優先順位は、名称によるレース、検出インターバル、VI/最大心拍、Long、明示Recovery、心拍またはLT近傍のTempo、Easy、短時間低負荷Recovery、既定Easy。

### CLASS-001 Recovery

- 種別: 確定値
- 入力: `{ km:3, durSec:1200, note:"回復ジョグ", name:"", hrAvg:null }`
- 期待値: `type === "recovery"`

### CLASS-002 Easy

- 種別: 確定値
- 入力: `{ km:10, durSec:3000, note:"", name:"", hrAvg:null }`
- ペース: 300秒/km、LTより45秒遅い
- 期待値: `type === "easy"`

### CLASS-003 Tempo

- 種別: 確定値
- 入力: `{ km:5, durSec:1350, note:"", name:"", hrAvg:null }`
- ペース: 270秒/km、LT+15秒/km、14分以上
- 期待値: `type === "tempo"`

### CLASS-004 LT

- 種別: 確定値
- 入力: `{ km:5, durSec:1275, note:"LT", name:"", hrAvg:null }`
- ペース: 255秒/km
- 期待値: `type === "tempo"`
- 実装事実: 保存カテゴリに独立した `"lt"` はない。LT走は `tempo`、計画上は `@T` または `thresholdQ` として表現される。

### CLASS-005 Interval

- 種別: 確定値
- 入力: `{ km:8, durSec:2400, VI:1.08, note:"", name:"", hrAvg:null }`
- 期待値: `type === "interval"`
- 別経路: `detectIntervals()` が3本以上の疾走区間を返す場合もInterval。

### CLASS-006 Long

- 種別: 確定値
- 入力A: `{ km:18, durSec:5400 }`
- 入力B: `{ km:12, durSec:5400 }`
- 期待値: どちらも `type === "long"`。条件は18km以上または90分以上。

### CLASS-007 分類優先順位

- 種別: 確定値
- 入力: `{ km:18, durSec:6000, note:"回復ジョグ" }`
- 期待値: `type === "long"`
- 確認観点: Long判定が明示Recovery判定より先。

## 7. 負荷指標

根拠関数: `trimp()`、`pmc()`、`acwr()`、`monotonyStrain()`。

### LOAD-001 心拍ありTRIMP

- 種別: 確定値
- 入力: 標準プロフィール、`{ durSec:3600, km:12, hrAvg:150 }`
- 計算:
  - `HRr = (150 - 44) / (189 - 44) = 0.7310344827586207`
  - 男性係数 `c=0.64`、`k=1.92`
- 期待値: `TRIMP = 114.24542876699854`

### LOAD-002 心拍なしTRIMP

- 種別: 確定値
- 入力: 標準プロフィール、`{ durSec:3600, km:12, hrAvg:null }`
- 計算:
  - ペース300秒/km
  - `IF = 255 / 300 = 0.85`
  - 代替 `HRr = 0.5 × 0.85 + 0.35 = 0.775`
- 期待値: `TRIMP = 131.78413064020725`

### LOAD-003 一定負荷のCTL・ATL・TSB

- 種別: 確定値
- 入力: 全日負荷50の系列
- 期待する性質:
  - 初期seedは最初の最大14日平均で50
  - 各日のCTL、ATLは50
  - TSBは0

### LOAD-004 PMC更新順序の特性

- 種別: 現行特性
- 入力: 初期seed 50、日次負荷 `[100, 0]`
- 期待値:
  - 1日目: `ctl=51.19047619047619`、`atl=57.142857142857146`、保存される `tsb=0`
  - 2日目: `ctl=49.971655328798185`、`atl=48.9795918367347`、保存される `tsb=-5.952380952380956`
- 実装事実: 各行の `tsb` は、その日のCTL/ATL更新前に計算される。同じ行の更新後 `ctl-atl` とは一致しない。

### LOAD-005 ACWR

- 種別: 確定値
- ケース:
  - 直近28日が毎日50 → `ACWR = 1`
  - 直近7日が毎日100、その前21日が0 → acute=100、chronic=25、`ACWR = 4`
  - chronicが0 → `ACWR = 0`

### LOAD-006 単調性とストレイン

- 種別: 確定値
- 入力: 直近7日 `[0,0,0,0,0,0,70]`
- 期待値:
  - mean `10`
  - SD `24.49489742783178`
  - monotony `0.408248290463863`
  - weekSum `70`
  - strain `28.577380332470412`

### LOAD-007 完全に一定な週

- 種別: 現行特性
- 入力: 直近7日がすべて50
- 期待値:
  - 実SDが0のため内部で `0.001`
  - monotony `50000`
  - weekSum `350`
  - strain `17500000`
- 確認観点: 上限処理はない。将来の安定化は明示的な計算仕様変更となる。

## 8. 走力指標

### PERF-001 単一ランのeVO2max

- 種別: 確定値
- 根拠関数: `runVO2()`、`effectiveVO2max()`
- 入力: 標準プロフィール、同日実施の `{ km:10, durSec:3000, hrAvg:150, type:"easy" }`
- 計算:
  - 速度 `200 m/min`
  - `VO2(v) = 36.0116`
  - `HRr = 0.7310344827586207`
- 期待値:
  - `runVO2()` = `49.261150943396224`
  - 有効な対象がこの1件だけなら `effectiveVO2max().value` も同値
  - `samples === 1`

### PERF-002 eVO2maxの対象期間と除外

- 種別: 期待する性質
- 期待値:
  - 基準日より未来、または42日より古い活動は除外
  - 心拍なしは除外
  - 算出値が25以下または95以上なら除外
  - 新しい活動ほど `exp(-age/20)` により重い
  - Easy、Long、Tempoは分類品質係数1、それ以外は0.8

### PERF-003 Critical Speed回帰

- 種別: 確定値
- 根拠関数: `cpFit()`、`criticalSpeed()`
- 合成曲線: 各時間 `t` に `speed = 4 + 200/t` を与える。対象時間は120〜1800秒から3点以上。
- 期待値:
  - `C = 4 m/s`
  - `K = 200 m`
  - `criticalSpeed()` は `{ cs:4, dprime:200 }`
  - 完全一致データの `r2 = 1`

### PERF-004 閾値検出

- 種別: 確定値
- 根拠関数: `thresholdDetect()`
- 入力: 120、180、300、600、900、1200秒に `speed = 4 + 200/t`
- 期待値:
  - `cs = 4 m/s`
  - `dPrime = 200 m`
  - `tPaceSec = 250`
  - `csKmh = 14.4`
  - `mPaceSec = 265`
  - `iPaceSec = 232.5`
  - 動的範囲条件を満たすため信頼度 `"高"`

### PERF-005 Critical Speedデータ不足

- 種別: 確定値
- 入力: 有効な持続時間点が2点以下
- 期待値: `cpFit()` と `thresholdDetect()` はモデルを確定できず `null`

### PERF-006 耐久性

- 種別: 確定値
- 根拠関数: `durabilityScore()`
- 入力: 8km以上で `decoupling` が `[3,6,9]` の3活動
- 期待値:
  - `avgDec = 6`
  - `score = 50`
  - `samples = 3`
- データが3件未満なら `null`。
- 性質: 平均デカップリングが大きいほどスコアは下がり、0〜100に制限される。

## 9. シーズンプラン

根拠関数: `generatePlan()`、`RACE_DEFS`。日付を固定し、現在の活動を空にする。

### PLAN-001 目標レース基本情報

- 種別: 確定値
- 入力:

```js
{
  name: "秋のハーフ",
  date: "2026-09-28",
  dist: "half",
  goal: "1:30:00"
}
```

- 前提: `todayISO() = "2026-07-06"`、現在の週間距離は活動なしのため下限12km
- 期待値:
  - `race.label === "ハーフ"`
  - `race.m === 21097.5`
  - `weeks.length === 12`
  - `startVol === 12`
  - `peak === 24`
  - `season === true`

### PLAN-002 期分け

- 種別: 確定値
- PLAN-001の期待値:
  - ベース5週
  - ビルド3週
  - ピーク2週
  - テーパー2週
  - フェーズ順は `base → build → peak → taper`
- 確認観点: テーパー週数はハーフの定義値2。作業週の45%をBase、20%をPeakへ丸め、残りをBuildにする。

### PLAN-003 吸収週と週間距離

- 種別: 期待する性質
- 期待値:
  - テーパー以外の4週ごとが吸収週候補
  - レース直前を除き、吸収週は通常ランプ値の75%
  - テーパーは残り3/2/1週に応じてピークの75%/62%/45%
  - 各週の `target` は整数丸め
  - `peak` は距離別上限を超えない

### PLAN-004 週次キーメニュー

- 種別: 確定値
- 期待する `workouts.kind`:
  - Base: `long`、`strides`
  - Build: `tempo`、`long`
  - Peak: `interval`、`race`
  - Taper: `sharpen`、`race`
- 確認観点: ペースと心拍の表示文字列は、VDOTと個人ゾーンの有無で変わるため完全一致では固定しない。

### PLAN-005 未対応距離

- 種別: 確定値
- 入力: `dist:"ultra"`
- 期待値: `generatePlan()` は `null`

## 10. 故障リスク

根拠関数: `acwr()`、`monotonyStrain()`、`loadRiskV77()`。

### RISK-001 急増負荷

- 種別: 確定値
- 現行加点:
  - mechanical ACWR > 1.45 → +26
  - 1.25超〜1.45以下 → +13
  - cardio ACWR > 1.45 → +16
  - neuro ratio > 1.65 → +12
  - 直近Quality > 18km → +16
- 境界確認: 比較は `>=` ではなく `>`。

### RISK-002 痛み入力

- 種別: 確定値
- 前提: その他のrisk加点条件はすべて不成立
- 最新wellnessの `soreness`:
  - 4以上 → +26
  - 3以上4未満 → +12
  - 3未満 → 加点なし
- 現行特性: 痛み4だけならrisk 26で、ゲートはまだ `GO`。痛み入力単独でSTOPにはならない。

### RISK-003 その他の加点

- 種別: 確定値
- 条件:
  - 回復残り時間 > 8時間 → +14
  - Readiness < 42 → +22
- 境界確認: 8時間ちょうど、42ちょうどは加点しない。

### RISK-004 ゲート境界

- 種別: 確定値
- 期待値:
  - risk 0〜33 → `GO`
  - 34〜54 → `SHORTEN`
  - 55〜75 → `PROTECT`
  - 76〜100 → `STOP`
- riskは全加点後に整数丸めし、0〜100へ制限する。

### RISK-005 単調性・ストレイン連携

- 種別: 実装事実
- `monotonyStrain()` は画面上の故障シグナルだが、`loadRiskV77()` のrisk加点には直接使われていない。
- 確認観点: 将来統合する場合はRISKゲートの出力が変わるため、別変更として扱う。

## 11. 自動テスト化の優先順位

### 優先度1: 純粋関数と固定式

- ペース・速度変換
- TRIMP
- `cpFit()`、Critical Speed
- 耐久性スコア
- 分類境界の単純ケース

理由: DOM、日付、localStorageへの依存が少なく、固定入力と数値期待値をそのまま単体テストにできる。

### 優先度2: 保存・復旧

- 正常保存
- 容量超過
- 破損JSON退避
- 必須配列欠落
- リカバリロック
- 明示的なデモ再開始

理由: ユーザーデータ保護に直結する。localStorage、console、警告表示をテストダブルへ置き換えれば自動化しやすい。

### 優先度3: 負荷系列と分類

- PMC、ACWR、単調性、ストレイン
- `categoryV77()` の優先順位
- `loadRiskV77()` の加点とゲート

理由: 現在日時とグローバルDBを固定する必要があるが、計算自体は決定的。PMCのTSB更新順序や一定負荷時の単調性など、意図せず変わりやすい特性を先に固定できる。

### 優先度4: シーズンプラン

- 目標レース定義
- 期分け
- 吸収週
- テーパー
- 週次メニュー種別

理由: 時計、現在の週間距離、VDOT、心拍ゾーンを注入可能にすれば安定する。表示文全文ではなく構造を先にテストする。

### 優先度5: FIT

- 合成FITによるscale変換
- 匿名化fixtureによるラップ、GPS、心拍、欠損値
- 複数ファイル、重複、部分失敗

理由: バイナリfixtureの準備が必要。取込制御は `parseFit()` をスタブ化して先行できる。

## 12. 実装から固定値を確定しなかった箇所

次は実装仕様を確認できるが、環境または実データ依存のため固定数値にしていない。

- 実FITファイルから得られるラップ数、GPS点列、心拍、移動時間
- `detectIntervals()` が実ストリームから返す疾走区間
- 複数活動を重み付けしたeVO2max
- `perfVO2max()` が複数の走力ソースから最終採用する値
- 実データのCritical SpeedとLT心拍
- VDOT・心拍ゾーンを含むシーズンプランの表示文全文
- 現在日時と既存活動に依存する週間距離、計画開始日、推奨メニュー
- 複数の故障リスク要因が同時に存在する実ユーザーの最終risk
- iPhone SafariでのlocalStorage容量、ファイル選択、Blobダウンロード挙動

これらは「期待する性質」を先に自動化し、匿名化された実データfixtureが用意できた時点でゴールデン値を追加する。

## 13. 推測・将来構想

以下は現行実装ではなく、テスト化時の構成案である。

- 計算関数へ `DB`、現在日、プロフィールを引数で渡し、DOMから分離する。
- FITパーサテスト用に、最小合成FITと匿名化した実機FITをfixture化する。
- 現行HTMLから得た代表結果をJSONゴールデンファイルとして保存する。
- TypeScript移行時は先に入出力型を付け、同じケースをJavaScript版とTypeScript版へ流す。

計算式、分類境界、保存形式を変更する提案ではない。
