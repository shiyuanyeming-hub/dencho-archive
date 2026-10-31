import { defineConfig } from 'vitest/config';

/**
 * テスト設定。
 *
 * CDK の合成（`synthAll()`）は aws-cdk-lib の読み込みとスタック構築を含み、
 * コールドスタート時に数秒かかる。既定のフックタイムアウト（10 秒）だと
 * 並列実行時にフレーキーになるため、余裕を持たせる。
 */
export default defineConfig({
  test: {
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
