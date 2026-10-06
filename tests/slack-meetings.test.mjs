import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule } from './load-module.mjs'

const load = () => loadModule('src/main/gateways/slack-meetings.ts')

test('Granola Slack post becomes one meeting record keyed by thread', async () => {
  const s = await load()
  const post = {
    channel: 'C1', ts: '1790900000.000100', bot_id: 'B1', text: 'fallback',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Pilot sync with Acme' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Action items*\n• Owner sends pricing by Fri' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '<https://notes.granola.ai/d/1234abcd-0000-4000-8000-0123456789ab|Open in Granola>' }] }
    ]
  }
  const m = s.slackNoteToMeeting(post)
  assert.equal(m.id, 'slack:C1:1790900000.000100')
  assert.equal(m.title, 'Pilot sync with Acme')
  assert.match(m.summary, /Owner sends pricing by Fri/)
  assert.match(m.summary, /notes\.granola\.ai/)
  assert.equal(m.date, new Date(1790900000000).toISOString())
  assert.equal(s.granolaNoteId(m.summary), '1234abcd-0000-4000-8000-0123456789ab')

  const reply = { channel: 'C1', ts: '1790900050.000200', thread_ts: post.ts, bot_id: 'B1', text: 'Transcript part 2' }
  const merged = s.slackNoteToMeeting(reply, { title: m.title, date: m.date, summary: m.summary })
  assert.equal(merged.id, m.id)
  assert.match(merged.summary, /Pilot sync[\s\S]*---[\s\S]*Transcript part 2/)
  assert.equal(s.slackNoteToMeeting(reply, { ...merged }), null, 'duplicate reply is ignored')

  const edited = s.slackNoteToMeeting({ ...post, blocks: undefined, text: 'Pilot sync v2' }, merged)
  assert.match(edited.summary, /^Pilot sync v2[\s\S]*Transcript part 2/)
})

test('rich text, attachments, edits and deletions', async () => {
  const s = await load()
  const text = s.slackNoteText({
    channel: 'C', ts: '1', blocks: [{ type: 'rich_text', elements: [
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'Decisions', style: { bold: true } }] },
      { type: 'rich_text_list', style: 'bullet', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Ship Friday' }] }] }
    ] }],
    attachments: [{ title: 'Notes', title_link: 'https://x', text: 'Body' }]
  })
  assert.equal(text, '**Decisions**\n- Ship Friday\n\n[Notes](https://x)\nBody')
  assert.equal(s.unwrapSlackEvent({ channel: 'C', ts: '1', subtype: 'message_deleted' }), null)
  assert.equal(s.unwrapSlackEvent({ channel: 'C', ts: '2', subtype: 'message_changed', message: { ts: '1', text: 'new' } }).channel, 'C')
  assert.equal(s.slackNoteToMeeting({ channel: 'C', ts: '1', text: '   ' }), null)
})
