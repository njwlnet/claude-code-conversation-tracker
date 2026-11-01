import type { SessionMessage } from 'claude-code'

import type { ActionItem, Decision, Question, Sidequest, Tracker } from '../types'

// What the updater may ask for after one exchange. The model only proposes;
// applyChanges decides what lands.
export type Changes = {
  actions: { text: string; owner?: string; due?: string }[]
  questions: { text: string }[]
  decisions: { text: string; reason?: string }[]
  sidequests: { text: string; why?: string }[]
  updates: { id: string; owner?: string; due?: string }[]
  done: { id: string; how?: string }[]
  resolved: { id: string; answer: string }[]
  title?: string
  goal?: string
}

const MAX_TEXT = 120
const MAX_NOTE = 60
const MAX_ADDS = 8
const MAX_SIDEQUESTS = 1
const MAX_PROMPT = 8000
const MAX_REPLY = 16000

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// The local calendar day of a clock reading, as YYYY-MM-DD.
export function isoDay(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function weekday(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()] ?? ''
}

// The latest exchange: the person's last prompt and everything Claude wrote
// after it, ending with the turn's final answer.
export function latestExchange(messages: readonly SessionMessage[], answer: string): string | undefined {
  let start = -1

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]

    if (message?.role === 'user' && message.text.trim() !== '' && (message.toolResults ?? []).length === 0) {
      start = i
      break
    }
  }
  if (start === -1) return undefined

  const prompt = messages[start]?.text.trim() ?? ''
  const replies = messages
    .slice(start + 1)
    .filter(message => message.role === 'assistant' && message.text.trim() !== '')
    .map(message => message.text.trim())

  if (answer.trim() !== '' && replies.at(-1) !== answer.trim()) replies.push(answer.trim())

  const reply = replies.join('\n\n')

  return [
    `<person>\n${prompt.slice(0, MAX_PROMPT)}\n</person>`,
    `<claude>\n${reply.length > MAX_REPLY ? `…${reply.slice(-MAX_REPLY)}` : reply}\n</claude>`,
  ].join('\n')
}

// The conversation so far as the scan reads it: the person's prompts and
// Claude's replies, oldest first, in stretches of at most `size` characters
// cut between messages (one longer message is cut to fit).
export function earlierStretches(messages: readonly SessionMessage[], size: number): string[] {
  const parts = messages.flatMap(message => {
    const isPrompt = message.role === 'user' && (message.toolResults ?? []).length === 0
    const text = message.text.trim()
    if (!(isPrompt || message.role === 'assistant') || text === '' || text.startsWith('<')) return []
    const tag = isPrompt ? 'person' : 'claude'

    return [`<${tag}>\n${text.slice(0, size - 40)}\n</${tag}>`]
  })
  const stretches: string[] = []
  let current = ''
  for (const part of parts) {
    if (current !== '' && current.length + part.length + 1 > size) {
      stretches.push(current)
      current = ''
    }
    current = current === '' ? part : `${current}\n${part}`
  }

  return current === '' ? stretches : [...stretches, current]
}

export const SYSTEM = `You keep a tracker for a conversation between a person and Claude, an AI assistant. After each exchange you report what changed. You never remove or rewrite anything: you add items, fill in missing owners and due dates, tick off finished action items and sidequests, and resolve answered questions.

Track three things:
- Action items: concrete tasks someone committed to, agreed to, or was asked to do and accepted. Not ideas, options, or things already finished within the exchange.
- Open questions: questions that still need an answer at the end of the exchange. Not rhetorical ones, and not ones the exchange itself answered.
- Decisions: choices the person made or explicitly approved (including approving Claude's recommendation). Not suggestions still waiting on a yes.

And, rarely, one more:
- Sidequests: a supporting or adjacent to-do nobody asked for that would clearly help what the person is working on (a check worth running, a prep step, a risk worth covering). At most one per exchange, never one that repeats an action item or sidequest already in the tracker, and usually none. Add why: in a few words, how it would help.

Rules:
- Only what the exchange clearly shows. When in doubt, leave it out. An empty result is normal.
- Never add an item that matches one already in the tracker, even if worded differently.
- Text is short and plain, under 80 characters. Action items start with a verb.
- owner: "me" for the person, "Claude" for the assistant, or another person's name. Only when the exchange makes it clear; otherwise omit it.
- due: a calendar date YYYY-MM-DD, only when a date or deadline is mentioned. Turn relative dates ("Friday", "next week", "end of month") into dates using today's date.
- reason: a decision's reason in a few words, only when one is given.
- updates: for an open action item already in the tracker that has no owner or no due date, when the exchange now makes one clear.
- done: ids of open action items or sidequests the exchange shows are finished: sent, written, delivered, completed. Not started, promised, or partly done. Add how: who finished it, as a short phrase under 60 characters that reads well after "done Oct 31, ", addressing the person as "you" (for example "you finished it", "Claude sent it", "Dana took care of it"). Omit how when the exchange doesn't say.
- resolved: ids of open questions the exchange answers, each with the answer as a short phrase under 60 characters that reads well after "done Oct 31, " (for example "Dana owns it").
- Never put an item marked "locked" in updates: the person set its details by hand. It can still be ticked off or resolved.
- Never name an item marked "dismissed", and never add it again: the person dismissed it as wrong.
- title: only when the tracker has no title, a 2 to 6 word name for what the conversation is working on, once the exchange makes it clear.
- goal: only when the tracker has no goal, one sentence under 120 characters on what the person wants to achieve, once the exchange makes it clear.

Reply with JSON only, no other text, in this shape:
{"actions":[{"text":"...","owner":"...","due":"YYYY-MM-DD"}],"questions":[{"text":"..."}],"decisions":[{"text":"...","reason":"..."}],"sidequests":[{"text":"...","why":"..."}],"updates":[{"id":"...","owner":"...","due":"YYYY-MM-DD"}],"done":[{"id":"...","how":"..."}],"resolved":[{"id":"...","answer":"..."}],"title":"...","goal":"..."}`

function state(item: ActionItem | Question): string {
  return [item.status, item.locked === true ? 'locked' : undefined, item.dismissed === true ? 'dismissed' : undefined]
    .filter(Boolean)
    .join(', ')
}

// `span` says what `exchange` holds: the latest exchange, an earlier stretch
// of the conversation read by "Scan earlier messages", or a helper agent's
// latest exchange, where Claude gave the task.
export function buildPrompt(
  t: Tracker,
  exchange: string,
  now: number,
  span: 'exchange' | 'earlier' | 'agent' = 'exchange',
): string {
  const lines = [
    ...t.actions.map(item => {
      const extra = [item.owner && `owner: ${item.owner}`, item.due && `due: ${item.due}`].filter(Boolean).join(', ')

      return `- action ${item.id} [${state(item)}] ${item.text}${extra === '' ? '' : ` (${extra})`}`
    }),
    ...t.questions.map(item => `- question ${item.id} [${state(item)}] ${item.text}`),
    ...t.decisions.map(item => `- decision ${item.id}${item.dismissed === true ? ' [dismissed]' : ''} ${item.text}`),
    ...(t.sidequests ?? []).map(
      item => `- sidequest ${item.id} [${item.status}${item.dismissed === true ? ', dismissed' : ''}] ${item.text}`,
    ),
  ]

  return [
    `Today is ${weekday(now)}, ${isoDay(now)}.`,
    `<tracker>\nTitle: ${t.title ?? '(none)'}\nGoal: ${t.goal ?? '(none)'}\n${lines.length === 0 ? '(no items)' : lines.join('\n')}\n</tracker>`,
    ...(span === 'agent'
      ? [
          'This is one of Claude\'s helper agents at work: the person\'s turns below are the task Claude gave it, and Claude\'s turns are the agent\'s own. Track what the agent committed to, asked, decided and finished; owner "Claude" means the agent. Its suggested next steps and recommendations ("Next: …", "I recommend …", "you should …") count as action items too, with no owner unless it names one.',
        ]
      : []),
    ...(span !== 'earlier'
      ? [`<exchange>\n${exchange}\n</exchange>`, 'What should the tracker gain from this exchange? Reply with JSON only.']
      : [
          'Below is an earlier stretch of the conversation, oldest first: many exchanges, not one. Treat it as one long exchange.',
          `<exchange>\n${exchange}\n</exchange>`,
          'What should the tracker gain from this stretch? Reply with JSON only.',
        ]),
  ].join('\n\n')
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\s+/g, ' ')

  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

function day(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : []
}

// Reads the model's reply, dropping anything malformed; undefined when the
// reply holds no JSON object at all.
export function parseChanges(reply: string): Changes | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')

  if (start === -1 || end < start) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined

  const body = raw as Record<string, unknown>
  const changes: Changes = { actions: [], questions: [], decisions: [], sidequests: [], updates: [], done: [], resolved: [] }

  for (const item of records(body.actions)) {
    const t = text(item.text)
    if (t !== undefined) changes.actions.push({ text: t, owner: text(item.owner), due: day(item.due) })
  }
  for (const item of records(body.questions)) {
    const t = text(item.text)
    if (t !== undefined) changes.questions.push({ text: t })
  }
  for (const item of records(body.sidequests)) {
    const t = text(item.text)
    if (t !== undefined) changes.sidequests.push({ text: t, why: text(item.why, MAX_NOTE) })
  }
  for (const item of records(body.decisions)) {
    const t = text(item.text)
    if (t !== undefined) changes.decisions.push({ text: t, reason: text(item.reason) })
  }
  for (const item of records(body.updates)) {
    if (typeof item.id === 'string') changes.updates.push({ id: item.id, owner: text(item.owner), due: day(item.due) })
  }
  for (const item of records(body.done)) {
    if (typeof item.id === 'string') changes.done.push({ id: item.id, how: text(item.how, MAX_NOTE) })
  }
  for (const item of records(body.resolved)) {
    const answer = text(item.answer, MAX_NOTE)
    if (typeof item.id === 'string' && answer !== undefined) changes.resolved.push({ id: item.id, answer })
  }

  const title = text(body.title, 60)
  const goal = text(body.goal, MAX_TEXT)
  if (title !== undefined) changes.title = title
  if (goal !== undefined) changes.goal = goal

  return changes
}

function sameText(a: string, b: string): boolean {
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

  return plain(a) === plain(b)
}

export function nextId(prefix: string, items: readonly { id: string }[]): () => string {
  let n = Math.max(0, ...items.map(item => Number(item.id.slice(prefix.length))).filter(Number.isFinite))

  return () => `${prefix}${(n += 1)}`
}

// Merges the updater's changes into the tracker as it stands now: new items
// that don't repeat an existing one (a dismissed one included); ticks on open
// items (one the person unticked too, when
// the conversation now says it's done); and owners or due dates only where an
// open, unlocked action item has none. A dismissed item is left alone.
export function applyChanges(t: Tracker, changes: Changes, today: string): Tracker {
  const actions = t.actions.map(item => {
    if (item.status !== 'open' || item.dismissed === true) return item
    const done = changes.done.find(entry => entry.id === item.id)
    if (done !== undefined) {
      return { ...item, status: 'done' as const, doneOn: today, ...(done.how === undefined ? {} : { doneNote: done.how }) }
    }
    const found = changes.updates.find(update => update.id === item.id)
    if (found === undefined || item.locked === true) return item

    return {
      ...item,
      ...(item.owner === undefined && found.owner !== undefined ? { owner: found.owner } : {}),
      ...(item.due === undefined && found.due !== undefined ? { due: found.due } : {}),
    }
  })
  const questions = t.questions.map(item => {
    if (item.status !== 'open' || item.dismissed === true) return item
    const found = changes.resolved.find(resolved => resolved.id === item.id)

    return found === undefined ? item : { ...item, status: 'resolved' as const, answer: found.answer, resolvedOn: today }
  })
  const decisions = [...t.decisions]
  const sidequests = (t.sidequests ?? []).map(item => {
    const done = item.status === 'open' && item.dismissed !== true ? changes.done.find(entry => entry.id === item.id) : undefined

    return done === undefined
      ? item
      : { ...item, status: 'done' as const, doneOn: today, ...(done.how === undefined ? {} : { doneNote: done.how }) }
  })

  const actionId = nextId('a', actions)
  for (const add of changes.actions.slice(0, MAX_ADDS)) {
    if (actions.some(item => sameText(item.text, add.text))) continue
    const item: ActionItem = { id: actionId(), text: add.text, status: 'open' }
    if (add.owner !== undefined) item.owner = add.owner
    if (add.due !== undefined) item.due = add.due
    actions.push(item)
  }

  const questionId = nextId('q', questions)
  for (const add of changes.questions.slice(0, MAX_ADDS)) {
    if (questions.some(item => sameText(item.text, add.text))) continue
    const item: Question = { id: questionId(), text: add.text, status: 'open' }
    questions.push(item)
  }

  const decisionId = nextId('d', decisions)
  for (const add of changes.decisions.slice(0, MAX_ADDS)) {
    if (decisions.some(item => sameText(item.text, add.text))) continue
    const item: Decision = { id: decisionId(), text: add.text, decidedOn: today }
    if (add.reason !== undefined) item.reason = add.reason
    decisions.push(item)
  }

  // A sidequest is a suggestion: at most one a reply, never one already on
  // either list.
  const sidequestId = nextId('s', sidequests)
  for (const add of changes.sidequests.slice(0, MAX_SIDEQUESTS)) {
    if ([...actions, ...sidequests].some(item => sameText(item.text, add.text))) continue
    const item: Sidequest = { id: sidequestId(), text: add.text, status: 'open' }
    if (add.why !== undefined) item.why = add.why
    sidequests.push(item)
  }

  // A title or goal is filled in once, where there is none: the person's own,
  // or one already found, stands.
  return {
    ...(t.side === undefined ? {} : { side: t.side }),
    ...(t.title ?? changes.title) === undefined ? {} : { title: t.title ?? changes.title },
    ...(t.goal ?? changes.goal) === undefined ? {} : { goal: t.goal ?? changes.goal },
    actions,
    questions,
    decisions,
    ...(sidequests.length === 0 ? {} : { sidequests }),
  }
}
