/**
 * Stage 1 — script.
 *
 * Turns a one-line brief into a structured script document. The model authors
 * content; this module owns the shape and the id hygiene.
 */
import { generateJson } from './llmgen.js'
import { SCRIPT_SPEC, scriptSystem, scriptUser } from '../prompts.js'

const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback)

/**
 * Re-key beats and scenes to a guaranteed-stable b1../s1.. sequence and repair
 * dangling beatId references. Models occasionally reuse or skip an id, and every
 * later stage keys off these.
 */
function rekey(script) {
  const beats = (Array.isArray(script.beats) ? script.beats : []).map((beat, index) => ({
    id: `b${index + 1}`,
    summary: str(beat?.summary, `Beat ${index + 1}`),
    emotion: str(beat?.emotion),
  }))
  const originalBeatIds = (Array.isArray(script.beats) ? script.beats : []).map((b) => str(b?.id))
  const byOriginal = new Map(originalBeatIds.map((id, index) => [id, beats[index]?.id]))

  const scenes = (Array.isArray(script.scenes) ? script.scenes : []).map((scene, index) => {
    const original = str(scene?.beatId)
    const beatId = byOriginal.get(original) ?? beats[Math.min(index, beats.length - 1)]?.id ?? 'b1'
    return {
      id: `s${index + 1}`,
      beatId,
      slug: str(scene?.slug, `场次 ${index + 1}`),
      dialogue: (Array.isArray(scene?.dialogue) ? scene.dialogue : [])
        .map((line) => ({ who: str(line?.who), line: str(line?.line) }))
        .filter((line) => line.line),
    }
  })
  return { beats, scenes }
}

/**
 * @param {object} deps { llm, provider, model }
 * @param {object} request { project, brief, instruction, reviseFrom, targetSec }
 */
export async function runScriptStage(deps, request) {
  const { value, attempts, usage } = await generateJson({
    llm: deps.llm,
    provider: deps.provider,
    model: deps.model,
    system: scriptSystem(),
    user: scriptUser(request.project, request.brief, {
      targetSec: request.targetSec,
      instruction: request.instruction,
      reviseFrom: request.reviseFrom,
    }),
    spec: SCRIPT_SPEC,
    temperature: 0.85,
    maxTokens: 8000,
    signal: request.signal,
    onProgress: request.onProgress,
  })

  const { beats, scenes } = rekey(value)
  const script = {
    synopsis: str(value.synopsis),
    beats,
    scenes,
  }

  return {
    attempts,
    usage,
    script,
    meta: {
      title: str(value.title),
      logline: str(value.logline),
      genre: str(value.genre),
      style: str(value.style),
      audioStyle: str(value.audioStyle),
    },
  }
}

export default { runScriptStage }
