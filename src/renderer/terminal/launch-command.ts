import { deliverCommand, type DeliveryIo, type DeliveryOutcome } from './command-delivery'

// A writer belongs to the PTY lifetime (including a parked view), not a Canvas render.
// Warm attachments never replay durable launch intent: a previous submission may have landed
// just before its clearing autosave. The retained command is available for explicit recovery.
type Writer = (command: string, manual: boolean) => Promise<DeliveryOutcome>
const writers = new Map<string, Writer>()
export function registerLaunchWriter(id: string, writer: Writer): () => void {
  writers.set(id, writer)
  return () => { if (writers.get(id) === writer) writers.delete(id) }
}
export function launchCommand(id: string, command: string, manual = false): Promise<DeliveryOutcome> {
  return writers.get(id)?.(command, manual) ?? Promise.resolve('cancelled')
}

export function createLaunchWriter(opts: {
  fresh: boolean
  io: DeliveryIo
  shellReady(manual: boolean): Promise<boolean>
  killLine: string
  cleanup(cancel: () => void): void
}): Writer {
  let attempted = false
  let submitted = false
  let inFlight: Promise<DeliveryOutcome> | undefined
  let disposed = false
  opts.cleanup(() => { disposed = true })
  return (command, manual) => {
    if (submitted) return Promise.resolve('submitted') // stale UI/save; never paste twice
    if (inFlight) return inFlight
    if (disposed || (!manual && (!opts.fresh || attempted))) return Promise.resolve('cancelled')
    attempted = true
    inFlight = (async () => {
      if (!(await opts.shellReady(manual)) || disposed) return 'cancelled' as const
      return new Promise<DeliveryOutcome>((resolve) => {
        try {
          // A cancelled delivery may have left an unsubmitted prefix in the shell editor.
          // Explicit recovery starts a new line rather than appending another CLI command.
          if (manual) opts.io.write(opts.killLine)
          opts.cleanup(deliverCommand(opts.io, command, resolve, { killLine: opts.killLine }))
        } catch { resolve('cancelled') }
      })
    })().then((outcome) => {
      submitted = outcome === 'submitted'
      return outcome
    }).catch(() => 'cancelled' as const).finally(() => { inFlight = undefined })
    return inFlight
  }
}

/** Keep UI launch intent through the asynchronous shell settle and submission boundary. */
export function deliverInitialLaunch(command: string, opts: {
  whenReady(run: () => void): void
  write: Writer
  update(patch: {
    initialCommand?: undefined
    pendingLaunch?: { after: string[]; command: string; manualOnly: true }
  }): void
  onFailure(outcome: DeliveryOutcome): void
}): void {
  const pendingLaunch = { after: [], command, manualOnly: true as const }
  // Do not discard the live initialCommand before settle. The durable pending record also
  // prevents the Canvas loop from racing this writer and survives a project switch.
  opts.update({ pendingLaunch })
  opts.whenReady(() => {
    void opts.write(command, false).then((outcome) => {
      opts.update({ initialCommand: undefined,
        pendingLaunch: outcome === 'submitted' ? undefined : pendingLaunch })
      if (outcome !== 'submitted') opts.onFailure(outcome)
    })
  })
}
