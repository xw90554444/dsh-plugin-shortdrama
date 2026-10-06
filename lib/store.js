/**
 * Project store: one JSON document per drama project.
 *
 * Files on disk rather than a database, because the whole artifact — script,
 * cast, shots, compiled prompts — is meant to be diffable, hand-editable, and
 * exportable as a production package.
 */
import { readFile, writeFile, mkdir, rename, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { projectsDir } from './config.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidProjectId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

/** @param {string} id */
export function projectPath(id) {
  return join(projectsDir(), `${id}.json`)
}

const isNonEmpty = (v) => typeof v === 'string' && v.trim().length > 0
const str = (v, fallback = '') => (isNonEmpty(v) ? v.trim() : fallback)
const num = (v, fallback = null) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/**
 * Build a filesystem- and URL-safe id stem.
 *
 * Ids become file names and URL path segments, so they stay ASCII even when the
 * title is not. A title with no ASCII left (Chinese, Japanese, ...) gets a stable
 * short hash instead of collapsing onto a shared fallback, which would make
 * every such project collide on the same id.
 */
export function slugify(input, fallback = 'project') {
  const raw = String(input ?? '').trim()
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  if (slug) return slug
  // djb2 over the original text: stable across runs, distinct per title.
  let hash = 5381
  for (let i = 0; i < raw.length; i += 1) hash = (((hash << 5) + hash) + raw.charCodeAt(i)) >>> 0
  return `${fallback}-${hash.toString(36).padStart(6, '0').slice(0, 6)}`
}

export function newProjectId(title) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${slugify(title)}-${stamp}`
}

/** Coerce an entity (character or scene) into the shape the compiler expects. */
function normaliseEntity(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    id: str(source.id, `e${index + 1}`),
    name: str(source.name, `Entity ${index + 1}`),
    role: str(source.role),
    age: source.age === undefined || source.age === null ? '' : String(source.age),
    persona: str(source.persona),
    location: str(source.location),
    timeOfDay: str(source.timeOfDay),
    lighting: str(source.lighting),
    atmosphere: str(source.atmosphere),
    appearance: {
      hair: str(source.appearance?.hair),
      build: str(source.appearance?.build),
      outfit: str(source.appearance?.outfit),
      mark: str(source.appearance?.mark),
    },
    lockToken: str(source.lockToken),
    refAssetId: str(source.refAssetId) || null,
      // A single full-body shot, used as the image-to-image source. Kept apart
      // from the turnaround sheet so panel borders cannot leak into a keyframe.
      heroAssetId: str(source.heroAssetId) || null,
    refSeed: num(source.refSeed),
  }
}

/** Coerce a shot into the shape the compiler expects. */
function normaliseShot(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const dialogue = Array.isArray(source.dialogue)
    ? source.dialogue
      .filter((line) => line && typeof line === 'object')
      .map((line) => ({ who: str(line.who), line: str(line.line) }))
      .filter((line) => line.line)
    : []
  return {
    id: str(source.id, `sh${index + 1}`),
    no: Number.isInteger(source.no) ? source.no : index + 1,
    sceneId: str(source.sceneId) || null,
    durationSec: num(source.durationSec, 3),
    shotSize: str(source.shotSize),
    camera: str(source.camera),
    movement: str(source.movement),
    action: str(source.action),
    // The operator's own direction for THIS frame — lighting, lens, blocking, mood.
    // The action says what happens; this says how it should look, which is the
    // difference between a staged snapshot and a film frame.
    promptNote: str(source.promptNote),
    dialogue,
    sfx: str(source.sfx),
    notes: str(source.notes),
    characters: Array.isArray(source.characters) ? source.characters.filter(isNonEmpty).map((s) => String(s).trim()) : [],
    promptComfy: str(source.promptComfy),
    promptH3: str(source.promptH3),
    negative: str(source.negative),
    keyframeAssetId: str(source.keyframeAssetId) || null,
    videoAssetId: str(source.videoAssetId) || null,
    seed: num(source.seed),
    status: str(source.status, 'draft'),
  }
}

/**
 * Running consumption totals, kept on the project document.
 *
 * Deliberately NOT in memory: a consumption figure that resets whenever DSH
 * restarts cannot answer "what has this film cost so far", which is the only
 * question worth asking of it. Every field is coerced because this object is
 * written from run results, and a provider that omits a counter must not turn the
 * whole tally into NaN.
 */
function normaliseUsage(source) {
  const s = source && typeof source === 'object' ? source : {}
  const llm = s.llm && typeof s.llm === 'object' ? s.llm : {}
  const render = s.render && typeof s.render === 'object' ? s.render : {}

  const byStage = {}
  for (const [key, value] of Object.entries(llm.byStage ?? {})) {
    if (!value || typeof value !== 'object') continue
    byStage[key] = {
      inputTokens: num(value.inputTokens),
      outputTokens: num(value.outputTokens),
      calls: num(value.calls),
    }
  }
  const byKind = {}
  for (const [key, value] of Object.entries(render.byKind ?? {})) {
    if (!value || typeof value !== 'object') continue
    byKind[key] = { count: num(value.count), ms: num(value.ms) }
  }

  return {
    llm: {
      inputTokens: num(llm.inputTokens),
      outputTokens: num(llm.outputTokens),
      totalTokens: num(llm.totalTokens),
      calls: num(llm.calls),
      byStage,
      updatedAt: str(llm.updatedAt),
    },
    render: {
      images: num(render.images),
      videos: num(render.videos),
      totalMs: num(render.totalMs),
      byKind,
      updatedAt: str(render.updatedAt),
    },
  }
}

/** Fill in every field the pipeline reads, so downstream code needs no null checks. */
export function normaliseProject(raw, idHint) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const title = str(source.title, 'Untitled drama')
  const id = str(source.id, idHint ?? newProjectId(title))
  return {
    id,
    title,
    logline: str(source.logline),
    genre: str(source.genre),
    /**
     * Image output budget, in megapixels. Stored on the project rather than read from
     * config at compile time: the two compilers that size an image read
     * `project.imageMegapixels` directly, and the config value was passed as a SIBLING
     * of the project copy and never reached them — invisible while both were 2.
     */
    imageMegapixels: num(source.imageMegapixels, 2),
    ratio: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', '9:21', '3:2', '2:3'].includes(source.ratio) ? source.ratio : '9:16',
    /**
     * Clip length for this project, in seconds.
     *
     * Persisted because it decides the CLIP SPLIT, and the clip split is what the storyboard was
     * written against: the renderer groups shots into clips of this length, and the board's shot
     * durations were packed to fill exactly that window. It used to live only in a component's
     * local state plus a config value, so the "单次出片时长" dropdown changed a number that never
     * reached the renderer, and a board written for 15s clips was cut into 10s clips.
     *
     * 0 means "not chosen yet — use the configured default", which is why it is a number rather
     * than null: `Number(null)` is 0, and a silent zero would be read as a real (empty) clip.
     */
    clipSeconds: num(source.clipSeconds, 0),
    style: str(source.style, 'cinematic realism, natural lighting'),
    imageQuality: str(source.imageQuality),
    imageNegativeExtra: Array.isArray(source.imageNegativeExtra) ? source.imageNegativeExtra.filter(isNonEmpty) : [],
    negativeExtra: Array.isArray(source.negativeExtra) ? source.negativeExtra.filter(isNonEmpty) : [],
    audioStyle: str(source.audioStyle),
    targetTotalSec: num(source.targetTotalSec),
    refRatio: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'].includes(source.refRatio) ? source.refRatio : '3:4',
    cloudResolution: str(source.cloudResolution, '2K'),
    script: source.script && typeof source.script === 'object' ? source.script : null,
    characters: (Array.isArray(source.characters) ? source.characters : []).map(normaliseEntity),
    scenes: (Array.isArray(source.scenes) ? source.scenes : []).map(normaliseEntity),
    shots: (Array.isArray(source.shots) ? source.shots : []).map(normaliseShot),
    assets: source.assets && typeof source.assets === 'object' ? source.assets : {},
    usage: normaliseUsage(source.usage),
    // Which script the current board came from; '' means it predates this field.
    shotsFromScript: str(source.shotsFromScript),
    createdAt: str(source.createdAt, new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  }
}

async function ensureDirs() {
  await mkdir(projectsDir(), { recursive: true })
}

/** @returns {Promise<object[]>} every stored project, newest first */
export async function listProjects() {
  await ensureDirs()
  let names = []
  try {
    names = (await readdir(projectsDir())).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const projects = []
  for (const name of names) {
    try {
      const text = await readFile(join(projectsDir(), name), 'utf8')
      const project = normaliseProject(JSON.parse(text), name.replace(/\.json$/, ''))
      projects.push(project)
    } catch { /* a corrupt project file must not hide the others */ }
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** Compact rows for list views. */
export async function listProjectSummaries() {
  const projects = await listProjects()
  return projects.map((p) => ({
    id: p.id,
    title: p.title,
    genre: p.genre,
    ratio: p.ratio,
    sceneCount: p.scenes.length,
    characterCount: p.characters.length,
    shotCount: p.shots.length,
    totalSec: Math.round(p.shots.reduce((n, s) => n + (Number(s.durationSec) || 0), 0) * 10) / 10,
    updatedAt: p.updatedAt,
  }))
}

/** @param {string} id @returns {Promise<object|null>} */
export async function getProject(id) {
  if (!isValidProjectId(id)) return null
  try {
    const text = await readFile(projectPath(id), 'utf8')
    return normaliseProject(JSON.parse(text), id)
  } catch {
    return null
  }
}

export async function saveProject(project) {
  await ensureDirs()
  const normalised = normaliseProject(project, project?.id)
  const target = projectPath(normalised.id)
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return normalised
}

export async function createProject(input = {}, options = {}) {
  const title = str(input.title, 'Untitled drama')
  let id = str(input.id, options.id ?? newProjectId(title))
  if (!isValidProjectId(id)) id = newProjectId(title)
  // Never silently clobber an existing project.
  if (!options.overwrite && (await getProject(id))) {
    let n = 2
    while (await getProject(`${id}-${n}`)) n += 1
    id = `${id}-${n}`
  }
  return saveProject({ ...input, id, createdAt: new Date().toISOString() })
}

/**
 * Merge a patch into a stored project.
 * Arrays are replaced wholesale — merging shot lists element-wise would silently
 * resurrect shots the caller meant to delete.
 */
export async function updateProject(id, patch = {}) {
  const current = await getProject(id)
  if (!current) return null
  const merged = { ...current, ...patch, id: current.id }
  return saveProject(merged)
}

export async function removeProject(id) {
  if (!isValidProjectId(id)) return false
  try {
    await stat(projectPath(id))
  } catch {
    return false
  }
  await rm(projectPath(id), { force: true })
  return true
}

export default {
  isValidProjectId, projectPath, normaliseProject, listProjects, listProjectSummaries,
  getProject, saveProject, createProject, updateProject, removeProject, slugify, newProjectId,
}
