import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 样式按导入顺序建立级联。先加载工作台基础布局，再让组件状态、适配规则和动效样式覆盖同名选择器。
import './styles/global.css';
import './styles/design-system.css';
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
