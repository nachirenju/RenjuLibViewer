import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // ★ここを追加！ (WebとAndroid両方でパスを合わせる魔法の設定)

  build: {
    target: 'esnext', // 必須: TypedArrayをネイティブで動かす
    sourcemap: false, // 必須: デバッグ情報をメモリに乗せない
    minify: 'esbuild',
  }
});