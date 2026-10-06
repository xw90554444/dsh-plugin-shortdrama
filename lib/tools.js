/**
 * Agent-facing tools.
 *
 * These call the same `api` object the studio UI reaches over the web route, so a
 * prompt compiled in the UI and one compiled by the agent are byte-identical.
 *
 * Long work is started as a tracked run. A tool waits a bounded slice for it and
 * then hands back the run id, so an agent never blocks a turn on a render that
 * legitimately takes twenty minutes — it polls instead.
 */

const text = (value) => [{ type: 'text', text: String(value) }]

function renderError(result) {
  const problems = Array.isArray(result?.error?.problems) && result.error.problems.length > 0
    ? `\n${result.error.problems.slice(0, 8).map((p) => `  - ${p}`).join('\n')}`
    : ''
  return text(`ShortDrama error [${result?.error?.code ?? 'unknown'}]: ${result?.error?.message ?? 'unknown failure'}${problems}`)
}

/**
 * Wait for a run, bounded. Returns either the finished run or a still-running
 * snapshot — never throws on timeout, because a live run is a valid outcome.
 */
async function waitForRun(api, runId, { waitMs = 120000, pollMs = 1500 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const run = api.runStatus(runId)
    if (!run) return { ok: false, error: { code: 'not-found', message: `no run "${runId}"` } }
    if (run.status !== 'running') return { ok: true, run }
    if (Date.now() >= deadline) return { ok: true, run, timedOut: true }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

function describeRun(run, extraLines = []) {
  const lines = []
  const head = run.status === 'done' ? '完成' : run.status === 'failed' ? '失败' : run.status === 'cancelled' ? '已取消' : '进行中'
  lines.push(`${run.label} — ${head}（${(run.elapsedMs / 1000).toFixed(1)}s）`)
  if (run.phase) lines.push(`阶段：${run.phase}`)
  if (run.message) lines.push(run.message)
  if (run.problems?.length) lines.push(`校验问题：${run.problems.slice(0, 5).join('; ')}`)
  if (run.error) lines.push(`错误 [${run.error.code}]：${run.error.message}`)
  const result = run.result
  if (result) {
    if (Array.isArray(result.rendered)) {
      lines.push(`产出 ${result.rendered.length} 项，失败 ${result.failed?.length ?? 0} 项（共 ${result.total}）`)
      for (const item of result.failed ?? []) lines.push(`  ✗ ${item.label ?? item.id}：${item.message}`)
    }
    if (result.summary) {
      lines.push(`镜头 ${result.summary.shotCount} 个 · 约 ${result.summary.totalSec}s · ${result.summary.clipCount} 个渲染片段`)
    }
    if (result.repairs?.length) lines.push(`自动修正：${result.repairs.slice(0, 5).join('; ')}`)
    if (result.lint?.length) {
      lines.push('分镜检查：')
      for (const issue of result.lint.slice(0, 8)) lines.push(`  [${issue.level}] ${issue.shotId || '整体'}：${issue.message}`)
    }
    if (result.model) lines.push(`模型：${result.model.provider}/${result.model.model}`)
  }
  lines.push(...extraLines)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// drama_project
// ---------------------------------------------------------------------------

export function projectTool(api) {
  return {
    name: 'drama_project',
    description: [
      'Create, list, read, update or remove a short-drama project: title, logline, visual style, cast, scenes and the shot list.',
      'A project is the input to drama_script, drama_storyboard, drama_render and drama_prompt.',
      'Shots carry durationSec, shotSize, camera, movement, action, dialogue, sfx and characters.',
      'Durations are the requested seconds; the compiler snaps them onto MiniMax-H3\'s 17k+5 frame grid itself.',
      'Typical flow: create -> drama_script -> drama_cast -> drama_storyboard -> drama_render.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'remove'], description: 'What to do.' },
        projectId: { type: 'string', description: 'Target project id. Required for get/update/remove.' },
        project: {
          type: 'object',
          description: 'Project document for create/update. Arrays are replaced wholesale, not merged.',
          additionalProperties: true,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.error) return renderError(value)
        if (Array.isArray(value?.projects)) {
          if (value.projects.length === 0) return text('No short-drama projects yet.')
          return text(`Short-drama projects:\n${value.projects.map((p) => (
            `- ${p.id} · ${p.title} · ${p.shotCount} shots · ${p.totalSec}s · ${p.characterCount} chars · ${p.sceneCount} scenes`
          )).join('\n')}`)
        }
        const p = value?.project
        if (p) {
          return text([
            `${p.title} (${p.id})`,
            `ratio ${p.ratio} · ${p.shots.length} shots · ${p.characters.length} characters · ${p.scenes.length} scenes`,
            p.logline ? `logline: ${p.logline}` : '',
            p.script ? `script: ${p.script.beats?.length ?? 0} beats, ${p.script.scenes?.length ?? 0} scenes` : 'script: (none yet)',
            p.characters.length ? `cast: ${p.characters.map((c) => c.name).join(', ')}` : '',
          ].filter(Boolean).join('\n'))
        }
        return text(JSON.stringify(value, null, 2))
      },
    },
    async execute(args) {
      try {
        switch (args?.action) {
          case 'list':
            return { projects: await api.listProjects() }
          case 'get': {
            const project = await api.getProject(args.projectId)
            return project ? { project } : { error: { code: 'not-found', message: `no project "${args.projectId}"` } }
          }
          case 'create':
            return { project: await api.createProject(args.project ?? {}) }
          case 'update': {
            const project = await api.updateProject(args.projectId, args.project ?? {})
            return project ? { project } : { error: { code: 'not-found', message: `no project "${args.projectId}"` } }
          }
          case 'remove': {
            const removed = await api.removeProject(args.projectId)
            return removed ? { removed: args.projectId } : { error: { code: 'not-found', message: `no project "${args.projectId}"` } }
          }
          default:
            return { error: { code: 'bad-action', message: `unknown action "${args?.action}"` } }
        }
      } catch (error) {
        return { error: { code: 'failed', message: String(error?.message ?? error) } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// drama_script
// ---------------------------------------------------------------------------

export function scriptTool(api) {
  return {
    name: 'drama_script',
    description: [
      'Write a short-drama script onto a project, using the session\'s model.',
      'Writes title, logline, genre, visual style, audio style, synopsis, story beats and scenes with dialogue onto the project.',
      'brief accepts EITHER a one-line creative direction OR a full screenplay: a long, scene-by-scene text is detected and the model is told to structure it as-is rather than rewrite it (dialogue preserved word for word).',
      'Set revise=true (with instruction) to rewrite an existing script in place, keeping what still works.',
      'Set expand=true to continue an existing script instead of replacing it — use this when the story needs more room.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to write into.' },
        brief: {
          type: 'string',
          description: 'Either a one-line creative direction (premise, hook, tone) or a whole screenplay to structure. A long text with scene headings or dialogue is treated as a screenplay and preserved. Falls back to the project logline.',
        },
        instruction: { type: 'string', description: 'For revisions: what to change.' },
        targetSec: { type: 'number', description: 'Target runtime in seconds, a LOWER bound — a story that needs longer is written longer rather than compressed. Defaults to the project target or 60.' },
        revise: { type: 'boolean', description: 'Rewrite the existing script instead of starting fresh.' },
        expand: { type: 'boolean', description: 'Continue the existing script from where it stops, keeping what is there. Ignored when revise is also set.' },
        waitMs: { type: 'number', description: 'How long to wait for completion before returning the run id. Default 120000.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.error) return renderError(value)
        if (!value?.run) return text(JSON.stringify(value, null, 2))
        const run = value.run
        const lines = [describeRun(run)]
        const script = run.result?.project?.script
        if (script) {
          lines.push('', `梗概：${script.synopsis}`)
          for (const beat of script.beats ?? []) lines.push(`\n[${beat.id}] ${beat.summary}${beat.emotion ? `（${beat.emotion}）` : ''}`)
          if (run.result?.usage) {
            // Providers disagree on the field names: DSH's own adapters use
            // inputTokens/outputTokens while an OpenAI-compatible endpoint returns
            // prompt_tokens/completion_tokens. Reading only one shape printed
            // "in ? / out ?" and looked like a broken counter rather than a name
            // mismatch.
            const u = run.result.usage
            const pick = (...keys) => {
              for (const k of keys) if (Number.isFinite(Number(u?.[k]))) return Number(u[k])
              return null
            }
            const input = pick('inputTokens', 'prompt_tokens', 'promptTokens')
            const output = pick('outputTokens', 'completion_tokens', 'completionTokens')
            const total = pick('totalTokens', 'total_tokens')
            lines.push('', `tokens: in ${input ?? '?'} / out ${output ?? '?'}${total ? ` / total ${total}` : ''}`)
          }
        }
        if (value.timedOut) lines.push('', `仍在运行，用 drama_render action=status runId=${run.id} 继续查询。`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        if (!args?.projectId) return { error: { code: 'bad-args', message: '缺少 projectId：请先用 drama_project 查到项目 id。' } }
        const started = await api.startScriptRun({
          projectId: args.projectId,
          brief: args.brief,
          instruction: args.instruction,
          targetSec: args.targetSec,
          revise: args.revise,
          // Continuation, exposed to the agent too: the same capability the panel's 继续写 button
          // has, so a story that needs more room can be extended without a rewrite.
          expand: args.expand,
        })
        if (!started.ok) return started
        const waited = await waitForRun(api, started.runId, { waitMs: args.waitMs ?? 120000 })
        return waited.ok
          ? { run: waited.run, runId: started.runId, timedOut: waited.timedOut === true }
          : waited
      } catch (error) {
        return { error: { code: error?.code ?? 'failed', message: String(error?.message ?? error) } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// drama_cast
// ---------------------------------------------------------------------------

export function castTool(api) {
  return {
    name: 'drama_cast',
    description: [
      'Extract the cast and locations from a project\'s script into a visual bible: per-entity appearance fields plus a lockToken',
      'that is spliced verbatim into every later image and video prompt to keep a character recognisable across shots.',
      'Set renderImages=true to also generate the reference artwork for each character and location.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to read from and write the cast onto.' },
        renderImages: { type: 'boolean', description: 'After extraction, render reference images for every entity.' },
        waitMs: { type: 'number', description: 'How long to wait before returning the run id. Default 120000.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.error) return renderError(value)
        const lines = []
        if (value.extract) lines.push(describeRun(value.extract.run))
        if (value.render) lines.push('', describeRun(value.render.run))
        const project = value.extract?.run?.result?.project
        if (project) {
          lines.push('', '人物：')
          for (const c of project.characters) lines.push(`  ${c.id} ${c.name}（${c.role || '角色'}）→ ${c.lockToken}`)
          lines.push('', '场景：')
          for (const s of project.scenes) lines.push(`  ${s.id} ${s.name} → ${s.lockToken}`)
        }
        if (value.extract?.timedOut || value.render?.timedOut) {
          lines.push('', '仍有任务在运行，用 drama_render action=status 查询进度。')
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        if (!args?.projectId) return { error: { code: 'bad-args', message: '缺少 projectId：请先用 drama_project 查到项目 id。' } }
        const started = await api.startCastRun({ projectId: args.projectId })
        if (!started.ok) return started
        const waited = await waitForRun(api, started.runId, { waitMs: args.waitMs ?? 120000 })
        const out = { extract: { run: waited.run, timedOut: waited.timedOut === true }, runId: started.runId }
        if (waited.run?.status === 'failed') return { error: waited.run.error, extract: out.extract }

        if (args.renderImages) {
          const rendered = await api.startReferenceRun({ projectId: args.projectId, force: false })
          if (!rendered.ok) return { ...out, error: rendered.error }
          const renderWaited = await waitForRun(api, rendered.runId, { waitMs: args.waitMs ?? 120000 })
          out.render = { run: renderWaited.run, timedOut: renderWaited.timedOut === true }
        }
        return out
      } catch (error) {
        return { error: { code: error?.code ?? 'failed', message: String(error?.message ?? error) } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// drama_storyboard
// ---------------------------------------------------------------------------

export function storyboardTool(api) {
  return {
    name: 'drama_storyboard',
    description: [
      'Turn a project\'s script and cast into a shot list the renderer can execute.',
      'Every shot gets durationSec, shotSize, camera, movement, action, dialogue, sfx and character references.',
      'Durations are validated against MiniMax-H3\'s real limits and the board is re-written once if it fails lint.',
      'Requires a script and a cast first (drama_script, then drama_cast).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to storyboard.' },
        instruction: { type: 'string', description: 'Extra directorial requirements for this board.' },
        targetSec: { type: 'number', description: 'Target total runtime in seconds.' },
        clipSeconds: { type: 'number', description: 'How long ONE generated video segment runs, in seconds (5-15). Shots are packed to fill this window, so it drives both the board split and the compiled timeline. Defaults to the configured value.' },
        waitMs: { type: 'number', description: 'How long to wait before returning the run id. Default 180000.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.error) return renderError(value)
        if (!value?.run) return text(JSON.stringify(value, null, 2))
        const lines = [describeRun(value.run)]
        const shots = value.run.result?.project?.shots
        if (shots) {
          lines.push('', '镜号  时长  景别    机位    运动    画面')
          for (const shot of shots) {
            lines.push(`${String(shot.no).padStart(3)}  ${String(shot.durationSec).padStart(4)}s  ${(shot.shotSize || '').padEnd(7)} ${(shot.camera || '').padEnd(7)} ${(shot.movement || '').padEnd(7)} ${shot.action}`)
          }
        }
        if (value.timedOut) lines.push('', `仍在运行，用 drama_render action=status runId=${value.run.id} 继续查询。`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        if (!args?.projectId) return { error: { code: 'bad-args', message: '缺少 projectId：请先用 drama_project 查到项目 id。' } }
        const started = await api.startStoryboardRun({
          projectId: args.projectId,
          instruction: args.instruction,
          targetSec: args.targetSec,
          clipSeconds: args.clipSeconds,
        })
        if (!started.ok) return started
        const waited = await waitForRun(api, started.runId, { waitMs: args.waitMs ?? 180000 })
        return waited.ok
          ? { run: waited.run, runId: started.runId, timedOut: waited.timedOut === true }
          : waited
      } catch (error) {
        return { error: { code: error?.code ?? 'failed', message: String(error?.message ?? error) } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// drama_prompt
// ---------------------------------------------------------------------------

export function promptTool(api) {
  return {
    name: 'drama_prompt',
    description: [
      'Compile a project\'s shot list into MiniMax-H3 prompts (for the local ComfyUI MiniMaxH3ImageToVideo node)',
      'and per-shot keyframe image prompts.',
      'Returns one prompt per renderable clip plus image prompts for every character and scene.',
      'Set export=true to also write the production bundle (h3-prompts.md, prompts.json, shot-list.csv, script.md, cloud-requests.json) to disk.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to compile.' },
        shotIds: { type: 'array', items: { type: 'string' }, description: 'Compile only these shots. Omit for the whole board.' },
        export: { type: 'boolean', description: 'Also write the production bundle to disk.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value?.ok) return renderError(value)
        const lines = [
          `${value.project.title} → ${value.clips.length} H3 clip(s), ${value.shots.length} shot(s), ${value.resolution.width}x${value.resolution.height}`,
        ]
        for (const clip of value.clips) {
          lines.push('')
          lines.push(`── Clip ${clip.index + 1} · ${clip.seconds}s · ${clip.frames} frames · shots ${clip.shotIds.join(', ')}`)
          if (clip.warnings.length > 0) lines.push(`   ⚠ ${clip.warnings.join('; ')}`)
          lines.push(clip.prompt)
        }
        if (value.lint?.length) {
          lines.push('', 'Storyboard lint:')
          for (const issue of value.lint) lines.push(`  [${issue.level}] ${issue.shotId || 'board'}: ${issue.message}`)
        }
        if (value.export) lines.push('', `Wrote ${value.export.written.length} file(s) under ${value.export.dir}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        if (!args?.projectId) return { ok: false, error: { code: 'bad-args', message: '缺少 projectId：请先用 drama_project 查到项目 id。' } }
        const request = { projectId: args.projectId, shotIds: args.shotIds }
        return args.export ? await api.exportPrompts(request) : await api.compile(request)
      } catch (error) {
        return { ok: false, error: { code: 'failed', message: String(error?.message ?? error) } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// drama_render
// ---------------------------------------------------------------------------

export function renderTool(api) {
  return {
    name: 'drama_render',
    description: [
      'Render on the local ComfyUI: character/location reference art, per-shot keyframes, or MiniMax-H3 video clips with native audio.',
      'Actions reference | keyframe | video start a tracked run and wait a bounded slice for it; status | cancel manage runs.',
      'Renders are minutes long for video, so a start action that exceeds waitMs returns the run id to poll with action=status.',
      'Video rendering needs keyframes first; keyframes need references for the strongest character consistency.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['reference', 'keyframe', 'video', 'status', 'cancel', 'capacity'], description: 'What to do.' },
        projectId: { type: 'string', description: 'Required for reference/keyframe/video.' },
        runId: { type: 'string', description: 'Required for status/cancel.' },
        entityIds: { type: 'array', items: { type: 'string' }, description: 'Limit reference rendering to these entity ids.' },
        shotIds: { type: 'array', items: { type: 'string' }, description: 'Limit keyframe/video rendering to these shot ids.' },
        clipIndexes: { type: 'array', items: { type: 'number' }, description: 'Limit video rendering to these clip indexes (0-based).' },
        force: { type: 'boolean', description: 'Re-render items that already have an artifact.' },
        keyframeMode: { type: 'string', enum: ['auto', 't2i', 'i2i'], description: 'auto uses image-to-image when a shot has exactly one referenced character.' },
        waitMs: { type: 'number', description: 'How long to wait before returning the run id. Default 180000.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.error) return renderError(value)
        if (value.runs) {
          if (value.runs.length === 0) return text('No render runs yet.')
          return text(value.runs.map((r) => `${r.id} · ${r.status} · ${r.phase} · ${r.label}${r.message ? ` — ${r.message}` : ''}`).join('\n'))
        }
        if (value.capacity) {
          const health = value.status?.health
          const capacity = value.status?.capacity
          if (!health) return text(`ComfyUI 不可用：${value.status?.error?.message ?? 'unknown'}`)
          return text([
            `GPU ${health.devices?.[0]?.name ?? '无'}`,
            `显存 ${(health.devices?.[0]?.vramFreeBytes / 1e9).toFixed(2)} GB 可用 / ${(health.devices?.[0]?.vramTotalBytes / 1e9).toFixed(2)} GB`,
            `内存 ${(health.ramFreeBytes / 1e9).toFixed(2)} GB 可用 / ${(health.ramTotalBytes / 1e9).toFixed(2)} GB`,
            `评估：${capacity?.level ?? 'unknown'}${capacity?.notes?.length ? ` — ${capacity.notes.join(' ')}` : ''}`,
          ].join('\n'))
        }
        if (!value.run) return text(JSON.stringify(value, null, 2))
        const lines = [describeRun(value.run)]
        if (value.timedOut) {
          lines.push('', `仍在渲染（出片通常需要数分钟）。用 drama_render action=status runId=${value.run.id} 查询，或 action=cancel 中止。`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const action = args?.action
        if (action === 'status') {
          if (args.runId) {
            const run = api.runStatus(args.runId)
            return run ? { run } : { error: { code: 'not-found', message: `no run "${args.runId}"` } }
          }
          return { runs: api.runList({ limit: 20 }) }
        }
        if (action === 'cancel') {
          if (!args.runId) return { error: { code: 'bad-args', message: 'runId is required for cancel' } }
          return { ...api.runCancel(args.runId), runId: args.runId }
        }
        if (action === 'capacity') {
          return { capacity: true, status: await api.status({ fresh: args?.force === true }) }
        }
        if (!args?.projectId) return { error: { code: 'bad-args', message: '缺少 projectId：请先用 drama_project 查到项目 id。' } }

        const request = {
          projectId: args.projectId,
          entityIds: args.entityIds,
          shotIds: args.shotIds,
          clipIndexes: args.clipIndexes,
          force: args.force === true,
          mode: args.keyframeMode,
        }
        const started = action === 'reference' ? await api.startReferenceRun(request)
          : action === 'keyframe' ? await api.startKeyframeRun(request)
            : action === 'video' ? await api.startVideoRun(request)
              : { ok: false, error: { code: 'bad-action', message: `unknown action "${action}"` } }
        if (!started.ok) return started

        const waited = await waitForRun(api, started.runId, { waitMs: args.waitMs ?? 180000 })
        return waited.ok
          ? { run: waited.run, runId: started.runId, timedOut: waited.timedOut === true }
          : waited
      } catch (error) {
        return { error: { code: error?.code ?? 'failed', message: String(error?.message ?? error) } }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// drama_comfy
// ---------------------------------------------------------------------------

export function comfyTool(api) {
  return {
    name: 'drama_comfy',
    description: [
      'Inspect the local ComfyUI that renders this project: connection facts, GPU and memory headroom,',
      'the installed model files, which MiniMax-H3 weights auto-resolution picks, and which model the LLM stages use.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'test'], description: 'status reads the configured server; test probes a URL without saving it.' },
        baseUrl: { type: 'string', description: 'For action=test: the URL to probe.' },
        fresh: { type: 'boolean', description: 'Bypass the installed-model cache.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.error) return renderError(value)
        if (value.ok === false) return text(`ComfyUI unreachable: ${value.error?.message ?? 'unknown'}`)
        const h = value.health ?? value
        const capacity = value.capacity
        const lines = [
          `ComfyUI ${h.version ?? '?'} · ${(h.devices?.[0]?.name ?? 'no device')} · ${h.latencyMs ?? '?'}ms`,
          `VRAM free ${(Number(h.devices?.[0]?.vramFreeBytes ?? 0) / 1e9).toFixed(2)} GB / ${(Number(h.devices?.[0]?.vramTotalBytes ?? 0) / 1e9).toFixed(2)} GB`,
          `RAM free ${(Number(h.ramFreeBytes ?? 0) / 1e9).toFixed(2)} GB / ${(Number(h.ramTotalBytes ?? 0) / 1e9).toFixed(2)} GB`,
        ]
        if (capacity?.notes?.length) lines.push(`capacity: ${capacity.level} — ${capacity.notes.join(' ')}`)
        if (value.llm?.selection) {
          lines.push(`生成模型：${value.llm.selection.provider}/${value.llm.selection.model}（来源 ${value.llm.selection.source}）`)
        }
        if (value.models) {
          lines.push('', 'installed:')
          for (const [category, list] of Object.entries(value.models)) lines.push(`  ${category.padEnd(15)} ${list.length}`)
        }
        if (value.resolved) {
          lines.push('', 'auto-resolved:')
          for (const [stage, set] of Object.entries(value.resolved)) {
            lines.push(`  ${stage}: ${Object.entries(set).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ')}`)
          }
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        if (args?.action === 'test') return await api.testConnection(args.baseUrl)
        return await api.status({ fresh: args?.fresh === true })
      } catch (error) {
        return { ok: false, error: { code: 'failed', message: String(error?.message ?? error) } }
      }
    },
  }
}

/** @returns {{name:string, apply(ctx:object):void}} */
export function createToolsPlugin(api) {
  const definitions = [
    projectTool(api),
    scriptTool(api),
    castTool(api),
    storyboardTool(api),
    promptTool(api),
    renderTool(api),
    comfyTool(api),
  ]
  return {
    name: 'shortDramaTools',
    apply(ctx) {
      for (const definition of definitions) {
        ctx.effect(() => ctx.tools.register(definition), `shortdrama.tool.${definition.name}`)
      }
    },
  }
}

export default createToolsPlugin
