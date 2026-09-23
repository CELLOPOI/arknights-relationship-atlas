import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

// 保留浏览器访问的 Host，令 Django 的同源 CSRF 校验覆盖开发及预览代理。
const proxy = Object.fromEntries(['/api', '/admin', '/static'].map(path => [path, { target: process.env.ATLAS_API_URL || 'http://127.0.0.1:8000', changeOrigin: false }]));

export default defineConfig(({ command, mode }) => {
  // 站点标识由部署环境提供；开发页面不加载统计脚本。
  const token = command === 'build' && mode === 'production'
    ? loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'CLOUDFLARE_').CLOUDFLARE_WEB_ANALYTICS_TOKEN?.trim()
    : '';
  if (token && !/^[a-f0-9]{32}$/i.test(token)) {
    throw new Error('CLOUDFLARE_WEB_ANALYTICS_TOKEN must be a 32-character hexadecimal token');
  }

  return {
    plugins: [vue(), {
      name: 'cloudflare-web-analytics',
      apply: 'build',
      transformIndexHtml: () => token ? [{
        tag: 'script',
        attrs: {
          type: 'module',
          src: 'https://static.cloudflareinsights.com/beacon.min.js',
          'data-cf-beacon': JSON.stringify({ token })
        },
        injectTo: 'body'
      }] : []
    }],
    // 字体包要求保留版权声明，不能让生产 CSS 压缩移除 @license 注释。
    esbuild: { legalComments: 'inline' },
    build: { outDir: 'build' },
    server: { proxy },
    preview: { proxy }
  };
});
