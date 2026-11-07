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
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply, inject, name, assertSafePath, assertSafeRemoteUrl,
} from '../index.js'

const require = createRequire(import.meta.url)
const sha256 = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const libVersion = JSON.parse(
  fs.readFileSync(require.resolve('agentcss/package.json'), 'utf8'),
).version
const atLeast = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return true
}

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
// 10~14 是「失败也安全」的反例；15~17 是路径 / 远程 URL 边界，不许再删回去。
const PLAN = 17
let passed = 0
/* 跨仓承诺（README L57 / agentcss_pdf 的 description）由**库**的行为兑现。
   库修复在 0.27.7 才会发上 npm；在此之前这条只能标"未判定"，
   既不能假绿，也不能让 CI 因为装到旧库而变红。发版后把下限提上来，
   下面的门控会自动变成硬断言，届时可删掉 unverified 这套分支。 */
const unverified = []

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

  // ⑩ overwrite:true + scaffold 失败 ⇒ 旧 index.html 逐字节保留、临时目录清空
  const guardDir = path.join(workdir, 'guard')
  fs.mkdirSync(guardDir, { recursive: true })
  const guardHtml = path.join(guardDir, 'index.html')
  fs.writeFileSync(guardHtml, 'OLD-INDEX-SENTINEL', 'utf8')
  await assert.rejects(
    () => tools.get('agentcss_new_page').execute({
      dir: guardDir, overwrite: true, recipe: 'no/such/recipe',
    }),
    /scaffold 失败/,
    '未知版式必须判失败',
  )
  assert.equal(
    fs.readFileSync(guardHtml, 'utf8'), 'OLD-INDEX-SENTINEL',
    'scaffold 失败后旧 index.html 必须逐字节不变（旧实现先删后生成，会直接丢）',
  )
  assert.deepEqual(
    fs.readdirSync(guardDir).filter(n => n.startsWith('.agentcss-build-')), [],
    '失败后不能留下临时构建目录',
  )
  passed += 1

  // ⑪ 全新目录里预置的用户 CSS，建页时不得被删（旧实现无条件递归删目标目录）
  const userDir = path.join(workdir, 'user-css')
  const userTokens = path.join(userDir, 'agentcss', '01-tokens')
  fs.mkdirSync(userTokens, { recursive: true })
  const userFile = path.join(userTokens, 'my-custom.css')
  fs.writeFileSync(userFile, 'USER-FILE-DO-NOT-DELETE', 'utf8')
  const withUser = await tools.get('agentcss_new_page').execute({ dir: userDir })
  assert.equal(withUser.ok, true, '目录里已有 agentcss/ 时也要能建页')
  assert.equal(
    fs.readFileSync(userFile, 'utf8'), 'USER-FILE-DO-NOT-DELETE',
    '建页不得删除用户放在 agentcss/ 里的文件，且不受 overwrite 影响',
  )
  passed += 1

  // ⑫ 成功路径也要干净：临时构建目录与旧 HTML 备份都不许残留
  const leftovers = fs.readdirSync(pageDir).filter(
    n => n.startsWith('.agentcss-build-') || n.startsWith('.agentcss-prev-'),
  )
  assert.deepEqual(leftovers, [], `成功建页后不应留下临时文件：${leftovers.join(', ')}`)
  passed += 1

  // ⑬ 提交阶段失败（把 agentcss 做成文件，让样式提交抛错）⇒ 旧 index.html 还原
  const rollbackDir = path.join(workdir, 'rollback')
  fs.mkdirSync(rollbackDir, { recursive: true })
  const rollbackHtml = path.join(rollbackDir, 'index.html')
  fs.writeFileSync(rollbackHtml, 'OLD-INDEX-ROLLBACK-SENTINEL', 'utf8')
  fs.writeFileSync(path.join(rollbackDir, 'agentcss'), 'not-a-directory', 'utf8')
  await assert.rejects(
    () => tools.get('agentcss_new_page').execute({ dir: rollbackDir, overwrite: true }),
    /agentcss|EEXIST/i,
    '样式目标不是目录时必须判失败',
  )
  assert.equal(
    fs.readFileSync(rollbackHtml, 'utf8'), 'OLD-INDEX-ROLLBACK-SENTINEL',
    '提交中途失败时旧 index.html 必须被还原（这是事务性写入的核心）',
  )
  passed += 1

  // ⑭ 原本没有 index.html 的目录提交失败 ⇒ 不许凭空留一份半成品
  const freshDir = path.join(workdir, 'fresh-fail')
  fs.mkdirSync(freshDir, { recursive: true })
  fs.writeFileSync(path.join(freshDir, 'agentcss'), 'not-a-directory', 'utf8')
  await assert.rejects(
    () => tools.get('agentcss_new_page').execute({ dir: freshDir }),
    /agentcss|EEXIST/i,
  )
  assert.equal(
    fs.existsSync(path.join(freshDir, 'index.html')), false,
    '原本没有 index.html，失败后也不该留下一个半成品',
  )
  passed += 1

  // 跨仓承诺：插件说「超预算不改写旧 PDF」，兑现方是 agentcss 的 pdf 导出器。
  // 不计入 PLAN —— 未判定不算通过。
  if (atLeast(libVersion, '0.27.7')) {
    const crossOut = path.join(workdir, 'cross.pdf')
    fs.writeFileSync(crossOut, 'OLD-PDF-CROSS-SENTINEL', 'utf8')
    const beforeCross = sha256(crossOut)
    await assert.rejects(
      () => tools.get('agentcss_pdf').execute({ path: longPath, out: crossOut, maxPages: 1 }),
      /页数预算/,
    )
    assert.equal(
      sha256(crossOut), beforeCross,
      '超预算失败时旧 PDF 必须逐字节不变（插件对外的原话）',
    )
    console.log(`cross-repo promise: verified against agentcss ${libVersion}`)
  } else {
    unverified.push(
      `插件承诺「超预算不改写旧 PDF」需 agentcss >= 0.27.7；当前 ${libVersion} 未含该修复`,
    )
  }

  // ⑮ 路径边界：系统目录 / 盘符根 / 符号链接越界都拒绝，正常子目录仍放行
  const sysDir = process.env.WINDIR || (process.platform === 'win32' ? 'C:\\Windows' : '/etc')
  const fsRoot = path.parse(process.cwd()).root
  assert.throws(() => assertSafePath(sysDir, 'dir'), /不允许写入|盘符根/,
    '系统目录必须拒绝写入')
  assert.throws(() => assertSafePath(fsRoot, 'dir'), /盘符根/,
    '盘符根必须拒绝')
  assert.equal(typeof assertSafePath(workdir, 'dir'), 'string',
    '工作区子目录不能被一刀切拒掉')
  await assert.rejects(
    () => tools.get('agentcss_new_page').execute({ dir: sysDir }),
    /不允许写入/,
    'new_page 必须真的接上路径边界',
  )
  const linkPath = path.join(workdir, 'link-to-system')
  let linkMade = false
  try {
    fs.symlinkSync(sysDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    linkMade = true
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) {
      unverified.push('符号链接越界反例：本机无权创建目录链接')
    } else {
      throw e
    }
  }
  if (linkMade) {
    assert.throws(() => assertSafePath(linkPath, 'dir'), /不允许写入|盘符根/,
      '符号链接指向系统目录必须被拒')
  }
  passed += 1

  // ⑯ 远程 URL 静态边界：表驱动，含等价 IP 写法；公开地址不能误拒
  const blocked = [
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0/',
    'http://localhost/', 'http://LOCALHOST./', 'http://10.1.2.3/',
    'http://172.16.0.1/', 'http://192.168.1.8/', 'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'ftp://example.com/',
    'http://user:pass@example.com/',
  ]
  for (const u of blocked) {
    assert.throws(
      () => assertSafeRemoteUrl(u),
      /环回|私网|链路本地|只支持|用户名|合法 URL/,
      `必须拒绝：${u}`,
    )
  }
  for (const u of ['https://example.com/report', 'http://owain323.github.io/agentcss/']) {
    assert.equal(typeof assertSafeRemoteUrl(u), 'string', `不应误拒：${u}`)
  }
  passed += 1

  // ⑰ 工具层接线：不能只有纯函数绿，execute 也要拦住
  await assert.rejects(
    () => tools.get('agentcss_pdf').execute({
      path: 'http://127.0.0.1/', out: path.join(workdir, 'blocked.pdf'),
    }),
    /环回|私网|链路本地/,
    'agentcss_pdf 必须真的接上 URL 边界',
  )
  passed += 1
} finally {
  fs.rmSync(workdir, { recursive: true, force: true })
}

/* 门控自己也要有牙：不能写一个"永远为 false"的版本比较，
   等库发了修复版还继续标未判定 —— 那就是 E366 那类空转。 */
assert.equal(atLeast('0.27.7', '0.27.7'), true, '修复版必须让门控转真')
assert.equal(atLeast('0.27.6', '0.27.7'), false, '当前版本必须保持未判定')
assert.equal(atLeast('0.28.0', '0.27.7'), true, '后续 minor 不能被误判成旧版')

assert.equal(passed, PLAN, '实际跑过的组数与计划不一致 —— 有断言被跳过')
console.log(`through: ${passed}/${PLAN} 组断言全部通过`)
if (unverified.length > 0) {
  for (const line of unverified) {
    console.log(`  [UNVERIFIED] ${line} —— 未判定，不计通过也不计失败`)
  }
}
console.log(`tools: ${registered.map((d) => d.name).join(', ')}`)
