import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEndpointEnv } from '../hook-endpoint-parse'

export const PI_EXTENSION_MARKER = '// nodeterm-managed-pi-extension-v1\n'

export function piAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  return path.resolve(env.PI_CODING_AGENT_DIR?.trim() || path.join(home, '.pi', 'agent'))
}

export function piExtensionPath(): string {
  return path.join(piAgentDir(), 'extensions', 'nodeterm-status.ts')
}

/** Self-contained Pi extension. It reports only persistent parent sessions; SDK subagent sessions
 * are in-memory and are reported later through the parent pi-subagents-lite event bridge. */
export function buildPiExtension(): string {
  return `${PI_EXTENSION_MARKER}import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const parseEndpointEnv = ${parseEndpointEnv.toString()}

export default function NodetermStatus(pi) {
  const nodeId = process.env.NODETERM_NODE_ID
  if (!nodeId || process.env.NODETERM_AGENT_ID !== 'pi') return

  const live = () => {
    const conf = {
      port: process.env.NODETERM_HOOK_PORT,
      sock: process.env.NODETERM_HOOK_SOCK,
      token: process.env.NODETERM_HOOK_TOKEN,
      version: process.env.NODETERM_HOOK_VERSION,
      tokenDir: process.env.NODETERM_NODE_TOKEN_DIR
    }
    try {
      const file = process.env.NODETERM_HOOK_ENDPOINT
      if (file) {
        const env = parseEndpointEnv(fs.readFileSync(file, 'utf8'))
        if ('NODETERM_HOOK_PORT' in env) conf.port = env.NODETERM_HOOK_PORT
        if ('NODETERM_HOOK_SOCK' in env) conf.sock = env.NODETERM_HOOK_SOCK
        if ('NODETERM_HOOK_TOKEN' in env) conf.token = env.NODETERM_HOOK_TOKEN
        if ('NODETERM_HOOK_VERSION' in env) conf.version = env.NODETERM_HOOK_VERSION
        if ('NODETERM_NODE_TOKEN_DIR' in env) conf.tokenDir = env.NODETERM_NODE_TOKEN_DIR
      }
    } catch {}
    return conf
  }

  const nodeToken = (dir) => {
    try {
      if (!dir) return ''
      return fs.readFileSync(path.join(dir, nodeId), 'utf8').split('\\n')[0].trim()
    } catch {
      return ''
    }
  }

  const post = (event, ctx, extra = {}) => {
    try {
      const transcriptPath = ctx.sessionManager.getSessionFile()
      if (!transcriptPath) return
      const { port, sock, token, version, tokenDir } = live()
      const portNumber = Number(port)
      if (!token || (!sock && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535))) return
      const payload = JSON.stringify({
        event,
        session_id: ctx.sessionManager.getSessionId(),
        transcript_path: transcriptPath,
        session_name: ctx.sessionManager.getSessionName(),
        ...extra
      })
      const body =
        'nodeId=' + encodeURIComponent(nodeId) +
        '&version=' + encodeURIComponent(version || '') +
        '&payload=' + encodeURIComponent(payload)
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'x-nodeterm-hook-token': token,
        'x-nodeterm-node-token': nodeToken(tokenDir)
      }
      const options = sock
        ? { socketPath: sock, path: '/hook/pi', method: 'POST', headers }
        : { hostname: '127.0.0.1', port: portNumber, path: '/hook/pi', method: 'POST', headers }
      const req = http.request(options, (res) => res.resume())
      req.on('error', () => {})
      req.setTimeout(1500, () => req.destroy())
      req.end(body)
    } catch {}
  }

  pi.on('session_start', (event, ctx) => post('session_start', ctx, { reason: event.reason }))
  pi.on('session_info_changed', (event, ctx) =>
    post('session_info_changed', ctx, { session_name: event.name })
  )
  pi.on('before_agent_start', (_event, ctx) => post('before_agent_start', ctx))
  pi.on('tool_execution_start', (event, ctx) =>
    post('tool_execution_start', ctx, { tool_call_id: event.toolCallId, tool_name: event.toolName })
  )
  pi.on('tool_execution_end', (event, ctx) =>
    post('tool_execution_end', ctx, {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      is_error: event.isError
    })
  )
  pi.on('ui_prompt_start', (event, ctx) =>
    post('ui_prompt_start', ctx, { prompt_kind: event.kind, message: event.title })
  )
  pi.on('ui_prompt_end', (event, ctx) =>
    post('ui_prompt_end', ctx, { prompt_kind: event.kind })
  )
  pi.on('agent_settled', (_event, ctx) => post('agent_settled', ctx))
  pi.on('session_shutdown', (event, ctx) =>
    post('session_shutdown', ctx, { reason: event.reason })
  )
}
`
}

export function installPiHooks(): void {
  const p = piExtensionPath()
  try {
    const existing = fs.readFileSync(p, 'utf8')
    if (!existing.startsWith(PI_EXTENSION_MARKER)) return
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, buildPiExtension(), 'utf8')
}

export function removePiHooks(): void {
  const p = piExtensionPath()
  try {
    if (fs.readFileSync(p, 'utf8').startsWith(PI_EXTENSION_MARKER)) fs.rmSync(p, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}
