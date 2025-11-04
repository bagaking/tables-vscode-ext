## 反推需求规格（从现有代码与资源归纳）

- 编辑器承载
  - 使用 VS Code `CustomTextEditorProvider` 注册自定义编辑器 `tables.csvEditor`，默认接管 `*.csv` 文件；提供命令 `tablesCsvEditor.openFile` 打开当前/选中文件。
  - Webview 仅暴露 `media/` 与内置三方资源为可访问根：`node_modules/ag-grid-community`、`node_modules/papaparse`。
  - Content Security Policy：`default-src 'none'`；`style-src ${webview.cspSource} 'unsafe-inline'`；`script-src 'nonce-…'`；`img-src ${webview.cspSource} https: data:`；`font-src ${webview.cspSource} data:`。

- 顶部状态栏与操作
  - Mode 指示与切换：`Auto detect` / `Force on` / `Force off`。显示 `Enabled/Disabled (detail)`，当 `Auto` 且检测到标记时为 Enabled；详情包含 `markers detected` 与命中 token 提示。
  - 编辑状态：`Saved` / `Unsaved changes` / `Saving…`，随内容同步更新。
  - 操作按钮：`Raw CSV` 视图切换（与表格视图互斥）、`Save` 发起保存请求。

- KH Tables 模式检测与持久化
  - 从前 16 行 CSV 取样，按规则统计命中 token（包含 `@`、`$ghost/$strict/$oneof`、`enum<T>`、`map/pair/array`、基础类型等），计算置信度；当置信度 ≥ 0.6 且至少包含一个以 `@` 开头的片段时视为命中；记录命中的 token 片段与命中行号作为 Mark Row。
  - 每个文档可持久化 Mode 覆盖（`on/off`），存于 `workspaceState`，`auto` 不入库。

- 表格视图（AG Grid）
  - 基础配置：单选行、可编辑、可调整列宽、不启用排序/过滤；Header 文本自动换行，高度自适应；行动画启用。
  - 行号列：最左固定一列 `#`（宽 32，最小 24，最大 40），内容左对齐；置顶行的行号单元格显示为空。
  - 置顶行：命中 KH Tables 时固定 Mark 行与其下方描述行到表格顶部；未命中时回退固定首行。
  - 固定数据列：从第 0 列起，连续的 `@/alias/enum` 类型列固定在左侧，直至遇到非上述类型终止。
  - 列宽策略：
    - 初始宽度基于 Header 与内容的测量（隐藏 `span` + 网格字体变量），并叠加 Header 6px / 内容 4px 缓冲；最小 12、最大 520；空列 12。
    - 内容测量按行类别与列类型选择字重与斜体：Mark/Field 行与 `at/alias/tid` 600 字重，注释列斜体；否则常规权重。
  - 单元格渲染：默认渲染为彩虹括号高亮（仅着色 `()[]{}` 括号，文字保持原色，栈深循环 `kh-rainbow-depth-0..5`）。
  - 列/字段分类与样式：
    - 类型判定：`comment`（空或`#`）、`struct`（含 `{}`/`[]` 或 `struct`）、`enum<...>`、`alias`（含 `alias/map/pair`）、`at`（含 `@`）、`tid`（含 `tid`）、`default`。
    - Mark/Field 行：
      - `default`：底色 `#C1C1C1`；`comment`：底色 `#AAAAAA` 且斜体、文字 `#333`；`struct`：底色 `#666` 且白字；`@`：浅蓝；`alias/enum`：浅绿；`tid`：浅紫。
    - 数据行：普通列隔行底色 `#FFFFFF/#EEEEEE`；`struct/comment` 列底色 `#999`（文字浅色）；`@` 列沿用浅蓝；强调列（`at/alias/enum/tid`）字重加粗。
    - 可选标记：若 Mark/Field 文本或标记以 `?` 结尾，整列在数据行加 `optional` 风格（常规字重、黑色）；否则为 `required`（黑色）。

- Enum 支持与编辑
  - 从宿主注入的 `context` 枚举表（扫描工作区或父目录中的 `context.*.json`，亦包含 `context/`、`contexts/`、`.context/` 子目录）合并 `enum<Name>` 的可选项；若 `<Name|Fallback1|...>` 则将回退值并入，标记为 `fallback`。
  - 数据行渲染：将以 `|` 分隔的枚举值拆分为彩色标签（稳定哈希调色），`fallback` 项以虚线边框及灰色系表现；标签悬停显示描述。
  - 编辑器：枚举列使用 `<select>` 下拉，首项为空值；选项以 `key · value — 描述/来源` 形式显示；若当前值不在选项中，追加 `raw value` 以保留原值。
  - Mark/Field 行：枚举文本不渲染为标签，仅进行括号彩虹高亮。

- 上下文菜单与快捷操作
  - 行号列右键菜单：`Add Row Above`、`Add Row Below`、分隔线、`Remove Row`（当仅一行或置顶行禁用）、若存在首个 `tid` 列则附 `Copy tid`（禁空值）。
  - 列头右键菜单：`Add Column Left/Right`、分隔线、`Remove Column`（仅剩一列禁用）。
  - 新增/删除后：重建网格；若在表格视图则聚焦到新增/就近行；同步文本并置为 `Unsaved changes`。

- 文本视图（Raw CSV）
  - 使用 `<textarea>` 展示与编辑原始 CSV；输入 250ms 防抖解析；解析错误时在状态栏提示并为文本框加 `data-error/aria-invalid` 标记。
  - 解析与序列化均采用 `Papa.parse/unparse`；自动识别换行符 `\n/\r\n` 并在序列化时保留；保留末尾换行。
  - 视图切换：`Raw CSV` 与表格视图互斥显示；切回表格前会将 Raw 的待处理输入立即应用。

- 保存与外部变更
  - Webview 内点击 `Save` 发送 `requestSave`，宿主以整文替换方式更新 `TextDocument` 并调用 `saveAll`；保存后回推最新快照。
  - 监听宿主侧文档变更（非自身编辑导致）并以 `externalUpdate` 同步到 Webview。

- 可访问性与杂项
  - 主要控件与区域包含 `aria-label/role` 与 `aria-live` 声明；上下文菜单可键盘关闭（Esc）。
  - 网格/文本字体与配色尽量复用 VS Code 主题变量；不从网络动态拉取资源。

— 以下为原有 Checklist —

# 需求清单

- [x] 首列的 cell 背景也不要特化颜色，应该和其他行一样
- [x] Add Row / Remove Row 应该放在行左边行号被击的右键菜单中
- [x] Add Column / Remove Column 应该放在行上边列号被击的右键菜单中
- [x] 组件打开时, 所有列的 cell 应该是正好能放下当前列的最长 cell，最窄列宽约等于一个字符
- [x] cell 内不要有内间距, 保持尽量紧凑
- [x] title 行高度保持紧凑, 给内容留空间
- [x] 左侧序号列居左显示并保持最小宽度
- [x] 最上面一行为 status bar, 显示
  - [x] Mode (KHTable / Normal), 自动识别并可强制切换
  - [x] 显示编辑状态和保存
  - [x] 支持切换成展示原始 csv 文件，并可编辑
  - [ ] Raw 模式增强：对 CSV 分隔符（逗号/分号/制表符等）进行彩虹色着色（随列序循环），仅影响显示以辅助阅读，不改变文本内容与编辑行为

- KHTable 的渲染背景色要求
  - [x] Mark Row 按类型区分 cell 的背景色
    - [x] @ - 浅蓝色
    - [x] alias/enum - 浅绿色
    - [x] tid - 浅紫色
    - [x] 结构化数据符号 ({} [] 等) - 灰色 #666666
    - [x] 对应 mark row 为空或者 # (注释) 的列 - 灰色 #AAAAAA
    - [x] 其他 - 浅灰色 #C1C1C1
  - [x] Desc Row 背景色与其上 Mark Row 保持一致
  - [x] Data Row 背景色
    - [x] 普通列交替 #FFFFFF / #EEEEEF
    - [x] 结构化 / 注释列使用灰色 #999999
    - [x] @ 对应列沿用浅蓝色

- KHTable 的渲染字体要求
  - [x] 结构化数据符号 ({} [] 等) 
    - [x] 加粗
    - [x] 文字部分黑色
    - [x] 并按栈深度循环彩虹色
  - [x] Mark Row 为 # 的整列斜体、#333333，其余行保持常规字体
  - [x] Mark Row 为 @、alias、enum、tid 的整列加粗
  - [x] 数据行其它列为纯黑、常规字重、非斜体
  - [x] enum 数据行输入改为下拉选择，内容以标签样式展示
  - [x] enum 标签根据内容着色，Mark/Desc 行 hover 显示选项及使用次数
    - [x] 选项应该从 context 解析来, 如果 context 没有提供, 就还是按照原始值, 而非下拉的方式显示
    - [x] 下拉组件要好看

- KHTable 的特殊检查要求 (开启 khtable 时)
  - [x] 紧贴左侧的连续 @ 与 alias/enum 列固定不随数据列滚动
  - [x] 行号右键菜单支持复制当前行 tid
