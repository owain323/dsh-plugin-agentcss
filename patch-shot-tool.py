# -*- coding: utf-8 -*-
"""dsh-plugin-agentcss：加第 5 工具 agentcss_shot（「看」的闭环）。

按交接文档 §4：
- 薄层：把 ai shot --json 的 verdict 结构化结果翻译成 agent 可读的返回，
  不含任何组件/判定定义（判定语义在库的 ai/shot-verdict.js，随包发布）
- 远程 http(s) 默认关闭，沿用 pdf 的三层网络边界（assertSafeRemoteUrl +
  allowRemote + --network-policy=strict），不另起一套
- 注册方式沿用 ctx.tools.register(裸对象)

同时更新：
- README「已知限制」段（ai shot 已接入，删掉那行"还没接进来"）
- test/smoke.mjs 的工具清单断言（4 → 5）
"""
import io
import re

p = r'C:\Users\czj17751\.zcode\workspace\draft-de03321d-1117-49f6-878c-567330e02793\dsh-plugin\index.js'
s = io.open(p, encoding='utf-8').read()

# ① 在 pdfTool 定义之后插入 shotTool（找到 pdfTool 的收尾——renderPdf 定义之后）
anchor = "function pdfTool() {"
assert s.count(anchor) == 1, 'pdfTool anchor'

SHOT_TOOL = r'''function shotTool() {
  return {
    name: 'agentcss_shot',
    description:
      '真渲染截图体检：按给定视口宽度真实渲染页面，返回**结构化判定**（verdict）与截图。'
      + 'verdict 分型：pass（无溢出无报错）/ warn（溢出在设计内滚动容器里，表格横向滚动属此类，'
      + '确认是契约行为即可）/ fail（真溢出、JS 报错、采集不完整）。'
      + '页面改完、交付之前跑这一步 —— 溢出、JS 报错、真实渲染效果，静态 check 结构性看不到。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'HTML 绝对路径（推荐），或 http(s) 地址（默认关闭，见 allowRemote）。'
            + '远程地址边界与 agentcss_pdf 相同：环回/私网/非 http(s) 拒绝。',
        },
        allowRemote: {
          type: 'boolean',
          description: '是否允许渲染远程 http(s) 地址。默认 false。仅当 path 来自'
            + '受信任输入、且已装 agentcss >= 0.27.15 时才传 true；不可信内容能影响 '
            + 'path 时保持关闭。开启会附带 --network-policy=strict。',
        },
        widths: {
          type: 'array',
          items: { type: 'number' },
          description: '视口宽度列表（200–4000 的整数），默认 [390, 1440]。'
            + '每个宽度都会截一张并各自出判定。',
        },
        height: {
          type: 'number',
          description: '视口高度（200–4000 的整数），默认 900。',
        },
        full: {
          type: 'boolean',
          description: '整页截图（超过 10000px 会截断并在结果里注明）。默认 false。',
        },
        waitMs: {
          type: 'number',
          description: '加载后额外等待毫秒（0–60000，默认 800）。',
        },
        outPrefix: {
          type: 'string',
          description: '截图输出绝对路径前缀，自动加 {width} 与 .png。'
            + '省略时输出到 HTML 同目录：agentcss-shot-{width}.png。',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: SHOT_OUT, render: (_args, value) => textBlock(renderShot(value)) },
    async execute(args, exec) {
      const raw = typeof args.path === 'string' ? args.path : ''
      const looksRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      const isHttp = /^https?:\/\//i.test(raw)
      if (!looksRemote && raw.trim() === '') throw new Error('path 不能为空')
      const src = looksRemote ? assertSafeRemoteUrl(raw) : assertSafePath(raw, 'path')
      if (isHttp) assertRemoteCapability(args.allowRemote, libraryVersion())
      if (!looksRemote && !fs.existsSync(src)) throw new Error(`找不到文件：${src}`)

      const widths = Array.isArray(args.widths) && args.widths.length
        ? args.widths.map(Number)
        : undefined
      const outPrefix = typeof args.outPrefix === 'string' && args.outPrefix.trim() !== ''
        ? assertSafePath(args.outPrefix, 'outPrefix')
        : path.join(
            path.dirname(src),
            looksRemote ? 'agentcss-shot-{width}.png' : 'agentcss-shot-{width}.png',
          )

      const cliArgs = ['shot', src, '--json',
        `--out=${outPrefix}`,
        '--width=' + (widths ? widths.join(',') : ''),
      ]
      if (args.height !== undefined) cliArgs.push(`--height=${Number(args.height)}`)
      if (args.full === true) cliArgs.push('--full')
      if (args.waitMs !== undefined) cliArgs.push(`--wait=${Number(args.waitMs)}`)
      if (isHttp) cliArgs.push('--network-policy=strict')
      cliArgs.push('--chrome=' + resolveChromePath())

      const result = await runCli(cliArgs, { signal: exec && exec.signal })
      const out = parseJsonOut(result.stdout)

      if (result.code !== 0 && !out.ok && !out.verdict) {
        const detail = (out.error && out.error.message) || excerpt(result.stderr) || '未知原因'
        throw new Error(`shot 没能跑完（退出码 ${result.code}）：${detail}`)
      }

      /* verdict 是库的 ai/shot-verdict.js 算的（判定语义固化在库里），
         插件只透传，不二次解释 —— 解释层放插件里就会两处漂移。 */
      return {
        ok: out.ok === true,
        verdict: out.verdict || { status: 'fail', reasons: [], summary: '库未返回 verdict' },
        summary: typeof out.summary === 'string' ? out.summary : '',
        consoleErrors: Array.isArray(out.consoleErrors) ? out.consoleErrors : [],
        shots: (Array.isArray(out.shots) ? out.shots : []).map((s) => ({
          width: Number(s.width),
          out: String(s.out),
          overflowCount: Number(s.overflowCount || 0),
          overflow: Array.isArray(s.overflow) ? s.overflow : [],
        })),
      }
    },
  }
}

function renderShot(value) {
  const lines = []
  const v = value.verdict || { status: 'fail', reasons: [], summary: '' }
  const mark = v.status === 'pass' ? '✅' : v.status === 'warn' ? '⚠️' : '🔴'
  lines.push(`${mark} 判定：${v.status.toUpperCase()} —— ${v.summary}`)
  for (const r of v.reasons || []) {
    lines.push(`  [${r.severity}] ${r.where}  ${r.code}  ${r.detail}`)
  }
  if ((value.consoleErrors || []).length > 0) {
    lines.push('')
    lines.push(`JS 报错 ${value.consoleErrors.length} 条：`)
    for (const e of value.consoleErrors.slice(0, 5)) lines.push('  ' + e)
  }
  for (const s of value.shots || []) {
    lines.push(`  截图：${s.out}（${s.png ? s.png.width + '×' + s.png.height : ''}）`)
  }
  return lines.join('\n')
}
'''

# 插入位置：pdfTool 的收尾之后（找 "  }\n}" 不好定位——插在 export apply 之前）
m = re.search(r'/\*\* 插件入口。', s)
assert m, 'apply 入口注释未找到'
insert_at = m.start()
block = SHOT_TOOL.replace('textBlock(renderShot(value))', 'textBlock(renderShot(value))')
# SHOT_OUT schema 常量也要定义——插在 shotTool 之前
shot_out_schema = r'''const SHOT_OUT = {
  type: 'object',
  required: ['ok', 'verdict'],
  properties: {
    ok: { type: 'boolean' },
    verdict: {
      type: 'object',
      required: ['status', 'reasons'],
      properties: {
        status: { enum: ['pass', 'warn', 'fail'] },
        reasons: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'severity', 'where', 'detail'],
            properties: {
              code: { type: 'string' },
              severity: { enum: ['pass', 'warn', 'fail'] },
              where: { type: 'string' },
              detail: { type: 'string' },
            },
          },
        },
      },
    },
    summary: { type: 'string' },
    consoleErrors: { type: 'array', items: { type: 'string' } },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          out: { type: 'string' },
          overflowCount: { type: 'number' },
          overflow: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

'''
s = s[:insert_at] + shot_out_schema + '\n' + SHOT_TOOL.replace('textBlock(renderShot(value))', 'textBlock(renderShot(value))') + '\n\n' + s[insert_at:]

# ② 注册第 5 工具
old2 = "  ctx.tools.register(pdfTool())"
new2 = "  ctx.tools.register(pdfTool())\n  ctx.tools.register(shotTool())"
assert s.count(old2) == 1
s = s.replace(old2, new2)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('index.js: shotTool + SHOT_OUT + registration done')

# ③ README 已知限制行更新
p2 = r'C:\Users\czj17751\.zcode\workspace\draft-de03321d-1117-49f6-878c-567330e02793\dsh-plugin\README.md'
s2 = io.open(p2, encoding='utf-8').read()
old3 = "- `ai shot`（横向溢出与 JS 报错的截图体检）还没接进来 —— 它是「看」的循环，与这里「写对 + 发出去」不是一条线。"
if old3 in s2:
    new3 = "- `ai shot`（「看」的循环）已接入（0.27.15 起）：agentcss_shot 返回结构化判定（verdict 分型：真溢出 fail / 设计内滚动 warn / JS 报错 fail）与截图。"
    s2 = s2.replace(old3, new3)
    io.open(p2, 'w', encoding='utf-8', newline='\n').write(s2)
    print('README 已知限制已更新')
else:
    print('README 行未找到（可能已被改过）——跳过')

# ④ smoke：工具清单 4 → 5
p4 = r'C:\Users\czj17751\.zcode\workspace\draft-de03321d-1117-49f6-878c-567330e02793\dsh-plugin\test\smoke.mjs'
s4 = io.open(p4, encoding='utf-8').read()
old4 = "for (const id of ['agentcss_catalog', 'agentcss_new_page', 'agentcss_check', 'agentcss_pdf']) {"
new4 = "for (const id of ['agentcss_catalog', 'agentcss_new_page', 'agentcss_check', 'agentcss_pdf', 'agentcss_shot']) {"
assert s4.count(old4) == 1
io.open(p4, 'w', encoding='utf-8', newline='\n').write(s4.replace(old4, new4))
print('smoke tool list updated')
