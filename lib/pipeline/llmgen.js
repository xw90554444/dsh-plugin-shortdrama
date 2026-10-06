/**
 * Structured generation over `ctx.llm.stream`.
 *
 * The reliability problem this solves: a model asked for JSON returns JSON most
 * of the time — fenced, prefixed with prose, or truncated at the token ceiling.
 * Rather than trusting it, every reply goes through extract -> validate -> retry,
 * with the concrete validation failures fed back on the second attempt. Only a
 * reply that satisfies the declared shape is ever returned to a caller.
 */

export class LlmGenError extends Error {
  /** @param {string} message @param {{code?:string, raw?:string, problems?:string[]}} [info] */
  constructor(message, info = {}) {
    super(message)
    this.name = 'LlmGenError'
    this.code = info.code ?? 'llm-gen-failed'
    this.raw = info.raw
    this.problems = info.problems
  }
}

/**
 * Find the first balanced `{...}` or `[...]` span, ignoring braces inside
 * strings. Handles the three shapes models actually emit: bare JSON, a fenced
 * block, and JSON embedded in an explanation.
 *
 * @param {string} text
 * @returns {number} index of the matching closer, or -1
 */
function matchBalanced(text, start) {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Extract the first JSON value from a model reply.
 * @param {string} text
 * @returns {unknown|undefined} undefined when nothing parses
 */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch { /* fall through to the tolerant paths */ }

  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim())
    } catch { /* the fence may itself wrap prose; keep scanning */ }
  }

  for (let start = 0; start < trimmed.length; start += 1) {
    const ch = trimmed[start]
    if (ch !== '{' && ch !== '[') continue
    const end = matchBalanced(trimmed, start)
    if (end < 0) continue
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch { /* try the next candidate */ }
  }
  return undefined
}

/**
 * Minimal declarative shape check. Deliberately not a general JSON Schema
 * implementation — it covers exactly the vocabulary the pipeline prompts use,
 * so the failure messages stay specific and actionable for the retry prompt.
 *
 * @param {unknown} value
 * @param {object} spec { type, required?, properties?, items?, enum?, minItems?, maxItems? }
 * @param {string} [path]
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateShape(value, spec, path = '$') {
  const problems = []
  if (!spec || typeof spec !== 'object') return problems

  if (spec.enum) {
    if (!spec.enum.includes(value)) problems.push(`${path}: expected one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`)
    return problems
  }

  switch (spec.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${path}: expected an object, got ${Array.isArray(value) ? 'array' : typeof value}`)
        return problems
      }
      for (const key of spec.required ?? []) {
        if (value[key] === undefined || value[key] === null) problems.push(`${path}.${key}: required but missing`)
      }
      for (const [key, child] of Object.entries(spec.properties ?? {})) {
        if (value[key] !== undefined && value[key] !== null) {
          problems.push(...validateShape(value[key], child, `${path}.${key}`))
        }
      }
      return problems
    }
    case 'array': {
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected an array, got ${typeof value}`)
        return problems
      }
      if (spec.minItems !== undefined && value.length < spec.minItems) {
        problems.push(`${path}: expected at least ${spec.minItems} item(s), got ${value.length}`)
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        problems.push(`${path}: expected at most ${spec.maxItems} item(s), got ${value.length}`)
      }
      if (spec.items) {
        // Report the first few offenders only: a wall of errors buries the cause.
        let reported = 0
        for (let i = 0; i < value.length && reported < 4; i += 1) {
          const found = validateShape(value[i], spec.items, `${path}[${i}]`)
          if (found.length > 0) { problems.push(...found); reported += 1 }
        }
      }
      return problems
    }
    case 'string':
      // The mirror of the numeric case below: a model asked for a free-text field
      // will happily answer `27` for an age, and the cast normaliser stringifies it
      // anyway. Rejecting that burned a full local-model retry (two minutes on a
      // 27B) over a value that was about to be coerced. Only container types are
      // genuinely wrong here.
      if (typeof value === 'number' && Number.isFinite(value)) return problems
      if (typeof value !== 'string') problems.push(`${path}: expected a string, got ${typeof value}`)
      else if (spec.minLength !== undefined && value.trim().length < spec.minLength) {
        problems.push(`${path}: must not be empty`)
      }
      return problems
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        // Models routinely emit "3" for 3; accept a numeric string rather than
        // burning a retry on it.
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return problems
        problems.push(`${path}: expected a number, got ${JSON.stringify(value)}`)
      }
      return problems
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path}: expected a boolean, got ${typeof value}`)
      return problems
    default:
      return problems
  }
}

/**
 * Drain a `llm.stream()` iterable.
 *
 * @param {AsyncIterable<object>} stream
 * @param {(delta:string, full:string)=>void} [onDelta]
 * @param {(delta:string)=>void} [onReasoning]
 * @returns {Promise<{text:string, reasoning:string, usage:object|null, finish:object|null}>}
 */
export async function collectStream(stream, onDelta, onReasoning) {
  let text = ''
  let reasoning = ''
  let usage = null
  let finish = null
  for await (const chunk of stream) {
    switch (chunk?.type) {
      case 'text-delta':
        text += chunk.text ?? ''
        onDelta?.(chunk.text ?? '', text)
        break
      case 'reasoning-delta':
        reasoning += chunk.text ?? ''
        onReasoning?.(chunk.text ?? '')
        break
      case 'usage':
        usage = chunk.usage ?? null
        break
      case 'finish':
        finish = chunk.reason ?? null
        break
      case 'block-end':
        // A provider may deliver the whole text block without deltas.
        if (chunk.block?.type === 'text' && text.length === 0) text = chunk.block.text ?? ''
        break
      default:
        break
    }
  }
  return { text, reasoning, usage, finish }
}

/**
 * Generate one JSON object, retrying once with the validation failures fed back.
 *
 * @param {object} options
 * @param {object} options.llm the `ctx.llm` service
 * @param {string} options.provider
 * @param {string} options.model
 * @param {string} options.system system prompt
 * @param {string} options.user first user turn
 * @param {object} options.spec shape spec for {@link validateShape}
 * @param {number} [options.maxAttempts]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {AbortSignal} [options.signal]
 * @param {(info:{attempt:number, phase:'streaming'|'validating'|'retrying', text:string, reasoning:string, problems:string[]})=>void} [options.onProgress]
 * @returns {Promise<{value:unknown, text:string, attempts:number, usage:object|null}>}
 */
export async function generateJson(options) {
  const {
    llm, provider, model, system, user, spec,
    maxAttempts = 2,
    temperature = 0.7,
    maxTokens = 8000,
    signal,
    onProgress,
  } = options

  if (!llm) throw new LlmGenError('no llm service in this composition', { code: 'no-llm' })
  if (!provider || !model) throw new LlmGenError('no model selected', { code: 'no-model' })

  /** @type {object[]} */
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }]
  let lastText = ''
  let lastProblems = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new LlmGenError('generation cancelled', { code: 'aborted' })

    const stream = llm.stream({
      provider,
      model,
      system,
      messages,
      temperature,
      maxTokens,
      signal,
    })

    // `liveReasoning` exists because the progress callback fires *during*
    // collection. Reading the destructured `reasoning` inside that callback would
    // hit its temporal dead zone and throw — a deterministic crash on the very
    // first streamed delta, not a transient failure.
    let liveReasoning = ''
    const { text, reasoning, usage, finish } = await collectStream(
      stream,
      (delta, full) => {
        onProgress?.({ attempt, phase: 'streaming', text: full, reasoning: liveReasoning, problems: [] })
      },
      (reasoningDelta) => { liveReasoning += reasoningDelta },
    )
    lastText = text

    if (finish?.kind === 'error') {
      throw new LlmGenError(`model call failed: ${finish.failure?.message ?? 'unknown error'}`, {
        code: finish.failure?.code ?? 'provider-error',
        raw: text,
      })
    }
    if (finish?.kind === 'aborted') {
      throw new LlmGenError('generation cancelled', { code: 'aborted', raw: text })
    }

    onProgress?.({ attempt, phase: 'validating', text, reasoning, problems: [] })

    const parsed = extractJson(text)
    if (parsed === undefined) {
      lastProblems = ['the reply contained no parsable JSON object']
    } else {
      lastProblems = validateShape(parsed, spec)
      if (lastProblems.length === 0) {
        return { value: parsed, text, attempts: attempt, usage }
      }
    }

    if (attempt === maxAttempts) break

    onProgress?.({ attempt, phase: 'retrying', text, reasoning, problems: lastProblems })

    // Feed the failure back as a fresh user turn. Only user turns are
    // constructible without a provider source, and a correction reads naturally
    // as one.
    const truncated = finish?.kind === 'max-tokens'
    messages.push({
      role: 'user',
      content: [{
        type: 'text',
        text: [
          'Your previous reply was rejected.',
          '',
          'Previous reply:',
          '```',
          text.slice(0, 12000),
          '```',
          '',
          'Problems:',
          ...lastProblems.slice(0, 12).map((p) => `- ${p}`),
          ...(truncated ? ['- the reply was cut off by the output token limit; produce a shorter, complete object'] : []),
          '',
          'Reply with ONLY the corrected JSON object. No prose, no code fence.',
        ].join('\n'),
      }],
    })
  }

  throw new LlmGenError(
    `model did not produce a valid object after ${maxAttempts} attempt(s): ${lastProblems.slice(0, 4).join('; ')}`,
    { code: 'invalid-shape', raw: lastText, problems: lastProblems },
  )
}

export default { LlmGenError, extractJson, validateShape, collectStream, generateJson }
