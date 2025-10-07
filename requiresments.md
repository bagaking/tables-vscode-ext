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
