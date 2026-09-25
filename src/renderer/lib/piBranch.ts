import { canResumeWith, withSessionId } from '@shared/agents/config'
import { oneLine } from '@shared/one-line'
import { shellSingleQuote } from '@shared/shell-quote'

export function piBranchCommand(
  launchCmd: string,
  sourceSessionId: string,
  newSessionId: string,
  name: string
): string | null {
  if (!canResumeWith('pi', sourceSessionId) || !canResumeWith('pi', newSessionId)) return null
  const command = withSessionId(`${launchCmd} --fork ${sourceSessionId}`, 'pi', newSessionId)
  return command ? `${command} --name ${shellSingleQuote(oneLine(name))}` : null
}
