# dsh-plugin-agentcss

> DeepSeek Harness 插件：让 agent 写出**能看**的报告页，而不是一堆没样式的 div。

English: DeepSeek Harness tools for [agentcss](https://github.com/owain323/frontend-lib) —
look up components, scaffold a report page, and validate the result before delivery.

---

## 它解决什么

让模型写 HTML 报告，有三个**不会报错、只会静默失效**的坑：

| 坑 | 现象 | 谁能发现 |
|---|---|---|
| 类名凭感觉编 | 页面上没有报错，只是那一块没有样式 | 没人，直到人打开看 |
| `<head>` 漏一条 `<link>` | 组件类名都对，但那部分完全没样式 | 没人，直到人打开看 |
| 骨架层级错 | 布局塌了，但不抛异常 | 没人，直到人打开看 |

这个插件给三个工具，正好对应这三件事：**查得到、起得对、交得出去**。

## 安装

Harness 里「添加插件」，三个入口任选其一：

- **npm 包名**：`dsh-plugin-agentcss`
- **GitHub 地址**：`https://github.com/owain323/dsh-plugin-agentcss`
- **本地目录**：克隆后填目录路径

命令行等价写法：

```sh
dsh plugin --profile desktop add dsh-plugin-agentcss
```

装完重启 Harness。工具会出现在模型的可调用列表里，名字以 `agentcss_` 开头。

## 三个工具

| 工具 | 什么时候用 | 返回什么 |
|---|---|---|
| `agentcss_catalog` | 写 HTML 之前。按关键词或分层查组件 | 组件 id、分层、根类名、**要引的样式表路径**、一句话用途 |
| `agentcss_new_page` | 新页面从这一步开始，不要手写 `<head>` | 一个自包含目录：`index.html` + `agentcss/`（库样式表副本） |
| `agentcss_check` | 每次改完页面 | 结构化问题列表：规则名、行号、级别、说明 |

`agentcss_check` 查的是：类名库里有没有、类名有但这页没引到定义它的样式表、图缺不缺 `alt`、
表头有没有 `scope`、标题有没有跳级、表单控件有没有可读名称、id 有没有重复……
**纯静态，不联网、不开浏览器。**

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

这个包只有约 400 行适配代码，**没有任何组件定义**。

组件、令牌、判据全部来自 npm 上的 `agentcss`。这是刻意的：`agentcss_check` 的类名白名单是
**从库的 CSS 现算**的，复制一份组件树过来就等于同时存在两份真值，改一次 token 就开始不同步，
而且两边各跑各的门禁，没人会发现。所以这里只做一件事——把模型的意图翻译成库的命令行调用。

## 依赖与兼容

| 项 | 要求 |
|---|---|
| Node | >= 18（Harness 桌面版自带 24） |
| `agentcss` | `^0.27.0` —— 需要 `ai scaffold` 与 `ai check <page.html>` 这两个 0.27.0 才有的能力 |
| Harness | 0.2.x 实测（0.2.2-rc.1） |

两个刻意的选择：

- **不依赖任何 `@deepseek-ai/*` 包。** 不用 `defineTool`，直接用 `ctx.tools.register()` 注册裸定义。
  读 `dsh-tools` 的实现能确认二者等价（`defineTool` 只是把参数编译成 JSON Schema 的包装器），
  少一个 peer 依赖就少一整类版本解析故障。
- **不声明 `engines.dsh`。** 0.2.x 是预发布版，semver 的预发布规则会让 `>=0.2.0` 这类范围
  **判不通过**，安装直接被拒。宁可不写这一行。

## 已知限制

- `dir` / `path` 必须传**绝对路径**。写错会明确报错，不会猜。
- 建页时会把库样式表复制到页面旁边（约 340 KB / 80 个文件）。这是拿体积换**自包含**：
  页面双击就能打开，不发网络请求，发给别人也不会掉样式。
- `ai shot` / `ai pdf` 还没接进来（库里有这两个能力，插件暂只做「写对」这一段）。

## 设计取舍

- **壳不覆盖已有文件。** 目标 `index.html` 存在时默认拒绝，除非显式 `overwrite: true` ——
  它可能正在被改。
- **版本范围收紧到 `^0.27.0`。** 0.x 的 caret 是「只在这个 minor 内」，
  库出 0.28 时插件要跟着升一次。这是有意的：CLI 的开关语义比 CSS 更容易变。

## License

MIT
