# Tables CSV Editor

![CI](https://github.com/bagaking/tables-vscode-ext/actions/workflows/ci.yml/badge.svg)

Modern CSV grid editor for VS Code, with first-class support for `@khgame/tables` header rows, enum hints, raw CSV inspection, and GFM Markdown export.

在 VS Code 中以现代表格体验编辑 CSV，针对 @khgame/tables 表头提供编辑辅助：自动识别 Mark 和 Desc 行与类型令牌、枚举下拉与标签化展示、连续主键、别名、枚举列固定等。

## 功能亮点

- 表格编辑（AG Grid）
  - 单元格实时编辑，文本与表格双向同步；行/列右键菜单：Add/Remove Row、Add/Remove Column
  - 自动列宽（测量 Header/内容、最小 12px）；行号列固定在左侧
  - 置顶显示 Mark 与 Desc 行；连续 `@/alias/enum` 数据列自动固定在左侧
  - 结构化括号 `()[]{}` 彩虹深度着色；可选/必选标记、注释列斜体、类型列加粗

- Raw 文本视图（增强）
  - 分隔符彩虹着色（逗号/分号/Tab，按列序循环），辅助对齐阅读
  - 数值高亮：
    - 整个单元格都是数字时整格高亮（含引号包裹的数值）
    - 单元格中出现的数字片段按整数/浮点区分着色
  - 仍基于 `Papa.parse` 保持原始换行风格与末尾换行

- 一键导出（GFM）
  - 通过命令 `Export CSV as GFM Markdown` 将当前 CSV 转为 GitHub Flavored Markdown 表格并保存；自动转义 `|`、保留多行为 `<br/>`

- @khgame/tables 表头辅助（0 配置）
  - 自动检测 Mark Row（前 16 行采样，命中 `@/$ghost/$strict/enum<...>/map/pair/...` 等令牌且置信度阈值达标）
  - 列类型判定与配色：`@/alias/enum/tid/struct/comment/default`
  - 枚举编辑与展示：
    - 读取工作区或上级目录中的 `context.*.json`（含 `context/`、`contexts/`、`.context/` 子目录）并合并常见 `context.enums` 对象和数组定义为枚举候选；表引用型 `ref` 枚举仍需由 @khgame/tables 工具链生成
    - 数据行以标签样式展示，支持 `enum<Name|Fallback1|...>` 的回退项（标记 `fallback`）
    - 单元格编辑为下拉选择（保留当前非候选值为 raw value）
  - 便利操作：行号右键可复制首个 `tid` 列；Mark/Desc 行固定置顶；连续主键/别名/枚举列固定在左侧

- 体验与可访问性
  - 顶部状态栏：Mode（Auto/On/Off）、编辑状态（Saved/Unsaved/Saving…）、Raw/Table 切换、Save
  - 自动响应外部变更（例如 Git 切换分支）；ARIA 属性与键盘可用性
  - 遵循 VS Code 主题变量与严格的 Webview CSP

## 安装与使用

### 从源码安装

1) 安装依赖并编译：

```bash
pnpm install --frozen-lockfile
pnpm run compile
```

2) 开发调试：在 VS Code 中按 `F5` 启动 Extension Development Host。

3) 打开任意 `*.csv` 文件即进入编辑器；或在命令面板执行 `Open CSV in Tables Editor`。

## 本地验证

```bash
pnpm run ci
```

该命令会编译 TypeScript、运行当前 Node 单元测试，并生成 `.vsix` 包，覆盖 CI 使用的最小发布置信度检查。

发布或提交前建议再检查最终 VSIX 文件清单：

```bash
pnpm run package:inspect
```

`package:inspect` 会运行 VS Code extension prepublish 步骤，列出将进入扩展包的文件，并对发布边界做机器可判定的 denylist 检查；如果 `src/`、`tests/`、`example/`、`.github/`、`.vscode/`、已有 `.vsix`、锁文件、`AGENTS.md`、`requirements.md`、`.env` 或 token/secret 类文件进入包内，命令会以非 0 退出。当前包应只包含运行时所需的 `dist/`、`media/`、`LICENSE`、`README.md`、`CHANGELOG.md` 和 `package.json` 等发布资产。

## 常见工作流

- 在表格视图编辑 → 顶部点击 Save 保存到文件。
- 切换到 Raw 文本视图核对分隔与数值格式（分隔符/数字已高亮）。
- 需要文档/README：打开命令面板 `Export CSV as GFM Markdown` 一键输出 Markdown 表格。
- 针对 @khgame/tables 的表：
  - 自动识别 Mark/Desc；类型列着色与强调；枚举列可下拉选择并以标签展示；连续主键/别名/枚举列固定。

## 项目结构

- `src/extension.ts` 扩展入口，注册自定义编辑器与 Webview
- `media/` Webview 前端（`main.js`/`main.css`）
- `src/features/khTables/*` KH Tables 检测、状态与枚举上下文解析
- `dist/` TypeScript 编译输出
- `example/` 示例 CSV（可用于手动冒烟）

## 安全与内容安全策略（CSP）

- Webview 仅开放 `media/` 与内置依赖资源；`default-src 'none'`，脚本使用 `nonce`，不从网络拉取动态脚本。

## 发行与打包

- `pnpm run package:vsix` 使用锁文件内的本地 `vsce` 生成 `.vsix` 包。
- `pnpm run prepublish:check` 会执行 CI 验证、打印 VSIX 文件清单，并在发布边界 denylist 命中时失败，适合作为发布前最后一道本地检查。
- 本仓库携带 `.vscodeignore`，避免将无关文件（如 `AGENTS.md`、测试、示例、源码、已有 `.vsix` 成品）打入新的 VSIX。
- 根目录生成的 `.vsix` 是本地发布产物，默认受 `.gitignore` 与 `.vscodeignore` 保护；如需要保留历史成品，应通过 GitHub Release 或 Marketplace/OpenVSX 版本记录归档，而不是依赖扩展包嵌套扩展包。

### 脚本命令（本地/发布）

- 本地打包：`npm run release:package`（等价：编译 + `vsce package`）
- 本地安装：`npm run install:local`（自动安装最新生成的 `.vsix` 到当前 VS Code）
- 发布前检查：`pnpm run prepublish:check`（编译、测试、打包并检查包内容）
- 发布到 VS Code Marketplace（需提前设置 `VSCE_PAT` 或交互登录）：
  - `npm run publish:marketplace`（使用当前版本号）
  - `npm run publish:marketplace:patch|minor|major`（自动 bump 版本并发布）
- 发布到 Open VSX：`OVSX_TOKEN=xxxx npm run publish:openvsx`

---

欢迎提交 Issue/PR：补充更多 @khgame/tables 能力（模板/校验/导出等）或优化 Raw 视图（配色/开关/性能）。

## License / 许可证

This project is licensed under the [MIT License](LICENSE).
