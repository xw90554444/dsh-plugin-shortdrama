/**
 * Stage 2 — cast and locations.
 *
 * Produces the visual bible: one record per recurring character and per location,
 * each carrying a `lockToken` that later stages splice verbatim into every image
 * and video prompt. That token is the plugin's main defence against a character
 * changing face between shots.
 */
import { generateJson, LlmGenError } from './llmgen.js'
import { CAST_SPEC, castSystem, castUser } from '../prompts.js'

const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback)

/**
 * A lockToken that leaks transient state defeats its own purpose: if it mentions
 * a smile or a camera angle, two shots built from it will not match. Detect the
 * common leaks and rebuild a safe token from the immutable appearance fields.
 */
const TRANSIENT = /\b(smiling|laughing|crying|angry|sad|shouting|running|walking|looking|facing|close-?up|wide shot|medium shot|camera|angle|pov|portrait|profile|expression)\b/i

export function sanitiseLockToken(token, entity, kind) {
  const value = str(token)
  if (value && !TRANSIENT.test(value)) return value
  if (kind === 'character') {
    const a = entity?.appearance ?? {}
    const rebuilt = [
      str(entity?.name),
      str(entity?.age),
      str(a.hair),
      str(a.build),
      str(a.outfit),
      str(a.mark),
    ].filter(Boolean).join(', ')
    return rebuilt || str(entity?.name, 'character')
  }
  return [str(entity?.location), str(entity?.timeOfDay), str(entity?.lighting)]
    .filter(Boolean).join(', ') || str(entity?.name, 'location')
}

/**
 * @param {object} deps { llm, provider, model }
 * @param {object} request { project }
 */
export async function runCastStage(deps, request) {
  const project = request.project
  if (!project?.script) {
    throw new LlmGenError('the project has no script yet; run the script stage first', { code: 'no-script' })
  }

  const { value, attempts, usage } = await generateJson({
    llm: deps.llm,
    provider: deps.provider,
    model: deps.model,
    system: castSystem(),
    user: castUser(project),
    spec: CAST_SPEC,
    temperature: 0.6,
    maxTokens: 6000,
    signal: request.signal,
    onProgress: request.onProgress,
  })

  const characters = (value.characters ?? []).map((raw, index) => {
    const entity = {
      id: `c${index + 1}`,
      name: str(raw?.name, `角色${index + 1}`),
      role: str(raw?.role),
      age: str(raw?.age),
      persona: str(raw?.persona),
      appearance: {
        hair: str(raw?.appearance?.hair),
        build: str(raw?.appearance?.build),
        outfit: str(raw?.appearance?.outfit),
        mark: str(raw?.appearance?.mark),
      },
    }
    entity.lockToken = sanitiseLockToken(raw?.lockToken, entity, 'character')
    entity.refSeed = null
    entity.refAssetId = null
    return entity
  })

  const scenes = (value.scenes ?? []).map((raw, index) => {
    const entity = {
      id: `sc${index + 1}`,
      name: str(raw?.name, `场景${index + 1}`),
      location: str(raw?.location),
      timeOfDay: str(raw?.timeOfDay),
      lighting: str(raw?.lighting),
      atmosphere: str(raw?.atmosphere),
    }
    entity.lockToken = sanitiseLockToken(raw?.lockToken, entity, 'scene')
    entity.refSeed = null
    entity.refAssetId = null
    return entity
  })

  return { attempts, usage, characters, scenes }
}

export default { runCastStage, sanitiseLockToken }
