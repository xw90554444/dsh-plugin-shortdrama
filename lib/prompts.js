/**
 * Prompts and shape specs for the three LLM stages.
 *
 * Two rules shape everything here:
 *
 * 1. The model fills FIELDS; the compiler owns FORMAT. Every controlled field is
 *    given as an explicit closed vocabulary so the compiler's normalisation is a
 *    no-op and two runs of the same brief compile identically.
 * 2. Constraints the renderer will enforce are stated as constraints the model
 *    must satisfy, not as advice. Durations, the 17k+5 grid, and the reference-id
 *    rules are all encoded, so a first-pass board is usually renderable as-is.
 */
import { clampClipSeconds, CLIP_SECONDS_DEFAULT } from './pipeline/compile.js'

/** Closed vocabularies. These must stay in sync with the maps in compile.js. */export const VOCAB = {
  shotSize: ['大远景', '远景', '全景', '中全景', '中景', '中近景', '近景', '特写', '大特写'],
  camera: ['平视', '俯拍', '仰拍', '过肩', '主观', '正拍', '侧拍', '鸟瞰', '荷兰角'],
  movement: ['固定', '推近', '拉远', '摇', '横移', '跟拍', '升降', '手持', '环绕', '变焦'],
}

const vocabLine = (label, values) => `${label}（只能从这个列表里选）：${values.join(' | ')}`

/**
 * Renderer constraints shared by the storyboard prompt and the retry feedback.
 * Kept as data so the prompt and the code cannot disagree.
 */
export const RENDER_CONSTRAINTS = {
  fps: 24,
  minShotSec: 1.5,
  maxShotSec: 6,
  clipMinSec: 5,
  clipMaxSec: 15,
}

export const RENDER_RULES = [
  `每个镜头的 durationSec 必须在 ${RENDER_CONSTRAINTS.minShotSec}–${RENDER_CONSTRAINTS.maxShotSec} 秒之间。`,
  `成片按 ${RENDER_CONSTRAINTS.fps}fps 渲染，单次渲染 5–15 秒；总时长超过 15 秒会被自动切成多段，段与段之间靠首尾帧衔接，所以相邻镜头要能接得上。`,
  'sceneId 必须来自已给出的场景 id 列表；characters 数组里的每个 id 必须来自已给出的角色 id 列表。不要在镜头里凭空创造新角色或新场景。',
  'action 写这一个镜头里真正看得见的动作与画面，不要写"然后""接着"这类跨镜头叙述。',
  'dialogue 只写这个镜头里说出口的台词，保留中文原文；没有台词就留空数组。',
  'sfx 写这个镜头里出现的声音（环境音、音效、配乐变化），没有就留空字符串。',
]

const JSON_ONLY = '只输出一个 JSON 对象，不要输出任何解释文字，不要用 ``` 代码块包裹。'

// ---------------------------------------------------------------------------
// Stage 1 — script
// ---------------------------------------------------------------------------

export const SCRIPT_SPEC = {
  type: 'object',
  required: ['title', 'logline', 'genre', 'style', 'audioStyle', 'synopsis', 'beats', 'scenes'],
  properties: {
    title: { type: 'string', minLength: 1 },
    logline: { type: 'string', minLength: 1 },
    genre: { type: 'string', minLength: 1 },
    style: { type: 'string', minLength: 1 },
    audioStyle: { type: 'string' },
    synopsis: { type: 'string', minLength: 1 },
    beats: {
      type: 'array',
      minItems: 2,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['id', 'summary', 'emotion'],
        properties: {
          id: { type: 'string', minLength: 1 },
          summary: { type: 'string', minLength: 1 },
          emotion: { type: 'string' },
        },
      },
    },
    scenes: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        required: ['id', 'beatId', 'slug', 'dialogue'],
        properties: {
          id: { type: 'string', minLength: 1 },
          beatId: { type: 'string', minLength: 1 },
          slug: { type: 'string', minLength: 1 },
          dialogue: {
            type: 'array',
            items: {
              type: 'object',
              required: ['who', 'line'],
              properties: {
                who: { type: 'string', minLength: 1 },
                line: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
}

export function scriptSystem() {
  return [
    '你是一位影视编剧，能把一句创作要求发展成可以直接开拍的剧本。',
    '',
    '写作原则：',
    '· 忠于创作要求。它说是什么就是什么——不要把它改造成另一种类型，',
    '  不要添加它没有要求的冲突、反转、秘密或额外人物。',
    '· 允许安静。不是每一场都需要钩子或反转；情绪、氛围、一个动作的细节，',
    '  本身就可以是一场戏的内容。',
    '· 具体胜过激烈。「她第三次看表」比「她感到一阵莫名的不安」更有力量。',
    '· 对白像人会说的话。不要用对白交代设定，也不要让每个人都在推进剧情。',
    '· 如果创作要求是一支 MV、一段氛围、一个画面，就照那个写，不要硬塞一个故事。',
    RENDER_RULES[1],
    JSON_ONLY,
  ].join('\n')
}

/**
 * @param {object} project
 * @param {string} brief free-form creative direction
 * @param {object} [options]
 */
export function scriptUser(project, brief, options = {}) {
  const targetSec = Number(options.targetSec ?? project?.targetTotalSec ?? 60)
  const sceneCount = Math.max(2, Math.min(12, Math.round(targetSec / 12)))
  const lines = [
    '创作要求：',
    brief?.trim() || project?.logline?.trim() || '（未提供。请构思一个适合竖屏的情绪片段，靠画面和氛围推进，不要依赖反转或悬念）',
    '',
    `目标成片时长约 ${targetSec} 秒，画面比例 ${project?.ratio ?? '9:16'}。`,
    `请拆成 ${Math.max(2, sceneCount - 1)}–${sceneCount + 1} 场戏。`,
  ]
  if (project?.genre) lines.push(`题材：${project.genre}`)
  // An existing style is a CONSTRAINT, not a hint. It is either a preset the
  // operator picked or a line they wrote, and every downstream stage — keyframes,
  // video, frame prompts — inherits it. Asking the model to invent one as well
  // produced a second style that silently replaced the first.
  if (project?.style) {
    lines.push(
      '',
      '【画面风格 · 必须严格遵守】',
      project.style,
      '剧本、场景描述和画面提示词都要能用这个风格拍出来。不要提出其它风格，不要改写它。',
    )
  }
  if (options.instruction) lines.push('', '修改要求：', options.instruction)
  if (options.reviseFrom) {
    lines.push(
      '',
      '这是需要修改的既有剧本：',
      '```json',
      JSON.stringify(options.reviseFrom, null, 2).slice(0, 20000),
      '```',
      '请在保留可用部分的前提下按修改要求重写，输出完整的剧本对象。',
    )
  }
  lines.push(
    '',
    '输出字段：',
    '- title: 剧名，4–10 字',
    '- logline: 一句话故事钩子',
    '- genre: 题材标签',
    project?.style
      ? '- style: 原样照抄上面【画面风格】那一行，一个字都不要改'
      : '- style: 画面风格，用英文写，供出图模型使用（例如 cinematic realism, neon night, shallow depth of field）',
    '- audioStyle: 配乐与声音基调，英文',
    '- synopsis: 200 字以内的故事梗概',
    '- beats: 情节点数组，每项 {id, summary, emotion}，id 用 b1/b2/...',
    '- scenes: 场次数组，每项 {id, beatId, slug, dialogue}，id 用 s1/s2/...，slug 是"地点·时间"式短标题，dialogue 是 [{who, line}]',
    '',
    JSON_ONLY,
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Stage 2 — cast and locations
// ---------------------------------------------------------------------------

export const CAST_SPEC = {
  type: 'object',
  required: ['characters', 'scenes'],
  properties: {
    characters: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        required: ['id', 'name', 'role', 'age', 'appearance', 'lockToken'],
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          role: { type: 'string' },
          age: { type: 'string' },
          persona: { type: 'string' },
          appearance: {
            type: 'object',
            required: ['hair', 'build', 'outfit', 'mark'],
            properties: {
              hair: { type: 'string' },
              build: { type: 'string' },
              outfit: { type: 'string' },
              mark: { type: 'string' },
            },
          },
          lockToken: { type: 'string', minLength: 1 },
        },
      },
    },
    scenes: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['id', 'name', 'location', 'timeOfDay', 'lighting', 'lockToken'],
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          location: { type: 'string', minLength: 1 },
          timeOfDay: { type: 'string' },
          lighting: { type: 'string' },
          atmosphere: { type: 'string' },
          lockToken: { type: 'string', minLength: 1 },
        },
      },
    },
  },
}

export function castSystem() {
  return [
    '你是短剧的美术指导，负责把剧本里的人物和场景变成可复现的视觉设定。',
    '最关键的产出是 lockToken：一段固定不变的英文描述，之后每一张图、每一个镜头都会原样拼接它，用来让同一个角色在不同镜头里保持同一张脸、同一身衣服。',
    '所以 lockToken 必须只描述**不变**的特征（年龄段、发型发色、体型、固定服装、标志物），绝不能写表情、动作、情绪、镜头角度或光线——那些每个镜头都在变。',
    JSON_ONLY,
  ].join('\n')
}

/** @param {object} project */
export function castUser(project) {
  return [
    '这是剧本：',
    '```json',
    JSON.stringify({
      title: project?.title,
      logline: project?.logline,
      genre: project?.genre,
      style: project?.style,
      synopsis: project?.script?.synopsis,
      beats: project?.script?.beats,
      scenes: project?.script?.scenes,
    }, null, 2).slice(0, 24000),
    '```',
    '',
    '请抽取人物与场景设定，输出字段：',
    '- characters: 数组，每项 {id, name, role, age, persona, appearance{hair, build, outfit, mark}, lockToken}',
    '  · id 用 c1/c2/...；name 保留剧本里的中文名',
    '  · appearance 的四个字段用英文写，具体到能画出来（例如 hair: "shoulder-length black hair, side part"）',
    '  · lockToken 用英文，一句话，只含不变特征，例如 "Lin Wan, 26, shoulder-length black hair, beige trench coat"',
    '- scenes: 数组，每项 {id, name, location, timeOfDay, lighting, atmosphere, lockToken}',
    '  · id 用 sc1/sc2/...；name 用中文短名',
    '  · location / timeOfDay / lighting / atmosphere 用英文写',
    '  · lockToken 用英文描述这个空间的固定特征，例如 "rooftop at night, neon rim light, wet concrete"',
    '',
    JSON_ONLY,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Stage 3 — storyboard
// ---------------------------------------------------------------------------

const SHOT_SPEC = {
  type: 'object',
  required: ['id', 'no', 'sceneId', 'durationSec', 'shotSize', 'camera', 'movement', 'action', 'dialogue', 'sfx', 'characters'],
  properties: {
    id: { type: 'string', minLength: 1 },
    no: { type: 'number' },
    sceneId: { type: 'string', minLength: 1 },
    durationSec: { type: 'number' },
    shotSize: { type: 'string', minLength: 1 },
    camera: { type: 'string', minLength: 1 },
    movement: { type: 'string', minLength: 1 },
    action: { type: 'string', minLength: 1 },
    dialogue: {
      type: 'array',
      items: {
        type: 'object',
        required: ['who', 'line'],
        properties: {
          who: { type: 'string' },
          line: { type: 'string', minLength: 1 },
        },
      },
    },
    sfx: { type: 'string' },
    characters: { type: 'array', items: { type: 'string' } },
  },
}

export const STORYBOARD_SPEC = {
  type: 'object',
  required: ['shots'],
  properties: {
    shots: { type: 'array', minItems: 1, maxItems: 80, items: SHOT_SPEC },
  },
}

/**
 * Cinematography pass: one direction line per shot.
 *
 * The storyboard's `action` describes WHAT HAPPENS and is written in the register of
 * a screenplay; it says nothing about how the moment is photographed. That gap is
 * why boards read as staged tableaux rather than film frames, and it is not
 * something an operator can close by hand across twenty shots.
 *
 * The instruction not to restate the action is load-bearing. A model asked for
 * "a prompt for this shot" will happily paraphrase the action back, which adds
 * length and no information — and, worse, competes with the action it duplicates.
 */
/**
 * Frame-prompt pass: expand each shot's action into a full image-generation prompt.
 *
 * This is an EXPANSION, not a direction. The action says what happens in the beat;
 * an image model needs the whole frame described — who is in it, what they look
 * like at this instant, what surrounds them, where the light comes from, what the
 * air feels like. The gap between a one-line action and a rendered frame is exactly
 * that missing description, and it is why boards built from the action alone come
 * out thin.
 *
 * Written to the conventions image models actually respond to: concrete visual
 * nouns, present tense, layered in a fixed order, no abstractions and no camera
 * crew instructions. "侧逆光勾边" tells a cinematographer something and a diffusion
 * model almost nothing; "晨光从她右后方照进来，发丝边缘有一圈亮边" tells both.
 */
/**
 * Style presets — one click instead of typing a style line by hand.
 *
 * Each entry is a finished prompt fragment rather than a label, because a diffusion
 * model reads the FRAGMENT and ignores the label. `{ key: 'mv', label: 'MV' }` alone
 * would give the model the word "MV" and nothing about contrast, colour or light,
 * which is exactly the abstraction the presets exist to remove.
 *
 * Order within each fragment is deliberate — look, then colour, then light, then
 * lens/grade — matching how the rest of the pipeline layers a prompt.
 */
export const STYLE_PRESETS = [
  {
    key: 'cinematic',
    label: '电影质感',
    fragment: 'cinematic realism, natural lighting, shallow depth of field, 35mm anamorphic, subtle film grain, low-key contrast, motivated practical light sources, muted desaturated palette, 2.39:1 framing sensibility',
  },
  {
    key: 'mv',
    label: 'MV / 音乐录影',
    fragment: 'stylised music-video look, saturated colour grading, hard coloured key lights, neon and gel accents, strong rim light, glossy skin highlights, high contrast, bold graphic composition, fashion-editorial energy',
  },
  {
    key: 'japanese',
    label: '日系清新',
    fragment: 'Japanese natural-light aesthetic, soft diffused daylight, airy low-contrast exposure, pale desaturated palette with warm skin tones, gentle backlight and lens flare, clean uncluttered space, nostalgic quiet mood',
  },
  {
    key: 'hkretro',
    label: '港片复古',
    fragment: '1990s Hong Kong cinema, humid night streets, neon signage reflecting on wet asphalt, warm tungsten and green fluorescent mix, heavy film grain, deep shadows, saturated cyan and amber, handheld intimacy',
  },
  {
    key: 'noir',
    label: '黑色电影',
    fragment: 'film noir, high-contrast chiaroscuro lighting, hard directional key with deep black shadow, venetian-blind patterns, smoke haze in the light beam, cold desaturated palette, moral-weight atmosphere',
  },
  {
    key: 'documentary',
    label: '纪录片',
    fragment: 'observational documentary look, available light only, no staged lighting, handheld camera, natural imperfect framing, honest skin texture, minimal grading, real locations with lived-in detail',
  },
  {
    key: 'commercial',
    label: '广告质感',
    fragment: 'premium commercial photography, immaculate controlled lighting, large soft source with precise fill, high-key clean background, saturated but accurate colour, razor-sharp product-grade detail, glossy finish',
  },
  {
    key: 'guofeng',
    label: '国风古装',
    fragment: 'classical Chinese aesthetic, ink-wash tonality, soft directional daylight through gauze, silk and lacquer textures, restrained palette of ink black, rice white and cinnabar red, mist and negative space, poetic stillness',
  },
  {
    key: 'warmfamily',
    label: '生活温情',
    fragment: 'warm domestic realism, golden practical lamps, soft window light, cosy cluttered detail, amber and cream palette, gentle shallow focus, unstaged candid framing, tender everyday atmosphere',
  },
  {
    key: 'thriller',
    label: '悬疑惊悚',
    fragment: 'contemporary thriller, cold clinical palette of steel blue and sickly green, underlit interiors, hard sidelight with heavy falloff, negative space around the subject, shallow focus on detail, uneasy stillness',
  },
]

/** @param {string} key */
export function stylePreset(key) {
  return STYLE_PRESETS.find((p) => p.key === key) ?? null
}

export function shotDirectionSystem() {
  return [
    '你在为 Qwen-Image 2.1 写图像生成提示词。给你一个镜头的内容，把它扩展成一段提示词。',
    '',
    '【格式 · 最重要】',
    '用逗号分隔的视觉短语，不要写成句子。',
    '不要用句号，不要用「然后」「接着」「正在」「地」这类叙述连接词。',
    '每个短语都是一个可以直接画出来的视觉事实，不是一句描述。',
    '',
    '错误示范（这是句子）：女孩侧身从门缝里挤出来，肩膀先探出门框，重心压在左腿上。',
    '正确示范（这是提示词）：白色短袖校服女孩，侧身，肩先过门框，重心在左腿，右脚仍在门内，',
    '  校服下摆被门沿掀起，藏青百褶裙，藏青西装外套系腰间，齐刘海被风向后吹散，',
    '  左耳侧红色小发圈，右手不锈钢保温杯，指节发白，嘴唇微张，眼睛半眯',
    '',
    '【必须覆盖的五层，一层都不能少】',
    '1. 主体：谁，姿态、朝向、表情、手在做什么、重心在哪',
    '2. 外观：衣着、发型此刻的状态（被风吹乱 / 汗湿 / 皱巴巴）、可辨识特征',
    '3. 环境：具体的家具物件、材质、颜色。不要写「房间」，要写「贴墙的灰色铁架床，床脚堆着两本卷边的练习册」',
    '4. 光线：从哪里来、什么颜色、照在什么上、明暗交界在哪。**这一层最容易被漏掉，必须写**',
    '5. 氛围：空气里的东西——尘埃、雾气、湿度、烟、逆光的光晕。**这一层也容易被漏掉，必须写**',
    '',
    '【最重要的一条：不要重复】',
    '我给你的画面描述可能已经写了光线、环境或某个物件。',
    '**已经写过的不要再写一遍**——重复不会加强它，只会挤掉你本可以补充的东西。',
    '你要做的是补上它没写的部分：漏掉的光线层次、更具体的材质、空气里的东西、',
    '手脚和重心的细节、背景里被忽略的物件。',
    '',
    '【其他要求】',
    '· 不要写景别、机位、运动（景别/机位/运动/风格会另外拼上去）。',
    '· 全部用具体的视觉名词。「氛围压抑」不行，「天花板荧光灯有一根在闪」可以。',
    // 350~500, not 200~320. Qwen-Image 2.1 encodes text with Qwen3-VL and handles far
    // longer prompts than this pipeline produces; the old ceiling left the model's
    // capacity unused while the fixed scene and character blocks took most of the
    // prompt. The lower bound matters more than the upper one: a short answer here
    // means the model restated the action instead of adding to it.
    '· 中文，350~500 字，一整段，短语之间用中文逗号「，」连接。',
    JSON_ONLY,
  ].join('\n')
}

/**
 * @param {object} project
 * @param {object[]} shots the shots to write frame prompts for
 */
export function shotDirectionUser(project, shots) {
  const scenes = new Map((project?.scenes ?? []).map((s) => [s.id, s]))
  const seen = new Map()
  const lines = [
    // Stated as a constraint rather than a label. The expansion is exactly where a
    // model drifts: asked to enrich a frame it reaches for whatever looks rich to it,
    // which is how a noir board acquires a golden-hour key light.
    ...(project?.style
      ? ['【画面风格 · 必须严格遵守】', project.style, '你写的每一段画面描述都要符合这个风格。不要引入与它冲突的光线、色调或质感。', '']
      : ['（未指定画面风格，按剧本题材自行判断）', '']),
    project?.genre ? `类型：${project.genre}` : '',
    '',
  ]
  // Scene descriptions are listed once and referenced by name. Inlining them per
  // shot repeated the same long paragraph nineteen times, which is both wasteful
  // and — worse — makes the static description the bulk of the input while the
  // frame's own content is a single line.
  for (const scene of project?.scenes ?? []) {
    if (!shots.some((s) => s.sceneId === scene.id)) continue
    seen.set(scene.id, scene)
    lines.push(`场景「${scene.name}」：${[scene.location, scene.timeOfDay, scene.lighting].filter(Boolean).join(' · ')}`)
  }
  lines.push('', '镜头表：')
  shots.forEach((shot, i) => {
    const scene = seen.get(shot.sceneId)
    lines.push(
      `${i + 1}. id=${shot.id}`,
      `   场景：${scene ? scene.name : '（未指定）'}`,
      `   画面：${String(shot.action ?? '').trim()}`,
    )
  })
  lines.push(
    '',
    `为上面全部 ${shots.length} 个镜头各写一段画面描述（每个 350~500 字）。`,
    '返回 JSON：{ "shots": [ { "id": "镜头 id", "note": "画面描述" } ] }',
    'id 必须原样照抄，不要编号，不要多写也不要少写。',
  )
  return lines.filter((l) => l !== '').join('\n')
}

export function storyboardSystem() {
  return [
    '你是短剧的分镜师，把剧本拆成可以直接交给视频模型渲染的镜头表。',
    '每个镜头都要能被独立渲染，所以画面信息必须写全，不能依赖上一个镜头的上下文。',
    ...RENDER_RULES,
    JSON_ONLY,
  ].join('\n')
}

/**
 * @param {object} project project carrying script + cast
 * @param {object} [options]
 */
export function storyboardUser(project, options = {}) {
  const targetSec = Number(options.targetSec ?? project?.targetTotalSec ?? 60)
  // The render window, not the shot length, is what the board is really built
  // around: one H3 submission produces one clip, and a clip holds several shots.
  const clipSeconds = clampClipSeconds(options.clipSeconds ?? CLIP_SECONDS_DEFAULT)
  const shotsPerClip = Math.max(1, Math.round(clipSeconds / 3))
  const clipCount = Math.max(1, Math.ceil(targetSec / clipSeconds))
  const expected = Math.max(2, clipCount * shotsPerClip)
  const sceneIds = (project?.scenes ?? []).map((s) => s.id)
  const characterIds = (project?.characters ?? []).map((c) => c.id)

  const lines = [
    '剧本：',
    '```json',
    JSON.stringify({
      synopsis: project?.script?.synopsis,
      beats: project?.script?.beats,
      scenes: project?.script?.scenes,
    }, null, 2).slice(0, 20000),
    '```',
    '',
    '可用场景：',
    ...(project?.scenes ?? []).map((s) => `- ${s.id} · ${s.name} · ${[s.location, s.timeOfDay, s.lighting].filter(Boolean).join(', ')}`),
    '',
    '可用角色：',
    ...(project?.characters ?? []).map((c) => `- ${c.id} · ${c.name}（${c.role || '角色'}）· ${c.lockToken}`),
    '',
    ...(project?.style ? [
      '【画面风格 · 必须严格遵守】',
      project.style,
      '每个镜头的场景、光线和人物状态都要能在这个风格下拍出来。不要写出这个风格拍不出的画面。',
      '',
    ] : []),
    '【渲染方式，必须照着排】',
    `视频模型一次只能生成一段约 ${clipSeconds} 秒的成片（硬性 5–15 秒），不是整片一次出。`,
    `所以约 ${targetSec} 秒的成片会被切成约 ${clipCount} 段，每段内部再包含约 ${shotsPerClip} 个镜头。`,
    '段与段之间靠「上一段的收尾接下一段的开场」衔接，所以每段最后一镜与下一段第一镜要接得上：同场景、动作连贯、光线一致。',
    '同一段内的镜头应共享同一个空间与时间点，不要把一场戏切得过于零碎。',
    '',
    `总计约 ${expected} 个镜头（可按内容增减 20%）。`,
    '',
    '输出一个 JSON 对象，镜头数组放在 shots 字段里，形如：',
    '{ "shots": [ { ... }, { ... } ] }',
    '',
    '每个镜头的字段：',
    '- id: sh1/sh2/...；no: 从 1 开始的镜号',
    `- sceneId: 只能取 ${sceneIds.join(' / ') || '（无）'}`,
    '- durationSec: 数字，秒',
    vocabLine('- shotSize', VOCAB.shotSize),
    vocabLine('  camera', VOCAB.camera),
    vocabLine('  movement', VOCAB.movement),
    '- action: 这一个镜头里看得见的画面与动作',
    '- dialogue: [{who, line}]，保留中文台词原文，who 用角色中文名',
    '- sfx: 声音描述',
    `- characters: 数组，元素只能取 ${characterIds.join(' / ') || '（无）'}；画面里没有人物就用空数组`,
  ]
  if (options.instruction) lines.push('', '额外要求：', options.instruction)
  lines.push('', JSON_ONLY)
  return lines.join('\n')
}

/**
 * Compact, actionable feedback for a storyboard retry. Only the first few issues
 * are sent: a long list buries the cause and invites a worse rewrite.
 *
 * @param {{shotId:string, level:string, message:string}[]} issues
 */
export function storyboardFeedback(issues) {
  const shown = issues.slice(0, 10).map((i) => `- 镜头 ${i.shotId || '(整体)'}：${i.message}`)
  return [
    '分镜表没有通过校验，请修正后重新输出完整对象。',
    ...shown,
    '',
    '再次强调：',
    ...RENDER_RULES,
  ].join('\n')
}

export default {
  VOCAB, RENDER_CONSTRAINTS, RENDER_RULES,
  SCRIPT_SPEC, scriptSystem, scriptUser,
  CAST_SPEC, castSystem, castUser,
  STORYBOARD_SPEC, storyboardSystem, storyboardUser, storyboardFeedback,
}
