# dencho-archive インフラ設計（AWS CDK v2）

電子帳簿保存法（電帳法）対応の証憑アーカイブ基盤を、サーバレス構成で AWS 上に構築する
ための CDK v2 スタック定義です。このドキュメントは「何を・なぜ・いくらで」作るのかを
まとめた、インフラの設計書兼運用ガイドです。

- 対象リージョン: `ap-northeast-1`（東京）
- 認証情報・ネットワークなしで **`npx cdk synth` / `node dist/cdk/synth-cli.js` が通る**（合成専用のダミーアカウントを使用）
- 実際の `cdk deploy` には AWS 認証情報が必要（後述）

> 免責: 本リポジトリはリファレンス実装であり、法的助言ではありません。最終的な
> 要件判断は税理士・顧問の専門家にご確認ください。

---

## 1. スタック構成

4 スタックを一方向の依存関係で積む。循環参照は無い。

```text
                    ┌─────────────────────────────┐
                    │      dencho-storage         │
                    │  S3(Object Lock) / KMS      │
                    │  DynamoDB x3                │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      dencho-compute         │
                    │  Lambda x4 / SQS DLQ        │
                    │  IAM(最小権限) / アラーム   │
                    └───────┬──────────────┬──────┘
                            │              │
          ┌─────────────────▼──┐       ┌───▼──────────────────────┐
          │  dencho-guardrails │       │     dencho-workflow      │
          │  CloudTrail        │       │  Step Functions (batch)  │
          │  ログ用 S3(Object   │       │  EventBridge (daily)     │
          │  Lock) / Dashboard │       │                          │
          └────────────────────┘       └──────────────────────────┘
```

| スタック | 役割 | リソース数 |
|---|---|---:|
| `dencho-storage` | WORM 保存層（証憑データ・台帳・索引） | 7 |
| `dencho-compute` | 実行層（4 Lambda + DLQ + 監視） | 28 |
| `dencho-guardrails` | 監査証跡（CloudTrail + 監視ダッシュボード） | 5 |
| `dencho-workflow` | バッチ取り込み + 日次チェーン検証 | 5 |
| **合計** | | **45** |

合成結果は `InfraSnapshot`（`{ stacks: { スタック名: CfnTemplate } }`）として
`synthAll()` が返し、適合性検証エンジン（`src/compliance/`）のインフラ要件
（INF-01..INF-10）の入力になる。**同一入力に対して同一 JSON** を返す（決定的）。

---

## 2. リソース一覧と重要プロパティ

### 2.1 `dencho-storage`

| リソース | 設定 | 電帳法・セキュリティ上の意味 |
|---|---|---|
| **S3 バケット**（証憑アーカイブ） | `ObjectLockEnabled: true`<br>`ObjectLockConfiguration.Rule.DefaultRetention = COMPLIANCE / 2557 日`<br>`VersioningConfiguration.Status = Enabled`<br>`BucketEncryption = aws:kms`（カスタマー管理 KMS キー、バケットキー有効）<br>`PublicAccessBlock` 4 項目すべて `true`<br>`OwnershipControls = BucketOwnerEnforced`<br>`DeletionPolicy/UpdateReplacePolicy = Retain` | 真実性の確保（WORM）と 7 年保存。ACL を無効化し、公開アクセスを全面禁止。TLS 強制ポリシー付き |
| **S3 バケットポリシー** | `Effect: Deny` / `Action: s3:*` / `Condition.Bool["aws:SecureTransport"] = "false"` | 平文 HTTP を全面拒否（`enforceSSL`）。AWS Foundational Security Best Practices の S3.5 相当 |
| **KMS キー + エイリアス** | `EnableKeyRotation: true`<br>エイリアス `alias/dencho-archive`<br>`DeletionPolicy/UpdateReplacePolicy = Retain` | 証憑の機密性確保。自動ローテーション。キー削除不可（RETAIN） |
| **DynamoDB `dencho-voucher-index`** | pk/sk 複合キー、`PAY_PER_REQUEST`、PITR 有効、SSE 有効、削除保護、RETAIN | 検索要件（取引年月日・金額・取引先）の 5 索引を 1 テーブルに格納 |
| **DynamoDB `dencho-audit-log`** | 同上 + DynamoDB ストリーム `NEW_AND_OLD_IMAGES` | 追記専用の監査ログ。ストリームで「いつ誰が何をしたか」の変化履歴を残す |
| **DynamoDB `dencho-chain-checkpoints`** | 同上 | ハッシュチェーンの検証済みチェックポイント。改ざん検知の基準点 |

**2557 日の根拠**: 法定保存期間は 7 年。単純な 365×7=2555 日では、うるう年を 2 回
またぐケースで最大 2 日不足し得るため、うるう日 2 日を加えた **2557 日**を既定値と
している。Object Lock の default retention として設定するため、**アップロード時に
ヘッダを付け忘れても全オブジェクトに自動適用**される。

### 2.2 `dencho-compute`

| リソース | 設定 |
|---|---|
| Lambda `dencho-ingest` | runtime `nodejs22.x` / arm64 / timeout 60s / memory 1024MB / DLQ 付き / 非同期再試行 2 回・最大 6 時間 |
| Lambda `dencho-search` | runtime `nodejs22.x` / arm64 / timeout 15s / memory 512MB |
| Lambda `dencho-export` | runtime `nodejs22.x` / arm64 / timeout 60s / memory 1024MB |
| Lambda `dencho-verify` | runtime `nodejs22.x` / arm64 / timeout 300s / memory 1024MB |
| ロググループ x4 | `/aws/lambda/dencho-*`、保持 **731 日**、RETAIN |
| SQS DLQ | `dencho-ingest-dlq`、保持 14 日、SSE（`alias/aws/sqs`）、TLS 強制 |
| CloudWatch アラーム x9 | 各関数の **Errors / Throttles**（計 8）+ DLQ 滞留（1） |
| IAM | 実行ロール x4 とインラインポリシー x4。**AWS マネージドポリシー不使用** |

Lambda のコードは `lambda.Code.fromAsset(handlersDir)` でビルド済み JavaScript
（`dist/handlers/`）をアセットとして同梱する。`handlersDir` の既定値は
**パッケージルート探索**（`import.meta.dirname` から `package.json` を探索）で
`<packageRoot>/dist/handlers` に解決される。

### 2.3 `dencho-guardrails`

| リソース | 設定 | 意味 |
|---|---|---|
| CloudTrail Trail | マルチリージョン、グローバルサービスイベント含む、ログファイル検証有効、管理イベント All | 「誰が何をしたか」の証跡 |
| CloudTrail データイベント | 証憑バケットの S3 オブジェクト（読み取り・書き込み = `All`） | 証憑の閲覧・書き込み履歴まで残す |
| S3 バケット（CloudTrail ログ専用） | Object Lock `COMPLIANCE / 2557 日`、バージョニング、パブリックアクセス全面ブロック、TLS 強制、RETAIN | ログ自体も改ざんできない（Object Lock） |
| CloudWatch アラーム | namespace `DenchoArchive` / metric `ChainVerificationFailure` / 閾値 1 / `notBreaching` | チェーン検証失敗の即時検知 |
| CloudWatch Dashboard | `dencho-archive-operations` | Lambda 呼び出し・エラー・スロットル、チェーン検証失敗、DLQ 滞留を一画面で |

CloudTrail のログバケットは **SSE-S3（AES256）** で暗号化する。CloudTrail サービス
自身が書き込むため、カスタマー管理キーを使う場合はキーポリシーに
`cloudtrail.amazonaws.com` の許可を追加する必要がある。機密性の高い証憑データは
別途 **CMK** で暗号化しており、ログは監査証跡としての真正性（Object Lock）を優先した。

### 2.4 `dencho-workflow`

| リソース | 設定 |
|---|---|
| Step Functions ステートマシン | `dencho-batch-import`、**Map**（`$.items`、最大 5 並列）+ **Retry**（指数バックオフ `BackoffRate: 2`）+ **Catch**（`States.ALL` → 失敗パス） |
| EventBridge ルール | `dencho-daily-chain-verification`、`cron(0 18 * * ? *)` = **毎日 03:00 JST**、検証 Lambda を起動（再試行 2 回） |
| Lambda Permission | EventBridge からの `lambda:InvokeFunction` をルールに限定 |

> EventBridge の cron は **UTC** で評価される。日本には夏時間が無いため
> `18:00 UTC = 翌 03:00 JST` で固定できる。

---

## 3. IAM 設計（最小権限）

基本方針:

1. **`Action: "*"` / `Resource: "*"` を一切使わない。** すべての権限は具体的な API 名と
   リソース ARN（バケット ARN・オブジェクト ARN・テーブル ARN・キー ARN・ロググループ ARN）で指定する。
2. **AWS マネージドポリシー（`AWSLambdaBasicExecutionRole` 等）に頼らない。**
   ログ書き込みすら「対象ロググループ ARN 限定」のインラインポリシーで付与する。
3. **削除系の権限を誰にも与えない。** 特に `s3:DeleteObject` / `s3:DeleteObjectVersion` /
   `s3:PutBucketPolicy` はどの実行ロールにも存在しない。
4. 役割ごとに **読み取り / 書き込み / 検証** を分離する。

| 関数 | S3 | DynamoDB | KMS | その他 |
|---|---|---|---|---|
| `dencho-ingest` | `s3:PutObject`（`objects/*`・`metadata/*` のみ） | `dynamodb:PutItem`（voucher-index / audit-log） | `Decrypt` + `GenerateDataKey` | `sqs:SendMessage`（DLQ）、ログ書き込み |
| `dencho-search` | `GetObject` / `GetObjectVersion` / `ListBucket` | `GetItem` / `Query`（voucher-index） | `Decrypt` のみ | ログ書き込み |
| `dencho-export` | 同上（読み取り） | `GetItem` / `Query` / `Scan`（voucher-index） | `Decrypt` のみ | ログ書き込み |
| `dencho-verify` | 同上（**読み取り専用**） | `GetItem` / `Query` / `ConditionCheckItem`（index / checkpoints）、`PutItem`（**checkpoints のみ**） | `Decrypt` のみ | ログ書き込み |

補足:

- **verify がチェックポイントにだけ書き込む理由**: 毎日の検証結果（検証済み sequence と
  entryHash）を残さないと「いつ時点で健全だったか」を証明できない。書き込み先は
  `chain-checkpoints` テーブルに限定し、証憑（S3）は読み取り専用のままにする。
- **export の `dynamodb:Scan`**: 税務調査の「ダウンロードの求め」では期間・取引先を
  跨いだ全件出力が必要になる場合がある。対象を単一テーブルに限定したうえで許可する。
- **Step Functions の CloudWatch Logs 出力を有効化しない理由**: `logs:CreateLogDelivery`
  などの Logs 配管 API はリソースレベル権限に対応しておらず、`Resource: "*"` が必須に
  なる。最小権限方針を優先し、実行履歴（Step Functions 側で 90 日保持）と CloudTrail で
  監査する。
- **CloudWatch のカスタムメトリクス**: `cloudwatch:PutMetricData` はリソース指定不可の
  ため付与しない。検証 Lambda は **EMF（Embedded Metric Format）** の JSON をログに
  書き出し、CloudWatch Logs が自動的に `DenchoArchive / ChainVerificationFailure` を
  メトリクス化する（ハンドラ側の実装規約）。

---

## 4. ログ保持設計（Lambda ログ 731 日のトレードオフ）

CloudWatch Logs の保持期間は最大 **10 年（`RetentionDays.TEN_YEARS` = 3653 日）** だが、
電帳法の保存期間 7 年（2557 日）と比べると「ログだけで 7 年を担保する」設計は
コストと上限の両面で現実的ではない。そこで:

- Lambda のアプリケーションログは **731 日（`RetentionDays.TWO_YEARS`）** 保持する
  （短期の障害調査・監査に十分）。
- **長期の監査証跡**は以下で担保する:
  - CloudTrail の管理イベント + 証憑バケットの S3 データイベント → Object Lock 付き
    専用バケットへ **7 年**（改ざん不可）
  - 監査ログ（DynamoDB `dencho-audit-log`）とハッシュチェーン台帳 → RETAIN + PITR
    で 7 年
  - 証憑そのもの → S3 Object Lock COMPLIANCE 2557 日
- 法令上、長期保存が求められるのは「証憑データ（真実性の確保）」と「検索・ダウンロード
  要件を満たす台帳・索引」であり、Lambda の実行ログそのものではない。この整理により
  CloudWatch Logs のコストを抑えつつ、監査に必要な証跡を欠かさない。

将来、アプリケーションログを 7 年保管する要件が生じた場合は、CloudWatch Logs
サブスクリプションフィルタ → Kinesis Firehose → Object Lock 付き S3（既存の
CloudTrail ログバケットと同じ設定）で移送する拡張が可能な構成にしてある。

---

## 5. Object Lock はなぜ COMPLIANCE モードなのか + リーガルホールド

| モード | 上書き・短縮・削除 | 用途 |
|---|---|---|
| GOVERNANCE | `s3:BypassGovernanceRetention` を持つ主体（管理者・root）は解除可能 | 誤操作防止。**真実性の証明には弱い** |
| **COMPLIANCE** | **root を含む誰も短縮・削除できない**（保持期間中） | 電帳法の「真実性の確保」に適合 |

- 本実装は **COMPLIANCE モード + 2557 日**を既定とする。電子帳簿保存法が求める
  「改ざん・削除の防止」を、権限管理ではなく **S3 側の強制力**で担保するため。
  IAM で一部管理者だけが解除できる GOVERNANCE では、「管理者が解除できる＝真実性を
  外部証明できない」弱さが残る。
- **リーガルホールド**は、保存期間とは独立して「係争・調査などで無期限に凍結する」
  追加機構である。本実装では 7 年保持（COMPLIANCE）で法定要件を満たすため既定では
  付与しないが、税務調査・訴訟対応で「保存期間経過後の保持」が必要になった場合は、
  対象オブジェクトに legal hold を付与できる（その際は書込み用の IAM 権限
  `s3:PutObjectLegalHold` を別途、限定的に付与する）。**証憑を書き込む Lambda には
  legal hold の権限を与えない**（運用者が明示的に実施する管理操作とする）。
- バケットは **バージョニング有効**（Object Lock の前提）。**`autoDeleteObjects` は
  設定しない**（スタック削除でオブジェクトを消してしまうため WORM と矛盾する）。
  CloudFormation の削除ポリシーもすべて **RETAIN**。

---

## 6. オフライン合成（認証情報なし）の設計

`cdk synth` は「テンプレートを生成するだけ」であり、AWS への API 呼び出しは不要である。
本実装はその前提を守るため、次の **禁止事項**を設けている:

- ❌ `Vpc.fromLookup` / `Bucket.fromBucketName` / `HostedZone.fromLookup` などの lookup
- ❌ `Aws.accountId` / `Aws.region`（トークン環境依存値）
- ❌ コンテキストプロバイダ（`app.node.tryGetContext` でネットワーク取得するもの）
- ❌ 存在しないアカウントの SSM パラメータ参照

代わりに:

- 既定値はコード上のダミーアカウント `111122223333` / リージョン `ap-northeast-1`。
  実デプロイ時だけ `DENCHO_ACCOUNT` / `DENCHO_REGION` で上書きする。
- CDK のアセット（Lambda コード）もローカルファイルからステージングするだけ。
- `synthAll()` は一時ディレクトリへ合成し、終了時に削除する。同一入力なら同一 JSON。

```bash
# 合成だけ（認証情報・ネットワーク不要）
npm run build
node dist/cdk/synth-cli.js | head          # JSON スナップショット
npx cdk synth                              # cdk.out/ に 4 テンプレート
node dist/cdk/app.js                       # 直接実行でも cdk.out/ に合成

# 実デプロイ（要: 認証情報 + bootstrap 済みアカウント）
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1
DENCHO_ACCOUNT=<ACCOUNT_ID> npx cdk deploy --all
```

> `npx cdk deploy` は **AWS 認証情報とネットワークが必要**。このリポジトリの CI は
> `cdk synth` と適合性検証までをオフラインで実行する（デプロイは行わない）。

---

## 7. 監視・アラーム

| アラーム | 条件 | 意図 |
|---|---|---|
| `dencho-{ingest,search,export,verify}-errors` | AWS/Lambda Errors ≥ 1（5 分） | 関数異常の即時検知 |
| `dencho-{ingest,search,export,verify}-throttles` | AWS/Lambda Throttles ≥ 1（5 分） | 並列数不足・急増の検知 |
| `dencho-ingest-dlq-not-empty` | SQS 可視メッセージ ≥ 1 | 非同期取り込みの恒久失敗の検知 |
| `dencho-chain-verification-failure` | `DenchoArchive / ChainVerificationFailure` ≥ 1（5 分） | **台帳の改ざん・破損を検知（最重要）** |

いずれも「データ欠測は正常扱い（`notBreaching`）」とし、通常運転での誤報を避ける。
ダッシュボード `dencho-archive-operations` に Lambda 呼び出し・エラー・スロットル・
DLQ 滞留・チェーン検証失敗を集約する。

---

## 8. コスト概算（小規模運用）

**前提（例）**: 証憑 100 件/日（3,000 件/月）、平均ファイルサイズ 500KB、
保持オブジェクト平均 10GB、毎日 1 回の全件チェーン検証、月間ダウンロード 5GB。
東京リージョン、2026 年時点の概算単価、**1 USD = 150 円**で換算（税抜・概算）。

| 項目 | 数量の目安 | 月額 USD | 月額 JPY |
|---|---|---:|---:|
| S3 Standard（保存 10GB + PUT/GET） | 3,000 件/月 + 検証 GET | 約 $0.30 | 約 ¥45 |
| KMS（CMK 1 本 + リクエスト） | キー 1 + 約 1.2 万リクエスト | 約 $1.05 | 約 ¥160 |
| DynamoDB オンデマンド（+ PITR） | 書き ~36 万 WRU / 保存 1GB | 約 $1.00 | 約 ¥150 |
| Lambda（4 関数） | 約 3.3 万回 + 検証 | 約 $0.35 | 約 ¥55 |
| CloudWatch Logs（取込 1GB + 保持） | 731 日保持の平均 1GB | 約 $0.80 | 約 ¥120 |
| CloudWatch アラーム 10 個 / ダッシュボード 1 個 | 無料枠内 | $0 | ¥0 |
| CloudTrail（管理イベント + S3 データイベント） | 約 10 万イベント/月 | 約 $0.20 | 約 ¥30 |
| SQS DLQ | ほぼ 0 | $0 | ¥0 |
| Step Functions（バッチ取り込み） | 月 1 万トランジション | 約 $0.25 | 約 ¥40 |
| データ転送（ダウンロード 5GB） | 5GB | 約 $0.45 | 約 ¥70 |
| **合計** | | **約 $4.4 / 月** | **約 ¥660 / 月** |

- 実運用ではバッファを見て **月 $5〜15（約 ¥750〜¥2,250）** を見込むのが安全。
- **最大の変動要因はストレージ累積**: 7 年で証憑が 126GB に達すると S3 は約 $3.2/月。
  それでも小規模事業者なら月数千円以内に収まる。
- **CloudTrail の S3 データイベント**は閲覧・検証回数に比例する。全件検証を毎日行う
  場合はオブジェクト数に注意（本設計では毎日 1 回に限定）。
- 保存期間中のデータは Object Lock により**削除できない**ため、コスト見積もりは
  「7 年間の累積」で評価する必要がある。
- CloudWatch Logs の 731 日保持は、ログ量が増えると支配的になる。必要に応じて
  保持期間の短縮や S3 移送（第 4 章）を検討する。

---

## 9. テストで担保していること

`test/cdk/*.test.ts`（53 ケース）が、合成済み CloudFormation に対して以下を検証する:

- Object Lock 有効 + `COMPLIANCE` / `2557` 日、バージョニング、パブリックアクセス全面
  ブロック、TLS 強制、KMS（SSE-KMS + キーローテーション + RETAIN）
- DynamoDB 3 テーブルの PITR・暗号化・削除保護・オンデマンド・pk/sk
- Lambda 4 関数の runtime `nodejs22.x` / ハンドラ文字列 / timeout / memory / ロググループ
  731 日 / DLQ / アラーム 8 個
- IAM に `Action: "*"` / `Resource: "*"` が無いこと、取り込み以外に書き込み権限が
  無いこと、マネージドポリシー不使用
- CloudTrail のマルチリージョン・グローバルイベント・ログファイル検証・S3 データ
  イベント（読み書き）・Object Lock 付きログバケット
- Step Functions（Map + Retry + Catch）と EventBridge 日次スケジュール（03:00 JST）、
  Lambda Permission がルール側スタックに作られること
- `synthAll()` の決定性、認証情報なしでの合成、スタック間の循環参照が無いこと、
  `cdk.json` の app パス、`handlersDir` の既定解決

```bash
npx vitest run test/cdk
```

---

## 10. 既知の制約・今後の拡張

- **デプロイは未検証**: 認証情報が無い環境のため、本リポジトリの CI は合成と適合性
  検証まで。実デプロイ時は `cdk bootstrap` と初回手動確認が必要。
- **DynamoDB の暗号化は AWS マネージドキー**: コストと運用の単純さを優先した。
  証憑データ本体（S3）はカスタマー管理キーで暗号化している。より厳格な分離が必要な
  場合はテーブルごとの CMK に変更可能。
- **CloudTrail ログバケットは SSE-S3**: CloudTrail サービス書き込みのため。CMK に
  する場合はキーポリシーへの `cloudtrail.amazonaws.com` 許可が必要。
- **Step Functions の実行ログ**: 最小権限方針により CloudWatch Logs 出力は無効。
  実行履歴（90 日）と CloudTrail で監査する。
- **適用範囲**: 本設計は「証憑データの真正性・検索・保存」に焦点を当てたリファレンス
  実装であり、税務署への事前承認申請（電帳法の承認申請）や、スキャナ保存・電子取引の
  各要件すべてを自動化するものではない。
