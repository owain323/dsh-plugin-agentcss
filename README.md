# dsh-plugin-agentcss

> DeepSeek Harness 插件：让 agent 写出**能看**的报告页，而不是一堆没样式的 div。

English: DeepSeek Harness tools for [agentcss](https://github.com/owain323/agentcss) —
look up components, scaffold a report page, validate the result, and export it to PDF.

---

## 它解决什么

让模型写 HTML 报告，有三个**不会报错、只会静默失效**的坑：

| 坑 | 现象 | 谁能发现 |
|---|---|---|
| 类名凭感觉编 | 页面上没有报错，只是那一块没有样式 | 没人，直到人打开看 |
| `<head>` 漏一条 `<link>` | 组件类名都对，但那部分完全没样式 | 没人，直到人打开看 |
| 骨架层级错 | 布局塌了，但不抛异常 | 没人，直到人打开看 |

这个插件给四个工具，正好对应这几件事：**查得到、起得对、交得出去、发得出去**。

## 安装

Harness 里「添加插件」，三个入口任选其一：

- **npm 包名（推荐）**：`dsh-plugin-agentcss` —— 版本随库走，升级最省事
- **GitHub 地址**：`https://github.com/owain323/dsh-plugin-agentcss`
- **本地目录**：克隆后填目录路径

命令行等价写法：

```sh
# 从 npm 装
dsh plugin --profile desktop add dsh-plugin-agentcss

# 或从 GitHub 装（跟踪 main）
dsh plugin --profile desktop add https://github.com/owain323/dsh-plugin-agentcss
```

装完重启 Harness。工具会出现在模型的可调用列表里，名字以 `agentcss_` 开头。

## 四个工具

| 工具 | 什么时候用 | 返回什么 |
|---|---|---|
| `agentcss_catalog` | 写 HTML 之前。按关键词或分层查组件 | 组件 id、分层、根类名、**要引的样式表路径**、一句话用途 |
| `agentcss_new_page` | 新页面从这一步开始，不要手写 `<head>` | 一个自包含目录：`index.html` + `agentcss/`（库样式表副本） |
| `agentcss_check` | 每次改完页面 | 结构化问题列表：规则名、行号、级别、说明 |
| `agentcss_pdf` | 内容定稿、要发出去或要交给打印时 | PDF 路径、页数、纸幅、字节数；有 JS 异常会点名 |

`agentcss_check` 查的是：类名库里有没有、类名有但这页没引到定义它的样式表、图缺不缺 `alt`、
表头有没有 `scope`、标题有没有跳级、表单控件有没有可读名称、id 有没有重复……
**纯静态，不联网、不开浏览器。**

`agentcss_pdf` 会起一次本机 Chrome/Edge（不开端口、不复用你的浏览器配置），
导出顺序是库定死的：页面加载 → 字体就绪 → 可选可见元素 → 额外等待 → 定格动画 → 打印。
**失败或超出页数预算时不改写旧 PDF，也不替你截断内容** —— 截断是静默丢东西，
比报错停下危险得多。

## 典型一轮

```
用户：用 agentcss 做一份三季度营收分析页，放在 /work/reports/q3

模型 → agentcss_new_page({ dir: "/work/reports/q3", recipe: "report/finance" })
     ← 已生成 /work/reports/q3/index.html；样式表已复制到 …/agentcss

模型 写内容（需要额外组件就先 agentcss_catalog 查一下）

模型 → agentcss_check({ path: "/work/reports/q3/index.html", recipe: "report/finance" })
     ← 不通过：1 个 error
          L42  error  class-not-linked  .bar 在库里，但这页没引 09-assets/bar/bar.css

模型 补一条 <link>，再跑一次 → 通过：0 error · 0 warn
```

## 它**不含**什么

这个包只有约 700 行适配代码（含注释），**没有任何组件定义**。

组件、令牌、判据全部来自 npm 上的 `agentcss`。这是刻意的：`agentcss_check` 的类名白名单是
**从库的 CSS 现算**的，复制一份组件树过来就等于同时存在两份真值，改一次 token 就开始不同步，
而且两边各跑各的门禁，没人会发现。所以这里只做一件事——把模型的意图翻译成库的命令行调用。

## 依赖与兼容

| 项 | 要求 |
|---|---|
| Node | >= 18（Harness 桌面版自带 24） |
| `agentcss` | `^0.27.7` —— `ai scaffold` / `ai check` 是 0.27.0；PDF 的就绪契约是 0.27.1；纸面墨阶是 0.27.3；图不溢出容器是 0.27.4；仓库名与包名统一、站点根路径改 `/agentcss/` 是 0.27.5；**导出判定失败不改写旧 PDF 是 0.27.7** |
| Harness | 0.2.x 实测（0.2.2-rc.1） |

两个刻意的选择：

- **不依赖任何 `@deepseek-ai/*` 包。** 不用 `defineTool`，直接用 `ctx.tools.register()` 注册裸定义。
  读 `dsh-tools` 的实现能确认二者等价（`defineTool` 只是把参数编译成 JSON Schema 的包装器），
  少一个 peer 依赖就少一整类版本解析故障。
- **不声明 `engines.dsh`。** 0.2.x 是预发布版，semver 的预发布规则会让 `>=0.2.0` 这类范围
  **判不通过**，安装直接被拒。宁可不写这一行。

## 已知限制

- `dir` / `path` 必须传**绝对路径**，并且不能落在系统 / 程序 / 应用数据目录
  （含指向那里的符号链接）、不能是盘符根。写错会明确报错，不会猜。
- 远程 `http(s)` 地址会先过一道边界：环回、私网、链路本地（含云元数据地址）、
  非 http(s) scheme、带用户名密码的 URL 一律拒绝。等价 IP 写法
  （`2130706433` / `127.1` / `0`）会被规范化后再判。
  **仍有两处不覆盖**：域名解析到内网（DNS rebinding），以及远程站点把页面
  重定向到内网地址（重定向由 Chromium 跟随，插件看不到最终 URL）。
  如果工具的入参会来自不可信内容，应把远程能力整体关闭，而不是只靠这道静态校验。
- 建页时会把库样式表复制到页面旁边（约 340 KB / 80 个文件）。这是拿体积换**自包含**：
  页面双击就能打开，不发网络请求，发给别人也不会掉样式。
- `ai shot`（横向溢出与 JS 报错的截图体检）还没接进来 —— 它是「看」的循环，与这里「写对 + 发出去」不是一条线。
- PDF 是**屏幕渲染结果**。实体打印机的纸张、驱动缩放、双面、页眉页脚仍需人工打样一次；`agentcss_pdf` 不声称替你验过。

## 设计取舍

- **壳不覆盖已有文件，失败也不留半套。** 目标 `index.html` 存在时默认拒绝，除非显式
  `overwrite: true`（它可能正在被改）。建页会先写进同目录的临时构建目录，HTML 和样式
  都生成成功后才提交；提交时旧 `index.html` 先备份，中途任一步失败自动还原。
  样式目录只覆盖库自带的同名文件，**不删除**你放在 `agentcss/` 里的其它文件；
  代价是库升级后废弃的旧文件可能留在目录里（不会被页面引用，可自行清理）。
- **版本范围收紧到 `^0.27.7`。** 0.x 的 caret 是「只在这个 minor 内」，
  库出 0.28 时插件要跟着升一次。这是有意的：CLI 的开关语义比 CSS 更容易变。
  下限选 0.27.7，是因为过半能力取决于库那一层：
  0.27.3 之前是灰底浅字；0.27.4 之前 `.rep__fig` 里的图没有宽度约束，
  一张 1920px 的截图会把整页撑破；0.27.5 才把仓库名与包名统一；
  **0.27.7 之前，PDF 导出判定失败（超页数预算 / 页树读数不一致）会先替换
  最终输出再报错，把调用方手里的旧 PDF 悄悄换掉** —— 而本插件对外承诺
  「失败或超预算时不改写旧 PDF」。这条承诺由库兑现，所以下限必须卡在修复版，
  冒烟测试也把「预置旧 PDF + 超预算 ⇒ 逐字节不变」写成了硬断言。

## 发版

打 tag 即发版。走 GitHub Actions + OIDC，**不需要任何长期令牌**：

```sh
# 改 package.json 的 version（或 npm version patch --no-git-tag-version）
git commit -am "chore: 0.2.5"
git tag -a v0.2.5 -m "agentcss ^0.27.7"
git push --atomic origin main v0.2.5
```

`.github/workflows/release.yml` 依次做五件事：tag 与 `package.json` 版本一致 →
加载契约冒烟 → 拒绝长期令牌（有 token 会盖过 OIDC，包就没有签名）→
`npm publish --provenance` → 建 GitHub Release。

⚠️ npm 后台那条 trusted publisher 绑的是**仓库名 + 工作流文件名**。
改仓库名、或把 `release.yml` 改名，发布就会失效（404/403），必须同步去
npm 的 Settings → Trusted publishing 重新绑一次。

## License

MIT
