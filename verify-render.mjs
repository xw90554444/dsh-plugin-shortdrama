/**
 * Do the five output controls render on a project that has nothing in it yet?
 *
 * This is the regression that has now been reported three times: a new project opened a 剧本 tab
 * with no 画面风格 / 分辨率 / 画面比例 / 成片时长 / 单次出片时长. Two separate causes were found:
 *
 *   1. `if (!project) return null` hid the whole row until the project document arrived, and
 *      "new project then immediately look at it" is exactly when it has not arrived yet.
 *   2. `catalogues` was read from the enclosing component's scope rather than taken as a prop, so
 *      the row threw `ReferenceError: catalogues is not defined` even when a project WAS loaded —
 *      optional chaining does not guard an undeclared identifier.
 *
 * Both were invisible to a syntax check, so this renders the component for real and asserts on the
 * markup. Run: node verify-render.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, 'lib', 'client.js')

// Imported up front, not where they are first used: the capacity check compares the panel's copy of
// the arithmetic against the host's, and a `const` declared further down would throw a temporal-dead
// -zone error when that check runs.
const compile = await import(pathToFileURL(join(HERE, 'lib', 'pipeline', 'compile.js')).href)
const prompts = await import(pathToFileURL(join(HERE, 'lib', 'prompts.js')).href)
// For `PRESETS`: a module constant, so importing it does not start anything.
const api = await import(pathToFileURL(join(HERE, 'lib', 'api.js')).href)
// Read once, here, for the same reason: several checks below slice the source, and a `const`
// declared next to the first of them threw a temporal-dead-zone error when an earlier check used it.
const source = readFileSync(CLIENT, 'utf8')

const React = (await import('react')).default
const { renderToString } = await import('react-dom/server')
const ReactDOM = await import('react-dom')

// ---------------------------------------------------------------- fake browser

const styleTags = []
globalThis.document = {
  getElementById: (id) => styleTags.find((t) => t.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { append(el) { styleTags.push(el) } },
  body: { nodeType: 1, appendChild() {}, removeChild() {}, insertBefore() {} },
}
globalThis.window = { __ModuleLoader__: { load: (spec) => { globalThis.__SPEC__ = spec } } }
globalThis.__SHORTDRAMA__ = { token: 't', prefix: '/p' }

await import(pathToFileURL(CLIENT).href)
const spec = globalThis.__SPEC__
let failures = 0
const check = (label, ok, extra = '') => {
  if (ok) console.log(`✓ ${label}${extra ? `  ${extra}` : ''}`)
  else { failures += 1; console.log(`✗ ${label}${extra ? `  ${extra}` : ''}`) }
}

check('客户端注册了 combo id', spec?.id === 'dsh-plugin-shortdrama', spec?.id)

// `react-dom` is required by the module itself, so it must be resolvable here.
const mod = spec.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error(`unexpected require(${name})`)
})
check('factory 返回可用模块', Boolean(mod?.apply), Object.keys(mod ?? {}).join(', '))

const ScriptTab = mod.__test__?.ScriptTab
if (!ScriptTab) {
  console.log('\n✗ __test__ 里没有 ScriptTab —— 无法渲染验证')
  process.exit(1)
}

// ---------------------------------------------------------------- the fixtures
//
// `catalogues` is what `api/status` returns: the option lists that must be available BEFORE a
// project has any shots. Its absence is what caused cause (2), so the fixture is the real shape.
const catalogues = {
  resolutionTiers: [
    { key: '480p', label: '480P', megapixels: 0.4 },
    { key: '720p', label: '720P', megapixels: 0.9 },
    { key: '1080p', label: '1080P', megapixels: 2 },
    { key: '2k', label: '2K', megapixels: 3.7 },
  ],
  ratios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', '9:21', '3:2', '2:3'],
  stylePresets: [
    { key: 'cinematic', label: '电影感', fragment: 'cinematic realism, natural lighting' },
    { key: 'ink', label: '水墨', fragment: 'classical Chinese aesthetic, ink-wash tonality' },
  ],
}

const LABELS = ['画面风格', '分辨率', '画面比例', '成片时长', '单次出片时长']

const render = (props) => renderToString(React.createElement(ScriptTab, {
  reload() {}, startRun() {}, busy: false, onFullPipeline() {}, compiled: null,
  catalogues, onRemember() {},
  ...props,
}))

// ---------------------------------------------------------------- 1. no project at all

console.log('\n=== project 为 null（文档还没到）===')
let html = ''
try {
  html = render({ project: null })
  check('渲染不抛错', true, `${html.length} 字符`)
} catch (error) {
  failures += 1
  console.log(`✗ 渲染抛错: ${error.message}`)
  // The message alone says what was read; the stack says by WHOM, which is the part needed to fix
  // it. `renderToString` wraps the throw, so the original site is the first client.js frame.
  const frames = (error.stack ?? '').split('\n').filter((l) => l.includes('client.js')).slice(0, 3)
  for (const frame of frames) console.log(`    ${frame.trim()}`)
}

for (const label of LABELS) {
  check(`出现「${label}」`, html.includes(label))
}

check('分辨率下拉列出了 4 档', (html.match(/1080P|2K|720P|480P/g) ?? []).length >= 4)
check('比例下拉列出了 9:16 与 21:9', html.includes('9:16') && html.includes('21:9'))
check('风格下拉列出了预设', html.includes('电影感') || html.includes('水墨'))

// ---------------------------------------------------------------- 2. a fresh, empty project

console.log('\n=== 新建的空项目（有文档、无镜头）===')
const fresh = {
  id: 'project-fresh', title: '未命名短剧', logline: '', genre: '',
  ratio: '9:16', imageMegapixels: 2, style: 'cinematic realism, natural lighting',
  targetTotalSec: 60, clipSeconds: 0, script: null,
  characters: [], scenes: [], shots: [], assets: {},
}
try {
  html = render({ project: fresh })
  check('渲染不抛错', true, `${html.length} 字符`)
} catch (error) {
  failures += 1
  console.log(`✗ 渲染抛错: ${error.message}`)
}
for (const label of LABELS) check(`出现「${label}」`, html.includes(label))
check('风格选中该项目的风格', /value="cinematic"[^>]*selected/.test(html))
check('分辨率选中 1080P', /value="1080p"[^>]*selected/.test(html))
check('比例选中 9:16', /value="9:16"[^>]*selected/.test(html))
check('成片时长选中 60s', /value="60"[^>]*selected/.test(html))

// ---------------------------------------------------------------- 1b. capacity + continuation
//
// Two things the operator now needs to see: whether the script has enough material for the length
// that was asked for, and a way to write more without discarding what exists.
console.log('\n=== 剧本容量读数与「继续写」（project 无剧本时先看没有读数）===')
{
  const noneHtml = render({ project: null })
  check('没有剧本时不显示容量读数', !noneHtml.includes('剧本的量'))

  // A script too thin for its target: 3 scenes, no dialogue, against 300s.
  const thinScript = {
    synopsis: 'x', beats: [{ id: 'b1', summary: 'a', emotion: '' }],
    scenes: [
      { id: 's1', beatId: 'b1', slug: 'a', dialogue: [] },
      { id: 's2', beatId: 'b1', slug: 'b', dialogue: [] },
      { id: 's3', beatId: 'b1', slug: 'c', dialogue: [] },
    ],
  }
  const thinProject = {
    ...fresh, targetTotalSec: 300, script: thinScript,
  }
  let thinHtml = ''
  try {
    thinHtml = render({ project: thinProject })
    check('剧本量偏少时渲染不抛错', true, `${thinHtml.length} 字符`)
  } catch (error) {
    failures += 1
    console.log(`✗ 渲染抛错: ${error.message}`)
  }
  check('提示剧本的量偏少', thinHtml.includes('剧本的量偏少'))
  check('给出了覆盖率百分比', /\d+%/.test(thinHtml))
  check('有「继续写」按钮', thinHtml.includes('继续写'))
  check('按钮从「生成剧本」变成「重新生成剧本」', thinHtml.includes('重新生成剧本'))

  // A script with room to spare must NOT be warned about.
  const richScript = {
    synopsis: 'x', beats: [{ id: 'b1', summary: 'a', emotion: '' }],
    scenes: Array.from({ length: 8 }, (_, i) => ({
      id: `s${i + 1}`, beatId: 'b1', slug: `场 ${i + 1}`,
      dialogue: [{ who: '甲', line: '这一句台词用来撑起一场戏的时间，够长了。' }],
    })),
  }
  const richHtml = render({ project: { ...fresh, targetTotalSec: 60, script: richScript } })
  check('剧本量够用时不报警', !richHtml.includes('剧本的量偏少') && richHtml.includes('剧本的量够用'))

  const noneScriptHtml = render({ project: { ...fresh, script: null } })
  check('没有剧本时不显示「继续写」', !noneScriptHtml.includes('继续写'))
  check('没有剧本时按钮是「生成剧本」', noneScriptHtml.includes('生成剧本'))

  // The client's mirror of the capacity arithmetic must agree with the host module. This is a
  // duplicated calculation, which is exactly the kind that drifts.
  const { estimateScriptCapacity } = compile
  const mine = mod.__test__?.scriptCapacity
  check('__test__ 暴露了 scriptCapacity', typeof mine === 'function')
  if (typeof mine === 'function' && typeof estimateScriptCapacity === 'function') {
    const cases = [
      [thinScript, 300],
      [richScript, 60],
      [{ scenes: [], beats: [] }, 60],
      [{ scenes: [{ dialogue: [{ line: '一二三四五六七八' }] }, { dialogue: [] }], beats: [{ id: 'b1' }] }, 120],
    ]
    let drift = 0
    for (const [script, target] of cases) {
      const host = estimateScriptCapacity(script, target)
      const client = mine(script, target)
      for (const key of ['scenes', 'beats', 'dialogueLines', 'shotsNeeded', 'shotsAvailable', 'coverage']) {
        if (host[key] !== client[key]) {
          drift += 1
          console.log(`     ${key} 不一致: 宿主 ${host[key]} vs 面板 ${client[key]}`)
        }
      }
    }
    check('面板的容量算法与宿主一致', drift === 0, `比较了 ${cases.length} 组`)
  } else {
    check('宿主导出了 estimateScriptCapacity', typeof estimateScriptCapacity === 'function')
  }
}

// ---------------------------------------------------------------- 3. a project with a style outside the presets

console.log('\n=== 自定义风格的项目 ===')
const custom = { ...fresh, style: '一条不属于任何预设的风格描述', targetTotalSec: 300, imageMegapixels: 3.7 }
try {
  html = render({ project: custom })
  check('渲染不抛错', true)
} catch (error) {
  failures += 1
  console.log(`✗ 渲染抛错: ${error.message}`)
}
check('风格下拉回落到「（未指定）」', html.includes('（未指定）'))
check('成片时长选中 300s', /value="300"[^>]*selected/.test(html))
check('分辨率选中 2K', /value="2k"[^>]*selected/.test(html))
check('界面上仍显示这条自定义风格', html.includes('一条不属于任何预设的风格描述'))

// ---------------------------------------------------------------- 4. catalogues missing

console.log('\n=== catalogues 还没加载出来 ===')
try {
  html = render({ project: fresh, catalogues: null })
  check('渲染不抛错（只是选项少）', true, `${html.length} 字符`)
  for (const label of LABELS) check(`仍出现「${label}」`, html.includes(label))
} catch (error) {
  failures += 1
  console.log(`✗ 渲染抛错: ${error.message}`)
}

// ---------------------------------------------------------------- the grip panels
//
// 成片 and the 片段 table are sized by dragging a bar, and the height is stored in config. Two
// things are worth asserting rather than assuming: the grip renders at all, and the height the
// panel is given is the height it uses — a grip that renders but ignores its `height` prop would
// look right and do nothing.
console.log('\n=== 可拖动面板（成片 / 片段表）===')
const GripPanel = mod.__test__?.GripPanel
if (!GripPanel) {
  failures += 1
  console.log('✗ __test__ 里没有 GripPanel')
} else {
  const gripHtml = renderToString(React.createElement(GripPanel, {
    height: 420, min: 140, max: 900, defaultHeight: 360,
    label: '成片', footerLeft: '3 条成片', onResizeEnd() {},
  }, React.createElement('span', null, '内容')))

  check('渲染出拖动条', gripHtml.includes('sd-grip'))
  check('拖动条可聚焦（键盘也能调）', /tabindex="0"/.test(gripHtml))
  check('用了 aria 的 separator 语义', /role="separator"/.test(gripHtml))
  check('报告了当前高度', /aria-valuenow="420"/.test(gripHtml))
  check('报告了上下界', /aria-valuemin="140"/.test(gripHtml) && /aria-valuemax="900"/.test(gripHtml))
  check('正文区高度 = 传入的 height', /height:\s*420px/.test(gripHtml), (gripHtml.match(/height:\s*\d+px/) ?? [])[0] ?? '(没找到)')
  check('有恢复默认高度的按钮', gripHtml.includes('默认高度'))
  check('内容被渲染', gripHtml.includes('内容'))

  // A different height must actually change the rendered box, or the prop is decorative.
  const otherHtml = renderToString(React.createElement(GripPanel, {
    height: 222, min: 140, max: 900, label: '成片', onResizeEnd() {},
  }, React.createElement('span', null, 'x')))
  check('高度是活的（222 与 420 渲染不同）', /height:\s*222px/.test(otherHtml) && !otherHtml.includes('height: 420px'))
  // `defaultHeight: 0` means "no magic number to return to", so the reset button is omitted.
  check('没有默认高度时不显示复位按钮', !otherHtml.includes('默认高度'))
}

// ---------------------------------------------------------------- action-shot warning
//
// 武打/跳舞 looks fake because turbo sampling at 8 steps smears fast motion — a SETTING, not the
// material. Nothing used to record which clips contained fast motion, so nothing could warn before
// the minutes were spent. This checks the warning appears, and stays away when it should.
console.log('\n=== 动作戏的采样警告 ===')
{
  const RenderTab = mod.__test__?.RenderTab
  check('__test__ 暴露了 RenderTab', typeof RenderTab === 'function')

  const clip = (index, fastMotion, motionReasons = []) => ({
    index, shotIds: [`sh${index + 1}`], frames: 243, seconds: 10.125, targetSeconds: 10,
    prompt: 'p', apiRequest: null, warnings: [], fastMotion, motionReasons,
    resolution: { width: 768, height: 1344 }, rendered: false, videoAssetId: null,
  })
  const shot = (id) => ({ id, no: 1, sceneId: null, durationSec: 4, shotSize: '中景', camera: '平视', movement: '固定', action: 'a', dialogue: [], sfx: '', notes: '', characters: [] })
  const renderTab = (props) => renderToString(React.createElement(RenderTab, {
    project: { ...fresh, shots: [shot('sh1'), shot('sh2')] },
    runs: [], busy: false, ui: null,
    onRender() {}, onCancel() {}, onMerge() {}, onOpenFolder() {}, onPreview() {}, onUi() {},
    ...props,
  }))

  /** A status payload shaped like the host's, so the selector reads the same table the host serves. */
  const withPresets = (current, extra = {}) => ({
    catalogues: {
      presets: {
        draft: { label: '草稿', imageSteps: 8, h3Steps: 4, turbo: true },
        standard: { label: '标准', imageSteps: 25, h3Steps: 8, turbo: true },
        quality: { label: '精细', imageSteps: 40, h3Steps: 20, turbo: false },
      },
    },
    presetKey: current,
    ...extra,
  })
  const turboPreset = 'standard'
  const fullPreset = 'quality'

  let html = ''
  try {
    html = renderTab({
      ...withPresets(turboPreset),
      compiled: { clips: [clip(0, true, ['出拳']), clip(1, false)] },
      onPreset() {},
    })
    check('含快速动作且用 turbo 时渲染通过', true, `${html.length} 字符`)
  } catch (error) {
    failures += 1
    console.log(`✗ 渲染抛错: ${error.message}`)
  }
  check('警告出现了', html.includes('含快速动作'))
  check('说明了当前预设与步数', html.includes('标准') && html.includes('8 步'))
  check('点出了具体动作类型', html.includes('出拳'))
  check('给了就地切换的按钮', html.includes('改用精细预设出片'))
  check('说明了代价', html.includes('只是慢一些'))

  const calm = renderTab({
    ...withPresets(turboPreset),
    compiled: { clips: [clip(0, false), clip(1, false)] },
    onPreset() {},
  })
  check('没有快速动作时不报警', !calm.includes('含快速动作'))
  check('没有快速动作时仍说明当前步数', calm.includes('没有检测到快速动作'))

  const already = renderTab({
    ...withPresets(fullPreset),
    compiled: { clips: [clip(0, true, ['出拳'])] },
    onPreset() {},
  })
  check('已在精细预设时不再警告', !already.includes('含快速动作'))
  // The preset in force must be READ, not assumed. An earlier version kept a stale `preset` prop
  // alongside the new `presetKey`, so the local `const preset` shadowed it and the panel always
  // behaved as though 标准 were selected — even after the operator switched to 精细.
  check('已切到精细时警告文本不再说「标准」', !already.includes('而当前预设「标准」'))
  // The note under the dropdown must describe the SELECTED preset, not a fixed sentence.
  check('已切到精细时说明它不启用加速 LoRA',
    already.includes('不启用加速 LoRA') || already.includes('不启用加速'))
  check('标准预设下说明它带加速 LoRA', html.includes('加速 LoRA'))
  check('精细那一行标出了当前选中', already.includes('▶ 精细'))
  check('每个预设都有用途说明',
    /用来试构图/.test(already) && /日常够用/.test(already) && /动作最稳/.test(already))
  check('列出了各档的耗时估算', /\d+(\.\d+)? (秒|分钟)/.test(already))
  check('有自动选质量的开关', already.includes('按镜头自动选质量'))
  // Width and layout. `.sd-select` is `width: 100%`, which stretched the dropdown across the whole
  // panel and pushed the render buttons down; the notes then sat under it as a second full-width
  // block. Both are layout decisions worth pinning, because a refactor would quietly undo them.
  check('下拉框按内容自适应宽度（覆盖 .sd-select 的 100%）',
    /className: 'sd-select', style: \{ width: 'auto'/.test(source))
  const pickerSrc = source.slice(source.indexOf('function RenderPresetPicker('), source.indexOf('function RunCard('))
  check('说明文字在右侧（横向排列）', /display: 'flex'/.test(pickerSrc) && /flexWrap: 'wrap'/.test(pickerSrc))
  check('控件列不参与伸展（flex: 0 0 auto）', /flex: '0 0 auto'/.test(pickerSrc))
  check('说明列占用剩余宽度', /flex: '1 1 240px'/.test(pickerSrc))
  check('说明不再堆在下拉框下面', !/margin: '6px 0 0'/.test(pickerSrc))
  console.log(`  （.sd-select 基础样式是 width:100%，见 client.js 第 89 行）`)

  // Rendered order, not just the source pattern: the label and select must come first, the notes
  // after them, inside one flex row. A regex can pass on markup that the browser lays out wrong.
  const labelAt = already.indexOf('出片质量')
  const notesAt = already.indexOf('最快，用来试构图')
  const checkAt = already.indexOf('按镜头自动选质量')
  check('渲染顺序：控件在前、说明在后', labelAt >= 0 && notesAt > labelAt)
  check('自动开关在左列、在说明之前', checkAt < notesAt, `开关 ${checkAt} < 说明 ${notesAt}`)
  const rowStyle = /display:flex[^"]*gap:16px[^"]*align-items:flex-start[^"]*flex-wrap:wrap/.exec(already.replace(/\s+/g, ''))
  check('控件与说明在同一行（渲染出的样式确认）', Boolean(rowStyle), rowStyle ? rowStyle[0] : '未找到 flex 行样式')

  const empty = renderTab({ ...withPresets(turboPreset), compiled: null, onPreset() {} })
  check('还没编译时不报警', !empty.includes('含快速动作') && !empty.includes('没有检测到'))

  // The selector must be present in EVERY one of those states — that is the whole point of moving
  // it out of the warning card, which only appeared on a turbo preset with detected action.
  check('预设选择器始终可见（含精细预设时）', already.includes('出片质量') && already.includes('精细'))
  check('预设选择器在没有快速动作时也在', calm.includes('出片质量'))
  check('预设选择器在还没编译时也在', empty.includes('出片质量'))
  check('选项列出了全部三个预设',
    already.includes('草稿') && already.includes('标准') && already.includes('精细'))
  check('选项标明了步数', /\d+ 步/.test(already))
  // No status payload at all: the built-in table must supply the options, or the selector is an
  // empty dropdown — which reads as broken rather than unloaded.
  check('没有 catalogues 时用内置预设兜底',
    renderTab({ compiled: null, presetKey: null, onPreset() {} }).includes('精细'))

  // ------------------------------------------------------------ render card layout
  //
  // Five things the operator asked for, each easy to undo by a later refactor.
  console.log('\n=== 渲染卡片的布局与点击反馈 ===')
  {
    const renderTabSrc = source.slice(source.indexOf('function RenderTab('), source.indexOf('function PromptStudio('))
    const actionSrc = source.slice(source.indexOf('function RenderAction('), source.indexOf('function RenderPresetPicker('))

    // The panel must not reimplement the detector: one classifier, in the host.
    check('警告依据的是宿主算好的 fastMotion 标记',
      /clip\.fastMotion/.test(renderTabSrc) && /fastClips/.test(renderTabSrc))
    check('面板里没有自己再写一套动作识别',
      !/出拳|一横斩|纵身跃起|拔剑起势/.test(renderTabSrc))

    check('标题「渲染」与按钮在同一行',
      /h\('h3', \{ style: \{ margin: 0[^}]*\} \}, '渲染'\)/.test(renderTabSrc)
      && /alignItems: 'center'/.test(renderTabSrc))
    check('标题不再独占一行（margin 归零）', /'h3', \{ style: \{ margin: 0/.test(renderTabSrc))
    check('四个按钮都渲染在同一行容器里',
      ['出参考图', '出关键帧', '出片（H3）', '打开产出文件夹'].every((l) => renderTabSrc.includes(`label: '${l}'`)))
    check('删掉了底部那段「出片是分钟级任务…」说明',
      !renderTabSrc.includes('出片是分钟级任务') && !source.includes('出片是分钟级任务'))

    // The confirmation: a tick driven by the host ACCEPTING the request, not by the click alone.
    check('按钮有已点确认（tick）', /ticked \? '✓ '/.test(actionSrc))
    check('按钮有运行中状态', /pending \? '⏳ '/.test(actionSrc))
    // The button no longer calls `onPress` itself — it opens the confirmation, and `runAsked` records
  // the press only once the operator has agreed. Asserting the old call shape would now be asserting
  // the absence of the confirmation.
  check('点击先询问，确认后才记录 pending',
    /onRun: \(\) => askRender\('reference'\)/.test(renderTabSrc)
    && /const runAsked = \(\) => \{[\s\S]{0,200}onPress\?\.\(kind\)/.test(renderTabSrc)
    && /data-state/.test(actionSrc))
    check('只有宿主接受后才打勾', /setRenderPress\(\{ pending: null, done: kind \}\)/.test(source))
    check('请求失败时不打勾', /catch \(err\) \{\s*setRenderPress\(\{ pending: null, done: null \}\)/.test(source))
    check('pending / done 状态有对应样式',
      /\.sd-btn\[data-state="pending"\]/.test(source) && /\.sd-btn\[data-state="done"\]/.test(source))
    // Disabled buttons are muted at .5 opacity, which would mute exactly the button being watched.
    check('pending / done 时不被 disabled 的透明度压暗',
      /\.sd-btn\[data-state="pending"\],\.sd-btn\[data-state="done"\]\{opacity:1\}/.test(source))
  }

  console.log('\n=== 出片质量：标签与下拉同一行 ===')
  {
    const pickerSrc = source.slice(source.indexOf('function RenderPresetPicker('), source.indexOf('function RunCard('))
    check('标签与下拉在同一个 flex 行', /display: 'flex', gap: 8, alignItems: 'center'/.test(pickerSrc))
    check('标签不再有下边距（不会把下拉挤到下一行）', /margin: 0, whiteSpace: 'nowrap'/.test(pickerSrc))
    check('标签不换行', /whiteSpace: 'nowrap'/.test(pickerSrc))

    // ---------------------------------------------------------- auto-quality switch
    //
    // It belongs UNDER the dropdown, in the left control column, with its left edge flush against
    // the 「出片质量」 label — so the column reads as one group: which preset, then whether it may be
    // applied per clip. Its explanation stays on the same line as the label.
    console.log('  -- 按镜头自动选质量 --')
    const selectedAt = pickerSrc.indexOf("'出片质量'")
    const autoLabelAt = pickerSrc.indexOf("'按镜头自动选质量'")
    const notesAt = pickerSrc.indexOf("className: 'sd-hint'")

    /**
     * The control column's own style string, not the whole picker.
     *
     * A whole-picker regex is not enough: the OUTER row is also `alignItems: 'flex-start'`, so
     * replacing the column's own alignment with `center` left the assertion green. It was verified by
     * breaking it — `prove-layout-assertions.mjs` regression 3 — which is how the gap was found.
     */
    const columnStyle = /style: \{ flex: '0 0 auto', display: 'flex', (flexDirection: '[^']*', )?alignItems: '([^']*)'[^}]*\}/.exec(pickerSrc)
    check('控件列是纵向排列（开关在下拉框下面）', /flexDirection: 'column'/.test(columnStyle?.[0] ?? ''))
    check('控件列左对齐（左边缘与「出片质量」平齐）',
      columnStyle?.[2] === 'flex-start',
      columnStyle ? `alignItems: ${columnStyle[2]}` : '没找到控件列的样式')
    check('「出片质量」在开关之前（顺序：标签 → 下拉 → 开关）',
      selectedAt > 0 && autoLabelAt > selectedAt)
    check('开关在左侧控件列内，不在右侧说明列内', autoLabelAt > 0 && autoLabelAt < notesAt,
      `开关 ${autoLabelAt} < 说明列 ${notesAt}`)

    // It must NOT be a sibling of the notes: that would put it back in the right-hand column.
    const columnOpen = pickerSrc.indexOf("flexDirection: 'column'")
    check('控件列在说明列之前闭合（两列是兄弟关系）', columnOpen > 0 && notesAt > columnOpen)

    const autoSrc = pickerSrc.slice(
      pickerSrc.indexOf("type: 'checkbox'") - 200,
      pickerSrc.indexOf("'按镜头自动选质量'"),
    )
    check('复选框与说明在同一个 flex 行', /display: 'flex'/.test(autoSrc))
    check('两者对齐而不是首行对齐（baseline）', /alignItems: 'baseline'/.test(autoSrc))
    check('说明不再换行到下一行（没有 display: block 的 span 包着）',
      !/display: 'block'/.test(pickerSrc))
    check('复选框不再有上边距偏移', /margin: 0/.test(autoSrc))
    check('「按镜头自动选质量」加粗以突出', /fontWeight: 600, whiteSpace: 'nowrap'/.test(pickerSrc))

    // The reason text follows the label inside the same row, not in a nested block.
    const reasonAt = pickerSrc.indexOf('动作镜头自动改用精细')
    check('说明紧跟标签（同一行结构内）', autoLabelAt > 0 && reasonAt > autoLabelAt && reasonAt - autoLabelAt < 400,
      `相距 ${reasonAt - autoLabelAt} 字符`)
    // Kept to one clause. The longer version argued why it was safe to leave the machine, which the
    // switch's one-way behaviour makes unnecessary.
    const autoText = pickerSrc.slice(reasonAt, reasonAt + 80)
    check('说明只有「动作镜头自动改用精细」这一句', autoText.startsWith('动作镜头自动改用精细'), autoText)
    check('没有把安全性论证再写回来',
      !/可以放心离开电脑|其余跟着上面的预设走/.test(pickerSrc))
    check('关闭时也有一句短说明', /整片统一用上面的预设/.test(pickerSrc))

    // The estimate summary line was removed: the per-preset times on the right already say it, and
    // two places quoting minutes is one too many.
    check('删掉了「当前：静止镜头约…」那句估算', !pickerSrc.includes('当前：静止镜头约'))
    check('删掉了只有时间估算的那一行', !/动作镜头自动按精细约/.test(pickerSrc))
    // But the per-preset times must remain — that is where the information now lives.
    check('各档的耗时估算仍在', /10 秒片段约/.test(pickerSrc))
    check('右侧说明列只剩各档说明', (pickerSrc.match(/sd-hint'/g) ?? []).length === 1)
  }
}

// The two blocks above were written INSIDE the action-shot test's braces, which left it unclosed —
// the file stopped parsing at EOF. `js-brace-balance.mjs` located it; the naive `{`/`}` count in a
// shell loop did not, because regex literals and template literals in this file contain braces.

// ---------------------------------------------------------------- render confirmation
//
// The three render buttons start jobs measured in minutes to hours, and they used to start on the
// first click — so one mis-click cost that outright. This checks the bar itself: it offers the two
// decisions, carries information rather than just asking "are you sure", and its boxes are wired.
console.log('\n=== 出片前的确认 ===')
{
  const RenderConfirm = mod.__test__?.RenderConfirm
  check('__test__ 暴露了 RenderConfirm', typeof RenderConfirm === 'function')

  let html = ''
  try {
    html = renderToString(React.createElement(RenderConfirm, {
      label: '出片（标准）',
      details: ['将生成 6 段视频，覆盖 27 个镜头。', '全部按「标准」。', '预计耗时约 1.5 小时。'],
      remember: false, onCancel() {}, onConfirm() {}, onRemember() {}, busy: false,
    }))
    check('确认条渲染通过', true, `${html.length} 字符`)
  } catch (error) {
    failures += 1
    console.log(`✗ 渲染抛错: ${error.message}`)
  }
  check('问的是哪一个动作', html.includes('要出片（标准）吗？'))
  check('有「开始」按钮', html.includes('开始'))
  check('有「取消」按钮', html.includes('取消'))
  check('有「下次不再询问」', html.includes('下次不再询问'))
  // Every detail line must survive: a confirmation that drops its detail is just a speed bump.
  check('三条明细都在', html.includes('6 段视频') && html.includes('全部按「标准」') && html.includes('1.5 小时'))

  // The checkbox reflects the prop rather than owning a copy — the setting is persisted by the host,
  // and a local mirror is exactly how such a value drifts from what is stored.
  const makesChecked = (remember) => renderToString(React.createElement(RenderConfirm, {
    label: 'x', details: [], remember, busy: false,
    onCancel() {}, onConfirm() {}, onRemember() {},
  }))
  check('未记住时不勾选', !/type="checkbox"[^>]*checked/.test(makesChecked(false)))
  check('已记住时勾选', /type="checkbox"[^>]*checked/.test(makesChecked(true)))

  // Empty detail lines are filtered, so a conditional line resolving to null leaves no gap.
  const withNulls = makesChecked(false)
  check('没有明细时不报错', typeof withNulls === 'string' && withNulls.includes('下次不再询问'))

  // The wiring: the buttons must ASK, not start.
  const renderTabSrc2 = source.slice(source.indexOf('function RenderTab('), source.indexOf('function PromptStudio('))
  check('三个按钮都是先询问而不是直接开始',
    (renderTabSrc2.match(/onRun: \(\) => askRender\('(reference|keyframe|video)'\)/g) ?? []).length === 3)
  check('没有按钮再直接启动渲染',
    !/onRun: \(\) => \{ onPress\?\.\('(reference|keyframe|video)'\); onRender\(/.test(renderTabSrc2))
  check('确认后才真正启动', /const runAsked = \(\) => \{[\s\S]{0,400}onRender\(kind, \{ projectId: project\.id \}\)/.test(renderTabSrc2))
  check('记住选择时跳过询问', /if \(rememberConfirm === true\) \{ onPress\?\.\(kind\); onRender\(kind/.test(renderTabSrc2))
  check('「打开产出文件夹」不需要确认', /label: '打开产出文件夹'[\s\S]{0,200}onRun: \(\) => onOpenFolder\(\)/.test(renderTabSrc2))
  check('取消不会启动渲染', /onCancel: \(\) => setAsking\(null\)/.test(renderTabSrc2))
  // Every question carries at least one concrete fact, or it is a speed bump, not a checkpoint.
  check('每个确认都给出具体数量',
    /将给 \$\{characters\} 个人物/.test(renderTabSrc2)
    && /将按 \$\{project\.shots\.length\} 个镜头出图/.test(renderTabSrc2)
    && /将生成 \$\{clips\.length\} 段视频/.test(renderTabSrc2))
  check('出片确认会指明没有关键帧的段数', /没有关键帧，那几段会退化成纯文字生成/.test(renderTabSrc2))
  check('切换项目时取消未完成的询问', /setAsking\(null\) \}, \[project\?\.id\]/.test(renderTabSrc2))

  // The preference has to survive a round trip through the config file.
  //
  // `mergeConfig` copies only the keys present in `DEFAULT_CONFIG`, so a key used by the panel but
  // missing from the defaults is silently DROPPED on read: the saved `true` came back as `false` and
  // the checkbox could not stick. Verified against the real normaliser, not by reading the source.
  const config = await import(pathToFileURL(join(HERE, 'lib', 'config.js')).href)
  check('默认是不询问（保留确认）', config.normaliseConfig(null).ui.skipRenderConfirm === false)
  check('勾选「下次不再询问」能存下来',
    config.normaliseConfig({ ui: { skipRenderConfirm: true } }).ui.skipRenderConfirm === true)
  check('取消勾选能存下来',
    config.normaliseConfig({ ui: { skipRenderConfirm: false } }).ui.skipRenderConfirm === false)
  check('乱值不会当成已勾选',
    config.normaliseConfig({ ui: { skipRenderConfirm: 'yes' } }).ui.skipRenderConfirm === false)
  check('它与面板高度的配置互不影响',
    config.normaliseConfig({ ui: { skipRenderConfirm: true, clipPanelHeight: 500 } }).ui.clipPanelHeight === 500)
}

// ---------------------------------------------------------------- keyframe selection default
//
// H3 has exactly two image inputs, so a clip's interior keyframes never reach the model. Defaulting
// the storyboard to "select everything" therefore paid GPU time for frames the video cannot use — 8 of
// 22 shots on 埋名十六年. The frames stay GENERATABLE, because looking at one before committing to a
// render is a real workflow; they are simply not selected for you.
console.log('\n=== 分镜默认勾选锚定镜头 ===')
{
  // This is the bug worth stating plainly: the first version of `anchorIds` called
  // `compile.groupIntoClips`, and the client half cannot reach that module. It would have thrown a
  // ReferenceError the moment the storyboard tab opened — the same class of failure as the
  // `renderPress` blank panel, so it is asserted rather than left to a reader.
  // The path `lib/pipeline/compile.js` appears in comments, so the match must require a real call
  // with a member access — not any occurrence of the word.
  const compileCalls = [...source.matchAll(/(?<![\w.$])compile\.(\w+)\s*\(/g)].map((m) => m[1])
  check('客户端没有调用宿主侧 compile 模块（会 ReferenceError）', compileCalls.length === 0,
    compileCalls.join(', '))
  const clientSrc = source
  check('锚定镜头来自宿主算好的 compiled.clips', /const clips = Array\.isArray\(compiled\?\.clips\)/.test(clientSrc))
  check('默认勾选用 anchorIds 过滤', /shots\.map\(\(s\) => s\.id\)\.filter\(\(id\) => anchorIds\.has\(id\)\)/.test(clientSrc))
  // "Select none" must stay distinguishable from "no decision yet".
  check('空选择仍被当作「有决策」而不是回落到默认',
    !/live\.length > 0 \|\| shots\.length === 0 \? live : shots\.map/.test(clientSrc))
  check('有「选锚定帧」按钮', /选锚定帧（\$\{anchorIds\.size\}）/.test(clientSrc))
  check('「全选」仍然保留（看片子时确实需要）', /onClick: selectAll/.test(clientSrc))
  check('没有编译结果时全选（还没有分段可依据）',
    /if \(!clips\.length\) return new Set\(shots\.map\(\(s\) => s\.id\)\)/.test(clientSrc))

  // The rule itself, replayed on whatever boards exist on this machine. The path is resolved from
  // `DSH_HOME` rather than written out: a hard-coded `C:/Users/<name>/…` is both machine-specific and
  // somebody's actual username, which has no business in a public repository.
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'shortdrama', 'projects')
  if (!existsSync(dir)) {
    console.log('  （本机没有已保存的项目，跳过真实数据检查）')
  } else {
    const boards = readdirSync(dir).filter((x) => x.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))).filter((d) => d.shots?.length)
    console.log('  改成默认只选锚定帧后，每部片子的默认出图量：')
    for (const d of boards) {
      const clips = compile.groupIntoClips(d.shots, compile.clipFrameBand(
        Number(d.clipSeconds) > 0 ? Number(d.clipSeconds) : 10,
      ))
      const anchors = new Set()
      for (const clip of clips) {
        anchors.add(clip.shotIds[0])
        anchors.add(clip.shotIds[clip.shotIds.length - 1])
      }
      console.log(`    ${String(d.title).padEnd(14)}${String(anchors.size).padStart(3)}/${String(d.shots.length).padEnd(3)} 镜`
        + `  省下 ${d.shots.length - anchors.size} 张`)
      if (anchors.size === 0) { failures += 1; console.log('    ✗ 锚定集合为空') }
      if (anchors.size > d.shots.length) { failures += 1; console.log('    ✗ 锚定数超过镜头总数') }
    }
  }
}

// ---------------------------------------------------------------- canvas mirrors
//
// The panel promises two pixel sizes: the finished film's (from 画面比例 alone) and the keyframes'
// (from 分辨率). Both mirror host functions, and a wrong mirror prints a confident wrong number beside
// a real control — the first version of `videoCanvas` said 21:9 renders at 1792x768 when the host
// produces 1344x576, because it scaled the short edge without applying the long-edge cap.
console.log('\n=== 画布尺寸的镜像与宿主是否一致 ===')
{
  const { videoCanvas, imageCanvas } = mod.__test__ ?? {}
  check('__test__ 暴露了两个画布镜像', typeof videoCanvas === 'function' && typeof imageCanvas === 'function')

  const ratioKeys = Object.keys(compile.RATIOS)
  const videoDrift = []
  for (const ratio of ratioKeys) {
    const mine = videoCanvas(ratio)
    const host = compile.resolutionFor(ratio)
    if (mine.width !== host.width || mine.height !== host.height) {
      videoDrift.push(`${ratio}: 面板 ${mine.width}×${mine.height} vs 宿主 ${host.width}×${host.height}`)
    }
  }
  check(`成片尺寸在全部 ${ratioKeys.length} 个比例上一致`, videoDrift.length === 0, videoDrift.slice(0, 3).join(' | '))

  const imageDrift = []
  for (const ratio of ['9:16', '21:9', '16:9', '1:1']) {
    for (const tier of compile.RESOLUTION_TIERS) {
      const mine = imageCanvas(ratio, tier.megapixels)
      const host = compile.resolutionForMegapixels(ratio, tier.megapixels)
      if (mine.width !== host.width || mine.height !== host.height) {
        imageDrift.push(`${ratio}/${tier.label}: 面板 ${mine.width}×${mine.height} vs 宿主 ${host.width}×${host.height}`)
      }
    }
  }
  check('关键帧尺寸在所有比例 × 档位上一致', imageDrift.length === 0, imageDrift.slice(0, 2).join(' | '))

  // The two sizes must genuinely differ, or the distinction this change is about would be fiction.
  const film = videoCanvas('21:9')
  const frames = imageCanvas('21:9', 3.7)
  check('成片与关键帧是两个不同的尺寸（这正是需要区分的理由）',
    film.width !== frames.width || film.height !== frames.height,
    `成片 ${film.width}×${film.height} vs 关键帧 ${frames.width}×${frames.height}`)
  // This pair IS the answer to 「分辨率跟成片有关系吗」, asserted rather than asserted-by-comment.
  const frameWidths = [0.4, 0.9, 2, 3.7].map((mp) => imageCanvas('21:9', mp).width)
  check('关键帧尺寸随分辨率档位变化', new Set(frameWidths).size === 4, frameWidths.join(', '))
  check('成片尺寸不随分辨率档位变化',
    videoCanvas('21:9').width === compile.resolutionFor('21:9').width
    && videoCanvas('9:16').height === compile.resolutionFor('9:16').height)

  // The labels the two controls print must use these helpers, not hand-written numbers.
  check('分辨率下拉用镜像函数列出像素尺寸', /imageCanvasLabel\(view\.ratio, x\.megapixels\)/.test(source))
  // Named for what it actually checks. It was called 「下拉的标签说明了它只影响图片」, which made it
  // look as though it covered the explanatory line — so when that line was removed the assertion
  // stayed green and the name kept implying coverage it never had.
  check('分辨率下拉的标签点明它作用于关键帧与参考图',
    /label: '关键帧与参考图分辨率'/.test(source))
  check('该下拉下没有解释性提示行（按操作者要求删除）',
    !/只影响关键帧和参考图的清晰度/.test(source))
  check('下拉的标签不再叫「分辨率」', !/label: '分辨率'/.test(source))
  check('出片页标出成片尺寸', /成片 \$\{videoCanvasLabel\(project\.ratio\)\}/.test(source))
}

// ---------------------------------------------------------------- per-clip auto quality
//
// One preset for a whole film is the wrong trade both ways: action needs the 20 full steps turbo
// gives up, and nothing else needs to pay for them. The stage now upgrades clips with detected fast
// motion. This checks the wiring, because "compute the decision and then not use it" is exactly the
// failure mode this file has caught before (`expected` in the board prompt, `brief` in the pipeline).
console.log('\n=== 按镜头自动选质量 ===')
{
  const renderSrc = readFileSync(join(HERE, 'lib', 'pipeline', 'render.js'), 'utf8')
  check('视频阶段引入了动作检测', /detectFastMotion/.test(renderSrc))
  check('算出了每个片段的实际预设', /const effectivePreset = autoPreset \?\? ctx\.preset/.test(renderSrc))
  check('REF2VA 图用的是实际预设',
    /buildH3ReferenceGraph\(\{[\s\S]*?turbo: effectivePreset\.turbo[\s\S]*?steps: effectivePreset\.h3Steps/.test(renderSrc))
  check('首尾帧图用的是实际预设',
    /buildH3Graph\(\{[\s\S]*?turbo: effectivePreset\.turbo[\s\S]*?steps: effectivePreset\.h3Steps/.test(renderSrc))
  // No sampling value may still read the run-wide preset, or a clip could silently render on the
  // wrong settings while the log claims otherwise.
  check('两处图都不再用 run 级 preset 采样',
    !/turbo: ctx\.preset\.turbo/.test(renderSrc) && !/steps: ctx\.preset\.h3Steps/.test(renderSrc))
  check('自动选择只会提高质量（要求 run 级是 turbo）',
    /autoQuality && motionReasons\.length > 0 && ctx\.preset\.turbo/.test(renderSrc))
  check('选择结果会报给用户', /自动改用/.test(renderSrc))

  // The decision itself, replayed on whatever boards exist on this machine. Same `DSH_HOME` lookup as
  // above, for the same reason: no machine-specific path in a published file.
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'shortdrama', 'projects')
  const boards = existsSync(dir)
    ? readdirSync(dir).filter((x) => x.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))).filter((d) => d.shots?.length)
    : []
  if (!boards.length) console.log('  （本机没有已保存的项目，跳过真实数据检查）')
  console.log('  按镜头自动选质量时，每部片子的升级情况：')
  for (const d of boards) {
    const clips = compile.groupIntoClips(d.shots, compile.clipFrameBand(
      Number(d.clipSeconds) > 0 ? Number(d.clipSeconds) : 10,
    ))
    const byId = new Map(d.shots.map((s) => [s.id, s]))
    let fastClips = 0
    let fastSec = 0
    let allSec = 0
    for (const clip of clips) {
      const shots = clip.shotIds.map((id) => byId.get(id)).filter(Boolean)
      allSec += clip.seconds
      if (shots.some((s) => compile.detectFastMotion(s).fast)) { fastClips += 1; fastSec += clip.seconds }
    }
    const share = allSec > 0 ? Math.round((fastSec / allSec) * 100) : 0
    console.log(`    ${String(d.title).padEnd(14)}${String(fastClips).padStart(3)}/${String(clips.length).padEnd(3)} 段需精细`
      + `  （占总时长 ${share}%，这部分会变慢，其余保持加速）`)
    if (fastClips > clips.length) { failures += 1; console.log('    ✗ 升级段数超过总段数') }
  }
}

// ---------------------------------------------------------------- source guards

// The picker quotes a render time per preset from a mirrored cost model. A drifting copy would put
// 8-step timings next to a 20-step preset — a wrong number presented confidently, which is worse
// than no number.
console.log('\n=== 耗时估算镜像与宿主是否一致 ===')
{
  const anchors = [...source.matchAll(/\{ frames: (\d+), secondsPerFrame: ([\d.]+) \}/g)]
    .map(([, f, spf]) => ({ frames: Number(f), secondsPerFrame: Number(spf) }))
  check('面板里找到了两个成本锚点', anchors.length === 2, anchors.map((a) => `${a.frames}帧@${a.secondsPerFrame}`).join(' '))

  // Recompute the panel's formula here from its own constants, then compare against the host across
  // a range of lengths — comparing the code text would pass on a formula that merely looks similar.
  const mirror = (frames, preset) => {
    const [[lo], [hi]] = [anchors, anchors.slice(1)]
    const n = Math.max(5, Number(frames) || 0)
    const slope = (hi.secondsPerFrame - lo.secondsPerFrame) / (hi.frames - lo.frames)
    let perFrame = lo.secondsPerFrame
    if (n >= hi.frames) perFrame = hi.secondsPerFrame + slope * (n - hi.frames)
    else if (n > lo.frames) perFrame = lo.secondsPerFrame + slope * (n - lo.frames)
    const base = n * perFrame
    const steps = Number(preset?.h3Steps)
    return Number.isFinite(steps) && steps > 0 ? (base * steps) / 8 : base
  }
  const drifts = []
  for (const frames of [5, 124, 141, 243, 328, 362, 500]) {
    for (const [key, preset] of Object.entries(api.PRESETS)) {
      const mine = mirror(frames, preset)
      const host = compile.estimateClipSecondsFor(frames, preset)
      if (Math.abs(mine - host) > 1e-6) drifts.push(`${frames}帧/${key}: ${mine.toFixed(1)} vs ${host.toFixed(1)}`)
    }
  }
  check('每一档、每一长度都与宿主一致', drifts.length === 0, drifts.slice(0, 3).join(' | '))
  if (drifts.length) failures += 1
  const sample = compile.estimateClipSecondsFor(243, api.PRESETS.quality)
  console.log(`  抽查：243 帧（10s）在精细档 = ${(sample / 60).toFixed(1)} 分钟`)
}

console.log('\n=== 源码层面不应再出现的写法 ===')
const scriptTabSrc = source.slice(
  source.indexOf('function ScriptTab('),
  source.indexOf('function CastTab(') > 0 ? source.indexOf('function CastTab(') : source.length,
)
// Comments are stripped first: the explanatory comment left above `view` QUOTES the old guard, and
// a check that cannot tell prose from code would keep failing on its own documentation.
const scriptTabCode = scriptTabSrc
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')
check('ScriptTab 里没有 if (!project) return null 这类整行隐藏',
  !/if\s*\(\s*!project\s*\)\s*return\s+null/.test(scriptTabCode))
// Only the five CONTROLS are checked, not the whole `save` helper above them: that helper reads
// `project.id` deliberately, after its own `if (!project?.id) return` guard, and widening the slice
// to include it produced a false failure.
const settingsRow = (() => {
  const from = scriptTabCode.indexOf("label: '画面风格'")
  const to = scriptTabCode.indexOf("label: '单次出片时长'")
  return from < 0 || to < 0 ? '' : scriptTabCode.slice(from, to)
})()
check('找到了五个控件的渲染区', settingsRow.length > 0, `${settingsRow.length} 字符`)
check('控件渲染区里没有裸的 project. 读取',
  !/[^?.\w]project\.[a-zA-Z]/.test(settingsRow),
  (settingsRow.match(/[^?.\w]project\.[a-zA-Z]\w*/g) ?? []).join(' ') || '无')
check('catalogues 是 prop，不是外部变量',
  /function ScriptTab\(\{[^}]*catalogues[^}]*\}\)/.test(source))
check('调用处传入了 catalogues', /h\(ScriptTab,\s*\{[^}]*catalogues/.test(source))
// The exact shape that hid the controls: a line that is just `X.length`, with `? box(...)` on the
// next line. Matching a bare trailing `.length` also hits legitimate ternary conditions, which is
// what made this assertion fail against correct code twice.
check('五个控件不再被 `X.length ?` 包住',
  !/^\s*(presets|tiers|ratios)\.length\s*$/m.test(scriptTabCode)
  && !/\?\s*box\(/.test(scriptTabCode))

// The `catalogues` defect was a component that existed and was fetched but was never PASSED in.
// The same mistake is available here: a GripPanel that renders perfectly in isolation while
// RenderTab never uses it. Asserting on the call site is the only check that catches that.
console.log('\n=== 拖动面板确实接进了出片页 ===')
const renderTabSrc = source.slice(
  source.indexOf('function RenderTab('),
  source.indexOf('function PromptStudio(') > 0 ? source.indexOf('function PromptStudio(') : source.length,
)
check('RenderTab 使用了 GripPanel', /h\(GripPanel,/.test(renderTabSrc))
check('成片区域用了拖动面板', /label: '成片'/.test(renderTabSrc))
check('片段表也用了拖动面板', /label: '片段表'/.test(renderTabSrc))
check('两处高度都写回配置',
  /saveHeight\('clipPanelHeight'\)/.test(renderTabSrc) && /saveHeight\('tablePanelHeight'\)/.test(renderTabSrc))
check('RenderTab 接收 ui / onUi',
  // `[\s\S]` rather than `[^}]`: the props object spans several lines now, and a `[^}]` class
  // stops at the first `}` it meets — which is inside the type annotation, not the end of the list.
  /function RenderTab\(\{[\s\S]*?\bui\b[\s\S]*?\}\)/.test(source)
  && /h\(RenderTab, \{[\s\S]*?ui: uiConfig[\s\S]*?\}\)/.test(source))
check('客户端能读回配置（loadConfig）', /loadConfig: \(\) => call\('GET', '\/config'\)/.test(source))
check('拖动结果会持久化', /api\.saveConfig\(\{ ui: patch \}\)/.test(source))

// ---------------------------------------------------------------- fallback drift
//
// The client carries its own copy of the three option lists so the controls can render before
// anything has been fetched. A copy that disagrees with the host is the same class of defect as the
// missing wiring: the panel would offer a tier or a ratio the renderer does not know.
console.log('\n=== 兜底列表与宿主是否一致 ===')

const block = /const CATALOGUE_FALLBACK = \{([\s\S]*?)\n    \}/.exec(source)?.[1] ?? ''
check('源码里能找到 CATALOGUE_FALLBACK', block.length > 0)

const tierPairs = [...block.matchAll(/key: '([^']+)', label: '([^']+)', megapixels: ([\d.]+)/g)]
  .map(([, key, label, mp]) => ({ key, label, megapixels: Number(mp) }))
check('分辨率档位与宿主一致',
  tierPairs.length === compile.RESOLUTION_TIERS.length
  && tierPairs.every((t, i) => t.key === compile.RESOLUTION_TIERS[i].key
    && Math.abs(t.megapixels - compile.RESOLUTION_TIERS[i].megapixels) < 1e-9),
  tierPairs.map((t) => t.label).join(' '))

const ratioList = (/ratios: \[([^\]]+)\]/.exec(block)?.[1] ?? '')
  .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
check('比例列表与宿主一致',
  JSON.stringify(ratioList) === JSON.stringify(Object.keys(compile.RATIOS)),
  ratioList.join(' '))

const presetFragments = [...block.matchAll(/key: '([^']+)', label: '([^']+)', fragment: '([^']+)'/g)]
  .map(([, key, label, fragment]) => ({ key, label, fragment }))
check('风格预设与宿主一致（key 与 fragment 都要对）',
  presetFragments.length === prompts.STYLE_PRESETS.length
  && presetFragments.every((p, i) => p.key === prompts.STYLE_PRESETS[i].key
    && p.fragment === prompts.STYLE_PRESETS[i].fragment),
  `${presetFragments.length} / ${prompts.STYLE_PRESETS.length} 个`)

// The render presets are mirrored for the same reason the catalogues above are: the panel has to
// render its selector before the status request returns, so the step counts are duplicated. If the
// two drift, the dropdown would promise 20 steps while the renderer ran 8 — the exact class of
// silent disagreement this whole file exists to catch.
const presetBlock = /const PRESET_FALLBACK = \{([\s\S]*?)\n      \}/.exec(source)?.[1] ?? ''
check('源码里能找到 PRESET_FALLBACK', presetBlock.length > 0)
const presetMirror = [...presetBlock.matchAll(
  /(\w+): \{ label: '([^']+)', imageSteps: (\d+), h3Steps: (\d+), turbo: (true|false) \}/g,
)].map(([, key, label, imageSteps, h3Steps, turbo]) => ({
  key, label, imageSteps: Number(imageSteps), h3Steps: Number(h3Steps), turbo: turbo === 'true',
}))
const hostPresets = Object.entries(api.PRESETS ?? {}).map(([key, entry]) => ({
  key, label: entry.label, imageSteps: entry.imageSteps, h3Steps: entry.h3Steps, turbo: Boolean(entry.turbo),
}))
check('渲染预设与宿主一致（步数与 turbo 都要对）',
  presetMirror.length === hostPresets.length
  && presetMirror.every((mine, i) => mine.key === hostPresets[i].key
    && mine.label === hostPresets[i].label
    && mine.imageSteps === hostPresets[i].imageSteps
    && mine.h3Steps === hostPresets[i].h3Steps
    && mine.turbo === hostPresets[i].turbo),
  presetMirror.map((p) => `${p.label}:${p.h3Steps}步${p.turbo ? '+turbo' : ''}`).join(' '))
if (presetMirror.length !== hostPresets.length) {
  for (const [i, host] of hostPresets.entries()) {
    const mine = presetMirror[i]
    if (!mine || mine.key !== host.key) console.log(`   第 ${i + 1} 项漂移：面板 ${mine?.key ?? '(缺)'} vs 宿主 ${host.key}`)
  }
}
if (presetFragments.length !== prompts.STYLE_PRESETS.length) {
  // Naming the drifting entry is the difference between a usable failure and a puzzle.
  for (const [i, host] of prompts.STYLE_PRESETS.entries()) {
    const mine = presetFragments[i]
    if (!mine || mine.key !== host.key || mine.fragment !== host.fragment) {
      console.log(`    第 ${i + 1} 个不一致: 面板 ${mine?.key ?? '(缺)'} vs 宿主 ${host.key}`)
    }
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
