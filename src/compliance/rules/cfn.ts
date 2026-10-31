/**
 * CloudFormation テンプレートを安全に読み取るためのヘルパー。
 *
 * 適合性検証は CDK が合成した `InfraSnapshot` を入力に取る。合成結果は
 * CDK のバージョンや書き方によってプロパティの有無・型が変わり得るため、
 * ここでは「例外を投げず、読めなければ undefined を返す」読み取り関数だけを
 * 提供する。欠落はルール側で fail（証跡: リソースが見つかりません）として扱う。
 *
 * 設計方針:
 * - ルールは純粋関数であること。I/O も例外も持ち込まない。
 * - 列挙順はスタック名 → 論理 ID の文字列順に固定し、レポートを決定的にする。
 * - `Fn::If` / `Fn::Join` などの組み込み関数オブジェクトは「読めない値」として
 *   undefined を返す（誤って pass にしない）。
 */
import type { CfnResource, EvidenceItem, InfraSnapshot } from '../../core/types.js';

/** スナップショット上の 1 リソースの所在。 */
export interface ResourceLocation {
  /** スタック名（`InfraSnapshot.stacks` のキー）。 */
  readonly stackName: string;
  /** テンプレート上の論理 ID。 */
  readonly logicalId: string;
  /** リソース定義。 */
  readonly resource: CfnResource;
}

/** S3 バケットの Object Lock デフォルト保持設定。 */
export interface ObjectLockRetention {
  /** 保持モード（例: `COMPLIANCE` / `GOVERNANCE`）。未設定なら undefined。 */
  readonly mode: string | undefined;
  /** 保持日数。`Years` 指定の場合は 365 日/年で換算する。未設定なら undefined。 */
  readonly days: number | undefined;
}

/**
 * プロパティ辞書から名前で値を取り出す。
 *
 * `noPropertyAccessFromIndexSignature` が有効なため、プロパティは
 * ブラケット記法でしか読めない。その読み取りをここに集約する。
 */
export function readProperty(
  properties: Readonly<Record<string, unknown>> | undefined,
  name: string,
): unknown {
  if (properties === undefined) {
    return undefined;
  }
  return properties[name];
}

/** 値を安全にオブジェクトとして読む。配列・null・プリミティブは undefined。 */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}

/** 値を安全に配列として読む。配列以外は undefined。 */
export function asArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value;
}

/** 値を安全に文字列として読む。文字列以外は undefined。 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 値を安全に真偽値として読む。
 *
 * CloudFormation のブール値はふつう boolean だが、IAM ポリシーの
 * `Condition.Bool` のように文字列 `"true"` / `"false"` で書かれる箇所もあるため
 * 文字列も受け付ける。
 */
export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return undefined;
}

/** 値を安全に数値として読む。有限の数値と数値文字列だけを受け付ける。 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 真偽値を証跡表示用の「有効 / 無効」ラベルへ変換する。 */
export function enabledLabel(value: boolean): string {
  return value ? '有効' : '無効';
}

/** インフラスナップショット内の指定タイプのリソースを決定的な順序で列挙する。 */
export function findResources(infra: InfraSnapshot, resourceType: string): readonly ResourceLocation[] {
  const locations: ResourceLocation[] = [];
  for (const stackName of Object.keys(infra.stacks).sort()) {
    const template = infra.stacks[stackName];
    if (template === undefined) {
      continue;
    }
    for (const logicalId of Object.keys(template.Resources).sort()) {
      const resource = template.Resources[logicalId];
      if (resource === undefined) {
        continue;
      }
      if (resource.Type === resourceType) {
        locations.push({ stackName, logicalId, resource });
      }
    }
  }
  return locations;
}

/** 最初に見つかった指定タイプのリソースを返す（無ければ undefined）。 */
export function findFirstResource(
  infra: InfraSnapshot,
  resourceType: string,
): ResourceLocation | undefined {
  return findResources(infra, resourceType)[0];
}

/** リソースのプロパティ辞書を返す（未定義なら空オブジェクト）。 */
export function propertiesOf(location: ResourceLocation): Readonly<Record<string, unknown>> {
  return location.resource.Properties ?? {};
}

/** 証跡に載せるリソース識別子（`スタック名/論理ID`）。 */
export function resourceSubject(location: ResourceLocation): string {
  return `${location.stackName}/${location.logicalId}`;
}

/**
 * アーカイブ本体を保存する S3 バケットを推定して返す。
 *
 * CDK のスナップショットにはアーカイブ用バケットと CloudTrail ログ用バケットが
 * 併存し得るため、論理 ID とスタック名からアーカイブ用らしさを採点して選ぶ。
 * 同点の場合は列挙順（スタック名 → 論理 ID）で先のものを選び、決定的にする。
 */
export function findArchiveBucket(infra: InfraSnapshot): ResourceLocation | undefined {
  const buckets = findResources(infra, 'AWS::S3::Bucket');
  let selected: ResourceLocation | undefined;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const bucket of buckets) {
    const score = archiveBucketScore(bucket);
    if (score > selectedScore) {
      selected = bucket;
      selectedScore = score;
    }
  }
  return selected;
}

/** バケットの「アーカイブ用らしさ」を採点する（内部用）。 */
function archiveBucketScore(location: ResourceLocation): number {
  const logicalId = location.logicalId.toLowerCase();
  const stackName = location.stackName.toLowerCase();
  let score = 0;
  // アーカイブ用バケットはストレージ系スタックに置かれることが多い。
  // CloudTrail ログ用バケット（ガードレール系スタック）と取り違えないよう、
  // スタック名の重みを論理 ID より小さくしつつ明確に差をつける。
  if (stackName.includes('storage')) {
    score += 5;
  }
  if (logicalId.includes('archive')) {
    score += 8;
  }
  if (logicalId.includes('voucher')) {
    score += 6;
  }
  if (logicalId.includes('evidence')) {
    score += 4;
  }
  if (logicalId.includes('document')) {
    score += 2;
  }
  if (stackName.includes('dencho')) {
    score += 1;
  }
  return score;
}

/** バケットで S3 Object Lock が有効か。 */
export function isObjectLockEnabled(bucket: ResourceLocation): boolean {
  const properties = propertiesOf(bucket);
  if (asBoolean(readProperty(properties, 'ObjectLockEnabled')) === true) {
    return true;
  }
  const configuration = asRecord(readProperty(properties, 'ObjectLockConfiguration'));
  return asString(readProperty(configuration, 'ObjectLockEnabled'))?.toLowerCase() === 'enabled';
}

/**
 * S3 バケットの Object Lock デフォルト保持設定を読み取る。
 *
 * `Rule` は単一オブジェクトが正だが、配列で書かれた定義も許容する。
 * `Days` が無く `Years` だけが指定されている場合は 365 日/年で換算する。
 */
export function readObjectLockRetention(bucket: ResourceLocation): ObjectLockRetention | undefined {
  const properties = propertiesOf(bucket);
  const configuration = asRecord(readProperty(properties, 'ObjectLockConfiguration'));
  const rule = asRecord(readProperty(configuration, 'Rule'));
  const defaultRetention = asRecord(readProperty(rule, 'DefaultRetention'));
  if (defaultRetention === undefined) {
    return undefined;
  }
  const mode = asString(readProperty(defaultRetention, 'Mode'))?.toUpperCase();
  const days = asNumber(readProperty(defaultRetention, 'Days'));
  const years = asNumber(readProperty(defaultRetention, 'Years'));
  const convertedDays = days ?? (years === undefined ? undefined : years * 365);
  return { mode, days: convertedDays };
}

/** リソースが見つからない場合の証跡（全インフラルールで共通の文言）。 */
export function missingResourceEvidence(resourceType: string, purpose: string): EvidenceItem {
  return {
    subject: resourceType,
    detail: `リソースが見つかりません（${purpose}を確認するための ${resourceType} がインフラ定義に含まれていません）`,
  };
}
