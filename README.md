# Tables CSV Editor

一个基于 VS Code Webview 的 CSV 表格编辑器扩展，内置 AG Grid 数据网格，让你直接在 VS Code 中以现代表格界面查看和修改本地 CSV 文件。

## 主要能力

- 🔄 自动把 `*.csv` 文件映射成可编辑的 AG Grid 表格视图
- ✏️ 单元格实时编辑，自动同步到原始 CSV 文本
- ➕ 快捷操作按钮：新增 / 删除行与列
- 💾 一键保存按钮，触发 VS Code 保存流程
- 👀 自动响应外部（例如 Git 变更）对 CSV 的更新

## 使用方式

1. 安装依赖并编译扩展：

   ```bash
   npm install
   npm run compile
   ```

2. 在 VS Code 中按 `F5` 启动扩展开发主机，或者打包后安装。
3. 打开任何 CSV 文件，默认会以“Tables CSV Editor”方式呈现；也可以通过命令面板执行 `Open CSV in Tables Editor`。

## 技术选型

- Web 前端：`ag-grid-community` 最新社区版 + `papaparse`
- VS Code API：`CustomTextEditorProvider` 自定义文本编辑器，用于双向同步文本与 Webview
- TypeScript：主扩展逻辑；前端脚本为纯 ES 模块，方便在 Webview 中直接加载

## 开发提示

- 所有 Webview 静态资源位于 `media/`
- 执行 `npm run watch` 可以在保存 TypeScript 时自动重新编译到 `dist/`
- 若要扩展更多网格功能（排序、过滤等），可以直接修改 `media/main.js` 中的 `gridOptions`

欢迎根据项目需求继续拓展，例如增加多文件批量浏览、Schema 校验、批注等能力。
