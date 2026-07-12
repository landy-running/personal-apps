# wanoku-navi Intelligence Architecture

最終確認日: 2026-07-12  
対象: wanoku-navi / Wanoku PWA / `packages/wanoku-core` / `workers/wanoku-intel-worker`

## 目的

wanoku-navi は、過去の実績ポイントを並べるアプリではなく、公開釣果情報・公的環境データ・地形・魚種生態から、魚の現在位置、移動方向、今後の存在確率を推定する時空間インテリジェンスシステムとして発展させる。

今回の実装範囲は、外部情報の収集・構造化・信頼度評価・将来推論に使う基盤である。legacy HTML の本体UI、既定保存先、外部本番API接続はまだ変更しない。

## 設計原則: 実績ポイント推薦だけにしない

- 「昨日釣れた場所」をそのまま推薦しない。
- 釣果投稿は観測の一種として扱い、環境・地形・魚種生態と統合する。
- 情報源、時刻、地点、鮮度、独立性、転載疑いを分解評価する。
- AIに最終スコアを自由生成させない。AIを使う場合も、抽出事実・根拠・不確実性を構造化する補助に限定する。
- 推論結果は「確定」ではなく、存在確率・移動方向・信頼度・根拠として表示する。
- 釣れなかった情報、古い情報、曖昧な位置情報も、適切に減衰・低信頼として扱う。

## 1. 観測層

役割:

- SNS風投稿、YouTube動画、釣具店釣果、公式情報、手動URL投入を `EvidenceEvent` として正規化する。
- 投稿時刻と実釣時刻を分ける。
- 位置の曖昧さを `LocationEstimate.radiusM` と `locationConfidence` で表す。
- 同一釣果の転載・まとめ・引用を重複候補として返す。

主な型:

- `EvidenceSource`
- `EvidenceEvent`
- `SpeciesObservation`
- `LocationEstimate`

現時点の実装:

- `packages/wanoku-core/src/intelligence.ts`
- `validateEvidenceEvent()`
- `findDuplicateCandidates()`
- `findConflictingEvidence()`
- `fixtures/wanoku-intelligence/evidence-events.json`

## 2. 環境層

役割:

- 水温、潮位、潮汐位相、風、雨、濁り、塩分などを時刻付きで扱う。
- 釣果情報と同じ座標/時間軸にそろえる。
- 公式API/RSS/公開データを優先し、取得失敗を通常ケースとして扱う。

主な型:

- `EnvironmentalSnapshot`

現時点:

- fixtureに公的環境データ風の観測を含めている。
- 本番API接続はまだ行わない。

## 3. 地形層

役割:

- 明暗、流れ、橋脚、ブレイク、河口、運河筋、干潟、常夜灯などを `HabitatFeature` として扱う。
- 地点の「実績」ではなく、魚が現在付きやすい構造として評価する。
- 地図タイル大量キャッシュは行わない。

主な型:

- `HabitatFeature`

現時点:

- 型のみ定義。
- 本格的な地形DB、地図タイル保存、UI表示は未実装。

## 4. 魚種別推論層

役割:

- 魚種ごとに鮮度減衰速度を変える。
- シーバス、チニング、アジ、メバル、ハゼなどで移動性・滞留性・回遊性の違いを反映する。
- 投稿時刻ではなく推定実釣時刻を優先し、実釣時刻不明時は信頼度を下げる。
- 存在確率と移動方向を、根拠付きで返す。

主な型:

- `FishPresenceEstimate`
- `MovementEstimate`
- `PredictionSnapshot`
- `SpeciesFreshnessProfile`

現時点の実装:

- `calculateFreshness()`
- `scoreEvidenceReliability()`
- mock `PredictionSnapshot`

未実装:

- 本格的な魚種別移動モデル
- 潮汐・風・地形を統合した本番スコアリング
- AIによる自由生成スコア

## 5. バックテスト層

役割:

- 予測時点の入力だけで予測し、後から結果と照合する。
- 「当たった/外れた」を魚種、場所、時間帯、潮汐、情報源ごとに分解する。
- 情報源信頼度や魚種別モデルを後から調整する。

主な型:

- `BacktestResult`

現時点:

- 型のみ定義。
- 自動バックテスト基盤は未実装。

## 6. UI層

役割:

- 根拠イベント、信頼度内訳、重複候補、矛盾情報、予測結果を分けて表示する。
- 「なぜここに魚がいる可能性があるか」を説明可能にする。
- 実績ポイント一覧ではなく、現在位置・移動方向・今後の存在確率を地図/時間軸で表現する。

現時点:

- legacy Wanoku HTMLは変更しない。
- Wanoku PWAにもまだ接続しない。
- Worker `/intel` / `/evidence` / `/predictions` はmock/fixtureを返すのみ。

## 7. Worker構成

作成場所:

```text
workers/wanoku-intel-worker
```

endpoint:

| endpoint | 概要 |
|---|---|
| `/health` | 稼働状態、許可origin、mock状態を返す |
| `/sources` | 利用候補情報源の一覧を返す |
| `/intel` | sources / evidence / duplicateCandidates / prediction をまとめて返す |
| `/evidence` | fixture中心のEvidenceEvent一覧を返す |
| `/predictions` | mock PredictionSnapshot を返す |

制約:

- 本番SNS APIには接続しない。
- secretやAPIキーをクライアントへ返さない。
- CORSはWanoku PWA originとlocalhostのみ許可する。
- 地図タイル大量キャッシュはしない。

## 8. 既知の制限

- fixture/mock中心であり、実運用のデータ収集は未接続。
- 重複観測は候補返却までで、自動統合はしない。
- 魚種別推論は鮮度・信頼度の基盤までで、本格モデルではない。
- legacy Wanoku HTML、IndexedDB既定化、PWA画面接続は未実装。

## 9. 次の小さな作業候補

1. Wanoku PWAに `/health` と `/intel` の読み取り専用デモを追加する。
2. `EvidenceEvent` fixtureを魚種別・季節別に増やす。
3. 地形fixtureとして `HabitatFeature` を追加する。
4. 公式環境データの取得先候補を実URLベースで棚卸しする。
5. Backtest用の予測snapshot保存形式を設計する。
