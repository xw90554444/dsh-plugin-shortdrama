/**
 * Background run registry.
 *
 * LLM stages and ComfyUI renders both take far longer than a comfortable HTTP
 * request, so nothing long-running happens inside a request. A caller starts a
 * run, gets an id immediately, and polls for progress. That also gives the UI a
 * live view of a render instead of a hung fetch.
 *
 * Runs are bounded and, unlike the first cut of this file, DURABLE. They began as
 * in-memory progress records on the argument that the artifacts are the real record
 * and the project document is the record of what was produced. That argument is
 * right about artifacts and wrong about the queue: the queue is what tells an
 * operator what they already asked for, and losing it on every restart makes the
 * panel look like nothing was ever run. The artifacts survive; the intent did not.
 *
 * Restoration has one honest obligation. A run persisted as `running` belonged to a
 * process that no longer exists, so it is restored as `interrupted` — not left
 * claiming to be in progress, and not silently deleted, because "this was asked for
 * and did not finish" is exactly what the operator needs to see.
 */

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted'])
const MAX_RETAINED = 40
/** Progress fires many times a second; writes are batched behind this. */
const SAVE_DEBOUNCE_MS = 800

export class RunCancelled extends Error {
  constructor() {
    super('run cancelled')
    this.name = 'RunCancelled'
    this.code = 'aborted'
  }
}

/**
 * @param {object} [options]
 * @param {object[]} [options.initial] records from a previous process
 * @param {(records: object[]) => void} [options.onChange] called with the full,
 *   serialisable list whenever something changes. Injected rather than hard-coded
 *   to a path so the registry stays testable without touching the disk.
 */
export function createRunRegistry(options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : null
  /** @type {Map<string, object>} */
  const runs = new Map()
  let timer = null
  let restoring = true

  for (const record of Array.isArray(options.initial) ? options.initial : []) {
    if (!record || typeof record.id !== 'string') continue
    const interrupted = record.status === 'running'
    runs.set(record.id, {
      ...record,
      status: interrupted ? 'interrupted' : record.status,
      phase: interrupted ? 'interrupted' : record.phase,
      message: interrupted ? '插件重启时中断' : record.message,
      error: interrupted
        ? { code: 'interrupted', message: '插件重启，这次运行被中断，产物可能不完整' }
        : record.error ?? null,
      finishedAt: interrupted ? Date.now() : record.finishedAt ?? null,
      // The controller belonged to the dead process and cannot be resumed.
      controller: null,
    })
  }
  restoring = false

  /** Serialisable projection: never leak the controller or a raw Error. */
  function record(run) {
    return {
      id: run.id,
      kind: run.kind,
      label: run.label,
      projectId: run.projectId,
      status: run.status,
      phase: run.phase,
      message: run.message,
      current: run.current,
      total: run.total,
      text: run.text,
      reasoning: run.reasoning,
      problems: run.problems,
      result: run.status === 'done' ? run.result : null,
      error: run.error ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
    }
  }

  function persistNow() {
    if (!onChange) return
    try {
      onChange([...runs.values()].map(record))
    } catch { /* persistence is best-effort; it must never break a render */ }
  }

  function scheduleSave() {
    if (!onChange || restoring) return
    if (timer) return
    timer = setTimeout(() => { timer = null; persistNow() }, SAVE_DEBOUNCE_MS)
    // Do not hold the event loop open for a progress write.
    timer.unref?.()
  }

  function prune() {
    if (runs.size <= MAX_RETAINED) return
    const finished = [...runs.values()]
      .filter((run) => TERMINAL.has(run.status))
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const run of finished) {
      if (runs.size <= MAX_RETAINED) break
      runs.delete(run.id)
    }
  }

  /** Public projection: never leak the controller or the raw error object. */
  function view(run) {
    return {
      id: run.id,
      kind: run.kind,
      label: run.label,
      projectId: run.projectId,
      status: run.status,
      phase: run.phase,
      message: run.message,
      current: run.current,
      total: run.total,
      text: run.text,
      reasoning: run.reasoning,
      problems: run.problems,
      result: run.status === 'done' ? run.result : null,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      elapsedMs: (run.finishedAt ?? Date.now()) - run.startedAt,
    }
  }

  // The restored list is written straight back, so a crash during restoration still
  // leaves the interrupted markers on disk.
  if (runs.size > 0) persistNow()

  return {
    /**
     * @param {object} spec
     * @param {string} spec.kind script|cast|storyboard|reference|keyframe|video
     * @param {string} spec.label human-readable, shown in the queue
     * @param {string} [spec.projectId]
     * @param {(context:{progress:(update:object)=>void, signal:AbortSignal, runId:string}) => Promise<unknown>} spec.work
     * @returns {string} runId
     */
    start(spec) {
      const id = `run-${globalThis.crypto.randomUUID().slice(0, 8)}`
      const controller = new AbortController()
      const run = {
        id,
        kind: spec.kind ?? 'task',
        label: spec.label ?? 'task',
        projectId: spec.projectId ?? null,
        status: 'running',
        phase: 'starting',
        message: '',
        current: 0,
        total: 0,
        text: '',
        reasoning: '',
        problems: [],
        result: null,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
        controller,
      }
      runs.set(id, run)
      prune()
      persistNow()

      const progress = (update = {}) => {
        if (TERMINAL.has(run.status)) return
        if (update.phase !== undefined) run.phase = update.phase
        if (update.message !== undefined) run.message = update.message
        if (update.current !== undefined) run.current = update.current
        if (update.total !== undefined) run.total = update.total
        if (update.text !== undefined) run.text = update.text
        if (update.reasoning !== undefined) run.reasoning = update.reasoning
        if (update.problems !== undefined) run.problems = update.problems
        scheduleSave()
      }

      // Detached on purpose: the caller only ever holds the id.
      Promise.resolve()
        .then(() => spec.work({ progress, signal: controller.signal, runId: id }))
        .then((result) => {
          if (run.status === 'cancelled') return
          run.status = 'done'
          run.phase = 'done'
          run.result = result ?? null
        })
        .catch((error) => {
          if (run.status === 'cancelled') return
          run.status = 'failed'
          run.phase = 'failed'
          run.error = {
            code: error?.code ?? 'error',
            message: String(error?.message ?? error),
          }
        })
        .finally(() => {
          run.finishedAt = Date.now()
          run.controller = null
          // A finished run is worth writing immediately: it is the state an operator
          // most needs to survive a restart.
          if (timer) { clearTimeout(timer); timer = null }
          persistNow()
        })

      return id
    },

    /** @param {string} id */
    get(id) {
      const run = runs.get(id)
      return run ? view(run) : null
    },

    /** Newest first. */
    list({ limit = 20 } = {}) {
      return [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map(view)
    },

    /** @param {string} id */
    cancel(id) {
      const run = runs.get(id)
      if (!run) return { ok: false, error: { code: 'not-found', message: `no run "${id}"` } }
      if (TERMINAL.has(run.status)) return { ok: false, error: { code: 'already-finished', message: `run ${id} already ${run.status}` } }
      run.status = 'cancelled'
      run.phase = 'cancelled'
      run.message = 'cancelled by request'
      run.finishedAt = Date.now()
      try { run.controller?.abort() } catch { /* already gone */ }
      run.controller = null
      if (timer) { clearTimeout(timer); timer = null }
      persistNow()
      return { ok: true }
    },

    /** Abort everything; used on plugin unload so work does not outlive the fiber. */
    dispose() {
      for (const run of runs.values()) {
        if (TERMINAL.has(run.status)) continue
        run.status = 'cancelled'
        run.phase = 'cancelled'
        run.error = { code: 'aborted', message: 'plugin unloaded' }
        run.finishedAt = Date.now()
        try { run.controller?.abort() } catch { /* already gone */ }
        run.controller = null
      }
      // Written before clearing, so a deliberate unload records that the work stopped
      // rather than leaving `running` on disk for the next start to call interrupted.
      if (timer) { clearTimeout(timer); timer = null }
      persistNow()
      runs.clear()
    },
  }
}

export default createRunRegistry
