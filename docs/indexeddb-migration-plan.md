# IndexedDB 移行設計メモ

最終確認日: 2026-07-10  
対象: RunOS PWA / Wanoku PWA

この文書は、RunOS PWA / Wanoku PWA の保存層を現在の localStorage demo から IndexedDB へ段階移行するための設計メモである。ここに書く内容は設計であり、この時点では IndexedDB 実装・既存HTML変更・PWA本体変更を行わない。

優先順位は既存方針どおり、保存安全性 → ロジック分離 → テスト → UI移行 とする。

## 1. 現在の保存状態

### 実装済みの事実

RunOS PWA は、legacy の `meridian.v1` には接続していない。PWA demo 専用の localStorage key だけを使っている。

| 用途 | key |
|---|---|
| RunOS PWA demo settings | `runos-pwa.demo.settings` |
| RunOS PWA 軽量ラン記録 | `runos-pwa.demo.runLogs` |
| Wanoku PWA demo settings | `wanoku-pwa.demo.settings` |
| Wanoku PWA 軽量釣果ログ | `wanoku-pwa.demo.catchLogs` |

`packages/storage` には `LocalStorageAdapter` と保存契約があり、主に次を扱う。

- `StorageMode`: `local` / `memory` / `blocked` / `async-pending`
- `SaveResult`: `success` / `memory` / `blocked` / `failed` / `asyncAccepted`
- JSON parse 失敗の検知
- `<key>.corrupt.<timestamp>` 形式の破損退避
- localStorage 書込失敗時の memory mode
- 保存前JSONサイズの概算
- 破損ロック中の保存ブロック

バックアップ/復元 demo は次の envelope を使う。

```ts
{
  backupType: string,
  appId: "runos" | "wanoku-navi",
  schemaVersion: string,
  createdAt: string,
  data: unknown,
  checksum: {
    algorithm: "byte-length-and-char-sum-v1",
    bytes: number,
    sum: number
  }
}
```

復元時は、JSON破損、`backupType` 不一致、`appId` 不一致、`schemaVersion` 不一致、checksum 不一致、data validation 失敗を拒否する。

RunOS PWA の軽量ラン記録は `packages/runos-core` に型と作成関数がある。

```ts
type LightweightRunLog = {
  id: string;
  date: string;
  distanceKm: number;
  durationSec: number;
  avgPace: number;
  note: string;
  painLevel?: number;
};
```

Wanoku PWA の軽量釣果ログは `packages/wanoku-core` に型と作成関数がある。

```ts
type LightweightCatchLog = {
  id: string;
  date: string;
  spotName: string;
  targetFish: string;
  result: string;
  lure: string;
  note: string;
};
```

### 設計上の前提

- legacy HTML の保存キーは当面そのまま残す。
- PWA demo key と legacy key はまだ混ぜない。
- IndexedDB 移行後も、バックアップJSON書き出しは必須導線として残す。
- iPhone Safari では IndexedDB も消失・容量不足・アップグレード失敗があり得るため、IndexedDB は「唯一の安全策」ではなく、バックアップと組み合わせて使う。

## 2. RunOS の IndexedDB 設計

### DB 基本方針

| 項目 | 設計 |
|---|---|
| DB名 | `runos-pwa` |
| 初期DB version | `1` |
| appId | `runos` |
| 最初の対象 | `settings` と `runLogs` |
| legacy接続 | 初期実装では `meridian.v1` に接続しない |

RunOS は将来的に FIT 由来の大きなデータ、ラップ、GPS/心拍などの時系列、分析キャッシュを扱うため、単一JSONではなく object store を分ける。

### object store 案

| store | 主な用途 | keyPath / key | 主な index | 備考 |
|---|---|---|---|---|
| `settings` | PWA設定、保存設定、移行状態 | `id` | `updatedAt` | `id: "default"` の singleton を基本にする |
| `runLogs` | 軽量ラン記録 | `id` | `date`, `createdAt` | 現在の `LightweightRunLog` の移行先 |
| `activities` | FIT/CSV/手入力由来の活動本体 | `id` | `date`, `source`, `sport`, `importedAt` | legacy の activities 相当を将来移行 |
| `laps` | activity ごとのラップ | `id` | `activityId`, `lapIndex` | `id = activityId + ":" + lapIndex` などを想定 |
| `streams` | GPS/心拍/ペース/パワー等の時系列 | `id` | `activityId`, `streamType` | 大きい配列は必要に応じて chunk 分割 |
| `analysisCache` | TRIMP/CTL/ATL/TSB/eVO2max等の派生結果 | `id` | `cacheKey`, `activityId`, `computedAt` | 再計算可能な値のみ置く |
| `shoes` | シューズ管理 | `id` | `active`, `updatedAt` | 活動との紐付けは activity 側にも参照を持つ |
| `races` | 目標レース、計画 | `id` | `date`, `priority` | シーズンプラン移行時に利用 |

### RunOS データ分離方針

- `activities` は活動のメタデータを持つ。巨大な stream は直接持たない。
- `laps` と `streams` は `activityId` で参照する。
- `analysisCache` は再生成可能な派生データとして扱い、バックアップ必須データとは分ける。
- FIT import は最初の IndexedDB adapter 実装範囲に含めない。
- 将来 FIT を扱う場合も、parse 中の巨大データを `onupgradeneeded` 内で処理しない。

## 3. Wanoku の IndexedDB 設計

### DB 基本方針

| 項目 | 設計 |
|---|---|
| DB名 | `wanoku-pwa` |
| 初期DB version | `1` |
| appId | `wanoku-navi` |
| 最初の対象 | `settings` と `catchLogs` |
| legacy接続 | 初期実装では legacy Store keys に接続しない |

Wanoku はスポット、釣果、予測、外部情報、学習状態の依存関係が強い。localStorage の複数キー保存はトランザクションではなかったため、IndexedDB では関連 store を同一 transaction で更新できるようにする。

### object store 案

| store | 主な用途 | keyPath / key | 主な index | 備考 |
|---|---|---|---|---|
| `settings` | PWA設定、既定魚種、エリア、保存設定 | `id` | `updatedAt` | `id: "default"` の singleton を基本にする |
| `spots` | 釣り場、地形、常夜灯、足場等 | `id` | `area`, `updatedAt`, `favorite` | legacy `spots` 相当の将来移行先 |
| `catchLogs` | 軽量釣果ログ | `id` | `date`, `targetFish`, `spotName` | 現在の `LightweightCatchLog` の移行先 |
| `predictions` | 24/48時間、7日予測など | `id` | `targetFish`, `spotId`, `startsAt`, `createdAt` | 計算条件とバージョンを保存する |
| `externalIntel` | 外部情報取得結果、要約、取得履歴 | `id` | `provider`, `fetchedAt`, `expiresAt` | APIキーやsecretは保存しない |
| `sourceReputation` | 情報源の信頼度 | `sourceId` | `updatedAt` | legacy `sourceRep` 相当 |
| `learningState` | 重み調整、検証結果、学習状態 | `id` | `scope`, `updatedAt` | `id: "default"` または魚種別scope |

### Wanoku データ分離方針

- `catchLogs` は軽量ログとして単独で保存できるようにする。
- `predictions` は再計算可能なキャッシュに近い扱いにし、計算ロジックの version と入力条件を持たせる。
- `externalIntel` は TTL を持たせ、古い外部情報を最新事実として扱わない。
- APIキー、secret、アクセストークンは IndexedDB に保存しない。
- Cloudflare Worker が未実装の間は、外部API取得結果を前提にした保存設計にしない。

## 4. スキーマバージョン

IndexedDB には DB version と、バックアップ envelope の `schemaVersion` がある。混同しない。

| 種類 | 用途 | 例 |
|---|---|---|
| IndexedDB DB version | `indexedDB.open(name, version)` の upgrade 判定 | `1`, `2`, `3` |
| app storage schema | アプリ内データ構造の互換性判定 | `runos-idb-v1` |
| backup schemaVersion | JSON backup の復元可否判定 | `runos-pwa-demo-data-v1` |
| analysis/cache version | 派生計算結果の再計算判定 | `runos-analysis-v1` |

初期実装では次を推奨する。

- RunOS DB version 1: `settings`, `runLogs`
- Wanoku DB version 1: `settings`, `catchLogs`
- FIT、潮汐、スコアリング、外部API、Worker連携は DB version 1 に含めない。
- schema を変える時は、先に backup/restore と migration test を追加する。

## 5. マイグレーション方針

### 共通原則

1. 旧データを即削除しない。
2. 移行前に backup JSON を書き出せる状態にする。
3. 移行は parse/validate → write → read-back validate → read priority 切替の順に行う。
4. write 失敗時は IndexedDB を中途半端な正と見なさない。
5. 移行結果と失敗理由を `SaveResult` 相当で表現する。
6. 破損データは上書きせず、退避またはファイル書き出し導線を出す。
7. 大きな移行は一括ではなく、store単位・機能単位で小さく行う。

### 推奨フロー

```text
localStorage demo key
  -> JSON parse
  -> shape validation
  -> backup export available
  -> IndexedDB transaction write
  -> IndexedDB read-back validation
  -> settings に migration status を記録
  -> 次回起動時の read priority を IndexedDB 優先へ変更
```

移行成功後も、一定期間は localStorage の元keyを削除しない。削除する場合は、ユーザー確認、バックアップ済み確認、rollback方針を別途用意する。

## 6. バックアップ/復元方針

### IndexedDB 後のバックアップ

IndexedDB 移行後も、現在の backup envelope 方針を継続する。

- `backupType`
- `appId`
- `schemaVersion`
- `createdAt`
- `data`
- `checksum`

IndexedDB 版では `data` の中に store 単位の payload を入れる。

```ts
type RunosIndexedDbBackupDataV1 = {
  settings: unknown;
  runLogs: unknown[];
};

type WanokuIndexedDbBackupDataV1 = {
  settings: unknown;
  catchLogs: unknown[];
};
```

将来の本格版では、store count、exported store names、app storage schema、source backend などの manifest 情報を追加する。ただし既存の demo backup と混同しないよう、`backupType` と `schemaVersion` は分ける。

### 復元方針

- `appId` 不一致は復元しない。
- `schemaVersion` 不一致は自動復元しない。
- checksum 不一致は復元しない。
- 復元前に現在の IndexedDB データを書き出せる導線を出す。
- 復元は対象 store を同一 transaction で更新する。
- 一部 store だけ成功した状態を成功扱いしない。
- 破損ロック中の key/store は、明示操作なしに上書きしない。

## 7. localStorage から IndexedDB への移行順序

### Phase 0: 設計と契約

- `packages/storage` に IndexedDB adapter の契約を追加する。
- `SaveResult` / `StorageMode` / `CorruptBackupInfo` を再利用する。
- async API を前提にし、呼び出し側が保存完了前に成功通知を出さない形にする。

### Phase 1: PWA demo key の移行

最初は legacy データに触れず、PWA demo key だけを対象にする。

1. RunOS: `runos-pwa.demo.settings` → `settings`
2. RunOS: `runos-pwa.demo.runLogs` → `runLogs`
3. Wanoku: `wanoku-pwa.demo.settings` → `settings`
4. Wanoku: `wanoku-pwa.demo.catchLogs` → `catchLogs`

この段階で、IndexedDB adapter、backup/restore、破損退避、容量不足表示の基本動作を確認する。

### Phase 2: PWA の保存先切替

- 新規保存は IndexedDB 優先にする。
- localStorage demo key は fallback / rollback 用に残す。
- UIには保存先、最終保存時刻、バックアップ導線を表示する。

### Phase 3: legacy 読込の検討

RunOS legacy:

- `meridian.v1` を直接上書きしない。
- 読み取り専用 import として parse/validate する。
- `activities`, `laps`, `streams`, `shoes`, `races` へ分離する前に、代表データで期待値を固定する。

Wanoku legacy:

- 既存 Store keys を直接上書きしない。
- key単位に parse/validate し、破損keyは `<元キー>.corrupt.<timestamp>` 方針を維持する。
- `spots`, `catchLogs`, `predictions`, `externalIntel`, `sourceReputation`, `learningState` への対応表を先に作る。

### Phase 4: legacy との並行期間

- PWA と legacy HTML は一定期間併存する。
- 双方向同期は初期範囲に含めない。
- legacy へ戻れるよう、backup JSON と legacy HTML を残す。

## 8. 破損時・容量不足時・部分失敗時の扱い

### 破損時

- JSON parse 失敗、shape validation 失敗は破損として扱う。
- localStorage 由来の破損は現行どおり `<key>.corrupt.<timestamp>` に退避する。
- IndexedDB record の shape validation 失敗は、対象 store / key / reason を記録し、上書きしない。
- 破損状態では、ユーザー操作なしに正常初期値で上書きしない。
- 画面には「破損データを検知しました」「バックアップを書き出してください」を出す。

### 容量不足時

- `QuotaExceededError` または同等の書込失敗を `quota-exceeded` として扱う。
- 成功通知を出さない。
- 元データを削除しない。
- 大きい store、特に RunOS の `streams` と `analysisCache` は保存サイズをログに出す。
- `analysisCache` は再生成可能なため、必要なら最初に削減候補にできる。ただし自動削除は別設計にする。

### 部分失敗時

- 複数 store を更新する処理は、可能な限り同一 readwrite transaction に入れる。
- transaction abort 時は全体失敗として扱う。
- Wanoku の予測・外部情報・学習状態のような関連データは、一部だけ成功した状態を成功通知にしない。
- localStorage fallback と IndexedDB の二重書込を行う場合は、どちらが正かを settings に記録し、曖昧にしない。

## 9. iPhone Safari での注意点

- IndexedDB は iPhone Safari でも容量制限、低ストレージ時の削除、Private Browsing、OS都合のデータ消失があり得る。
- ホーム画面追加版と通常Safariタブで、保存領域・起動条件・Service Worker状態を別々に確認する。
- `onupgradeneeded` では重い処理をしない。store作成・index作成だけに留める。
- transaction 中に長い `await` を挟むと transaction が閉じる可能性があるため、書込データは事前に準備してから短い transaction で保存する。
- version upgrade は別タブ・別ホーム画面インスタンスが開いていると blocked になり得る。blocked 表示と再起動案内を用意する。
- Blob backup のダウンロード、ファイル選択、復元は iPhone Safari 実機で確認する。
- 大きな FIT / stream 保存は UI フリーズの原因になる。parse と保存の分割、進捗表示、将来の Worker 化を前提にする。
- Cache Storage と IndexedDB を混同しない。個人データは Service Worker cache に入れない。
- APIキーやsecretは IndexedDB にも localStorage にも保存しない。

## 10. 最初に実装すべき IndexedDB adapter の範囲

最初の実装は、PWA demo の保存先を安全に切り替えるための最小範囲に限定する。

### adapter 契約

`packages/storage` に、localStorage adapter と並ぶ async adapter を追加する。

最小メソッド案:

```ts
type IndexedDbJsonAdapter<Key extends string> = {
  readonly mode: StorageMode;
  open(): Promise<void>;
  loadJson<T>(key: Key, validate: (value: unknown) => value is T): Promise<LoadJsonResult<Key, T>>;
  saveJson<T>(key: Key, value: T): Promise<SaveResult<Key>>;
  delete(key: Key): Promise<SaveResult<Key>>;
  archiveCorruptValue(key: Key, rawValue: string, reason: string): Promise<CorruptBackupInfo<Key>>;
};
```

実際の型名は実装時に決めてよいが、次は必須にする。

- `SaveResult` を返す。
- 保存完了前に成功扱いしない。
- JSON parse / shape validation 失敗を検知する。
- 保存サイズを返す。
- quota / blocked / unknown error を区別できる。
- appId 不一致の backup は復元しない。
- テストでは fake IndexedDB 相当、または薄いモックを使い、iPhone Safari 実機確認を別に残す。

### 初期対象 store

RunOS:

- `settings`
- `runLogs`

Wanoku:

- `settings`
- `catchLogs`

初期対象外:

- RunOS の FIT import
- RunOS の `activities`, `laps`, `streams`, `analysisCache`, `shoes`, `races` の本格移行
- Wanoku の潮汐、スコアリング、予測、外部API、Worker連携
- legacy key の自動移行
- 双方向同期

## 11. 次の小さな作業候補

1. `packages/storage` に IndexedDB adapter の TypeScript 契約だけを追加する。
2. IndexedDB adapter 用のエラー分類と `SaveResult` 変換テストを追加する。
3. RunOS PWA demo の `settings` / `runLogs` を IndexedDB に保存する opt-in demo を作る。
4. Wanoku PWA demo の `settings` / `catchLogs` を IndexedDB に保存する opt-in demo を作る。
5. backup JSON に IndexedDB store counts と schema 情報を含める v2案を作る。

