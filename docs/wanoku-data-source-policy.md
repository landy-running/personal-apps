# wanoku-navi Data Source Policy

最終確認日: 2026-07-12  
対象: wanoku-navi intelligence / 外部情報取得 / Worker

## 目的

wanoku-navi の外部情報取得は、公開釣果情報・公的環境データ・地形・魚種生態を安全に扱うためのものです。無断スクレイピングやクライアント側secret保存に依存せず、利用規約とデータ提供者の意図を尊重します。

## 基本方針

- 公式API、公式RSS、公開データセットを優先する。
- 本番SNS APIを初期必須依存にしない。
- X APIを必須依存にしない。
- YouTube、RSS、公式ページ、手動URL投入を初期優先にする。
- APIキー、アクセストークン、secretをクライアントHTMLやlocalStorageへ置かない。
- Cloudflare Worker等のサーバー側でsecretを保持する。
- Workerは許可origin、入力サイズ、接続先、レート、エラー出力を制限する。
- 外部レスポンスをそのままUIや状態へ入れず、構造化・検証・信頼度評価を通す。

## 優先する情報源

1. 公的環境データ
   - 気象、風、雨、水温、潮位、河川、海況など
   - 公式API/RSS/公開CSV/公開JSONを優先する
2. 釣具店・船宿・施設の公式釣果
   - RSS、公式API、公開ページの明示利用可能範囲を優先する
3. YouTube
   - 動画公開時刻と実釣時刻を分ける
   - 動画概要欄、タイトル、手動URL投入から構造化する
4. 手動URL投入
   - ユーザーが見つけた公開情報を手動で登録する
   - 自動収集できない情報の初期導線にする
5. SNS
   - 公式APIや規約に沿った利用のみ
   - X APIは必須依存にしない
   - スクリーンショットや転載まとめを一次情報として過信しない

## 避けること

- robots.txtや利用規約に反する無断スクレイピング
- ログインが必要なページの無断収集
- 非公開投稿や個人情報の収集
- 投稿者名、顔、車両、詳細住所などの不要な個人情報保存
- APIキーやsecretをHTML、PWA、localStorage、バックアップJSONへ入れること
- AIに根拠なしで最終スコアを自由生成させること
- 地図タイルを大量キャッシュして規約や端末容量を圧迫すること

## 構造化時の注意

外部情報は `EvidenceEvent` として扱い、最低限次を分ける。

- `publishedAt`: 投稿・公開時刻
- `observedAt`: 推定実釣時刻
- `species`: 魚種・数・サイズ・行動
- `location`: 推定地点・半径・信頼度
- `sourceReliability`: 情報源信頼度
- `timeConfidence`: 時刻精度
- `locationConfidence`: 地点精度
- `freshness`: 鮮度
- `duplicateGroupId`: 転載/同一釣果候補
- `evidenceUrl`: 根拠URL
- `extractedFacts`: 抽出した事実

投稿時刻と実釣時刻が違うケースでは、鮮度評価は実釣時刻を優先する。実釣時刻が不明な場合は不確実性を下げる。

## 信頼度評価

信頼度は合計点だけでなく、以下の内訳を保持する。

- 情報源信頼度
- 時刻精度
- 地点精度
- 鮮度
- 独立性
- 再投稿疑い

同一URL、同一sourceId、近似日時、近似地点、類似魚種・サイズ・文章はduplicate候補として扱う。ただし完全自動確定ではなく、UIや後続処理が確認できる候補として返す。

## Worker方針

`workers/wanoku-intel-worker` は初期段階ではmock/fixture中心にする。

endpoint:

- `/health`
- `/sources`
- `/intel`
- `/evidence`
- `/predictions`

制約:

- 本番SNS APIへまだ接続しない。
- secretをクライアントへ返さない。
- CORSはWanoku PWA originとlocalhostのみ許可する。
- エラーにsecretや生レスポンスを混ぜない。

## 今後の導入順

1. 手動URL投入とfixtureで構造化形式を固める。
2. 公式環境データを読み取り専用で接続する。
3. YouTube/RSSなど規約上扱いやすい情報源を追加する。
4. 情報源ごとに利用規約、取得間隔、保存項目をdocsに明記する。
5. APIキーが必要な連携はWorker secretで管理する。
6. バックテストで精度と過学習を確認してからUI上の推薦を強める。
