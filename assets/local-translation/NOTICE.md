# Gravity 本地英译简中

Gravity 随包分发 Firefox Translations 的英文到简体中文模型 2.2、词表、词汇短名单和 Bergamot WebAssembly 引擎 3.0。所有文件从本地读取。模型和引擎的上游许可副本位于同目录的 MODEL-LICENSE 和 ENGINE-LICENSE。UPSTREAM.yml 记录 Firefox 使用的 Bergamot 源码版本。

sources.json 记录每个二进制文件的原始下载地址与版本。bergamot.js 来自该清单指定的 Firefox 修订，末尾增加了 CommonJS 导出以供桌面工作线程加载。worker.cjs 负责本地加载、批量翻译以及保留代码和文件路径。

[Firefox Translations 模型源代码](https://github.com/mozilla/firefox-translations-models) · [Firefox 集成源码](https://github.com/mozilla-firefox/firefox/tree/48d55cf7ec80093903e2ef7f58b61a84a22ef716/toolkit/components/translations/bergamot-translator)
