import type { Entry, Kind } from '../types'
import { isoDay } from './updater'

const MAX_TEXT = 120
const MAX_NOTE = 60
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const ENTRY_SYSTEM = `You turn a line the person typed into one item of their conversation tracker. You change nothing they meant; you only split what they wrote into fields.

Fields:
- text: the item itself, short and plain, under 80 characters, without the owner, date or reason. An action item starts with a verb.
- owner (action items only): "me" for the person, "Claude" for the assistant, or the name they gave. Only when they gave one.
- due (action items only): a calendar date YYYY-MM-DD, only when they gave a date or deadline. Turn relative dates ("Friday", "next week") into dates using today's date; "Nov 7" means the next Nov 7 on or after today.
- reason (decisions only): why, in a few words, only when they gave one.
- why (sidequests only): how it would help, in a few words, only when they gave it.

Reply with JSON only, no other text: {"text":"...","owner":"...","due":"YYYY-MM-DD","reason":"...","why":"..."} with only the fields that apply.`

export function entryPrompt(kind: Kind, line: string, now: number): string {
  const date = new Date(now)

  return [
    `Today is ${WEEKDAYS[date.getDay()] ?? ''}, ${isoDay(now)}.`,
    `The item is a${kind === 'action' ? 'n action item' : ` ${kind}`}.`,
    `<typed>\n${line}\n</typed>`,
    'Reply with JSON only.',
  ].join('\n\n')
}

function field(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\s+/g, ' ')

  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

// What the model read from the line, kept to the fields the kind has; the
// line as typed when the reply holds nothing usable.
export function parseEntry(kind: Kind, reply: string | undefined, line: string): Entry {
  const typed = { text: line.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT) }
  const start = reply?.indexOf('{') ?? -1
  const end = reply?.lastIndexOf('}') ?? -1
  if (reply === undefined || start === -1 || end < start) return typed

  let raw: unknown
  try {
    raw = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return typed
  }
  if (typeof raw !== 'object' || raw === null) return typed
  const body = raw as Record<string, unknown>
  const text = field(body.text, MAX_TEXT)
  if (text === undefined) return typed

  const due = typeof body.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due) ? body.due : undefined
  const keep = (key: keyof Entry, value: string | undefined) => (value === undefined ? {} : { [key]: value })

  return {
    text,
    ...(kind === 'action' ? { ...keep('owner', field(body.owner, MAX_NOTE)), ...keep('due', due) } : {}),
    ...(kind === 'decision' ? keep('reason', field(body.reason, MAX_NOTE)) : {}),
    ...(kind === 'sidequest' ? keep('why', field(body.why, MAX_NOTE)) : {}),
  }
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split('-').map(Number)
  const name = month === undefined ? undefined : MONTHS[month - 1]

  return name === undefined || day === undefined ? iso : `${name} ${day}`
}

// An item as the person would type it, for the message box to edit:
// "Send revised proposal to client (owner: me, due: Nov 7)".
export function editLine(kind: Kind, item: Entry): string {
  const details =
    kind === 'action'
      ? [item.owner === undefined ? undefined : `owner: ${item.owner}`, item.due === undefined ? undefined : `due: ${shortDate(item.due)}`]
      : kind === 'decision'
        ? [item.reason === undefined ? undefined : `because ${item.reason}`]
        : kind === 'sidequest'
          ? [item.why === undefined ? undefined : `why: ${item.why}`]
          : []
  const shown = details.filter(part => part !== undefined)

  return shown.length === 0 ? item.text : `${item.text} (${shown.join(', ')})`
}
