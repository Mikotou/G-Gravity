import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 唯一样式入口：tokens → base → components → platform（见 styles/index.css）。
import './styles/index.css';
import { applyDocumentFavicon, applyThemePreference } from './styles/theme';

// 首屏同步注入默认 Claude Code Dark 主题变量与 Gravity 图标，确保零闪烁挂载
applyThemePreference('claude-code-dark');
applyDocumentFavicon('gravity-claude-dark');

// HTML 只提供挂载节点。App 获取启动快照后，再用已保存的主题、图标和语言更新首屏默认值。
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
