/**
 * Catch the class of bug that made the panel go blank: a piece of state used from the wrong
 * component.
 *
 * What happened: `const [renderPress, setRenderPress] = React.useState(...)` was written into
 * `RenderTab`, while `startRender` — which calls `setRenderPress` — lives in `PromptStudio`. That is
 * a free variable in a different function: harmless until the button is pressed, then a
 * ReferenceError. Neither a syntax check nor any render-to-string test in this suite can see it,
 * because string rendering never invokes the handler.
 *
 * A first version of this file tried to mount the panel with a hand-written hook runtime and fire
 * real clicks. That does not work: the panel's own `useAsync` calls `React.useState` directly, so the
 * real React dispatcher has to be installed, which only happens inside a real render. Rather than
 * fake React, this checks the property that was actually violated — that a state variable and every
 * use of it belong to the same component — which is both simpler and precisely the defect.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (label, ok, extra = '') => {
  if (ok) console.log(`✓ ${label}${extra ? `  ${extra}` : ''}`)
  else { failures += 1; console.log(`✗ ${label}${extra ? `  ${extra}` : ''}`) }
}

const CLIENT = join(HERE, 'lib', 'client.js')
const source = readFileSync(CLIENT, 'utf8')
const lines = source.split('\n')

/** Component boundaries: `function Name(` at four-space indent inside the factory. */
const starts = []
lines.forEach((line, i) => {
  const m = /^ {4}function (\w+)\s*\(/.exec(line)
  if (m) starts.push({ line: i + 1, name: m[1] })
})
const ownerOf = (lineNo) => {
  let owner = null
  for (const s of starts) if (s.line < lineNo) owner = s.name
  return owner
}

console.log(`=== 组件边界（共 ${starts.length} 个）===`)
console.log(`  ${starts.map((s) => s.name).join(' · ')}`)

// ---------------------------------------------------------------- the check

console.log('\n=== 每个 useState 的读写是否都在定义它的组件里 ===')
const declared = new Map()
lines.forEach((line, i) => {
  const m = /const \[(\w+),\s*(\w+)\] = React\.useState/.exec(line)
  if (m) declared.set(m[1], { line: i + 1, owner: ownerOf(i + 1), setter: m[2] })
})

/**
 * Only compound state names are checked (`renderPress`, `presetKey`, …).
 *
 * A bare `state` — as used inside `useAsync` — is an ordinary English word that appears in unrelated
 * code, and an earlier version of this check reported every such line. A test that cries wolf gets
 * ignored, which is worse than not having it.
 */
const isCompound = (name) => /^[a-z]+[A-Z]\w*$/.test(name)
const checked = [...declared.entries()].filter(([name]) => isCompound(name))
console.log(`  扫描 ${declared.size} 个 useState，其中 ${checked.length} 个是复合命名（逐个校验）`)

/**
 * Is `name` declared anywhere inside the component whose body starts at `ownerLine`?
 *
 * A name match alone proves nothing: `targetSec` is a `useState` in `ScriptTab`, a PARAMETER of
 * `scriptCapacity`, and a destructured parameter inside `PromptStudio`'s `runFullPipeline` — three
 * legitimate declarations. What made `renderPress` a bug is that `PromptStudio` used it while
 * declaring it NOWHERE, so the check is "used but unresolvable", not "used elsewhere".
 */
function declaresIn(lines, ownerLine, name) {
  const body = lines.slice(ownerLine - 1)
  // Only this component's body: stop at the next top-level function, so one component's parameters
  // cannot vouch for another's.
  let end = body.length
  for (let i = 1; i < body.length; i += 1) {
    if (/^ {4}function \w+\s*\(/.test(body[i])) { end = i; break }
  }
  const scope = body.slice(0, end).join('\n')
  const patterns = [
    // Function and arrow parameters, plain or destructured.
    new RegExp(`function\\s*\\w*\\s*\\([^)]*\\b${name}\\b`),
    new RegExp(`(?:async\\s*)?\\([^)]*\\)\\s*=>`).test(scope) && new RegExp(`\\([^)]*\\b${name}\\b[^)]*\\)\\s*=>`).test(scope),
    // const / let / var, with or without destructuring.
    new RegExp(`(?:const|let|var)\\s+(?:\\[[^\\]]*|\\{[^}]*)?\\b${name}\\b`),
  ]
  return patterns.some(Boolean)
}

const misused = []
for (const [name, info] of checked) {
  const ownerLineOf = (ownerName) => starts.find((s) => s.name === ownerName)?.line ?? 1
  lines.forEach((line, i) => {
    if (i + 1 === info.line) return
    const owner = ownerOf(i + 1)
    if (!owner || owner === info.owner) return
    // Comments in this file name these variables freely, and that is not a use.
    if (/^\s*(\*|\/\/)/.test(line)) return
    if (!new RegExp(`\\b${name}\\b|\\b${info.setter}\\b`).test(line)) return
    if (declaresIn(lines, ownerLineOf(owner), name)) return
    if (declaresIn(lines, ownerLineOf(owner), info.setter)) return
    misused.push(`${name}（第 ${info.line} 行定义于 ${info.owner}）被第 ${i + 1} 行的 ${owner} 使用，但 ${owner} 里没有声明`)
  })
}
check('没有「使用了但无法解析」的状态引用', misused.length === 0, misused.slice(0, 4).join('  |  '))
if (misused.length) {
  console.log('  后果：变量在该组件里不存在，按下按钮时抛 ReferenceError，面板随即空白。')
  console.log('  修法：把 useState 挪到真正使用它的组件里（该组件须是使用者的自身或祖先）。')
}

// ---------------------------------------------------------------- the specific case

console.log('\n=== 渲染按钮的三个状态 ===')
for (const name of ['renderPress']) {
  const info = declared.get(name)
  check(`${name} 已声明`, Boolean(info), info ? `第 ${info.line} 行，定义于 ${info.owner}` : '未找到')
  if (!info) continue
  const users = []
  lines.forEach((line, i) => {
    if (new RegExp(`\\b${name}\\b|\\b${info.setter}\\b`).test(line)) users.push({ line: i + 1, owner: ownerOf(i + 1) })
  })
  const foreign = users.filter((u) => u.owner !== info.owner)
  check(`${name} 的所有引用都在 ${info.owner} 里`, foreign.length === 0,
    foreign.length ? foreign.map((f) => `第 ${f.line} 行在 ${f.owner}`).join(', ') : `${users.length} 处引用`)
}

// The buttons read these props, so they must be handed down from the owner above.
console.log('\n=== 宿主是否把状态传给了出片页 ===')
for (const prop of ['pendingKind', 'doneKind', 'onPress']) {
  check(`RenderTab 调用处传了 ${prop}`, new RegExp(`${prop}:`).test(source.slice(source.indexOf('h(RenderTab,'))))
}
check('RenderAction 用 props 而不是自由变量',
  /function RenderAction\(props\)[\s\S]{0,900}const \{ label, onRun, disabled, pending, done, title, busy, variant, size \} = props/.test(source))

console.log('\n=== 出片页不依赖父组件的状态（反向检查）===')
{
  const renderTab = source.slice(source.indexOf('function RenderTab('), source.indexOf('function PromptStudio('))
  const freeVars = ['renderPress', 'setRenderPress'].filter((v) => new RegExp(`\\b${v}\\b`).test(renderTab))
  check('RenderTab 里不出现父组件的状态', freeVars.length === 0, freeVars.join(', '))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
