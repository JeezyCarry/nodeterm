import { lstatSync, readFileSync, unlinkSync } from 'fs'
import { createConnection } from 'net'
import { request } from 'http'
import { parseEndpointEnv } from './hook-endpoint-parse'

export class HookSocketOwnedError extends Error {
  constructor() {
    super(
      'hook-endpoint-owned: Another listener may own this hook endpoint; its advertisement was left unchanged.'
    )
  }
}

/** An old advertisement can point at a tunnel, even when our local bind path is different.
 *  Inspect it as data, never source it. Only a failed connect proves that it is safe to replace. */
export async function assertHookEndpointAvailable(file: string): Promise<void> {
  let env: Record<string, string>
  try {
    env = parseEndpointEnv(readFileSync(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new HookSocketOwnedError()
  }
  const port = Number(env.NODETERM_HOOK_PORT)
  const targets = [
    ...(env.NODETERM_HOOK_SOCK ? [{ socketPath: env.NODETERM_HOOK_SOCK }] : []),
    ...(Number.isInteger(port) && port > 0 && port <= 65535 ? [{ host: '127.0.0.1', port }] : [])
  ]
  if (!targets.length) throw new HookSocketOwnedError()
  for (const target of targets) {
    const stale = await new Promise<boolean>((resolve) => {
      const req = request({
        ...target,
        path: '/verify',
        method: 'POST',
        timeout: 500,
        headers: { 'X-Nodeterm-Hook-Token': env.NODETERM_HOOK_TOKEN ?? '' }
      })
      const finish = (value: boolean): void => {
        req.destroy()
        resolve(value)
      }
      req.once('response', () => finish(false))
      req.once('timeout', () => finish(false))
      req.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED' || e.code === 'ENOENT'))
      req.end()
    })
    if (!stale) throw new HookSocketOwnedError()
  }
}

/** Only ECONNREFUSED proves a leftover socket. Timeouts and permission errors prove nothing. */
export async function clearStaleHookSocket(sock: string): Promise<void> {
  let before
  try {
    before = lstatSync(sock)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  if (!before.isSocket()) throw new HookSocketOwnedError()
  const stale = await new Promise<boolean>((resolve) => {
    const client = createConnection(sock)
    const finish = (value: boolean): void => {
      client.destroy()
      resolve(value)
    }
    client.once('connect', () => finish(false))
    client.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED'))
    client.setTimeout(500, () => finish(false))
  })
  if (!stale) throw new HookSocketOwnedError()
  // Do not delete a replacement that appeared while connect was in flight.
  const after = lstatSync(sock)
  if (before.dev !== after.dev || before.ino !== after.ino) throw new HookSocketOwnedError()
  unlinkSync(sock)
}
