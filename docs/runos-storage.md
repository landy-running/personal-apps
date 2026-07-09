# RunOS 現行保存仕様

最終確認日: 2026-07-09  
対象実装: `runos/RunOS v100 apex.html`

この文書は現在実装されている保存、破損検知、通知、復旧の仕様を記録する。将来候補は末尾に分離し、現行仕様には含めない。
保存処理について既存の現状設計メモと記述が異なる場合は、実装を再確認した本書を優先する。

## 1. 保存モデルとキー

- 永続化先はブラウザの `localStorage`。
- 主キーは `meridian.v1`。
- グローバル状態 `DB` 全体を `JSON.stringify(DB)` し、単一の文字列として保存する。
- プロフィール、活動、ウェルネス、計画、シューズ、環境、レース、FIT由来ストリーム等が同じキーに入る。
- 正常データのJSON形式と主キー名は、保存安全化対応の前後で変更していない。

読込時はJSONのルートがオブジェクトであることと、`activities`、`wellness` が配列であることを必須条件として検証する。その他の一部プロパティは読込後に既定値で補完する。

## 2. 通常の読込

`load()` は次の順で動作する。

1. `localStorage.getItem('meridian.v1')` を実行する。
2. 値があればJSON解析と必須項目の検証を行う。
3. 正常なら `DB` に採用し、任意項目の既定値を補う。
4. `console.info('[RunOS storage] loaded', ...)` に概算サイズを出す。

主キーが存在しない場合は、デモデータを生成して通常の `save()` を呼ぶ。この経路では「保存データが見つからないため、デモデータを生成しました」と警告する。デモデータの保存にも失敗した場合は、その失敗とバックアップ書き出しの案内を表示する。

`localStorage.getItem()` 自体が例外になった場合は、デモデータをメモリ上へ一時表示する。この経路では読込エラーを `console.error` に出し、「保存領域を読み込めない」「自動保存は行っていない」「設定からバックアップを書き出せる」ことを画面に表示する。

## 3. 通常の保存

`save()` の戻り値は真偽値である。

| 戻り値 | 意味 |
|---|---|
| `true` | `localStorage.setItem('meridian.v1', json)` が同期的に完了した |
| `false` | リカバリロック、JSON変換失敗、またはlocalStorage書込失敗で主キーを更新できなかった |

保存前にはJSON文字列のサイズを概算し、次を出力する。

```text
[RunOS storage] save attempt
```

付随情報は `key`、`bytes`、`kib`、`mib`。Blobが利用できない場合は文字列長の2倍を概算値とする。

JSON変換に失敗した場合:

- `console.error('[RunOS storage] JSON serialization failed', ...)`
- 画面に「データの変換中に保存に失敗しました」
- 設定からバックアップを書き出すよう案内
- `save()` は `false`

localStorage書込に失敗した場合:

- `console.error('[RunOS storage] localStorage write failed', ...)`
- 画面に「保存に失敗しました」と概算MB数
- 設定からバックアップを書き出すよう案内
- `save()` は `false`

RunOSにはwanoku-naviの `Store.mode` に相当する永続的なモード変数はない。ただし、読込失敗時または破損リカバリ中の `DB` はページ内メモリにだけ存在する状態になり得る。

## 4. 保存通知

主要な保存呼出元は `notifySaveResult(save(), successMessage)` を使用する。

`notifySaveResult()` の表示は次のとおり。

| 状態 | トースト表示 |
|---|---|
| `save()` が `true` | 呼出元が渡した成功メッセージ |
| `save()` が `false` かつリカバリ中 | `リカバリ中のため保存を停止しています` |
| その他の `false` | `保存できませんでした` |

関数は受け取った保存結果をそのまま返す。Undo付き処理等はこの戻り値を確認し、保存成功時だけ成功UIを出す実装になっている。

すべての内部 `save()` 呼出元が `notifySaveResult()` を使うわけではない。個別通知がない経路でも、`save()` 自体の警告UIとconsole出力は動作する。

## 5. 破損検知と退避

次の場合を破損として扱う。

- `meridian.v1` のJSON解析失敗
- JSONルートがオブジェクトではない
- `activities` が配列ではない
- `wellness` が配列ではない

破損時は元の文字列を次の別キーへ退避する。

```text
meridian.v1.corrupt.<timestamp>
```

`<timestamp>` は `Date.now()` のミリ秒値。

退避成功時:

- `console.warn('[RunOS storage] corrupt data archived', ...)`
- 元キー、退避キー、概算サイズ、検知原因を記録

退避失敗時:

- `console.error('[RunOS storage] corrupt data archive failed', ...)`
- 退避キー候補と原因を記録
- 元文字列はページ内のリカバリ状態にも保持する

続いて `STORAGE_RECOVERY.active` を有効にし、デモデータを `seedDemo(false)` で一時表示する。この時点では `meridian.v1` をデモデータで上書きしない。

## 6. リカバリ中の保存ブロック

`STORAGE_RECOVERY.active` の間、`save()` は主キーへ書き込まない。

- `console.warn('[RunOS storage] save blocked until recovery choice is confirmed', ...)`
- 画面に破損データの退避状態と「自動保存は停止」と表示
- `save()` は `false`
- `notifySaveResult()` は「リカバリ中のため保存を停止しています」を表示

画面には次の明示操作を出す。

- `破損データを書き出す`
- `デモデータで再開始`

`デモデータで再開始` は確認ダイアログに同意した場合だけ、一時的にロックを解除して現在のデモデータを `meridian.v1` へ保存する。保存に成功した場合だけ再開始を確定し、退避キーは削除しない。保存に失敗した場合はリカバリロックを復元する。

したがって、破損検知直後にユーザー操作なしで主キーをデモデータへ置き換えることはない。

## 7. バックアップ導線

通常バックアップ:

- 設定画面の `JSONで書き出し`
- 現在メモリ上にある `DB` を整形JSONで出力
- ファイル名は `runos-backup-YYYY-MM-DD.json`

破損元データ:

- 破損警告の `破損データを書き出す`
- 解析前の元文字列をテキストとして出力
- ファイル名は `runos-corrupt-<detectedAt>.txt`
- 成功時は `console.warn('[RunOS storage] corrupt data exported', ...)`
- 失敗時は `console.error('[RunOS storage] corrupt data export failed', ...)`

通常バックアップと破損元データの書き出しは用途が異なる。リカバリ中の通常バックアップは一時表示中のデモ状態を含み得るため、破損した元文字列の保全には専用ボタンを使う。

JSON取込は設定画面の `JSONを取り込み` から行う。現実装はファイルをJSON解析して `DB` へ代入した後に `save()` を呼ぶが、`load()` と同じ必須配列検証は行っていない。

## 8. console出力一覧

主な識別子:

- `[RunOS storage] loaded`
- `[RunOS storage] no saved data; generating demo data`
- `[RunOS storage] save attempt`
- `[RunOS storage] localStorage read failed`
- `[RunOS storage] JSON serialization failed`
- `[RunOS storage] localStorage write failed`
- `[RunOS storage] corrupt data archived`
- `[RunOS storage] corrupt data archive failed`
- `[RunOS storage] corrupt data detected; demo data is temporary and saves are blocked`
- `[RunOS storage] save blocked until recovery choice is confirmed`
- `[RunOS storage] corrupt data exported`
- `[RunOS storage] corrupt data export failed`
- `[RunOS storage] user restarted with demo data`
- `[RunOS storage] restart with demo data failed`

## 9. 既知のリスク

- 全データを単一キーへ同期保存するため、データ増加に伴いUI停止や容量超過が起こり得る。
- 保存はトランザクションや世代管理を持たず、主キーの直前正常版は自動保持されない。
- 退避キーの一覧表示、削除、再取込を行う管理UIはない。
- JSON取込時のスキーマ検証が読込時より弱い。
- リカバリ中も画面上の `DB` は変更できるが、主キーには保存されない。
- localStorageはSafariのプライベートブラウズ、OS都合の削除、容量制限等の影響を受ける。
- iPhone Safari実機での容量上限、Blobダウンロード、復旧操作は自動テストされていない。

## 10. 将来候補: IndexedDB

IndexedDB移行は未実装であり、現行仕様ではない。将来検討する場合も、`meridian.v1` を即時削除せず、保存アダプター、移行結果の検証、ロールバック、FITストリームとメタデータの分離を先に設計する必要がある。
