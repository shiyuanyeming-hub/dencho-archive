/**
 * ツールの識別情報。
 *
 * レポートやレポートのメタデータ、SARIF 相当の出力に埋め込む。
 * バージョンは package.json と手動で同期する（ビルド時に埋め込む仕組みは
 * 依存を増やすため採用していない）。
 */

/** ツール名。 */
export const TOOL_NAME = 'dencho-archive';

/** 表示用バージョン。 */
export const TOOL_VERSION = '0.2.0';

/** アーカイブ形式（スキーマ）のバージョン。 */
export const ARCHIVE_SCHEMA_VERSION = 1;
