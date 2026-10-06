/**
 * Cinematography pass — one direction line per shot.
 *
 * The storyboard's `action` says what happens; nothing in the pipeline said how the
 * moment is photographed. Keyframes built from the action alone come out as staged
 * tableaux, and closing that gap by hand across twenty shots is not something an
 * operator will do.
 *
 * One call for the whole board rather than one per shot: adjacent shots need to look
 * like they belong to the same film, and a model that can see the neighbours keeps
 * its lighting and lens choices coherent in a way twenty independent calls cannot.
 */
import { generateJson, LlmGenError } from './llmgen.js'
import { shotDirectionSystem, shotDirectionUser } from '../prompts.js'

/** One note per shot, keyed by id. */
const DIRECTION_SPEC = {
  type: 'object',
  required: ['shots'],
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'note'],
        properties: {
          id: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  },
}

/**
 * @param {object} deps resolved llm + provider + model
 * @param {object} request { project, shots, signal, onProgress }
 */
export async function runShotDirectionStage(deps, request) {
  const project = request.project
  const shots = Array.isArray(request.shots) ? request.shots.filter(Boolean) : []
  if (shots.length === 0) {
    throw new LlmGenError('no shots to write direction for', { code: 'no-shots' })
  }

  const result = await generateJson({
    llm: deps.llm,
    provider: deps.provider,
    model: deps.model,
    system: shotDirectionSystem(),
    user: shotDirectionUser(project, shots),
    spec: DIRECTION_SPEC,
    temperature: 0.8,
    // Budget scales with the board, and 12000 stopped being enough once a note grew to
    // 350-500 characters: a 40-shot board needs roughly 40 x 500 x 1.3 tokens before
    // JSON overhead, and a truncated array surfaces as a schema error rather than the
    // budget error it actually is.
    maxTokens: 32000,
    signal: request.signal,
    onProgress: request.onProgress,
  })

  // Map back by id. A shot the model omitted KEEPS what it already had: a partial
  // answer should improve the board, and blanking the rest would destroy work the
  // operator had already done by hand.
  const byId = new Map()
  for (const entry of result.value?.shots ?? []) {
    const id = String(entry?.id ?? '').trim()
    const note = String(entry?.note ?? '').trim()
    if (id && note) byId.set(id, note)
  }

  const updated = []
  const missing = []
  for (const shot of shots) {
    const note = byId.get(String(shot.id))
    if (note) updated.push({ ...shot, promptNote: note })
    else { updated.push(shot); missing.push(shot.id) }
  }

  return {
    shots: updated,
    written: updated.length - missing.length,
    total: updated.length,
    missing,
    attempts: result.attempts,
    usage: result.usage,
  }
}

export default runShotDirectionStage
