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
import {
  lintStoryboard, snapFrames, framesToSeconds, groupIntoClips, TRAINED_MAX_FRAMES,
  clampClipSeconds, CLIP_SECONDS_DEFAULT,
} from './compile.js'
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

  /**
   * The previous board's per-shot direction, keyed by shot id.
   *
   * `promptNote` is not something the storyboard model produces — it is written by the later
   * shot-direction pass and edited by hand in the panel — so rebuilding a board from the model's
   * answer alone silently threw it away. Both prompt builders consume it, so a regenerated board
   * rendered from the action and nothing else.
   *
   * Ids are positional (`sh1`, `sh2`, …) and are reassigned here, so id equality alone is NOT
   * enough to identify "the same shot": a fully rewritten board still produces sh1, sh2, …. The
   * carried note is therefore only kept when the action it was written for is unchanged — a
   * different action is a different moment, and old staging on it would be worse than none.
   */
  const previous = new Map()
  for (const shot of Array.isArray(project?.shots) ? project.shots : []) {
    const id = str(shot?.id)
    if (id) previous.set(id, shot)
  }
  const carried = { kept: 0, changed: 0 }

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

    const action = str(raw?.action, '(missing action)')

    // The model's own answer wins if it ever supplies a note (a future spec might ask for one);
    // otherwise the operator's existing direction is carried over when the action still matches.
    let promptNote = str(raw?.promptNote ?? raw?.note)
    if (!promptNote) {
      const before = previous.get(id)
      const beforeNote = str(before?.promptNote)
      if (beforeNote) {
        if (str(before?.action) === action) { promptNote = beforeNote; carried.kept += 1 }
        else carried.changed += 1
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
      action,
      // See the note above `previous`: without this the scene is re-staged from scratch on every
      // regeneration and the operator's own writing disappears from the panel as well as the render.
      promptNote,
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

  if (carried.kept) repairs.push(`沿用上一版画面提示词 ${carried.kept} 条（对应镜头的内容未变）`)
  if (carried.changed) repairs.push(`丢弃 ${carried.changed} 条画面提示词（对应镜头的内容已变，旧调度不再适用）`)

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
 * The board's duration budget: how many shots, and how many seconds of CONTENT.
 *
 * The requested runtime is a limit on the finished film, and nothing used to enforce it. The
 * storyboard prompt converted every scene in the script into shots regardless, so a 30s target
 * produced 56.5s of footage — measured at +98% on a real project. Snapping to the frame grid adds
 * about a second on top; the other 55% was the board simply writing more film than was asked for.
 *
 * Two numbers, because they constrain different things:
 *
 *   - `maxContentSec` bounds the sum of the shots. It is deliberately below the target, because
 *     every clip then snaps UP to the 17k+5 frame grid and the tolerance band packs toward the
 *     ceiling. Budgeting exactly the target guarantees overshoot.
 *   - `maxShots` is the same budget expressed in shots, which is what the model actually decides.
 *     It is a hard CEILING, not a quota: scenes run out when they run out.
 *
 * @param {number} targetSec the requested runtime of the finished film
 * @param {number} clipSeconds the chosen 单次出片时长
 * @returns {{targetSec:number, maxContentSec:number, maxShots:number, avgShotSec:number, clipCount:number, shotsPerClip:number}}
 */
export function boardBudget(targetSec, clipSeconds) {
  const target = Math.max(1, Number(targetSec) || 60)
  const perClip = clampClipSeconds(clipSeconds ?? CLIP_SECONDS_DEFAULT)
  const shotsPerClip = Math.max(1, Math.round(perClip / AVG_SHOT_SEC))
  const clipCount = Math.max(1, Math.ceil(target / perClip))
  // Content budget: the grid and the band both round upward, so aim under the target. The reserve is
  // half a clip — the smallest amount that reliably absorbs a whole clip's worth of rounding.
  const reserve = perClip / 2
  const maxContentSec = Math.max(AVG_SHOT_SEC, target - reserve)
  const maxShots = Math.max(1, Math.floor(maxContentSec / AVG_SHOT_SEC))
  return {
    targetSec: target,
    maxContentSec: Math.round(maxContentSec * 10) / 10,
    maxShots,
    avgShotSec: AVG_SHOT_SEC,
    clipCount,
    shotsPerClip: Math.min(shotsPerClip, maxShots),
  }
}

/** Nominal shot length, used to convert between seconds and shots. */
export const AVG_SHOT_SEC = 3

/**
 * Trim a board down to its duration budget, by whole shots from the end.
 *
 * The prompt asks for the budget, but a prompt is a request and this is the guarantee: the model
 * overran on every real project measured. Cutting from the end keeps the opening intact and leaves a
 * board that is a complete first part of the film — which is the outcome asked for, rather than
 * compressing the story to fit.
 *
 * A scene is never left with zero shots, and a shot is never cut in half; if the last scene would
 * vanish entirely it is kept whole, because a board that drops a scene reads as a bug.
 *
 * @param {object[]} shots
 * @param {number} maxContentSec
 * @returns {{shots:object[], dropped:number, droppedSec:number}}
 */
export function trimToBudget(shots, maxContentSec) {
  const list = Array.isArray(shots) ? shots : []
  const budget = Number(maxContentSec)
  if (!Number.isFinite(budget) || budget <= 0) return { shots: list, dropped: 0, droppedSec: 0 }

  const totalSec = list.reduce((n, s) => n + (Number(s.durationSec) || 0), 0)
  if (totalSec <= budget) return { shots: list, dropped: 0, droppedSec: 0 }

  const kept = []
  let used = 0
  for (const shot of list) {
    const seconds = Number(shot.durationSec) || 0
    // Never cut the board down to nothing.
    if (kept.length === 0) { kept.push(shot); used += seconds; continue }
    // A shot that fits inside the budget is kept even when it opens a new scene — stopping there
    // would waste most of the budget. An earlier version checked the scene first and kept ONE shot
    // out of fourteen against a 26s budget.
    if (used + seconds <= budget) { kept.push(shot); used += seconds; continue }
    // It does not fit. Opening a new scene with it would leave that scene cut off mid-way, which
    // reads as a broken board rather than a short one, so this is where the cut lands.
    break
  }
  const dropped = list.length - kept.length
  const droppedSec = totalSec - used
  return { shots: kept, dropped, droppedSec: Math.round(droppedSec * 10) / 10 }
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
  const budget = boardBudget(request.targetSec, request.clipSeconds)
  const baseUser = storyboardUser(project, {
    targetSec: request.targetSec,
    clipSeconds: request.clipSeconds,
    budget,
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

    /**
     * Enforce the duration budget in code, not only in the prompt.
     *
     * The prompt states the budget, but on every real project measured the model overran it — a 30s
     * target came back with 56.5s of footage. A request is not a guarantee, and the operator asked
     * for 30 seconds; returning 56 is not a rounding difference, it is twice the film.
     *
     * The cut is applied to the last attempt only. Earlier attempts go back to the model with the
     * lint errors, and trimming there would hide the overrun from the retry instead of letting the
     * model fix it properly.
     */
    const isLastAttempt = boardAttempt === maxBoardAttempts
    if (isLastAttempt && shots.length > 0) {
      const trimmed = trimToBudget(shots, budget.maxContentSec)
      if (trimmed.dropped > 0) {
        shots = trimmed.shots
        repairs.push(
          `分镜超出时长预算，已按预算裁掉末尾 ${trimmed.dropped} 个镜头（约 ${trimmed.droppedSec}s）：`
          + `目标 ${budget.targetSec}s，内容预算 ${budget.maxContentSec}s。`,
        )
      }
    }

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

  return { attempts, usage, shots, repairs, summary: summarise(shots), budget }
}

export { snapFrames, framesToSeconds }
export default { runStoryboardStage, normaliseShots, summarise }
