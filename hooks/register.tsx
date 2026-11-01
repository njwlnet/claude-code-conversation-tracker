import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { ActionItem, Decision, Entry, Kind, Question, Side, Sidequest, Tracker } from '../types'
import { add, dismiss, edit, find, frame, onSide, restore, toggle, toggleSide } from './edits'
import { editLine, ENTRY_SYSTEM, entryPrompt, parseEntry } from './entry'
import { decode, encode, savedPath } from './saved'
import { applyChanges, buildPrompt, earlierStretches, isoDay, latestExchange, parseChanges, SYSTEM } from './updater'

const PANE = 'tracker'
const TITLE = 'Tracker'
const COLUMNS = 44

const EMPTY: Tracker = { actions: [], questions: [], decisions: [] }

// Change the tag when a change of fields would misread what an earlier
// version stored, which outlives a reload: the tag declines it. Optional
// fields added since (`locked`) read fine without one.
const tracker = atom({ plugin: 'conversation-tracker', key: 'tracker' } as const, EMPTY, {
  shape: 'tracker-1',
})

// True once the person closes the pane: a reload leaves it closed, and the
// band above the prompt offers it back.
const isClosed = atom({ plugin: 'conversation-tracker', key: 'isClosed' } as const, false)

// The question the person's next message replies to, where the message box
// couldn't take the reply itself: drawn above the box, added when they send.
const replyingTo = atom({ plugin: 'conversation-tracker', key: 'replyingTo' } as const, null)

// The conversation whose saved tracker this session's state holds: the id
// it was loaded for, or null before any was.
const loadedFor = atom({ plugin: 'conversation-tracker', key: 'loadedFor' } as const, null)

// The sections whose finished items are folded away under their Done line.
const hiddenDone = atom({ plugin: 'conversation-tracker', key: 'hiddenDone' } as const, [])

// The helper agents whose trackers are open in the pane, by agent id.
const openSides = atom({ plugin: 'conversation-tracker', key: 'openSides' } as const, [])

// Whether the Dismissed group at the bottom of the pane is open.
const showDismissed = atom({ plugin: 'conversation-tracker', key: 'showDismissed' } as const, false)

// What the updater is doing, drawn under the summary: null when idle.
const note = atom({ plugin: 'conversation-tracker', key: 'note' } as const, null)

const MODEL = 'claude-sonnet-5-5'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDate(iso: string): string {
  const [, month, day] = iso.split('-').map(Number)
  const name = month === undefined ? undefined : MONTHS[month - 1]

  return name === undefined || day === undefined ? iso : `${name} ${day}`
}

function summary(t: Tracker): string {
  const kept = <T extends { dismissed?: true }>(items: T[]) => items.filter(item => item.dismissed !== true)
  const actions = kept(t.actions)
  const questions = kept(t.questions)
  const open = actions.filter(item => item.status === 'open').length + questions.filter(item => item.status === 'open').length
  const done = actions.length + questions.length - open
  const decisions = kept(t.decisions).length
  const sidequests = kept(t.sidequests ?? []).filter(item => item.status === 'open').length
  const extra = sidequests === 0 ? '' : ` · ${sidequests} ${sidequests === 1 ? 'sidequest' : 'sidequests'}`

  return `${open} open · ${done} done · ${decisions} ${decisions === 1 ? 'decision' : 'decisions'}${extra}`
}

// The tracker as plain text, for where no pane can draw it (a cloud session)
// and for /tracker show: each item with its id, for /tracker edit.
function asText(t: Tracker): string {
  const kept = <T extends { dismissed?: true }>(items: T[]) => items.filter(item => item.dismissed !== true)
  const line = (mark: string, text: string, meta: string | undefined, id: string) =>
    `${mark} ${text}${meta === undefined ? '' : ` (${meta})`} [${id}]`
  const section = (title: string, rows: string[]) => (rows.length === 0 ? [] : ['', title, ...rows])
  const finishedLast = <T extends { status: string }>(items: T[]) => [
    ...items.filter(item => item.status === 'open'),
    ...items.filter(item => item.status !== 'open'),
  ]

  return [
    t.title ?? 'Untitled conversation',
    `Goal: ${t.goal ?? 'not clear yet'}`,
    summary(t),
    ...section(
      'Action items',
      finishedLast(kept(t.actions)).map(item => line(item.status === 'done' ? '☑' : '☐', item.text, actionMeta(item), item.id)),
    ),
    ...section(
      'Open questions',
      finishedLast(kept(t.questions)).map(item =>
        line(item.status === 'resolved' ? '✓' : '?', item.text, questionMeta(item), item.id),
      ),
    ),
    ...section(
      'Decisions',
      kept(t.decisions).map(item => line(`${shortDate(item.decidedOn)}:`, item.text, item.reason, item.id)),
    ),
    ...section(
      'Sidequests',
      finishedLast(kept(t.sidequests ?? [])).map(item =>
        line(item.status === 'done' ? '☑' : '☐', item.text, sidequestMeta(item), item.id),
      ),
    ),
    ...section(
      'Helper agents',
      (t.side ?? []).map(side => {
        const open = [...side.tracker.actions, ...side.tracker.questions, ...(side.tracker.sidequests ?? [])].filter(
          item => item.status === 'open',
        ).length

        return `${side.title} (${open} open)`
      }),
    ),
  ].join('\n')
}

// Open items first, in the order they came up; finished ones below, the
// most recently finished first.
function openFirst<T>(items: T[], isOpen: (item: T) => boolean, finishedOn: (item: T) => string): T[] {
  const finished = items.filter(item => !isOpen(item))
  finished.sort((a, b) => finishedOn(b).localeCompare(finishedOn(a)))

  return [...items.filter(isOpen), ...finished]
}

// A resolved question reads as a finished item, its answer after the date:
// "(done Oct 31, Dana owns it)".
function questionMeta(item: Question): string | undefined {
  if (item.status !== 'resolved') return undefined
  const parts = [
    item.resolvedOn === undefined ? undefined : `done ${shortDate(item.resolvedOn)}`,
    item.answer,
  ].filter(part => part !== undefined)

  return parts.length === 0 ? undefined : parts.join(', ')
}

// A sidequest's note: why it would help while open; once done, as an action
// item's reads.
function sidequestMeta(item: Sidequest): string | undefined {
  if (item.status === 'open') return item.why
  const parts = [item.doneOn === undefined ? undefined : `done ${shortDate(item.doneOn)}`, item.doneNote].filter(
    part => part !== undefined,
  )

  return parts.length === 0 ? undefined : parts.join(', ')
}

function actionMeta(item: ActionItem): string | undefined {
  if (item.status === 'done') {
    const parts = [item.doneOn === undefined ? undefined : `done ${shortDate(item.doneOn)}`, item.doneNote].filter(
      part => part !== undefined,
    )

    return parts.length === 0 ? undefined : parts.join(', ')
  }
  const parts = [
    item.owner === undefined ? undefined : `owner: ${item.owner}`,
    item.due === undefined ? undefined : `due: ${shortDate(item.due)}`,
  ].filter(part => part !== undefined)

  return parts.length === 0 ? undefined : parts.join(', ')
}

// A plugin's own open and close do not pass through its own hooks, so each
// one updates the closed mark itself; the ui.close hook catches the person's.
// The band reads the mark, but while it draws nothing a write alone leaves it
// as it was until something else redraws it, so a change redraws it at once.
async function markClosed($: EngineInterface, value: boolean): Promise<void> {
  await update($, isClosed, () => value)
  $.ui.invalidate('ui.render')
  await persist($)
}

// Every change to the tracker goes through here, so each is saved.
async function changeTracker($: EngineInterface, change: (now: Tracker | undefined) => Tracker): Promise<void> {
  await update($, tracker, change)
  await persist($)
}

async function trackerFile($: EngineInterface, conversation: string): Promise<string> {
  return savedPath(await $.env.get('HOME'), $.plugin.root, conversation)
}

// Writes this conversation's tracker, and whether its pane is closed, to its
// file. A failed write says so on the status line; the tracker itself stands.
async function persist($: EngineInterface): Promise<void> {
  try {
    const conversation = await $.session.id()
    const text = encode({
      version: 1,
      conversation,
      savedAt: new Date().toISOString(),
      isClosed: await read($, isClosed),
      tracker: await read($, tracker),
    })
    await $.fs.write(await trackerFile($, conversation), text)
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).slice(0, 80)
    await flashStatus($, `Couldn't save the tracker (${why}).`, 15_000)
  }
}

// Binds the session's state to the conversation it's in: its saved tracker
// when there is one. A hot reload finds the state already bound and keeps it.
// State never bound before (the session that built the mod) keeps its tracker
// and saves it; a different conversation without a file starts empty.
async function load($: EngineInterface): Promise<void> {
  const conversation = await $.session.id()
  const bound = await read($, loadedFor)
  if (bound === conversation) return

  const path = await trackerFile($, conversation)
  const saved = (await $.fs.exists(path)) ? decode(await $.fs.read(path)) : undefined
  if (saved !== undefined) {
    await update($, tracker, () => saved.tracker)
    await update($, isClosed, () => saved.isClosed)
  } else if (bound !== null) {
    await update($, tracker, () => EMPTY)
    await update($, isClosed, () => false)
  }
  await update($, replyingTo, () => null)
  await update($, note, () => null)
  await update($, showDismissed, () => false)
  await update($, loadedFor, () => conversation)
  if (saved === undefined) await persist($)
}

// Resolves whether a surface drew the pane: none does in a cloud session or
// a `claude -p` run.
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: COLUMNS })

  if (opened.isPlaced) {
    await markClosed($, false)
  }

  return opened.isPlaced
}

async function closePane($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  await markClosed($, true)
}

// A click on a question starts a reply to it in the message box, ahead of
// whatever is typed there (a reply to another question is swapped out).
// Where the box can't take it, the question waits above the box instead.
const REPLY = /^Re: ".*?" /

function replyPrefix(question: Question): string {
  return `Re: "${question.text}" `
}

async function replyTo($: EngineInterface, question: Question): Promise<void> {
  const prefix = replyPrefix(question)
  const draft = (await $.prompt.read()).text.replace(REPLY, '')
  const filled = await $.prompt.fill({ text: prefix + draft, mode: 'replace' })

  if (!filled.isFilled) {
    await setReplyingTo($, question.id)
  }
}

async function setReplyingTo($: EngineInterface, id: string | null): Promise<void> {
  await update($, replyingTo, () => id)
  $.ui.invalidate('ui.render')
}

// Shows `text` on the pane's status line, under the summary, for `ms`,
// unless something else is put there first. The close runs on `clock.after`,
// not a `sleep`, which would hold the hook that showed it past its budget.
let clearing: Timer | undefined

async function flashStatus($: EngineInterface, text: string, ms: number): Promise<void> {
  clearing?.cancel()
  await update($, note, () => text)
  // The mod may have reloaded or gone by then: nothing is left to clear.
  clearing = $.clock.after(ms, () => {
    update($, note, now => (now === text ? null : now ?? null)).catch(() => undefined)
  })
}

// The person's own changes, typed in the message box as a /tracker command.
const ADD = /^add\s+(?:(action|question|decision|sidequest)s?\s*:\s*)?([\s\S]*)$/i
const EDIT = /^edit\s+([aqds]\d+)\s*([\s\S]*)$/i
const FRAME = /^(title|goal)\b\s*([\s\S]*)$/i
const SET_ASIDE = /^(dismiss|restore)\s+([aqds]\d+)\s*$/i
const SECTION: Record<Kind, string> = {
  action: 'Action items',
  question: 'Open questions',
  decision: 'Decisions',
  sidequest: 'Sidequests',
}
const USAGE =
  'Use /tracker to show or hide the tracker, /tracker show to print it, /tracker add action: <item> (or question:, decision:, sidequest:), /tracker edit <id> <words>, /tracker dismiss <id> or restore <id>, or /tracker title <words> and /tracker goal <words>. Type each on its own.'

// Reads what the person typed into an item's fields (owner, due date, reason)
// with the same model as the updater; the words as typed if that fails.
async function readEntry($: EngineInterface, kind: Kind, line: string): Promise<Entry> {
  const reply = await $.model.complete({
    model: MODEL,
    system: ENTRY_SYSTEM,
    prompt: entryPrompt(kind, line, await $.clock.now()),
    maxTokens: 300,
    timeoutMs: 30_000,
  })

  return parseEntry(kind, reply.isAnswered ? reply.text : undefined, line)
}

// A + by a section heading, or Edit in an open row: puts the /tracker command
// in the message box for the person to finish and send. Anything already
// typed there joins it. Where the box can't take it, the status line says
// what to type.
async function startCommand($: EngineInterface, command: string): Promise<void> {
  const draft = (await $.prompt.read()).text.trim()
  const filled = await $.prompt.fill({ text: draft === '' ? command : `${command}${draft}`, mode: 'replace' })

  if (!filled.isFilled) {
    await flashStatus($, `Type "${command.trim()} …" in the message box.`, 15_000)
  }
}

// After each of Claude's replies: ask the model what the tracker should gain
// from that exchange, then merge it into the tracker as it stands by then.
async function runUpdater($: EngineInterface, exchange: string): Promise<void> {
  await update($, note, () => 'Updating…')
  const now = await $.clock.now()
  const reply = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: buildPrompt(await read($, tracker), exchange, now),
    maxTokens: 2048,
    timeoutMs: 90_000,
  })

  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? reply.error : reply.reason
    await update($, note, () => `Couldn't update (${why}). It will try again after the next reply.`)

    return
  }
  const changes = parseChanges(reply.text)

  if (changes === undefined) {
    await update($, note, () => "Couldn't read the update. It will try again after the next reply.")

    return
  }
  let ticked: string[] = []
  await changeTracker($, t => {
    const before = t ?? EMPTY
    const after = applyChanges(before, changes, isoDay(now))
    ticked = newlyFinished(before, after)

    return after
  })
  if (ticked.length > 0) {
    await flashStatus($, `Ticked off: ${ticked.join('; ')}. Untick it to undo.`, 10_000)
  } else {
    await update($, note, () => null)
  }
}

// "Scan earlier messages": the updater over the conversation so far, a stretch
// at a time, oldest first, for what was settled before the tracker was
// watching. Nothing is added twice, so a scan can run again safely.
const SCAN_SIZE = 40_000

async function runScan($: EngineInterface): Promise<void> {
  const messages = await $.session.messages()
  if ('deny' in messages) return
  const stretches = earlierStretches(messages, SCAN_SIZE)
  const count = (t: Tracker) => t.actions.length + t.questions.length + t.decisions.length + (t.sidequests ?? []).length
  let added = 0

  for (const [at, stretch] of stretches.entries()) {
    await update($, note, () => `Scanning earlier messages… ${at + 1} of ${stretches.length}`)
    const now = await $.clock.now()
    const reply = await $.model.complete({
      model: MODEL,
      system: SYSTEM,
      prompt: buildPrompt(await read($, tracker), stretch, now, 'earlier'),
      maxTokens: 4096,
      timeoutMs: 120_000,
    })
    if (!reply.isAnswered) {
      const why = reply.reason === 'api-error' ? reply.error : reply.reason
      await flashStatus($, `The scan stopped at ${at + 1} of ${stretches.length} (${why}). Run it again to finish.`, 20_000)

      return
    }
    const changes = parseChanges(reply.text)
    if (changes === undefined) continue
    // A write that misses its version runs this again: count once, after.
    let gained = 0
    await changeTracker($, t => {
      const before = t ?? EMPTY
      const after = applyChanges(before, changes, isoDay(now))
      gained = count(after) - count(before)

      return after
    })
    added += gained
  }
  await flashStatus(
    $,
    added === 0 ? 'Scan done: nothing new in earlier messages.' : `Scan done: added ${added} ${added === 1 ? 'item' : 'items'} from earlier messages.`,
    15_000,
  )
}

// After each turn of a helper agent this conversation started: the same
// update over the agent's own latest exchange (Claude's task, the agent's
// replies), into that agent's side tracker, titled with its task. Quiet on
// the status line unless it fails.
async function runSideUpdater($: EngineInterface, agent: string, exchange: string): Promise<void> {
  const title = (await $.agent.list()).find(one => one.id === agent)?.description ?? 'Helper agent'
  const now = await $.clock.now()
  const before = (await read($, tracker)).side?.find(side => side.agent === agent)?.tracker ?? EMPTY
  const reply = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: buildPrompt(before, exchange, now, 'agent'),
    maxTokens: 2048,
    timeoutMs: 90_000,
  })
  const changes = reply.isAnswered ? parseChanges(reply.text) : undefined

  if (changes === undefined) {
    await flashStatus($, `Couldn't update the tracker for "${title}". It will try again after its next step.`, 10_000)

    return
  }
  await changeTracker($, t => onSide(t ?? EMPTY, agent, title, side => applyChanges(side, changes, isoDay(now))))
}

function newlyFinished(before: Tracker, after: Tracker): string[] {
  const all = (t: Tracker) => [...t.actions, ...t.questions, ...(t.sidequests ?? [])]
  const wasOpen = new Set(all(before).filter(item => item.status === 'open').map(item => item.id))

  return all(after).filter(item => item.status !== 'open' && wasOpen.has(item.id)).map(item => item.text)
}

export const register: Register = on => {
  // One update at a time, in the order the replies came.
  let queue: Promise<void> = Promise.resolve()

  // The person's next message, where a reply waits above the box: it opens
  // with the question, so the exchange (and the updater) see what it answers.
  on('prompt.submit', async ($, e, next) => {
    const id = await read($, replyingTo)

    if (id === null || e.command !== undefined || e.isMeta === true || e.origin.kind === 'task-notification') {
      return next(e)
    }
    const question = (await read($, tracker)).questions.find(item => item.id === id)
    await setReplyingTo($, null)

    return question === undefined ? next(e) : next({ ...e, text: replyPrefix(question) + e.text.replace(REPLY, '') })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const messages = await $.session.messages()
      const exchange = 'deny' in messages ? undefined : latestExchange(messages, e.answer)

      if (exchange !== undefined) {
        queue = queue
          .then(() => runUpdater($, exchange))
          .catch(async (error: unknown) => {
            const why = (error instanceof Error ? error.message : String(error)).slice(0, 80)
            await update($, note, () => `Couldn't update (${why}). It will try again after the next reply.`)
          })
          // Saying so can fail too, once the mod has reloaded: the queue goes on.
          .catch(() => undefined)
      }
    } else if (e.agentId !== undefined && e.reason === 'answer') {
      const agent = e.agentId
      const messages = await $.session.messages({ agentId: agent })
      const exchange = 'deny' in messages ? undefined : latestExchange(messages, e.answer)

      if (exchange !== undefined) {
        queue = queue.then(() => runSideUpdater($, agent, exchange)).catch(() => undefined)
      }
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tracker',
      description: 'Show or hide the tracker; /tracker add <item> or /tracker edit <id> <words> to change it',
    })
    try {
      await load($)
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).slice(0, 80)
      await flashStatus($, `Couldn't load this conversation's saved tracker (${why}).`, 15_000)
    }
    if (!(await read($, isClosed))) {
      // A pane that can't open now waits for /tracker or the Show tracker button.
      openPane($).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)

    if (e.origin.kind === 'person') {
      await markClosed($, true)
    }

    return closed
  })

  on('command.run', { command: 'tracker' }, async ($, e) => {
    const typed = e.args.trim()
    const adding = typed.match(ADD)
    const editing = typed.match(EDIT)
    const framing = typed.match(FRAME)
    const settingAside = typed.match(SET_ASIDE)

    if (settingAside !== null) {
      const verb = settingAside[1]?.toLowerCase()
      const id = settingAside[2] ?? ''
      const found = find(await read($, tracker), id)
      if (found === undefined) return { text: `There's no item ${id} in the tracker.` }
      await changeTracker($, now => (verb === 'dismiss' ? dismiss : restore)(now ?? EMPTY, id))

      return { text: `${verb === 'dismiss' ? 'Dismissed' : 'Restored'}: ${found.item.text}` }
    }

    if (framing !== null) {
      const field = (framing[1]?.toLowerCase() ?? 'title') as 'title' | 'goal'
      const words = framing[2] ?? ''
      await changeTracker($, now => frame(now ?? EMPTY, field, words))

      return { text: words.trim() === '' ? `Cleared the ${field}.` : `Set the ${field}: ${words.trim()}` }
    }

    if (adding !== null) {
      const kind = (adding[1]?.toLowerCase() ?? 'action') as Kind
      const line = adding[2] ?? ''
      if (line.trim() === '') return { text: `Type what to add after "/tracker add ${kind}:".` }
      const today = isoDay(await $.clock.now())
      const entry = await readEntry($, kind, line)
      let added = ''
      await changeTracker($, now => {
        const result = add(now ?? EMPTY, kind, entry, today)
        added = result.id

        return result.tracker
      })

      return { text: `Added to ${SECTION[kind]}: ${editLine(kind, entry)}${added === '' ? '' : ` [${added}]`}` }
    }
    if (editing !== null) {
      const id = editing[1] ?? ''
      const found = find(await read($, tracker), id)
      if (found === undefined) return { text: `There's no item ${id} in the tracker.` }
      const line = editing[2] ?? ''
      if (line.trim() === '') return { text: `Type the new words after "/tracker edit ${id}".` }
      const entry = await readEntry($, found.kind, line)
      await changeTracker($, now => edit(now ?? EMPTY, id, entry))

      return { text: `Updated ${SECTION[found.kind].toLowerCase()}: ${editLine(found.kind, entry)}` }
    }
    if (/^show$/i.test(typed)) return { text: asText(await read($, tracker)) }
    if (typed !== '') return { text: USAGE }

    const pane = (await $.ui.panes()).find(one => one.id === PANE)

    if (pane?.isPlaced === true && pane.isShown) {
      await closePane($)

      return { text: 'Tracker closed.' }
    }

    // Where nothing draws the pane (a cloud session), the tracker comes back
    // as the command's text instead.
    return (await openPane($)) ? { text: 'Tracker opened.' } : { text: asText(await read($, tracker)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, tracker)
    const closed = await read($, isClosed)
    const id = await read($, replyingTo)
    const question = id === null ? undefined : t.questions.find(item => item.id === id)

    if (e.props.hasSurvey || (!closed && question === undefined)) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {question === undefined ? null : (
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={1}>
              <Text>
                <Text dimColor>Replying to:</Text> {question.text}
              </Text>
            </Box>
            <Button key="cancel-reply" label="Cancel" plain dimColor onPress={() => setReplyingTo($, null)} />
          </Box>
        )}
        {closed ? (
          <Box flexDirection="row" gap={1}>
            <Button key="show" label="Show tracker" onPress={() => openPane($)} />
            <Text dimColor>{summary(t)}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await read($, tracker)
    const status = await read($, note)

    // Each action item's checkbox: a click ticks or unticks it.
    const checkbox = (id: string, glyph: string, isFinished: boolean) => (
      <Button
        key={`tick:${id}`}
        label={glyph}
        plain
        dimColor={isFinished}
        onPress={async () => {
          const today = isoDay(await $.clock.now())
          await changeTracker($, now => toggle(now ?? EMPTY, id, today))
        }}
      />
    )

    // An item's words, struck once finished. Plain text: a desktop draws a
    // Button natively, without its children's strikethrough, and its
    // transcript doesn't scroll to a row, so the words aren't clickable.
    const words = (isFinished: boolean, text: string, meta: string | undefined, lead?: string) => (
      <Text dimColor={isFinished}>
        {lead === undefined ? null : <Text bold>{lead} </Text>}
        <Text strikethrough={isFinished}>{text}</Text>
        {meta === undefined ? null : <Text dimColor> ({meta})</Text>}
      </Text>
    )

    // What the person can do with an item, shown while the pointer is over its
    // row: ✎ puts its /tracker edit in the message box, ✕ dismisses it. A
    // gutter is kept for them so nothing shifts when they show.
    const tools = (item: { id: string; text: string }, kind: Kind) => (
      <Box width={4} flexShrink={0}>
        <Box display="none" hover={{ display: 'flex' }} flexDirection="row" gap={1}>
          <Button
            key={`edit:${item.id}`}
            label="✎"
            plain
            dimColor
            onPress={() => startCommand($, `/tracker edit ${item.id} ${editLine(kind, item)}`)}
          />
          <Button
            key={`dismiss:${item.id}`}
            label="✕"
            plain
            dimColor
            onPress={() => changeTracker($, now => dismiss(now ?? EMPTY, item.id))}
          />
        </Box>
      </Box>
    )

    // An item's line, keyed so the pointer over it reveals its tools.
    const row = (item: { id: string; text: string }, kind: Kind, line: RenderChildren[]) => (
      <Box key={`row:${item.id}`} flexDirection="row" gap={1}>
        {line}
        {tools(item, kind)}
      </Box>
    )

    const actionRow = (item: ActionItem) => {
      const isDone = item.status === 'done'

      return row(item, 'action', [
        checkbox(item.id, isDone ? '☑' : '☐', isDone),
        <Box flexShrink={1}>{words(isDone, item.text, actionMeta(item))}</Box>,
      ])
    }

    // A question's mark starts a reply to it in the message box.
    const questionRow = (item: Question) => {
      const isResolved = item.status === 'resolved'

      return row(item, 'question', [
        <Button
          key={`ask:${item.id}`}
          label={isResolved ? '✓' : '?'}
          plain
          dimColor={isResolved}
          onPress={() => replyTo($, item)}
        />,
        <Box flexShrink={1}>{words(isResolved, item.text, questionMeta(item))}</Box>,
      ])
    }

    const sidequestRow = (item: Sidequest) => {
      const isDone = item.status === 'done'

      return row(item, 'sidequest', [
        checkbox(item.id, isDone ? '☑' : '☐', isDone),
        <Box flexShrink={1}>{words(isDone, item.text, sidequestMeta(item))}</Box>,
      ])
    }

    const decisionRow = (item: Decision) =>
      row(item, 'decision', [
        <Box flexShrink={1}>{words(false, item.text, item.reason, `${shortDate(item.decidedOn)}:`)}</Box>,
      ])

    // A section's heading, with a + that starts a /tracker add in the message box.
    const heading = (kind: Kind) => (
      <Box flexDirection="row" gap={1}>
        <Text bold>{SECTION[kind]}</Text>
        <Button key={`add:${kind}`} label="+" plain dimColor onPress={() => startCommand($, `/tracker add ${kind}: `)} />
      </Box>
    )

    const kept = <T extends { dismissed?: true }>(items: T[]) => items.filter(item => item.dismissed !== true)
    const actions = openFirst(kept(t.actions), item => item.status === 'open', item => item.doneOn ?? '')
    const questions = openFirst(kept(t.questions), item => item.status === 'open', item => item.resolvedOn ?? '')
    const decisions = kept(t.decisions).sort((a, b) => b.decidedOn.localeCompare(a.decidedOn))
    const sidequests = openFirst(kept(t.sidequests ?? []), item => item.status === 'open', item => item.doneOn ?? '')
    const dismissed = [...t.actions, ...t.questions, ...t.decisions, ...(t.sidequests ?? [])].filter(
      item => item.dismissed === true,
    )
    const isDismissedShown = await read($, showDismissed)
    const foldedDone = await read($, hiddenDone)

    // A section's rows: its open items, then, when any are finished, a Done
    // line that folds those away or shows them again.
    const sectionRows = <T extends { id: string; status: string }>(kind: Kind, items: T[], draw: (item: T) => RenderChildren) => {
      const open = items.filter(item => item.status === 'open')
      const finished = items.filter(item => item.status !== 'open')
      const isFolded = foldedDone.includes(kind)

      return [
        ...open.map(draw),
        ...(finished.length === 0
          ? []
          : [
              <Button
                key={`done:${kind}`}
                label={`${isFolded ? '▸' : '▾'} Done (${finished.length})`}
                plain
                dimColor
                onPress={() =>
                  update($, hiddenDone, now => (isFolded ? (now ?? []).filter(one => one !== kind) : [...(now ?? []), kind]))
                }
              />,
              ...(isFolded ? [] : finished.map(draw)),
            ]),
      ]
    }
    const shownSides = await read($, openSides)
    const sides = (t.side ?? []).filter(side => {
      const s = side.tracker

      return s.actions.length + s.questions.length + s.decisions.length + (s.sidequests ?? []).length > 0
    })

    // One helper agent's tracker: a line with its task and what's open, which
    // opens to its items. Its checkboxes tick its own items; the rest reads.
    const sideGroup = (side: Side) => {
      const s = side.tracker
      const isOpen = shownSides.includes(side.agent)
      const open =
        s.actions.filter(item => item.status === 'open').length +
        s.questions.filter(item => item.status === 'open').length +
        (s.sidequests ?? []).filter(item => item.status === 'open').length
      const tick = (id: string, isDone: boolean) => (
        <Button
          key={`side-tick:${side.agent}:${id}`}
          label={isDone ? '☑' : '☐'}
          plain
          dimColor={isDone}
          onPress={async () => {
            const today = isoDay(await $.clock.now())
            await changeTracker($, now => toggleSide(now ?? EMPTY, side.agent, id, today))
          }}
        />
      )
      const line = (mark: RenderChildren, body: RenderChildren) => (
        <Box flexDirection="row" gap={1}>
          {mark}
          <Box flexShrink={1}>{body}</Box>
        </Box>
      )

      return (
        <Box flexDirection="column">
          <Button
            key={`side:${side.agent}`}
            label={`${isOpen ? '▾' : '▸'} ${side.title} (${open} open)`}
            plain
            onPress={() =>
              update($, openSides, now =>
                (now ?? []).includes(side.agent) ? (now ?? []).filter(id => id !== side.agent) : [...(now ?? []), side.agent],
              )
            }
          />
          {isOpen ? (
            <Box flexDirection="column" marginLeft={2}>
              {openFirst(s.actions, item => item.status === 'open', item => item.doneOn ?? '').map(item =>
                line(tick(item.id, item.status === 'done'), words(item.status === 'done', item.text, actionMeta(item))),
              )}
              {openFirst(s.questions, item => item.status === 'open', item => item.resolvedOn ?? '').map(item =>
                line(
                  <Text dimColor={item.status === 'resolved'}>{item.status === 'resolved' ? '✓' : '?'}</Text>,
                  words(item.status === 'resolved', item.text, questionMeta(item)),
                ),
              )}
              {s.decisions.map(item => line(<Text dimColor>·</Text>, words(false, item.text, item.reason, `${shortDate(item.decidedOn)}:`)))}
              {openFirst(s.sidequests ?? [], item => item.status === 'open', item => item.doneOn ?? '').map(item =>
                line(tick(item.id, item.status === 'done'), words(item.status === 'done', item.text, sidequestMeta(item))),
              )}
            </Box>
          ) : null}
        </Box>
      )
    }

    // The title and goal at the top, each with an ✎ shown while the pointer is
    // over it that puts its /tracker command in the message box.
    const framing = (field: 'title' | 'goal', body: RenderChildren, current: string | undefined) => (
      <Box key={`frame:${field}`} flexDirection="row" gap={1}>
        <Box flexShrink={1}>{body}</Box>
        <Box width={2} flexShrink={0}>
          <Box display="none" hover={{ display: 'flex' }}>
            <Button
              key={`set:${field}`}
              label="✎"
              plain
              dimColor
              onPress={() => startCommand($, `/tracker ${field} ${current ?? ''}`)}
            />
          </Box>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {framing(
          'title',
          t.title === undefined ? (
            <Text dimColor bold size="heading">
              Untitled conversation
            </Text>
          ) : (
            <Text bold size="heading">
              {t.title}
            </Text>
          ),
          t.title,
        )}
        {framing(
          'goal',
          <Text dimColor>
            <Text bold>Goal:</Text> {t.goal ?? 'not clear yet'}
          </Text>,
          t.goal,
        )}
        <Box marginTop={1}>
          <Text>{summary(t)}</Text>
        </Box>
        {status === null ? null : <Text dimColor>{status}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {heading('action')}
          {actions.length === 0 ? <Text dimColor>None yet.</Text> : sectionRows('action', actions, actionRow)}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {heading('question')}
          {questions.length === 0 ? <Text dimColor>None yet.</Text> : sectionRows('question', questions, questionRow)}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {heading('decision')}
          {decisions.length === 0 ? <Text dimColor>None yet.</Text> : decisions.map(decisionRow)}
        </Box>
        {sidequests.length === 0 ? null : (
          <Box flexDirection="column" marginTop={1}>
            {heading('sidequest')}
            {sectionRows('sidequest', sidequests, sidequestRow)}
          </Box>
        )}
        {sides.length === 0 ? null : (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Helper agents</Text>
            {sides.map(sideGroup)}
          </Box>
        )}
        <Box marginTop={1}>
          <Button
            key="scan"
            label="Scan earlier messages"
            plain
            dimColor
            onPress={() => {
              queue = queue
                .then(() => runScan($))
                .catch(async (error: unknown) => {
                  const why = (error instanceof Error ? error.message : String(error)).slice(0, 80)
                  await flashStatus($, `The scan failed (${why}).`, 15_000)
                })
                .catch(() => undefined)
            }}
          />
        </Box>
        {dismissed.length === 0 ? null : (
          <Box flexDirection="column" marginTop={1}>
            <Button
              key="dismissed"
              label={`${isDismissedShown ? '▾' : '▸'} Dismissed (${dismissed.length})`}
              plain
              dimColor
              onPress={() => update($, showDismissed, now => !(now ?? false))}
            />
            {isDismissedShown
              ? dismissed.map(item => (
                  <Box flexDirection="row" gap={1}>
                    <Box flexShrink={1}>
                      <Text dimColor>{item.text}</Text>
                    </Box>
                    <Button
                      key={`restore:${item.id}`}
                      label="Restore"
                      plain
                      dimColor
                      onPress={() => changeTracker($, now => restore(now ?? EMPTY, item.id))}
                    />
                  </Box>
                ))
              : null}
          </Box>
        )}
      </Box>
    )
  })
}
