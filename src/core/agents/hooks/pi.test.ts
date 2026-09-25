import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PI_EXTENSION_MARKER,
  buildPiExtension,
  installPiHooks,
  piExtensionPath,
  removePiHooks
} from './pi'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pi-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', tmp)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Pi extension install', () => {
  it('installs idempotently and removes only its own file', () => {
    installPiHooks()
    installPiHooks()
    expect(fs.readFileSync(piExtensionPath(), 'utf8').startsWith(PI_EXTENSION_MARKER)).toBe(true)
    removePiHooks()
    expect(fs.existsSync(piExtensionPath())).toBe(false)

    fs.mkdirSync(path.dirname(piExtensionPath()), { recursive: true })
    fs.writeFileSync(piExtensionPath(), '// user extension\n')
    installPiHooks()
    removePiHooks()
    expect(fs.readFileSync(piExtensionPath(), 'utf8')).toBe('// user extension\n')
  })
})

describe('generated Pi extension', () => {
  it('forwards persistent lifecycle events and ignores in-memory child sessions', async () => {
    const received: Record<string, unknown>[] = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const params = new URLSearchParams(body)
        received.push(JSON.parse(params.get('payload') ?? '{}'))
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP port')

    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_AGENT_ID', 'pi')
    vi.stubEnv('NODETERM_HOOK_PORT', String(address.port))
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'token')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_HOOK_SOCK', '')

    const file = path.join(tmp, 'extension.mjs')
    fs.writeFileSync(file, buildPiExtension())
    const mod = await import(/* @vite-ignore */ `file://${file}?${Date.now()}`)
    const handlers: Record<string, (event: Record<string, unknown>, ctx: unknown) => void> = {}
    mod.default({ on: (name: string, handler: typeof handlers[string]) => (handlers[name] = handler) })

    const context = (sessionFile: string | undefined) => ({
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => 'session-1',
        getSessionName: () => 'Build Pi'
      }
    })
    handlers.session_start({ reason: 'startup' }, context('/tmp/session.jsonl'))
    handlers.before_agent_start({}, context('/tmp/session.jsonl'))
    handlers.agent_settled({}, context('/tmp/session.jsonl'))
    handlers.tool_execution_start(
      {
        toolCallId: 'tool-1',
        toolName: 'Agent',
        args: { agent: 'luna-patch', description: 'Fix names', run_in_background: true }
      },
      context('/tmp/session.jsonl')
    )
    handlers.tool_execution_end(
      {
        toolCallId: 'tool-1',
        toolName: 'Agent',
        isError: false,
        result: {
          content: [{ type: 'text', text: '[Agent running]' }],
          details: {
            agentId: '12345678-abcd',
            status: 'running',
            outputFile: '/tmp/pi-agent-outputs/12345678-abcd.log'
          }
        }
      },
      context('/tmp/session.jsonl')
    )
    handlers.message_end(
      {
        message: {
          customType: 'subagent-result',
          content: '[Subagent "luna-patch" 12345678 completed]\\n\\nDone',
          details: {
            durationMs: 25,
            input: 10,
            output: 5,
            toolUses: 2,
            outputFile: '/tmp/pi-agent-outputs/12345678-abcd.log'
          }
        }
      },
      context('/tmp/session.jsonl')
    )
    handlers.session_start({ reason: 'startup' }, context(undefined))

    await vi.waitFor(() => expect(received).toHaveLength(6))
    expect(received.map((payload) => payload.event)).toEqual([
      'session_start',
      'before_agent_start',
      'agent_settled',
      'subagent_start',
      'subagent_update',
      'subagent_end'
    ])
    expect(received[0]).toMatchObject({
      session_id: 'session-1',
      session_name: 'Build Pi',
      transcript_path: '/tmp/session.jsonl'
    })
    expect(received[3]).toMatchObject({
      subagent_id: 'tool-1',
      subagent_type: 'luna-patch',
      task_label: 'Fix names'
    })
    expect(received[4]).toMatchObject({
      subagent_id: 'tool-1',
      output_file: '/tmp/pi-agent-outputs/12345678-abcd.log'
    })
    expect(received[5]).toMatchObject({
      subagent_id: 'tool-1',
      output_file: '/tmp/pi-agent-outputs/12345678-abcd.log',
      duration_ms: 25,
      tokens: 15,
      tool_uses: 2
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
