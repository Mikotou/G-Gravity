import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  // 生产窗口从本地 HTML 文件启动，生成相对资源路径才能在不同安装位置找到脚本和样式。
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  // 渲染产物有独立输出目录，Vite 清理该目录时保留 TypeScript 已生成的主进程代码。
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      output: { manualChunks: { react: ['react', 'react-dom', 'react-dom/client'] } },
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
