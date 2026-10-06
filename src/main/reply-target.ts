import type { Run } from '@shared/types'

export function replyTarget(run: Pick<Run, 'trigger' | 'conversationKey'>): { gateway: 'slack' | 'imessage'; target: string } | null {
  // A thread started with NEW ("imessage:<chat>#<id>") replies to the same chat.
  const key = (run.conversationKey ?? '').replace(/#[a-z0-9]+$/, '')
  if (run.trigger === 'slack' && key.startsWith('slack:')) {
    const [, channel, maybeThread] = key.split(':')
    const thread = /^\d+\.\d+$/.test(maybeThread ?? '') ? maybeThread : undefined
    return channel ? { gateway: 'slack', target: thread ? `${channel}:${thread}` : channel } : null
  }
  if (run.trigger === 'imessage' && key.startsWith('imessage:')) {
    const chatId = key.slice('imessage:'.length).split(':')[0]
    return chatId ? { gateway: 'imessage', target: chatId } : null
  }
  return null
}
