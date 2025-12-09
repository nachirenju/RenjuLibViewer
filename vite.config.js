import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  // コマンドで --mode app が指定されたかチェック
  const isApp = mode === 'app';

  return {
    build: {
      // ▼ ここがポイント！
      // アプリ用なら 'dist-app'、Web用なら 'dist' にフォルダを分ける
      outDir: isApp ? 'dist-app' : 'dist',

      // ▼ 既存の設定（そのまま）
      target: 'esnext', 
      sourcemap: false, 
      minify: 'esbuild',
    }
  };
});