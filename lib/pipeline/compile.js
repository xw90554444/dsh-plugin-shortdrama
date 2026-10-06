/**
 * Deterministic prompt compiler for the ShortDrama pipeline.
 *
 * Why a compiler instead of "let the model write the prompt": an LLM left to
 * free-form the prompt drifts in format, so the same storyboard compiles to two
 * different strings and results stop being reproducible. Here the LLM only fills
 * structured fields; the FORMAT is fixed by this module.
 *
 * Everything in this file is pure: no I/O, no clock, no randomness. That makes it
 * unit-testable and makes a compiled prompt a stable artifact.
 *
 * Verified against the live ComfyUI (v0.38.2) node contract:
 *   MiniMaxH3ImageToVideo.required = clip, vae, prompt(STRING multiline),
 *     width(INT step 32), height(INT step 32), length(INT step 17)
 *   MiniMaxH3ImageToVideo.optional = first_frame(IMAGE), last_frame(IMAGE)
 */

// ---------------------------------------------------------------------------
// Frame grid
// ---------------------------------------------------------------------------

/** H3 renders at a fixed 24 fps. */
export const FPS = 24
/** `length` must land on the model's 17k+5 grid. */
export const FRAME_GRID_STEP = 17
export const FRAME_GRID_OFFSET = 5
/** Trained range, per the official template note (124 ≈ 5s, 362 ≈ 15s). */
export const TRAINED_MIN_FRAMES = 124
export const TRAINED_MAX_FRAMES = 362
/** Node widget bounds. */
export const LENGTH_MIN = 5
export const LENGTH_MAX = 3600

/**
 * Snap a duration to the model's 17k+5 frame grid, reproducing the official
 * template's own expression:
 *   max(5, round(sec*24)) + (5 - (max(5, round(sec*24)) % 17)) % 17
 * Unlike a raw `%`, this stays correct for frame counts below the offset.
 *
 * @param {number} seconds desired clip duration
 * @returns {number} the frame count `length` to send to the node
 */
export function snapFrames(seconds) {
  const raw = Math.max(5, Math.round((Number(seconds) || 0) * FPS))
  const pad = ((FRAME_GRID_OFFSET - (raw % FRAME_GRID_STEP)) % FRAME_GRID_STEP + FRAME_GRID_STEP) % FRAME_GRID_STEP
  return raw + pad
}

/** @param {number} frames @returns {number} seconds actually rendered */
export function framesToSeconds(frames) {
  return Math.round((frames / FPS) * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * H3's native canvas is a 768px short edge capped at 768x1344, rounded to a
 * multiple of 32. Short-form drama is usually vertical, so 9:16 is first.
 */
export const RATIOS = {
  '9:16': [9, 16],
  '16:9': [16, 9],
  '1:1': [1, 1],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '21:9': [21, 9],
  // The portrait counterpart. Without it a vertical ultra-wide had no option and
  // silently fell back to 16:9, which is the wrong shape rather than a smaller one.
  '9:21': [9, 21],
  '3:2': [3, 2],
  '2:3': [2, 3],
}

export const LONG_EDGE_MAX = 1344
export const SHORT_EDGE_NATIVE = 768

/**
 * How long ONE generation runs, in seconds — the unit the storyboard is really
 * built around.
 *
 * H3 renders one clip per submission and a clip may hold several shots, so the
 * meaningful control is not "how long is a shot" but "how long is a render".
 * Shots are packed to fill this window, and consecutive clips then chain by
 * feeding each clip's opening keyframe forward, which is what makes the joins
 * line up. Writing the storyboard against the real render window is also what
 * keeps the compiled timeline honest.
 *
 * H3's trained range is ~124–362 frames (5.17–15.08s) on the 17k+5 grid, so the
 * useful span is narrow and anything outside it degrades.
 */
export const CLIP_SECONDS_MIN = 5
export const CLIP_SECONDS_MAX = 15
export const CLIP_SECONDS_DEFAULT = 10

/** @param {number} seconds @returns {number} a usable clip length in seconds */
export function clampClipSeconds(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return CLIP_SECONDS_DEFAULT
  return Math.min(CLIP_SECONDS_MAX, Math.max(CLIP_SECONDS_MIN, value))
}

/**
 * Per-frame rendering cost, measured on a 4070 Ti SUPER at 768x1344 with the
 * turbo LoRA (6 steps).
 *
 * Cost is markedly superlinear in clip length — attention scales with sequence
 * length — so a 15s clip costs ~5.8 s/frame while a 5s clip costs ~1.8. That has
 * a counter-intuitive consequence worth surfacing in the UI: **shorter clips are
 * cheaper in total**, because you pay the higher per-frame rate only on the long
 * ones. Splitting 60s into twelve 5s clips costs roughly half of what four 15s
 * clips cost. The tradeoff is more seams to hide.
 *
 * Two measured points are enough; the interpolation is linear in frame count and
 * the result is presented as an estimate, never a promise.
 */
const COST_ANCHORS = [
  { frames: 124, secondsPerFrame: 1.84 }, // measured: 228s
  { frames: 328, secondsPerFrame: 5.20 }, // measured: 1700s
]

/** @param {number} frames @returns {number} estimated seconds for one clip */
export function estimateClipSeconds(frames) {
  const [[lo], [hi]] = [COST_ANCHORS, COST_ANCHORS.slice(1)]
  const n = Math.max(5, Number(frames) || 0)
  let perFrame = lo.secondsPerFrame
  if (n >= hi.frames) {
    // Extrapolate past the last measurement rather than clamping: letting the UI
    // under-report a very long clip would be worse than an approximate number.
    const slope = (hi.secondsPerFrame - lo.secondsPerFrame) / (hi.frames - lo.frames)
    perFrame = hi.secondsPerFrame + slope * (n - hi.frames)
  } else if (n > lo.frames) {
    const slope = (hi.secondsPerFrame - lo.secondsPerFrame) / (hi.frames - lo.frames)
    perFrame = lo.secondsPerFrame + slope * (n - lo.frames)
  }
  return n * perFrame
}

/**
 * What a whole board will cost to render, plus the seam count each choice implies.
 *
 * @param {object[]} shots
 * @param {number} clipSeconds
 * @returns {{clips:number, seconds:number, frames:number, seams:number, totalSeconds:number}}
 */
export function estimateBoardCost(shots, clipSeconds) {
  const clips = groupIntoClips(shots, { maxFrames: snapFrames(clampClipSeconds(clipSeconds)) })
  const seconds = clips.reduce((n, c) => n + c.seconds, 0)
  const frames = clips.reduce((n, c) => n + c.frames, 0)
  const totalSeconds = clips.reduce((n, c) => n + estimateClipSeconds(c.frames), 0)
  return {
    clips: clips.length,
    seconds: Math.round(seconds * 10) / 10,
    frames,
    // One join between each pair of consecutive clips.
    seams: Math.max(0, clips.length - 1),
    totalSeconds: Math.round(totalSeconds),
  }
}


/**
 * Output size for an IMAGE model, targeting a megapixel budget.
 *
 * Distinct from {@link resolutionFor}, which sizes H3's video canvas. Image models
 * are trained at a characteristic pixel budget and lose detail well below it:
 * Qwen-Image 2.1's own guidance is ~1 MP as the default and up to 4 MP for native
 * 2K. Rendering reference art at 768x1024 (0.79 MP) sits *under* that floor, which
 * is one reason output came out soft regardless of prompt quality.
 *
 * @param {string} ratio one of {@link RATIOS}
 * @param {number} megapixels target total pixels, in millions
 * @param {number} [multiple] dimension granularity
 * @returns {{width:number,height:number}}
 */
/**
 * Output resolutions offered in the studio.
 *
 * A TIER, not a pixel count: naming a short edge is meaningless once the ratio can
 * be 9:21, and "1080P" on a vertical frame and "1080P" on a landscape one are the
 * same promise — the short edge — but very different pixel budgets. Megapixels is
 * the unit the image stages actually consume, so it is what gets stored.
 *
 * Video is deliberately absent: H3 renders at its own trained resolution and the
 * canvas is not ours to choose. See resolutionFor.
 */
export const RESOLUTION_TIERS = [
  { key: '480p', label: '480P', megapixels: 0.4 },
  { key: '720p', label: '720P', megapixels: 0.9 },
  { key: '1080p', label: '1080P', megapixels: 2 },
  { key: '2k', label: '2K', megapixels: 3.7 },
]

/** @param {number} megapixels */
export function tierForMegapixels(megapixels) {
  const n = Number(megapixels) || 2
  let best = RESOLUTION_TIERS[0]
  for (const tier of RESOLUTION_TIERS) {
    if (Math.abs(tier.megapixels - n) < Math.abs(best.megapixels - n)) best = tier
  }
  return best
}

/**
 * Reference art is rendered at a FIXED budget, deliberately not the project's.
 *
 * A reference is working material, not an output: it exists to be looked at while
 * building the board, and its size is chosen so a three-panel sheet stays legible —
 * not so it matches the finished frame. Tying it to the resolution selector meant
 * picking 480P to iterate quickly also degraded the references the keyframes are
 * generated FROM, which is the opposite of what a speed setting should do.
 *
 * The project's ratio and resolution therefore reach exactly two things: the
 * storyboard keyframes, and the video.
 */
export const REFERENCE_MEGAPIXELS = 2

export function resolutionForMegapixels(ratio = '9:16', megapixels = 2, multiple = 32) {
  // An unknown ratio used to fall through to 9:16 in silence, which turned an
  // intended landscape into a portrait with nothing to indicate anything was wrong.
  if (!RATIOS[ratio]) {
    throw new Error(`unknown ratio "${ratio}"; known: ${Object.keys(RATIOS).join(', ')}`)
  }
  const [rw, rh] = RATIOS[ratio]
  const target = Math.min(16, Math.max(0.1, Number(megapixels) || 2)) * 1e6
  const snap = (n) => Math.max(multiple, Math.round(n / multiple) * multiple)
  // Solve w·h = target subject to w/h = rw/rh.
  const height = Math.sqrt((target * rh) / rw)
  const width = (height * rw) / rh
  return { width: snap(width), height: snap(height) }
}

/**
 * The three-view sentence, shared by the character pipeline and the free-form
 * image tools.
 *
 * Extracted rather than duplicated: the wording is load-bearing. "identical
 * proportions, identical clothing and hair in all three" is what keeps the panels
 * consistent, and "plain seamless neutral grey studio background" with "no shadows
 * on the backdrop" is what stops the backdrop bleeding into the figures. Two
 * copies would drift, and only one of them would ever get fixed.
 *
 * @param {string} who the subject phrase, already assembled
 * @param {string} looks the appearance clause, may be empty
 * @param {string} style the look to apply, may be empty
 * @param {string} quality the quality tail
 * @returns {string}
 */
export function threeViewSentence(who, looks, style, quality) {
  return joinSentence([
    `Character model sheet of ${who}: three full-body views side by side`,
    looks,
    'left panel: front view facing the camera; centre panel: side profile facing left; right panel: back view',
    'full figure head to toe in every panel, identical proportions, identical clothing and hair in all three',
    'consistent scale across panels, evenly spaced, standing straight with arms relaxed',
    'plain seamless neutral grey studio background, even soft lighting, no shadows on the backdrop',
    'clean character turnaround reference, no text, no labels, no watermark',
    style ? `overall look: ${style}` : '',
    quality,
  ])
}

/**
 * A three-view prompt built from free text rather than a stored character.
 *
 * This is the "make me a turnaround of THIS" path: a description the user typed,
 * or — when a reference image is supplied — instructions to keep that image's
 * subject while restating them as a sheet. The image itself is wired by the graph,
 * not by this string, which is why the bridge sentence exists: without it the
 * encoder sees the reference but is told nothing about what to do with it.
 *
 * @param {object} options
 * @param {string} [options.subject] free-text description of the character
 * @param {string} [options.style]
 * @param {string} [options.quality]
 * @param {boolean} [options.keepSource] a reference image was supplied
 * @returns {{positive:string, negative:string}}
 */
export function compileThreeViewPrompt(options = {}) {
  const subject = isNonEmpty(options.subject) ? options.subject.trim() : 'the character shown'
  const style = isNonEmpty(options.style) ? `${options.style}.` : ''
  const quality = isNonEmpty(options.quality)
    ? options.quality
    : 'cinematic still, sharp focus, natural skin texture, film grain'
  const bridge = options.keepSource
    ? 'Reproduce the same person from the reference image: same face, same hair, same build, same clothing.'
    : ''

  return {
    positive: joinSentence([bridge, threeViewSentence(subject, '', style, quality)]),
    // The panel-specific failures are worth naming: a text encoder asked for a
    // sheet can otherwise produce one figure with three heads, or three figures in
    // three different outfits.
    negative: [
      ...IMAGE_NEGATIVE_DEFAULT,
      'two people, multiple heads, duplicated limbs',
      'different clothing or hair between panels',
      'panel borders, frame lines, collage seams',
    ].join(', '),
  }
}

/**
 * A stable fingerprint of the parts of a script a storyboard is derived from.
 *
 * Regenerating the script does NOT clear the board, and that is deliberate: shots
 * may have been hand-edited, and silently discarding that work would be worse than
 * stale data. But stale data that LOOKS current is worse still — the operator
 * recompiles prompts and gets text describing the script they just replaced, with
 * nothing to explain why. So the board records which script it came from, and the
 * mismatch is REPORTED rather than prevented.
 *
 * Only story-bearing fields are hashed. Including anything else would raise a
 * false alarm when an unrelated field changes.
 *
 * @param {object|null} script
 * @returns {string} '' when there is no script to fingerprint
 */
export function scriptFingerprint(script) {
  if (!script || typeof script !== 'object') return ''
  const canonical = JSON.stringify({
    synopsis: script.synopsis ?? '',
    beats: (script.beats ?? []).map((b) => [b.id, b.summary ?? '', b.emotion ?? '']),
    scenes: (script.scenes ?? []).map((s) => [
      s.id, s.beatId ?? '', s.slug ?? '',
      (s.dialogue ?? []).map((d) => [d.who ?? '', d.line ?? '']),
    ]),
  })
  // djb2: stable across processes and cheap, which is all a change-detector needs.
  let hash = 5381
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0
  }
  return `v1:${canonical.length}:${(hash >>> 0).toString(36)}`
}

/**
 * @param {string} ratio one of {@link RATIOS}
 * @param {number} [shortEdge] short edge in pixels
 * @returns {{width:number,height:number}}
 */
export function resolutionFor(ratio = '16:9', shortEdge = SHORT_EDGE_NATIVE) {
  const [rw, rh] = RATIOS[ratio] ?? RATIOS['16:9']
  const snap32 = (n) => Math.max(32, Math.round(n / 32) * 32)
  let width
  let height
  if (rw >= rh) {
    height = snap32(shortEdge)
    width = snap32((height * rw) / rh)
  } else {
    width = snap32(shortEdge)
    height = snap32((width * rh) / rw)
  }
  // When the long edge exceeds the cap, re-derive the SHORT edge from the capped
  // long edge rather than scaling both: scaling both would shrink the short edge
  // below the native 768 (16:9 collapsed to 1344x736 instead of 1344x768).
  if (Math.max(width, height) > LONG_EDGE_MAX) {
    if (rw >= rh) {
      width = LONG_EDGE_MAX
      height = Math.min(snap32(shortEdge), snap32((LONG_EDGE_MAX * rh) / rw))
    } else {
      height = LONG_EDGE_MAX
      width = Math.min(snap32(shortEdge), snap32((LONG_EDGE_MAX * rw) / rh))
    }
  }
  return { width, height }
}

// ---------------------------------------------------------------------------
// Vocabulary normalisation
//
// Keeps prompt wording stable whether the storyboard was authored in Chinese or
// English, so two runs of the same shot produce the same string.
// ---------------------------------------------------------------------------

const SHOT_SIZE = new Map(Object.entries({
  '大远景': 'extreme wide shot', '远景': 'wide shot', '全景': 'full shot',
  '中全景': 'medium full shot', '中景': 'medium shot', '中近景': 'medium close-up',
  '近景': 'close-up', '特写': 'close-up', '大特写': 'extreme close-up',
  ews: 'extreme wide shot', ws: 'wide shot', fs: 'full shot', ms: 'medium shot',
  mcu: 'medium close-up', cu: 'close-up', ecu: 'extreme close-up',
}))

const CAMERA = new Map(Object.entries({
  '平视': 'eye level', '俯拍': 'high angle', '俯视': 'high angle', '仰拍': 'low angle',
  '仰视': 'low angle', '过肩': 'over-the-shoulder', '主观': 'POV', '正拍': 'frontal',
  '侧拍': 'profile', '鸟瞰': 'bird\'s eye', '荷兰角': 'dutch angle',
}))

const MOVEMENT = new Map(Object.entries({
  '固定': 'static', '静止': 'static', '推': 'slow push in', '推近': 'slow push in',
  '拉': 'pull out', '拉远': 'pull out', '摇': 'pan', '横移': 'lateral track',
  '移': 'tracking', '跟': 'follow', '跟拍': 'follow', '升降': 'crane',
  '手持': 'handheld', '环绕': 'orbit', '变焦': 'zoom',
}))

/**
 * Strip a leading restatement of the shot's own composition from its action text.
 *
 * The board writes "中景侧拍跟拍：陈小满光脚跳下床…" — the prefix duplicates the
 * structured shotSize/camera/movement fields. That is harmless until someone edits
 * one of them, at which point the prompt contradicts itself and the LONGER, more
 * concrete Chinese sentence wins. Measured: an A/B on one shot with only the
 * dropdowns changed produced two near-identical frames, and the requested
 * "extreme close-up / bird's eye" never appeared.
 *
 * Built from the vocabulary tables so it cannot drift from them, and restricted to
 * words of two or more characters because the single-character abbreviations
 * ("推", "移", "拉") are ordinary words that legitimately open a sentence.
 */
const COMPOSITION_WORDS = [...new Set([...SHOT_SIZE.keys(), ...CAMERA.keys(), ...MOVEMENT.keys()])]
  .filter((word) => word.length >= 2)
  // Escaped for the RegExp, built with a function so the replacement string's
  // $& is not re-interpreted as 'the matched text'.
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch))
const COMPOSITION_PREFIX = new RegExp(
  `^\\s*(?:${COMPOSITION_WORDS.join('|')}|[、/·\\s])+\\s*[：:]\\s*`,
)

export function bareAction(action) {
  if (typeof action !== 'string') return ''
  return action.replace(COMPOSITION_PREFIX, '').trim()
}

function normalise(table, value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const key = value.trim()
  if (!key) return fallback
  return table.get(key) ?? table.get(key.toLowerCase()) ?? key
}

export const normaliseShotSize = (v) => normalise(SHOT_SIZE, v)
export const normaliseCamera = (v) => normalise(CAMERA, v)
export const normaliseMovement = (v) => normalise(MOVEMENT, v)

/**
 * Reverse lookup: the English form back to the Chinese vocabulary entry.
 *
 * The maps above run Chinese -> English because the PROMPT wants English. Storage
 * and the UI want the Chinese entry, and the two are not the same: a board written
 * by the model stores "medium close-up", the dropdown offers "中近景", and a
 * <select> whose value matches no option renders blank. The data was never wrong —
 * it was unreadable to the control showing it.
 */
export function toVocab(table, value) {
  if (typeof value !== 'string') return ''
  const key = value.trim()
  if (!key) return ''
  for (const [zh, en] of table) {
    if (en.toLowerCase() === key.toLowerCase()) return zh
  }
  return table.has(key) ? key : key
}

export function reverseVocab(vocab = {}) {
  // Several Chinese keys can share one English value — '跟' and '跟拍' are both
  // "follow", '推' and '推近' are both "slow push in". Only one of each pair is an
  // OFFERED option, and mapping to the other reproduces the very blank select this
  // exists to fix. So the offered list wins when it is known.
  const build = (table, offered = []) => {
    const out = {}
    for (const [zh, en] of table) {
      const preferred = offered.includes(zh)
      if (!(en in out) || preferred) {
        if (preferred || !(out[en] in (offered.length ? offered : [out[en]]))) out[en] = zh
      }
    }
    return out
  }
  const shotSize = build(SHOT_SIZE, vocab.shotSize)
  const camera = build(CAMERA, vocab.camera)
  const movement = build(MOVEMENT, vocab.movement)
  return { shotSize, camera, movement }
}

// ---------------------------------------------------------------------------
// Structural labels (overridable)
// ---------------------------------------------------------------------------

const DEFAULT_LABELS = {
  timeline: 'Timeline:',
  audio: 'Audio:',
  continuity: 'Continuity:',
  negative: 'Avoid:',
  cutRule: 'Hard cuts only, each transition landing on a beat; no dissolves, no push-ins.',
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isNonEmpty = (v) => typeof v === 'string' && v.trim().length > 0

function joinSentence(parts) {
  return parts.filter(isNonEmpty).map((p) => p.trim()).join(' ')
}

function formatSeconds(value) {
  const n = Math.round(Number(value) * 10) / 10
  return Number.isInteger(n) ? `${n}s` : `${n.toFixed(1)}s`
}

/** Stable, human-readable reference used to keep an entity consistent across shots. */
function lockOf(entity) {
  if (!entity) return ''
  if (isNonEmpty(entity.lockToken)) return entity.lockToken.trim()
  const a = entity.appearance ?? {}
  return joinSentence([
    entity.name,
    entity.age ? `${entity.age}` : '',
    a.hair, a.build, a.outfit, a.mark,
  ])
}

function indexById(list) {
  const map = new Map()
  for (const item of Array.isArray(list) ? list : []) {
    if (item && isNonEmpty(item.id)) map.set(item.id, item)
  }
  return map
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/**
 * Group consecutive shots into clips that each fit one H3 render.
 *
 * H3 is trained on roughly 124–362 frames (5–15s). A storyboard longer than that
 * cannot be one render, so shots are packed greedily in order; the caller feeds
 * each clip's last frame back as the next clip's `first_frame` for continuity.
 *
 * The clip length is snapped from the TOTAL requested seconds, never from the
 * sum of per-shot snapped counts. Those differ: 3s + 2s + 4s snaps individually
 * to 73 + 56 + 107 = 236, but 236 is not on the grid, while snapFrames(9) = 226
 * is. The node takes one `length` for the whole clip, so the total is what must
 * satisfy the grid.
 *
 * @param {object[]} shots
 * @param {object} [options]
 * @param {number} [options.maxFrames] override the trained ceiling
 * @returns {{shotIds:string[], frames:number, seconds:number, index:number}[]}
 */
export function groupIntoClips(shots, options = {}) {
  const maxFrames = Math.min(options.maxFrames ?? TRAINED_MAX_FRAMES, LENGTH_MAX)


  const clips = []
  let shotIds = []
  let seconds = 0

  const settle = () => {
    // Clamped, not just snapped. The packing loop only splits when ADDING a shot
    // would exceed the ceiling, so a single shot that is already longer than the
    // ceiling sailed through and produced a 447-frame clip against a trained maximum
    // of 362 — beyond the range the model was trained on.
    const frames = Math.min(maxFrames, snapFrames(seconds))
    clips.push({ shotIds, frames, seconds: framesToSeconds(frames), index: clips.length })
  }

  for (const shot of Array.isArray(shots) ? shots : []) {
    const shotSeconds = Math.max(0, Number(shot?.durationSec) || 0)
    if (shotIds.length > 0 && snapFrames(seconds + shotSeconds) > maxFrames) {
      settle()
      shotIds = []
      seconds = 0
    }
    shotIds.push(shot?.id ?? `shot-${shotIds.length + 1}`)
    seconds += shotSeconds
  }
  if (shotIds.length > 0) settle()
  return clips
}

// ---------------------------------------------------------------------------
// H3 prompt compilation
// ---------------------------------------------------------------------------

function styleLine(project) {
  return joinSentence([
    project?.genre ? `${project.genre} short drama.` : '',
    project?.style ? `${project.style}.` : '',
    project?.logline ? `Story: ${project.logline}` : '',
  ])
}

function locksFor(shots, project) {
  const characters = indexById(project?.characters)
  const scenes = indexById(project?.scenes)
  const usedCharacters = []
  const usedScenes = []
  const seenC = new Set()
  const seenS = new Set()
  for (const shot of shots) {
    for (const id of Array.isArray(shot?.characters) ? shot.characters : []) {
      if (!seenC.has(id)) { seenC.add(id); const c = characters.get(id); if (c) usedCharacters.push(c) }
    }
    if (isNonEmpty(shot?.sceneId) && !seenS.has(shot.sceneId)) {
      seenS.add(shot.sceneId)
      const s = scenes.get(shot.sceneId)
      if (s) usedScenes.push(s)
    }
  }
  return { usedCharacters, usedScenes }
}

function dialogueLine(shot) {
  const lines = Array.isArray(shot?.dialogue) ? shot.dialogue : []
  const spoken = lines
    .filter((l) => isNonEmpty(l?.line))
    .map((l) => (isNonEmpty(l.who) ? `${l.who}: "${l.line.trim()}"` : `"${l.line.trim()}"`))
  if (spoken.length === 0) return ''
  return `Dialogue (spoken in original language): ${spoken.join(' / ')}`
}

function shotSegment(shot, startSec, endSec) {
  const visual = joinSentence([
    normaliseShotSize(shot?.shotSize),
    normaliseCamera(shot?.camera),
    normaliseMovement(shot?.movement),
  ])
  const body = joinSentence([
    // bareAction, not the raw text: the board opens each action by restating its own
      // composition ("中景侧拍跟拍：…"), which contradicts the structured fields the
      // moment anyone edits them — and being longer and more concrete, it wins.
      isNonEmpty(shot?.action) ? bareAction(shot.action) : '',
      // Placed after the action and before the quality tail: it refines the same
      // frame, so it belongs next to what it refines rather than at the end.
      isNonEmpty(shot?.promptNote) ? shot.promptNote.trim() : '',
    dialogueLine(shot),
    isNonEmpty(shot?.notes) ? shot.notes.trim() : '',
  ])
  const head = `[${formatSeconds(startSec)}-${formatSeconds(endSec)}]`
  return joinSentence([`${head} ${visual ? `${visual} —` : ''}`, body])
}

function audioBlock(shots, project) {
  const sfx = []
  for (const shot of shots) {
    if (isNonEmpty(shot?.sfx)) sfx.push(shot.sfx.trim())
  }
  const dialogueCount = shots.reduce(
    (n, s) => n + (Array.isArray(s?.dialogue) ? s.dialogue.filter((l) => isNonEmpty(l?.line)).length : 0),
    0,
  )
  return joinSentence([
    isNonEmpty(project?.audioStyle) ? project.audioStyle.trim() : '',
    dialogueCount > 0 ? `${dialogueCount} line(s) of dialogue as listed above.` : '',
    sfx.length > 0 ? `Sound effects: ${sfx.join('; ')}.` : '',
    'Stereo, natural room tone under the score.',
  ])
}

function negativeBlock(project, labels) {
  const base = [
    'no subtitles', 'no caption bars', 'no watermark', 'no logo', 'no split screen',
    'no soft dissolves', 'no text overlay', 'no distorted faces', 'no extra limbs',
    'no flicker', 'no frame tearing',
  ]
  const extra = Array.isArray(project?.negativeExtra)
    ? project.negativeExtra.filter(isNonEmpty).map((s) => s.trim())
    : []
  return `${labels.negative} ${[...base, ...extra].join(', ')}.`
}

/**
 * Compile one clip's shots into a MiniMax-H3 prompt.
 *
 * The shape follows the official template's own example prompt: a global style
 * line, entity locks, a `Timeline:` block of `[start-end]` segments, a cut rule,
 * a separate `Audio:` block (H3 models audio in the same forward pass), and
 * explicit negatives.
 *
 * @param {object[]} shots one clip's shots, in order
 * @param {object} project project document (style, characters, scenes, ...)
 * @param {object} [options]
 * @param {object} [options.labels] override structural labels
 * @param {boolean} [options.withApiRequest] also build the verified cloud request body
 * @returns {{prompt:string, frames:number, seconds:number, apiRequest:object|null, warnings:string[]}}
 */
export function compileH3Prompt(shots, project, options = {}) {
  const labels = { ...DEFAULT_LABELS, ...(options.labels ?? {}) }
  const list = Array.isArray(shots) ? shots.filter(Boolean) : []
  const warnings = []

  if (list.length === 0) {
    return { prompt: '', frames: 0, seconds: 0, apiRequest: null, warnings: ['no shots supplied'] }
  }

  const { usedCharacters, usedScenes } = locksFor(list, project)

  const segments = []
  let cursor = 0
  for (const shot of list) {
    // The timeline is semantic pacing guidance, so it uses the requested seconds
    // (matching the official template's own `[0s-1s] [1s-2.5s] ...` style) rather
    // than the frame-exact snapped duration. The exact frame count travels
    // separately as `length`, where it actually matters.
    const requested = Math.max(0, Number(shot?.durationSec) || 0)
    segments.push(shotSegment(shot, cursor, cursor + requested))
    cursor += requested
  }

  // The node takes ONE `length` for the whole clip, so the TOTAL is what must
  // land on the grid — not the sum of per-shot snapped counts (see groupIntoClips).
  const requestedSeconds = list.reduce((n, s) => n + Math.max(0, Number(s?.durationSec) || 0), 0)
  const totalFrames = snapFrames(requestedSeconds)
  const totalSeconds = framesToSeconds(totalFrames)

  if (totalFrames < TRAINED_MIN_FRAMES) {
    warnings.push(
      `clip is ${totalFrames} frames (${totalSeconds}s); below the trained floor of ${TRAINED_MIN_FRAMES} frames (~5s) — quality may degrade`,
    )
  }
  if (totalFrames > TRAINED_MAX_FRAMES) {
    warnings.push(
      `clip is ${totalFrames} frames (${totalSeconds}s); above the trained ceiling of ${TRAINED_MAX_FRAMES} frames (~15s) — split it with groupIntoClips()`,
    )
  }

  const blocks = [
    styleLine(project),
    usedCharacters.length > 0
      ? `${labels.continuity} ${usedCharacters.map((c) => `${c.name ?? c.id}: ${lockOf(c)}`).join(' | ')}`
      : '',
    usedScenes.length > 0
      ? usedScenes.map((s) => joinSentence([
        isNonEmpty(s.name) ? `${s.name}:` : '',
        isNonEmpty(s.location) ? s.location : '',
        isNonEmpty(s.timeOfDay) ? s.timeOfDay : '',
        isNonEmpty(s.lighting) ? s.lighting : '',
        isNonEmpty(s.lockToken) ? s.lockToken : '',
      ])).join('\n')
      : '',
    `${labels.timeline}\n${segments.join('\n')}`,
    labels.cutRule,
    `${labels.audio} ${audioBlock(list, project)}`,
    negativeBlock(project, labels),
  ]

  const prompt = blocks.filter(isNonEmpty).join('\n\n')

  let apiRequest = null
  if (options.withApiRequest !== false) {
    const resolution = resolutionFor(project?.ratio ?? '16:9')
    apiRequest = {
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: prompt }],
      resolution: project?.cloudResolution ?? '2K',
      duration: Math.max(1, Math.round(totalSeconds)),
      ratio: project?.ratio ?? '16:9',
    }
    void resolution
  }

  return { prompt, frames: totalFrames, seconds: totalSeconds, apiRequest, warnings }
}

// ---------------------------------------------------------------------------
// Image prompt compilation (reference art and keyframes)
// ---------------------------------------------------------------------------

const IMAGE_NEGATIVE_DEFAULT = [
  'lowres', 'blurry', 'jpeg artifacts', 'extra fingers', 'bad hands',
  'deformed face', 'asymmetric eyes', 'watermark', 'signature', 'text',
  'multiple views', 'collage', 'frame border',
]

/**
 * Extra negatives for scene references only.
 *
 * A scene reference is a location plate. A plate with a person in it is worse than
 * useless: the keyframe stage feeds it in as a reference image, so an invented
 * stranger is carried into every frame of that scene as a second character — which
 * is exactly the report that the people in the scene art had nothing to do with the
 * cast.
 *
 * "no people" in the POSITIVE prompt does not achieve this. A diffusion model reads
 * a negation in the prompt as one more phrase to render, so asking for "empty
 * location, no people" still produces an empty-looking room with someone standing in
 * it. Exclusion belongs in the negative, which is the channel that actually
 * subtracts.
 */
const SCENE_NEGATIVE_EXTRA = [
  'person', 'people', 'human', 'figure', 'silhouette', 'crowd',
  'man', 'woman', 'child', 'boy', 'girl', 'teenager',
  'face', 'portrait', 'hands', 'arms', 'legs', 'body',
]

/**
 * Prompt for a character or scene reference image.
 *
 * @param {object} entity character or scene document
 * @param {'character'|'scene'} kind
 * @param {object} project
 * @returns {{positive:string, negative:string, params:object}}
 */
export function compileImagePrompt(entity, kind, project, options = {}) {
  // 'turnaround' (default) or 'hero'; ignored for scenes.
  const view = options.view === 'hero' ? 'hero' : 'turnaround'
  const style = isNonEmpty(project?.style) ? `${project.style}.` : ''
  const quality = isNonEmpty(project?.imageQuality)
    ? project.imageQuality
    : 'cinematic still, sharp focus, natural skin texture, film grain'

  let positive
  let size
  if (kind === 'character') {
    const a = entity?.appearance ?? {}
    const who = `${entity?.name ?? 'the character'}${entity?.age ? ` age ${entity.age}` : ''}${isNonEmpty(entity?.role) ? ` (${entity.role})` : ''}`
    const looks = joinSentence([a.hair, a.build, a.outfit, a.mark, isNonEmpty(entity?.persona) ? entity.persona : ''])

    // Two views, because they answer two different questions.
    //
    // The TURNAROUND is what stops a character deforming: the video model needs to
    // know the whole silhouette, not just a face, and a front/side/back sheet is
    // the standard way to state it. Its cost is that each figure is small, so it
    // is rendered wide and given more pixels than a single portrait needs.
    //
    // The HERO shot exists so the turnaround never becomes an image-to-image
    // source: feeding a three-panel sheet through img2img at partial denoise
    // leaks panel borders and repeated figures into the keyframe.
    if (view === 'hero') {
      positive = joinSentence([
        `Full-body character reference photograph of ${who}`,
        looks,
        'entire figure visible head to toe, standing straight, arms relaxed at the sides',
        'facing the camera directly, neutral expression, even soft lighting',
        'plain seamless neutral grey studio background, nothing else in frame',
        'single person only, no panels, no text, no borders',
        style ? `overall look: ${style}` : '',
        quality,
      ])
      size = resolutionForMegapixels(project?.refRatio ?? '3:4', REFERENCE_MEGAPIXELS)
    } else {
      positive = joinSentence([
        `Character model sheet of ${who}: three full-body views side by side`,
        looks,
        'left panel: front view facing the camera; centre panel: side profile facing left; right panel: back view',
        'full figure head to toe in every panel, identical proportions, identical clothing and hair in all three',
        'consistent scale across panels, evenly spaced, standing straight with arms relaxed',
        'plain seamless neutral grey studio background, even soft lighting, no shadows on the backdrop',
        'clean character turnaround reference, no text, no labels, no watermark',
        style ? `overall look: ${style}` : '',
        quality,
      ])
      // Three figures need roughly three times the pixels to hold the same facial
      // detail a single portrait gets, so this view is budgeted higher on purpose.
      // The sheet is landscape because three figures sit side by side, but it now takes
      // the SAME megapixel budget as everything else. It used to be multiplied by 1.5,
      // so setting 2 MP silently produced 3 MP — a 22% cost the operator could neither
      // see nor turn off. Want it sharper? Raise the budget. The choice is visible now
      // instead of baked in.
      size = resolutionForMegapixels('4:3', REFERENCE_MEGAPIXELS)
    }
  } else {
    positive = joinSentence([
      isNonEmpty(entity?.name) ? `${entity.name}:` : '',
      entity?.location, entity?.timeOfDay, entity?.lighting,
      isNonEmpty(entity?.atmosphere) ? entity.atmosphere : '',
      isNonEmpty(entity?.lockToken) ? entity.lockToken : '',
      'establishing shot, no people, empty location',
      style,
      quality,
    ])
  }

  const negative = [
    ...IMAGE_NEGATIVE_DEFAULT,
    // Characters are excluded from plates but not from portraits, where a person is
    // the entire point.
    ...(kind === 'character' ? [] : SCENE_NEGATIVE_EXTRA),
    ...(Array.isArray(project?.imageNegativeExtra) ? project.imageNegativeExtra : []),
  ].join(', ')

  // Scene reference art, and the fallback for anything else that reached this far.
  //
  // The RATIO follows the project; the RESOLUTION does not.
  //
  // A scene plate is the closest thing the pipeline has to a preview of the finished
  // frame, so a 21:9 project wants a 21:9 room — seeing the framing while choosing a
  // scene is worth more than the round numbers of a 3:4 plate. The megapixel budget
  // stays fixed for the same reason as the character references: a speed setting must
  // not degrade the material the keyframes are generated FROM.
  if (!size) {
    size = resolutionForMegapixels(project?.ratio ?? '9:16', REFERENCE_MEGAPIXELS)
  }

  return {
    positive,
    negative,
    params: { ...size, seed: Number.isInteger(entity?.refSeed) ? entity.refSeed : null },
  }
}

/**
 * Prompt for one shot's keyframe image, biased toward image-to-image so the
 * character reference actually constrains the face.
 *
 * @param {object} shot
 * @param {object} project
 * @returns {{positive:string, negative:string, params:object, warnings:string[]}}
 */
export function compileKeyframePrompt(shot, project) {
  const warnings = []
  const characters = indexById(project?.characters)
  const scenes = indexById(project?.scenes)
  const cast = (Array.isArray(shot?.characters) ? shot.characters : [])
    .map((id) => characters.get(id))
    .filter(Boolean)
  if (cast.length === 0) warnings.push('shot names no character; the keyframe will not be identity-locked')

  const scene = isNonEmpty(shot?.sceneId) ? scenes.get(shot.sceneId) : undefined

  const positive = joinSentence([
    isNonEmpty(project?.style) ? `${project.style}.` : '',
    scene ? joinSentence([scene.name, scene.location, scene.timeOfDay, scene.lighting]) : '',
    cast.length > 0 ? `Characters present: ${cast.map((c) => lockOf(c)).join(' | ')}` : '',
    normaliseShotSize(shot?.shotSize),
    normaliseCamera(shot?.camera),
    // bareAction, not the raw text: the board opens each action by restating its own
      // composition ("中景侧拍跟拍：…"), which contradicts the structured fields the
      // moment anyone edits them — and being longer and more concrete, it wins.
      isNonEmpty(shot?.action) ? bareAction(shot.action) : '',
      // The operator's own direction: lighting, lens, blocking, mood. Placed after
      // the action and before the quality tail, next to what it refines.
      isNonEmpty(shot?.promptNote) ? shot.promptNote.trim() : '',
    isNonEmpty(project?.imageQuality) ? project.imageQuality : 'cinematic still, sharp focus, film grain',
  ])

  const negative = [...IMAGE_NEGATIVE_DEFAULT, ...(Array.isArray(project?.imageNegativeExtra) ? project.imageNegativeExtra : [])].join(', ')

  return {
    positive,
    negative,
    params: {
      // A keyframe is an image, so it sizes by megapixels rather than by H3's
      // video canvas. H3 downscales whatever it receives as `first_frame`.
      ...resolutionForMegapixels(project?.ratio ?? '9:16', project?.imageMegapixels ?? 2),
      seed: Number.isInteger(shot?.seed) ? shot.seed : null,
    },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Storyboard lint
// ---------------------------------------------------------------------------

/**
 * Non-fatal quality checks surfaced in the UI. Returns [] for a clean board.
 *
 * @param {object[]} shots
 * @param {object} project
 * @returns {{shotId:string, level:'error'|'warn', message:string}[]}
 */
export function lintStoryboard(shots, project) {
  const issues = []
  const list = Array.isArray(shots) ? shots.filter(Boolean) : []
  const characters = indexById(project?.characters)
  const scenes = indexById(project?.scenes)

  if (list.length === 0) return [{ shotId: '', level: 'warn', message: 'storyboard is empty' }]

  list.forEach((shot, i) => {
    const id = shot.id ?? `#${i + 1}`
    if (!isNonEmpty(shot.action)) issues.push({ shotId: id, level: 'error', message: 'missing action' })
    if (!isNonEmpty(shot.shotSize)) issues.push({ shotId: id, level: 'warn', message: 'missing shot size' })
    if (isNonEmpty(shot.sceneId) && !scenes.has(shot.sceneId)) {
      issues.push({ shotId: id, level: 'error', message: `unknown sceneId "${shot.sceneId}"` })
    }
    for (const cid of Array.isArray(shot.characters) ? shot.characters : []) {
      if (!characters.has(cid)) issues.push({ shotId: id, level: 'error', message: `unknown character id "${cid}"` })
    }
    const sec = Number(shot.durationSec)
    if (!Number.isFinite(sec) || sec <= 0) {
      issues.push({ shotId: id, level: 'error', message: 'durationSec must be a positive number' })
    } else if (sec > 15) {
      issues.push({ shotId: id, level: 'warn', message: `${sec}s exceeds H3's ~15s trained ceiling` })
    }
  })

  const clips = groupIntoClips(list)
  if (clips.length > 1) {
    issues.push({
      shotId: '',
      level: 'warn',
      message: `board spans ${clips.length} H3 clips (${clips.map((c) => `${c.frames}f`).join(' + ')}); render in order and feed each last frame back as the next first_frame`,
    })
  }
  return issues
}

export default {
  FPS, FRAME_GRID_STEP, FRAME_GRID_OFFSET, TRAINED_MIN_FRAMES, TRAINED_MAX_FRAMES, LENGTH_MIN, LENGTH_MAX,
  RATIOS, LONG_EDGE_MAX, SHORT_EDGE_NATIVE,
  snapFrames, framesToSeconds, resolutionFor, resolutionForMegapixels, scriptFingerprint,
  RESOLUTION_TIERS, tierForMegapixels, RATIOS, REFERENCE_MEGAPIXELS,
  normaliseShotSize, normaliseCamera, normaliseMovement,
  groupIntoClips, compileH3Prompt, compileImagePrompt, compileKeyframePrompt, lintStoryboard,
  threeViewSentence, compileThreeViewPrompt,
}
