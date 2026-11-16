/*!
 * dsh-vscode-web — client half (browser bundle).
 *
 * Adds two entry points that open the Session's workspace in VS Code's own web
 * server:
 *   - one small icon button in a sidebar session row's hover strip,
 *   - one icon button in the conversation header's Session utilities.
 *
 * Both call the Host half's fenced route (`/dsh-vscode-web/api/open`), which
 * resolves the workspace, starts the shared `code serve-web` process on first
 * use, and answers with the URL to open. Opening that URL is the tricky part:
 * the server may take up to a minute on its very first run, and a browser only
 * allows a popup from fresh user activation — so the browser path opens a
 * blank tab synchronously inside the click and navigates it once the URL
 * arrives. Desktop opens the right-sidebar Browser tab instead.
 *
 * Bundle shape: the official DSH client-bundle closure registered with
 * `window.__ModuleLoader__.load({ id, factory })`; `react` is resolved from the
 * shell's module table. UI strings live here; `locale/*.json` holds the
 * plugin-manager metadata.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vscode-web',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    const NS = 'dshVscodeWeb'
    const API = '/dsh-vscode-web/api'

    const EN = {
      'action.open': 'Open this session’s workspace in VS Code Web',
      'action.busy': 'Starting VS Code Web… the first run can take a minute',
      'waiting.title': 'Starting VS Code Web…',
      'waiting.body':
        'VS Code is starting its web server for this workspace. The first run can take a minute while the server runtime is prepared.',
      'error.popup': 'The browser blocked the new tab. Allow pop-ups for this page, then try again.',
      'dock.quoted': 'Quoted {file}:{range} from VS Code',
      'dock.added': 'Added {file} from VS Code',
      'dock.failed': 'Could not insert into the composer; the draft is busy or read-only.',
    }

    const ZH = {
      'action.open': '在 VS Code 网页版中打开本会话的工作区',
      'action.busy': '正在启动 VS Code 网页版…首次启动可能需要一分钟',
      'waiting.title': '正在启动 VS Code 网页版…',
      'waiting.body': 'VS Code 正在为该工作区启动网页服务。首次启动需要准备服务运行时，可能需要一分钟。',
      'error.popup': '浏览器拦截了新标签页，请允许本站弹出窗口后重试。',
      'dock.quoted': '已从 VS Code 引用 {file}:{range}',
      'dock.added': '已从 VS Code 加入 {file}',
      'dock.failed': '无法插入输入框：草稿正在提交或不可编辑。',
    }

    /**
     * Sessions whose open request is in flight, shared by both entry points so
     * a second click on the other button cannot start a second open.
     */
    const pendingSessions = new Set()

    /** Dictionary for the active locale id. */
    function dictFor(active) {
      return String(active === undefined || active === null ? '' : active)
        .toLowerCase()
        .startsWith('zh')
        ? ZH
        : EN
    }

    /** Translate one key, substituting `{name}` placeholders. */
    function translate(active, key, vars) {
      const dict = dictFor(active)
      let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : EN[key] || key
      if (vars !== undefined && vars !== null) {
        for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
      }
      return text
    }

    /**
     * Subscribe to the locale service so labels follow a live language switch.
     * @param {any} ctx - client context.
     * @returns {(key: string, vars?: Record<string, string>) => string} translator.
     */
    function useTranslate(ctx) {
      const active = React.useSyncExternalStore(
        (callback) => ctx.locale.subscribe(callback),
        () => (ctx.locale.getSnapshot() || {}).active,
        () => 'en',
      )
      return React.useCallback((key, vars) => translate(active, key, vars), [active])
    }

    /** Active locale id, tolerant of a locale service that is not ready yet. */
    function activeLocale(ctx) {
      try {
        return (ctx.locale.getSnapshot() || {}).active
      } catch {
        return 'en'
      }
    }

    /** The window-with-code-brackets glyph (no third-party brand mark). */
    function IconVscodeWeb(props) {
      const size = props.size === undefined ? 16 : props.size
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('rect', {
          x: 1.75,
          y: 2.75,
          width: 12.5,
          height: 10.5,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        h('path', {
          d: 'M6.2 6.3 4.5 8l1.7 1.7M9.8 6.3 11.5 8l-1.7 1.7',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Spinner drawn while the server is starting. */
    function IconSpinner(props) {
      const size = props.size === undefined ? 16 : props.size
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': true,
          focusable: 'false',
          style: { animation: 'dsw-vscode-web-spin 0.9s linear infinite' },
        },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 5.75,
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeOpacity: 0.3,
        }),
        h('path', {
          d: 'M8 2.25a5.75 5.75 0 0 1 5.75 5.75',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      )
    }

    /** Keyframes for the busy spinner; rendered with the button so unmounting removes them. */
    function SpinnerKeyframes() {
      return h(
        'style',
        null,
        '@keyframes dsw-vscode-web-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      )
    }

    /** Icon button styled from the host theme tokens. */
    function iconButtonStyle(busy, size) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        cursor: busy ? 'progress' : 'pointer',
        flex: 'none',
      }
    }

    /** Hover fill, disabled while a start is in flight so it cannot read as enabled. */
    function hoverHandlers(setHover) {
      return {
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setHover(true),
        onBlur: () => setHover(false),
      }
    }

    /**
     * The workbench URL for one open result.
     *
     * `serve-web` always serves a remote authority, and its workbench builds
     * the folder URI as `vscode-remote://<authority><path>` from the `folder`
     * query — but only when that value starts with `/`. So the query must be
     * the server-side path (`/C:/dir` on Windows, `/dir` on POSIX). A bare
     * `C:\dir` parses as a relative path and `file:///c:/dir` names a provider
     * the web client does not have. The Host answers the same way; rebuilding
     * here keeps that true for an older Host and either separator style.
     * @param {{ url: string, workspace?: string }} result - Host answer.
     * @returns {string} URL to open.
     */
    function folderUrl(result) {
      const workspace = typeof result.workspace === 'string' ? result.workspace.trim() : ''
      if (workspace === '' || typeof result.url !== 'string') return result.url
      const slashed = workspace.replace(/\\/g, '/')
      const path = /^[A-Za-z]:\//.test(slashed) ? `/${slashed}` : slashed.startsWith('/') ? slashed : `/${slashed}`
      return `${result.url.split('?')[0]}?folder=${encodeURIComponent(path)}`
    }

    /** POST one JSON body to the Host API and unwrap its envelope. */
    async function postJson(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || payload === undefined || payload.ok !== true) {
        const reason =
          payload !== undefined && payload.error !== undefined && payload.error.message !== undefined
            ? payload.error.message
            : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return payload.result
    }

    /** True when the page runs inside the DSH Desktop shell (Electron). */
    function isDesktopShell() {
      const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
      return /Electron/i.test(ua)
    }

    /** The right-sidebar navigation controller, when this profile has one. */
    function sidebarRightOf(ctx) {
      try {
        return ctx.get('sidebarRight')
      } catch {
        return undefined
      }
    }

    /**
     * Open a blank tab inside the click's user activation and paint it with the
     * waiting message; the real URL replaces it once the Host answers.
     * @returns {Window | null} the tab, or null when the browser refused it.
     */
    function openWaitingTab(t) {
      let win
      try {
        win = window.open('', '_blank')
      } catch {
        win = null
      }
      if (win === null) return null
      try {
        win.document.title = t('waiting.title')
        const body = win.document.body
        body.style.cssText =
          'margin:0;display:flex;align-items:center;justify-content:center;height:100vh;' +
          'font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#57606a;background:#fbfbfd;' +
          'padding:0 24px;text-align:center;'
        const message = win.document.createElement('p')
        message.textContent = t('waiting.body')
        body.appendChild(message)
      } catch {
        // A browser that hands back a cross-origin blank page still navigates.
      }
      return win
    }

    /**
     * Show a URL that is already known.
     * @param {any} ctx - client context.
     * @param {string} url - workbench URL.
     * @param {Window | null} tab - a tab opened synchronously for this click.
     * @param {string} fallbackMessage - pop-up-blocked text.
     */
    function present(ctx, url, tab, fallbackMessage) {
      if (tab !== null) {
        try {
          tab.location.replace(url)
          return
        } catch {
          // Fall through to the other carriers.
        }
      }
      if (isDesktopShell()) {
        const controller = sidebarRightOf(ctx)
        if (controller !== undefined && typeof controller.openTab === 'function') {
          try {
            controller.openTab('browser', { params: { url } })
            return
          } catch (error) {
            console.warn('[dsh-vscode-web] right-sidebar Browser tab unavailable:', error)
          }
        }
      }
      if (window.open(url, '_blank', 'noopener') === null) throw new Error(fallbackMessage)
    }

    /**
     * The click flow shared by both entry points: reserve the session, ask the
     * Host, then present the URL (or close the placeholder and report).
     * @returns {[boolean, () => Promise<void>]} busy flag and click action.
     */
    function useOpenAction(ctx, t, sessionId) {
      const [busy, setBusy] = React.useState(false)
      const run = React.useCallback(async () => {
        if (pendingSessions.has(sessionId)) return
        pendingSessions.add(sessionId)
        const desktop = isDesktopShell()
        const tab = desktop ? null : openWaitingTab(t)
        setBusy(true)
        try {
          const result = await postJson('/open', { sessionId })
          present(ctx, folderUrl(result), tab, t('error.popup'))
        } catch (error) {
          try {
            if (tab !== null && !tab.closed) tab.close()
          } catch {
            // The placeholder is already gone.
          }
          const message = error instanceof Error ? error.message : String(error)
          console.error('[dsh-vscode-web] open failed:', error)
          window.alert(message)
        } finally {
          pendingSessions.delete(sessionId)
          setBusy(false)
        }
      }, [ctx, sessionId, t])
      return [busy, run]
    }

    /**
     * The one button both entry points render.
     * @param {{ ctx: any, sessionId: string, compact?: boolean }} props
     */
    function OpenButton(props) {
      const { ctx, sessionId, compact } = props
      const t = useTranslate(ctx)
      const [hover, setHover] = React.useState(false)
      const [busy, open] = useOpenAction(ctx, t, sessionId)
      const size = compact ? 20 : 24
      const glyph = compact ? 14 : 16
      const label = busy ? t('action.busy') : t('action.open')
      const style = iconButtonStyle(busy, size)
      if (hover && !busy) {
        style.background = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.16))'
        style.color = 'var(--dsw-alias-label-primary, currentColor)'
      }
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            title: label,
            'aria-label': label,
            'aria-busy': busy ? 'true' : 'false',
            'aria-disabled': busy ? 'true' : 'false',
            onClick: () => {
              void open()
            },
            style,
            ...hoverHandlers(setHover),
          },
          busy ? h(IconSpinner, { size: glyph }) : h(IconVscodeWeb, { size: glyph }),
        ),
        busy ? h(SpinnerKeyframes) : null,
      )
    }

    /**
     * The one bridge stream per page. EventSource reconnects on its own; the
     * connection is closed when the last dock component unsubscribes.
     */
    let bridgeSource
    const bridgeListeners = new Set()

    /** Open the stream on demand and fan bridge events out to the docks. */
    function ensureBridgeStream() {
      if (bridgeSource !== undefined) return bridgeSource
      if (typeof EventSource !== 'function') return undefined
      try {
        bridgeSource = new EventSource(API + '/events')
      } catch (error) {
        console.warn('[dsh-vscode-web] bridge stream unavailable:', error)
        return undefined
      }
      bridgeSource.onmessage = (message) => {
        let event
        try {
          event = JSON.parse(message.data)
        } catch {
          return
        }
        if (event === null || typeof event !== 'object' || event.type !== 'bridge') return
        for (const listener of bridgeListeners) {
          try {
            listener(event)
          } catch (error) {
            console.error('[dsh-vscode-web] bridge listener failed:', error)
          }
        }
      }
      // A failed connection is retried by EventSource itself.
      bridgeSource.onerror = () => {}
      return bridgeSource
    }

    /**
     * Subscribe to bridge pushes.
     * @param {(event: any) => void} listener - receives one bridge event.
     * @returns {() => void} unsubscribe.
     */
    function subscribeBridge(listener) {
      bridgeListeners.add(listener)
      ensureBridgeStream()
      return () => {
        bridgeListeners.delete(listener)
        if (bridgeListeners.size === 0 && bridgeSource !== undefined) {
          try {
            bridgeSource.close()
          } catch {
            // Already closed.
          }
          bridgeSource = undefined
        }
      }
    }

    /** Small auto-dismissing status row under the composer. */
    function BridgeDock(props) {
      const { ctx, sessionId, inputActions } = props
      const t = useTranslate(ctx)
      const [notice, setNotice] = React.useState(null)
      const timerRef = React.useRef(undefined)

      const show = React.useCallback((text, failed) => {
        setNotice({ text, failed: failed === true })
        if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = undefined
          setNotice(null)
        }, failed === true ? 12_000 : 6_000)
      }, [])

      React.useEffect(
        () => () => {
          if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        },
        [],
      )

      React.useEffect(() => {
        if (inputActions === undefined || inputActions === null) return undefined
        return subscribeBridge((event) => {
          if (event.sessionId !== sessionId) return
          const file = typeof event.relPath === 'string' ? event.relPath : 'file'
          if (event.kind === 'selection' && typeof event.text === 'string') {
            const range =
              Number.isInteger(event.startLine) && Number.isInteger(event.endLine)
                ? `${event.startLine}-${event.endLine}`
                : ''
            const ok = inputActions.insertQuote(event.text)
            if (ok) show(t('dock.quoted', { file, range }), false)
            else show(t('dock.failed'), true)
            return
          }
          if (event.kind === 'file') {
            const span = inputActions.captureInsertion()
            const suffix = Number.isInteger(event.line) ? `:${event.line}` : ''
            const ok = inputActions.insertText(`@${file}${suffix} `, span)
            if (ok) show(t('dock.added', { file }), false)
            else show(t('dock.failed'), true)
          }
        })
      }, [inputActions, sessionId, show, t])

      if (notice === null) return null
      return h(
        'div',
        {
          role: 'status',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: '100%',
            margin: '4px 0 0',
            padding: '2px 8px',
            borderRadius: 8,
            font: '12px/1.6 inherit',
            color: notice.failed
              ? 'var(--dsw-alias-state-error-primary, #c0392b)'
              : 'var(--dsw-alias-label-secondary, currentColor)',
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
          },
        },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, notice.text),
        h(
          'button',
          {
            type: 'button',
            'aria-label': 'dismiss',
            onClick: () => {
              if (timerRef.current !== undefined) clearTimeout(timerRef.current)
              timerRef.current = undefined
              setNotice(null)
            },
            style: {
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
              opacity: 0.7,
            },
          },
          '×',
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', ZH)
          const offEn = ctx.locale.register(NS, 'en', EN)
          return () => {
            offZh()
            offEn()
          }
        }, 'dsh-vscode-web: dictionaries')

        // Owner projections (menus, tooltips) re-read this thunk, so the
        // label follows a live language switch without re-registering.
        const label = () => translate(activeLocale(ctx), 'action.open')

        ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.row.action',
              id: 'dsh-vscode-web:row',
              order: 50,
              label,
              inject: () => ({ ctx, compact: true }),
            },
            OpenButton,
          ),
        )

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'dsh-vscode-web:header',
              order: 5,
              label,
              inject: () => ({ ctx }),
            },
            OpenButton,
          ),
        )

        // The receiving end of the VS Code bridge: a session-scoped dock entry
        // that inserts the pushed quote / file reference into this draft.
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-vscode-web:bridge',
              order: 20,
              inject: () => ({ ctx }),
            },
            BridgeDock,
          ),
        )
      },
    }
  },
})
