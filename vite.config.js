import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext', // 必須: TypedArrayをネイティブで動かす
    sourcemap: false, // 必須: デバッグ情報をメモリに乗せない
    minify: 'esbuild',
  }
});