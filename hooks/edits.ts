import type { ActionItem, Decision, Entry, Kind, Question, Quote, Sidequest, Tracker } from '../types'
import { nextId } from './updater'

// The person's click on an action item's checkbox: a finished item opens
// again, as before it was finished; an open one is finished today. The
// updater can tick it again later, when the conversation says it's done.
export function toggle(t: Tracker, id: string, today: string): Tracker {
  const flip = <T extends { id: string; status: 'open' | 'done'; doneOn?: string; doneNote?: string }>(item: T): T => {
    if (item.id !== id) return item
    if (item.status === 'open') return { ...item, status: 'done', doneOn: today }
    const { doneOn: _, doneNote: __, ...rest } = item

    return { ...rest, status: 'open' } as T
  }

  return {
    ...t,
    actions: t.actions.map(flip),
    ...(t.sidequests === undefined ? {} : { sidequests: t.sidequests.map(flip) }),
  }
}

// Saves the line an item came from, found after the fact.
export function withQuote(t: Tracker, id: string, quote: Quote): Tracker {
  const stamp = <T extends { id: string; quote?: Quote }>(item: T): T => (item.id === id ? { ...item, quote } : item)

  return {
    ...t,
    actions: t.actions.map(stamp),
    questions: t.questions.map(stamp),
    decisions: t.decisions.map(stamp),
    ...(t.sidequests === undefined ? {} : { sidequests: t.sidequests.map(stamp) }),
  }
}

type Item = ActionItem | Question | Decision | Sidequest

// Applies `change` to the item with `id`, on whichever list it's on.
function onItem(t: Tracker, id: string, change: <T extends Item>(item: T) => T): Tracker {
  const each = <T extends Item>(item: T): T => (item.id === id ? change(item) : item)

  return {
    ...t,
    actions: t.actions.map(each),
    questions: t.questions.map(each),
    decisions: t.decisions.map(each),
    ...(t.sidequests === undefined ? {} : { sidequests: t.sidequests.map(each) }),
  }
}

export function find(t: Tracker, id: string): { kind: Kind; item: Item } | undefined {
  const lists: [Kind, Item[]][] = [
    ['action', t.actions],
    ['question', t.questions],
    ['decision', t.decisions],
    ['sidequest', t.sidequests ?? []],
  ]
  for (const [kind, items] of lists) {
    const item = items.find(one => one.id === id)
    if (item !== undefined) return { kind, item }
  }

  return undefined
}

// Dismissing keeps the item, out of its list, under Dismissed; restoring
// puts it back as it was.
export function dismiss(t: Tracker, id: string): Tracker {
  return onItem(t, id, item => ({ ...item, dismissed: true }))
}

export function restore(t: Tracker, id: string): Tracker {
  return onItem(t, id, item => {
    const { dismissed: _, ...rest } = item

    return rest as typeof item
  })
}

// An item the person adds: open, on the list they chose, with what they gave.
export function add(t: Tracker, kind: Kind, entry: Entry, today: string): { tracker: Tracker; id: string } {
  if (kind === 'question') {
    const id = nextId('q', t.questions)()

    return { tracker: { ...t, questions: [...t.questions, { id, text: entry.text, status: 'open' }] }, id }
  }
  if (kind === 'decision') {
    const id = nextId('d', t.decisions)()
    const item: Decision = { id, text: entry.text, decidedOn: today, ...(entry.reason === undefined ? {} : { reason: entry.reason }) }

    return { tracker: { ...t, decisions: [...t.decisions, item] }, id }
  }
  if (kind === 'sidequest') {
    const sidequests = t.sidequests ?? []
    const id = nextId('s', sidequests)()
    const item: Sidequest = { id, text: entry.text, status: 'open', ...(entry.why === undefined ? {} : { why: entry.why }) }

    return { tracker: { ...t, sidequests: [...sidequests, item] }, id }
  }
  const id = nextId('a', t.actions)()
  const item: ActionItem = {
    id,
    text: entry.text,
    status: 'open',
    locked: true,
    ...(entry.owner === undefined ? {} : { owner: entry.owner }),
    ...(entry.due === undefined ? {} : { due: entry.due }),
  }

  return { tracker: { ...t, actions: [...t.actions, item] }, id }
}

// The person's edit: the words and details become exactly what they typed (a
// detail they left out is cleared). An action item or question is locked, so
// the updater fills in nothing on it again.
export function edit(t: Tracker, id: string, entry: Entry): Tracker {
  const found = find(t, id)
  if (found === undefined) return t

  const given = (key: keyof Entry) => (entry[key] === undefined ? {} : { [key]: entry[key] })
  const details =
    found.kind === 'action'
      ? { ...given('owner'), ...given('due'), locked: true }
      : found.kind === 'question'
        ? { locked: true }
        : found.kind === 'decision'
          ? given('reason')
          : given('why')

  return onItem(t, id, item => {
    const { owner: _o, due: _d, reason: _r, why: _w, ...rest } = item as Item & Partial<Entry>

    return { ...rest, text: entry.text, ...details } as typeof item
  })
}

// A change to one helper agent's tracker, by the agent's id; the side
// tracker is made, titled, when the agent first has one.
export function onSide(t: Tracker, agent: string, title: string, change: (side: Tracker) => Tracker): Tracker {
  const sides = t.side ?? []
  const found = sides.find(side => side.agent === agent)
  const before = found?.tracker ?? { actions: [], questions: [], decisions: [] }
  const side = { agent, title: found?.title ?? title, tracker: change(before) }

  return { ...t, side: found === undefined ? [...sides, side] : sides.map(one => (one.agent === agent ? side : one)) }
}

export function toggleSide(t: Tracker, agent: string, id: string, today: string): Tracker {
  return onSide(t, agent, '', side => toggle(side, id, today))
}

// The person sets the conversation's title or goal; the updater only ever
// fills one in where there is none.
export function frame(t: Tracker, field: 'title' | 'goal', text: string): Tracker {
  const clean = text.trim().replace(/\s+/g, ' ').slice(0, field === 'title' ? 60 : 120)
  if (clean === '') {
    const { [field]: _, ...rest } = t

    return rest
  }

  return { ...t, [field]: clean }
}
