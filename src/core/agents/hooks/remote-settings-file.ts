// POSIX transport for the same guarded user-settings transaction as settings-file.ts.
import { posixQuote } from '../../../shared/ssh'
import { parseSettings } from './settings-file'

type Result = { code: number; stdout: string }
export type SettingsRunner = (command: string, stdin?: string) => Promise<Result>

export async function updateRemoteSettingsFile(
  file: string,
  run: SettingsRunner,
  update: (config: Record<string, unknown>) => Record<string, unknown>
): Promise<boolean> {
  const q = posixQuote(file)
  const lock = posixQuote(`${file}.nodeterm-lock`)
  try {
    const read = await run(`if [ -L ${q} ]; then exit 1; elif [ -e ${q} ]; then [ -f ${q} ] && cat ${q}; else exit 44; fi`)
    if (read.code !== 0 && read.code !== 44) return false
    const before = read.code === 44 ? null : read.stdout
    const config = before === null ? {} : parseSettings(before)
    const original = JSON.stringify(config)
    const updated = update(config)
    if (before !== null && JSON.stringify(updated) === original) return false
    const next = JSON.stringify(updated, null, 2)
    // Both snapshots travel on stdin, never in argv. dd reads exactly the UTF-8 byte count;
    // cat consumes the remaining new document. No remote Python/Node/jq dependency.
    const count = Buffer.byteLength(before ?? '', 'utf8')
    const unchanged = before === null
      ? `[ ! -e ${q} ] && [ ! -L ${q} ]`
      : `[ ! -L ${q} ] && [ -f ${q} ] && cmp -s "$nt_stage/before" ${q}`
    const command = `umask 077
mkdir -p "$(dirname ${q})" || exit 1
mkdir ${lock} 2>/dev/null || exit 1
nt_stage=''
nt_lock=${lock}
trap 'if [ -n "$nt_stage" ]; then rm -rf -- "$nt_stage"; fi; rmdir "$nt_lock"' EXIT
nt_stage=$(mktemp -d "$(dirname ${q})/.nodeterm-settings-XXXXXXXX") || exit 1
dd bs=1 count=${count} of="$nt_stage/before" 2>/dev/null || exit 1
cat > "$nt_stage/next" || exit 1
[ "$(wc -c < "$nt_stage/next")" -eq ${Buffer.byteLength(next, 'utf8')} ] || exit 1
${unchanged} || exit 1
${before === null ? ':' : `cp -p ${q} "$nt_stage/publish" || exit 1`}
cat "$nt_stage/next" > "$nt_stage/publish" || exit 1
${unchanged} || exit 1
mv -f -- "$nt_stage/publish" ${q}`
    return (await run(command, (before ?? '') + next)).code === 0
  } catch {
    return false
  }
}
