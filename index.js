/**
 * dsh-vscode-web — Host half.
 *
 * Owns one `code serve-web` process (VS Code's own web server, shipped with
 * the desktop VS Code install) and exposes the fenced HTTP routes the Client
 * half calls. Every workspace shares that single process: a workspace is
 * selected per open through the `?folder=` query parameter, so opening ten
 * workspaces costs one server, not ten.
 *
 * The launcher is resolved without a shell. On Windows the shipped
 * `bin/code-tunnel.exe` is a real executable, so `spawn` works directly
 * (a `.cmd` shim would fail with EINVAL because Node refuses to spawn batch
 * files without a shell). On POSIX the `code` launcher script is executable
 * on its own.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-vscode-web'
/** JSON API root under the prefix above. */
const API_PREFIX = `${ROUTE_PREFIX}/api`
/** First port tried; the manager walks upward until one can bind. */
const DEFAULT_PORT = 8765
/** How long a freshly spawned server may take before the open reports failure.
 *  Generous on purpose: the first `serve-web` run on a machine may prepare
 *  VS Code's web-server runtime (`~/.vscode/cli/serve-web`) first. */
const READY_TIMEOUT_MS = 120_000
/** Delay between two readiness probes. */
const PROBE_INTERVAL_MS = 300
/** Upper bound for a JSON request body. */
const BODY_LIMIT_BYTES = 64 * 1024
/** Folder name of the bundled VS Code extension inside the server data dir. */
const EXTENSION_DIR = 'dsh-bridge'
/** Extension identity VS Code uses in `extensions.json`. */
const EXTENSION_ID = 'dsh.dsh-bridge'
/**
 * Workbench settings this plugin always wants, independent of any profile
 * patch: the embedded workbench is a local tool for this machine's own
 * workspace, so VS Code's workspace-trust gate only gets in the way. A row
 * `settings` object overrides these keys.
 */
const DEFAULT_SETTINGS = {
  'security.workspace.trust.enabled': false,
  'security.workspace.trust.banner': 'never',
  'security.workspace.trust.startupPrompt': 'never',
}

/** Keep-alive cadence of the bridge event stream. */
const HEARTBEAT_MS = 25_000

/** Services this Host plugin cannot run without. */
export const inject = ['webServer', 'subprocess', 'connection']

/**
 * Resolve the `code serve-web` launcher without a shell.
 * @param {string} configured - explicit `command` from the plugin row, when set.
 * @returns {string | undefined} absolute executable path, or undefined.
 */
function resolveLauncher(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '' && existsSync(explicit)) return explicit

  const candidates = []
  const env = process.env
  if (process.platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'),
      env.ProgramFiles === undefined ? undefined : join(env.ProgramFiles, 'Microsoft VS Code'),
      env['ProgramFiles(x86)'] === undefined ? undefined : join(env['ProgramFiles(x86)'], 'Microsoft VS Code'),
    ]
    for (const root of roots) {
      if (root !== undefined) candidates.push(join(root, 'bin', 'code-tunnel.exe'))
    }
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (dir !== '') candidates.push(join(dir, 'code-tunnel.exe'))
    }
  } else {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (dir === '') continue
      candidates.push(join(dir, 'code-tunnel'))
      candidates.push(join(dir, 'code'))
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // An unreadable PATH entry must not abort discovery.
    }
  }
  return undefined
}

/**
 * True when a loopback listener can bind the port right now.
 * @param {number} port - candidate port.
 * @returns {Promise<boolean>} whether the port is free.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/**
 * First free port at or above `base`.
 * @param {number} base - first candidate.
 * @returns {Promise<number>} a bindable port.
 * @throws when the whole window is occupied.
 */
async function pickPort(base) {
  for (let port = base; port < base + 50; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(
    `No free port in ${base}-${base + 49}. Set the \`port\` option of dsh-vscode-web to another range.`,
  )
}

/**
 * The `folder` query value VS Code expects.
 *
 * The workbench bootstrap parses that query as
 * `{ folderUri: URI.from({ scheme: 'vscode-remote', path: value, authority }) }`
 * when `remoteAuthority` is set and the value starts with `/` (see
 * `workbench.js: QUERY_PARAM_FOLDER`). A `serve-web` window always carries a
 * remote authority, and its workspace URI is `vscode-remote://127.0.0.1:<port>/C:/…`
 * — the same URI the server itself writes for `--default-folder`. So the value
 * must be the server-side **path**: `/C:/dir` on Windows, `/dir` on POSIX.
 * A bare `C:\dir` fails as a relative path, and `file:///c:/dir` names a
 * provider type this client does not have.
 * @param {string} workspace - absolute workspace directory.
 * @returns {string} path value for the `folder` query.
 */
function workbenchFolderPath(workspace) {
  const slashed = workspace.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(slashed)) return `/${slashed}`
  return slashed.startsWith('/') ? slashed : `/${slashed}`
}

/**
 * Build the workbench URL for one workspace.
 * @param {string} origin - loopback origin of the server.
 * @param {string} workspace - absolute workspace directory.
 * @returns {string} URL to open.
 */
function workbenchUrl(origin, workspace) {
  return `${origin}/?folder=${encodeURIComponent(workbenchFolderPath(workspace))}`
}

/**
 * Install (or refresh) the bundled VS Code extension inside the server's own
 * extension folder, so the web workbench gains the "send to DSH" commands.
 *
 * The extension host runs on this machine next to DSH, which is why the
 * extension talks to the Host over loopback HTTP instead of anything the page
 * would have to broker.
 * @param {string} dataDir - the server's `--server-data-dir`.
 * @param {{ url: string, token: string }} bridge - endpoint and per-process token.
 * @returns {string} the installed extension directory.
 */
function installBridgeExtension(dataDir, bridge) {
  const extensionsDir = join(dataDir, 'extensions')
  const target = join(extensionsDir, EXTENSION_DIR)
  mkdirSync(target, { recursive: true })
  const source = fileURLToPath(new URL('./vscode-extension/', import.meta.url))
  for (const name of ['package.json', 'extension.js']) {
    const from = join(source, name)
    const to = join(target, name)
    let same = false
    try {
      same = readFileSync(to).equals(readFileSync(from))
    } catch {
      same = false
    }
    if (!same) writeFileSync(to, readFileSync(from))
  }
  writeFileSync(join(target, 'bridge.json'), `${JSON.stringify(bridge, null, 2)}\n`)

  // VS Code treats a directory as an installed extension only when
  // `extensions.json` lists it; the file may already carry other entries.
  const manifest = join(extensionsDir, 'extensions.json')
  let entries = []
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    if (Array.isArray(parsed)) entries = parsed
  } catch {
    entries = []
  }
  let version = '0.1.0'
  try {
    version = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version ?? version
  } catch {
    // Keep the fallback version; the manifest is ours.
  }
  const kept = entries.filter(
    (entry) => String(entry?.identifier?.id ?? '').toLowerCase() !== EXTENSION_ID.toLowerCase(),
  )
  kept.push({
    identifier: { id: EXTENSION_ID },
    version,
    location: { $mid: 1, fsPath: target, path: target, scheme: 'file' },
    relativeLocation: basename(target),
    metadata: {
      id: EXTENSION_ID,
      publisherId: 'dsh',
      publisherDisplayName: 'dsh',
      targetPlatform: 'universal',
      isApplicationScoped: false,
      isPreReleaseVersion: false,
      installedTimestamp: Date.now(),
      pinned: false,
      preRelease: false,
    },
  })
  writeFileSync(manifest, JSON.stringify(kept))
  return target
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed body object (empty when absent).
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - serializable body.
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Resolve one Session's workspace directory.
 * @param {any} ctx - host context.
 * @param {string} sessionId - session id from the Client.
 * @returns {string | undefined} absolute workspace path.
 */
function workspacePathOfSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined

  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        const ids = workspace?.sessionIds
        if (Array.isArray(ids) && ids.includes(sessionId)) return workspace.path
      }
    } catch {
      // A registry failure falls through to the live-agent path.
    }
  }

  let agents
  let workingDirectory
  try {
    agents = ctx.get('agents')
    workingDirectory = ctx.get('workingDirectory')
  } catch {
    agents = undefined
    workingDirectory = undefined
  }
  if (agents !== undefined && workingDirectory !== undefined && typeof agents.get === 'function') {
    const agent = agents.get(sessionId)
    const session = agent?.session
    if (session !== undefined) {
      try {
        const path = workingDirectory.get(session)
        if (typeof path === 'string' && path !== '') return path
      } catch {
        // Nothing left to try.
      }
    }
  }
  return undefined
}

/**
 * Merge the row's `settings` into the server's machine-settings file.
 *
 * The web workbench keeps "User" settings in the browser's own storage keyed
 * by origin, so they vanish when the page moves to another port, another
 * browser, or another window kind. Machine (a.k.a. Remote) settings live in
 * the server data dir instead: one file, every client, every restart.
 * @param {string} dataDir - the server's `--server-data-dir`.
 * @param {unknown} settings - `settings` from the plugin row.
 */
function applyServerSettings(dataDir, settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return
  const entries = Object.entries(settings).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return
  const file = join(dataDir, 'data', 'Machine', 'settings.json')
  mkdirSync(dirname(file), { recursive: true })
  let current = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
  } catch {
    current = {}
  }
  let changed = false
  for (const [key, value] of entries) {
    if (JSON.stringify(current[key]) === JSON.stringify(value)) continue
    current[key] = value
    changed = true
  }
  if (!changed) return
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`)
}
/** Normalize a path for comparison (separators, case). */
function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True when two spellings name the same directory. */
function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' && normalizePath(left) === normalizePath(right)
}

/**
 * The registered workspace that owns one absolute file path.
 * @param {any} ctx - host context.
 * @param {string} file - absolute file path from the VS Code extension.
 * @returns {string | undefined} workspace directory.
 */
function workspaceOfFile(ctx, file) {
  if (typeof file !== 'string' || file === '') return undefined
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    return undefined
  }
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  const normalized = normalizePath(file)
  let best
  try {
    for (const workspace of registry.list()) {
      const candidate = normalizePath(workspace.path)
      if (normalized === candidate || normalized.startsWith(`${candidate}/`)) {
        if (best === undefined || candidate.length > normalizePath(best).length) best = workspace.path
      }
    }
  } catch {
    return undefined
  }
  return best
}

/**
 * The server lifecycle for one Host fiber: lazy start, shared readiness,
 * one process serving every workspace.
 */
class VscodeWebServer {
  /**
   * @param {any} ctx - host context.
   * @param {{ command?: string, port?: number, dataDir?: string, extraArgs?: string[] }} config - plugin row config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.handle = undefined
    this.starting = undefined
    this.ready = false
    this.port = undefined
    this.origin = undefined
    this.bin = undefined
    this.startedAt = undefined
    this.lastError = undefined
    /** Bridge secret, assigned by the plugin body before the first start. */
    this.token = undefined
    /** Why the bridge extension could not be installed, when it failed. */
    this.bridgeError = undefined
    /** True when an already-running server was reused instead of spawned. */
    this.adopted = false
    /** Where the bundled VS Code extension was installed, once it was. */
    this.bridgeDir = undefined
    /** workspace (normalized) -> session that last opened VS Code there. */
    this.lastOpen = new Map()
  }

  /** Remember which Session opened a workspace, so bridge pushes land there. */
  remember(workspace, sessionId) {
    if (typeof workspace === 'string' && workspace !== '' && typeof sessionId === 'string' && sessionId !== '') {
      this.lastOpen.set(normalizePath(workspace), sessionId)
    }
  }

  /**
   * Best Session for one workspace: the one that last opened VS Code here,
   * else the workspace's first Session.
   * @param {any} ctx - host context.
   * @param {string} workspace - absolute workspace directory.
   * @returns {string | undefined} session id.
   */
  sessionFor(ctx, workspace) {
    const remembered = this.lastOpen.get(normalizePath(workspace))
    if (remembered !== undefined) return remembered
    try {
      const registry = ctx.get('workspaceRegistry')
      const entity = registry?.list?.().find((item) => samePath(item.path, workspace))
      const first = entity?.sessionIds?.[0]
      return typeof first === 'string' ? first : undefined
    } catch {
      return undefined
    }
  }

  /** Built-in settings with the row's own `settings` on top. */
  resolvedSettings() {
    const configured = this.config.settings
    const extra = configured !== null && typeof configured === 'object' && !Array.isArray(configured) ? configured : {}
    return { ...DEFAULT_SETTINGS, ...extra }
  }

  /** Directory holding the server's own data (cookies, workspace state). */
  dataDir() {
    const configured = typeof this.config.dataDir === 'string' ? this.config.dataDir.trim() : ''
    return configured !== '' ? configured : join(homedir(), '.dsh-vscode-web', 'server')
  }

  /** Extra `serve-web` arguments from the plugin row. */
  extraArgs() {
    const list = this.config.extraArgs
    return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : []
  }

  /** @returns {number} first port candidate. */
  basePort() {
    const configured = Number(this.config.port)
    return Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : DEFAULT_PORT
  }

  /** Snapshot for the Client's status line. */
  info() {
    return {
      running: this.ready,
      adopted: this.adopted,
      port: this.port,
      origin: this.origin,
      bin: this.bin,
      startedAt: this.startedAt,
      lastError: this.lastError,
      bridge: {
        installed: typeof this.bridgeDir === 'string',
        extensionDir: this.bridgeDir,
        error: this.bridgeError,
      },
    }
  }

  /** Ensure the shared server is running and answering. */
  async ensure() {
    if (this.ready) return this.info()
    if (this.starting !== undefined) return this.starting
    this.starting = (async () => {
      // A workbench still serving on the configured port is reused instead of
      // displaced to the next free port: the origin (and therefore the
      // browser's workspace trust and layout state) has to stay stable.
      if (this.config.strictPort !== false) {
        const adopted = await this.adoptExisting()
        if (adopted !== undefined) return adopted
      }
      return await this.start()
    })().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /**
   * Reuse a VS Code web server already answering on the configured port.
   * @returns {object | undefined} server info, or undefined when nothing usable listens.
   */
  async adoptExisting() {
    const port = this.basePort()
    if (await isPortFree(port)) return undefined
    const origin = `http://127.0.0.1:${port}`
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1500) })
      if (!response.ok && response.status !== 302) return undefined
      const html = response.status === 302 ? '' : await response.text()
      if (html !== '' && !/vscode|workbench/i.test(html)) return undefined
    } catch {
      return undefined
    }
    const dataDir = this.dataDir()
    mkdirSync(dataDir, { recursive: true })
    if (typeof this.token === 'string' && this.token !== '') {
      try {
        const hostOrigin = this.ctx.webServer.getOrigin()
        this.bridgeDir = installBridgeExtension(dataDir, {
          url: `${hostOrigin}${API_PREFIX}/bridge`,
          token: this.token,
        })
      } catch {
        // A reused server keeps whatever extension set it started with.
      }
    }
    try {
      applyServerSettings(dataDir, this.resolvedSettings())
    } catch {
      // Same.
    }
    this.handle = undefined
    this.adopted = true
    this.port = port
    this.origin = origin
    this.ready = true
    this.startedAt = Date.now()
    return this.info()
  }

  /** Spawn, then wait for the first successful probe. */
  async start() {
    const bin = resolveLauncher(this.config.command)
    if (bin === undefined) {
      this.lastError = 'VS Code CLI not found'
      throw new Error(
        'VS Code was not found on this machine. Install VS Code, or set the `command` option of dsh-vscode-web to its `code-tunnel.exe` (Windows) / `code` launcher.',
      )
    }

    const basePort = this.basePort()
    let port
    if (await isPortFree(basePort)) {
      port = basePort
    } else if (this.config.strictPort === false) {
      port = await pickPort(basePort)
    } else {
      throw new Error(
        `Port ${basePort} is occupied by another program. Free it, set \`port\` on the dsh-vscode-web row, ` +
          'or set `strictPort: false` to let the plugin pick the next free port.',
      )
    }
    const origin = `http://127.0.0.1:${port}`
    const dataDir = this.dataDir()
    mkdirSync(dataDir, { recursive: true })

    // The bundled extension must exist before the server scans its extension
    // folder, and its bridge endpoint is this Host's own route.
    if (typeof this.token === 'string' && this.token !== '') {
      try {
        const hostOrigin = this.ctx.webServer.getOrigin()
        this.bridgeDir = installBridgeExtension(dataDir, {
          url: `${hostOrigin}${API_PREFIX}/bridge`,
          token: this.token,
        })
        this.bridgeError = undefined
    /** True when an already-running server was reused instead of spawned. */
    this.adopted = false
      } catch (error) {
        this.bridgeError = messageOf(error)
        console.warn('[dsh-vscode-web] bridge install skipped:', error)
      }
    }

    // Machine settings must exist before the window loads them.
    try {
      applyServerSettings(dataDir, this.resolvedSettings())
    } catch (error) {
      console.warn('[dsh-vscode-web] settings could not be written:', error)
    }

    const argv = [
      bin,
      'serve-web',
      '--accept-server-license-terms',
      '--without-connection-token',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--server-data-dir',
      dataDir,
      '--disable-telemetry',
      ...this.extraArgs(),
    ]

    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv,
        cwd: homedir(),
        // The service inherits the scrubbed parent environment; the server and
        // the workbench's integrated terminal need PATH and friends intact.
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' },
        graceMs: 5000,
      })
    } catch (error) {
      this.lastError = messageOf(error)
      throw new Error(`Could not start the VS Code web server: ${this.lastError}`)
    }

    this.handle = handle
    this.port = port
    this.origin = origin
    this.bin = bin
    this.exited = undefined
    handle.done.then(
      (outcome) => {
        if (this.handle === handle) {
          this.handle = undefined
          this.ready = false
        }
        this.exited = outcome
      },
      () => {
        if (this.handle === handle) {
          this.handle = undefined
          this.ready = false
        }
      },
    )

    try {
      await this.waitReady(origin, handle)
    } catch (error) {
      this.lastError = messageOf(error)
      await this.stop()
      throw new Error(
        `The VS Code web server did not start: ${this.lastError}. ` +
          'The first run can take a minute while VS Code prepares its server runtime; ' +
          "the server's own output is written to the DSH Host log.",
      )
    }

    this.ready = true
    this.startedAt = Date.now()
    return this.info()
  }

  /**
   * Poll the server root until it answers, or the process leaves.
   * @param {string} origin - loopback origin.
   * @param {any} handle - the subprocess handle that must stay alive.
   */
  async waitReady(origin, handle) {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.handle !== handle) throw new Error('the server process exited during startup')
      try {
        const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) })
        if (response.ok || response.status === 302) return
      } catch {
        // Not listening yet.
      }
      await sleep(PROBE_INTERVAL_MS)
    }
    throw new Error(`no answer within ${Math.round(READY_TIMEOUT_MS / 1000)}s`)
  }

  /** Stop the server, if any. Safe to call twice. */
  async stop() {
    const handle = this.handle
    this.handle = undefined
    this.ready = false
    if (handle === undefined) return
    try {
      await handle.terminate()
    } catch {
      // Termination races exit; nothing to recover.
    }
    try {
      await handle.waitForExit?.()
    } catch {
      // Same.
    }
  }
}

/**
 * Register the plugin: routes plus one server owned by this fiber.
 * @param {any} ctx - host context.
 * @param {Record<string, unknown>} [config] - plugin row config.
 */
export function apply(ctx, config = {}) {
  const manager = new VscodeWebServer(ctx, config ?? {})
  /** Per-process secret the bundled VS Code extension presents on the bridge route. */
  manager.token = randomBytes(24).toString('base64url')

  /** Connection owns deployment trust; never bypass it here. */
  const admitted = (req) => {
    try {
      const connection = ctx.get('connection')
      if (connection === undefined || typeof connection.requestRejection !== 'function') return true
      return connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  /**
   * Bridge requests come from the extension host, which has no browser
   * cookie; they prove themselves with the per-process token instead.
   * @param {import('node:http').IncomingMessage} req - request.
   * @returns {boolean} whether the token matches.
   */
  const bridgeAuthorized = (req) => {
    const header = req.headers['x-dsh-bridge-token']
    const value = Array.isArray(header) ? header[0] : header
    if (typeof value !== 'string' || value === '' || value.length !== manager.token.length) return false
    try {
      return timingSafeEqual(Buffer.from(value), Buffer.from(manager.token))
    } catch {
      return false
    }
  }

  /** Responses of the EventSource clients waiting for bridge pushes. */
  const subscribers = new Set()

  /**
   * Push one event to every subscribed Client.
   * @param {Record<string, unknown>} event - JSON payload.
   */
  const broadcast = (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const subscriber of subscribers) {
      try {
        subscriber.write(frame)
      } catch {
        subscribers.delete(subscriber)
      }
    }
  }

  ctx.effect(
    () => {
      const timer = setInterval(() => {
        for (const subscriber of subscribers) {
          try {
            subscriber.write(': ping\n\n')
          } catch {
            subscribers.delete(subscriber)
          }
        }
      }, HEARTBEAT_MS)
      return () => {
        clearInterval(timer)
        for (const subscriber of subscribers) {
          try {
            subscriber.end()
          } catch {
            // Already closed.
          }
        }
        subscribers.clear()
      }
    },
    'dsh-vscode-web: bridge heartbeat',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : undefined

          // The extension host authenticates with the per-process token.
          if (method === '/bridge' && req.method === 'POST') {
            if (!bridgeAuthorized(req)) {
              writeJson(res, 403, { ok: false, error: { message: 'forbidden' } })
              return
            }
            try {
              const body = await readJsonBody(req)
              const kind = body.kind === 'file' ? 'file' : body.kind === 'selection' ? 'selection' : undefined
              if (kind === undefined) {
                writeJson(res, 400, { ok: false, error: { message: 'kind must be "selection" or "file"' } })
                return
              }
              const file = typeof body.file === 'string' ? body.file : ''
              const fallback = typeof body.workspace === 'string' ? body.workspace : undefined
              const workspace = workspaceOfFile(ctx, file) ?? fallback
              if (workspace === undefined || workspace === '') {
                writeJson(res, 404, {
                  ok: false,
                  error: { message: 'This file is not inside any registered workspace.' },
                })
                return
              }
              const text = typeof body.text === 'string' ? body.text.slice(0, 200_000) : undefined
              const sessionId = manager.sessionFor(ctx, workspace)
              broadcast({
                type: 'bridge',
                time: Date.now(),
                sessionId: sessionId ?? null,
                workspace,
                kind,
                file,
                relPath: typeof body.relPath === 'string' ? body.relPath : basename(file),
                language: typeof body.language === 'string' ? body.language : undefined,
                startLine: Number.isInteger(body.startLine) ? body.startLine : undefined,
                endLine: Number.isInteger(body.endLine) ? body.endLine : undefined,
                line: Number.isInteger(body.line) ? body.line : undefined,
                text: kind === 'selection' ? text : undefined,
              })
              writeJson(res, 200, { ok: true, result: { sessionId: sessionId ?? null, workspace } })
            } catch (error) {
              writeJson(res, 400, { ok: false, error: { message: messageOf(error) } })
            }
            return
          }

          if (!admitted(req)) {
            writeJson(res, 403, { ok: false, error: { message: 'forbidden' } })
            return
          }

          // Server-sent events carrying pushes from the VS Code extension.
          if (method === '/events' && req.method === 'GET') {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
            res.write('retry: 2000\n\n')
            subscribers.add(res)
            const cleanup = () => {
              subscribers.delete(res)
            }
            req.on('close', cleanup)
            req.on('error', cleanup)
            return
          }

          if (method === '/status' && req.method === 'GET') {
            writeJson(res, 200, { ok: true, result: manager.info() })
            return
          }

          if (method === '/open' && req.method === 'POST') {
            try {
              const body = await readJsonBody(req)
              const requested = typeof body.path === 'string' ? body.path.trim() : ''
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
              const workspace = requested !== '' ? requested : workspacePathOfSession(ctx, sessionId)
              if (workspace === undefined || workspace === '') {
                writeJson(res, 400, {
                  ok: false,
                  error: { message: 'This session has no workspace directory to open.' },
                })
                return
              }
              if (!existsSync(workspace)) {
                writeJson(res, 400, {
                  ok: false,
                  error: { message: `The workspace directory no longer exists: ${workspace}` },
                })
                return
              }
              const info = await manager.ensure()
              manager.remember(workspace, sessionId)
              writeJson(res, 200, {
                ok: true,
                result: {
                  url: workbenchUrl(info.origin, workspace),
                  port: info.port,
                  workspace,
                },
              })
            } catch (error) {
              writeJson(res, 500, { ok: false, error: { message: messageOf(error) } })
            }
            return
          }

          if (method === '/stop' && req.method === 'POST') {
            await manager.stop()
            writeJson(res, 200, { ok: true, result: manager.info() })
            return
          }

          writeJson(res, 404, { ok: false, error: { message: 'unknown dsh-vscode-web route' } })
        },
      }),
    'dsh-vscode-web: routes',
  )

  ctx.effect(
    () => () => {
      void manager.stop()
    },
    'dsh-vscode-web: server lifecycle',
  )
}
