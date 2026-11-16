'use strict'

/**
 * DSH bridge — the VS Code side of dsh-vscode-web.
 *
 * Installed by the DSH plugin into the serve-web server's extension folder, so
 * it runs in the server-side extension host on the same machine as DSH. It
 * reads `bridge.json` (written next to this file by the plugin) to learn the
 * loopback URL and the per-process token, then POSTs the editor selection or
 * the current file to the DSH Host.
 */

const vscode = require('vscode')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const BRIDGE_FILE = path.join(__dirname, 'bridge.json')

/** The bridge endpoint written by the DSH plugin, when present. */
function bridgeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'))
    if (typeof parsed.url === 'string' && typeof parsed.token === 'string') return parsed
  } catch {
    // Missing or not written yet: reported once when a command runs.
  }
  return undefined
}

/** POST one JSON payload to the DSH Host. */
function post(config, payload) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(config.url)
    } catch (error) {
      reject(error)
      return
    }
    const body = JSON.stringify(payload)
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-dsh-bridge-token': config.token,
        },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          if (response.statusCode === 200) resolve(text)
          else reject(new Error(`DSH answered ${response.statusCode}: ${text.slice(0, 300)}`))
        })
      },
    )
    request.on('error', reject)
    request.end(body)
  })
}

/** Workspace-relative path used for the `@` reference in the DSH composer. */
function relativePathOf(document) {
  try {
    return vscode.workspace.asRelativePath(document.uri, false)
  } catch {
    return document.fileName
  }
}

/** First workspace folder of this VS Code window, when any. */
function workspacePath() {
  const folders = vscode.workspace.workspaceFolders
  return folders !== undefined && folders.length > 0 ? folders[0].uri.fsPath : undefined
}

/** Send one payload and report the outcome in the status bar. */
async function send(payload) {
  const config = bridgeConfig()
  if (config === undefined) {
    void vscode.window.showErrorMessage(
      'DSH bridge is not configured yet. Start VS Code from the DSH sidebar once, then try again.',
    )
    return
  }
  try {
    await post(config, payload)
    vscode.window.setStatusBarMessage('DSH: sent', 3000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    void vscode.window.showErrorMessage(`DSH: ${message}`)
  }
}

/**
 * @param {import('vscode').ExtensionContext} context - extension context.
 */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.sendSelection', () => {
      const editor = vscode.window.activeTextEditor
      if (editor === undefined) return
      const document = editor.document
      const selection = editor.selection
      const text = document.getText(selection)
      if (text.trim() === '') {
        void vscode.window.showInformationMessage('DSH: nothing is selected')
        return
      }
      void send({
        kind: 'selection',
        file: document.uri.fsPath,
        relPath: relativePathOf(document),
        text,
        language: document.languageId,
        startLine: selection.start.line + 1,
        endLine: selection.end.line + 1,
        workspace: workspacePath(),
      })
    }),
    vscode.commands.registerCommand('dsh.sendFile', () => {
      const editor = vscode.window.activeTextEditor
      if (editor === undefined) return
      const document = editor.document
      void send({
        kind: 'file',
        file: document.uri.fsPath,
        relPath: relativePathOf(document),
        language: document.languageId,
        line: editor.selection.active.line + 1,
        workspace: workspacePath(),
      })
    }),
  )
}

module.exports = { activate }
