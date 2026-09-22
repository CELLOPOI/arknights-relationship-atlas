import { createRequire } from 'node:module';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
// 显式覆盖供临时工具环境使用；默认版本由前端锁文件管理。
export const { chromium, firefox, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
