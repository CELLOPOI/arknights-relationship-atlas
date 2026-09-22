import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 保留浏览器访问的 Host，令 Django 的同源 CSRF 校验覆盖开发及预览代理。
const proxy = Object.fromEntries(['/api', '/admin', '/static'].map(path => [path, { target: process.env.ATLAS_API_URL || 'http://127.0.0.1:8000', changeOrigin: false }]));

export default defineConfig({
  plugins: [vue()],
  // 字体包要求保留版权声明，不能让生产 CSS 压缩移除 @license 注释。
  esbuild: { legalComments: 'inline' },
  build: { outDir: 'build' },
  server: { proxy },
  preview: { proxy }
});
