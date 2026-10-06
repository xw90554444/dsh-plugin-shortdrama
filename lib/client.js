/**
 * ShortDrama Studio — client half.
 *
 * Loaded as a combo script through `window.__ModuleLoader__`. It talks to the
 * host half over the plugin's own web route (there is no client service for
 * package-private RPC, and Typert remote descriptors would be far heavier than
 * this UI needs). The per-process token is injected into the shell page by the
 * host, so only a page the harness actually served can reach the route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-shortdrama',
  factory: function (require) {
    'use strict'
    const React = require('react')
    const h = React.createElement

    /**
     * The script-capacity figure, mirrored from `lib/pipeline/compile.js`.
     *
     * Mirrored so the panel can show it without a round trip, and kept line-for-line identical to
     * the host on purpose: a first version returned early for an empty script and reported
     * `shotsNeeded: 0` where the host said 15, which `verify-render.mjs` caught as drift. The host
     * also returns its own `scriptCapacity` in the compile result, and the panel prefers that —
     * this is the fallback for the moment before the compile lands.
     */
    function scriptCapacity(script, targetSec, secondsPerShot = 4) {
      const scenes = Array.isArray(script?.scenes) ? script.scenes : []
      const beats = Array.isArray(script?.beats) ? script.beats : []
      let dialogueLines = 0
      for (const scene of scenes) {
        for (const line of Array.isArray(scene?.dialogue) ? scene.dialogue : []) {
          if (String(line?.line ?? '').trim()) dialogueLines += 1
        }
      }
      const target = Math.max(0, Number(targetSec) || 0)
      const shotsNeeded = secondsPerShot > 0 ? Math.round(target / secondsPerShot) : 0
      const shotsAvailable = scenes.reduce((n, scene) => {
        const lines = Array.isArray(scene?.dialogue) ? scene.dialogue.filter((l) => String(l?.line ?? '').trim()).length : 0
        return n + 3 + lines
      }, 0)
      const coverage = shotsNeeded > 0 ? Math.min(1, shotsAvailable / shotsNeeded) : 1
      return {
        scenes: scenes.length,
        beats: beats.length,
        dialogueLines,
        targetSec: target,
        shotsNeeded,
        shotsAvailable,
        coverage: Math.round(coverage * 100) / 100,
        secondsPerShot,
      }
    }

    // ---------------------------------------------------------------- theming

    const CSS = `
.sd-root{--sd-ink:var(--dsw-alias-label-primary,light-dark(#0f1115,#f9fafb));
--sd-muted:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));
--sd-line:var(--dsw-alias-border-l2,light-dark(#0000001a,#ffffff1f));
--sd-line-strong:var(--dsw-alias-border-l3,light-dark(#0000001f,#ffffff29));
--sd-surface:var(--dsw-alias-bg-module-platform,light-dark(#f9fafb,#353638));
--sd-surface-2:var(--dsw-specific-menu,light-dark(#f8f9fa,#2b2c2e));
--sd-accent:var(--dsw-alias-brand-primary,light-dark(#0f1115,#f9fafb));
--sd-accent-ink:var(--dsw-alias-label-primary-foreground,light-dark(#fff,#0f1115));
--sd-hover:var(--dsw-alias-interactive-bg-hover,light-dark(#2631480f,#ffffff14));
--sd-warn:light-dark(#8a5a00,#f0b429);--sd-err:light-dark(#b3261e,#ff8a80);--sd-ok:light-dark(#1a7f4b,#5ddc9a);
color:var(--sd-ink);display:flex;flex-direction:column;min-height:0;font-size:13px;line-height:1.55}
.sd-root[data-fill="1"]{height:100%}
.sd-root *{box-sizing:border-box}
.sd-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--sd-line);flex:0 0 auto;flex-wrap:wrap}
.sd-title{font-weight:600;font-size:14px;margin-right:auto;display:flex;align-items:center;gap:8px}
.sd-tabs{display:flex;gap:2px;padding:8px 14px 0;border-bottom:1px solid var(--sd-line);flex:0 0 auto;flex-wrap:wrap}
.sd-tab{appearance:none;border:0;background:transparent;color:var(--sd-muted);padding:6px 11px;border-radius:7px 7px 0 0;cursor:pointer;font:inherit;position:relative}
.sd-tab:hover{background:var(--sd-hover);color:var(--sd-ink)}
.sd-tab[data-on="1"]{color:var(--sd-ink);font-weight:600}
.sd-tab[data-on="1"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--sd-accent);border-radius:2px}
.sd-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px}
.sd-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--sd-line-strong);background:var(--sd-surface);
color:var(--sd-ink);padding:5px 11px;border-radius:7px;white-space:nowrap}
.sd-btn:hover:not(:disabled){background:var(--sd-hover)}
.sd-btn:disabled{opacity:.5;cursor:default}
.sd-btn[data-variant="primary"]{background:var(--sd-accent);color:var(--sd-accent-ink);border-color:transparent;font-weight:600}
.sd-btn[data-size="sm"]{padding:3px 8px;font-size:12px;border-radius:6px}
/* Press acknowledgement. The disabled state above drops opacity to .5, which would mute exactly the
   button the operator is watching — so a pending or acknowledged button stays full strength and is
   marked by border and colour instead. */
.sd-btn[data-state="pending"],.sd-btn[data-state="done"]{opacity:1}
.sd-btn[data-state="pending"]{border-color:var(--sd-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--sd-accent) 28%,transparent)}
.sd-btn[data-state="done"]{border-color:var(--sd-ok);color:var(--sd-ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--sd-ok) 26%,transparent)}
.sd-btn[data-state="done"][data-variant="primary"]{color:var(--sd-accent-ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--sd-ok) 55%,transparent)}
.sd-field > label,.sd-field-label{white-space:nowrap}
.sd-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.sd-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.sd-field>label{font-size:11px;color:var(--sd-muted);font-weight:600;letter-spacing:.02em}
.sd-input,.sd-select,.sd-textarea{font:inherit;color:var(--sd-ink);background:var(--sd-surface);border:1px solid var(--sd-line-strong);
border-radius:7px;padding:5px 8px;min-width:0;width:100%}
.sd-textarea{resize:vertical;min-height:60px;font-family:inherit}
.sd-input:focus,.sd-select:focus,.sd-textarea:focus{outline:2px solid var(--sd-accent);outline-offset:-1px}
.sd-card{border:1px solid var(--sd-line);border-radius:10px;background:var(--sd-surface-2);padding:12px;margin-bottom:10px}
.sd-card>h3{margin:0 0 8px;font-size:13px;font-weight:600}
.sd-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;
border:1px solid var(--sd-line-strong);color:var(--sd-muted);white-space:nowrap}
.sd-badge[data-tone="ok"]{color:var(--sd-ok);border-color:currentColor}
.sd-badge[data-tone="warn"]{color:var(--sd-warn);border-color:currentColor}
.sd-badge[data-tone="err"]{color:var(--sd-err);border-color:currentColor}
.sd-pre{margin:0;padding:10px;border-radius:8px;background:var(--sd-surface);border:1px solid var(--sd-line);
white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
font-size:12px;line-height:1.6;max-height:440px;overflow:auto}
.sd-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:12px}
.sd-kv dt{color:var(--sd-muted)}
.sd-kv dd{margin:0;font-variant-numeric:tabular-nums}
.sd-empty{padding:36px 16px;text-align:center;color:var(--sd-muted)}
.sd-err{padding:10px 12px;border-radius:8px;border:1px solid var(--sd-err);color:var(--sd-err);margin-bottom:10px;white-space:pre-wrap}
.sd-hint{font-size:12px;color:var(--sd-muted);margin:6px 0 0}
.sd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:9px}
.sd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.sd-clip-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:7px}
.sd-clip-head strong{font-size:13px}
.sd-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--sd-line-strong);border-top-color:var(--sd-accent);
border-radius:50%;animation:sd-rot .7s linear infinite;vertical-align:-1px}
@keyframes sd-rot{to{transform:rotate(360deg)}}
.sd-scroll-x{overflow-x:auto}
/* Draggable panel heights — same gesture and look as 角色多视图, so it is learned once. */
.sd-gripwrap{display:flex;flex-direction:column;min-height:0}
.sd-grip{height:14px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;
touch-action:none;user-select:none;border-radius:6px;flex:0 0 auto}
.sd-grip:hover,.sd-grip[data-dragging="1"]{background:var(--sd-hover)}
.sd-grip>i{display:block;width:38px;height:3px;border-radius:999px;background:var(--sd-line-strong)}
.sd-grip:hover>i,.sd-grip[data-dragging="1"]>i{background:var(--sd-muted)}
.sd-grip:focus-visible{outline:2px solid var(--sd-accent);outline-offset:-2px}
.sd-grip-body{overflow:auto;min-height:0;overscroll-behavior:contain;padding-right:2px}
.sd-grip-foot{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--sd-muted);
padding-top:5px;border-top:1px solid var(--sd-line);flex:0 0 auto}
/* Labels centred over their control, for rows of equal-weight settings. */
.sd-labels-centered .sd-field{align-items:center}
.sd-labels-centered .sd-field > label{text-align:center;width:100%}
.sd-labels-centered .sd-select{min-width:0}
.sd-table{border-collapse:collapse;width:100%;font-size:12px}
.sd-table th,.sd-table td{border-bottom:1px solid var(--sd-line);padding:5px 8px;text-align:left;vertical-align:top}
.sd-table th{color:var(--sd-muted);font-weight:600;white-space:nowrap;position:sticky;top:0;background:var(--sd-surface-2);z-index:1}
.sd-table td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.sd-table td.nowrap{white-space:nowrap}
/* Wide enough for a spoken line, and free to wrap rather than push the table out. */
.sd-table td.dialogue{min-width:240px;max-width:420px;white-space:normal}
/* The action column absorbs the slack so every narrow column shrinks to its own
   content. Per-cell min-widths across eleven columns added up to more than the
   panel was wide, which pushed the composition selects and the action box past
   the right edge and made the table scroll sideways for no reason. */
.sd-table td.wide{width:100%}
.sd-table th{max-width:160px;overflow:hidden;text-overflow:ellipsis}
.sd-thumb{width:86px;height:86px;object-fit:contain;border-radius:6px;border:1px solid var(--sd-line);display:block;background:var(--sd-surface)}
.sd-thumb-empty{width:86px;height:86px;border-radius:6px;border:1px dashed var(--sd-line-strong);display:flex;
align-items:center;justify-content:center;color:var(--sd-muted);font-size:11px}
.sd-video{width:100%;max-height:320px;border-radius:8px;border:1px solid var(--sd-line);background:#000;display:block}
.sd-bar{height:4px;border-radius:2px;background:var(--sd-line);overflow:hidden;margin-top:6px}
.sd-bar>i{display:block;height:100%;background:var(--sd-accent);transition:width .4s}
.sd-run{border:1px solid var(--sd-line);border-radius:8px;padding:9px 11px;margin-bottom:7px;background:var(--sd-surface-2)}
.sd-run[data-status="failed"]{border-color:var(--sd-err)}
/* The queue is bounded. Appending every finished run straight into the card made the
   page grow without limit — ten renders pushed everything below them off-screen, so
   the panels an operator actually needed ended up somewhere past the scroll. The cap
   is a viewport fraction as well as a pixel value so a short window does not lose half
   its height to history. */
.sd-prompt{white-space:pre-wrap;word-break:break-word;margin:0;padding:10px;font-size:11px;line-height:1.65;max-height:320px;overflow:auto;background:var(--sd-bg);border:1px solid var(--sd-line);border-radius:6px;color:var(--sd-fg)}
/* Bounded and scrollable like the queue, so a long history browses in place
   instead of stretching the page. */
.sd-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;align-items:start;max-height:min(46vh,420px);overflow-y:auto;overscroll-behavior:contain;padding-right:3px}
.sd-gallery::-webkit-scrollbar{width:8px}
.sd-gallery::-webkit-scrollbar-track{background:transparent}
.sd-gallery::-webkit-scrollbar-thumb{background:var(--sd-line);border-radius:4px}
.sd-gallery::-webkit-scrollbar-thumb:hover{background:var(--sd-muted)}
.sd-tile{margin:0;display:flex;flex-direction:column;gap:3px;min-width:0;align-self:start}
/* Natural aspect, never cropped. A forced 9/16 with object-fit:cover cut the
   landscape sheets — the character turnarounds are 4:3 — down to their middle
   third, so the one image whose whole point is three figures side by side showed
   one and a bit. */
.sd-tile img{width:100%;height:auto;object-fit:contain;border-radius:6px;border:1px solid var(--sd-line);background:var(--sd-surface);display:block;cursor:zoom-in}
.sd-tile img:hover{border-color:var(--sd-accent)}
.sd-tile-bar{display:flex;align-items:center;gap:4px;min-width:0}
.sd-tile-label{flex:1 1 auto;min-width:0;font-size:10px;color:var(--sd-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-tile-bar .sd-btn{padding:1px 4px;font-size:11px;line-height:1.2}
.sd-tile figcaption{font-size:10px;color:var(--sd-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-thumb-time{font-size:10px;color:var(--sd-muted);font-variant-numeric:tabular-nums}
.sd-split{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
/* The panel is often narrower than two readable columns; below that they stack,
   which is the only way both stay usable. */
@media (max-width: 980px){.sd-split{grid-template-columns:1fr}}
.sd-queue{max-height:min(46vh,420px);overflow-y:auto;overscroll-behavior:contain;padding-right:3px}
/* The last card's margin would otherwise sit inside the scroll box as dead space. */
.sd-queue .sd-run:last-child{margin-bottom:0}
.sd-queue::-webkit-scrollbar{width:8px}
.sd-queue::-webkit-scrollbar-track{background:transparent}
.sd-queue::-webkit-scrollbar-thumb{background:var(--sd-line);border-radius:4px}
.sd-queue::-webkit-scrollbar-thumb:hover{background:var(--sd-muted)}
.sd-stream{margin-top:6px;max-height:150px;overflow:auto;font-size:11px;color:var(--sd-muted);white-space:pre-wrap;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.sd-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.sd-shot{display:flex;gap:10px;align-items:flex-start}
.sd-shot-img{flex:0 0 auto}
.sd-shot-body{flex:1 1 auto;min-width:0}
.sd-pill{font-size:11px;padding:1px 6px;border-radius:5px;background:var(--sd-hover);color:var(--sd-muted);white-space:nowrap}
/* Pipeline stepper: the five stages read as one flow, not five unrelated screens. */
.sd-steps{display:flex;align-items:stretch;gap:0;padding:10px 14px;border-bottom:1px solid var(--sd-line);
flex:0 0 auto;overflow-x:auto}
.sd-step{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;background:transparent;
color:var(--sd-muted);display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;white-space:nowrap}
.sd-step:hover{background:var(--sd-hover);color:var(--sd-ink)}
.sd-step[data-on="1"]{background:var(--sd-surface);border-color:var(--sd-line-strong);color:var(--sd-ink);font-weight:600}
.sd-step[data-state="done"] .sd-step-num{background:var(--sd-ok);color:var(--sd-accent-ink);border-color:transparent}
.sd-step[data-state="next"]{color:var(--sd-ink)}
.sd-step[data-state="next"] .sd-step-num{border-color:var(--sd-ink);font-weight:700}
.sd-step[data-running="1"]{color:var(--sd-warn)}
.sd-step-num[data-plain="1"]{border-style:dashed;font-size:9px}
.sd-step-num{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;
border-radius:50%;border:1px solid var(--sd-line-strong);font-size:11px;flex:0 0 auto}
.sd-step-arrow{color:var(--sd-line-strong);align-self:center;flex:0 0 auto;padding:0 2px;user-select:none}
.sd-lightbox{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:24px}
.sd-lightbox-body{display:flex;flex-direction:column;gap:8px;max-width:min(92vw,1200px);max-height:92vh;overflow:auto;background:var(--sd-surface);border:1px solid var(--sd-line-strong);border-radius:12px;padding:12px}
.sd-lightbox-img{max-width:100%;max-height:70vh;object-fit:contain;display:block;border-radius:8px;background:#000}
.sd-lightbox-meta{font-size:12px;color:var(--sd-muted)}
.sd-ctxmenu{position:fixed;z-index:10000;min-width:150px;padding:4px;background:var(--sd-surface);
border:1px solid var(--sd-line-strong);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;flex-direction:column}
.sd-ctxmenu-item{appearance:none;font:inherit;font-size:12px;text-align:left;background:transparent;border:0;color:var(--sd-ink);padding:7px 10px;border-radius:5px;cursor:pointer}
.sd-ctxmenu-item:hover:not([disabled]){background:var(--sd-hover)}
.sd-ctxmenu-item[disabled]{opacity:.4;cursor:default}
.sd-thumb[data-zoom="1"]{cursor:zoom-in}
.sd-confirm{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;padding:10px 12px;
border-radius:8px;border:1px solid var(--sd-err);color:var(--sd-err);font-size:12px}
/* The render confirmation. Accent-coloured rather than red: it is a checkpoint before a long job, not
   an error, and reusing the error styling would make every render start look like something broke.
   The confirm and cancel buttons are pushed to the right so the reading order is
   "what will happen" -> "the decision". */
.sd-confirm-ask{border-color:var(--sd-accent);color:var(--sd-ink);align-items:flex-start;
background:color-mix(in srgb,var(--sd-accent) 7%,transparent)}
.sd-confirm-ask > .sd-btn:first-of-type{margin-left:auto}
.sd-next{margin:0 0 12px;padding:9px 12px;border-radius:8px;border:1px dashed var(--sd-line-strong);
color:var(--sd-muted);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
`

    let styleInstalled = false
    function ensureStyles() {
      if (styleInstalled || typeof document === 'undefined') return
      styleInstalled = true
      const element = document.createElement('style')
      element.setAttribute('data-shortdrama', '')
      element.textContent = CSS
      document.head.append(element)
    }

    // ------------------------------------------------------------ transport

    function bridge() {
      const injected = globalThis.__SHORTDRAMA__
      if (!injected?.token) {
        // Reachable whenever the host half never wired its web route (for example
        // a load-order miss) — in that state every call below would fail, so say
        // what is actually wrong instead of "token missing".
        const error = new Error(
          '插件后端未就绪：页面里没有注入访问令牌。\n\n'
          + '这通常意味着宿主半边没有注册 Web 路由（可能是插件加载顺序问题）。\n'
          + '请先重启 DeepSeek Harness；仍不行就说明是插件缺陷，而不是你的操作问题。',
        )
        error.code = 'host-not-ready'
        throw error
      }
      return injected
    }

    async function call(method, path, body) {
      const { token, prefix } = bridge()
      const response = await fetch(`${prefix}${path}`, {
        method,
        headers: {
          'x-shortdrama-token': token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`ShortDrama: ${method} ${path} returned a non-JSON response (HTTP ${response.status})`)
      }
      if (payload?.error?.message && payload.ok !== true) {
        const error = new Error(payload.error.message)
        error.code = payload.error.code
        error.problems = payload.error.problems
        throw error
      }
      if (!response.ok) throw new Error(`ShortDrama: ${method} ${path} failed with HTTP ${response.status}`)
      return payload
    }

    const api = {
      status: (fresh) => call('GET', `/status${fresh ? '?fresh=1' : ''}`),
      // The route already served GET /config; only the write side was wired up, so the panel could
      // change settings but never read the ones it had saved. The draggable panel heights are the
      // first setting that has to SURVIVE a reload to be worth anything.
      loadConfig: () => call('GET', '/config'),
      saveConfig: (patch) => call('POST', '/config', { patch }),
      test: (baseUrl) => call('POST', '/test', { baseUrl }),
      listProjects: () => call('GET', '/projects'),
      consumption: () => call('GET', '/consumption'),
      getProject: (id) => call('GET', `/projects/${encodeURIComponent(id)}`),
      createProject: (input) => call('POST', '/projects', input),
      updateProject: (id, patch) => call('POST', `/projects/${encodeURIComponent(id)}`, patch),
      // Was missing entirely, which is why delete never worked: every other
      // project method existed, so the call site looked plausible.
      removeProject: (id) => call('POST', `/projects/${encodeURIComponent(id)}/delete`),
      compile: (request) => call('POST', '/compile', request),
      exportPrompts: (request) => call('POST', '/export', request),
      generate: (kind, request) => call('POST', `/generate/${kind}`, request),
      render: (kind, request) => call('POST', `/render/${kind}`, request),
      upload: (request) => call('POST', '/upload', request),
      restyle: (request) => call('POST', '/restyle', request),
      merge: (request) => call('POST', '/merge', request),
      reveal: (request) => call('POST', '/reveal', request),
      runs: () => call('GET', '/runs'),
      run: (id) => call('GET', `/runs/${encodeURIComponent(id)}`),
      cancelRun: (id) => call('POST', `/runs/${encodeURIComponent(id)}/cancel`),
    }

    /** `<img>`/`<video>` cannot send headers, so asset reads carry the token in the query. */
    function assetUrl(projectId, assetId) {
      const { token, prefix } = bridge()
      return `${prefix}/asset/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}?t=${encodeURIComponent(token)}`
    }

    // ------------------------------------------------------------- utilities

    /**
     * The option lists the five output selectors need, available from the first render.
     *
     * These mirror `RESOLUTION_TIERS`, `RATIOS` and `STYLE_PRESETS` in the host half, and they exist
     * because the selectors must render BEFORE anything has been fetched. They previously drew their
     * options only from `compiled` (null until a project has shots) and `catalogues` (an async round
     * trip), and rendered NOTHING while both were empty — so a new project's 剧本 tab was missing
     * 画面风格 and 画面比例 outright, which reads as a broken panel rather than a slow one.
     *
     * `verify-render.mjs` compares every entry against the host module, so a duplicated list cannot
     * silently drift from the one the renderer actually uses.
     *
     * A style preset is not a mode: picking one writes `fragment` into `project.style`, which is why
     * only the fragment matters downstream and the label is cosmetic.
     */
    const CATALOGUE_FALLBACK = {
      resolutionTiers: [
        { key: '480p', label: '480P', megapixels: 0.4 },
        { key: '720p', label: '720P', megapixels: 0.9 },
        { key: '1080p', label: '1080P', megapixels: 2 },
        { key: '2k', label: '2K', megapixels: 3.7 },
      ],
      ratios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', '9:21', '3:2', '2:3'],
      stylePresets: [
        { key: 'cinematic', label: '电影质感', fragment: 'cinematic realism, natural lighting, shallow depth of field, 35mm anamorphic, subtle film grain, low-key contrast, motivated practical light sources, muted desaturated palette, 2.39:1 framing sensibility' },
        { key: 'mv', label: 'MV / 音乐录影', fragment: 'stylised music-video look, saturated colour grading, hard coloured key lights, neon and gel accents, strong rim light, glossy skin highlights, high contrast, bold graphic composition, fashion-editorial energy' },
        { key: 'japanese', label: '日系清新', fragment: 'Japanese natural-light aesthetic, soft diffused daylight, airy low-contrast exposure, pale desaturated palette with warm skin tones, gentle backlight and lens flare, clean uncluttered space, nostalgic quiet mood' },
        { key: 'hkretro', label: '港片复古', fragment: '1990s Hong Kong cinema, humid night streets, neon signage reflecting on wet asphalt, warm tungsten and green fluorescent mix, heavy film grain, deep shadows, saturated cyan and amber, handheld intimacy' },
        { key: 'noir', label: '黑色电影', fragment: 'film noir, high-contrast chiaroscuro lighting, hard directional key with deep black shadow, venetian-blind patterns, smoke haze in the light beam, cold desaturated palette, moral-weight atmosphere' },
        { key: 'documentary', label: '纪录片', fragment: 'observational documentary look, available light only, no staged lighting, handheld camera, natural imperfect framing, honest skin texture, minimal grading, real locations with lived-in detail' },
        { key: 'commercial', label: '广告质感', fragment: 'premium commercial photography, immaculate controlled lighting, large soft source with precise fill, high-key clean background, saturated but accurate colour, razor-sharp product-grade detail, glossy finish' },
        { key: 'guofeng', label: '国风古装', fragment: 'classical Chinese aesthetic, ink-wash tonality, soft directional daylight through gauze, silk and lacquer textures, restrained palette of ink black, rice white and cinnabar red, mist and negative space, poetic stillness' },
        { key: 'warmfamily', label: '生活温情', fragment: 'warm domestic realism, golden practical lamps, soft window light, cosy cluttered detail, amber and cream palette, gentle shallow focus, unstaged candid framing, tender everyday atmosphere' },
        { key: 'thriller', label: '悬疑惊悚', fragment: 'contemporary thriller, cold clinical palette of steel blue and sickly green, underlit interiors, hard sidelight with heavy falloff, negative space around the subject, shallow focus on detail, uneasy stillness' },
      ],
    }

    const gb = (bytes) => (Number.isFinite(Number(bytes)) ? `${(Number(bytes) / 1e9).toFixed(2)} GB` : '—')

    function useAsync(operation, deps) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const [nonce, setNonce] = React.useState(0)
      React.useEffect(() => {
        let live = true
        setState((previous) => ({ ...previous, loading: true, error: null }))
        Promise.resolve()
          .then(operation)
          .then((data) => { if (live) setState({ loading: false, data, error: null }) })
          .catch((error) => { if (live) setState({ loading: false, data: null, error }) })
        return () => { live = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, nonce])
      return [state, () => setNonce((n) => n + 1)]
    }

    /**
     * Poll the run list while anything is active, so the studio shows live
     * progress without the user having to refresh.
     *
     * Also serves as the host-version handshake. The client bundle is served from
     * disk on every page load, so it can be newer than the already-imported host
     * module; Node caches ESM by resolved URL, so editing the host half does not
     * take effect until DSH restarts. The run routes only exist in the newer host,
     * so a `no-route` response here means exactly that mismatch — worth saying
     * plainly instead of failing feature by feature.
     */
    function useRuns(intervalMs = 1500) {
      const [runs, setRuns] = React.useState([])
      const [error, setError] = React.useState(null)
      const [mismatch, setMismatch] = React.useState(false)
      React.useEffect(() => {
        let live = true
        let timer = null
        const tick = async () => {
          try {
            const payload = await api.runs()
            if (!live) return
            setRuns(payload.runs ?? [])
            setError(null)
            setMismatch(false)
            const active = (payload.runs ?? []).some((run) => run.status === 'running')
            timer = setTimeout(tick, active ? Math.max(800, intervalMs) : 4000)
          } catch (err) {
            if (!live) return
            if (err?.code === 'no-route') setMismatch(true)
            else setError(err)
            timer = setTimeout(tick, 8000)
          }
        }
        tick()
        return () => { live = false; if (timer) clearTimeout(timer) }
      }, [intervalMs])
      return [runs, error, mismatch]
    }

    function CopyButton({ text, label = '复制' }) {
      const [done, setDone] = React.useState(false)
      return h('button', {
        type: 'button',
        className: 'sd-btn',
        'data-size': 'sm',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(text)
            setDone(true)
            setTimeout(() => setDone(false), 1400)
          } catch { setDone(false) }
        },
      }, done ? '已复制' : label)
    }

    const Badge = ({ tone, children }) => h('span', { className: 'sd-badge', 'data-tone': tone }, children)
    const Spinner = ({ label }) => h('span', { style: { color: 'var(--sd-muted)' } }, h('span', { className: 'sd-spin' }), ` ${label ?? '加载中…'}`)

    /**
     * Catches a render error so ONE broken panel does not take the whole studio with
     * it.
     *
     * Twice now a single component threw and the entire studio went black with no
     * message — the shell's own boundary caught it and reported to a console the
     * operator has no reason to open. An error boundary here turns that into a card
     * that names the failure and keeps every other tab usable.
     */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        // Kept as well as shown: the stack names the component, which the message
        // alone often does not.
        console.error('[短剧工作室] 面板渲染失败', error, info)
      }

      render() {
        if (!this.state.error) return this.props.children
        const error = this.state.error
        return h('div', { className: 'sd-card', style: { borderColor: 'var(--sd-err)' } },
          h('h3', { style: { color: 'var(--sd-err)' } }, `${this.props.name ?? '这个页面'}渲染失败`),
          h('p', { style: { margin: '6px 0 0' } }, String(error?.message ?? error)),
          h('details', { style: { marginTop: 8 } },
            h('summary', { style: { cursor: 'pointer', color: 'var(--sd-muted)', fontSize: 12 } }, '技术细节（发给我就能定位）'),
            h('pre', { className: 'sd-pre', style: { marginTop: 6, maxHeight: 200 } },
              String(error?.stack ?? ''))),
          h('p', { className: 'sd-hint', style: { marginTop: 8 } },
            '其它页签仍然可用。把上面的技术细节发我即可。'))
      }
    }

    function Field({ label, hint, children }) {
      return h('div', { className: 'sd-field' },
        h('label', null, label),
        children,
        hint ? h('p', { className: 'sd-hint' }, hint) : null)
    }

    /**
     * A panel whose height the operator sets by dragging a bar above it.
     *
     * Used for 成片 and the 片段 table, because they are the same problem: a collection that grows
     * with the amount of work done, inside a page that must not grow with it. Before this, a board
     * of eighty shots pushed the rest of the 出片 tab off the screen, and there was no way to make
     * the video strip taller without zooming the whole window.
     *
     * Matches the behaviour of the same control in 角色多视图 deliberately, so the gesture is
     * learned once. Three things it has to get right:
     *
     *  - The height belongs to the USER, not the content. An unbounded region pushes whatever is
     *    below it out of view.
     *  - The drag is driven by pointer DELTAS, never by the pointer's absolute position: the grab
     *    bar moves as it is dragged, so reading `clientY` directly feeds the bar's own movement
     *    into the next calculation and the drag runs away.
     *  - The bar sits ABOVE the region. Dragging up makes it taller, which is one line of
     *    arithmetic (`start - current`) and would be a minute of confusion if inverted.
     */
    function GripPanel(props) {
      const {
        children, height, onResizeEnd, min, max, defaultHeight,
        label, hint, footerLeft, footerRight, empty,
      } = props
      const [dragging, setDragging] = React.useState(false)
      const [live, setLive] = React.useState(height)

      // The end-of-drag value lives in a ref because the pointer-up handler closes over the state
      // of the render that STARTED the drag, where `live` is already stale.
      const liveRef = React.useRef(live)
      React.useEffect(() => { liveRef.current = live }, [live])
      React.useEffect(() => { setLive(height) }, [height])

      const lo = Number(min) > 0 ? Number(min) : 120
      const hi = Number(max) > lo ? Number(max) : 900
      const clamp = (value) => Math.max(lo, Math.min(hi, Math.round(value)))
      // `defaultHeight: 0` means "there is no magic number to go back to".
      const hasDefault = Number(defaultHeight) > 0

      function beginDrag(event) {
        event.preventDefault()
        const startY = event.clientY
        const startHeight = liveRef.current
        setDragging(true)
        const target = event.currentTarget
        try { target.setPointerCapture?.(event.pointerId) } catch { /* capture is a nicety */ }

        const onMove = (moveEvent) => {
          // Dragging UP is a negative delta and must GROW the panel, hence `start - current`.
          const next = clamp(startHeight + (startY - moveEvent.clientY))
          setLive(next)
        }
        const onUp = () => {
          setDragging(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          try { target.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
          onResizeEnd?.(liveRef.current)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      return h('div', { className: 'sd-gripwrap' },
        h('div', {
          className: 'sd-grip',
          'data-dragging': dragging ? '1' : '0',
          role: 'separator',
          'aria-orientation': 'horizontal',
          'aria-label': `拖动以调整${label ?? '面板'}高度`,
          'aria-valuenow': live,
          'aria-valuemin': lo,
          'aria-valuemax': hi,
          tabIndex: 0,
          title: hasDefault ? '上下拖动调整高度（双击恢复默认）' : '上下拖动调整高度',
          onPointerDown: beginDrag,
          onDoubleClick: () => { if (hasDefault) onResizeEnd?.(clamp(defaultHeight)) },
          onKeyDown: (event) => {
            // Keyboard-accessible, because a pointer-only control is one some people cannot use at
            // all. 16px steps, 64px with Shift — the same as 角色多视图.
            const step = event.shiftKey ? 64 : 16
            if (event.key === 'ArrowUp') { event.preventDefault(); onResizeEnd?.(clamp(live + step)) }
            if (event.key === 'ArrowDown') { event.preventDefault(); onResizeEnd?.(clamp(live - step)) }
          },
        }, h('i', null)),
        hint ? h('p', { className: 'sd-hint', style: { margin: '0 0 4px' } }, hint) : null,
        h('div', { className: 'sd-grip-body', style: { height: live } },
          React.Children.count(children) === 0 ? (empty ?? null) : children),
        h('div', { className: 'sd-grip-foot' },
          h('span', null, footerLeft ?? `${live}px`),
          h('span', { style: { flex: '1 1 auto' } }),
          footerRight ?? null,
          hasDefault ? h('button', {
            className: 'sd-btn', 'data-size': 'sm',
            onClick: () => onResizeEnd?.(clamp(defaultHeight)),
          }, '默认高度') : null))
    }

    /**
     * The render preset picker.
     *
     * A named component rather than inline markup, for a practical reason: at this nesting depth
     * (`h('div', …, h('div', …, h('select', …, map(h('option')))))`) counting the closing brackets by
     * hand went wrong four times in a row, each time with a confident explanation. Extracting it
     * removes the nesting from the call site entirely.
     *
     * This is also the setting that decides whether 武打/跳舞 smears: turbo sampling at 8 steps is a
     * distillation shortcut, and fast motion is exactly what it gives up. So it sits on the 出片 tab
     * always visible — the first version lived inside a warning card that appeared only when the
     * board contained detected action under a turbo preset, which meant that on a quiet project the
     * control was simply absent and "where is the quality mode" had no answer.
     */
    /**
     * A render button that confirms it was pressed.
     *
     * Clicking 出片 starts a job that runs for minutes and the panel's only acknowledgement was a
     * line of text at the BOTTOM of the panel, far from the button and easy to miss — so "did that
     * register?" was a fair question. This ticks the button itself, immediately, and keeps a spinner
     * on it for as long as the render runs.
     *
     * `busy` is run-wide, so `pending` distinguishes "this button started it" from "something else is
     * running" — without it, all four buttons would light up together.
     */
    function RenderAction(props) {
      const { label, onRun, disabled, pending, done, title, busy, variant, size } = props
      const [ticked, setTicked] = React.useState(false)
      React.useEffect(() => {
        if (!done) return undefined
        setTicked(true)
        const timer = setTimeout(() => setTicked(false), 2600)
        return () => clearTimeout(timer)
      }, [done])
      return h('button', {
        className: 'sd-btn',
        'data-variant': variant,
        'data-size': size,
        'data-state': ticked ? 'done' : pending ? 'pending' : undefined,
        disabled,
        title,
        onClick: onRun,
      },
      // The tick is a character, not an icon font: nothing to load, and it survives a missing font.
      ticked ? '✓ ' : pending ? '⏳ ' : '',
      label,
      pending ? ' · 运行中' : ticked ? ' · 已开始' : '')
    }

    /** Seconds to a readable span, for the confirmation's time estimate. */
    function fmtSeconds(seconds) {
      const n = Number(seconds)
      if (!Number.isFinite(n) || n <= 0) return '—'
      if (n < 90) return `${Math.round(n)} 秒`
      if (n < 5400) return `${Math.round(n / 60)} 分钟`
      return `${(n / 3600).toFixed(1)} 小时`
    }

    /**
     * The step between pressing a render button and the render starting.
     *
     * These three buttons start jobs measured in minutes to hours, and two of them are destructive in
     * the ordinary sense: 出关键帧 replaces frames that were reviewed, and 出片 burns the GPU on
     * whatever the board and keyframes currently are. A mis-click used to cost that outright.
     *
     * The `details` lines say what WILL happen rather than asking "are you sure" — a confirmation
     * carrying no information trains people to dismiss it unread, which is the same as not having one.
     *
     * 「下次不再询问」 exists because the workflow honestly has two modes: iterating on parameters,
     * where a prompt every time is friction, and committing to a long render, where it is the point.
     */
    function RenderConfirm(props) {
      const { label, details, onCancel, onConfirm, remember, onRemember, busy } = props
      return h('div', { className: 'sd-confirm sd-confirm-ask' },
        h('div', { style: { display: 'grid', gap: 2, minWidth: 0 } },
          h('b', null, `要${label}吗？`),
          ...details.filter(Boolean).map((line, i) => h('span', { key: i, className: 'sd-hint' }, line))),
        h('label', { style: { display: 'flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' } },
          h('input', {
            type: 'checkbox', style: { margin: 0 },
            checked: remember === true,
            onChange: (event) => onRemember?.(event.target.checked),
          }),
          h('span', { className: 'sd-hint' }, '下次不再询问')),
        h('button', { className: 'sd-btn', 'data-variant': 'primary', disabled: busy, onClick: onConfirm }, '开始'),
        h('button', { className: 'sd-btn', disabled: busy, onClick: onCancel }, '取消'))
    }

    /**
     * What each preset is FOR, in the terms the decision is actually made in.
     *
     * 「精细」on its own does not tell anyone whether to pick it. "Is 2.5x slower, and is what action
     * shots need" does. Kept here rather than in the option labels, which browsers truncate.
     */
    const PRESET_NOTES = {
      draft: '最快，用来试构图、试节奏。动作容易糊，别用它出成片。',
      standard: '日常够用：静止、对话、慢动作都没问题。武打、跳舞这类快速动作容易糊。',
      quality: '动作最稳，也最慢。武打、跳舞、快速运镜的镜头值得用它。',
    }

    /** The three renders that ask for confirmation, and what to call them in the question. */
    const ASK_LABELS = {
      reference: '出参考图',
      keyframe: '出关键帧',
      video: '出片',
    }

    function RenderPresetPicker(props) {
      const { presets, current, onChange, autoQuality, onAutoQuality, estimateSeconds } = props
      const entries = Object.entries(presets ?? {})
      const at = typeof estimateSeconds === 'function' ? estimateSeconds : null
      return h('div', { style: { marginTop: 9 } },
        /**
         * The control column on the left, the per-preset notes on the right.
         *
         * The control column is `flex: 0 0 auto` so the select sizes to its own longest option
         * rather than stretching across the panel, and the notes take the remaining width. The notes
         * used to sit UNDER the select, which made a full-width block of small print below a
         * full-width control — hard to read across and pushed the render buttons off screen.
         */
        h('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' } },
          /**
           * Control column: the quality row, then the auto-quality switch UNDER it.
           *
           * `alignItems: 'flex-start'` rather than `center` on the column is what keeps the toggle's
           * left edge flush with the 「出片质量」 label. With `center` the column would be centred
           * against the taller notes block beside it and the two left edges would drift apart.
           */
          h('div', { className: 'sd-field', style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 7 } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('label', { style: { margin: 0, whiteSpace: 'nowrap' } }, '出片质量'),
              // `width: auto` lets the browser size the box to the rendered option text. The class
              // alone was not enough — `.sd-select` sets `width: 100%`, which is what made it long.
              h('select', {
                className: 'sd-select', style: { width: 'auto', maxWidth: 'none' },
                value: current,
                onChange: (event) => onChange?.(event.target.value),
              }, entries.map(([key, entry]) => h('option', { key, value: key },
                `${entry.label} · 视频 ${entry.h3Steps} 步${entry.turbo ? ' + 加速' : ''} / 图 ${entry.imageSteps} 步`)))),

            /**
             * The auto-quality switch: `[✓] 按镜头自动选质量　<why it is safe to leave>` on one line.
             *
             * It sits below the dropdown and flush with the 「出片质量」 label, so the column reads
             * top-to-bottom as one group: which preset, and whether the presets may be applied per
             * clip. The label used to be a block with the explanation wrapped beneath it, which split
             * the checkbox from its reason.
             *
             * The estimate line that used to sit here is gone: the per-preset times on the right
             * already say the same thing, and two places quoting minutes is one place too many.
             */
            h('label', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
              h('input', {
                type: 'checkbox', style: { flex: '0 0 auto', margin: 0 },
                checked: autoQuality !== false,
                onChange: (event) => onAutoQuality?.(event.target.checked),
              }),
              h('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, '按镜头自动选质量'),
              // Short, because the reason it is safe needs no argument here: the switch only ever
              // raises quality, so there is no risk to explain away.
              h('span', null, autoQuality !== false ? '动作镜头自动改用精细' : '整片统一用上面的预设'))),

          // The explanation a dropdown cannot hold. Times come from the measured cost model
          // (`estimateClipSecondsFor`), so the relative speeds are real rather than a claim.
          h('div', { className: 'sd-hint', style: { flex: '1 1 240px', minWidth: 0, display: 'grid', gap: 2 } },
            entries.map(([key, entry]) => h('div', {
              key,
              style: key === current ? { fontWeight: 600, color: 'var(--sd-fg, inherit)' } : undefined,
            },
            `${key === current ? '▶ ' : '　'}${entry.label} · ${entry.h3Steps} 步${entry.turbo ? ' + 加速 LoRA' : '（不启用加速）'}`
              + `${at ? ` · 10 秒片段约 ${at(entry)}` : ''} — ${PRESET_NOTES[key] ?? ''}`)))))
    }

    /**
     * The finished film's canvas, from the ratio alone.
     *
     * Mirror of the host's `resolutionFor`, and it exists so the 分辨率 control can say what it does
     * NOT affect. H3 renders at its own trained canvas — 768 on the short edge, capped at 1344 on the
     * long one — so 画面比例 is the only thing that moves it.
     *
     * The CAP is the part worth copying exactly. A first version scaled the short edge up with the
     * ratio unchecked, and printed 1792x768 for 21:9 against the host's 1344x576 — a wrong promise
     * beside a real control. `verify-render.mjs` compares the two across every ratio.
     */
    const H3_SHORT_EDGE = 768
    const H3_LONG_EDGE_MAX = 1344
    function videoCanvas(ratio = '9:16') {
      const snap32 = (n) => Math.max(32, Math.round(n / 32) * 32)
      const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ratio ?? '').trim())
      const rw = m ? Number(m[1]) : 16
      const rh = m ? Number(m[2]) : 9
      let width
      let height
      if (rw >= rh) {
        height = snap32(H3_SHORT_EDGE)
        width = snap32((height * rw) / rh)
      } else {
        width = snap32(H3_SHORT_EDGE)
        height = snap32((width * rh) / rw)
      }
      if (Math.max(width, height) > H3_LONG_EDGE_MAX) {
        if (rw >= rh) {
          width = H3_LONG_EDGE_MAX
          height = Math.min(snap32(H3_SHORT_EDGE), snap32((H3_LONG_EDGE_MAX * rh) / rw))
        } else {
          height = H3_LONG_EDGE_MAX
          width = Math.min(snap32(H3_SHORT_EDGE), snap32((H3_LONG_EDGE_MAX * rw) / rh))
        }
      }
      return { width, height }
    }
    const videoCanvasLabel = (ratio) => {
      const v = videoCanvas(ratio)
      return `${v.width}×${v.height}`
    }

    /**
     * Keyframe / reference-art size, in pixels, for a ratio and a megapixel budget.
     *
     * Mirror of `resolutionForMegapixels`. Kept next to `videoCanvas` so the two numbers shown in the
     * panel come from one place.
     */
    function imageCanvas(ratio = '9:16', megapixels = 2) {
      const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ratio ?? '').trim())
      const w = m ? Number(m[1]) : 9
      const h = m ? Number(m[2]) : 16
      const target = Math.min(16, Math.max(0.1, Number(megapixels) || 2)) * 1e6
      const ratioValue = w / h
      let width = Math.round(Math.sqrt(target * ratioValue) / 32) * 32
      let height = Math.round(Math.sqrt(target / ratioValue) / 32) * 32
      width = Math.max(32, width)
      height = Math.max(32, height)
      return { width, height }
    }
    const imageCanvasLabel = (ratio, megapixels) => {
      const v = imageCanvas(ratio, megapixels)
      return `${v.width}×${v.height}`
    }

    function RunCard({ run, onCancel }) {
      const pct = run.total > 0 ? Math.min(100, Math.round((run.current / run.total) * 100)) : null
      const tone = run.status === 'failed' ? 'err' : run.status === 'done' ? 'ok' : undefined
      const duration = fmtMs(run.elapsedMs)
      // When it ended, not just how long it took: on a queue of a dozen renders the
      // ordering matters as much as the individual durations.
      const finishedAt = run.finishedAt
        ? new Date(run.finishedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : null
      return h('div', { className: 'sd-run', 'data-status': run.status },
        h('div', { className: 'sd-clip-head', style: { marginBottom: 2 } },
          h('strong', null, run.label),
          h(Badge, { tone }, run.status === 'running' ? `${run.phase} · ${duration}` : run.status),
          // The elapsed time of a FINISHED run is the number an operator wants when
          // deciding whether to re-run something, and it used to appear only while
          // running — visible when it was least useful, gone when it mattered.
          run.status !== 'running' ? h('span', { className: 'sd-pill' }, `用时 ${duration}`) : null,
          finishedAt ? h('span', { className: 'sd-pill' }, finishedAt) : null,
          run.total > 0 ? h('span', { className: 'sd-pill' }, `${run.current}/${run.total}`) : null,
          run.status === 'running'
            ? h('span', { style: { marginLeft: 'auto' } }, h('button', { className: 'sd-btn', 'data-size': 'sm', onClick: () => onCancel(run.id) }, '中止'))
            : null),
        run.message ? h('div', { style: { fontSize: 12, color: 'var(--sd-muted)' } }, run.message) : null,
        pct !== null ? h('div', { className: 'sd-bar' }, h('i', { style: { width: `${pct}%` } })) : null,
        run.error ? h('div', { style: { color: 'var(--sd-err)', fontSize: 12, marginTop: 4 } }, `[${run.error.code}] ${run.error.message}`) : null,
        run.problems?.length ? h('div', { style: { color: 'var(--sd-warn)', fontSize: 12, marginTop: 4 } }, run.problems.slice(0, 4).join('；')) : null,
        run.text ? h('div', { className: 'sd-stream' }, run.text.slice(-1200)) : null,
        run.result?.failed?.length
          ? h('div', { style: { marginTop: 5, fontSize: 12 } },
            run.result.failed.slice(0, 6).map((f, i) => h('div', { key: i, style: { color: 'var(--sd-err)' } }, `✗ ${f.label ?? f.id}：${f.message}`)))
          : null)
    }

    // -------------------------------------------------------- P0: settings

    function ModelSelect({ label, category, lists, value, onChange }) {
      const options = lists?.[category] ?? []
      return h(Field, { label },
        h('select', {
          className: 'sd-select',
          value: value ?? '',
          onChange: (event) => onChange(event.target.value || null),
        },
        h('option', { value: '' }, `自动（${options.find((o) => /minimax|qwen/i.test(o)) ?? options[0] ?? '无可用'}）`),
        options.map((name) => h('option', { key: name, value: name }, name))))
    }

    function HealthCard({ health, capacity }) {
      if (!health) return null
      const device = health.devices?.[0]
      return h('div', { className: 'sd-card' },
        h('h3', null, '连接状态 ', h(Badge, { tone: 'ok' }, '已连接'),
          capacity?.level && capacity.level !== 'ok'
            ? h(Badge, { tone: capacity.level === 'blocked' ? 'err' : 'warn' }, `资源 ${capacity.level}`)
            : null),
        h('dl', { className: 'sd-kv' },
          h('dt', null, '地址'), h('dd', { className: 'sd-mono' }, health.baseUrl),
          h('dt', null, '版本'), h('dd', null, `${health.version ?? '?'} · Python ${String(health.python ?? '').split(' ')[0]}`),
          h('dt', null, 'GPU'), h('dd', null, device?.name ?? '无'),
          h('dt', null, '显存'), h('dd', null, `${gb(device?.vramFreeBytes)} 可用 / ${gb(device?.vramTotalBytes)}`),
          h('dt', null, '内存'), h('dd', null, `${gb(health.ramFreeBytes)} 可用 / ${gb(health.ramTotalBytes)}`),
          h('dt', null, '延迟'), h('dd', null, `${health.latencyMs} ms`)),
        capacity?.notes?.length
          ? h('p', { className: 'sd-hint', style: { color: capacity.level === 'blocked' ? 'var(--sd-err)' : 'var(--sd-warn)' } }, capacity.notes.join(' '))
          : null)
    }

    function SettingsPage() {
      ensureStyles()
      const [state, reload] = useAsync(() => api.status(false), [])
      const [draftUrl, setDraftUrl] = React.useState(null)
      const [testResult, setTestResult] = React.useState(null)
      const [testing, setTesting] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      // Consumption lives here, and the hook MUST be above the early returns below:
      // a hook after a conditional return changes the hook count between renders and
      // React throws. It is a separate request from status because status is polled
      // for health and walking every asset directory on each poll would be wasteful.
      const [consumptionState] = useAsync(() => api.consumption(), [])

      const status = state.data?.status
      const config = status?.config
      const health = status?.health
      const lists = status?.models
      const resolved = status?.resolved
      // Models per provider, for the two selects below.
      const catalogue = status?.llm?.catalogue ?? []
      const consumption = consumptionState.data

      if (state.loading) return h('div', { className: 'sd-root' }, h('div', { className: 'sd-body' }, h(Spinner)))
      if (state.error) {
        return h('div', { className: 'sd-root' }, h('div', { className: 'sd-body' },
          h('div', { className: 'sd-err' }, `读取配置失败：${state.error.message}`),
          h('button', { className: 'sd-btn', onClick: reload }, '重试')))
      }

      const baseUrl = draftUrl ?? config.comfy.baseUrl

      const runTest = async () => {
        setTesting(true); setTestResult(null)
        try { setTestResult(await api.test(baseUrl)) } catch (error) { setTestResult({ ok: false, error: { message: error.message } }) } finally { setTesting(false) }
      }
      const save = async (patch) => {
        setNotice(null)
        try { await api.saveConfig(patch); setDraftUrl(null); setNotice('已保存'); reload() } catch (error) { setNotice(`保存失败：${error.message}`) }
      }
      const setModel = (key, value) => save({ comfy: { models: { [key]: value } } })

      return h('div', { className: 'sd-root' },
        h('div', { className: 'sd-head' },
          h('div', { className: 'sd-title' }, '短剧工作室 · 设置'),
          notice ? h(Badge, { tone: 'ok' }, notice) : null,
          h('button', { className: 'sd-btn', 'data-size': 'sm', onClick: reload, disabled: state.loading }, '刷新')),

        h('div', { className: 'sd-body' },
          status?.error
            ? h('div', { className: 'sd-err' }, `无法连接 ComfyUI：${status.error.message}\n\n请确认 ComfyUI 已启动，或填入正确地址。`)
            : null,

          h('div', { className: 'sd-card' },
            h('h3', null, '服务地址'),
            h('div', { className: 'sd-row' },
              h('div', { style: { flex: '1 1 260px' } },
                h(Field, { label: 'ComfyUI 地址' },
                  h('input', {
                    className: 'sd-input sd-mono',
                    value: baseUrl,
                    onChange: (event) => setDraftUrl(event.target.value),
                  }))),
              h('button', { className: 'sd-btn', onClick: runTest, disabled: testing }, testing ? h(Spinner, { label: '测试中' }) : '测试连接'),
              h('button', {
                className: 'sd-btn', 'data-variant': 'primary',
                disabled: !draftUrl || draftUrl === config.comfy.baseUrl,
                onClick: () => save({ comfy: { baseUrl } }),
              }, '保存地址')),
            testResult
              ? h('p', { className: 'sd-hint', style: { color: testResult.ok ? 'var(--sd-ok)' : 'var(--sd-err)' } },
                testResult.ok
                  ? `连接成功：ComfyUI ${testResult.health.version} · ${testResult.health.devices?.[0]?.name ?? '无设备'}`
                  : `连接失败：${testResult.error?.message}`)
              : null),

          h(HealthCard, { health, capacity: status?.capacity }),

          h('div', { className: 'sd-card' },
          h('h3', null, '消耗统计'),
          consumption
            ? h('div', null,
              h('p', { className: 'sd-hint' },
                `全部项目：token ${fmtTokens(consumption.totals.totalTokens)}`
                + `（入 ${fmtTokens(consumption.totals.inputTokens)} / 出 ${fmtTokens(consumption.totals.outputTokens)}）`
                + ` · ${consumption.totals.llmCalls} 次文本调用`
                + ` · 图片 ${consumption.totals.images} 张 / 视频 ${consumption.totals.videos} 段`
                + ` · 渲染 ${fmtMs(consumption.totals.renderMs)}`
                + ` · 磁盘 ${fmtBytes(consumption.totals.diskBytes)}`),
              h('table', { className: 'sd-table' },
                h('thead', null, h('tr', null,
                  ['项目', 'token 入/出', '调用', '图/片', '渲染', '磁盘'].map((l) => h('th', { key: l }, l)))),
                h('tbody', null, consumption.projects.map((project) => h('tr', { key: project.id },
                  h('td', null, project.title),
                  h('td', { className: 'sd-mono' },
                    `${fmtTokens(project.llm.inputTokens)} / ${fmtTokens(project.llm.outputTokens)}`),
                  h('td', { className: 'num' }, project.llm.calls ? String(project.llm.calls) : '—'),
                  h('td', { className: 'num' }, `${project.render.images} / ${project.render.videos}`),
                  h('td', { className: 'num' }, fmtMs(project.render.totalMs)),
                  h('td', { className: 'num' },
                    fmtBytes(project.disk.assets + project.disk.document + project.disk.exports)))))),
              // Said explicitly so a local render is never mistaken for a metered one.
              h('p', { className: 'sd-hint' }, consumption.billing?.note ?? ''),
              h('p', { className: 'sd-hint' }, '磁盘为实测目录大小；token 与渲染耗时是累计记录，重启后仍在。'))
            : h('p', { className: 'sd-hint' }, '正在统计…'),
          h('h3', null, '生成模型'),
          h('p', { className: 'sd-hint' },
            status?.llm?.selection
              ? `当前使用 ${status.llm.selection.provider} / ${status.llm.selection.model}（来源：${status.llm.selection.source === 'config' ? '本页设置' : '会话默认模型'}）`
              : '还没有可用的文本模型。'),
          catalogue.length
            ? h('div', { className: 'sd-grid' },
              h(Field, { label: '文本模型 Provider', hint: '选「跟随会话默认」可随时切回' },
                h('select', {
                  className: 'sd-select',
                  value: config.llm?.provider ?? '',
                  onChange: (event) => {
                    const provider = event.target.value
                    if (!provider) return save({ llm: { provider: null, model: null } })
                    const first = (catalogue.find((entry) => entry.id === provider)?.models ?? [])[0]
                    return save({ llm: { provider, model: first?.id ?? '' } })
                  },
                },
                h('option', { value: '' }, '（跟随会话默认）'),
                catalogue.map((entry) => h('option', { key: entry.id, value: entry.id },
                  `${entry.name} · ${entry.models.length} 个模型`)))),
              h(Field, { label: '模型', hint: '该 provider 下可用的模型' },
                h('select', {
                  className: 'sd-select',
                  disabled: !config.llm?.provider,
                  value: config.llm?.model ?? '',
                  onChange: (event) => save({ llm: { model: event.target.value } }),
                },
                (catalogue.find((entry) => entry.id === config.llm?.provider)?.models ?? [])
                  .map((m) => h('option', { key: m.id, value: m.id }, m.name)))))
            : h('p', { className: 'sd-hint' },
              status?.llm?.providers?.length
                ? `可用 provider：${status.llm.providers.map((p) => p.id).join('、')}（模型列表读不到）`
                : '读不到 provider 列表。'),
          config.llm?.provider
            ? h('p', { className: 'sd-hint' }, '已指定独立模型。本地模型跑剧本/分镜对指令跟随要求较高，小模型可能反复校验失败。')
            : null,
            h('h3', null, '渲染模式与预设'),
            h('div', { className: 'sd-grid' },
              h(Field, {
                label: 'H3 模式',
                hint: config.comfy.mode === 'ref2va'
                  ? '参考图生视频：用人物参考图锁定身份，适合角色反复出现的镜头。'
                  : '首尾帧生视频：用关键帧定住开场，最省显存。',
              },
              h('select', {
                className: 'sd-select', value: config.comfy.mode,
                onChange: (event) => save({ comfy: { mode: event.target.value } }),
              },
              h('option', { value: 'fl2va' }, '首尾帧生视频 (FL2VA)'),
              h('option', { value: 'ref2va' }, '参考图生视频 (REF2VA) · 身份更稳'))),
              config.comfy.mode === 'ref2va'
                ? h(Field, {
                  label: '参考图精度',
                  hint: config.comfy.refImageSize === 'max'
                    ? '使用 2048px 短边，身份还原最好，但采样会慢数倍。'
                    : '按生成画幅缩放参考图。快，但身份还原略弱。',
                },
                h('select', {
                  className: 'sd-select', value: config.comfy.refImageSize ?? 'match',
                  onChange: (event) => save({ comfy: { refImageSize: event.target.value } }),
                },
                h('option', { value: 'match' }, 'match · 匹配生成画幅（快）'),
                h('option', { value: 'max' }, 'max · 2048px 短边（身份最稳）')))
                : null,
              h(Field, {
                label: '质量预设',
                hint: status?.presets?.[config.comfy.preset]?.turbo ? '启用加速 LoRA，速度快很多' : '不启用加速 LoRA，质量最好但很慢',
              },
              h('select', {
                className: 'sd-select', value: config.comfy.preset,
                onChange: (event) => save({ comfy: { preset: event.target.value } }),
              },
              Object.entries(status?.presets ?? {}).map(([key, preset]) => h('option', { key, value: key },
                `${preset.label} · 图 ${preset.imageSteps} 步 / 视频 ${preset.h3Steps} 步`))))),
            config.comfy.mode === 'ref2va'
              ? h('p', { className: 'sd-hint' },
                'REF2VA 需要人物参考图：请先在「人物场景」页生成参考图，再出片。没有参考图时会自动回退到首尾帧模式。')
              : null,
            resolved
              ? h('p', { className: 'sd-hint' },
                `自动选用：图 ${resolved.image.diffusionModel ?? '未找到'} ｜ H3 ${resolved.h3.diffusionModel ?? '未找到'}`)
              : null),

          lists ? h('div', { className: 'sd-card' },
            h('h3', null, '模型绑定'),
            h('p', { className: 'sd-hint', style: { marginBottom: 10 } },
              '留空即从 ComfyUI 已安装的模型中自动挑选。LoRA 是例外：匹配不到就不加，绝不会套用无关的 LoRA。'),
            h('div', { className: 'sd-grid' },
              h(ModelSelect, { label: 'H3 扩散模型', category: 'diffusionModel', lists, value: config.comfy.models.diffusionModel, onChange: (v) => setModel('diffusionModel', v) }),
              h(ModelSelect, { label: 'H3 文本编码器', category: 'textEncoder', lists, value: config.comfy.models.textEncoder, onChange: (v) => setModel('textEncoder', v) }),
              h(ModelSelect, { label: 'H3 视频 VAE', category: 'vae', lists, value: config.comfy.models.vae, onChange: (v) => setModel('vae', v) }),
              h(ModelSelect, { label: 'H3 音频 VAE', category: 'audioVae', lists, value: config.comfy.models.audioVae, onChange: (v) => setModel('audioVae', v) }),
              h(ModelSelect, { label: 'H3 加速 LoRA', category: 'lora', lists, value: config.comfy.models.lora, onChange: (v) => setModel('lora', v) }),
              h(ModelSelect, { label: '出图模型', category: 'diffusionModel', lists, value: config.comfy.models.imageDiffusionModel, onChange: (v) => setModel('imageDiffusionModel', v) }),
              h(ModelSelect, { label: '出图编码器', category: 'textEncoder', lists, value: config.comfy.models.imageTextEncoder, onChange: (v) => setModel('imageTextEncoder', v) }),
              h(ModelSelect, { label: '出图 VAE', category: 'vae', lists, value: config.comfy.models.imageVae, onChange: (v) => setModel('imageVae', v) }),
              h(ModelSelect, { label: '出图 LoRA', category: 'lora', lists, value: config.comfy.models.imageLora, onChange: (v) => setModel('imageLora', v) })),
            h('details', { style: { marginTop: 10 } },
              h('summary', { style: { cursor: 'pointer', color: 'var(--sd-muted)', fontSize: 12 } }, '查看已安装模型清单'),
              h('div', { className: 'sd-grid', style: { marginTop: 8 } },
                Object.entries(lists).map(([category, names]) => h('div', { key: category },
                  h('div', { style: { fontSize: 11, color: 'var(--sd-muted)', fontWeight: 600 } }, `${category} · ${names.length}`),
                  h('div', { className: 'sd-mono', style: { maxHeight: 130, overflow: 'auto', color: 'var(--sd-muted)' } },
                    names.length ? names.join('\n') : '（无）'))))))
            : null))
    }

    // ------------------------------------------------------------ studio tabs

    /**
     * Client-side mirror of the host cost estimate.
     *
     * The browser bundle cannot import the pipeline module, so the model is
     * restated here — with the two MEASURED anchor points. The point is to make
     * the time/quality tradeoff visible BEFORE a two-hour render, not after.
     */
    function estimateRender(totalSec, clipSeconds) {
      const perFrame = (frames) => {
        const lo = { f: 124, s: 1.84 }
        const hi = { f: 328, s: 5.20 }
        if (frames <= lo.f) return lo.s
        const slope = (hi.s - lo.s) / (hi.f - lo.f)
        return frames >= hi.f ? hi.s + slope * (frames - hi.f) : lo.s + slope * (frames - lo.f)
      }
      const snap = (sec) => {
        const raw = Math.max(5, Math.round(sec * 24))
        return raw + (((5 - (raw % 17)) % 17) + 17) % 17
      }
      const clips = Math.max(1, Math.ceil(totalSec / clipSeconds))
      const framesPerClip = Math.min(snap(clipSeconds), snap(totalSec / clips))
      return {
        clips,
        seams: Math.max(0, clips - 1),
        seconds: Math.round(clips * framesPerClip * perFrame(framesPerClip)),
      }
    }

    const humanDuration = (seconds) => (seconds >= 3600
      ? (seconds / 3600).toFixed(1) + ' 小时'
      : seconds >= 90 ? Math.round(seconds / 60) + ' 分钟' : Math.round(seconds) + ' 秒')

    /**
     * Which project the panel was last showing.
     *
     * The panel unmounts whenever the settings dialog opens or the view changes, so
     * component state cannot hold this. Without it every return to the studio reset
     * to the FIRST project in the list, which is the worst possible default: it looks
     * like the work was lost, and in a list sorted by recency the first entry is
     * rarely the one being edited.
     *
     * localStorage rather than the plugin config: this is a view preference of one
     * browser, not a property of the project, and a wrong value costs nothing because
     * the id is validated against the live list before use.
     */
    const REMEMBERED_PROJECT_KEY = 'shortdrama.activeProject'
    function readRememberedProject() {
      try { return window.localStorage.getItem(REMEMBERED_PROJECT_KEY) || null } catch { return null }
    }
    function rememberProject(id) {
      try {
        if (id) window.localStorage.setItem(REMEMBERED_PROJECT_KEY, id)
        else window.localStorage.removeItem(REMEMBERED_PROJECT_KEY)
      } catch { /* storage disabled or full; remembering is best-effort */ }
    }

    /** Compact token counts: 21491 -> "21.5k". */
    const fmtTokens = (n) => {
      const v = Number(n) || 0
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
      return String(v)
    }

    /** Milliseconds as a coarse duration; render batches run to hours. */
    const fmtMs = (ms) => {
      const total = (Number(ms) || 0) / 1000
      if (total <= 0) return '—'
      if (total >= 3600) return (total / 3600).toFixed(1) + 'h'
      if (total >= 60) return Math.round(total / 60) + 'm'
      return Math.round(total) + 's'
    }

    /** Bytes at whatever scale reads best; assets span KB to GB. */
    const fmtBytes = (n) => {
      const v = Number(n) || 0
      if (v <= 0) return '—'
      if (v >= 1e9) return (v / 1e9).toFixed(2) + ' GB'
      if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB'
      if (v >= 1e3) return (v / 1e3).toFixed(0) + ' KB'
      return v + ' B'
    }

    function ScriptTab({ project, reload, startRun, busy, onFullPipeline, compiled, catalogues, onRemember }) {
      const [brief, setBrief] = React.useState('')
      const [instruction, setInstruction] = React.useState('')
      const [targetSec, setTargetSec] = React.useState(project?.targetTotalSec ?? 60)
      // 0 means the project has never chosen; the panel then shows the configured default so the
      // number on screen matches what the renderer will actually use.
      const [clipSeconds, setClipSeconds] = React.useState(
        Number(project?.clipSeconds) > 0 ? Number(project.clipSeconds) : (compiled?.clipSeconds ?? 10),
      )
      // Local, because this component has no error channel of its own and the
      // studio-level one is not in scope here — reaching for it blanked the tab.
      const [styleError, setStyleError] = React.useState(null)

      /**
       * Re-seed the two local numbers when the OPEN PROJECT changes.
       *
       * `useState`'s initial value is read once, on mount. Without this, creating a project — or
       * switching to another one — left these two selects showing the previous project's numbers
       * while the project itself held different ones, which is the same class of quiet disagreement
       * between the panel and the document that the rest of this work is about.
       */
      const projectId = project?.id ?? null
      const projectTarget = project?.targetTotalSec ?? null
      const projectClip = Number(project?.clipSeconds) > 0 ? Number(project.clipSeconds) : null
      React.useEffect(() => {
        setTargetSec(projectTarget ?? 60)
        setClipSeconds(projectClip ?? compiled?.clipSeconds ?? 10)
        // `compiled` is deliberately absent from the deps: including it would reset a number the
        // operator had just chosen every time the board recompiled underneath them.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [projectId, projectTarget, projectClip])

      const script = project?.script
      // The host's figure when the compile has landed (it is computed from the same script, and is
      // the authority), otherwise the local mirror so the readout appears immediately.
      const capacity = script
        ? (compiled?.scriptCapacity ?? scriptCapacity(script, project?.targetTotalSec ?? 60))
        : null

      return h('div', null,
        h('div', { className: 'sd-card' },
          h('h3', null, '创作要求'),
          // The style line was displayed but not editable anywhere: the script stage
        // wrote it and nothing could change it. A preset is the whole line, not a
        // mode — picking one writes the fragment into project.style, so every later
        // stage inherits it, and it stays hand-editable afterwards.

        // Both kinds of input are accepted here, and the label says so.
        //
        // It used to read 一句话故事 / 创作要求 with a one-line example, and the whole path was built
        // for that: a finished screenplay pasted in was treated as "creative direction" and
        // rewritten. The detection now switches the instruction, and this text is what tells the
        // operator that pasting the whole thing is a supported move rather than a misuse.
        h(Field, {
          label: '剧本或创作要求',
          hint: '可以贴一份写好的剧本（会照原样整理，台词一字不改），也可以只写一句创意方向（会据此写一个）。',
        },
            h('textarea', {
              className: 'sd-textarea',
              style: { minHeight: 92 },
              value: brief,
              placeholder: project?.logline
                || '贴完整剧本：第一场 内景 老屋堂屋 日 / 女孩：我回来了。 …\n或一句话：被合伙人背叛的女主在天台夺回属于自己的一切，竖屏，强钩子，每 10 秒一个反转',
              onChange: (event) => setBrief(event.target.value),
            })),
          // The five output settings on ONE row.
          //
          // Each used to carry its own hint paragraph underneath, and those hints — not
          // the controls — are what set the widths: five stacked label+select+hint
          // groups cannot share a line, so they were split across two rows and still
          // left the panel looking like a form. One shared hint line below the row
          // says the same things once, and the controls fit side by side.
          (() => {
            // The five output settings render even before a project has loaded.
            //
            // They used to be behind `if (!project) return null`, because the expressions below read
            // `project.ratio` and a null project threw a TypeError that took the whole panel down.
            // Hiding them was the wrong cure: the row is exactly what an operator looks for when
            // opening a project, and a fresh project — whose document arrives one round trip after
            // its id does — showed a 剧本 tab with no 画面风格 / 分辨率 / 画面比例 / 成片时长 /
            // 单次出片时长 at all.
            //
            // `view` is the project or a set of defaults, so every access below is safe. Writes are
            // still gated on a real project id, so a control moved before the document lands cannot
            // be silently discarded — see `save`.
            const view = project ?? {
              ratio: '9:16',
              imageMegapixels: null,
              // `style` must be present even though the derived object below reads it: a missing key
              // threw `Cannot read properties of null (reading 'style')` the moment the row was
              // allowed to render without a project — which is how the guard was first discovered.
              style: '',
              targetTotalSec: targetSec,
            }
            // Three sources, in order of authority: `compiled` is the live truth for the open
            // project, `catalogues` is what the host reported at startup, and the fallback is a
            // mirror of the host's own tables so the controls can render before either has arrived.
            // Every list is therefore always non-empty, and the selectors are never conditional.
            const tiers = Array.isArray(compiled?.resolutionTiers) && compiled.resolutionTiers.length
              ? compiled.resolutionTiers
              : (Array.isArray(catalogues?.resolutionTiers) && catalogues.resolutionTiers.length
                ? catalogues.resolutionTiers
                : CATALOGUE_FALLBACK.resolutionTiers)
            const ratios = Array.isArray(compiled?.ratios) && compiled.ratios.length
              ? compiled.ratios
              : (Array.isArray(catalogues?.ratios) && catalogues.ratios.length
                ? catalogues.ratios
                : CATALOGUE_FALLBACK.ratios)
            const presets = Array.isArray(compiled?.stylePresets) && compiled.stylePresets.length
              ? compiled.stylePresets
              : (Array.isArray(catalogues?.stylePresets) && catalogues.stylePresets.length
                ? catalogues.stylePresets
                : CATALOGUE_FALLBACK.stylePresets)
            const currentTier = tiers.find((x) => Number(x?.megapixels) === Number(view.imageMegapixels ?? 2))
            const currentPreset = presets.find((p) => p.fragment === view.style)
            const save = async (patch) => {
              // Remember first, and unconditionally: the value is what the operator chose, and the
              // next project should be seeded from it even if this write cannot land yet.
              onRemember?.(patch)
              if (!project?.id) return
              try { setStyleError(null); await api.updateProject(project.id, patch); reload() }
              catch (err) { setStyleError(err) }
            }
            // Sized by content, not by a number picked in advance.
            //
            // '0 0 auto' lets the wrapper take exactly the width of the widest option in
            // the select, and 'width: auto' stops .sd-select from stretching to fill a
            // container that was wider than its contents — which is where the empty
            // space on the right of every dropdown came from.
            const box = (children) => h('div', { style: { flex: '0 0 auto' } }, children)
            const fit = { width: 'auto' }
            const est = estimateRender(targetSec, clipSeconds)
            return h('div', null,
              // 20px apart, not the row default of 10: five controls with their labels
              // read as one dense block at 10, and the point of putting them on a line
              // is that each one stays legible at a glance.
              // 28px apart, and every label centred over its control. Centring is what
              // makes the row read as five equal settings: with left-aligned labels a
              // six-character label sits off to one side of a narrow select and the
              // column looks mis-set rather than deliberate.
              h('div', {
                className: 'sd-row sd-labels-centered',
                style: { marginTop: 9, flexWrap: 'nowrap', gap: 28 },
              },
                // All five are rendered UNCONDITIONALLY. They used to be wrapped in
                // `presets.length ? … : null`, which meant the controls disappeared whenever the
                // option lists were still empty — and "still empty" is the state a brand-new
                // project is in. `tiers`, `ratios` and `presets` above always resolve to a
                // non-empty list, so the condition is gone rather than left as a misleading
                // suggestion that these can be absent.
                box(h(Field, { label: '画面风格' },
                  h('select', {
                    className: 'sd-select',
                    value: String(currentPreset?.key ?? ''),
                    onChange: (event) => {
                      const preset = presets.find((p) => p.key === event.target.value)
                      if (preset) save({ style: preset.fragment })
                    },
                  },
                  h('option', { value: '' }, '（未指定）'),
                  presets.map((p) => h('option', { key: String(p.key), value: String(p.key) }, String(p.label)))))),
                /**
                 * 「关键帧与参考图分辨率」, not 「分辨率」.
                 *
                 * The old label sat between 画面风格 and 画面比例 and looked like the finished film's
                 * resolution, which it is not and cannot be: H3 renders at its own trained canvas
                 * (768x1344 for 9:16, 1344x576 for 21:9) and that is decided by 画面比例 alone. What
                 * this control actually sizes is the IMAGES — keyframes and reference art — which are
                 * ordinary text-to-image renders.
                 *
                 * Concretely, on the real projects: switching 渊底归路 from 1080P to 2K doubles its
                 * keyframes from 2176x928 to 2944x1248 and leaves the film at 1344x576 either way. The
                 * value is indirect but real — sharper keyframes give H3 a cleaner first and last frame
                 * to anchor on, which is what holds identity and composition.
                 */
                box(h(Field, {
                  // The label carries the distinction on its own; an explanatory line here was
                  // removed as noise. `videoCanvasLabel` is still used for the option text below and
                  // on the render tab, which is where the two sizes actually need telling apart.
                  label: '关键帧与参考图分辨率',
                },
                h('select', {
                  className: 'sd-select',
                  value: String(currentTier?.key ?? '1080p'),
                  onChange: (event) => {
                    const tier = tiers.find((x) => x.key === event.target.value)
                    if (tier) save({ imageMegapixels: tier.megapixels })
                  },
                },
                tiers.map((x) => h('option', { key: String(x.key), value: String(x.key) },
                  // The pixel count belongs in the option text: "1080P" on a 9:16 frame and "1080P"
                  // on 21:9 are the same promise but very different images, and the number is what
                  // tells them apart.
                  `${x.label} · ${imageCanvasLabel(view.ratio, x.megapixels)}`))))),
                box(h(Field, { label: '画面比例' },
                  h('select', {
                    className: 'sd-select',
                    value: String(view.ratio ?? '9:16'),
                    onChange: (event) => save({ ratio: event.target.value }),
                  },
                  ratios.map((r) => h('option', { key: String(r), value: String(r) }, String(r)))))),
                box(h(Field, { label: '成片时长' },
                  h('select', {
                    className: 'sd-select', value: String(targetSec),
                    // Persisted rather than left in component state: the storyboard, the H3 prompts
                    // and the clip split are all planned against this number, so it has to outlive
                    // the tab. Local-only is how a 30s target once wrote a 30s script while every
                    // later stage still planned a 60s film.
                    onChange: (event) => {
                      const value = Number(event.target.value)
                      setTargetSec(value)
                      save({ targetTotalSec: value })
                    },
                  },
                  [15, 30, 45, 60, 90, 120, 180, 300].map((v) => h('option', { key: v, value: String(v) }, `${v}s`))))),
                box(h(Field, { label: '单次出片时长' },
                  h('select', {
                    className: 'sd-select', value: String(clipSeconds),
                    // This is the CLIP SPLIT length. It used to change only a local number, so the
                    // renderer grouped shots by the configured default instead, and a board packed
                    // for 15s windows was cut into 10s clips — the dropdown looked like it worked.
                    onChange: (event) => {
                      const value = Number(event.target.value)
                      setClipSeconds(value)
                      save({ clipSeconds: value })
                    },
                  },
                  [5, 6, 8, 10, 12, 15].map((v) => h('option', { key: v, value: String(v) }, `${v}s/段`)))))),
              h('p', { className: 'sd-hint', style: { margin: '6px 0 0' } },
                `风格写入项目 · 分辨率只作用于分镜关键帧；比例作用于关键帧、视频和场景图 · 角色全身图与三视图的尺寸固定 · 成片 ${targetSec}s 拆成 ${est.clips} 段（${est.seams} 个接缝，预估 ${humanDuration(est.seconds)}）`),
              // `view`, not `project`: the guard and the value both have to survive a null project,
              // and `project.style ? … : null` reads `project.style` in the CONDITION — which is the
              // read that threw. Reading through `view` makes the guard meaningful again.
              view.style
                ? h('p', { className: 'sd-hint', style: { margin: '4px 0 0', wordBreak: 'break-all' } }, view.style)
                : null,
              styleError ? h('p', { className: 'sd-err', style: { margin: '4px 0 0' } }, `保存失败：${styleError.message}`) : null,

              // Does the script have enough material for the length that was asked for?
              //
              // Reported in scenes and shots rather than seconds, because seconds are a storyboard
              // decision — the script has no durations at all. Without this the only feedback on
              // "is it long enough" was the target the operator had typed, and a 300s film written
              // from a script that could carry 59% of it had nothing to show for the gap.
              script && capacity
                ? h('p', {
                  className: 'sd-hint',
                  style: { margin: '6px 0 0', color: capacity.coverage < 0.8 ? 'var(--sd-warn)' : undefined },
                }, capacity.coverage < 0.8
                  ? `⚠ 剧本的量偏少：${capacity.scenes} 场 / ${capacity.beats} 个情节点，`
                    + `按 ${capacity.secondsPerShot}s 一镜算大约能撑 ${capacity.shotsAvailable} 个镜头，`
                    + `而 ${targetSec}s 需要约 ${capacity.shotsNeeded} 个（覆盖 ${Math.round(capacity.coverage * 100)}%）。`
                    + ' 直接拆分镜会被拉长，看着会赶——可以先点「继续写」把故事写足。'
                  : `剧本的量够用：${capacity.scenes} 场 / ${capacity.beats} 个情节点，`
                    + `约可撑 ${capacity.shotsAvailable} 个镜头，${targetSec}s 需要约 ${capacity.shotsNeeded} 个。`)
                : null,

              h('div', { className: 'sd-row', style: { marginTop: 9 } },
                h('button', {
                  className: 'sd-btn', 'data-variant': 'primary',
                  // Disabled without a project: `startRun` needs `project.id`, and the row above now
                  // renders before that id exists. A live button whose only outcome is a TypeError is
                  // worse than a visibly inactive one.
                  disabled: busy || !project?.id,
                  title: project?.id ? undefined : '先新建或选择一个项目',
                  onClick: async () => {
                    await startRun('script', { projectId: project.id, brief, targetSec })
                    reload()
                  },
                }, script ? '重新生成剧本' : '生成剧本'),
                // Continuation, next to the button that starts a script rather than buried with the
                // rewrite controls: it is the same intent — get more script — carried out differently.
                script
                  ? h('button', {
                    className: 'sd-btn',
                    disabled: busy || !project?.id,
                    title: '接着已写的部分往下写，不改动现有内容。故事需要更长的时长时用它。',
                    onClick: async () => {
                      await startRun('script', { projectId: project.id, brief, targetSec, expand: true })
                      reload()
                    },
                  }, '继续写')
                  // The count here is 2, established by trying every plausible value against the
                  // parser rather than by reading the nesting. Reasoning about a six-deep `h(...)`
                  // gave three confident, wrong answers in a row.
                  : null))
          })(),


          h('div', { className: 'sd-row', style: { marginTop: 9 } },
            h('div', { style: { flex: '1 1 260px' } },
              h(Field, { label: '修改要求（用于重写）' },
                h('input', {
                  className: 'sd-input', value: instruction,
                  placeholder: '例如：把结局改成开放式，加一个反转人物',
                  onChange: (event) => setInstruction(event.target.value),
                }))),
            h('button', {
              className: 'sd-btn', disabled: busy || !script || !project?.id,
              onClick: async () => { await startRun('script', { projectId: project.id, brief, instruction, revise: true, targetSec }); reload() },
            }, '按修改要求重写')),

          h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--sd-line)' } },
            h('div', { className: 'sd-clip-head', style: { marginBottom: 0 } },
              h('button', {
                className: 'sd-btn', disabled: busy,
                title: `依次执行：生成剧本 → 抽取人物与场景 → 拆分镜头（约 ${targetSec} 秒成片，平均 ${clipSeconds} 秒/镜）`,
                onClick: () => onFullPipeline({ targetSec, clipSeconds, brief }),
              }, '⚡ 一键生成（剧本 → 人物 → 分镜）'),
              h('span', { className: 'sd-hint', style: { margin: 0 } },
                `按 ${targetSec} 秒成片、${clipSeconds} 秒/段，一次跑完前三步。段落越短总耗时越省、接缝越多；段落越长越连贯、单帧成本越高。`)))),

        script
          ? h('div', null,
            h('div', { className: 'sd-card' },
              h('h3', null, project.title, ' ', h(Badge, null, project.genre || '未定题材')),
              project.logline ? h('p', { style: { margin: '0 0 8px' } }, project.logline) : null,
              script.synopsis ? h('p', { className: 'sd-hint' }, script.synopsis) : null,
              project.style ? h('p', { className: 'sd-hint' }, `画面风格：${project.style}`) : null,
              project.audioStyle ? h('p', { className: 'sd-hint' }, `声音基调：${project.audioStyle}`) : null),
            (script.beats ?? []).map((beat) => h('div', { className: 'sd-card', key: beat.id },
              h('h3', null, `${beat.id} · ${beat.summary}`, beat.emotion ? h('span', { className: 'sd-pill', style: { marginLeft: 8 } }, beat.emotion) : null),
              (script.scenes ?? []).filter((scene) => scene.beatId === beat.id).map((scene) => h('div', { key: scene.id, style: { marginTop: 6 } },
                h('div', { style: { fontWeight: 600, fontSize: 12 } }, `${scene.id} ${scene.slug}`),
                (scene.dialogue ?? []).length
                  ? h('ul', { style: { margin: '4px 0 0', paddingLeft: 18, fontSize: 12 } },
                    scene.dialogue.map((line, i) => h('li', { key: i }, h('strong', null, line.who), '：', line.line)))
                  : h('div', { className: 'sd-hint' }, '（无对白）'))))))
          : h('div', { className: 'sd-empty' },
            h('p', null, '还没有剧本。'),
            h('p', { className: 'sd-hint' }, '填一句创作要求，点「生成剧本」。生成后接着做人物设定，再到分镜头。')))
    }

    function CastTab({ project, compiled, reload, startRun, busy, onRender, onUpload, onRestyle, onPreview, onMenu }) {
      if (!project) return h('div', { className: 'sd-empty' }, '加载中…')
      const hasCast = project.characters.length > 0 || project.scenes.length > 0
      const promptsFor = (kind, id) => (kind === 'character' ? compiled?.cast : compiled?.scenes)?.find((e) => e.id === id)

      const card = (entity, kind) => {
        const meta = project.assets?.[entity.refAssetId]
        const prompt = promptsFor(kind, entity.id)
        return h('div', { className: 'sd-card', key: entity.id, style: { marginBottom: 0 } },
          h('div', { className: 'sd-clip-head' },
            h('strong', null, entity.name),
            h('span', { className: 'sd-pill' }, kind === 'character' ? (entity.role || '角色') : '场景'),
            // Per-entity re-roll: one bad face should not force re-rendering the
            // whole cast, which is the expensive part.
            h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 4 } },
              h('label', {
                className: 'sd-btn', 'data-size': 'sm',
                style: { cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 },
                title: '用一张本地图片当参考图（演员照片、实景照片等）',
              },
              '上传本地图',
              h('input', {
                type: 'file', accept: 'image/*', style: { display: 'none' }, disabled: busy,
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) onUpload(entity.id, file)
                },
              })),
              h('button', {
                className: 'sd-btn', 'data-size': 'sm', disabled: busy,
                title: meta ? '用同一个提示词重新生成这一张' : '生成这一张',
                onClick: () => onRender('reference', { projectId: project.id, entityIds: [entity.id], force: true }),
              }, meta ? '重出这张' : '出图'))),
          meta
            // contain, not cover: a reference is a 3:4 portrait and cropping it
            // hides exactly the face the reference exists to show.
            ? h('img', {
                className: 'sd-thumb', 'data-zoom': '1',
                style: { width: '100%', height: 240, objectFit: 'contain' },
                src: assetUrl(project.id, entity.refAssetId),
                alt: entity.name,
                title: '点击放大查看，右键更多操作',
                onClick: () => onPreview({
                  src: assetUrl(project.id, entity.refAssetId),
                  label: entity.name + (kind === 'scene' ? ' · 场景' : ' · 三视图'),
                  detail: [entity.appearance?.hair, entity.appearance?.outfit].filter(Boolean).join(' · '),
                  // .positive, not the whole compiled object. `promptsFor` returns
                  // {id, name, refAssetId, refSeed, positive, negative, params}, and
                  // React throws "objects are not valid as a child" when the lightbox
                  // renders it — which is exactly what happened once the compiled board
                  // stopped being null and this field stopped being undefined.
                  prompt: prompt?.positive ?? null,
                }),
                onContextMenu: (event) => onMenu(event, {
                  src: assetUrl(project.id, entity.refAssetId),
                  label: entity.name + (kind === 'scene' ? ' · 场景' : ' · 三视图'),
                  detail: [entity.appearance?.hair, entity.appearance?.outfit].filter(Boolean).join(' · '),
                  // .positive, not the whole compiled object. `promptsFor` returns
                  // {id, name, refAssetId, refSeed, positive, negative, params}, and
                  // React throws "objects are not valid as a child" when the lightbox
                  // renders it — which is exactly what happened once the compiled board
                  // stopped being null and this field stopped being undefined.
                  prompt: prompt?.positive ?? null,
                  assetId: entity.refAssetId,
                  ext: meta?.ext,
                }),
              })
            : h('div', { className: 'sd-thumb-empty', style: { width: '100%', height: 240 } }, '未出图'),
          h('p', { className: 'sd-hint', style: { marginTop: 6 } }, entity.lockToken || '（无一致性锚点）'),
          kind === 'character' && (entity.appearance?.outfit || entity.appearance?.hair)
            ? h('p', { className: 'sd-hint' }, [entity.appearance.hair, entity.appearance.outfit].filter(Boolean).join(' · '))
            : null,
          meta?.origin === 'upload'
            ? h('div', { style: { marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('span', { className: 'sd-pill' }, '本地图'),
              h('button', {
                className: 'sd-btn', 'data-size': 'sm', disabled: busy,
                title: '保留人物，按项目风格重绘背景与光影',
                onClick: () => onRestyle(entity.id, 'keep the same person and the same face, replace the background with a clean neutral backdrop matching the described look, relight and colour-grade consistently'),
              }, '重绘背景'),
              h('button', {
                className: 'sd-btn', 'data-size': 'sm', disabled: busy,
                title: '整张图统一到项目风格',
                onClick: () => onRestyle(entity.id, 'restyle this image into the described cinematic look, keep the subject and composition'),
              }, '统一风格'))
            : null,
          entity.refSeed !== null && entity.refSeed !== undefined
            ? h('p', { className: 'sd-hint' }, `seed ${entity.refSeed}`)
            : null,
          prompt ? h('details', { style: { marginTop: 6 } },
            h('summary', { style: { cursor: 'pointer', color: 'var(--sd-muted)', fontSize: 11 } }, '出图提示词'),
            h('pre', { className: 'sd-pre', style: { marginTop: 5, maxHeight: 150 } }, prompt.positive)) : null)
      }

      return h('div', null,
        h('div', { className: 'sd-toolbar' },
          h('button', {
            className: 'sd-btn', 'data-variant': 'primary', disabled: busy,
            onClick: async () => { await startRun('cast', { projectId: project.id }); reload() },
          }, hasCast ? '重新抽取人物与场景' : '抽取人物与场景'),
          h('button', {
            className: 'sd-btn', disabled: busy || !hasCast,
            onClick: () => onRender('reference', { projectId: project.id }),
          }, '一键出全部参考图'),
          h('button', {
            className: 'sd-btn', disabled: busy || !hasCast,
            onClick: () => onRender('reference', { projectId: project.id, force: true }),
          }, '全部重出'),
          h('span', { className: 'sd-hint', style: { margin: 0 } },
            '只出了没图的；对某一张不满意，用卡片右上角的「重出这张」单独重来，不用整批重跑。')),

        !hasCast
          ? h('div', { className: 'sd-empty' }, '还没有人物与场景设定。先点上面的按钮从剧本里抽取。')
          : h(React.Fragment, null,
            project.characters.length
              ? h(React.Fragment, null,
                h('h3', { style: { fontSize: 13 } }, `人物 · ${project.characters.length}`),
                h('div', { className: 'sd-grid' }, project.characters.map((c) => card(c, 'character'))))
              : null,
            project.scenes.length
              ? h(React.Fragment, null,
                h('h3', { style: { fontSize: 13, marginTop: 16 } }, `场景 · ${project.scenes.length}`),
                h('div', { className: 'sd-grid' }, project.scenes.map((s) => card(s, 'scene'))))
              : null))
    }

    /**
     * One editable storyboard row.
     *
     * Generation produces a first draft, not a final board, so every field the
     * compiler reads is editable here. `shotSize` / `camera` / `movement` are
     * selects over the same closed vocabulary the prompt offers, because a value
     * outside it would pass through the normaliser unchanged and make the
     * compiled prompt inconsistent between runs.
     */
    function ShotRow({ shot, vocabulary, frameCount, sceneName, castName, projectId, assets, onRender, onPatch, onDelete, busy, selected, onToggle, onPreview, onMenu, clipRole, onRegenPrompt }) {
      const [draft, setDraft] = React.useState(shot)
      React.useEffect(() => { setDraft(shot) }, [shot])

      const commit = (patch) => {
        setDraft((current) => ({ ...current, ...patch }))
        onPatch(shot.id, patch)
      }
      const keyframe = assets?.[shot.keyframeAssetId]
      const vocab = vocabulary ?? { shotSize: [], camera: [], movement: [] }

      /**
       * The board stores the ENGLISH form ("medium close-up") because that is what the
       * prompt compiler emits, while the options are the Chinese vocabulary. A <select>
       * whose value matches no option renders BLANK — so every composition control
       * looked empty even though all nineteen shots had values in them. The stored
       * form is right; the control just had to translate before it could show it.
       */
      const select = (field, options) => {
        const reverse = vocab.reverse?.[field] ?? {}
        const stored = draft[field] ?? ''
        const shown = reverse[stored] ?? stored
        // A value the vocabulary does not know still gets an option, so it stays
        // visible and editable instead of silently reading as empty.
        const extra = shown && !options.includes(shown) ? [shown] : []
        return h('select', {
          className: 'sd-select',
          style: { minWidth: 78, padding: '2px 4px', fontSize: 12 },
          value: shown,
          onChange: (event) => commit({ [field]: event.target.value }),
        },
        h('option', { value: '' }, '—'),
        [...options, ...extra].map((value) => h('option', { key: value, value }, value)))
      }

      return h('tr', { style: selected ? undefined : { opacity: 0.45 } },
        h('td', null, h('input', {
          type: 'checkbox',
          checked: selected,
          title: selected ? '已选中：会出关键帧' : '未选中：跳过，不出图',
          onChange: () => onToggle(shot.id),
        })),
        h('td', null,
          // The per-shot button lives HERE, beside the thumbnail, not only in the
          // trailing 操作 column: that column is the last of fourteen, so on any
          // narrow panel it sits off-screen and the feature looks absent.
          h('button', {
            className: 'sd-btn', 'data-size': 'sm',
            style: { width: 92, marginBottom: 4 },
            disabled: busy,
            title: '只给这一个镜头出关键帧，不影响其它镜头',
            onClick: () => onRender('keyframe', { projectId, shotIds: [shot.id], force: true }),
          }, keyframe ? '重出' : '出图'),
          keyframe
          ? h('img', {
              className: 'sd-thumb', 'data-zoom': '1',
              style: { width: 92, height: 92, objectFit: 'contain' },
              src: assetUrl(projectId, shot.keyframeAssetId),
              alt: '镜头 ' + shot.no,
              title: '点击放大查看，右键更多操作',
              onClick: () => onPreview({
                src: assetUrl(projectId, shot.keyframeAssetId),
                label: '镜头 ' + shot.no,
                detail: shot.action,
              }),
              onContextMenu: (event) => onMenu(event, {
                src: assetUrl(projectId, shot.keyframeAssetId),
                label: '镜头 ' + shot.no,
                detail: shot.action,
                assetId: shot.keyframeAssetId,
              }),
            })
          : h('div', { className: 'sd-thumb-empty' }, '—')),
        h('td', { className: 'num' }, shot.no),
        h('td', null, h('input', {
          className: 'sd-input',
          type: 'number', min: 0.5, max: 15, step: 0.5,
          style: { width: 50, padding: '2px 4px', fontSize: 12 },
          value: draft.durationSec,
          onChange: (event) => setDraft({ ...draft, durationSec: Number(event.target.value) }),
          onBlur: () => commit({ durationSec: Math.min(15, Math.max(0.5, Number(draft.durationSec) || 0.5)) }),
        })),
        h('td', { className: 'num', style: { color: 'var(--sd-muted)' } }, frameCount ?? '—'),
        // One line, never wrapped: a scene name broken across three lines made the
        // row twice as tall and pushed everything below it out of view.
        h('td', { className: 'nowrap' }, sceneName(shot.sceneId)),
        h('td', null, select('shotSize', vocab.shotSize)),
        h('td', null, select('camera', vocab.camera)),
        h('td', null, select('movement', vocab.movement)),
        h('td', { className: 'wide' }, h('textarea', {
          className: 'sd-textarea',
          style: { minHeight: 46, fontSize: 12, padding: '3px 5px' },
          value: draft.action,
          onChange: (event) => setDraft({ ...draft, action: event.target.value }),
          onBlur: () => commit({ action: draft.action }),
        }),
        // The frame PROMPT: what this shot's picture actually contains, expanded from
        // the action into the layered description an image model responds to. It sits
        // in the same cell as the action because it is that action made visible, and
        // below it so the two read as a pair.
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'flex-start', marginTop: 4 } },
          h('textarea', {
            className: 'sd-textarea',
            placeholder: '画面提示词：这一帧里有什么（主体 / 外观 / 环境 / 光线 / 氛围）—— 可直接手改，关键帧和视频都按它生成',
            style: {
              minHeight: 32, flex: '1 1 auto', fontSize: 11, padding: '3px 5px',
              opacity: draft.promptNote ? 1 : 0.72,
            },
            value: draft.promptNote ?? '',
            onChange: (event) => setDraft({ ...draft, promptNote: event.target.value }),
            onBlur: () => commit({ promptNote: draft.promptNote ?? '' }),
          }),
          // Rewrite just this shot's prompt. A whole-board pass is right after the
          // storyboard is generated; it is the wrong tool when one frame missed —
          // re-running nineteen of them to fix one wastes a minute and churns the
          // eighteen that were already good.
          h('button', {
            className: 'sd-btn', 'data-size': 'sm',
            disabled: busy,
            title: '只重写这一个镜头的画面提示词，不动其它镜头',
            onClick: () => onRegenPrompt?.(shot.id),
          }, '🔄'))),
        // 240px, roughly four times the width an unconstrained cell settled on.
        // Dialogue is the one column whose content is a full sentence: with no
        // min-width it was squeezed to a few characters and every line broke across
        // three rows, which made the whole board look like it had lost its alignment.
        h('td', { className: 'dialogue' }, (shot.dialogue ?? []).length
          ? (shot.dialogue ?? []).map((line, index) => h('div', { key: index, style: { fontSize: 12 } },
            h('strong', null, line.who), '：', line.line))
          : h('span', { style: { color: 'var(--sd-muted)', fontSize: 12 } }, '—')),
        h('td', null, (shot.characters ?? []).map(castName).join('、') || '—'),
        h('td', null,
          h(Badge, {
            tone: shot.status === 'done' ? 'ok' : shot.status === 'keyframed' ? 'warn' : undefined,
          }, shot.status === 'done' ? '已出片' : shot.status === 'keyframed' ? '有关键帧' : '草稿'),
          // Which clip this shot lands in, and — more usefully — whether its keyframe
          // reaches the renderer at all. In a packed clip only the first and last
          // keyframes are wired to first_frame/last_frame; a middle shot's keyframe is
          // rendered at full cost and used by nothing, which is worth admitting next
          // to the button that renders it.
          clipRole
            ? h('p', { className: 'sd-hint', style: { margin: '3px 0 0', whiteSpace: 'nowrap' } },
              `第${clipRole.clip}/${clipRole.clips}段 · ${clipRole.role}`)
            : null),
        h('td', null, h('div', { style: { display: 'flex', gap: 4, flexDirection: 'column' } },
          h('button', {
            className: 'sd-btn', 'data-size': 'sm', disabled: busy,
            onClick: () => onRender('keyframe', { projectId, shotIds: [shot.id], force: true }),
          }, keyframe ? '重出关键帧' : '出关键帧'),
          h('button', {
            className: 'sd-btn', 'data-size': 'sm', disabled: busy,
            onClick: () => onRender('video', { projectId, shotIds: [shot.id], force: true }),
          }, '出这一段'),
          h('button', {
            className: 'sd-btn', 'data-size': 'sm', disabled: busy,
            onClick: () => onDelete(shot.id),
          }, '删除'))))
    }

    function StoryboardTab({ project, compiled, reload, startRun, busy, onRender, onResplit, onPreview, onMenu }) {
      const [instruction, setInstruction] = React.useState('')
      const [localShots, setLocalShots] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const pending = React.useRef(null)

      // Local edits are the working copy until the project reloads from disk.
      const shots = localShots ?? project.shots ?? []
      React.useEffect(() => { setLocalShots(null) }, [project?.id, project?.updatedAt])

      /**
       * The shots whose keyframes the VIDEO actually consumes: each clip's first and last.
       *
       * H3 has exactly two image inputs — `first_frame` and `last_frame` — so a clip's interior
       * keyframes never reach the model. They are still generated from the shot's 画面描述, so they are
       * worth having when you want to LOOK at a frame before committing; that is a choice about
       * reviewing, not about the finished film, which is why they default to OFF rather than being
       * removed.
       *
       * The grouping comes from `compiled.clips`, which the HOST produced with the very window the
       * renderer cuts on. Recomputing it here would need `groupIntoClips` and `clipFrameBand`, and
       * those live in `lib/pipeline/compile.js` — a host module the client half cannot reach (this
       * panel's copy of the bundle has no `require` into it). Writing the call anyway is how this was
       * first done, and it would have thrown a ReferenceError the moment the storyboard tab opened.
       *
       * With nothing compiled there are no clip boundaries to read, so every shot stays selected:
       * the operator has not seen a board yet, and silently dropping shots from the count would be
       * worse than being unhelpful.
       */
      const anchorIds = React.useMemo(() => {
        if (!shots.length) return new Set()
        const clips = Array.isArray(compiled?.clips) ? compiled.clips : []
        if (!clips.length) return new Set(shots.map((s) => s.id))
        const ids = new Set()
        for (const clip of clips) {
          const shotIds = Array.isArray(clip?.shotIds) ? clip.shotIds : []
          if (!shotIds.length) continue
          ids.add(shotIds[0])
          // A single-shot clip uses its one frame as BOTH ends. The renderer only sends `last_frame`
          // when a clip holds more than one shot, but listing it twice is harmless.
          ids.add(shotIds[shotIds.length - 1])
        }
        return ids
      }, [shots, compiled])

      /**
       * Keyframe selection.
       *
       * Defaults to the ANCHOR shots rather than the whole board. Selecting everything meant paying
       * GPU time for frames the video cannot use — 8 of 22 shots on 埋名十六年 — and interior frames
       * are the ones most likely to be generated and never looked at.
       *
       * An empty selection is still meaningful ("render nothing"), so the default applies only when no
       * decision has been recorded, not when the recorded set happens to be empty.
       */
      const [selected, setSelected] = React.useState(null)
      const selectedIds = React.useMemo(() => {
        if (selected instanceof Set) {
          // Drop ids that no longer exist. A set that survives that filter but is empty is a
          // deliberate "select none", and is left alone.
          const live = shots.filter((s) => selected.has(s.id)).map((s) => s.id)
          return new Set(live)
        }
        return new Set(shots.map((s) => s.id).filter((id) => anchorIds.has(id)))
      }, [selected, shots, anchorIds])
      // Moved BELOW the hooks. An early return above them changes how many hooks
      // React sees when a project finally loads, which is a hooks-order violation and
      // throws — a panel that is fine until the exact moment data arrives.
      if (!project) return h('div', { className: 'sd-empty' }, '加载中…')

      const toggleShot = (id) => {
        const next = new Set(selectedIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSelected(next)
      }
      const selectAll = () => setSelected(new Set(shots.map((s) => s.id)))
      const selectNone = () => setSelected(new Set())

      const sceneName = (id) => project.scenes?.find((s) => s.id === id)?.name ?? '—'
      const castName = (id) => project.characters?.find((c) => c.id === id)?.name ?? id

      /**
       * Persist a shot patch, coalescing rapid edits. A select change and a blur
       * on the same row should be one write, not two.
       */
      const patchShot = (shotId, patch) => {
        const next = shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s))
        setLocalShots(next)
        if (pending.current) clearTimeout(pending.current)
        pending.current = setTimeout(async () => {
          pending.current = null
          try {
            await api.updateProject(project.id, { shots: next })
            setNotice('已保存')
            setTimeout(() => setNotice(null), 1200)
          } catch (err) {
            setNotice(`保存失败：${err.message}`)
          }
        }, 500)
      }

      const deleteShot = (shotId) => {
        const next = shots.filter((s) => s.id !== shotId).map((s, index) => ({ ...s, no: index + 1 }))
        setLocalShots(next)
        api.updateProject(project.id, { shots: next })
          .then(() => { setNotice('已删除'); reload() })
          .catch((err) => setNotice(`删除失败：${err.message}`))
      }

      const totalSec = Math.round(shots.reduce((n, s) => n + (Number(s.durationSec) || 0), 0) * 10) / 10

      // Which clip each shot belongs to, and what its keyframe is used FOR. Kept as a
      // plain expression rather than a hook: this component already returns early
      // above, and adding a hook after a conditional return would change the hook
      // count between renders.
      const clipRoleMap = (() => {
        const map = new Map()
        const clips = compiled?.clips ?? []
        for (const clip of clips) {
          const n = clip.shotIds.length
          clip.shotIds.forEach((id, i) => {
            map.set(id, {
              clip: clip.index + 1,
              clips: clips.length,
              role: n === 1 ? '单镜'
                : i === 0 ? '首帧'
                  : i === n - 1 ? '尾帧'
                    : '中间帧（不出片）',
            })
          })
        }
        return map
      })()
      // Derived from the compiled board, so the numbers shown are the numbers the
      // renderer will actually use rather than a second guess at them.
      const clipSummary = compiled?.clips?.length
        ? {
          clips: compiled.clips.length,
          avgSeconds: (compiled.clips.reduce((n, c) => n + (Number(c.seconds) || 0), 0) / compiled.clips.length).toFixed(1),
          shotsPerClip: (shots.length / compiled.clips.length).toFixed(1),
        }
        : null;

      return h('div', null,
        h(StaleNotice, { compiled, busy, onResplit }),
        h('div', { className: 'sd-card' },
          h('h3', null, '分镜头'),
          h(Field, { label: '导演要求（可选）' },
            h('input', {
              className: 'sd-input', value: instruction,
              placeholder: '例如：多用特写，节奏再快一点，最后一镜给远景收尾',
              onChange: (event) => setInstruction(event.target.value),
            })),
          h('div', { className: 'sd-row', style: { marginTop: 9 } },
            h('button', {
              className: 'sd-btn', 'data-variant': 'primary',
              disabled: busy || !project.script || project.characters.length === 0,
              // No targetSec here on purpose. It is not in this component's scope — it
              // lives in ScriptTab — and referencing it would throw at render and blank
              // the entire panel. It is also unnecessary: the script stage now records
              // the target on the project, and the storyboard stage reads it there.
              onClick: async () => { await startRun('storyboard', { projectId: project.id, instruction }); reload() },
            }, shots.length ? '重新拆解分镜' : '生成分镜头'),
            // The frame-prompt pass. It EXPANDS each action into a full description of
            // what the frame contains, which is what an image model needs and what a
            // one-line action does not provide. Its output feeds both the keyframe and
            // the H3 prompt.
            h('button', {
              className: 'sd-btn', disabled: busy || shots.length === 0,
              title: '让 AI 把每个镜头的画面扩展成一段完整的画面描述（主体 / 外观 / 环境 / 光线 / 氛围），关键帧和视频都按它生成',
              onClick: () => startRun('shotprompts', { projectId: project.id, shotIds: [...selectedIds] }),
            }, '生成画面提示词'),
            h('button', {
              className: 'sd-btn', disabled: busy || shots.length === 0,
              onClick: () => onRender('keyframe', { projectId: project.id, shotIds: [...selectedIds] }),
            }, `出选中关键帧（${selectedIds.size}/${shots.length}）`),
            /**
             * 「选锚定帧」first, 「全选」second.
             *
             * The first button is the one that matches what the video can use, so it is the one
             * offered as a single click; selecting every frame — including the interior ones H3 has no
             * input for — stays available because it is a legitimate thing to want when reviewing a
             * board, but it is no longer the default or the easy option.
             */
            h('button', {
              className: 'sd-btn', 'data-size': 'sm',
              disabled: shots.length === 0,
              title: '只选每段的首、尾镜头——出片时真正作为首帧/尾帧喂给模型的就是这两个',
              onClick: () => setSelected(new Set(anchorIds)),
            }, `选锚定帧（${anchorIds.size}）`),
            h('button', { className: 'sd-btn', 'data-size': 'sm', onClick: selectAll, disabled: shots.length === 0 }, '全选'),
            h('button', { className: 'sd-btn', 'data-size': 'sm', onClick: selectNone, disabled: shots.length === 0 }, '全不选'),
            h('button', {
              className: 'sd-btn', disabled: busy || shots.length === 0,
              onClick: () => onRender('video', { projectId: project.id }),
            }, '出全片'),
            h('span', { className: 'sd-hint', style: { margin: 0 } },
              !project.script ? '需要先有剧本'
                : project.characters.length === 0 ? '需要先抽取人物设定'
                  : `${shots.length} 个镜头 · 共 ${totalSec}s`),
            // The honest reading of the board, because the shot list looks like a
            // cutting plan and is not one: H3 is given ONE first frame and one last
            // frame and produces a single continuous take, so shots inside a clip are
            // described in the prompt but never cut. Saying so is the difference
            // between a tool that misleads and one that constrains honestly.
            clipSummary
              ? h('p', { className: 'sd-hint', style: { margin: 0 } },
                `会分成 ${clipSummary.clips} 段渲染，每段约 ${clipSummary.avgSeconds}s、含 ${clipSummary.shotsPerClip} 个镜头。`
                + `一段 = 一次连续生成（首帧 → 尾帧），段内不会真的切换镜头——镜头描述只作为提示词引导。`
                + `想要「一镜一段」，把出片时长设成和镜头时长一样即可。`)
              : null,
            notice ? h(Badge, { tone: notice.startsWith('保存失败') || notice.startsWith('删除失败') ? 'err' : 'ok' }, notice) : null),
          h('p', { className: 'sd-hint' },
            '表格里的时长、景别、机位、运动、画面都可以直接改，改动会自动保存。'
            + '景别/机位/运动是受控词表——从这里选才能保证编译出的提示词前后一致。')),

        shots.length === 0
          ? h('div', { className: 'sd-empty' }, '还没有分镜表。')
          : h('div', { className: 'sd-scroll-x' },
            h('table', { className: 'sd-table' },
              h('thead', null, h('tr', null,
                ['', '关键帧', '#', '时长', '帧', '场景', '景别', '机位', '运动', '画面', '对白', '角色', '状态', '操作']
                  .map((label) => h('th', { key: label }, label)))),
              h('tbody', null, shots.map((shot) => h(ShotRow, {
                key: shot.id,
                shot,
                vocabulary: compiled?.vocabulary,
                frameCount: compiled?.shots?.find((s) => s.id === shot.id)?.frames,
                sceneName,
                castName,
                projectId: project.id,
                assets: project.assets,
                onRender,
                onPatch: patchShot,
                onRegenPrompt: (id) => startRun('shotprompts', { projectId: project.id, shotIds: [id] }),
                onDelete: deleteShot,
                busy,
                selected: selectedIds.has(shot.id),
                onToggle: toggleShot,
                onPreview,
                onMenu,
                clipRole: clipRoleMap.get(shot.id),
              }))))))
    }

    function PromptTab({ project, compiled, onCompile, busy, onExport, onResplit, onError }) {
      return h('div', null,
        h('div', { className: 'sd-toolbar' },
          // Relabelled once a board exists. The button always recompiled, but calling it
          // "编译提示词" on a page that already showed compiled prompts read as a
          // no-op — so after changing the script there was nothing that looked like the
          // way to make the prompts follow.
          h('button', { className: 'sd-btn', 'data-variant': 'primary', disabled: busy || !project, onClick: onCompile },
            compiled ? '重新编译提示词' : '编译提示词'),
          h('button', { className: 'sd-btn', disabled: busy || !project, onClick: onExport }, '导出制作包'),
          h('button', {
            className: 'sd-btn', disabled: busy || !project,
            title: '在文件管理器中打开这个项目的导出文件夹',
            onClick: async () => {
              try {
                const revealed = await api.reveal({ projectId: project.id, kind: 'exports' })
                if (!revealed?.ok) throw new Error(revealed?.error?.message ?? '打不开导出文件夹')
              } catch (err) { onError?.(err) }
            },
          }, '📂 打开导出文件夹'),
          compiled ? h('span', { className: 'sd-hint', style: { margin: 0 } },
            `${compiled.clips.length} 个可渲染片段 · 画布 ${compiled.resolution.width}×${compiled.resolution.height}`) : null),

        h(StaleNotice, { compiled, busy, onResplit }),

        compiled
          ? h('div', null,
            compiled.clips.map((clip) => h('div', { className: 'sd-card', key: clip.index },
              h('div', { className: 'sd-clip-head' },
                h('strong', null, `片段 ${clip.index + 1}`),
                h(Badge, { tone: clip.warnings.length ? 'warn' : 'ok' }, `${clip.seconds}s · ${clip.frames} 帧`),
                h(Badge, null, `镜头 ${clip.shotIds.join(', ')}`),
                clip.rendered ? h(Badge, { tone: 'ok' }, '已出片') : null,
                h('span', { style: { marginLeft: 'auto' } }, h(CopyButton, { text: clip.prompt, label: '复制提示词' }))),
              clip.warnings.length ? h('p', { className: 'sd-hint', style: { color: 'var(--sd-warn)' } }, `⚠ ${clip.warnings.join('；')}`) : null,
              h('pre', { className: 'sd-pre' }, clip.prompt),
              h('details', { style: { marginTop: 8 } },
                h('summary', { style: { cursor: 'pointer', color: 'var(--sd-muted)', fontSize: 12 } }, '云 API 请求体 (POST /v2/video_generation)'),
                h('pre', { className: 'sd-pre', style: { marginTop: 6 } }, JSON.stringify(clip.apiRequest, null, 2))))),
            compiled.lint?.length
              ? h('div', { className: 'sd-card' },
                h('h3', null, '分镜检查'),
                h('table', { className: 'sd-table' },
                  h('tbody', null, compiled.lint.map((issue, i) => h('tr', { key: i },
                    h('td', null, h(Badge, { tone: issue.level === 'error' ? 'err' : 'warn' }, issue.level)),
                    h('td', { className: 'sd-mono' }, issue.shotId || '整体'),
                    h('td', null, issue.message))))))
              : null)
          : h('div', { className: 'sd-empty' },
            h('p', null, '尚未编译。'),
            h('p', { className: 'sd-hint' }, '点「编译提示词」把分镜表编译成 H3 时间轴提示词与关键帧提示词。')))
    }

    function RenderTab({ project, compiled, runs, onRender, onCancel, onMerge, onOpenFolder, onPreview, busy, ui, onUi, catalogues, presetKey: presetKeyProp, onPreset, autoQuality, onAutoQuality, pendingKind, doneKind, onPress, rememberConfirm, onRememberAsk }) {
      const [picked, setPicked] = React.useState(null)
      // Which clip's compiled prompt is open. The prompt is the only thing besides
      // the frames that the model actually reads, and reviewing it BEFORE a render
      // is the difference between catching a wrong description and paying thirteen
      // minutes to discover it. The data was already on hand — `compile` returns a
      // prompt per clip — it simply was not shown where the button is.
      const [openPrompt, setOpenPrompt] = React.useState(null)
      React.useEffect(() => { setPicked(null) }, [project?.id])
      // Moved BELOW the hooks. An early return above them changes how many hooks
      // React sees when a project finally loads, which is a hooks-order violation and
      // throws — a panel that is fine until the exact moment data arrives.
      if (!project) return h('div', { className: 'sd-empty' }, '加载中…')
      const clips = compiled?.clips ?? []
      const videos = Object.values(project.assets ?? {}).filter((a) => a.kind === 'video')
      // Ordered by creation, so the cut follows the film. Letting click order
      // drive it would silently produce a different edit than the one on screen.
      const ordered = [...videos].sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))
      const pickedIds = picked ?? new Set(ordered.map((x) => x.id))
      const pickedOrder = ordered.filter((x) => pickedIds.has(x.id)).map((x) => x.id)
      const images = Object.values(project.assets ?? {}).filter((a) => a.kind === 'image')

      // Draggable heights, from config. Defaults here as well as on the host so the panel is
      // usable for the frame or two before the config request lands.
      const clipHeight = Number(ui?.clipPanelHeight) > 0 ? Number(ui.clipPanelHeight) : 360
      const tableHeight = Number(ui?.tablePanelHeight) > 0 ? Number(ui.tablePanelHeight) : 300
      const saveHeight = (key) => (value) => onUi?.({ [key]: value })

      /**
       * Mirror of the host's measured render-cost model (`estimateClipSecondsFor`).
       *
       * Same two anchors, same interpolation, rescaled by the preset's step count. Mirrored rather
       * than fetched because the picker has to explain the options on the first frame, before the
       * status request returns. `verify-render.mjs` compares the two so the copy cannot drift — a
       * stale copy here would quote 8-step timings next to a 20-step preset.
       */
      const COST_ANCHORS = [{ frames: 124, secondsPerFrame: 1.84 }, { frames: 328, secondsPerFrame: 5.2 }]
      const SPEED_LORA_STEPS = 8
      /**
       * Estimated seconds for one clip, as a NUMBER.
       *
       * Split from the display helper because the confirmation has to SUM these across clips, and
       * summing formatted strings is not possible. `estimateClipSecondsMirror` is just this plus
       * formatting, so the two cannot drift apart.
       */
      const estimateClipSecondsAt = (frames, entry) => {
        const n = Math.max(5, Number(frames) || 0)
        const [[lo], [hi]] = [COST_ANCHORS, COST_ANCHORS.slice(1)]
        const slope = (hi.secondsPerFrame - lo.secondsPerFrame) / (hi.frames - lo.frames)
        let perFrame = lo.secondsPerFrame
        if (n >= hi.frames) perFrame = hi.secondsPerFrame + slope * (n - hi.frames)
        else if (n > lo.frames) perFrame = lo.secondsPerFrame + slope * (n - lo.frames)
        const base = n * perFrame
        const steps = Number(entry?.h3Steps)
        return Number.isFinite(steps) && steps > 0 ? (base * steps) / SPEED_LORA_STEPS : base
      }
      const estimateClipSecondsMirror = (frames, preset) => {
        const seconds = estimateClipSecondsAt(frames, preset)
        return seconds < 90 ? `${Math.round(seconds)} 秒` : `${(seconds / 60).toFixed(1)} 分钟`
      }

      // The three presets, mirrored from `lib/api.js#PRESETS` so the selector has options on the
      // first frame instead of an empty dropdown. `verify-render.mjs` compares them with the host.
      const PRESET_FALLBACK = {
        draft: { label: '草稿', imageSteps: 8, h3Steps: 4, turbo: true },
        standard: { label: '标准', imageSteps: 25, h3Steps: 8, turbo: true },
        quality: { label: '精细', imageSteps: 40, h3Steps: 20, turbo: false },
      }
      // The preset in force, for the selector and the action-shot warning below.
      const presetTable = Object.keys(catalogues?.presets ?? {}).length ? catalogues.presets : PRESET_FALLBACK
      const presetList = Object.entries(presetTable)
      const presetKey = presetKeyProp ?? 'standard'
      const preset = presetTable[presetKey] ?? presetTable.standard ?? null
      const presetLabel = preset?.label ?? '标准'
      const presetH3Steps = Number(preset?.h3Steps) || 8
      const turboActive = Boolean(preset?.turbo)
      const fastClips = clips.filter((clip) => clip.fastMotion)

      /**
       * Which render is being asked about, if any.
       *
       * Local because it is transient UI state: leaving the tab should cancel the question rather than
       * leave a confirmation waiting when the operator comes back.
       */
      const [asking, setAsking] = React.useState(null)
      React.useEffect(() => { setAsking(null) }, [project?.id])

      const runAsked = () => {
        const kind = asking
        setAsking(null)
        if (!kind) return
        onPress?.(kind)
        onRender(kind, { projectId: project.id })
      }
      const askRender = (kind) => {
        // '下次不再询问' recorded: skip the question and start, which is the whole point of the box.
        // Read straight from the prop — no local mirror, so there is one source for the setting and it
        // is the persisted one.
        if (rememberConfirm === true) { onPress?.(kind); onRender(kind, { projectId: project.id }); return }
        setAsking(kind)
      }

      /**
       * What the confirmation says will happen.
       *
       * Counts and the time estimate come from the SAME sources the render uses — `clips` from the
       * compile, `estimateClipSecondsFor` for cost — so the bar cannot promise one thing and start
       * another. A confirmation that carries no information trains people to dismiss it unread.
       */
      const askDetails = (kind) => {
        const characters = (project.characters ?? []).length
        const scenes = (project.scenes ?? []).length
        if (kind === 'reference') {
          return [
            `将给 ${characters} 个人物、${scenes} 个场景各出一张参考图，共 ${characters + scenes} 张。`,
            '已有的参考图会被新的替换。',
          ]
        }
        if (kind === 'keyframe') {
          const missing = project.shots.filter((s) => !s.keyframeAssetId).length
          return [
            `将按 ${project.shots.length} 个镜头出图${missing < project.shots.length ? `，其中 ${project.shots.length - missing} 个已有、会被重新生成` : ''}。`,
            '关键帧决定出片时首尾帧锚定的画面。',
          ]
        }
        // video
        const ids = new Set(clips.flatMap((clip) => clip.shotIds))
        const unkeyframed = clips.filter((clip) => {
          const first = project.shots.find((s) => s.id === clip.shotIds[0])
          return !first?.keyframeAssetId
        }).length
        const autoCount = preset?.turbo ? fastClips.length : 0
        const total = clips.reduce((sum, clip) => sum + (estimateClipSecondsAt ? estimateClipSecondsAt(clip.frames, preset) : 0), 0)
        const quality = autoCount > 0
          ? `静止镜头按「${presetLabel}」，${autoCount} 段动作镜头自动按「精细」。`
          : `全部按「${presetLabel}」。`
        return [
          `将生成 ${clips.length} 段视频，覆盖 ${ids.size} 个镜头。`,
          // The honest warning: without a keyframe the clip is plain text-to-video and the composition
          // is invented rather than inherited. Saying so BEFORE the render is the point of this bar.
          unkeyframed > 0 ? `其中 ${unkeyframed} 段的起始镜头没有关键帧，那几段会退化成纯文字生成（构图不受控）。` : null,
          quality,
          total > 0 ? `预计耗时约 ${fmtSeconds(total)}（按 10 秒片段实测值估算，实际会有出入）。` : null,
        ].filter(Boolean)
      }

      return h('div', null,
        /**
         * The action-shot warning.
         *
         * Turbo sampling is a distillation shortcut and it is exactly where fast motion breaks down:
         * limbs smear and the body stops reading as one object. That is the "武打/跳舞很假" report,
         * and the cause is a setting — 8 steps with the speed LoRA — not the material.
         *
         * Shown here rather than only in settings because this is where 出片 is pressed, and because
         * the information needed to decide is per project: the compile result now marks which clips
         * contain a strike, a leap or a spin.
         */
        turboActive && fastClips.length > 0
          ? h('div', { className: 'sd-confirm' },
            h('span', null,
              `⚠ ${fastClips.length}/${clips.length} 段含快速动作（${[...new Set(fastClips.flatMap((c) => c.motionReasons))].join('、')}），`
              + `而当前预设「${presetLabel}」用 ${presetH3Steps} 步 + 加速 LoRA。`
              + '少步采样最容易在武打、跳舞这类动作上糊掉、变形——这通常就是"动作很假"的原因。'),
            onPreset
              ? h('button', {
                className: 'sd-btn', 'data-size': 'sm', 'data-variant': 'primary',
                disabled: busy,
                title: '切到精细预设：视频用 20 步且不启用加速 LoRA。出图步数也会一起变多，慢一些。',
                onClick: () => onPreset('quality'),
              }, '改用精细预设出片')
              : null,
            h('span', { className: 'sd-hint', style: { margin: 0 } },
              '只是慢一些；动作镜头值得。'))
          : null,
        turboActive && fastClips.length === 0 && clips.length > 0
          ? h('p', { className: 'sd-hint' },
            `当前预设「${presetLabel}」用 ${presetH3Steps} 步 + 加速 LoRA。这份分镜里没有检测到快速动作，通常够用；`
            + '如果成片里出现肢体糊、动作不连贯，切到精细预设再出一段对比。')
          : null,
        // Title and buttons on ONE line, with the preset picker beneath.
        h('div', { className: 'sd-card' },
          h('div', { style: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' } },
            // `margin: 0` overrides `.sd-card > h3 { margin: 0 0 8px }`, which would otherwise push
            // the buttons off the title's baseline.
            h('h3', { style: { margin: 0, flex: '0 0 auto' } }, '渲染'),
            h('div', { className: 'sd-toolbar', style: { margin: 0, flex: '1 1 auto' } },
              h(RenderAction, {
                label: '出参考图', busy, disabled: busy,
                pending: pendingKind === 'reference', done: doneKind === 'reference',
                title: '给人物和场景各出一张参考图，出片时用来保持一致',
                onRun: () => askRender('reference'),
              }),
              h(RenderAction, {
                label: '出关键帧', busy, disabled: busy,
                pending: pendingKind === 'keyframe', done: doneKind === 'keyframe',
                title: '按每个镜头出一张首帧图；出片时用首尾两张锚定画面',
                onRun: () => askRender('keyframe'),
              }),
              h(RenderAction, {
                label: '出片（H3）', variant: 'primary', busy,
                disabled: busy || project.shots.length === 0,
                pending: pendingKind === 'video', done: doneKind === 'video',
                title: '按片段逐段生成视频。分钟级任务，进度见下方队列',
                onRun: () => askRender('video'),
              }),
              h(RenderAction, {
                label: '打开产出文件夹', size: 'sm', disabled: busy || !project,
                title: '在文件管理器里打开本项目的产出文件夹',
                onRun: () => onOpenFolder(),
              }),
              /**
               * The finished film's size, stated where 出片 is pressed.
               *
               * It is fixed by 画面比例 and NOT by the 分辨率 control, which sizes keyframes — a
               * distinction that was invisible while this number lived in a line of small print on
               * another tab, and the reason "我设置的分辨率跟你生成的视频有关系吗" was a fair question.
               */
              h('span', {
                className: 'sd-badge',
                title: '成片尺寸由画面比例决定，H3 按自己训练的画布出图，无法任意指定。关键帧与参考图的分辨率另设。',
              }, `成片 ${videoCanvasLabel(project.ratio)}`)),

          /**
           * The confirmation, between the buttons and the preset row.
           *
           * It used to be possible to start a multi-hour render with one mis-click. The bar sits
           * directly under the button that summoned it, and the preset row stays visible below, so the
           * settings being confirmed are on screen while the decision is made.
           */
          asking
            ? h(RenderConfirm, {
              label: `${ASK_LABELS[asking]}（${presetLabel}）`,
              details: askDetails(asking),
              remember: rememberConfirm === true,
              onRemember: (next) => {
                // Only records the preference. It does NOT dismiss this confirmation: ticking the box
                // is a statement about future renders, and cancelling the one being asked about would
                // read as the click having thrown the action away.
                onRememberAsk?.(next)
              },
              busy,
              onCancel: () => setAsking(null),
              onConfirm: () => runAsked(),
            })
            : null),

          /**
           * The render preset lives HERE, always visible, not only inside a warning.
           *
           * The first version put it in a conditional card that appeared only when a compiled board
           * contained fast motion under a turbo preset. That is three conditions, and on a project
           * with no detected action it was simply absent — so "where is the quality mode" had no
           * answer. A setting this consequential should not be reachable only through a warning.
           *
           * It is also the setting that decides whether 武打/跳舞 smears: turbo sampling at 8 steps
           * is a distillation shortcut, and fast motion is exactly what it gives up.
           */
          h(RenderPresetPicker, {
            presets: presetTable,
            current: presetKey,
            onChange: onPreset,
            autoQuality,
            onAutoQuality,
            // Local mirror of the measured cost model, so the picker can say what each preset costs.
            // Compared against the host in `verify-render.mjs` — a drifting copy would promise 8
            // steps' timing for a 20-step render.
            estimateSeconds: (entry) => estimateClipSecondsMirror(243, entry),
          })),

        h('div', { className: 'sd-card' },
          h('h3', null, '任务队列'),
          runs.length === 0
            ? h('p', { className: 'sd-hint' }, '暂无任务。')
            : h('div', { className: 'sd-queue' }, runs.map((run) => h(RunCard, { key: run.id, run, onCancel })))),

        // Images left, videos right, in one row. They answer the same question —
        // "what came out of the render?" — and reading them side by side beats
        // scrolling past one to reach the other.
        h('div', { className: 'sd-split' },
        // Images get their own card, ahead of the videos and separated from them.
        // There was no way to LOOK at what had been generated — the tab reported a
        // count and nothing else — so a regenerated keyframe was indistinguishable
        // from the one it replaced, which matters most when the new frame closely
        // resembles the old one.
        h('div', { className: 'sd-card' },
          h('h3', null, images.length ? `成图 · ${images.length}` : '成图'),
          images.length === 0
            ? h('p', { className: 'sd-hint' }, '还没有图片。先在「分镜」页出参考图或关键帧。')
            : h('div', { className: 'sd-gallery' },
              // Newest first, each tile carrying the time it was made: "did that
              // regenerate?" is answered by the timestamp even when two frames look
              // alike, which is exactly when the question gets asked.
              [...images]
                .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
                .map((asset) => h('figure', { key: asset.id, className: 'sd-tile' },
                  h('img', {
                    src: assetUrl(project.id, asset.id),
                    alt: asset.label ?? '',
                    loading: 'lazy',
                    onClick: () => onPreview({
                      src: assetUrl(project.id, asset.id),
                      label: asset.label ?? asset.id,
                      detail: asset.prompt,
                    }),
                    title: '点击放大预览',
                  }),
                  // The same action the video card offers: locate this file. Without
                  // it the only way to a keyframe on disk was to open the whole project
                  // folder and hunt for a timestamped name.
                  h('div', { className: 'sd-tile-bar' },
                    h('span', { className: 'sd-tile-label' }, asset.label ?? asset.id),
                    h('button', {
                      className: 'sd-btn', 'data-size': 'sm',
                      title: '在文件管理器中定位这张图片',
                      onClick: (event) => { event.stopPropagation(); onOpenFolder(asset.id) },
                    }, '📂')),
                  h('span', { className: 'sd-thumb-time' },
                    new Date(asset.createdAt).toLocaleTimeString('zh-CN', { hour12: false })))))),

        // Always rendered, even with nothing to merge: this card is where the merge
        // feature lives, and hiding it until an artifact exists made the feature look
        // absent to anyone who had not rendered yet.
        h('div', { className: 'sd-card' },
          h('div', { className: 'sd-clip-head' },
            h('h3', null, videos.length ? `成片 · ${videos.length}` : '成片合成'),
            h('button', {
              className: 'sd-btn', 'data-size': 'sm', style: { marginLeft: 'auto' },
              disabled: !videos.length,
              onClick: () => setPicked(new Set(ordered.map((a) => a.id))),
            }, '全选'),
            h('button', {
              className: 'sd-btn', 'data-size': 'sm', disabled: !videos.length,
              onClick: () => setPicked(new Set()),
            }, '全不选'),
            h('button', {
              className: 'sd-btn', 'data-size': 'sm', 'data-variant': 'primary',
              disabled: busy || pickedOrder.length < 2,
              title: pickedOrder.length < 2 ? '至少勾选两段才能合成' : `按列表顺序拼成 ${pickedOrder.length} 段`,
              onClick: () => onMerge(pickedOrder),
            }, `合并选中（${pickedOrder.length}/${ordered.length}）`)),
          videos.length
            ? h('p', { className: 'sd-hint' }, '勾选要保留的片段，按列表顺序拼成一条。合并是流复制，无损、几秒完成。')
            : h('p', { className: 'sd-hint' }, '还没有成片。先到「分镜」页给镜头出关键帧，再点上面的「出片（H3）」，渲染完成后回到这里勾选并合成整片。'),
            videos.length ? h(GripPanel, {
              // A board of eighty shots produces up to sixty videos; the grid grows with the film
              // and used to push the 片段 table and the prompt list off the tab entirely.
              height: clipHeight,
              min: 140,
              max: 900,
              defaultHeight: 360,
              label: '成片',
              hint: '上下拖动上面的横条调整成片区域高度（双击恢复默认）',
              footerLeft: `${videos.length} 条成片 · 显示 ${clipHeight}px`,
              onResizeEnd: saveHeight('clipPanelHeight'),
              // The grid is one child of the panel, and it scrolls inside it: the panel sets the
              // HEIGHT and the grid keeps its own columns, so widening the window still reflows.
            }, h('div', { className: 'sd-grid' },
              ordered.map((asset) => h('div', { key: asset.id, style: { marginBottom: 0 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 4 } },
                  h('input', {
                    type: 'checkbox',
                    checked: pickedIds.has(asset.id),
                    onChange: () => setPicked(() => {
                      const next = new Set(pickedIds)
                      if (next.has(asset.id)) next.delete(asset.id)
                      else next.add(asset.id)
                      return next
                    }),
                  }),
                  h('span', { className: 'sd-hint', style: { margin: 0 } },
                    `${asset.label ?? asset.id}${asset.origin === 'merge' ? '（合辑）' : ''}${asset.seconds ? ` · ${asset.seconds.toFixed(1)}s` : ''}`),
                  h('button', {
                    className: 'sd-btn', 'data-size': 'sm', style: { marginLeft: 6 },
                    title: '在文件管理器中定位这个文件',
                    onClick: () => onOpenFolder(asset.id),
                  }, '📂')),
                h('video', { className: 'sd-video', src: assetUrl(project.id, asset.id), controls: true, preload: 'metadata' })))))
              : null)),

        clips.length
          ? h('div', { className: 'sd-card' },
            h('h3', null, '片段'),
            // An eighty-shot board is sixty clips, and the table used to run the full height of
            // the page. Same grip, same gesture as the 成片 strip above.
            h(GripPanel, {
              height: tableHeight,
              min: 120,
              max: 900,
              defaultHeight: 300,
              label: '片段表',
              footerLeft: `${clips.length} 段 · 显示 ${tableHeight}px`,
              onResizeEnd: saveHeight('tablePanelHeight'),
            },
            h('table', { className: 'sd-table' },
              h('thead', null, h('tr', null, ['片段', '时长', '帧', '镜头', '状态', ''].map((l) => h('th', { key: l }, l)))),
              h('tbody', null, clips.map((clip) => h('tr', { key: clip.index },
                h('td', { className: 'num' }, clip.index + 1),
                h('td', { className: 'num' }, `${clip.seconds}s`),
                h('td', { className: 'num' }, clip.frames),
                h('td', { className: 'sd-mono' }, clip.shotIds.join(', ')),
                h('td', null, clip.rendered ? h(Badge, { tone: 'ok' }, '已出片') : h(Badge, null, '未出片')),
                h('td', null, h('button', {
                  className: 'sd-btn', 'data-size': 'sm', disabled: busy,
                  onClick: () => onRender('video', { projectId: project.id, clipIndexes: [clip.index], force: true }),
                }, '单出这一段'))))))))
          : null,

        // The compiled prompt per clip, verbatim. This is the only text besides the
        // frames the model reads, and the render costs minutes — reading it first is
        // the difference between catching a wrong description and paying for it.
        // A native <details> so this needs no state and cannot disturb render order.
        clips.some((clip) => clip.prompt)
          ? h('div', { className: 'sd-card' },
            h('h3', null, '各段提示词'),
            h('p', { className: 'sd-hint' }, '出片前先对一遍：下面是每一段实际送给模型的完整提示词。'),
            clips.map((clip) => h('details', { key: clip.index, style: { marginBottom: 6 } },
              h('summary', { style: { cursor: 'pointer', fontSize: 12, padding: '3px 0' } },
                `第 ${clip.index + 1} 段 · ${clip.seconds}s · ${clip.frames} 帧 · ${clip.shotIds.length} 个镜头`),
              h('pre', { className: 'sd-prompt' }, clip.prompt))))
          : null,

        images.length && !videos.length
          ? h('p', { className: 'sd-hint' }, `已生成 ${images.length} 张图片（参考图 / 关键帧）。`)
          : null,

      )
    }

    // ----------------------------------------------------------- studio shell

    /**
     * The five pipeline stages as a stepper.
     *
     * The stages are genuinely sequential — a script before a cast, a cast before
     * a storyboard, keyframes before clips — so the UI should say so. Previously
     * they were flat tabs with no order and no sense of where you were, and one
     * action (generating reference art) jumped the user to a different tab
     * entirely, which read as the modules being unrelated.
     *
     * Each step reports its own completion, the first unfinished one is marked as
     * the next move, and a stage with work in flight shows a spinner.
     */
    /**
     * Full-screen preview for a generated image.
     *
     * Judging a reference or a keyframe means looking at it properly. The card
     * thumbnail is far too small to spot a wrong face, a stray limb or a broken
     * background — which is exactly the judgement the operator is trying to make.
     *
     * The prompt is shown alongside rather than hidden behind a tab: "is this image
     * wrong?" is almost always answered by comparing it with what was asked for, and
     * making that a second navigation step defeats the purpose.
     */
    function Lightbox({ item, onClose }) {
      React.useEffect(() => {
        if (!item) return undefined
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        // The overlay is fixed and full-bleed, so background scrolling would move
        // the page underneath it and lose the reader's place.
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          window.removeEventListener('keydown', onKey)
          document.body.style.overflow = previous
        }
      }, [item, onClose])

      if (!item) return null
      return h('div', {
        className: 'sd-lightbox',
        role: 'presentation',
        onClick: onClose,
      },
      h('div', {
        className: 'sd-lightbox-body',
        onClick: (event) => event.stopPropagation(),
      },
      h('img', { className: 'sd-lightbox-img', src: item.src, alt: item.label ?? '' }),
      h('div', { className: 'sd-lightbox-meta' },
        h('div', { className: 'sd-clip-head', style: { marginBottom: 0 } },
          h('strong', null, item.label ?? ''),
          h('button', {
            className: 'sd-btn', 'data-size': 'sm', style: { marginLeft: 'auto' },
            onClick: () => downloadAsset(item.src, safeFileName(item.label, item.ext)).catch(() => {}),
          }, '保存图片'),
          h('button', { className: 'sd-btn', 'data-size': 'sm', onClick: onClose }, '关闭 (Esc)')),
        item.detail ? h('p', { className: 'sd-hint', style: { margin: '4px 0 0' } }, item.detail) : null,
        // Guarded by type, not just truthiness. An object here is a React crash that
        // takes the whole panel down, and a prompt is the one field a caller can
        // plausibly pass the wrong thing for.
        typeof item.prompt === 'string' && item.prompt
          ? h('details', { style: { marginTop: 6 } },
            h('summary', { style: { cursor: 'pointer' } }, '出图提示词'),
            h('pre', { className: 'sd-pre', style: { marginTop: 6, maxHeight: 200 } }, item.prompt))
          : null)))
    }

    /**
     * Fetch an asset as a blob and hand it to the browser as a download.
     *
     * Blob rather than a bare `<a download>`: the asset response carries no
     * content-disposition, and going through a blob guarantees the suggested
     * filename survives and that nothing renders inline instead of saving.
     */
    async function downloadAsset(url, filename) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`)
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
    }

    /** A filesystem-safe filename from a label and an extension. */
    function safeFileName(label, ext) {
      const base = String(label ?? 'asset')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'asset'
      return `${base}.${ext || 'png'}`
    }

    /**
     * Right-click menu for a generated image.
     *
     * Electron does not show the browser's native image menu — the "save image as"
     * item people expect simply is not there — so the menu has to be built. It
     * offers the three things worth doing with a rendered artifact: look at it
     * properly, keep it, or find it on disk.
     */
    function ImageMenu({ menu, onClose, onPreview, onDownload, onReveal }) {
      React.useEffect(() => {
        if (!menu) return undefined
        const dismiss = () => onClose()
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        // Any of these means the menu is stale: the pointer moved to a new target
        // or the page shifted under it.
        window.addEventListener('click', dismiss)
        window.addEventListener('contextmenu', dismiss)
        window.addEventListener('scroll', dismiss, true)
        window.addEventListener('resize', dismiss)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('click', dismiss)
          window.removeEventListener('contextmenu', dismiss)
          window.removeEventListener('scroll', dismiss, true)
          window.removeEventListener('resize', dismiss)
          window.removeEventListener('keydown', onKey)
        }
      }, [menu, onClose])

      if (!menu) return null
      // Keep the menu on screen: a right-click near the bottom-right corner would
      // otherwise open it past the viewport with no way to reach the last item.
      const width = 168
      const height = 132
      const left = Math.min(menu.x, Math.max(8, window.innerWidth - width - 8))
      const top = Math.min(menu.y, Math.max(8, window.innerHeight - height - 8))

      const item = (label, action, disabled) => h('button', {
        className: 'sd-ctxmenu-item',
        key: label,
        disabled: Boolean(disabled),
        onClick: (event) => { event.stopPropagation(); onClose(); action() },
      }, label)

      return h('div', {
        className: 'sd-ctxmenu',
        style: { left, top },
        onClick: (event) => event.stopPropagation(),
      },
      item('放大预览', onPreview),
      item('保存图片', onDownload, !onDownload),
      item('在文件夹中显示', onReveal, !onReveal))
    }

    /**
     * Warns that the board predates the current script.
     *
     * This is the whole point of the fingerprint: regenerating the script leaves
     * the board alone (shots may have been hand-edited, and discarding that silently
     * would be worse), so the operator ends up compiling prompts that describe the
     * script they just replaced. Nothing in the output reveals it, so it has to be
     * said out loud, next to the action that fixes it.
     */
    function StaleNotice({ compiled, busy, onResplit }) {
      if (!compiled || (!compiled.scriptStale && !compiled.scriptStaleUnknown)) return null
      if (compiled.scriptStale) {
        return h('div', { className: 'sd-confirm' },
          h('span', null, '⚠ 剧本在分镜之后被重新生成过。当前分镜与提示词仍然描述的是旧剧本，标题和台词都对不上。'),
          h('button', {
            className: 'sd-btn', 'data-size': 'sm', 'data-variant': 'primary',
            disabled: busy,
            onClick: onResplit,
          }, '按新剧本重新拆分镜头'))
      }
      // Older projects predate the fingerprint, so staleness cannot be judged.
      // Saying "unknown" is honest; claiming either state would not be.
      return h('p', { className: 'sd-hint' },
        '这个项目的分镜早于剧本版本记录，无法判断是否与当前剧本一致。如果提示词内容不对，重新拆分镜头即可。')
    }

    function PipelineStepper({ project, compiled, runs, tab, onSelect }) {
      const shots = project?.shots ?? []
      // Four stages, not five.
      //
      // 提示词 used to sit between 分镜 and 出图出片 as a numbered step, which was
      // misleading twice over: it cannot precede them, because compiling needs the
      // board to exist; and it is not a stage at all, because it produces nothing
      // the next step consumes. It is a read-only projection of the other three,
      // so it is offered as a check rather than a step you must clear.
      const stages = [
        { key: 'script', label: '剧本', done: Boolean(project?.script), action: '生成剧本', kinds: ['script'] },
        { key: 'cast', label: '人物场景', done: (project?.characters?.length ?? 0) > 0, action: '抽取人物与场景', kinds: ['cast', 'reference'] },
        { key: 'storyboard', label: '分镜', done: shots.length > 0, action: '拆分镜头', kinds: ['storyboard'] },
        // Unnumbered too: it is a read-only projection of the other three, not a
        // step that must be cleared before the film can be produced.
        { key: 'prompts', label: '提示词', done: Boolean(compiled), action: '编译提示词', kinds: [], plain: true, glyph: '👁' },
        // Unnumbered: the first four PREPARE the film, this one PRODUCES it. Giving
        // it a "4" made it read as one more thing to clear before the real work.
        { key: 'render', label: '出图出片', done: shots.some((s) => s.videoAssetId), action: '出图与出片', kinds: ['keyframe', 'video'], plain: true, glyph: '▶' },
      ]
      const nextIndex = stages.findIndex((stage) => !stage.done)
      const active = runs.filter((run) => run.status === 'running')

      return h('div', { className: 'sd-steps' },
        stages.map((stage, index) => {
          const state = stage.done ? 'done' : index === nextIndex ? 'next' : 'todo'
          const running = active.find((run) => stage.kinds.includes(run.kind))
          const children = [
            h('span', { key: 'n', className: 'sd-step-num', 'data-plain': stage.plain ? '1' : '0' },
              stage.done ? '✓' : (stage.plain ? (stage.glyph ?? '▶') : String(index + 1))),
            h('span', { key: 'l', className: 'sd-step-label' }, stage.label),
          ]
          if (running) children.push(h('span', { key: 's', className: 'sd-spin' }))
          if (index < stages.length - 1) {
            // The arrow lives inside the previous step so the row stays flush.
            children.push(h('span', { key: 'a', className: 'sd-step-arrow' }, '›'))
          }
          return h('button', {
            key: stage.key,
            type: 'button',
            className: 'sd-step',
            'data-state': state,
            'data-running': running ? '1' : '0',
            'data-on': tab === stage.key ? '1' : '0',
            title: stage.done ? '已完成' : `下一步：${stage.action}`,
            onClick: () => onSelect(stage.key),
          }, children)
        }))
    }

    function PromptStudio() {
      ensureStyles()
      const [projectsState, reloadProjects] = useAsync(() => api.listProjects(), [])
      // Models per provider, for the two selects in the settings page.
      const [activeId, setActiveId] = React.useState(() => readRememberedProject())
      const [tab, setTab] = React.useState('script')
      const [project, setProject] = React.useState(null)
      const [compiled, setCompiled] = React.useState(null)
      // Fetched independently of `compiled`, which is null until a project has shots.
      // Without this the three output selectors disappear on every new project.
      const [catalogues, setCatalogues] = React.useState(null)
      /**
       * Which render preset is in force.
       *
       * Mirrored from the status response rather than read on demand because the 出片 tab needs it to
       * warn about action shots BEFORE a render starts — the warning is useless if it arrives after
       * the minutes have been spent.
       */
      const [presetKey, setPresetKey] = React.useState(null)
      /** Whether the video stage may raise a clip's quality on its own. Mirrored so the 出片 tab can
       *  show and change it without a round trip. */
      const [autoQuality, setAutoQuality] = React.useState(true)
      /**
       * Which render button was last pressed, and whether the host took the job.
       *
       * It belongs HERE, not in `RenderTab`: `startRender` is the only thing that knows whether the
       * request was accepted (a button that ticks on a FAILED request would be worse than no tick),
       * and `RenderTab` mounts and unmounts as the operator changes tabs — so a state hook inside it
       * would be thrown away on every switch.
       */
      const [renderPress, setRenderPress] = React.useState({ pending: null, done: null })
      /**
       * Whether the render buttons still ask before starting.
       *
       * Persisted, because it is a working preference: while iterating on parameters the question is
       * friction, and while committing to a long render it is the whole point. Absent means ask.
       */
      const [rememberConfirm, setRememberConfirm] = React.useState(false)
      React.useEffect(() => {
        let live = true
        api.status(false)
          .then((data) => {
            if (!live || !data || data.error) return
            setCatalogues(data)
            setPresetKey((current) => current ?? data.config?.comfy?.preset ?? 'standard')
            setAutoQuality(data.config?.comfy?.autoQuality !== false)
            setRememberConfirm(data.config?.ui?.skipRenderConfirm === true)
          })
          .catch(() => { /* the selectors fall back to nothing rather than breaking */ })
        return () => { live = false }
      }, [])

      /**
       * Panel heights and other view preferences, read once and written back on change.
       *
       * Held here rather than inside `RenderTab` because a component that is unmounted when the
       * operator switches tabs would lose the value it just dragged to — the write has to outlive
       * the tab, and so does the value that is handed back down.
       */
      const [uiConfig, setUiConfig] = React.useState(null)
      React.useEffect(() => {
        let live = true
        api.loadConfig()
          .then((data) => { if (live && data?.config?.ui) setUiConfig(data.config.ui) })
          .catch(() => { /* the panels fall back to their built-in defaults */ })
        return () => { live = false }
      }, [])
      const saveUi = (patch) => {
        // Optimistic: the drag has already happened on screen, and waiting for a round trip to
        // redraw the height would make the panel snap back under the pointer.
        setUiConfig((previous) => ({ ...(previous ?? {}), ...patch }))
        api.saveConfig({ ui: patch })
          .then((data) => { if (data?.config?.ui) setUiConfig(data.config.ui) })
          .catch(() => { /* the height stays for this session and the next drag tries again */ })
      }
      // One preview surface for every generated image, owned here so a click in any
      // tab opens the same overlay and Esc always means the same thing.
      const [lightbox, setLightbox] = React.useState(null)
      const closeLightbox = React.useCallback(() => setLightbox(null), [])
      // Right-click target for an artifact: position plus everything the menu needs
      // to act on it, captured at click time so a later re-render cannot shift it.
      const [menu, setMenu] = React.useState(null)
      const closeMenu = React.useCallback(() => setMenu(null), [])
      const openMenu = React.useCallback((event, info) => {
        event.preventDefault()
        event.stopPropagation()
        setMenu({ x: event.clientX, y: event.clientY, ...info })
      }, [])
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      // Arming expires so a stray click cannot leave a live delete button behind.
      React.useEffect(() => {
        if (!confirmDelete) return undefined
        const timer = setTimeout(() => setConfirmDelete(false), 6000)
        return () => clearTimeout(timer)
      }, [confirmDelete])
      const [runs, runsError, hostMismatch] = useRuns()

      const projects = projectsState.data?.projects ?? []
      const anyRunning = runs.some((run) => run.status === 'running')

      /**
       * The four output settings a new project should start from.
       *
       * Seeded from the project that is open — the list is ordered by `updatedAt`, so `projects[0]`
       * is the one actually being worked on — and then updated every time the operator changes one
       * of those controls. Without this a new project always opened on the hardcoded 9:16 / 60s /
       * 2MP, which is why it never matched the project in use.
       *
       * Kept in a ref rather than state: it is read once per creation and must not trigger a
       * re-render of the whole studio when a dropdown changes.
       */
      const lastUsed = React.useRef(null)
      const seedFrom = projects.find((p) => p.id === activeId) ?? projects[0] ?? null
      if (!lastUsed.current) {
        lastUsed.current = {
          ratio: seedFrom?.ratio ?? '9:16',
          // The project's own budget when it has one, else the configured default that
          // `store.js` will fall back to anyway. `null` here means "let the host decide".
          imageMegapixels: seedFrom?.imageMegapixels ?? null,
          style: seedFrom?.style ?? 'cinematic realism, natural lighting',
          targetTotalSec: seedFrom?.targetTotalSec ?? 60,
          // 0 means "do not override": a project that has never had this setting must inherit the
          // configured value, and `null` would be coerced to 0 by `Number(null)` and then written
          // onto the project as a real zero-length clip.
          clipSeconds: Number(seedFrom?.clipSeconds) > 0 ? Number(seedFrom.clipSeconds) : 0,
        }
      }
      /** Called by the 剧本 tab whenever one of those controls changes. */
      const rememberSettings = (patch) => {
        lastUsed.current = { ...lastUsed.current, ...patch }
      }

      // Restore what was remembered, but only while it still exists: a deleted
      // project must not leave the panel pointing at a ghost, and the list may load
      // after the first render.
      React.useEffect(() => {
        if (projects.length === 0) return
        if (activeId && projects.some((p) => p.id === activeId)) return
        setActiveId(projects[0].id)
      }, [projects, activeId])

      // Written on every change, including the fallback above, so the remembered
      // value is always one the panel actually managed to display.
      React.useEffect(() => { rememberProject(activeId) }, [activeId])

      const loadProject = React.useCallback(async (id) => {
        if (!id) { setProject(null); return }
        try {
          const payload = await api.getProject(id)
          setProject(payload?.project ?? null)
        } catch (err) { setError(err) }
      }, [])

      React.useEffect(() => {
        let live = true
        setCompiled(null); setError(null); setNotice(null)
        if (!activeId) { setProject(null); return () => { live = false } }
        api.getProject(activeId)
          .then((payload) => { if (live) setProject(payload?.project ?? null) })
          .catch((err) => { if (live) setError(err) })
        return () => { live = false }
      }, [activeId])

      // Progressive preview, and the reason it exists:
      //
      // Each render writes its artifact and persists the project as soon as that
      // ONE item finishes. But refreshing only when the whole run settled meant a
      // ten-minute batch showed nothing until the very end — ComfyUI visibly
      // produced images while the studio stayed empty. So reload whenever an
      // active run's item counter advances, not just when it completes.
      // Keyed on the progress MESSAGE as well as the counter, because `current` is
      // "item N is being worked on" (1-based, set when the item STARTS), not "N
      // items are done". A single-item render therefore reaches its final counter
      // value immediately and never changes it again — so keying on the counter
      // alone meant the artifact only appeared once the whole run had finished.
      // The message changes to "done" AFTER the persist, which is the moment the
      // new asset is first readable.
      const progressKey = runs
        .filter((run) => run.projectId === activeId && (run.status === 'running' || run.current > 0))
        .map((run) => `${run.id}:${run.current}:${run.message ?? ''}`)
        .join('|')
      const lastProgress = React.useRef('')
      React.useEffect(() => {
        if (!activeId) return
        if (progressKey === lastProgress.current) return
        const hadProgress = lastProgress.current !== ''
        lastProgress.current = progressKey
        // Skip the first observation: it is just the existing state, not news.
        if (hadProgress || progressKey) loadProject(activeId)
      }, [progressKey, activeId, loadProject])

      // Settled runs also refresh the project list, since a new project or a
      // changed shot count should show up in the picker.
      const finishedCount = React.useRef(0)
      React.useEffect(() => {
        const finished = runs.filter((run) => run.status !== 'running').length
        if (finished !== finishedCount.current) {
          finishedCount.current = finished
          if (activeId) loadProject(activeId)
          reloadProjects()
        }
      }, [runs, activeId, loadProject, reloadProjects])

      const startRun = async (kind, request) => {
        setError(null); setNotice(null)
        try {
          const started = await api.generate(kind, request)
          if (!started.ok) throw new Error(started.error?.message ?? '启动失败')
          setNotice('已开始生成，进度见「出片」页的任务队列')
        } catch (err) { setError(err) }
      }

      /** Poll a run to settlement from the client so stages can be chained. */
      const waitForRun = async (runId) => {
        for (let i = 0; i < 900; i += 1) {
          const payload = await api.run(runId)
          const run = payload?.run
          if (!run || run.status !== 'running') return run
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
        return null
      }

      /**
       * One-click pipeline: script → cast → storyboard, chained client-side.
       *
       * Each stage is a separate run because each is independently re-runnable and
       * writes its own part of the project; chaining them here keeps the server
       * stages single-purpose while still giving one button.
       */
      const runFullPipeline = async ({ targetSec, clipSeconds, brief }) => {
        if (!activeId) return
        setBusy(true); setError(null); setNotice(null)
        const stages = [
          /**
           * `brief` is passed, and its absence was the whole defect.
           *
           * This list used to send only `targetSec`, so 一键生成 asked for a script with NO creative
           * direction at all: the model invented one from the project's title, and whatever the
           * operator had pasted into 创作要求 never reached the LLM. The single 生成剧本 button was
           * fixed for the same class of bug earlier; this path was missed, which is why "it still
           * ignores my script" survived that fix.
           *
           * A stage that silently drops the operator's input is worse than one that fails: it returns
           * a complete, plausible script that is about something else.
           */
          ['script', { targetSec, brief }, '生成剧本'],
          ['cast', {}, '抽取人物与场景'],
          ['storyboard', { targetSec, clipSeconds }, '拆分镜头'],
        ]
        try {
          for (const [kind, extra, label] of stages) {
            setNotice(`正在${label}…`)
            const started = await api.generate(kind, { projectId: activeId, ...extra })
            if (!started.ok) throw new Error(started.error?.message ?? `${label}启动失败`)
            const run = await waitForRun(started.runId)
            if (!run) throw new Error(`${label}超时未返回`)
            if (run.status !== 'done') throw new Error(`${label}失败：${run.error?.message ?? run.status}`)
            await loadProject(activeId)
          }
          setNotice('全流程完成 —— 下一步：到「人物场景」出参考图')
        } catch (err) {
          setError(err)
        } finally {
          setBusy(false)
          loadProject(activeId)
        }
      }

      /** Ask the host to show an artifact in the OS file manager. */
      const openFolder = async (assetId) => {
        if (!activeId) return
        try {
          const result = await api.reveal({ projectId: activeId, assetId })
          if (!result.ok) throw new Error(result.error?.message ?? '无法打开文件夹')
        } catch (err) { setError(err) }
      }

      /** Rebuild the board from the current script, which is what clears staleness. */
      const resplitShots = async () => {
        if (!activeId) return
        setError(null); setNotice(null)
        try {
          const started = await api.generate('storyboard', { projectId: activeId })
          if (!started.ok) throw new Error(started.error?.message ?? '启动失败')
          // The previous compile describes the previous board; keeping it on screen
          // would show exactly the stale text this button exists to remove.
          setCompiled(null)
          setNotice('正在按新剧本重新拆分镜头…')
        } catch (err) { setError(err) }
      }

      const startRender = async (kind, request) => {
        setError(null); setNotice(null)
        setRenderPress({ pending: kind, done: null })
        try {
          const started = await api.render(kind, request)
          if (!started.ok) throw new Error(started.error?.message ?? '启动失败')
          // Deliberately does NOT jump to another tab. Starting a render from the
          // cast page used to yank the user into 出图出片, which made the five
          // stages feel like unrelated screens. Progress shows inline instead, and
          // the stepper marks the stage.
          setNotice({
            reference: '已开始出参考图，进度见下方',
            keyframe: '已开始出关键帧，进度见下方',
            video: '已开始出片（可能数分钟），进度见下方',
          }[kind] ?? '已开始渲染，进度见下方')
          // Only now does the button tick. `done` is what the tick is driven by, so a rejected
          // request leaves the button unmarked and the error message is the only thing shown.
          setRenderPress({ pending: null, done: kind })
        } catch (err) {
          setRenderPress({ pending: null, done: null })
          setError(err)
        }
      }

      /**
       * Read the chosen file in the page and post it as a data URL.
       *
       * The bytes are already here, so this avoids a multipart route; the host
       * stores them verbatim.
       */
      const uploadReference = async (entityId, file) => {
        setError(null); setNotice(null)
        try {
          if (file.size > 24 * 1024 * 1024) throw new Error('图片超过 24 MB，请先压缩')
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(new Error('读取文件失败'))
            reader.readAsDataURL(file)
          })
          const result = await api.upload({ projectId: activeId, entityId, dataUrl, filename: file.name })
          if (!result.ok) throw new Error(result.error?.message ?? '上传失败')
          setNotice('已用作参考图')
          await loadProject(activeId)
        } catch (err) { setError(err) }
      }

      const restyleEntity = async (entityId, instruction) => {
        setError(null); setNotice(null)
        try {
          const started = await api.restyle({ projectId: activeId, entityId, instruction })
          if (!started.ok) throw new Error(started.error?.message ?? '启动失败')
          setNotice('已开始重绘（约半分钟），完成后自动更新')
        } catch (err) { setError(err) }
      }

      /**
       * Archive the open project to a file, or bring one back.
       *
       * The picker is a plain <select>, so a growing library becomes unusable long
       * before the store does. Export/import is what keeps the list bounded: park
       * finished projects as files and pull one back when you return to it.
       */
      const saveProjectToFile = () => {
        if (!project) return
        try {
          const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = (project.title || project.id).replace(/[\\/:*?"<>|]/g, '_') + '.shortdrama.json'
          document.body.append(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          setNotice('已保存到下载文件夹')
        } catch (err) { setError(err) }
      }

      const importProjectFromFile = async (file) => {
        setError(null); setNotice(null)
        try {
          const text = await file.text()
          const doc = JSON.parse(text)
          if (!doc || typeof doc !== 'object' || !Array.isArray(doc.shots)) {
            throw new Error('这不像是本插件导出的项目文件')
          }
          // A fresh id: importing must never overwrite the project it came from.
          delete doc.id
          const created = await api.createProject(doc)
          reloadProjects()
          // Same shape tolerance as the create path: the route returns the project itself, so
          // `created.project` was always undefined and an imported project was never opened.
          const made = created?.project ?? created
          if (made?.id) setActiveId(made.id)
          setNotice('已导入项目：' + (made?.title ?? ''))
        } catch (err) { setError(err) }
      }

      const mergeClips = async (assetIds) => {
        setError(null); setNotice(null)
        try {
          const result = await api.merge({ projectId: activeId, assetIds })
          if (!result.ok) {
            const detail = result.error?.detail ? `（${String(result.error.detail).split('\n').slice(-1)[0]}）` : ''
            throw new Error((result.error?.message ?? '合并失败') + detail)
          }
          const secs = result.asset.seconds ? ` ${result.asset.seconds.toFixed(1)}s` : ''
          setNotice(`已合并 ${assetIds.length} 段 → ${result.asset.label ?? result.asset.id}${secs}（${result.asset.mode === 'reencode' ? '重新编码' : '无损复制'}）`)
          await loadProject(activeId)
        } catch (err) { setError(err) }
      }

      const cancelRun = async (id) => {
        try { await api.cancelRun(id) } catch (err) { setError(err) }
      }

      /**
       * `quiet` skips the busy flag. The compiled board is DERIVED state that three
       * tabs read, but it used to be produced only by a button on one of them, so
       * the storyboard and the render tab saw null and drew empty vocabularies and
       * blank clip tables. Deriving it automatically is what makes those tabs work;
       * flashing the global busy state every time the board changes is not.
       */
      const compile = async ({ quiet = false } = {}) => {
        if (!activeId) return
        if (!quiet) setBusy(true)
        setError(null); setNotice(null)
        try {
          const result = await api.compile({ projectId: activeId })
          if (!result.ok) throw new Error(result.error?.message ?? '编译失败')
          setCompiled(result)
          // Only for a manual compile.
          //
          // The auto-compile runs on every project write, so a notice there would
          // appear whenever anything is typed anywhere — noise, and it would train you
          // to ignore the one case where the notice matters. This one confirms a
          // BUTTON PRESS, and without it the button did nothing visible when it
          // worked: no error, no change on screen, and no way to tell whether the
          // prompts had actually been rebuilt.
          if (!quiet) {
            const size = result.resolution ?? {}
            const stale = result.scriptStale ? ' · 剧本已改动，建议重出分镜' : ''
            setNotice(`已重新编译 · ${(result.clips ?? []).length} 个片段 · 画布 ${size.width}×${size.height}${stale}`)
          }
        } catch (err) { setError(err) } finally { if (!quiet) setBusy(false) }
      }

      // Re-derive whenever the board could have changed. Keyed on the project's
      // updatedAt, which the API bumps on every write, so an edit in any tab flows
      // into the shared compile result without anyone pressing a button.
      React.useEffect(() => {
        if (!activeId || !project) return
        if (!Array.isArray(project.shots) || project.shots.length === 0) { setCompiled(null); return }
        compile({ quiet: true })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [activeId, project?.updatedAt])

      const exportBundle = async () => {
        if (!activeId) return
        setBusy(true); setError(null); setNotice(null)
        try {
          const result = await api.exportPrompts({ projectId: activeId })
          if (!result.ok) throw new Error(result.error?.message ?? '导出失败')
          setCompiled(result)
          const skipped = result.export.skipped ?? []
          setNotice(
            `已导出 ${result.export.written.length} 个文件到 ${result.export.dir}（用旁边的「📂 打开导出文件夹」可直接打开）`
            + (skipped.length ? `（${skipped.join('；')}）` : ''),
          )
        } catch (err) { setError(err) } finally { setBusy(false) }
      }

      /**
       * Create the sample project: a cast, a scene and two shots, ready to look at.
       *
       * Reverted to one-click on request. The create FORM that briefly stood here asked for ratio
       * and resolution up front, which is where those settings belong — but it was also the change
       * that coincided with the panel looking wrong, so it is out until that is understood.
       *
       * The `created?.project ?? created` line is kept: it is an unrelated bug fix. The route
       * returns the project ITSELF, not `{ project }`, so reading only `created.project.id` never
       * fired and a newly created or imported project was never opened.
       */
      const createSample = async () => {
        setBusy(true)
        try {
          const created = await api.createProject({
            title: '示例 · 天台合约',
            genre: '都市逆袭',
            ratio: '9:16',
            style: 'cinematic realism, neon night, cool-warm contrast, shallow depth of field',
            logline: '被合伙人背叛的女主在天台夺回属于自己的一切',
            audioStyle: 'tense synth pulse, 90 BPM',
            characters: [
              { id: 'c1', name: 'Lin Wan', role: '女主', age: '26', lockToken: 'Lin Wan, 26, shoulder-length black hair, beige trench coat' },
              { id: 'c2', name: 'Chen Mo', role: '对手', age: '34', lockToken: 'Chen Mo, 34, short cropped hair, dark navy suit' },
            ],
            scenes: [
              { id: 'sc1', name: 'Rooftop', location: 'high-rise rooftop', timeOfDay: 'night', lighting: 'neon rim light, wet concrete', lockToken: 'rooftop at night, neon rim light, wet concrete' },
            ],
            shots: [
              { id: 'sh1', no: 1, sceneId: 'sc1', durationSec: 3, shotSize: '中近景', camera: '过肩', movement: '推近', action: 'Lin Wan slams the contract onto the table', dialogue: [{ who: 'Lin Wan', line: '这笔账，今天算清。' }], sfx: 'paper slap', characters: ['c1'] },
              { id: 'sh2', no: 2, sceneId: 'sc1', durationSec: 2, shotSize: '特写', camera: '仰拍', movement: '固定', action: "Chen Mo's smile freezes, a vein twitches at his temple", sfx: 'low string swell', characters: ['c2'] },
            ],
          })
          reloadProjects()
          const made = created?.project ?? created
          if (made?.id) setActiveId(made.id)
        } catch (err) { setError(err) } finally { setBusy(false) }
      }

      /**
       * Create an empty project, seeded from the settings LAST USED rather than from constants.
       *
       * This used to write `ratio: '9:16', targetTotalSec: 60, style: 'cinematic realism…'` and
       * nothing else, so every new project opened on 9:16 / 60s / 2MP no matter what the operator
       * had configured — the settings row on the 剧本 tab did not feed back into creation at all,
       * and a project in use (21:9, 300s) looked nothing like a fresh one. The four values below
       * are the ones that row controls, so they are the four that get remembered.
       *
       * Deliberately NOT a dialog: the operator asked for the form to be removed once already. The
       * settings stay visible and editable on the 剧本 tab; this only makes them stick.
       */
      const createBlank = async () => {
        setBusy(true)
        try {
          const seed = lastUsed
          const created = await api.createProject({
            title: '未命名短剧',
            ratio: seed.ratio,
            imageMegapixels: seed.imageMegapixels,
            style: seed.style,
            targetTotalSec: seed.targetTotalSec,
            // Omitted rather than sent as 0: the host treats a non-positive value as "keep the
            // configured default", but sending the key at all is only meaningful when it is real.
            ...(Number(seed.clipSeconds) > 0 ? { clipSeconds: Number(seed.clipSeconds) } : {}),
          })
          reloadProjects()
          const made = created?.project ?? created
          if (made?.id) { setActiveId(made.id); setTab('script') }
        } catch (err) { setError(err) } finally { setBusy(false) }
      }

      /**
       * Two-step delete, confirmed inline.
       *
       * Deliberately NOT `window.confirm`: a native dialog blocks the renderer's
       * main thread, and this webview does not present one — so the click appeared
       * to freeze the entire panel with no way out. An in-page arming step has the
       * same safety with none of that.
       */
      const deleteActive = async () => {
        if (!activeId) return
        if (!confirmDelete) { setConfirmDelete(true); return }
        setConfirmDelete(false)
        setBusy(true)
        try {
          await api.removeProject(activeId)
          const remaining = projects.filter((p) => p.id !== activeId)
          setActiveId(remaining[0]?.id ?? null)
          setProject(null)
          setCompiled(null)
          reloadProjects()
          setNotice('已删除该项目')
        } catch (err) { setError(err) } finally { setBusy(false) }
      }

      // One explicit "do this next" line, derived from the project's own state so
      // it stays true no matter which tab the user is standing on.
      const nextHint = (() => {
        if (!project) return null
        if (!project.script) return { tab: 'script', text: '下一步：生成剧本' }
        if (project.characters.length === 0) return { tab: 'cast', text: '下一步：从剧本抽取人物与场景设定' }
        if (project.shots.length === 0) return { tab: 'storyboard', text: '下一步：把剧本拆成镜头表' }
        if (!compiled) return { tab: 'prompts', text: '下一步：编译提示词，先看看每个片段会被描述成什么样' }
        if (project.characters.some((c) => !c.refAssetId)) {
          return { tab: 'cast', text: '下一步：给人物出参考图——它决定角色跨镜头长得像不像' }
        }
        if (project.shots.some((s) => !s.keyframeAssetId)) return { tab: 'storyboard', text: '下一步：出关键帧（图生图，会以参考图为基准）' }
        if (project.shots.some((s) => !s.videoAssetId)) return { tab: 'render', text: '下一步：出片' }
        return null
      })()

      // Rendered in BOTH branches below. Showing failures only when a project list
      // happened to load made the panel look dead in exactly the state a first-time
      // user is in: nothing listed, every button silently failing, no reason given.
      const messages = h('div', null,
        hostMismatch
          ? h('div', { className: 'sd-err', style: { borderColor: 'var(--sd-warn)', color: 'var(--sd-warn)' } },
            '宿主版本不匹配：界面已是新版，但后端仍是旧代码。\n\n'
            + '插件修改后需要重启 DeepSeek Harness 才能让后端生效（Node 会缓存已加载的模块，'
            + '停用再启用插件不够）。')
          : null,
        projectsState.error
          ? h('div', { className: 'sd-err' }, `读取项目列表失败：${projectsState.error.message}`)
          : null,
        error ? h('div', { className: 'sd-err' }, error.message) : null,
        runsError ? h('div', { className: 'sd-err' }, `任务队列不可用：${runsError.message}`) : null,
        notice ? h('p', { className: 'sd-hint', style: { color: 'var(--sd-ok)' } }, notice) : null,
        // Deletion is confirmed here rather than by a button label change: a small
        // button whose caption flips is easy to read as "nothing happened", which
        // is exactly how this was reported twice.
        confirmDelete
          ? h('div', { className: 'sd-confirm' },
            h('span', null, '删除项目「' + (project?.title ?? activeId) + '」？它的图片和视频会一并删除，无法恢复。'),
            h('button', { className: 'sd-btn', 'data-size': 'sm', 'data-variant': 'primary', onClick: deleteActive }, '确认删除'),
            h('button', { className: 'sd-btn', 'data-size': 'sm', onClick: () => setConfirmDelete(false) }, '取消'))
          : null)

      return h('div', { className: 'sd-root', 'data-fill': '1' },
        h('div', { className: 'sd-head' },
          h('div', { className: 'sd-title' }, '短剧工作室',
            anyRunning ? h(Badge, { tone: 'warn' }, `${runs.filter((r) => r.status === 'running').length} 个任务进行中`) : null),
          h('select', {
            className: 'sd-select', style: { width: 'auto', minWidth: 190 },
            value: activeId ?? '',
            onChange: (event) => setActiveId(event.target.value || null),
          },
          projects.length === 0 ? h('option', { value: '' }, '（暂无项目）') : null,
          projects.map((p) => h('option', { key: p.id, value: p.id }, `${p.title} · ${p.shotCount} 镜`))),
          projects.length > 8 ? null : null,
          h('button', { className: 'sd-btn', onClick: createBlank, disabled: busy }, '新建项目'),
          h('button', { className: 'sd-btn', onClick: createSample, disabled: busy }, '新建示例'),
          h('button', {
            className: 'sd-btn', 'data-size': 'sm', disabled: !project,
            title: '把当前项目另存为一个文件，之后可以从文件再导回来',
            onClick: saveProjectToFile,
          }, '保存到文件'),
          h('label', {
            className: 'sd-btn', 'data-size': 'sm',
            style: { cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 },
            title: '从 .shortdrama.json 文件导入一个项目（会作为新项目加入）',
          },
          '从文件添加',
          h('input', {
            type: 'file', accept: '.json,application/json', style: { display: 'none' }, disabled: busy,
            onChange: (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) importProjectFromFile(file)
            },
          })),
          h('button', {
            className: 'sd-btn',
            'data-size': 'sm',
            'data-variant': confirmDelete ? 'primary' : undefined,
            onClick: deleteActive,
            disabled: busy || !activeId,
            title: '删除当前项目（含它的图片与视频）',
          }, '删除项目'),
          h('button', { className: 'sd-btn', 'data-size': 'sm', onClick: () => { reloadProjects(); if (activeId) loadProject(activeId) } }, '刷新')),

        projects.length === 0
          ? h('div', { className: 'sd-body' },
            messages,
            h('div', { className: 'sd-empty' },
              h('p', null, '还没有短剧项目。'),
              h('p', { className: 'sd-hint' }, '点「新建项目」或「新建示例」开始；也可以让 Agent 用 drama_project 建项目，再用 drama_script / drama_cast / drama_storyboard / drama_render 跑完整条流水线。')))
          : h(React.Fragment, null,
            h(PipelineStepper, { project, compiled, runs, tab, onSelect: setTab }),
            h(Lightbox, { item: lightbox, onClose: closeLightbox }),
            h(ImageMenu, {
              menu,
              onClose: closeMenu,
              onPreview: () => { if (menu) setLightbox({ src: menu.src, label: menu.label, detail: menu.detail, prompt: menu.prompt }) },
              onDownload: menu ? () => downloadAsset(menu.src, safeFileName(menu.label, menu.ext)).catch(setError) : null,
              onReveal: menu && menu.assetId ? () => openFolder(menu.assetId) : null,
            }),
            h('div', { className: 'sd-body' },
              messages,
              nextHint
                ? h('div', { className: 'sd-next' },
                  h('span', null, nextHint.text),
                  nextHint.tab !== tab
                    ? h('button', {
                      className: 'sd-btn', 'data-size': 'sm',
                      onClick: () => setTab(nextHint.tab),
                    }, '前往')
                    : null)
                : null,

              h(ErrorBoundary, {
                name: { script: '剧本', cast: '人物场景', storyboard: '分镜', prompts: '提示词', render: '出图出片' }[tab] ?? tab,
              },
              tab === 'script' ? h(ScriptTab, { project, reload: () => loadProject(activeId), startRun, busy: anyRunning, onFullPipeline: runFullPipeline, compiled, catalogues, onRemember: rememberSettings }) : null,
              tab === 'cast' ? h(CastTab, { project, compiled, reload: () => loadProject(activeId), startRun, busy: anyRunning, onRender: startRender, onUpload: uploadReference, onRestyle: restyleEntity, onPreview: setLightbox, onMenu: openMenu }) : null,
              tab === 'storyboard' ? h(StoryboardTab, { project, compiled, reload: () => loadProject(activeId), startRun, busy: anyRunning, onRender: startRender, onResplit: resplitShots, onPreview: setLightbox, onMenu: openMenu }) : null,
              tab === 'prompts' ? h(PromptTab, { project, compiled, onCompile: compile, busy, onExport: exportBundle, onResplit: resplitShots, onError: setError }) : null,
              tab === 'render' ? h(RenderTab, {
                project, compiled, runs,
                onRender: startRender, onCancel: cancelRun, onMerge: mergeClips,
                onOpenFolder: openFolder, onPreview: setLightbox, busy: anyRunning,
                ui: uiConfig, onUi: saveUi,
                // The preset in force, so the action-shot warning can say which sampling settings
                // are about to be used. The selector itself renders from `catalogues`, which is the
                // same status payload, so there is one source for both.
                catalogues,
                presetKey,
                onPreset: (next) => api.saveConfig({ comfy: { preset: next } })
                  .then(() => setPresetKey(next))
                  .catch(() => { /* the warning stays; the next attempt tries again */ }),
                autoQuality,
                onAutoQuality: (next) => api.saveConfig({ comfy: { autoQuality: next } })
                  .then(() => setAutoQuality(next))
                  // Put the checkbox back if the write failed, rather than showing a state the host
                  // does not have.
                  .catch(() => setAutoQuality(autoQuality)),
                // Which button is mid-flight and which one the host accepted, so the button itself
                // can confirm the click instead of relying on a line of text at the panel's foot.
                pendingKind: renderPress.pending,
                doneKind: renderPress.done,
                onPress: (kind) => setRenderPress((current) => ({ pending: kind, done: null })),
                // The confirmation lives in `ui`, not `comfy`: it is a panel behaviour, not a render
                // setting, and mixing the two would make the config describe the wrong thing.
                rememberConfirm,
                onRememberAsk: (next) => api.saveConfig({ ui: { skipRenderConfirm: next } })
                  .then(() => setRememberConfirm(next))
                  .catch(() => setRememberConfirm(rememberConfirm)),
              }) : null))))
    }

    // ------------------------------------------------------------ chrome bits

    function PanelIcon(props) {
      const size = Number(props?.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5 }),
        h('path', { d: 'M2.5 9.5h19M7 5v14M10 5v14' }),
        h('circle', { cx: 18, cy: 15.5, r: 1.6, fill: 'currentColor', stroke: 'none' }))
    }

    // ------------------------------------------------------------------ wire

    const module = {
      inject: ['slots'],
      apply(ctx) {
        if (typeof document !== 'undefined') ensureStyles()

        // A sidebar icon whose list id addresses the main panel key below —
        // the panellist's own contract: "Each list id addresses the matching
        // main panel".
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'shortdrama',
          order: 30,
          label: '短剧工作室',
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'shortdrama',
        }, PromptStudio))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'shortdrama',
          order: 60,
          label: '短剧工作室',
        }, SettingsPage))
      },
    }

    /**
     * Components, exposed for this plugin's own render tests.
     *
     * Defined non-enumerably on purpose: the module loader reads `inject` and `apply`, and a loader
     * that validates the exported shape would see an unexpected third key in `Object.keys()`.
     *
     * `verify-render.mjs` uses these to prove the bundle MATERIALISES — that the factory returns a
     * usable module rather than throwing on the way. That is the failure that took the panel down
     * once already, and it is invisible to a syntax check only in the sense that a syntax check
     * catches it earlier; what the render test adds is the trip through `require('react')` and the
     * component bodies.
     */
    Object.defineProperty(module, '__test__', {
      value: { Field, PanelIcon, ScriptTab, PromptStudio, ErrorBoundary, GripPanel, scriptCapacity, RenderTab, RenderConfirm, RenderPresetPicker, videoCanvas, imageCanvas },
      enumerable: false,
    })

    return module
  },
})
