# 電帳法 適合性マッピング（要件 → ルール → 実装 → 証跡）

dencho-archive は、電子帳簿保存法（電帳法）の要件を「機械的に検証できるルール」へ
分解し、保存済みアーカイブと AWS インフラの両方を監査する。このドキュメントは、
**どの要件を・どのルール ID が・どの実装で検証し・どの証跡で確認するか**を対応付ける。

> **免責事項**
> 本プロジェクトはリファレンス実装であり、法的助言ではない。ルールの判定結果は
> 実装上の参考情報にすぎず、法令への適合を保証しない。最終的な判断は、顧問税理士・
> 監査担当者など専門家の確認を受けること。
>
> 本ドキュメントは要件名と国税庁の公開ページのみを参照する。**条文番号は引用しない**
> （誤引用を避けるため）。参照先の一次資料を必ず確認すること。

---

## 1. 全体像

```
ArchiveView（証憑・台帳・チェーン検証・検索機能）     InfraSnapshot（CDK 合成済み CFN）
                    │                                        │
                    └──────────────┬─────────────────────────┘
                                   ▼
                     RuleContext { archive, infra, now, config }
                                   │
                    evaluateRules()（BUILTIN_RULES を順に評価）
                                   ▼
                       RuleResult[]（pass / fail / not-applicable / error）
                                   │
                     buildAuditReport()（集計 + 総合判定）
                                   ▼
              AuditReport ── renderAuditMarkdown() / renderAuditJson()
                                   │
                         auditExitCode() 0: 適合 / 1: 不適合 / 2: 判定不能
```

- ルールは**純粋関数**。I/O を持たず、例外を投げない（投げてもエンジンが `error` に変換する）。
- 出力順は `BUILTIN_RULES` の定義順で固定され、レポートは決定的（同じ入力 → 同じ出力）。
- インフラ定義（`InfraSnapshot`）が渡されない場合、インフラ系ルールは `not-applicable`。

## 2. カテゴリ・重要度・総合判定

| カテゴリ | 意味 |
| --- | --- |
| `authenticity` | 真実性の確保 |
| `visibility` | 可視性の確保（検索要件を含む） |
| `searchability` | 検索要件（将来の詳細ルール用に定義済み） |
| `retention` | 保存期間 |
| `tax-audit-support` | 税務調査対応（ダウンロードの求め） |
| `auditability` | 監査証跡（クラウド側の統制） |

- **重要度 `mandatory`（必須）**: 法令上の要件に対応。1 件でも `fail` があれば総合判定は
  **不適合**。`error`（判定不能）がある場合は **判定不能**。
- **重要度 `recommended`（推奨）**: 実務上の推奨。`fail` しても総合判定は変わらない。
- **`not-applicable`（対象外）** は必須ルールでも総合判定を妨げない
  （例: インフラ監査を行わないローカル実行、タイムスタンプ方式を採用している場合の
  AUTH-05 = WORM/訂正削除履歴ルール）。

| 総合判定 | 条件 | 終了コード |
| --- | --- | --- |
| `compliant`（適合） | 必須ルールに `fail` も `error` も無い | 0 |
| `non-compliant`（不適合） | 必須ルールに `fail` が 1 件以上 | 1 |
| `incomplete`（判定不能） | 必須ルールの `fail` は無いが `error` が 1 件以上 | 2 |

## 3. 要件マッピング表

### 3.1 真実性の確保（タイムスタンプ / ハッシュチェーン / WORM）

| 要件 | ルール ID | 実装（何を検査するか） | 証跡（誰が・何で確認するか） |
| --- | --- | --- | --- |
| 証憑へのタイムスタンプ付与 | AUTH-01 | 全 `StoredVoucher.timestamp` が非 null か | 付与済み/未付与件数と未付与 voucherId（先頭 5 件）を監査担当者が確認 |
| タイムスタンプの付与期限 | AUTH-02 | `daysBetween(receivedAt, timestamp.generatedAt)` が `timestampMaxDelayDays`（既定 62 日）以内か。受領前の付与も違反扱い | 上限日数・最大遅延日数・違反 voucherId と日数 |
| タイムスタンプの検証 | AUTH-03 | `ChainVerification.break?.reason === 'timestamp-mismatch'` でないか | 破損位置・期待値/実際値のハッシュ先頭 12 桁 |
| 台帳の完全性 | AUTH-04 | `chain.status` が `intact` または `empty` かつ `checkpointsVerified` | 検証済みエントリ数・先頭ハッシュ・チェックポイント整合 |
| WORM / 訂正削除履歴 | AUTH-05 | 条件付き必須: `requireTimestamp === true` なら n/a、false なら `config.worm === true` またはインフラの Object Lock が COMPLIANCE / 2557 日以上かを確認 | 方式選択（タイムスタンプ/WORM）と Object Lock のモード・日数 |
| 保存先の WORM 有効化 | INF-01 | S3 バケットの `ObjectLockEnabled` / `ObjectLockConfiguration` | `dencho-storage/ArchiveBucket` の設定値 |
| バージョニング | INF-03 | `VersioningConfiguration.Status === 'Enabled'` | バケットのバージョニング状態 |

### 3.2 可視性の確保（検索要件・ダウンロード対応）

| 要件 | ルール ID | 実装（何を検査するか） | 証跡（誰が・何で確認するか） |
| --- | --- | --- | --- |
| 検索対象 3 項目の索引化 | VIS-01 | `capability.searchableFields` ⊇ {取引年月日, 取引金額, 取引先} | 索引化済み項目・不足項目・索引数 |
| 2 項目以上の組み合わせ検索 | VIS-02 | `capability.twoFieldCombinations` が空でないか（期待値 3） | 対応している組み合わせ一覧と件数 |
| 日付・金額の範囲指定 | VIS-03 | `supportsDateRange && supportsAmountRange` | 日付/金額/取引先それぞれの可否 |
| ダウンロードの求めへの対応 | DL-01 | `capability.exportFormats` に `csv` と `json` の両方を含むか | 対応出力形式（CSV / JSON の可否） |

### 3.3 保存期間

| 要件 | ルール ID | 実装（何を検査するか） | 証跡（誰が・何で確認するか） |
| --- | --- | --- | --- |
| 7 年以上の保存 | RET-01 | `config.retentionYears >= 7`、かつインフラがあれば Object Lock の保持日数 ≧ 2557 日 | 設定年数・保持モード・保持日数（2557 日 = 7 年相当） |
| 保持モードの実効性 | INF-02 | `ObjectLockConfiguration.Rule.DefaultRetention` が `Mode: COMPLIANCE` かつ `Days >= 2557` | バケットのモードと日数 |

### 3.4 監査証跡・クラウド側の統制（インフラ系）

| 要件 | ルール ID | 実装（何を検査するか） | 証跡（誰が・何で確認するか） |
| --- | --- | --- | --- |
| パブリックアクセスの遮断 | INF-04 | `PublicAccessBlockConfiguration` の 4 フラグがすべて true | 4 フラグそれぞれの値 |
| 保存データの暗号化 | INF-05 | `BucketEncryption.ServerSideEncryptionConfiguration` に `SSEAlgorithm` があるか（KMS 推奨） | 暗号化方式・KMS キー ID |
| TLS の強制 | INF-06 | `BucketPolicy` に `Effect: Deny` + `Condition.Bool['aws:SecureTransport'] === false` のステートメントがあるか（推奨） | 該当ポリシーの論理 ID |
| データイベントの記録 | INF-07 | `CloudTrail::Trail` の `EventSelectors` / `AdvancedEventSelectors` に S3 オブジェクト（`AWS::S3::Object`）のデータイベントがあるか | トレイルごとの記録有無 |
| 索引・台帳の復旧可能性 | INF-08 | すべての `DynamoDB::Table` で `PointInTimeRecoveryEnabled === true` か | テーブルごとの PITR 有効/無効 |
| KMS キーのローテーション | INF-09 | すべての `KMS::Key` で `EnableKeyRotation === true` か（推奨） | キーごとのローテーション状態 |
| 整合性検証失敗の検知 | INF-10 | `CloudWatch::Alarm` に `MetricName === 'ChainVerificationFailure'` があるか（推奨） | アラームの名前空間・メトリクス名 |

## 4. ルール一覧（実装順）

`BUILTIN_RULES` は以下の 20 ルールをこの順序で評価する（アーカイブ系 10 → インフラ系 10）。

| # | ルール ID | タイトル | カテゴリ | 重要度 |
| ---: | --- | --- | --- | --- |
| 1 | AUTH-01 | 全証憑にタイムスタンプが付与されている | authenticity | mandatory |
| 2 | AUTH-02 | タイムスタンプ付与が受領後 62 日以内 | authenticity | mandatory |
| 3 | AUTH-03 | タイムスタンプの検証に失敗していない | authenticity | mandatory |
| 4 | AUTH-04 | ハッシュチェーンが整合している | authenticity | mandatory |
| 5 | AUTH-05 | WORM または訂正削除履歴による真実性確保 | authenticity | mandatory（条件付き） |
| 6 | VIS-01 | 検索対象3項目が索引化されている | visibility | mandatory |
| 7 | VIS-02 | 2項目以上の組み合わせ検索が可能 | visibility | mandatory |
| 8 | VIS-03 | 日付・金額の範囲指定検索が可能 | visibility | mandatory |
| 9 | RET-01 | 保存期間が7年以上 | retention | mandatory |
| 10 | DL-01 | 税務調査の「ダウンロードの求め」に対応できる | tax-audit-support | mandatory |
| 11 | INF-01 | S3 Object Lock が有効 | authenticity | mandatory |
| 12 | INF-02 | 保持モードが COMPLIANCE で 7 年以上 | retention | mandatory |
| 13 | INF-03 | バケットのバージョニングが有効 | authenticity | mandatory |
| 14 | INF-04 | パブリックアクセスが全面ブロック | auditability | mandatory |
| 15 | INF-05 | 保存データが暗号化されている（KMS 推奨） | auditability | mandatory |
| 16 | INF-06 | TLS が強制されている | auditability | recommended |
| 17 | INF-07 | CloudTrail がデータイベントを記録 | auditability | mandatory |
| 18 | INF-08 | DynamoDB のポイントインタイムリカバリが有効 | auditability | mandatory |
| 19 | INF-09 | KMS キーローテーションが有効 | auditability | recommended |
| 20 | INF-10 | 整合性検証の失敗を検知するアラームがある | auditability | recommended |

## 5. 実装メモ

### 5.1 真実性の確保の方式選択（AUTH-01 / AUTH-05）

真実性の確保は「タイムスタンプ」「WORM 保存」「訂正削除の履歴」のいずれかで行う。
エンジンはこの方式選択を次のように扱う（`RuleStatus` では「必須だが条件付き」を表現
できないため、条件が成立しない場合を `not-applicable` で表す）。

| 設定・状態 | AUTH-01（タイムスタンプ付与） | AUTH-05（WORM / 訂正削除履歴） |
| --- | --- | --- |
| `requireTimestamp: true`（タイムスタンプ方式を採用） | 全証憑に付与されていれば pass | `not-applicable`（真実性は AUTH-01〜AUTH-04 で確認） |
| `requireTimestamp: false` かつ `worm: true` | `not-applicable` | pass（WORM で確保） |
| `requireTimestamp: false` かつインフラの Object Lock が COMPLIANCE / 2557 日以上 | `not-applicable` | pass（S3 Object Lock で確保） |
| `requireTimestamp: false` かつ WORM も Object Lock も無い | `not-applicable` | **fail（必須）** → 総合判定は不適合 |

つまり、どの真実性確保手段も採っていないアーカイブは「不適合」になる。
`requireTimestamp: false` のとき AUTH-02 は付与済みトークンのみを対象に判定する。
訂正削除の履歴を残す運用は本エンジンでは観測できないため、当該方式を採る場合は
設定と運用証跡（訂正削除履歴の保管）で担保する。

### 5.2 62 日・2557 日という数値

- AUTH-02 の既定値 62 日は、実務上「受領後おおむね 2 か月以内」とされる運用を
  既定値として表現したものである（`timestampMaxDelayDays` で変更可能）。
- RET-01 / INF-02 の 2557 日は 7 年相当（365 日 × 7 + 閏日 2 日）である。
  Object Lock の `Days` は暦日で指定するため、この換算を採用する。

### 5.3 インフラの寛容な読み取り

合成済み CloudFormation は CDK のバージョンや書き方で揺れる。そのため読み取りは
`src/compliance/rules/cfn.ts` の「例外を投げず、読めなければ `undefined`」ヘルパーに集約し、
欠落・型違いは **fail**（証跡: 「リソースが見つかりません」）として扱う。
`Fn::If` / `Fn::Join` などの組み込み関数オブジェクトは「読めない値」であり、
誤って pass にすることはない。

アーカイブ用バケットは、複数バケット（アーカイブ用 + CloudTrail ログ用）が併存しても
取り違えないよう、スタック名・論理 ID（`archive` / `voucher` / `storage`）で採点して選ぶ。

### 5.4 検索実装との関係（法定 3 項目と書類種別）

検索要件の実装（`src/core/query.ts`）は、法定の検索対象 3 項目（取引年月日・取引金額・
取引先）を**主条件（索引アクセス）**とし、書類種別（`documentType`）は取得後の
**残余条件（residual）**として扱う。そのため「書類種別だけ」のクエリは主条件が無く
`ValidationError` になる。これは意図した設計である（法定の検索要件は 3 項目・範囲・
組み合わせで規定され、書類種別は補助的な絞り込みにすぎないため）。監査上は VIS-01〜VIS-03
（3 項目の索引化・組み合わせ・範囲指定）と DL-01（ダウンロード）で検索要件を確認する。

### 5.5 エンジンの安全性

- ルールが例外を投げた場合は `status: 'error'` と `error` メッセージに変換し、監査全体は継続する。
- ルールが `status` / `evidence` を持たない不正な値を返した場合も `error` とする。
- ルール評価の順序と結果の順序は `BUILTIN_RULES` の定義順で固定される。
- Markdown 出力では証跡中の `|`・改行・バッククォートをエスケープし、表やコードスパンを壊さない。

## 6. 証跡の読み方（例）

```
AUTH-01  タイムスタンプ付与状況: 付与済み 120 件 / 未付与 0 件（対象 120 件）
AUTH-02  付与遅延の最大値: 判定対象のうち最大 41 日（上限 62 日）
AUTH-04  ハッシュチェーン: 検証済みエントリ数: 120 件
AUTH-04  先頭エントリのハッシュ: 9f2c…（SHA-256）
RET-01   dencho-storage/ArchiveBucket: Object Lock 保持: モード COMPLIANCE / 2557 日（要件: 2557 日以上）
INF-07   dencho-guardrails/ArchiveTrail: S3 オブジェクトのデータイベント:記録あり
```

各ルールの `evidence` は CLI の `dencho audit --format markdown` / `--format json`、
および `dencho audit --out <path>` で出力できる。JSON は機械処理・差分監査用、
Markdown は監査法人・税理士への提出用である。

## 7. 参照資料

- 国税庁「電子帳簿保存法関係」: <https://www.nta.go.jp/law/joho-zeikaishaku/sonota/031227/index.htm>
- AWS 公式ドキュメント（インフラ系ルールの根拠）
  - S3 Object Lock: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html>
  - S3 バージョニング: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html>
  - S3 パブリックアクセスブロック: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html>
  - S3 暗号化（KMS）: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html>
  - CloudTrail データイベント: <https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html>
  - DynamoDB PITR: <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery.html>
  - KMS キーローテーション: <https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html>

要件名（真実性の確保 / 可視性の確保 / 検索要件 / 保存期間 / ダウンロードの求め）は
公的な資料で用いられる表現に従う。条文番号・通達番号は本プロジェクトでは引用しない。

## 8. 免責事項（再掲）

本プロジェクトおよび本マッピングは**リファレンス実装**であり、法的助言ではない。
個別の事業・取引・保存期間・運用形態によって当てはめる要件は異なる。
最終的な適合判断は、税理士・監査担当者等の専門家に相談すること。

## 9. テストと検証

- `npx vitest run test/compliance` — ルール・エンジン・レンダラのテスト
  - `test/compliance/archive-rules.test.ts`: AUTH / VIS / RET / DL の pass・fail・not-applicable
  - `test/compliance/infra-rules.test.ts`: INF-01〜INF-10、複数バケットの選択、欠落・型違いへの耐性
  - `test/compliance/engine.test.ts`: 評価順序、例外の隔離、総合判定、終了コード、決定性
  - `test/compliance/render.test.ts`: Markdown / JSON の決定性とエスケープ
- `test/compliance/fixtures.ts` は `src/app/**` / `src/adapters/**` に依存せず、
  型どおりの値をリテラルで組み立てる（アプリケーション層の変更から独立して検証できる）。
