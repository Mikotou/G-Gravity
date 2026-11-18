import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // 界面测试默认使用 DOM 模拟环境。需要 Node 文件系统或进程语义的套件可在文件顶部声明自己的环境。
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 15000,
  },
  resolve: {
    // 测试和渲染构建将 @shared 指向同一目录，使契约、默认配置和校验函数来自同一份源码。
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
