/**
 * Stage 3 — storyboard.
 *
 * Two gates, not one. `generateJson` already guarantees the reply matches the
 * declared shape; that is not enough here, because a shape-valid board can still
 * be unrenderable (a dangling scene id, a 20-second shot, a character who does
 * not exist). So the normalised board is run through the same `lintStoryboard`
 * the UI shows, and hard errors are fed back for one rewrite.
 */
import { generateJson, LlmGenError } from './llmgen.js'
import { STORYBOARD_SPEC, storyboardSystem, storyboardUser, storyboardFeedback, VOCAB } from '../prompts.js'
import { lintStoryboard, snapFrames, framesToSeconds, groupIntoClips, TRAINED_MAX_FRAMES } from './compile.js'
import { normaliseShotSize, normaliseCamera, normaliseMovement } from './compile.js'

const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

export const DURATION_MIN = 0.5
export const DURATION_MAX = 15

/**
 * Force a model-authored board into the shape the renderer needs.
 *
 * Repairs rather than rejects wherever the intent is unambiguous: a shot that
 * names a character the cast does not contain loses the reference (and is
 * reported), instead of failing an otherwise usable board.
 *
 * @param {object[]} rawShots
 * @param {object} project
 * @returns {{shots:object[], repairs:string[]}}
 */
export function normaliseShots(rawShots, project) {
  const repairs = []
  const knownScenes = new Set((project?.scenes ?? []).map((s) => s.id))
  const knownCharacters = new Set((project?.characters ?? []).map((c) => c.id))
  const nameToId = new Map((project?.characters ?? []).map((c) => [c.name, c.id]))
  const seenNames = new Set()

  const shots = (Array.isArray(rawShots) ? rawShots : []).map((raw, index) => {
    const id = `sh${index + 1}`

    let durationSec = num(raw?.durationSec, 3)
    if (durationSec < DURATION_MIN) { durationSec = DURATION_MIN; repairs.push(`${id}: duration raised to ${DURATION_MIN}s`) }
    if (durationSec > DURATION_MAX) { durationSec = DURATION_MAX; repairs.push(`${id}: duration clamped to ${DURATION_MAX}s`) }

    let sceneId = str(raw?.sceneId) || null
    if (sceneId && !knownScenes.has(sceneId)) {
      repairs.push(`${id}: dropped unknown sceneId "${sceneId}"`)
      sceneId = null
    }

    const characters = []
    for (const ref of Array.isArray(raw?.characters) ? raw.characters : []) {
      const value = str(ref)
      if (!value) continue
      const resolved = knownCharacters.has(value) ? value : nameToId.get(value)
      if (resolved && !characters.includes(resolved)) characters.push(resolved)
      else repairs.push(`${id}: dropped unknown character "${value}"`)
    }

    const dialogue = (Array.isArray(raw?.dialogue) ? raw.dialogue : [])
      .map((line) => ({ who: str(line?.who), line: str(line?.line) }))
      .filter((line) => line.line)

    // Names the cast does not contain are worth surfacing: it usually means the
    // model invented a character mid-board.
    for (const line of dialogue) {
      if (line.who && !nameToId.has(line.who) && !seenNames.has(line.who)) {
        seenNames.add(line.who)
        repairs.push(`${id}: dialogue speaker "${line.who}" is not in the cast`)
      }
    }

    return {
      id,
      no: index + 1,
      sceneId,
      durationSec,
      shotSize: normaliseShotSize(str(raw?.shotSize)) || VOCAB.shotSize[4],
      camera: normaliseCamera(str(raw?.camera)) || VOCAB.camera[0],
      movement: normaliseMovement(str(raw?.movement)) || VOCAB.movement[0],
      action: str(raw?.action, '(missing action)'),
      dialogue,
      sfx: str(raw?.sfx),
      notes: str(raw?.notes),
      characters,
      promptComfy: '',
      promptH3: '',
      negative: '',
      keyframeAssetId: null,
      videoAssetId: null,
      seed: null,
      status: 'draft',
    }
  })

  return { shots, repairs }
}

/** Board-level summary handed back with the shots. */
export function summarise(shots) {
  const totalSec = shots.reduce((n, s) => n + s.durationSec, 0)
  const clips = groupIntoClips(shots)
  return {
    shotCount: shots.length,
    totalSec: Math.round(totalSec * 10) / 10,
    renderedSec: clips.reduce((n, c) => n + c.seconds, 0),
    clipCount: clips.length,
    clips: clips.map((c) => ({
      index: c.index,
      shotIds: c.shotIds,
      frames: c.frames,
      seconds: c.seconds,
      overCeiling: c.frames > TRAINED_MAX_FRAMES,
    })),
  }
}

/**
 * @param {object} deps { llm, provider, model }
 * @param {object} request { project, instruction, targetSec, avgShotSec, maxBoardAttempts }
 */
export async function runStoryboardStage(deps, request) {
  const project = request.project
  if (!project?.script) {
    throw new LlmGenError('the project has no script yet; run the script stage first', { code: 'no-script' })
  }
  if ((project?.characters ?? []).length === 0) {
    throw new LlmGenError('the project has no cast yet; run the cast stage first', { code: 'no-cast' })
  }

  const maxBoardAttempts = Math.max(1, Math.min(3, request.maxBoardAttempts ?? 2))
  const pipeline = { llm: deps.llm, provider: deps.provider, model: deps.model }
  const baseUser = storyboardUser(project, {
    targetSec: request.targetSec,
    clipSeconds: request.clipSeconds,
    instruction: request.instruction,
  })

  let shots = []
  let repairs = []
  let attempts = 0
  let usage = null
  let feedback = ''

  for (let boardAttempt = 1; boardAttempt <= maxBoardAttempts; boardAttempt += 1) {
    const result = await generateJson({
      ...pipeline,
      system: storyboardSystem(),
      user: feedback
        ? `${baseUser}\n\n${feedback}\n\n上一版分镜表：\n\`\`\`json\n${JSON.stringify({ shots }, null, 2).slice(0, 20000)}\n\`\`\``
        : baseUser,
      spec: STORYBOARD_SPEC,
      temperature: 0.7,
      // 12000 was not enough: a 60s board needs roughly eighteen shots with a dozen
      // fields each, and the output was truncated mid-array, which fails as
      // "shots: required but missing" — a misleading error for a budget problem.
      // Budget is per-shot cost, not a style choice.
      maxTokens: 24000,
      signal: request.signal,
      onProgress: request.onProgress,
    })
    attempts += result.attempts
    usage = result.usage ?? usage

    const normalised = normaliseShots(result.value?.shots, project)
    shots = normalised.shots
    repairs = normalised.repairs

    const errors = lintStoryboard(shots, project).filter((issue) => issue.level === 'error')
    if (errors.length === 0) break

    if (boardAttempt === maxBoardAttempts) {
      // Return what we have rather than nothing: the UI shows the issues next to
      // the board so the user can fix them by hand.
      break
    }
    feedback = storyboardFeedback(errors)
    request.onProgress?.({ attempt: attempts, phase: 'retrying', text: '', reasoning: '', problems: errors.map((e) => e.message) })
  }

  return { attempts, usage, shots, repairs, summary: summarise(shots) }
}

export { snapFrames, framesToSeconds }
export default { runStoryboardStage, normaliseShots, summarise }
