/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';

const incidentServer = process.env.FIREWATCH_SERVER_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [iwsdkDev()],
  server: {
    host: '0.0.0.0',
    port: 8081,
    open: false,
    // The headset loads over https (dev cert); browsers block a secure page
    // from talking to the FireSight server's plain http/ws on :8080 (mixed
    // content). Proxy it through Vite's own origin instead of exposing the
    // server directly, so the browser only ever sees https/wss to :8081.
    proxy: {
      '/fs-api': {
        target: incidentServer,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fs-api/, ''),
      },
      '/fs-ws': {
        target: incidentServer.replace(/^http/u, 'ws'),
        ws: true,
        rewrite: (path) => path.replace(/^\/fs-ws/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (its own three vs the app's super-three alias). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
