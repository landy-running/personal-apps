# wanoku-navi 現行保存仕様

最終確認日: 2026-07-09  
対象実装: `wanoku-navi/wanoku navi v27 yakou.html`

この文書は現在実装されている `Store` の保存、メモリフォールバック、破損ロック、通知、バックアップ仕様を記録する。将来候補は末尾に分離する。
保存処理について既存の現状設計メモと記述が異なる場合は、実装を再確認した本書を優先する。

## 1. 保存モデルとキー

wanoku-naviは状態を用途別のキーに分けて保存する。起動時に `Store.load()` が読み込むキーは次のとおり。

- `spots`
- `logs`
- `signals`
- `settings`
- `ai`
- `userCatches`
- `forecasts`
- `tuningHistory`
- `observations`
- `fieldDecisions`
- `reviewReports`
- `tripPlans`
- `officialSignals`
- `officialFetchHistory`
- `noFishingNotes`
- `sourceRep`
- `extIntel`
- `lastAutoTuneAt`

通常は各値を個別に `JSON.stringify()` して同名の `localStorage` キーへ保存する。保存形式、キー名、JSON構造は保存安全化対応で変更していない。

初期化時にはlocalStorage利用可否の確認用として `__t` を一時的に書き込み、直後に削除する。

## 2. Store.mode

`Store.mode` は現在の保存先を返す。

| 値 | 意味 |
|---|---|
| `local` | ブラウザの `localStorage` を使用 |
| `ws` | 実行環境が提供する `window.storage` を使用 |
| `mem` | ページ内メモリだけを使用 |

初期値は `mem`。localStorageの試験書込が成功すれば `local` になる。`window.storage.get` が存在する環境では `ws` が優先される。

初期試験でlocalStorageを利用できない場合:

- `Store.mode` は `mem`
- `console.warn('[wanoku storage] localStorage unavailable; using memory only', ...)`
- 画面に「このセッション限りの保存」「設定からバックアップを書き出す」と表示

永続ストレージへの書込が途中で失敗した場合も `enterMemory()` により全体が `mem` へ切り替わる。それ以降の `Store.set()` はページ内メモリへ値を保持し、`false` を返す。

## 3. 読込と検証

`Store.load(keys)` はキーごとにJSON解析と最低限の形状検証を行う。

- 配列必須: `spots`、`logs`、`signals`、`userCatches`、`forecasts`、`tuningHistory`、`observations`、`fieldDecisions`、`reviewReports`、`tripPlans`、`officialSignals`、`officialFetchHistory`、`noFishingNotes`
- オブジェクト必須: `settings`、`sourceRep`、`ai`
- `extIntel`: オブジェクトかつ `runs` が配列
- `lastAutoTuneAt`: 有限数
- `null` は欠損値として許容

正常値は内部 `cache` へ格納され、`Store.get(key)` で取得される。値がないキーや破損キーは `null` となり、起動処理側が既定値を採用する。

読込自体が失敗し、元文字列を得られていない場合:

- `console.error('[wanoku storage] read failed', ...)`
- 永続モードだった場合は `mem` へ移行
- メモリ保存警告を表示

## 4. Store.set() の結果

`Store.set(key, value)` は真偽値を返す。

| 戻り値 | 意味 |
|---|---|
| `true` | `localStorage.setItem()` が完了した、または `window.storage.set()` の非同期処理を受け付けた |
| `false` | 破損ロック、JSON変換失敗、永続書込失敗、またはメモリモード |

`Store.set()` は最初に内部 `cache` を更新する。このため、`false` の場合でも現在のページでは変更が画面へ反映され得る。

保存前には次を出力する。

```text
[wanoku storage] save attempt
```

付随情報は `key`、`bytes`、`kib`、`mib`、`mode`。

永続書込に失敗した場合:

- `console.error('[wanoku storage] persistent write failed; switched to memory', ...)`
- `Store.mode` を `mem` へ変更
- 失敗した値をページ内メモリへ保持
- 画面に「端末への保存に失敗」「このセッション限り」「再起動前にバックアップ」と表示
- `Store.set()` は `false`

すでにメモリモードの場合は、値をページ内メモリへ保持して `false` を返す。初期化失敗理由がないメモリモードでは `console.warn('[wanoku storage] memory-only save', ...)` も出す。

## 5. 破損検知、退避、キー単位ロック

JSON解析またはキー別検証に失敗すると、元文字列を次のキーへ退避する。

```text
<元キー>.corrupt.<timestamp>
```

例:

```text
logs.corrupt.1783600000000
settings.corrupt.1783600000000
```

`<timestamp>` は `Date.now()` のミリ秒値。

退避成功時:

- `console.warn('[wanoku storage] corrupt data archived', ...)`
- 元キー、退避キー、概算サイズ、原因を記録

退避失敗時:

- `console.error('[wanoku storage] corrupt data archive failed', ...)`
- 元文字列はページ内の `corrupt` マップにも保持

成功・失敗にかかわらず元キーを `blocked` セットへ追加し、自動上書きを止める。画面には「破損データを退避しました」または「退避に失敗しました」と、元キーを自動上書きしないことを表示する。

`Store.isBlocked(key)` は、そのキーが現在のページで破損ロック中なら `true` を返す。

破損ロック中に `Store.set(key, value)` を呼ぶと:

- 永続ストレージの元キーは更新しない
- 値はページ内メモリへ保持
- `console.warn('[wanoku storage] write blocked for corrupt key', ...)`
- 画面に「破損データ保護中」「この変更はこのセッション限り」と表示
- `false` を返す

ロックはキー単位であり、他の正常キーは引き続き永続保存できる。

## 6. 保存通知

主要な保存呼出元は `notifyStoreResult(saved, successMessage, keys)` を使用する。以下ではこの関数を `notifyStoreResult()` と表記する。

| 判定 | トースト表示 |
|---|---|
| 対象キーのいずれかで `Store.isBlocked()` が `true` | `破損データ保護中のため保存を停止しています` |
| `saved === true` かつ `Store.mode === 'local'` | 呼出元の成功メッセージ |
| `saved === true` かつlocalStorage以外 | `保存処理を受け付けました` |
| `saved === false` | `一時保存です。このセッション限りの保存です` |

複数キー保存では各 `Store.set()` の結果を配列に集め、`results.every(Boolean)` を通知へ渡す実装がある。このため、一件でも `false` なら成功通知にはならない。

個別トーストを持たない自動保存や内部保存も存在する。その場合は常駐警告とconsole出力が主な検知手段になる。

## 7. ロック解除を伴う明示操作

`Store.allowOverwrite(keys)` は指定キー、または引数なしなら全破損キーを `blocked` から外す。

- `console.warn('[wanoku storage] user-authorized overwrite enabled', ...)`
- 自動処理からは通常呼ばれない
- 現在はバックアップ読込と全消去のユーザー操作で呼ばれる

バックアップ読込は全ロックを解除してから、読込データを現在状態へマージし、複数キーを保存する。全消去も全ロックを解除して既定状態を複数キーへ保存する。

破損検知だけで自動的にロックを解除したり、既定値で元キーを上書きしたりすることはない。

## 8. バックアップ導線

通常バックアップ:

- 設定画面のデータ管理にある `バックアップ`
- ファイル名は `wanoku-v27.json`
- カスタムスポット、実釣ログ、シグナル、釣果、予測、検証・学習関連データ、設定等をJSONで出力
- 標準スポットは全件ではなく、IDが `u` で始まるカスタムスポットだけを出力
- `ai` と `lastAutoTuneAt` は通常バックアップに含まれない

破損元データ:

- 常駐警告の `破損データを書き出す`
- 対象キーの解析前文字列を出力
- ファイル名は `wanoku-corrupt-<元キー>-<detectedAt>.txt`
- 成功時は `console.warn('[wanoku storage] corrupt data exported', ...)`
- 失敗時は `console.error('[wanoku storage] corrupt data export failed', ...)`

警告には `設定でバックアップ` ボタンもあり、設定画面へ移動できる。メモリモード中でも、ページを閉じる前であれば現在の `S` から通常バックアップを書き出せる。

## 9. 複数キー保存

wanoku-naviの複数キー保存はトランザクションではない。

- バックアップ読込や全消去はキーを順番に個別保存する。
- 途中で容量超過等が起きると、それ以前のキーだけ永続化される可能性がある。
- 最終通知は一件でも失敗すれば成功扱いにしないが、すでに成功した書込をロールバックしない。
- localStorageとページ内メモリの状態が部分的に異なる可能性がある。

## 10. console出力一覧

主な識別子:

- `[wanoku storage] localStorage unavailable; using memory only`
- `[wanoku storage] save attempt`
- `[wanoku storage] persistent write failed; switched to memory`
- `[wanoku storage] memory-only save`
- `[wanoku storage] read failed`
- `[wanoku storage] corrupt data archived`
- `[wanoku storage] corrupt data archive failed`
- `[wanoku storage] corrupt data detected; automatic overwrite blocked`
- `[wanoku storage] write blocked for corrupt key`
- `[wanoku storage] user-authorized overwrite enabled`
- `[wanoku storage] corrupt data exported`
- `[wanoku storage] corrupt data export failed`

## 11. 既知のリスク

- 複数キー保存は非トランザクションで、部分成功があり得る。
- `window.storage.set()` は非同期完了前に `true` を返す。後から失敗した場合はメモリモードへ移るが、先に「保存処理を受け付けました」と表示される。
- `Store.set()` が `false` でも内部キャッシュと画面状態は変化し得る。
- 破損退避キーの一覧、削除、再取込を行う管理UIはない。
- バックアップ読込は全破損ロックを解除するため、バックアップに含まれないキーの扱いにも注意が必要。
- 現在の全消去処理は `sourceRep`、`extIntel`、`lastAutoTuneAt` を明示的に消去・保存していない。
- 通常バックアップはすべてのlocalStorageキーを完全複製するものではない。
- localStorageはSafariのプライベートブラウズ、OS都合の削除、容量制限等の影響を受ける。
- iPhone Safari実機でのメモリモード、Blobダウンロード、複数キー部分失敗は自動テストされていない。

## 12. 将来候補: IndexedDB

IndexedDB移行は未実装であり、現行仕様ではない。将来検討する場合は、`Store` の呼出し契約を維持するアダプター、旧localStorageとの並行読込、キー別移行結果、トランザクション失敗、ロールバックを先に設計する必要がある。
