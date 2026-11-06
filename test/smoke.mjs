/**
 * 冒烟测试 —— 在**没有 Harness** 的情况下，把插件的契约验一遍。
 *
 * 验的是三件事，缺一件都不算通过：
 *   ① 模块能按 Cordis 的函数式插件加载（name / inject / apply）
 *   ② 四个工具的定义形状合法：parameters 与 output.schema 都落在
 *      dsh-tools 支持的 JSON Schema 子集里（写成 type 数组、写了 minLength，
 *      在 Harness 里会在 register 那一刻抛 UNSUPPORTED_SCHEMA）
 *   ③ 四个工具真的能跑：查得到组件、建得出页面、查得出错误、导得出 PDF
 *
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, inject, name } from '../index.js'

/* ---------- 一份 dsh-tools 子集的断言器（故意写得比实现更严） ---------- */

const TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']
const KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATIONS = new Set(['description', 'title'])

function assertSchema(node, at) {
  assert.ok(node && typeof node === 'object', `${at} 必须是对象`)
  for (const key of Object.keys(node)) {
    assert.ok(
      KEYWORDS.has(key) || ANNOTATIONS.has(key),
      `${at}.${key} 不是 dsh-tools 支持的关键字`,
    )
  }
  if (Object.hasOwn(node, 'description')) {
    assert.equal(typeof node.description, 'string', `${at}.description 必须是字符串`)
  }
  if (!Object.hasOwn(node, 'type')) return
  assert.equal(typeof node.type, 'string', `${at}.type 只能是单个字符串（不支持 type 数组）`)
  assert.ok(TYPES.includes(node.type), `${at}.type 取值不合法：${node.type}`)

  if (Object.hasOwn(node, 'enum')) {
    assert.ok(Array.isArray(node.enum) && node.enum.length > 0, `${at}.enum 必须是非空数组`)
    if (node.type === 'string') {
      assert.ok(node.enum.every((v) => typeof v === 'string'), `${at}.enum 混入了非字符串`)
    }
  }
  if (Object.hasOwn(node, 'additionalProperties')) {
    assert.equal(node.type, 'object', `${at}.additionalProperties 只能出现在 object 上`)
  }
  if (Object.hasOwn(node, 'items')) {
    assert.equal(node.type, 'array', `${at}.items 只能出现在 array 上`)
    assertSchema(node.items, `${at}.items`)
  }
  if (Object.hasOwn(node, 'properties')) {
    assert.equal(node.type, 'object', `${at}.properties 只能出现在 object 上`)
    for (const [key, value] of Object.entries(node.properties)) {
      assertSchema(value, `${at}.properties.${key}`)
    }
  }
  if (Object.hasOwn(node, 'required')) {
    assert.ok(Array.isArray(node.required), `${at}.required 必须是数组`)
    for (const key of node.required) {
      assert.ok(node.properties && Object.hasOwn(node.properties, key), `${at}.required 里的 ${key} 不在 properties 里`)
    }
  }
}

/* ---------- ① 加载契约 ---------- */

assert.equal(name, 'agentcss', 'name 必须是 agentcss')
assert.deepEqual(inject, ['tools'], 'inject 必须且只需要 tools')

const registered = []
apply({ tools: { register(def) { registered.push(def) } } })

assert.equal(registered.length, 4, '必须注册四个工具')
const tools = new Map(registered.map((def) => [def.name, def]))
for (const id of ['agentcss_catalog', 'agentcss_new_page', 'agentcss_check', 'agentcss_pdf']) {
  assert.ok(tools.has(id), `缺工具：${id}`)
}

/* ---------- ② 定义形状 ---------- */

for (const def of registered) {
  assert.equal(typeof def.description, 'string')
  assert.ok(def.description.length > 30, `${def.name} 的 description 太短，模型读不出用途`)
  assertSchema(def.parameters, `${def.name}.parameters`)
  assert.ok(def.output, `${def.name} 缺 output`)
  assertSchema(def.output.schema, `${def.name}.output.schema`)
  assert.equal(typeof def.output.render, 'function', `${def.name}.output.render 必须是函数`)
  assert.equal(typeof def.execute, 'function', `${def.name}.execute 必须是函数`)
}

/* ---------- ③ 真的能跑 ---------- */

// 默认用系统临时目录；本机可以用 AGENTCSS_DSH_TMP 指到别的盘（别落 C 盘）。
const tmpRoot = process.env.AGENTCSS_DSH_TMP || os.tmpdir()
fs.mkdirSync(tmpRoot, { recursive: true })
const workdir = fs.mkdtempSync(path.join(tmpRoot, 'agentcss-dsh-'))
// 计划跑几组。改测试就改这里 —— 少跑一组必须当场失败，不能"全部通过"。
const PLAN = 9
let passed = 0

try {
  const catalog = await tools.get('agentcss_catalog').execute({ tier: 'asset' })
  assert.ok(catalog.matched > 0, 'asset 层至少有一个组件')
  assert.ok(catalog.components.length > 0)
  for (const c of catalog.components) {
    assert.ok(c.id && c.css, `组件 ${c.id} 缺 css 路径`)
  }
  const catalogText = tools.get('agentcss_catalog').output.render({}, catalog)[0]
  assert.equal(catalogText.type, 'text')
  assert.match(catalogText.text, /agentcss/)
  passed += 1

  const pageDir = path.join(workdir, 'pages')
  const created = await tools.get('agentcss_new_page').execute({ dir: pageDir })
  assert.ok(fs.existsSync(created.html), 'index.html 没生成')
  assert.ok(fs.existsSync(path.join(pageDir, 'agentcss', '01-tokens', 'tokens.css')), '样式表没复制过去')
  assert.ok(created.cssFiles > 10, `只复制了 ${created.cssFiles} 个文件，明显不对`)
  const html = fs.readFileSync(created.html, 'utf8')
  assert.match(html, /href="agentcss\/01-tokens\/tokens\.css"/, '骨架里的样式表路径不是相对路径')
  passed += 1

  const clean = await tools.get('agentcss_check').execute({ path: created.html, recipe: created.recipe })
  assert.equal(clean.ok, true, `新壳应当直接通过，实际有 ${clean.errors} 个 error：${JSON.stringify(clean.findings)}`)
  assert.equal(clean.errors, 0)
  assert.ok(clean.css.localSheets > 0, '没读到本地样式表')
  passed += 1

  const brokenPath = path.join(pageDir, 'broken.html')
  fs.writeFileSync(
    brokenPath,
    html.replace('<article class="rep', '<div class="definitely-not-a-class">x</div><img src="a.png"><article class="rep'),
    'utf8',
  )
  const broken = await tools.get('agentcss_check').execute({ path: brokenPath, recipe: created.recipe })
  assert.equal(broken.ok, false, '坏页面必须判不通过')
  assert.ok(broken.errors >= 1, '至少一条 error（img 缺 alt）')
  const rules = broken.findings.map((f) => f.rule)
  assert.ok(rules.includes('img-alt'), `findings 里没有 img-alt：${rules.join(',')}`)
  assert.ok(rules.includes('class-unknown'), `findings 里没有 class-unknown：${rules.join(',')}`)
  passed += 1

  await assert.rejects(
    () => tools.get('agentcss_new_page').execute({ dir: pageDir }),
    /已存在/,
    '重复建页必须被拒绝（壳不覆盖正在被改的文件）',
  )
  passed += 1

  const again = await tools.get('agentcss_new_page').execute({ dir: pageDir, overwrite: true })
  assert.equal(again.ok, true, 'explicit overwrite=true 应当重建成功')
  assert.ok(fs.existsSync(again.html))
  passed += 1

  await assert.rejects(
    () => tools.get('agentcss_check').execute({ path: 'relative.html' }),
    /绝对路径/,
    '相对路径必须被拒绝并说明原因',
  )
  passed += 1

  const pdfOut = path.join(workdir, 'report.pdf')
  const pdf = await tools.get('agentcss_pdf').execute({ path: created.html, out: pdfOut })
  assert.equal(pdf.ok, true, 'PDF 导出应当成功')
  assert.ok(fs.existsSync(pdfOut), 'PDF 没落到磁盘上')
  assert.ok(pdf.bytes > 1000, `PDF 只有 ${pdf.bytes} 字节，明显不对`)
  assert.ok(pdf.pages >= 1, '至少要有一页')
  assert.match(pdf.paperSize, /^[0-9]+×[0-9]+pt$/, `纸幅读不出来：${pdf.paperSize}`)
  const pdfText = tools.get('agentcss_pdf').output.render({}, pdf)[0]
  assert.equal(pdfText.type, 'text')
  assert.match(pdfText.text, /已导出/)
  passed += 1

  // 超页数预算：必须**判失败**，不能悄悄截断（产物保留是库的既定行为）
  const longPath = path.join(pageDir, 'long.html')
  const filler = Array.from({ length: 120 }, (_, i) => `<p>第 ${i + 1} 段：用于把内容撑到多页。</p>`).join('')
  fs.writeFileSync(longPath, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<title>long</title><style>@page{size:A4;margin:15mm}body{font:16px/1.6 serif}</style></head>`
    + `<body>${filler}</body></html>`, 'utf8')
  await assert.rejects(
    () => tools.get('agentcss_pdf').execute({ path: longPath, out: path.join(workdir, 'long.pdf'), maxPages: 1 }),
    /页数预算/,
    '超预算必须判失败并说清原因（不替使用者截断）',
  )
  passed += 1
} finally {
  fs.rmSync(workdir, { recursive: true, force: true })
}

assert.equal(passed, PLAN, '实际跑过的组数与计划不一致 —— 有断言被跳过')
console.log(`through: ${passed}/${PLAN} 组断言全部通过`)
console.log(`tools: ${registered.map((d) => d.name).join(', ')}`)
