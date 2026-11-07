/**
 * dsh-plugin-agentcss —— 把 agentcss 的四个动作，做成 DeepSeek Harness 能调的四个工具。
 *
 * ============================================================================
 * 🔴 这个包**不含任何组件定义**
 * ----------------------------------------------------------------------------
 * 组件、令牌、判据全部来自 npm 上的 `agentcss`，这里只负责：
 *   ① 把模型的意图翻译成 `ai/cli.js` 的调用
 *   ② 把 CLI 的 JSON 收敛成稳定的结构
 *   ③ 把结果说成人话
 *
 * 为什么不能把组件"分一半"过来：`ai check` 的类名白名单是**从库的 CSS 现算**的
 * （check-html.js 的 libraryClassMap）。复制一份组件树，等于同时存在两份真值，
 * 改一次 token 就开始不同步，而且两边门禁各跑各的，没人会发现。
 *
 * ============================================================================
 * 🔴 为什么不用 `@deepseek-ai/dsh-tools` 的 `defineTool`
 * ----------------------------------------------------------------------------
 * 读它的实现可以确认：`defineTool` 只是把 parameters 编译成一段 JSON Schema，
 * 再返回 `{ name, description, parameters, output, execute }` 这个**普通对象**；
 * 注册表本身只认这个对象。少一个 import，就少一整类 peer 版本解析故障 ——
 * 插件装进任意版本的 profile 都能加载。
 *
 * 代价：参数校验要自己兜。下面的 schema 都是 JSON Schema 子集
 * （只允许 type / properties / required / additionalProperties / items / enum / description），
 * 注册时会由 dsh-tools 断言，写错当场红。
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

/** 插件在 Cordis 里的名字。与 package.json 的 name 是两回事。 */
export const name = 'agentcss'

/** 只依赖工具注册表：没有 tools 服务就没有这个插件存在的意义。 */
export const inject = ['tools']

/** 复制到页面目录里的库子目录。只复制这五个，`COSTS.md` / `manifest.json` 不进去。 */
const VENDOR_DIRS = ['01-tokens', '02-primitives', '03-patterns', '04-recipes', '09-assets']

/** 组件分层。与 ai/components.json 的 summary.byTier 一致。 */
const TIERS = ['primitive', 'pattern', 'recipe', 'asset']

/** 读不到 ai/recipes.json 时的兜底（正常情况下用不到）。 */
const FALLBACK_RECIPES = ['report/finance', 'report/technical', 'report/magazine']

const require = createRequire(import.meta.url)

let cachedRoot = null

/**
 * 找到已安装的 agentcss 包根目录。
 * 解析失败时不抛在 apply 里 —— 让插件先加载成功，把原因留到每次调用时说明，
 * 这样用户看到的是"工具为什么不能用"，而不是"插件消失了"。
 */
function libraryRoot() {
  if (cachedRoot) return cachedRoot
  let pkg
  try {
    pkg = require.resolve('agentcss/package.json')
  } catch {
    throw new Error(
      '找不到 agentcss 依赖。这个插件不含组件定义，必须有一份 agentcss 才能工作：'
      + '在插件目录执行 `npm install`，或确认安装时 dependencies 没有被裁掉。',
    )
  }
  cachedRoot = path.dirname(pkg)
  return cachedRoot
}

function readLibraryJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(libraryRoot(), rel), 'utf8'))
}

/** 版式清单从 recipes.json 现算，不写死 —— 库加了版式，这里自动跟上。 */
function knownRecipes() {
  try {
    const recipes = readLibraryJson('ai/recipes.json').recipes
    const ids = Object.keys(recipes || {})
    return ids.length > 0 ? ids : FALLBACK_RECIPES
  } catch {
    return FALLBACK_RECIPES
  }
}

function textBlock(s) {
  return [{ type: 'text', text: s }]
}

function excerpt(s, max = 400) {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

/**
 * 跑一次 `ai/cli.js`。
 *
 * 用 `process.execPath` 而不是 `node`：Harness 桌面版跑在 Electron 里，
 * 直接 spawn "node" 会依赖外部 PATH；而 Electron 的 execPath 需要
 * `ELECTRON_RUN_AS_NODE=1` 才会退化成纯 Node（否则它会当成要开第二个 App）。
 * 两个分支都覆盖，插件在桌面版和 CLI 版都能跑。
 */
function runCli(args, { signal, timeout = 120000 } = {}) {
  const cli = path.join(libraryRoot(), 'ai', 'cli.js')
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { timeout, signal, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        if (error.name === 'AbortError') return reject(new Error('调用被取消'))
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr })
        if (error.killed) return reject(new Error(`agentcss 超过 ${timeout}ms 没有结束：${args.join(' ')}`))
        return reject(new Error(`启动 agentcss 失败：${error.message}`))
      },
    )
  })
}

/** CLI 每个子命令都支持 --json；这里只做"从第一段 { 开始parse"的容错，不做猜测。 */
function parseJsonOut(stdout) {
  const s = String(stdout || '').trim()
  const at = s.indexOf('{')
  if (at < 0) throw new Error(`agentcss 没有输出 JSON：${excerpt(s) || '(空)'}`)
  try {
    return JSON.parse(s.slice(at))
  } catch {
    throw new Error(`agentcss 输出的不是合法 JSON：${excerpt(s)}`)
  }
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 不能为空`)
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} 要传绝对路径（收到的是 "${value}"）。先确认当前工作目录，再拼成完整路径。`)
  }
  return path.normalize(value)
}

function walkSize(dir) {
  let files = 0
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = walkSize(full)
      files += sub.files
      bytes += sub.bytes
    } else if (entry.isFile()) {
      files += 1
      bytes += fs.statSync(full).size
    }
  }
  return { files, bytes }
}

/**
 * 把 dist 的五个目录复制进**本次新建的构建目录**。
 * 这里不删除任何东西：目标是刚由 mkdtempSync 造出来的空目录。
 */
function vendorStyles(target) {
  const root = libraryRoot()
  let files = 0
  let bytes = 0
  for (const sub of VENDOR_DIRS) {
    const from = path.join(root, 'dist', sub)
    if (!fs.existsSync(from)) continue
    const to = path.join(target, sub)
    fs.cpSync(from, to, { recursive: true, force: true })
    const size = walkSize(to)
    files += size.files
    bytes += size.bytes
  }
  return { files, bytes }
}

/**
 * 把构建目录里的样式提交到页面目录。
 *
 * 🔴 只覆盖同名文件，**绝不删目标目录里多出来的文件**。
 *    旧实现是 `fs.rmSync(to, {recursive:true})` 再整目录复制：用户自己放在
 *    agentcss/01-tokens/ 里的 CSS 会被一起删掉，而且这一步完全不受
 *    `overwrite` 控制（连"目标 index.html 不存在、纯新建"都会删）。
 *    代价是库升级后废弃的旧文件会留下 —— 多一个用不到的文件，
 *    比静默丢掉用户文件好得多；库文件名本身是稳定的契约。
 */
function commitStyles(builtCss, cssDir) {
  fs.mkdirSync(cssDir, { recursive: true })
  for (const sub of VENDOR_DIRS) {
    const from = path.join(builtCss, sub)
    if (!fs.existsSync(from)) continue
    fs.cpSync(from, path.join(cssDir, sub), { recursive: true, force: true })
  }
}

/* ==========================================================================
 * 工具一：查组件
 * ========================================================================== */

const CATALOG_OUT = {
  type: 'object',
  properties: {
    version: { type: 'string' },
    total: { type: 'number' },
    matched: { type: 'number' },
    components: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tier: { type: 'string' },
          rootClass: { type: 'string' },
          css: { type: 'string' },
          purpose: { type: 'string' },
          slots: { type: 'number' },
        },
        required: ['id', 'tier', 'rootClass', 'css', 'purpose', 'slots'],
        additionalProperties: false,
      },
    },
  },
  required: ['version', 'total', 'matched', 'components'],
  additionalProperties: false,
}

function renderCatalog(value) {
  const lines = []
  lines.push(`agentcss ${value.version} · 共 ${value.total} 个组件`)
  if (value.matched === 0) {
    lines.push('没有匹配的组件。换一个关键词，或去掉 tier 过滤。')
    return lines.join('\n')
  }
  lines.push(`匹配 ${value.matched} 个${value.matched > value.components.length ? `，先给前 ${value.components.length} 个` : ''}：\n`)
  for (const c of value.components) {
    lines.push(`- ${c.id} [${c.tier}] ${c.rootClass ? '.' + c.rootClass : '(无根类名)'} — ${c.purpose}`)
    lines.push(`  css: agentcss/${c.css}`)
  }
  lines.push('')
  lines.push('用到哪个就加一条 <link rel="stylesheet" href="agentcss/…">；')
  lines.push('漏引的话 agentcss_check 会报 class-not-linked。')
  return lines.join('\n')
}

function catalogTool() {
  return {
    name: 'agentcss_catalog',
    description:
      '查 agentcss 组件库（零依赖 CSS 库，面向报告/分析页面）。写 HTML 之前先查，'
      + '保证类名是库里真有的、样式表引对。返回组件 id、所属层、根类名、要引的样式表、一句话用途。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '关键词，匹配组件 id / 根类名 / 用途 / 样式表路径。不传则按层列前 N 个。',
        },
        tier: {
          type: 'string',
          enum: TIERS,
          description: 'primitive=基础件；pattern=组合件；recipe=整页版式；asset=图表等资产。',
        },
        limit: { type: 'number', description: '返回条数上限，默认 12，最大 40。' },
      },
      additionalProperties: false,
    },
    output: { schema: CATALOG_OUT, render: (_args, value) => textBlock(renderCatalog(value)) },
    async execute(args) {
      const data = readLibraryJson('ai/components.json')
      const all = Array.isArray(data.components) ? data.components : []
      const query = String(args.query || '').trim().toLowerCase()
      const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 12), 1), 40)

      let list = all
      if (args.tier) list = list.filter((c) => c.tier === args.tier)
      if (query) {
        list = list.filter((c) => {
          const hay = [c.id, c.rootClass, c.purpose, c.files && c.files.css].join(' ').toLowerCase()
          return hay.includes(query)
        })
      }

      const components = list.slice(0, limit).map((c) => ({
        id: String(c.id),
        tier: String(c.tier),
        rootClass: String(c.rootClass || ''),
        css: String((c.files && c.files.css) || ''),
        purpose: excerpt(c.purpose, 90),
        slots: Array.isArray(c.slots) ? c.slots.length : 0,
      }))

      return {
        version: String(data.libraryVersion || ''),
        total: Number((data.summary && data.summary.total) || all.length),
        matched: list.length,
        components,
      }
    },
  }
}

/* ==========================================================================
 * 工具二：新建页面
 * ========================================================================== */

const NEW_PAGE_OUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    html: { type: 'string' },
    cssDir: { type: 'string' },
    recipe: { type: 'string' },
    requires: { type: 'array', items: { type: 'string' } },
    cssFiles: { type: 'number' },
    cssBytes: { type: 'number' },
  },
  required: ['ok', 'html', 'cssDir', 'recipe', 'requires', 'cssFiles', 'cssBytes'],
  additionalProperties: false,
}

function renderNewPage(value) {
  const lines = []
  lines.push(`已生成 ${value.html}`)
  lines.push(`版式：${value.recipe}`)
  lines.push(`样式表：${value.cssDir}（${value.cssFiles} 个文件，${Math.round(value.cssBytes / 1024)} KB，页面用相对路径 agentcss/… 引用，双击就能打开）`)
  if (value.requires.length > 0) {
    lines.push(`这一版式的必有件：${value.requires.join('、')}`)
  }
  lines.push('')
  lines.push('下一步：把占位文字换成内容（别改骨架层级），改完跑 agentcss_check。')
  return lines.join('\n')
}

function newPageTool(recipes) {
  return {
    name: 'agentcss_new_page',
    description:
      '新建一个自包含的报告页目录：正确的 HTML 骨架 + 一份库样式表的本地副本。'
      + '新页面都从这里开始，不要手写 <head> —— 漏一条 <link> 或错一层容器，页面不会报错，只会静默地长得不对。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '目标目录的绝对路径。会在里面生成 index.html 和 agentcss/。目录会被创建。',
        },
        recipe: {
          type: 'string',
          enum: recipes,
          description: 'report/finance=金融研究；report/technical=科研技术；report/magazine=杂志编辑。默认第一个。',
        },
        overwrite: {
          type: 'boolean',
          description: '目标 index.html 已存在时是否重建。默认 false（壳不覆盖正在被改的文件）；'
            + '设为 true 时会先备份旧文件，任何一步失败都自动还原。',
        },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    output: { schema: NEW_PAGE_OUT, render: (_args, value) => textBlock(renderNewPage(value)) },
    async execute(args, exec) {
      const dir = requireAbsolute(args.dir, 'dir')
      const recipe = args.recipe || recipes[0]
      const html = path.join(dir, 'index.html')
      const cssDir = path.join(dir, 'agentcss')

      /* ① 前置判定全部在**动手之前**做完：拒绝时不碰目标一个字节 */
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
        throw new Error(`${dir} 已存在且不是目录。`)
      }
      const hadHtml = fs.existsSync(html)
      if (hadHtml && args.overwrite !== true) {
        throw new Error(
          `目标已存在：${html}。壳不会覆盖已有文件（它可能正在被改）。`
          + '换一个 dir，或显式传 overwrite=true。',
        )
      }

      /* ② 全部产物先落进同目录的临时构建目录。
             scaffold 失败 / 复制失败 ⇒ 直接清掉，目标目录完全没被写过。 */
      fs.mkdirSync(dir, { recursive: true })
      const build = fs.mkdtempSync(path.join(dir, '.agentcss-build-'))
      const builtHtml = path.join(build, 'index.html')
      const builtCss = path.join(build, 'agentcss')
      /* 旧 HTML 的备份放在 dir 里、**不在** build 里：这样 finally 清 build
         时不会把"回滚失败后唯一的用户副本"一起删掉。 */
      const backup = hadHtml
        ? path.join(dir, `.agentcss-prev-${process.pid}-${Date.now().toString(36)}.html`)
        : null

      try {
        const result = await runCli(
          ['scaffold', recipe, '--out', builtHtml, '--css-prefix=agentcss', '--json'],
          { signal: exec && exec.signal },
        )
        const out = parseJsonOut(result.stdout)
        if (result.code !== 0 || !out.ok) {
          const detail = (out.error && out.error.message) || excerpt(result.stderr) || '未知原因'
          throw new Error(`scaffold 失败（退出码 ${result.code}）：${detail}`)
        }
        const size = vendorStyles(builtCss)

        /* ③ 提交：先备份旧 HTML（同盘 rename，原子），再落新 HTML。
               任何一步抛错，catch 都把旧 HTML 还原回去。 */
        if (backup) fs.renameSync(html, backup)
        fs.renameSync(builtHtml, html)
        commitStyles(builtCss, cssDir)
        if (backup) fs.rmSync(backup, { force: true })

        return {
          ok: true,
          html,
          cssDir,
          recipe,
          requires: Array.isArray(out.requires) ? out.requires.map(String) : [],
          cssFiles: size.files,
          cssBytes: size.bytes,
        }
      } catch (e) {
        if (backup && fs.existsSync(backup)) {
          try {
            if (fs.existsSync(html)) fs.rmSync(html, { force: true })
            fs.renameSync(backup, html)
          } catch {
            throw new Error(
              `${e.message}\n  另外：旧的 ${html} 已备份在 ${backup}，`
              + '自动还原失败 —— 请手工取回，别直接删。',
            )
          }
        } else if (!hadHtml && fs.existsSync(html)) {
          /* 目标原本没有 index.html：提交到一半失败，不能凭空留一份半成品
             让人以为建页成功了。删掉它，回到"什么都没发生"的状态。 */
          try { fs.rmSync(html, { force: true }) } catch { /* 下面照常抛原错 */ }
        }
        throw e
      } finally {
        try {
          fs.rmSync(build, { recursive: true, force: true, maxRetries: 3 })
        } catch { /* Windows 偶发占用；下次建页不受影响 */ }
      }
    },
  }
}

/* ==========================================================================
 * 工具三：交付前自检
 * ========================================================================== */

const CHECK_OUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    errors: { type: 'number' },
    warnings: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule: { type: 'string' },
          level: { type: 'string' },
          line: { type: 'number' },
          msg: { type: 'string' },
        },
        required: ['rule', 'level', 'msg'],
        additionalProperties: false,
      },
    },
    unchecked: { type: 'number' },
    css: {
      type: 'object',
      properties: {
        localSheets: { type: 'number' },
        remoteSheets: { type: 'number' },
        inlineStyle: { type: 'boolean' },
        libraryClasses: { type: 'number' },
      },
      required: ['localSheets', 'remoteSheets', 'inlineStyle', 'libraryClasses'],
      additionalProperties: false,
    },
  },
  required: ['ok', 'errors', 'warnings', 'findings', 'unchecked', 'css'],
  additionalProperties: false,
}

function renderCheck(value) {
  const lines = []
  const head = value.ok ? '通过' : '不通过'
  lines.push(`${head}：${value.errors} 个 error · ${value.warnings} 个 warn（引了 ${value.css.localSheets} 个本地样式表，库里 ${value.css.libraryClasses} 个类名）`)
  if (value.findings.length > 0) {
    lines.push('')
    for (const f of value.findings) {
      const at = typeof f.line === 'number' ? `L${f.line}` : '—'
      lines.push(`  ${at.padEnd(6)} ${f.level.padEnd(5)} ${f.rule}  ${f.msg}`)
    }
  }
  if (value.unchecked > 0) {
    lines.push('')
    lines.push(`另有 ${value.unchecked} 条没有可查标记，工具不判（例如"篇幅不超过两屏"）。`)
  }
  if (value.css.localSheets === 0) {
    lines.push('')
    lines.push('提示：一个本地样式表都没读到 —— 先用 agentcss_new_page 建页，或检查 <link> 的相对路径。')
  }
  if (!value.ok) {
    lines.push('')
    lines.push('error 必须修完再交付；warn 里 class-unknown 通常意味着类名拼错或漏引样式表。')
  }
  return lines.join('\n')
}

function checkTool(recipes) {
  return {
    name: 'agentcss_check',
    description:
      '按 agentcss 的规则校验生成好的 HTML：类名库里有没有、样式表引没引到、图缺不缺 alt、'
      + '表头有没有 scope、标题层级跳没跳。改完页面就跑一次，error 清零再交付。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要校验的 HTML 绝对路径。' },
        recipe: {
          type: 'string',
          description: `按某个版式的「必有件」一起判。可选：${recipes.join('、')}。不传只跑通用规则。`,
        },
        strict: { type: 'boolean', description: '把 warn 也当失败（默认 false）。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: CHECK_OUT, render: (_args, value) => textBlock(renderCheck(value)) },
    async execute(args, exec) {
      const file = requireAbsolute(args.path, 'path')
      if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`)

      const cliArgs = ['check', file, '--json']
      if (args.recipe) cliArgs.push(`--recipe=${args.recipe}`)
      if (args.strict === true) cliArgs.push('--strict')

      const result = await runCli(cliArgs, { signal: exec && exec.signal })
      const out = parseJsonOut(result.stdout)

      if (result.code !== 0 && result.code !== 1) {
        const detail = (out.error && out.error.message) || excerpt(result.stderr) || '未知原因'
        throw new Error(`check 没能跑完（退出码 ${result.code}）：${detail}`)
      }

      const counts = out.counts || {}
      const sources = out.sources || {}
      const findings = (Array.isArray(out.findings) ? out.findings : []).map((f) => {
        const item = {
          rule: String(f.rule),
          level: String(f.level),
          msg: String(f.msg),
        }
        if (typeof f.line === 'number') item.line = f.line
        return item
      })

      return {
        ok: out.ok === true,
        errors: Number(counts.error || 0),
        warnings: Number(counts.warn || 0),
        findings,
        unchecked: Array.isArray(out.notes) ? out.notes.length : 0,
        css: {
          localSheets: Number(sources.localSheets || 0),
          remoteSheets: Number(sources.remoteSheets || 0),
          inlineStyle: sources.inlineStyle === true,
          libraryClasses: Number(sources.libraryClasses || 0),
        },
      }
    },
  }
}

/* ==========================================================================
 * 工具四：导出 PDF
 * ==========================================================================
 * 为什么单独做一个工具、而不是让模型自己拼命令：
 * `ai pdf` 的导出顺序是**契约**（load → fonts.ready → 可选可见元素 → 额外等待
 * → 动画终态 → printToPDF），失败时旧文件必须原样保留、超页数预算不许静默截断。
 * 这些规矩写在库的门禁里；插件这边只负责把参数收敛成那几条，别让模型即兴发挥。
 */

const PAPERS = ['a4', 'letter', 'a5', 'a3', 'legal']

const PDF_OUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    out: { type: 'string' },
    pages: { type: 'number' },
    bytes: { type: 'number' },
    paper: { type: 'string' },
    paperSize: { type: 'string' },
    margin: { type: 'string' },
    jsErrors: { type: 'number' },
  },
  required: ['ok', 'out', 'pages', 'bytes', 'paper', 'paperSize', 'margin', 'jsErrors'],
  additionalProperties: false,
}

function renderPdf(value) {
  const kb = Math.max(1, Math.round(value.bytes / 1024))
  const lines = [
    `已导出：${value.out}`,
    `${value.pages} 页 · ${value.paperSize} · ${kb} KB · 纸幅 ${value.paper} · 边距 ${value.margin}`,
  ]
  if (value.jsErrors > 0) {
    lines.push('')
    lines.push(`⚠️ 页面有 ${value.jsErrors} 条未捕获的 JS 异常 —— 导出的内容可能缺块，先修页面再导一次。`)
  }
  lines.push('')
  lines.push('这是屏幕渲染的电子 PDF。实体打印机的纸张、缩放、双面、页眉页脚仍需人工打样一次。')
  return lines.join('\n')
}

function pdfTool() {
  return {
    name: 'agentcss_pdf',
    description:
      '把 HTML 页面导出成 PDF（本机 Chrome/Edge 无头渲染，等字体与就绪元素后再打印）。'
      + '失败或超出页数预算时不会改写已有的旧 PDF，也不会替你截断内容。'
      + '页面改完要发出去、或者要交给打印时用这一步。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'HTML 绝对路径，或 http(s) 地址。' },
        out: {
          type: 'string',
          description: 'PDF 输出绝对路径。省略时与 HTML 同名同目录；远程地址必须显式给。',
        },
        paper: {
          type: 'string',
          enum: PAPERS,
          description: '纸张，默认 a4。页面自己写了 @page 时以页面为准，这个参数不生效。',
        },
        margin: { type: 'string', description: 'CSS 长度，例如 "18mm 15mm"。' },
        maxPages: {
          type: 'number',
          description: '页数上限（≥1）。超了判失败并保留完整产物 —— 不替你截断。',
        },
        waitMs: {
          type: 'number',
          description: '字体就绪后再等多少毫秒（0–60000，默认 800）。',
        },
        readySelector: {
          type: 'string',
          description: '必须可见且有尺寸才算就绪的 CSS 选择器；只存在但 display:none 不算。',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: PDF_OUT, render: (_args, value) => textBlock(renderPdf(value)) },
    async execute(args, exec) {
      const raw = typeof args.path === 'string' ? args.path : ''
      const remote = /^https?:\/\//i.test(raw)
      if (!remote && raw.trim() === '') throw new Error('path 不能为空')
      const src = remote ? raw : requireAbsolute(raw, 'path')
      if (!remote && !fs.existsSync(src)) throw new Error(`找不到文件：${src}`)

      const cliArgs = ['pdf', src, '--json']
      if (args.out !== undefined) cliArgs.push(`--out=${requireAbsolute(args.out, 'out')}`)

      if (args.paper !== undefined) {
        if (!PAPERS.includes(args.paper)) {
          throw new Error(`paper 只能是 ${PAPERS.join(' / ')}，收到 "${args.paper}"`)
        }
        cliArgs.push(`--paper=${args.paper}`)
      }

      if (args.margin !== undefined) {
        if (typeof args.margin !== 'string' || args.margin.trim() === '') {
          throw new Error('margin 不能为空；不需要就整个参数不传')
        }
        cliArgs.push(`--margin=${args.margin}`)
      }

      if (args.maxPages !== undefined) {
        if (!Number.isInteger(args.maxPages) || args.maxPages < 1) {
          throw new Error(`maxPages 必须是不小于 1 的整数，收到 ${args.maxPages}`)
        }
        cliArgs.push(`--max-pages=${args.maxPages}`)
      }

      if (args.waitMs !== undefined) {
        if (!Number.isInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 60000) {
          throw new Error(`waitMs 必须是 0–60000 的整数，收到 ${args.waitMs}`)
        }
        cliArgs.push(`--wait-ms=${args.waitMs}`)
      }

      if (args.readySelector !== undefined) {
        if (typeof args.readySelector !== 'string' || args.readySelector.trim() === '') {
          throw new Error('readySelector 必须是非空 CSS 选择器')
        }
        cliArgs.push(`--ready-selector=${args.readySelector}`)
      }

      // 渲染要起浏览器；120 秒是 CLI 调用的默认值，PDF 这边放宽一档。
      const result = await runCli(cliArgs, { signal: exec && exec.signal, timeout: 180000 })

      let out = null
      try {
        out = parseJsonOut(result.stdout)
      } catch {
        out = null
      }

      if (result.code !== 0) {
        const detail = (out && out.error && out.error.message)
          || excerpt(result.stderr) || excerpt(result.stdout) || '未知原因'
        throw new Error(`pdf 没能导出（退出码 ${result.code}）：${detail}`)
      }
      if (!out) throw new Error(`pdf 没有输出 JSON：${excerpt(result.stdout) || '(空)'}`)
      if (!out.out) throw new Error('导出报告里没有产物路径，视同失败')

      // 报告说成功、文件却不在（或 0 字节）—— 这类"假成功"必须在插件层拦住，
      // 不能交给模型去核。
      const bytes = Number(out.bytes || 0)
      if (bytes <= 0) throw new Error(`导出的 PDF 是空文件：${out.out}`)
      if (!fs.existsSync(out.out)) {
        throw new Error(`导出报告说成功，但目标文件不在：${out.out}（检查输出目录是否可写）`)
      }

      return {
        ok: true,
        out: String(out.out),
        pages: Number(out.pages || 0),
        bytes,
        paper: String(out.paper || '由页面自己决定'),
        paperSize: String(out.paperSize || '?'),
        margin: String(out.margin || '由页面自己决定'),
        jsErrors: Array.isArray(out.jsErrors) ? out.jsErrors.length : 0,
      }
    },
  }
}

/** 插件入口。Cordis 会把 `ctx` 给进来，注册出去的东西卸载时自动撤掉。 */
export function apply(ctx) {
  const recipes = knownRecipes()
  ctx.tools.register(catalogTool())
  ctx.tools.register(newPageTool(recipes))
  ctx.tools.register(checkTool(recipes))
  ctx.tools.register(pdfTool())
}
