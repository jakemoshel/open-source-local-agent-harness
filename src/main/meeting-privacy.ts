/** Keep raw meeting tool payloads out of the event database. Providers and the
 * live UI still receive the original response; replay shows an archive pointer.
 * This does not suppress excerpts an assistant deliberately includes in chat.
 */
export function persistedMeetingEvent(type: string, data: Record<string, unknown>, priorCall?: Record<string, unknown>): Record<string, unknown> {
  const input = (type === 'tool_call' ? data.input : priorCall?.input) as Record<string, unknown> | undefined
  const op = typeof input?.op === 'string' ? input.op : ''
  if (!['meetings_read', 'meetings_text', 'meetings_archive'].includes(op)) return data
  const args = input?.args as Record<string, unknown> | undefined
  const reference = { op, meetingId: args?.id, section: args?.section, note: 'Meeting content is stored in the Markdown archive, not in harness.db.' }
  if (type === 'tool_call') return { ...data, input: reference }
  if (type === 'tool_result') return { ...data, output: JSON.stringify(reference) }
  return data
}
