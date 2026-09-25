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
  const subagentCalls = new Map()
  const subagentPrefixes = new Map()
  let lastStopReason

  const stringValue = (value) => typeof value === 'string' ? value : undefined
  const numberValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const resultText = (result) =>
    Array.isArray(result?.content)
      ? result.content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\\n')
      : ''

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

  pi.on('session_start', (event, ctx) => {
    subagentCalls.clear()
    subagentPrefixes.clear()
    post('session_start', ctx, { reason: event.reason })
  })
  pi.on('session_info_changed', (event, ctx) =>
    post('session_info_changed', ctx, { session_name: event.name })
  )
  pi.on('before_agent_start', (_event, ctx) => {
    lastStopReason = undefined
    post('before_agent_start', ctx)
  })
  pi.on('agent_end', (event) => {
    const assistant = [...event.messages].reverse().find((message) => message?.role === 'assistant')
    lastStopReason = stringValue(assistant?.stopReason)
  })
  pi.on('tool_execution_start', (event, ctx) => {
    if (event.toolName !== 'Agent') {
      post('tool_execution_start', ctx, { tool_call_id: event.toolCallId, tool_name: event.toolName })
      return
    }
    const args = event.args || {}
    const call = {
      type: stringValue(args.agent) || 'general-purpose',
      label: stringValue(args.description) || stringValue(args.prompt)
    }
    subagentCalls.set(event.toolCallId, call)
    post('subagent_start', ctx, {
      subagent_id: event.toolCallId,
      subagent_type: call.type,
      task_label: call.label
    })
  })
  pi.on('tool_execution_end', (event, ctx) => {
    const call = subagentCalls.get(event.toolCallId)
    if (!call || event.toolName !== 'Agent') {
      post('tool_execution_end', ctx, {
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        is_error: event.isError
      })
      return
    }
    const details = event.result?.details || {}
    const agentId = stringValue(details.agentId)
    if (agentId) subagentPrefixes.set(agentId.slice(0, 8), event.toolCallId)
    const status = stringValue(details.status)
    const active = !event.isError && (status === 'running' || status === 'queued')
    const input = numberValue(details.input)
    const output = numberValue(details.output)
    post(active ? 'subagent_update' : 'subagent_end', ctx, {
      subagent_id: event.toolCallId,
      subagent_type: call.type,
      task_label: call.label,
      output_file: stringValue(details.outputFile),
      duration_ms: numberValue(details.durationMs),
      tokens: input === undefined && output === undefined ? undefined : (input || 0) + (output || 0),
      tool_uses: numberValue(details.toolUses),
      result: resultText(event.result)
    })
    if (!active) subagentCalls.delete(event.toolCallId)
  })
  pi.on('message_end', (event, ctx) => {
    const message = event.message
    if (message?.customType !== 'subagent-result' || typeof message.content !== 'string') return
    const match = message.content.match(/^\\[Subagent \\"[^\\"]*\\" ([A-Za-z0-9]{8}) /)
    const toolCallId = match ? subagentPrefixes.get(match[1]) : undefined
    const call = toolCallId ? subagentCalls.get(toolCallId) : undefined
    if (!toolCallId || !call) return
    const details = message.details || {}
    const input = numberValue(details.input)
    const output = numberValue(details.output)
    post('subagent_end', ctx, {
      subagent_id: toolCallId,
      subagent_type: call.type,
      task_label: call.label,
      output_file: stringValue(details.outputFile),
      duration_ms: numberValue(details.durationMs),
      tokens: input === undefined && output === undefined ? undefined : (input || 0) + (output || 0),
      tool_uses: numberValue(details.toolUses),
      result: message.content
    })
    subagentCalls.delete(toolCallId)
    subagentPrefixes.delete(match[1])
  })
  pi.on('ui_prompt_start', (event, ctx) =>
    post('ui_prompt_start', ctx, { prompt_kind: event.kind, message: event.title })
  )
  pi.on('ui_prompt_end', (event, ctx) =>
    post('ui_prompt_end', ctx, { prompt_kind: event.kind })
  )
  pi.on('agent_settled', (_event, ctx) =>
    post('agent_settled', ctx, { stop_reason: lastStopReason })
  )
  pi.on('session_shutdown', (event, ctx) => {
    post('session_shutdown', ctx, { reason: event.reason })
    subagentCalls.clear()
    subagentPrefixes.clear()
  })
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
