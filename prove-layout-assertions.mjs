/**
 * Prove the layout assertions for the auto-quality switch are not decorative.
 *
 * A green test that would also be green with the bug present is worthless. The change under test is
 * "the switch moved from the right-hand notes column into the left control column, under the
 * dropdown" — so this moves it back and confirms the assertions go red, then restores the file.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, 'lib', 'client.js')
const VERIFY = join(HERE, 'verify-render.mjs')
const NODE = process.execPath

const original = readFileSync(CLIENT, 'utf8')

/** Run verify-render and return the failed assertion lines, the exit code, and any stderr. */
function failingLines() {
  try {
    const out = execFileSync(NODE, [VERIFY], { encoding: 'utf8', cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
    return { out, err: '', code: 0 }
  } catch (error) {
    return { out: String(error.stdout ?? ''), err: String(error.stderr ?? ''), code: error.status ?? 1 }
  }
}

/**
 * A regression sample is only evidence if the suite RAN and failed an assertion.
 *
 * A syntax error in the sample makes the suite exit non-zero without printing a single `✗`, which
 * reads as "the assertion caught it" when in truth nothing ran. The first version of this file made
 * exactly that mistake on regression 1.
 */
function verdict(label, result) {
  const hits = result.out.split('\n').filter((l) => l.trim().startsWith('✗'))
  const crashed = /SyntaxError|Error:/.test(result.err) && hits.length === 0
  console.log(`\n${label}  -> exit=${result.code}，断言失败 ${hits.length} 条${crashed ? '（脚本崩溃，非断言）' : ''}`)
  for (const h of hits.slice(0, 5)) console.log(`   ${h.trim()}`)
  if (crashed) {
    console.log(`   ✗ 样本本身语法错误，没跑起来：${result.err.split('\n')[0]}`)
    console.log('   -> 这一条不算证据，需要换一个能保持语法正确的样本')
    return 'crashed'
  }
  if (result.code === 0) {
    console.log('   ✗ 没有报错——这些断言是摆设！')
    return 'missed'
  }
  console.log('   ✓ 断言确实会报红')
  return 'caught'
}

const before = failingLines()
console.log(`基线：exit=${before.code}  ${before.code === 0 ? '全部通过' : '有失败'}`)
if (before.code !== 0) {
  console.log('基线就不是绿的，先修好再谈这个检查。')
  process.exit(1)
}

// ---------------------------------------------------------------- regression 1

/**
 * Put the switch back in the right-hand notes column.
 *
 * The sample has to stay syntactically valid, or the suite exits non-zero from a parse error and it
 * reads as "the assertion caught it" when nothing ran. The first version appended a label with an
 * unbalanced bracket and produced exactly that false positive; this one only changes the column's
 * closing and the two flex wrappers, which balances.
 */
const BROKEN_NOTES = original
  .replace(
    "flexDirection: 'column', alignItems: 'flex-start', gap: 7",
    "flexDirection: 'row', alignItems: 'flex-start', gap: 7",
  )
  .replace(
    "h('label', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },",
    "h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },",
  )
if (BROKEN_NOTES === original) {
  console.log('⚠ 无法构造回归样本 1（锚点未匹配），跳过')
} else {
  writeFileSync(CLIENT, BROKEN_NOTES, 'utf8')
  verdict('回归 1：把控件列改回横向（开关不再在下拉框下面）', failingLines())
}

// ---------------------------------------------------------------- regression 2

// Drop the label so the checkbox and its reason are no longer in one row.
const BROKEN_ROW = original.replace(
  "            h('label', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },",
  "            h('div', { style: { display: 'block' } },",
)
if (BROKEN_ROW === original) {
  console.log('\n⚠ 无法构造回归样本 2（锚点未匹配），跳过')
} else {
  writeFileSync(CLIENT, BROKEN_ROW, 'utf8')
  verdict('回归 2：把开关那一行从 flex 改成 block', failingLines())
}

// ---------------------------------------------------------------- regression 3

// Give the control column `center` alignment. This is the subtle one: the switch would still be
// under the dropdown, but its left edge would drift away from the 「出片质量」 label as soon as the
// notes column beside it grew taller.
const BROKEN_ALIGN = original.replace(
  "flexDirection: 'column', alignItems: 'flex-start', gap: 7",
  "flexDirection: 'column', alignItems: 'center', gap: 7",
)
if (BROKEN_ALIGN === original) {
  console.log('\n⚠ 无法构造回归样本 3（锚点未匹配），跳过')
} else {
  writeFileSync(CLIENT, BROKEN_ALIGN, 'utf8')
  verdict('回归 3：把控件列改成居中对齐（左边缘会漂移）', failingLines())
}

writeFileSync(CLIENT, original, 'utf8')
const restored = failingLines()
console.log(`\n还原后：exit=${restored.code}  ${restored.code === 0 ? '全部通过' : '仍有失败'}`)
if (restored.code !== 0) process.exitCode = 1
