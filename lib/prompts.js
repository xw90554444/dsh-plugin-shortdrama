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
      // Raised from 16 to 24 so the scene count can follow the beats. A 300s film written with
      // ten beats needs roughly twenty scenes to give each one room; the old ceiling was part of
      // what forced multi-beat compression.
      maxItems: 24,
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
    '',
    // The pacing contract. Without it the model wrote every beat as a self-contained event —
    // "the light goes out, she freezes, it comes back, she works out the rule" as ONE beat
    // carried by ONE scene — so each turn arrived the moment the scene began and the film read
    // as a list of events rather than a story. Measured on the real scripts: ten beats in twelve
    // scenes, and single-scene beats throughout.
    '【节奏 · 这一条决定了成片好不好看】',
    '· 一个情节点不是一个事件，是一段发展。它至少要 2 场戏，重要的给 3–4 场。',
    '  只有 1 场的情节点必须极少，而且只能是刻意的收束（比如结尾的一个动作）。',
    '· 转折要有铺垫：让它落下来之前，先给一个能看出苗头的镜头或动作。',
    '  观众要能事后回想起「原来那时候就有迹象」。',
    '· 情绪不要一步到位。同一情绪写足它的过程——犹豫、尝试、确认、放开，',
    '  这四步本身就值得 2–3 场，而不是一句话带过。',
    '· 转折之间要有承接。上一段结束时人物处在什么状态，下一段就从那个状态开始，',
    '  不要跳到一个全新的情绪上。',
    '· 场次数量由情节点决定，不要反过来把故事压进固定的场次数里。',
    '  情节点多就多给场次；宁可情节点少而每段写透，也不要多而每段一句带过。',
    '',
    // Kept from the paragraph that used to carry the runtime contract. The contract moved to the board
    // stage (see `boardBudget`), but this half of it — write fewer beats properly rather than stacking
    // undeveloped turns — is about quality, not length, and was worth keeping. It was accidentally
    // dropped along with the 「时长是下限」 sentence in the same edit.
    '· 宁可少写几个情节点，把每一个写透，也不要为了显得内容多而堆一串没有展开的转折。',
    '  写长了是可以接受的，写扁了不行。',
    '',
    /**
     * Transition design, at the stage that actually decides it.
     *
     * The finished film is a chain of hard cuts — the clips are concatenated with no dissolve — so a
     * cut is only jarring when it lands somewhere a cut has no business landing. That is decided HERE,
     * by where each scene stops, and it cannot be repaired downstream: the storyboard can only order
     * shots the script already gave it. Measured before this existed: the two script prompts contained
     * ZERO mentions of transitions, while the storyboard prompt carried six lines about them.
     *
     * The examples are deliberately concrete. "End at a decisive moment" is the kind of instruction
     * that reads well and changes nothing; 「手放在门上，还没推开」 is a thing a writer can recognise
     * in their own draft.
     */
    '【每场戏怎么结束 · 这决定了成片接得顺不顺】',
    '成片是**一连串硬切**：镜头与镜头、场与场之间没有淡入淡出、没有叠化，就是直接切过去。',
    '硬切本身没问题——它是最常用的手法。突兀只发生在**切点落错了地方**的时候：',
    '切在一个动作的半途，观众会觉得被扯断；切在一个动作的完成处，观众会觉得是标点。',
    '',
    '所以写每一场的时候，先想好它**停在哪一刻**：',
    '· 停在一个动作的**完成点**上。「她关上门」是完成；「她正伸手去关门」是半途，',
    '  不要停在半途——除非你故意的，要让观众悬着。',
    '· 或者停在**视线的转向**上：人物看向某个方向、某个东西进入他的视野，下一刻切到他在看的东西。',
    '· 或者停在**光或声音的变化**上：灯灭了、远处响了一声、风起来了。变化本身就是一个自然的标点。',
    '· 或者停在**一句话落地之后**，而不是说到一半。对白被切断是最刺耳的一种突兀。',
    '',
    '还有两件不能做的事：',
    '· **不要靠运镜或特效来遮挡接缝**。剧本层面不需要考虑技术过渡，那不是你的工作，',
    '  你只要让每一场的落点本身成立。',
    '· **不要让相邻两场看起来是同一场的续写**。同一个人、同一个地方、同一个时间，',
    '  连着两场之间没有推进，那两场就该并成一场。',
    '',
    '判断标准很简单：**把任意两场之间的切点念出来，问「为什么切在这里」。**',
    '如果你答不出一个理由，那个切点就是突兀的。',
    '',
    // The script stage no longer states a runtime contract: the board stage enforces it (see
    // `boardBudget`), and saying "时长是下限" here as well is what made a 30s target produce 56.5s
    // of footage. A contradictory instruction in the same pipeline is worse than a missing one.
    JSON_ONLY,
  ].join('\n')
}

/**
 * @param {object} project
 * @param {string} brief free-form creative direction
 * @param {object} [options]
 */
/**
 * Is the text the operator supplied a SYNOPSIS or an actual SCREENPLAY?
 *
 * The distinction changes the whole task and there is no reliable way to ask for it, so it is
 * inferred. The failure this exists to prevent is concrete: a finished screenplay was pasted into
 * the 创作要求 box, treated as "creative direction", and rewritten — the instruction to be
 * faithful to the brief was read as licence to reinterpret it, because the brief was assumed to be
 * a one-line idea.
 *
 * The heuristic is deliberately generous toward "this is a screenplay". Being wrong that way costs
 * a little creative latitude; being wrong the other way throws away the operator's work, which is
 * what happened.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeScreenplay(text) {
  const value = String(text ?? '').trim()
  if (!value) return false
  const lines = value.split('\n').filter((l) => l.trim())
  const speakerLines = lines.filter((l) => /^[^：:\n]{1,12}[：:]\s*\S/.test(l.trim())).length
  // A numbered scene heading or three speaker lines is not something a synopsis has. These are
  // strong enough to outweigh BOTH the length floor and the line-count floor, which is what makes a
  // 76-character dialogue block read as a script — verified against samples of that size, which the
  // first version of this rejected.
  const hasSceneHeading = /^\s*(场景|场次|第\s*[一二三四五六七八九十百\d]+\s*[场幕])/m.test(value)
  if (hasSceneHeading || speakerLines >= 3) return true

  // Otherwise it takes several independent hints AND some length. The floors are low on purpose: a
  // three-scene short can be 150 characters, and the first threshold of 400 rejected a real one.
  if (value.length < 120 || lines.length < 5) return false
  let signals = 0
  if (/(内景|外景|日|夜)\s*[·\-—]/.test(value)) signals += 1
  // Cinematic vocabulary a synopsis does not usually reach for.
  if (/(镜头|特写|全景|中景|近景|画外音|切入|淡出|转场|俯拍|仰拍)/.test(value)) signals += 1
  // Many short lines is the shape of a script, not of a paragraph of direction.
  if (value.length / lines.length < 60) signals += 1
  // Stage directions in brackets, which is how a screenplay marks anything non-spoken.
  if (/^\s*[（(].+[）)]\s*$/m.test(value)) signals += 1
  return signals >= 2
}

export function scriptUser(project, brief, options = {}) {
  const targetSec = Number(options.targetSec ?? project?.targetTotalSec ?? 60)
  /**
   * Scenes to aim for — a MINIMUM, and no longer capped in a way that compresses long films.
   *
   * The old formula was `min(12, round(targetSec / 12))`, which every long project hit exactly:
   * 180s and 300s both produced 12 scenes, so a 300s film was written in the same number of
   * dramatic units as a 144s one and each unit had to carry twice the runtime. That is the
   * mechanism behind "转折太快" — there was nowhere for a turn to build.
   *
   * Roughly one scene per 10 seconds, floored at 4 and allowed to reach the schema's ceiling.
   * It is phrased as an expectation rather than a quota: the model is told the count follows the
   * beats, not the other way round.
   */
  const sceneCount = Math.max(4, Math.min(24, Math.round(targetSec / 10)))
  const supplied = String(brief ?? '').trim() || String(project?.logline ?? '').trim()
  const givenScreenplay = looksLikeScreenplay(supplied)
  const lines = givenScreenplay
    ? [
      '【下面这份是已经写好的剧本，不是创意概要】',
      '你的任务是把它**整理成结构化文档**，不是重写它、不是改编它、也不是另写一个。',
      '',
      '必须原样保留：',
      '· 场次的先后顺序与每一场的内容',
      '· 所有台词，一字不改（说话人名字也照抄）',
      '· 人物、地点、时间、以及故事本身的走向和结局',
      '',
      '你只做这些：',
      '· 把场次归到情节点下（beatId），情节点要概括这段戏在讲什么',
      '· 补出 slug（地点·时间的短标题）、synopsis（梗概，按剧本已有内容写，不要添加情节）',
      '· 如果原剧本缺 title / genre / style / audioStyle，按它的内容补上',
      '',
      '原剧本已有的东西不要动。**一个字都不许改台词。**',
      '如果你觉得某处写得不好，也照原样保留——创作决定权不在你这里。',
      '',
      '剧本原文：',
      '```',
      supplied.slice(0, 30000),
      '```',
    ]
    : [
      '创作要求：',
      supplied || '（未提供。请构思一个适合竖屏的情绪片段，靠画面和氛围推进，不要依赖反转或悬念）',
    ]
  lines.push(
    '',
    `目标成片时长约 ${targetSec} 秒，画面比例 ${project?.ratio ?? '9:16'}。`,
    // The script stage writes the whole story; the BOARD stage is what has to fit the runtime, so
    // this is deliberately not a limit here. An earlier revision said "时长是下限" in BOTH places,
    // which is what made boards overshoot: measured at +98% on a 30s target.
    '这里是**写出完整故事**的阶段，先把故事讲好、讲顺，不要为了卡时长把情节砍断；',
    `真正卡时长的是后面的分镜阶段（它会按 ${targetSec} 秒排出对应数量的镜头）。`,
    givenScreenplay
      ? '场次以剧本原文为准；原文的场次多于上面的参考值也没关系，不要合并或删减。'
      : `按内容大约需要 ${sceneCount} 场戏或更多。先决定要讲几个情节点，再让场次数跟着情节点走——`,
    givenScreenplay ? '' : '不要为了凑场次而多写情节点，也不要把一个情节点压进一场里。',
  )
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
  /**
   * Continuation.
   *
   * A story that wants more room gets it by being WRITTEN LONGER, not by being packed tighter.
   * The model is given the existing script and asked to carry on from where it stopped, with the
   * existing ids restated so the two halves can be joined without a collision.
   */
  if (options.continueFrom) {
    const beats = Array.isArray(options.continueFrom.beats) ? options.continueFrom.beats : []
    const scenes = Array.isArray(options.continueFrom.scenes) ? options.continueFrom.scenes : []
    lines.push(
      '',
      '【续写 · 不要重写，只管往下接】',
      '下面是你已经写好的部分。它已经定稿，**不要改动它**，也不要重述它写过的内容。',
      '```json',
      JSON.stringify({ beats, scenes }, null, 2).slice(0, 20000),
      '```',
      '',
      `已经写到：第 ${scenes.length} 场，第 ${beats.length} 个情节点。`,
      '请从它停下的地方继续写，输出**完整**对象（原有的 + 新写的），并且：',
      `· 情节点 id 从 b${beats.length + 1} 开始，场次 id 从 s${scenes.length + 1} 开始，依次后推。`,
      '· 新写的场次 beatId 必须指向情节点里真实存在的 id。',
      '· 原有的 title / logline / genre / style / audioStyle 保持不变（若确有需要可微调 logline）。',
      '· 续写的部分要和已有部分同一个故事、同一个语气，接着往下发展，不要另起一个故事。',
      '· 收在哪里由故事决定：讲完了就自然地收尾，不必为了凑时长硬加情节。',
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
  // Blank entries are dropped: the screenplay branch leaves a conditional line empty, and a stray
  // empty line mid-instruction reads as sloppiness to a model being asked to be precise.
  return lines.filter((line) => line !== '').join('\n')
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
    '**同一个镜头内，已经写过的不要再写一遍**——重复不会加强它，只会挤掉你本可以补充的东西。',
    '你要做的是补上它没写的部分：漏掉的光线层次、更具体的材质、空气里的东西、',
    '手脚和重心的细节、背景里被忽略的物件。',
    '',
    // The rule above was read ACROSS shots as well as within them, which flattened a whole board
    // into one tidy list: every frame got the same layered light, the same dust, the same five
    // subjects. A sequence needs the opposite — each frame advancing the image, not restating it.
    '【镜头之间：要推进，不要平均】',
    '· 上面那条只管同一个镜头内部。镜头之间要各写各的，不要每镜都凑齐同样的五层。',
    '· 相邻镜头换一个侧面去写：这一镜写手和光线，下一镜写背部和环境，再下一镜写脸和呼吸。',
    '· 让画面随镜头变化——光在移动，影子在变长，衣服被汗浸湿，地上多了个东西。',
    '  同一个场景的几个镜头不该是同一张照片的五个角度。',
    '· 主体在动的地方写清楚位于动作的哪一刻：刚抬手、手到一半、手已经落下。',
    '  一个明确的瞬间比一段平均的描述有画面得多。',
    '· 至少写一处这一镜独有的东西——别的镜头没有的物件、反光、瑕疵或意外。',
    '· 空气里的东西也要变：尘埃、雾气、烟的浓度和走向随时间和动作不同。',
    '',
    // A transition is carried by a FRAME, so if the frame prompt treats every shot as a fresh
    // tableau the join is a cut no matter what the board intended. These are the frames that have
    // to be written as mid-motion rather than posed.
    '【转场的那一镜：要写成"正在过去"，不要写成"已经在这里"】',
    '如果这一镜是过场（人物进出画、门的开合、光的移动、动作接上一个镜头），',
    '那就必须写出**动作还在进行中**的样子：',
    '· 身体的重心已经移向下一处，但脚还没落定；手已经推开门，但门还没完全开。',
    '· 画面里要同时有「离开的那个空间」和「要去的那个空间」——门框、走廊尽头、门外的光。',
    '· 光要写出方向：光从哪边来、在地上拉到多长、下一个空间的光是不是同一个色温。',
    '· 不要写成一个静态的姿势。过场镜的力气全在「差一点就到了」这个瞬间上。',
    '',
    // A frame prompt that poses fast action mid-swing is what makes it smear: the model is asked to
    // reach an unambiguous pose and is handed an ambiguous one. The same rule as the board's, applied
    // to the frame description, because this is the text the image model actually reads.
    '【动作镜：写到极点，不要写中段】',
    '如果这一镜是武打、跳跃、旋转这类快速动作，把姿势写在**动作的极点**上：',
    '· 出拳写到「手臂完全展开、拳到最远点、肩背肌肉绷紧、对手的头刚进入画面边缘」。',
    '· 腾空写到「双脚离地最高点、衣摆被拉直、头发向上飘起」。',
    '· 旋身写到「背对镜头、裙摆甩成完整的圆、重心压在单脚前掌」。',
    '不要写「正在出拳」「跳到一半」这类中间态：静帧画在中间态，模型没有依据去补前后，只能糊。',
    '极点姿势是确定的，模型从极点推回起势和收势反而更稳。',
    '',
    // Motion blur is a common instinct here and it is counterproductive at these step counts: the
    // model has few steps to resolve the pose, and a blurred pose gives it nothing to resolve.
    '另外：**不要写运动模糊、残影、拖影**。少步采样下这些词只会让肢体更糊、更不像人。',
    '要"快"的感觉，靠姿势的张力、衣料被拉直、尘土被带起——靠画面里的结果，不靠模糊。',
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
  // The caller builds the budget (`boardBudget`) so the prompt and the code that trims the result
  // cannot disagree about it. Falling back keeps this function usable on its own in a test.
  const budget = options.budget ?? {
    targetSec,
    maxContentSec: Math.max(3, Math.round((targetSec - clipSeconds / 2) * 10) / 10),
    maxShots: Math.max(1, Math.floor((targetSec - clipSeconds / 2) / 3)),
    avgShotSec: 3,
  }
  const shotsPerClip = Math.max(1, Math.round(clipSeconds / budget.avgShotSec))
  const clipCount = Math.max(1, Math.ceil(targetSec / clipSeconds))
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
    '同一段内的镜头通常共享同一个空间与时间点，但同一地点的前后时段也算同一段——',
    '光线从午后走到黄昏、人物从站着到坐下，这种推进是内容，不要为了「同一时间点」把它切掉。',
    '',
    /**
     * The duration budget, stated as a limit.
     *
     * `expected` was computed above and never reached the prompt, so nothing ever told the model how
     * many shots to write — it converted every scene in the script instead, and a 30s target came
     * back with 56.5s of footage. The measured overrun was +98% on that project and +27% on another,
     * while snapping to the frame grid accounted for barely a second of it.
     */
    '【时长预算是硬上限 · 这条最容易被忽略】',
    `· 所有镜头的 durationSec 加起来**不能超过 ${budget.maxContentSec} 秒**，镜头总数**不要超过 ${budget.maxShots} 个**。`,
    `· 这是上限，不是配额：剧本里后面的场次排不下就**不要排**，写到预算用完为止。`,
    `· 宁可少排几镜，也不要每一镜都超一点——每一点都会被渲染的帧网格向上取整，累加起来就超出成片时长。`,
    `· 平均每镜约 ${budget.avgShotSec} 秒。不要为了让内容都装下而把每镜压到 1–2 秒，那样动作会看不清。`,
    '· 排不下不是失败：先出一部分能看的，用户可以看过之后再决定要不要继续加时长。',
    '',
    // The board knew about segment joins and nothing about SCENE joins, so a change of place was a
    // hard cut with no shot carrying it — the "生硬" this is here to fix. The two are different
    // things and are now stated as such: a segment boundary is a fact of the renderer and is
    // invisible in the finished film, a scene change is a moment in the story and needs a shot.
    '【转场 · 这是成片顺不顺的关键】',
    '先把两件事分开看：',
    '· 分段边界是渲染的产物，成片里看不出来（上一段结尾和下一段开头本来就连着），',
    '  所以**不要为了让段落好看而安排转场**。',
    '· 场景切换是故事里真实发生的一刻，观众能看见它。换场景必须有镜头承担过渡。',
    '',
    '所以每一次 sceneId 变化，前面那一镜必须是过场，不能直接硬切到新场景。过场用这几种写法：',
    '· 人物**走出画**或走进画：镜头跟着他一道门、转过一个拐角，新场景接在下一步。',
    '· 光的移动：光斑滑过墙面、灯被关掉或点亮，同一空间在光线里变成「另一个地方」。',
    '· 一个物件带着观众过去：手、道具、影子先进入新场景，人随后跟上。',
    '· 匹配剪辑：上一镜的动作（抬手、回头、推门）与下一镜**同一个动作**接上，动作不要断。',
    '',
    '不要用淡入淡出、叠化、黑场——成片是硬切。所以过渡要发生在**镜头内部**：',
    '让人物或光先把观众带到下一个空间，再切。',
    '同一个场景内部也要有变化，不要让三个镜头站在原地讲同一件事：',
    '景别递进（远→中→近）、机位换边、焦点从人到物，都是让接点不突兀的手段。',
    '',
    // Fast action is where the video model fails visibly, and the failure is usually set up in the
    // BOARD rather than in the sampler: the keyframe is a still, so if it is posed at the midpoint
    // of a swing the model has to invent both the wind-up and the follow-through from nothing, and
    // it invents them as mush. A still at the extreme of the motion constrains the interpolation
    // far harder. This is also why one shot should carry one action: a shot that performs three
    // moves in four seconds has no pose the model can hold.
    '【武打 / 跳舞这类动作戏 · 单独说清楚】',
    '关键帧是一张静帧，模型要从这一张推出整段运动。所以静帧画在**哪里**，直接决定动作像不像。',
    '· **一镜一个动作**。不要在一个镜头里连做三个招式——四秒里塞三招，模型只能糊成一片。',
    '  一个镜头一件事：出拳、闪身、落地、旋身，各占一镜。',
    '· action 里写清楚身体状态：谁在动、哪只手哪条腿在动、重心在哪只脚、动到哪一刻。',
    '· 写到**动作的极点**，不要写中段：出拳写到"拳已到对方脸前、手臂完全展开"，',
    '  而不是"正在出拳"。极点姿势明确，中间的过渡模型自己补得出来；中段姿势无法约束。',
    '· 旋转、翻滚这类动作同样处理：写"转到背对镜头、裙摆完全甩开"这样的确定时刻。',
    '· 打斗不要靠运镜糊过去。手持、快推、甩镜会让糊更明显，宁可固定机位把动作摆清楚。',
    '',
    // States the same ceiling as the budget section above. It used to say "可按内容增减 20%",
    // which is a licence to overshoot — and the film then came out 98% long on a 30s target. One
    // number, stated once as a limit, is the only version that holds.
    `总计不要超过 ${budget.maxShots} 个镜头，所有 durationSec 加起来不超过 ${budget.maxContentSec} 秒。`,
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
