import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Tracker } from '../types'
import { add, dismiss, edit, restore } from '../hooks/edits'
import { editLine, parseEntry } from '../hooks/entry'
import { findContext } from '../hooks/quotes'
import { decode, encode } from '../hooks/saved'
import { applyChanges, buildPrompt, earlierStretches, parseChanges } from '../hooks/updater'

const PANE = {
  plugin: 'conversation-tracker',
  component: 'Pane',
  requestId: 'tracker',
  props: {
    title: 'Tracker',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'conversation-tracker',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const SAMPLE: Tracker = {
  actions: [
    { id: 'a1', text: 'Send revised proposal to client', owner: 'me', due: '2026-11-07', status: 'open' },
    { id: 'a2', text: 'Set up the Stripe test account', owner: 'Claude', status: 'open' },
    { id: 'a3', text: 'Book onboarding call with the design partner', due: '2026-11-04', status: 'open' },
    { id: 'a4', text: 'Collect competitor pricing screenshots', owner: 'Claude', status: 'done', doneOn: '2026-10-29' },
    { id: 'a5', text: 'Draft pricing page copy', status: 'done', doneOn: '2026-10-30' },
  ],
  questions: [
    { id: 'q1', text: 'What is the launch date?', status: 'open' },
    { id: 'q2', text: 'Does the free tier need a seat limit?', status: 'open' },
    {
      id: 'q3',
      text: 'Stripe or Paddle for payments?',
      status: 'resolved',
      answer: 'Stripe, since the account already exists',
      resolvedOn: '2026-10-30',
    },
  ],
  decisions: [
    { id: 'd1', text: 'Launch with monthly billing only', reason: 'simpler to support', decidedOn: '2026-10-29' },
    { id: 'd2', text: 'Use Stripe for payments', reason: 'account already set up', decidedOn: '2026-10-30' },
    { id: 'd3', text: 'Cap the free tier at 3 seats', reason: 'keeps support load low', decidedOn: '2026-10-31' },
  ],
}

// The session's values, kept in memory, with the engine's own band beneath.
// A call on `$` is answered `{ value }`; the tracker is stored with its tag.
// Each map is seated once; a test watches its writes through `watchers`.
const watchers = new WeakMap<Map<string, unknown>, ((key: string, value: unknown) => void)[]>()
// The files each seated map's session wrote, by path, in the conversation
// `conv-1` under the home folder `/home/test`.
const disks = new WeakMap<Map<string, unknown>, Map<string, string>>()
const SAVED_AT = '/home/test/.claude/conversation-tracker/conv-1.json'

// The styled runs inside a found Text: its child Text elements, with their props.
function runs(found: { children?: unknown } | undefined): { props: Record<string, unknown> }[] {
  return ((found?.children ?? []) as unknown[]).filter(
    (child): child is { props: Record<string, unknown> } => typeof child === 'object' && child !== null && 'props' in child,
  )
}

function holdsUndefined(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false

  return Object.values(value).some(holdsUndefined)
}

function seat(on: On, saved: Map<string, unknown>) {
  if (watchers.has(saved)) return
  watchers.set(saved, [])
  const files = new Map<string, string>()
  disks.set(saved, files)
  on('session.id', () => ({ value: 'conv-1' }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  let version = 0
  on('state.get', ($, e) => ({ value: { value: saved.get(e.key), version } }))
  on('state.set', ($, e) => {
    // The engine takes JSON data only: a field left undefined is refused.
    if (holdsUndefined(e.value)) throw new Error(`state.set ${e.key}: a field is undefined`)
    saved.set(e.key, e.value)
    version += 1
    for (const watch of watchers.get(saved) ?? []) watch(e.key, e.value)

    return { value: { isSet: true, version } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}

function stored(t: Tracker) {
  return { shape: 'tracker-1', value: t }
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('the pane shows the summary and the three sections, on every surface', async ($, on) => {
  seat(on, new Map([['tracker', stored(SAMPLE)]]))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('5 open · 3 done · 3 decisions')
    expect(await ui.find({ type: 'Text', text: 'Action items' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Open questions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Decisions' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Send revised proposal/ }))?.text).toBe(
      'Send revised proposal to client (owner: me, due: Nov 7)',
    )
    expect((await ui.find({ type: 'Text', text: /^Draft pricing page copy/ }))?.text).toBe(
      'Draft pricing page copy (done Oct 30)',
    )
    expect((await ui.find({ type: 'Text', text: /^Oct 29:/ }))?.text).toBe(
      'Oct 29: Launch with monthly billing only (simpler to support)',
    )
    expect((await ui.find({ type: 'Text', text: /^Stripe or Paddle/ }))?.text).toBe(
      'Stripe or Paddle for payments? (done Oct 30, Stripe, since the account already exists)',
    )
    await ui.unmount()
  }
})

test('a conversation starts with an empty tracker', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('0 open · 0 done · 0 decisions')
  expect(await ui.findAll({ type: 'Text', text: 'None yet.' })).toHaveLength(3)
  await ui.unmount()
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', ($, e) => ({ value: { value: e.key === 'tracker' ? { actions: 'old' } : undefined, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('0 open · 0 done · 0 decisions')
  await ui.unmount()
})

const ANSWER = 'Monthly billing only it is. I will send the proposal by Friday. What is the launch date?'

// Stands in for the engine around one turn's end, with the model's reply
// given: register it before the test's first call on `$`. `end` ends the turn
// and waits until the updater has finished; `prompts` holds what it sent.
function aTurn(on: On, saved: Map<string, unknown>, reply: string) {
  const prompts: string[] = []
  let finished!: () => void
  const done = new Promise<void>(resolve => {
    finished = resolve
  })

  seat(on, saved)
  watchers.get(saved)?.push((key, value) => {
    if (key === 'note' && value !== 'Updating…') finished()
  })
  mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Earlier prompt', toolUses: [] },
      { role: 'assistant', text: 'Earlier answer', toolUses: [] },
      {
        role: 'user',
        text: "Let's launch with monthly billing only, it's simpler to support. Can you send the revised proposal to the client by Friday?",
        toolUses: [],
      },
      { role: 'assistant', text: '', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [] },
      { role: 'assistant', text: ANSWER, toolUses: [] },
    ],
  }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return {
    prompts,
    end: async ($: Engine) => {
      await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
      await done
    },
  }
}

async function endTurn($: Engine, on: On, saved: Map<string, unknown>, reply: string): Promise<string[]> {
  const turn = aTurn(on, saved, reply)
  await turn.end($)

  return turn.prompts
}

test('after a reply, the updater adds what the exchange settled', async ($, on) => {
  const saved = new Map<string, unknown>()
  const prompts = await endTurn(
    $,
    on,
    saved,
    '```json\n{"actions":[{"text":"Send revised proposal to client","owner":"Claude","due":"2026-11-06"}],' +
      '"questions":[{"text":"What is the launch date?"}],' +
      '"decisions":[{"text":"Launch with monthly billing only","reason":"simpler to support"}],"updates":[]}\n```',
  )

  // The model sees today's date and only the latest exchange.
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Today is Saturday, 2026-10-31.')
  expect(prompts[0]).toContain('send the revised proposal to the client by Friday')
  expect(prompts[0]).not.toContain('Earlier prompt')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('2 open · 0 done · 1 decision')
  expect((await ui.find({ type: 'Text', text: /^Send revised proposal/ }))?.text).toBe(
    'Send revised proposal to client (owner: Claude, due: Nov 6)',
  )
  expect(await ui.find({ type: 'Text', text: 'What is the launch date?' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Oct 31:/ }))?.text).toBe(
    'Oct 31: Launch with monthly billing only (simpler to support)',
  )
  expect(saved.get('note')).toBe(null)
  await ui.unmount()
})

test('a reply the updater cannot read changes nothing and says so', async ($, on) => {
  const saved = new Map<string, unknown>()
  await endTurn($, on, saved, 'Sorry, I am not sure.')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('0 open · 0 done · 0 decisions')
  expect((await ui.find({ type: 'Text', text: /^Couldn't read/ }))?.text).toBe(
    "Couldn't read the update. It will try again after the next reply.",
  )
  await ui.unmount()
})

test('merging skips repeats and fills only missing owners and due dates', () => {
  const changes = parseChanges(
    JSON.stringify({
      actions: [
        { text: 'send revised proposal to client!' },
        { text: 'Write the FAQ', owner: 'me', due: 'next week' },
        { text: '   ' },
      ],
      questions: [{ text: 'What is the launch date' }],
      decisions: [{ text: 'Use Stripe for payments.' }],
      updates: [
        { id: 'a2', owner: 'me', due: '2026-11-09' },
        { id: 'a3', owner: 'Dana' },
        { id: 'a5', due: '2026-11-09' },
      ],
    }),
  )
  expect(changes).toBeDefined()
  if (changes === undefined) return

  const merged = applyChanges(SAMPLE, changes, '2026-10-31')

  // Repeats of existing items, however punctuated, are left out.
  expect(merged.actions.map(item => item.text)).toEqual([...SAMPLE.actions.map(item => item.text), 'Write the FAQ'])
  expect(merged.questions).toHaveLength(SAMPLE.questions.length)
  expect(merged.decisions).toHaveLength(SAMPLE.decisions.length)
  // A date that is not YYYY-MM-DD is dropped; new ids follow the old ones.
  expect(merged.actions.at(-1)).toEqual({ id: 'a6', text: 'Write the FAQ', owner: 'me', status: 'open' })
  // An owner already set stays; a missing one is filled; done items are left alone.
  expect(merged.actions[1]).toEqual({ ...SAMPLE.actions[1], due: '2026-11-09' })
  expect(merged.actions[2]).toEqual({ ...SAMPLE.actions[2], owner: 'Dana' })
  expect(merged.actions[4]).toEqual(SAMPLE.actions[4])
})

test('the updater ticks off finished items and resolves answered questions', async ($, on) => {
  const saved = new Map<string, unknown>([
    [
      'tracker',
      stored({
        actions: [
          { id: 'a1', text: 'Draft the FAQ', owner: 'Claude', due: '2026-11-06', status: 'open' },
          { id: 'a2', text: 'Write release notes', status: 'open', locked: true },
        ],
        questions: [{ id: 'q1', text: 'Who owns the launch email?', status: 'open' }],
        decisions: [],
      }),
    ],
  ])
  const prompts = await endTurn(
    $,
    on,
    saved,
    '{"done":[{"id":"a1","how":"you finished it"},{"id":"a2"},{"id":"zz"}],"resolved":[{"id":"q1","answer":"Dana owns it"}]}',
  )

  expect(prompts[0]).toContain('- action a2 [open, locked] Write release notes')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('0 open · 3 done · 0 decisions')
  expect((await ui.find({ type: 'Text', text: /^Draft the FAQ/ }))?.text).toBe('Draft the FAQ (done Oct 31, you finished it)')
  expect((await ui.find({ type: 'Text', text: /^Who owns/ }))?.text).toBe(
    'Who owns the launch email? (done Oct 31, Dana owns it)',
  )
  // Locked details don't stop a tick the conversation shows.
  expect((await ui.find({ type: 'Text', text: /^Write release notes/ }))?.text).toBe('Write release notes (done Oct 31)')
  expect((await ui.find({ key: 'tick:a1' }))?.text).toBe('☑')
  expect((await ui.find({ key: 'ask:q1' }))?.text).toBe('✓')
  expect((await ui.find({ key: 'tick:a2' }))?.text).toBe('☑')
  // Said on the pane's status line, not in a toast headed with the mod's name.
  expect(saved.get('note')).toBe('Ticked off: Draft the FAQ; Write release notes; Who owns the launch email?. Untick it to undo.')
  await ui.unmount()
})

test('unticking a finished item reopens it, on every surface', async ($, on) => {
  const saved = new Map<string, unknown>()
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 10, 2, 9).getTime() })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    saved.set('tracker', stored({ ...SAMPLE, actions: SAMPLE.actions.map(item => (item.id === 'a5' ? { ...item, doneNote: 'you finished it' } : item)) }))
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'tick:a5' })
    const after = (saved.get('tracker') as { value: Tracker }).value

    expect(after.actions[4]).toEqual({ id: 'a5', text: 'Draft pricing page copy', status: 'open' })
    // Everything else is as it was.
    expect(after.actions.slice(0, 4)).toEqual(SAMPLE.actions.slice(0, 4))
    expect(after.questions).toEqual(SAMPLE.questions)
    expect(after.decisions).toEqual(SAMPLE.decisions)
    await ui.unmount()
  }
})

test('ticking an open item finishes it today', async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 10, 2, 9).getTime() })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'tick:a1' })
  const after = (saved.get('tracker') as { value: Tracker }).value

  expect(after.actions[0]).toEqual({ ...SAMPLE.actions[0], status: 'done', doneOn: '2026-11-02' })
  await ui.unmount()
})

function trackerIn(saved: Map<string, unknown>): Tracker {
  return (saved.get('tracker') as { value: Tracker }).value
}

// The message box, as the engine beneath holds it: `fills` records each fill;
// `takes` false stands for a box that refuses one, as one an app draws may.
function messageBox(on: On, draft: string, takes: boolean) {
  const fills: { text: string; mode: string }[] = []
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })

    // An event of its own as well as a call: answered by its own result.
    return takes ? { isFilled: true } : { isFilled: false, refusal: 'no_composer' as const }
  })

  return fills
}

test("clicking a question's mark starts a reply to it in the message box", async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  seat(on, saved)
  const fills = messageBox(on, 'Re: "What is the launch date?" draft so far', true)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'ask:q2' })
    await ui.press({ key: 'ask:q3' })
    await ui.unmount()
  }
  // A reply to another question gives way; what was typed after it stays.
  expect(fills).toHaveLength(8)
  expect(fills[0]).toEqual({ text: 'Re: "Does the free tier need a seat limit?" draft so far', mode: 'replace' })
  expect(fills[1]).toEqual({ text: 'Re: "Stripe or Paddle for payments?" draft so far', mode: 'replace' })
  expect(saved.get('replyingTo')).toBeUndefined()
})

test("where the box won't take it, the reply waits above the box and opens the next message", async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  seat(on, saved)
  messageBox(on, '', false)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)

    return { text: e.text }
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'ask:q2' })
  expect(saved.get('replyingTo')).toBe('q2')
  await pane.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Replying to:/ }))?.text).toBe(
    'Replying to: Does the free tier need a seat limit?',
  )
  expect(await band.find({ key: 'cancel-reply' })).toBeDefined()
  expect(await band.find({ key: 'show' })).toBeUndefined()
  await band.unmount()

  // A slash command passes it by; the next message carries it.
  await $.prompt.submit({ text: '/tracker', command: { name: 'tracker', args: '' }, wait: false, origin: { kind: 'composer' } })
  expect(saved.get('replyingTo')).toBe('q2')
  await $.prompt.submit({ text: 'Yes, 3 seats', wait: false, origin: { kind: 'composer' } })
  expect(sent).toEqual(['/tracker', 'Re: "Does the free tier need a seat limit?" Yes, 3 seats'])
  expect(saved.get('replyingTo')).toBe(null)
})

test('Cancel drops a waiting reply', async ($, on) => {
  const saved = new Map<string, unknown>([
    ['tracker', stored(SAMPLE)],
    ['replyingTo', 'q1'],
  ])
  seat(on, saved)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await band.press({ key: 'cancel-reply' })
  expect(saved.get('replyingTo')).toBe(null)
  await band.unmount()
})

test("new items keep where they came from; a row's ▸ opens it to the line in context where the app can't scroll", async ($, on) => {
  const saved = new Map<string, unknown>()
  const turn = aTurn(
    on,
    saved,
    '{"actions":[{"text":"Send the revised proposal","from":"person","quote":"Can you send the revised proposal to the client by Friday?"}],' +
      '"questions":[{"text":"What is the launch date?","from":"claude","quote":"What is the launch date?"}],' +
      '"decisions":[{"text":"Monthly billing only"}]}',
  )
  // Each row opened, in order.
  const opened: unknown[] = []
  watchers.get(saved)?.push((key, value) => {
    if (key === 'expanded' && value !== null) opened.push(value)
  })

  // The exchange's rows, as the main conversation keeps them.
  const row = (door: 'prompt' | 'response', type: 'user' | 'assistant', text: string, uuid: string) =>
    $.session.append({
      message: { type, role: type, content: [{ type: 'text', text }] },
      door,
      origin: door === 'prompt' ? { kind: 'composer' } : { kind: 'model', model: 'claude' },
      uuid,
    })
  await row('prompt', 'user', 'Can you send the revised proposal to the client by Friday?', 'row-prompt')
  await row('response', 'assistant', ANSWER, 'row-answer')
  const rows = saved.get('rows') as { prompt?: string; answer?: string }
  expect(rows.prompt).toBeDefined()
  expect(rows.answer).toBeDefined()
  expect(rows.answer).not.toBe(rows.prompt)

  await turn.end($)
  const t = trackerIn(saved)
  expect(t.actions[0]).toMatchObject({ source: rows.prompt, quote: { by: 'person' } })
  expect(t.questions[0]).toMatchObject({ source: rows.answer, quote: { by: 'claude', text: 'What is the launch date?' } })
  expect(t.decisions[0]?.source).toBe(rows.prompt)
  expect(t.decisions[0]?.quote).toBeUndefined()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    saved.set('tracker', stored({ ...t, actions: t.actions.map(item => ({ ...item, status: 'done' as const, doneOn: '2026-10-31' })) }))
    const ui = await $.ui.mount({ ...PANE, surface })
    // The text stays plain, struck once done; each row has a ▸ kept for hover.
    expect((await ui.find({ type: 'Text', text: /^Send the revised proposal/ }))?.text).toBe('Send the revised proposal (done Oct 31)')
    expect(runs(await ui.find({ type: 'Text', text: /^Send the revised proposal/ }))[0]?.props.strikethrough).toBe(true)
    expect((await ui.find({ key: 'go:a1' }))?.text).toBe('▸')
    // The kit draws no conversation to scroll, as the desktop app won't.
    await ui.press({ key: 'go:a1' })
    await ui.press({ key: 'go:q1' })
    await ui.press({ key: 'go:d1' })
    await ui.unmount()
  }
  expect(opened.slice(0, 3)).toEqual([
    {
      id: 'a1',
      context: {
        by: 'person',
        before: "Let's launch with monthly billing only, it's simpler to support.",
        text: 'Can you send the revised proposal to the client by Friday?',
      },
    },
    { id: 'q1', context: { by: 'claude', before: 'I will send the proposal by Friday.', text: 'What is the launch date?' } },
    // The decision had no line saved: the closest is found, and kept.
    {
      id: 'd1',
      context: {
        by: 'person',
        text: "Let's launch with monthly billing only, it's simpler to support.",
        after: 'Can you send the revised proposal to the client by Friday?',
      },
    },
  ])
  expect(trackerIn(saved).decisions[0]?.quote).toEqual({
    by: 'person',
    text: "Let's launch with monthly billing only, it's simpler to support.",
  })
})

test('the open row shows the line between its dim neighbours, and ▾ closes it', async ($, on) => {
  const saved = new Map<string, unknown>([
    ['tracker', stored(SAMPLE)],
    ['expanded', { id: 'a1', context: { by: 'person', before: 'Before it.', text: 'The line.', after: 'After it.' } }],
  ])
  seat(on, saved)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^You:/ }))?.text).toBe('You: Before it. The line. After it.')
    // Not bold, which read as confusing; its dim neighbours set it apart, and the
    // whole quote is smaller and in italics.
    const quote = await ui.find({ type: 'Text', text: /^You:/ })
    expect(quote?.props).toMatchObject({ italic: true, size: 'footnote' })
    // Its styled runs are the dim lead and neighbours; the line itself is plain.
    expect(runs(quote).map(run => run.props)).toEqual([{ dimColor: true }, { dimColor: true }, { dimColor: true }])
    expect(JSON.stringify(runs(quote))).not.toContain('The line.')
    expect((await ui.find({ key: 'go:a1' }))?.text).toBe('▾')
    expect((await ui.find({ key: 'go:a2' }))?.text).toBe('▸')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'go:a1' })
  expect(saved.get('expanded')).toBe(null)
  await ui.unmount()

  saved.set('expanded', { id: 'd2' })
  const missing = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await missing.find({ type: 'Text', text: "Couldn't find where this came up in the conversation." })).toBeDefined()
  await missing.unmount()
})

test('the line an item came from is found with its neighbours', () => {
  const said = (role: 'user' | 'assistant', text: string, toolResults?: []) => ({ role, text, toolUses: [], toolResults })
  const messages = [
    said('assistant', 'Try sending: "Can you draft the FAQ by Friday?"'),
    said('user', '<system-reminder>draft the FAQ by Friday</system-reminder>'),
    said('user', 'Weekly billing it is. Can you draft the FAQ by Friday? Thanks.'),
    said('user', '', []),
    said('assistant', 'I drafted the FAQ.'),
  ]

  // With no line saved: the person's words beat Claude's earlier suggestion of
  // them, a tag-led reminder doesn't count, and the sentences either side come too.
  expect(findContext(messages, 'Draft the FAQ by Friday')).toEqual({
    by: 'person',
    before: 'Weekly billing it is.',
    text: 'Can you draft the FAQ by Friday?',
    after: 'Thanks.',
  })
  expect(findContext(messages, 'Weekly billing')).toEqual({
    by: 'person',
    text: 'Weekly billing it is.',
    after: 'Can you draft the FAQ by Friday?',
  })
  // A saved line is found where its speaker said it.
  expect(findContext(messages, 'Draft the FAQ', { by: 'claude', text: 'I drafted the FAQ.' })).toEqual({
    by: 'claude',
    text: 'I drafted the FAQ.',
  })
  // Fewer than half the words in any one sentence: nothing is claimed.
  expect(findContext(messages, 'Book the venue for the offsite party')).toBeUndefined()
})

test('an unticked item is ticked again when the conversation says so; a locked one keeps its details', () => {
  const t: Tracker = {
    actions: [
      { id: 'a1', text: 'Unticked by hand', status: 'open' },
      { id: 'a2', text: 'Edited by hand', status: 'open', locked: true },
      { id: 'a3', text: 'Already done', status: 'done', doneOn: '2026-10-29' },
    ],
    questions: [{ id: 'q1', text: 'Reopened question', status: 'open' }],
    decisions: [],
  }
  const changes = parseChanges(
    '{"done":[{"id":"a1","how":"you finished it"},{"id":"a3"}],"resolved":[{"id":"q1","answer":"Yes"}],' +
      '"updates":[{"id":"a2","owner":"me","due":"2026-11-09"}]}',
  )
  expect(changes).toBeDefined()
  if (changes === undefined) return

  expect(applyChanges(t, changes, '2026-10-31')).toEqual({
    actions: [
      { id: 'a1', text: 'Unticked by hand', status: 'done', doneOn: '2026-10-31', doneNote: 'you finished it' },
      // A locked item gets no owner or due date from the updater.
      { id: 'a2', text: 'Edited by hand', status: 'open', locked: true },
      // A done item keeps its first date.
      { id: 'a3', text: 'Already done', status: 'done', doneOn: '2026-10-29' },
    ],
    questions: [{ id: 'q1', text: 'Reopened question', status: 'resolved', answer: 'Yes', resolvedOn: '2026-10-31' }],
    decisions: [],
  })
})

test('a sidequest the updater suggests gets its own section, which shows only when there is one', async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 10, 2, 9).getTime() })

  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await before.find({ type: 'Text', text: 'Sidequests' })).toBeUndefined()
  await before.unmount()

  saved.set(
    'tracker',
    stored({
      ...SAMPLE,
      sidequests: [
        { id: 's1', text: 'Set up a status page', why: 'helps support during launch', status: 'open' },
        { id: 's2', text: 'Check the pricing page on mobile', status: 'done', doneOn: '2026-10-31', doneNote: 'you checked it' },
      ],
    }),
  )
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('5 open · 3 done · 3 decisions · 1 sidequest')
    expect(await ui.find({ type: 'Text', text: 'Sidequests' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Set up a status page/ }))?.text).toBe(
      'Set up a status page (helps support during launch)',
    )
    expect((await ui.find({ type: 'Text', text: /^Check the pricing page/ }))?.text).toBe(
      'Check the pricing page on mobile (done Oct 31, you checked it)',
    )
    await ui.unmount()
  }

  // Its checkbox ticks it like an action item's.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tick:s1' })
  expect(trackerIn(saved).sidequests?.[0]).toEqual({
    id: 's1',
    text: 'Set up a status page',
    why: 'helps support during launch',
    status: 'done',
    doneOn: '2026-11-02',
  })
  await ui.unmount()
})

test('the updater adds at most one sidequest a reply, none repeating an action item, and ticks them off', () => {
  const changes = parseChanges(
    JSON.stringify({
      sidequests: [
        { text: 'send revised proposal to client', why: 'repeats an action item' },
        { text: 'Set up a status page', why: 'helps support during launch', from: 'claude', quote: 'Launch is close.' },
        { text: 'Write a launch checklist' },
      ],
    }),
  )
  expect(changes).toBeDefined()
  if (changes === undefined) return

  // The first suggestion repeats an action item, so this reply adds none:
  // one a reply at most, and only the first is weighed.
  expect(applyChanges(SAMPLE, changes, '2026-10-31').sidequests).toBeUndefined()

  const fresh = parseChanges(JSON.stringify({ sidequests: changes.sidequests.slice(1) }))
  if (fresh === undefined) return
  const added = applyChanges(SAMPLE, fresh, '2026-10-31')
  expect(added.sidequests).toEqual([
    {
      id: 's1',
      text: 'Set up a status page',
      why: 'helps support during launch',
      status: 'open',
      quote: { by: 'claude', text: 'Launch is close.' },
    },
  ])
  expect(buildPrompt(added, '<person>hi</person>', new Date(2026, 9, 31, 12).getTime())).toContain(
    '- sidequest s1 [open] Set up a status page',
  )

  const ticked = parseChanges('{"done":[{"id":"s1","how":"Claude set it up"}]}')
  if (ticked === undefined) return
  expect(applyChanges(added, ticked, '2026-11-01').sidequests?.[0]).toMatchObject({
    status: 'done',
    doneOn: '2026-11-01',
    doneNote: 'Claude set it up',
  })
})

// Runs `/tracker <args>` as the person sending it from the message box, the
// model reading their words as `reply`.
function aCommand(on: On, saved: Map<string, unknown>, reply: string) {
  const prompts: string[] = []
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('command.run', () => ({ text: 'the engine' }))

  return {
    prompts,
    run: ($: Engine, args: string) =>
      $.command.run({ command: 'tracker', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }),
  }
}

test('/tracker add puts the item on the list named, with the details read from the words, locked', async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  const command = aCommand(on, saved, '{"text":"Send the deck to Dana","owner":"me","due":"2026-11-06","reason":"ignored here"}')

  const said = await command.run($, 'add action: Send the deck to Dana by Friday')
  expect(said.text).toBe('Added to Action items: Send the deck to Dana (owner: me, due: Nov 6) [a6]')
  expect(command.prompts[0]).toContain('Today is Saturday, 2026-10-31.')
  expect(command.prompts[0]).toContain('Send the deck to Dana by Friday')
  expect(trackerIn(saved).actions.at(-1)).toEqual({
    id: 'a6',
    text: 'Send the deck to Dana',
    owner: 'me',
    due: '2026-11-06',
    status: 'open',
    locked: true,
  })

  // No list named is an action item; a decision keeps a reason, not an owner.
  await command.run($, 'add Send the deck to Dana')
  expect(trackerIn(saved).actions).toHaveLength(SAMPLE.actions.length + 2)
  await command.run($, 'add decision: ship on Friday')
  expect(trackerIn(saved).decisions.at(-1)).toEqual({
    id: 'd4',
    text: 'Send the deck to Dana',
    decidedOn: '2026-10-31',
    reason: 'ignored here',
  })
})

test('/tracker edit rewrites an item exactly as typed, clearing what was left out, and locks it', async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  const command = aCommand(on, saved, '{"text":"Send the final proposal to client","due":"2026-11-09"}')

  const said = await command.run($, 'edit a1 Send the final proposal to client (due: Nov 9)')
  expect(said.text).toBe('Updated action items: Send the final proposal to client (due: Nov 9)')
  expect(trackerIn(saved).actions[0]).toEqual({
    id: 'a1',
    text: 'Send the final proposal to client',
    due: '2026-11-09',
    status: 'open',
    locked: true,
  })
  expect((await command.run($, 'edit a99 nothing')).text).toBe("There's no item a99 in the tracker.")
  expect((await command.run($, 'fly')).text).toMatch(/^Use \/tracker/)
})

test('+ by a heading and Edit in an open row start the command in the message box', async ($, on) => {
  const saved = new Map<string, unknown>([
    ['tracker', stored(SAMPLE)],
    ['expanded', { id: 'a1' }],
  ])
  seat(on, saved)
  const fills = messageBox(on, '', true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'add:question' })
  await ui.press({ key: 'edit:a1' })
  expect(fills).toEqual([
    { text: '/tracker add question: ', mode: 'replace' },
    { text: '/tracker edit a1 Send revised proposal to client (owner: me, due: Nov 7)', mode: 'replace' },
  ])
  await ui.unmount()
})

test('Dismiss moves an item to a collapsed Dismissed group, where Restore brings it back', async ($, on) => {
  const saved = new Map<string, unknown>([
    ['tracker', stored(SAMPLE)],
    ['expanded', { id: 'q2' }],
  ])
  seat(on, saved)

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.press({ key: 'dismiss:q2' })
  expect(trackerIn(saved).questions[1]?.dismissed).toBe(true)
  expect(saved.get('expanded')).toBe(null)
  await first.unmount()

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Out of its list and the counts; under a closed Dismissed group.
  expect((await after.find({ type: 'Text', text: /open ·/ }))?.text).toBe('4 open · 3 done · 3 decisions')
  expect(await after.find({ type: 'Text', text: 'Does the free tier need a seat limit?' })).toBeUndefined()
  expect((await after.find({ key: 'dismissed' }))?.text).toBe('▸ Dismissed (1)')
  await after.press({ key: 'dismissed' })
  await after.unmount()

  const open = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await open.find({ key: 'dismissed' }))?.text).toBe('▾ Dismissed (1)')
  await open.press({ key: 'restore:q2' })
  expect(trackerIn(saved).questions[1]).toEqual(SAMPLE.questions[1])
  await open.unmount()
})

test('the updater changes nothing on a dismissed item and adds none like it again', () => {
  const t = dismiss(SAMPLE, 'a2')
  const changes = parseChanges(
    '{"actions":[{"text":"Set up the Stripe test account"}],"done":[{"id":"a2"}],"updates":[{"id":"a2","due":"2026-11-09"}]}',
  )
  if (changes === undefined) return

  expect(applyChanges(t, changes, '2026-10-31')).toEqual(t)
  expect(buildPrompt(t, '<person>hi</person>', 0)).toContain('- action a2 [open, dismissed] Set up the Stripe test account')
  expect(restore(t, 'a2')).toEqual(SAMPLE)
})

test("the person's words are read into the fields their item's list has", () => {
  const reply = '{"text":"Send the deck","owner":"Dana","due":"2026-11-06","reason":"r","why":"w"}'

  expect(parseEntry('action', reply, 'x')).toEqual({ text: 'Send the deck', owner: 'Dana', due: '2026-11-06' })
  expect(parseEntry('question', reply, 'x')).toEqual({ text: 'Send the deck' })
  expect(parseEntry('decision', reply, 'x')).toEqual({ text: 'Send the deck', reason: 'r' })
  expect(parseEntry('sidequest', reply, 'x')).toEqual({ text: 'Send the deck', why: 'w' })
  // Nothing usable from the model: the words as typed.
  expect(parseEntry('action', undefined, '  Send   the deck by Friday ')).toEqual({ text: 'Send the deck by Friday' })
  expect(editLine('action', { text: 'Send the deck', owner: 'me', due: '2026-11-07' })).toBe('Send the deck (owner: me, due: Nov 7)')
  expect(add(SAMPLE, 'sidequest', { text: 'Check mobile', why: 'half of traffic' }, '2026-10-31').tracker.sidequests).toEqual([
    { id: 's1', text: 'Check mobile', status: 'open', why: 'half of traffic' },
  ])
  expect(edit(SAMPLE, 'd1', { text: 'Monthly billing only' }).decisions[0]).toEqual({
    id: 'd1',
    text: 'Monthly billing only',
    decidedOn: '2026-10-29',
  })
})

function savedFile(saved: Map<string, unknown>): Tracker | undefined {
  const text = disks.get(saved)?.get(SAVED_AT)

  return text === undefined ? undefined : decode(text)?.tracker
}

test("every change is saved to this conversation's own file", async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 10, 2, 9).getTime() })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'tick:a1' })
  expect(savedFile(saved)?.actions[0]).toMatchObject({ id: 'a1', status: 'done', doneOn: '2026-11-02' })
  await ui.unmount()
})

// Starts the session as the engine does: the command registered, the pane placed.
function starting(on: On, saved: Map<string, unknown>) {
  seat(on, saved)
  on('command.register', () => ({ value: { command: 'tracker' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  return ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

const OTHER: Tracker = { actions: [{ id: 'a1', text: 'Book the venue', status: 'open' }], questions: [], decisions: [] }

test('a conversation picks up its saved tracker when it starts or resumes', async ($, on) => {
  const saved = new Map<string, unknown>([
    ['tracker', stored(SAMPLE)],
    ['loadedFor', 'conv-0'],
  ])
  const start = starting(on, saved)
  disks.get(saved)?.set(SAVED_AT, encode({ version: 1, conversation: 'conv-1', savedAt: '', isClosed: true, tracker: OTHER }))

  await start($)
  expect(trackerIn(saved)).toEqual(OTHER)
  expect(saved.get('isClosed')).toBe(true)
  expect(saved.get('loadedFor')).toBe('conv-1')
})

test('a hot reload keeps what the session holds', async ($, on) => {
  const saved = new Map<string, unknown>([
    ['tracker', stored(SAMPLE)],
    ['loadedFor', 'conv-1'],
  ])
  const start = starting(on, saved)
  disks.get(saved)?.set(SAVED_AT, encode({ version: 1, conversation: 'conv-1', savedAt: '', isClosed: false, tracker: OTHER }))

  await start($)
  expect(trackerIn(saved)).toEqual(SAMPLE)
})

test('the session that built the mod keeps its tracker and saves it; another conversation with none starts empty', async ($, on) => {
  const built = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  const start = starting(on, built)

  await start($)
  expect(trackerIn(built)).toEqual(SAMPLE)
  expect(savedFile(built)).toEqual(SAMPLE)
  expect(built.get('loadedFor')).toBe('conv-1')

  // The same session state, moved to a conversation with no file (a /clear).
  built.set('loadedFor', 'conv-0')
  disks.get(built)?.clear()
  await start($)
  expect(trackerIn(built)).toEqual({ actions: [], questions: [], decisions: [] })
})

test('a saved file that is not the mod\'s is ignored', () => {
  expect(decode('not json')).toBeUndefined()
  expect(decode('{"version":2,"tracker":{"actions":[],"questions":[],"decisions":[]}}')).toBeUndefined()
  expect(decode('{"version":1,"tracker":{"actions":"x","questions":[],"decisions":[]}}')).toBeUndefined()
  expect(decode(encode({ version: 1, conversation: 'c', savedAt: 't', isClosed: false, tracker: SAMPLE }))?.tracker).toEqual(SAMPLE)
})

test('Scan earlier messages reads the conversation so far, a stretch at a time, and adds what it settled', async ($, on) => {
  const saved = new Map<string, unknown>()
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
  const prompts: string[] = []
  let finished!: () => void
  const done = new Promise<void>(resolve => {
    finished = resolve
  })
  watchers.get(saved)?.push((key, value) => {
    if (key === 'note' && typeof value === 'string' && value.startsWith('Scan done')) finished()
  })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Can you draft the FAQ by Friday?', toolUses: [] },
      { role: 'assistant', text: 'Yes, by Friday.', toolUses: [] },
    ],
  }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: '{"actions":[{"text":"Draft the FAQ","owner":"Claude","due":"2026-11-06"}]}', usage: USAGE } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scan' })
  await done
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('earlier stretch of the conversation')
  expect(trackerIn(saved).actions).toEqual([{ id: 'a1', text: 'Draft the FAQ', owner: 'Claude', due: '2026-11-06', status: 'open' }])
  expect(saved.get('note')).toBe('Scan done: added 1 item from earlier messages.')
  await ui.unmount()
})

test('the scan reads prompts and replies only, in stretches cut between messages', () => {
  const said = (role: 'user' | 'assistant', text: string, toolResults?: []) => ({ role, text, toolUses: [], toolResults })
  const messages = [
    said('user', 'a'.repeat(30)),
    said('user', '', []),
    said('user', '<system-reminder>skip</system-reminder>'),
    said('assistant', 'b'.repeat(30)),
    said('assistant', 'c'.repeat(30)),
  ]

  const stretches = earlierStretches(messages, 100)
  expect(stretches).toHaveLength(2)
  expect(stretches[0]).toBe(`<person>\n${'a'.repeat(30)}\n</person>\n<claude>\n${'b'.repeat(30)}\n</claude>`)
  expect(stretches[1]).toBe(`<claude>\n${'c'.repeat(30)}\n</claude>`)
})

test("a helper agent's turn fills its own tracker, titled with its task, and leaves the main lists alone", async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
  const prompts: string[] = []
  let finished!: () => void
  const done = new Promise<void>(resolve => {
    finished = resolve
  })
  watchers.get(saved)?.push((key, value) => {
    if (key === 'tracker' && (value as { value: Tracker }).value.side !== undefined) finished()
  })
  const asked: unknown[] = []
  on('session.messages', ($, e) => {
    asked.push(e)

    return {
      value: [
        { role: 'user', text: 'Review the auth code and list the risks.', toolUses: [] },
        { role: 'assistant', text: 'I will fix the token check. Should sessions expire after a day?', toolUses: [] },
      ],
    }
  })
  on('agent.list', () => ({
    value: [{ id: 'agent-1', description: 'Review the auth code', type: 'general-purpose', status: 'completed' }],
  }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: '{"actions":[{"text":"Fix the token check","owner":"Claude"}],"questions":[{"text":"Should sessions expire after a day?"}]}',
        usage: USAGE,
      },
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete({
    answer: 'I will fix the token check. Should sessions expire after a day?',
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    agentId: 'agent-1',
  })
  await done

  expect(JSON.stringify(asked[0])).toContain('agent-1')
  expect(prompts[0]).toContain("helper agents at work")
  // An agent's suggested next steps count as action items.
  expect(prompts[0]).toContain('suggested next steps and recommendations')
  const t = trackerIn(saved)
  expect(t.actions).toEqual(SAMPLE.actions)
  expect(t.side).toEqual([
    {
      agent: 'agent-1',
      title: 'Review the auth code',
      tracker: {
        actions: [{ id: 'a1', text: 'Fix the token check', owner: 'Claude', status: 'open' }],
        questions: [{ id: 'q1', text: 'Should sessions expire after a day?', status: 'open' }],
        decisions: [],
      },
    },
  ])
})

test("each helper agent's tracker is a closed line under Helper agents that opens to its items", async ($, on) => {
  const saved = new Map<string, unknown>([
    [
      'tracker',
      stored({
        ...SAMPLE,
        side: [
          {
            agent: 'agent-1',
            title: 'Review the auth code',
            tracker: {
              actions: [{ id: 'a1', text: 'Fix the token check', owner: 'Claude', status: 'open' }],
              questions: [{ id: 'q1', text: 'Should sessions expire after a day?', status: 'open' }],
              decisions: [],
            },
          },
          { agent: 'agent-2', title: 'Nothing yet', tracker: { actions: [], questions: [], decisions: [] } },
        ],
      }),
    ],
  ])
  seat(on, saved)
  mock.clock(on, { now: new Date(2026, 10, 2, 9).getTime() })

  const closed = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await closed.find({ type: 'Text', text: 'Helper agents' })).toBeDefined()
  expect((await closed.find({ key: 'side:agent-1' }))?.text).toBe('▸ Review the auth code (2 open)')
  // An agent with nothing tracked isn't listed; the main counts leave agents out.
  expect(await closed.find({ key: 'side:agent-2' })).toBeUndefined()
  expect((await closed.find({ type: 'Text', text: /open ·/ }))?.text).toBe('5 open · 3 done · 3 decisions')
  expect(await closed.find({ type: 'Text', text: /^Fix the token check/ })).toBeUndefined()
  await closed.press({ key: 'side:agent-1' })
  expect(saved.get('openSides')).toEqual(['agent-1'])
  await closed.unmount()

  const open = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await open.find({ key: 'side:agent-1' }))?.text).toBe('▾ Review the auth code (2 open)')
  expect((await open.find({ type: 'Text', text: /^Fix the token check/ }))?.text).toBe('Fix the token check (owner: Claude)')
  await open.press({ key: 'side-tick:agent-1:a1' })
  expect(trackerIn(saved).side?.[0]?.tracker.actions[0]).toMatchObject({ status: 'done', doneOn: '2026-11-02' })
  // The main list's a1 is another item, untouched.
  expect(trackerIn(saved).actions[0]).toEqual(SAMPLE.actions[0])
  await open.unmount()
})

test("each section's Done line folds its finished items away and shows them again", async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  seat(on, saved)

  const shown = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await shown.find({ key: 'done:action' }))?.text).toBe('▾ Done (2)')
  expect((await shown.find({ key: 'done:question' }))?.text).toBe('▾ Done (1)')
  // No Done line where nothing can be finished, or nothing is.
  expect(await shown.find({ key: 'done:decision' })).toBeUndefined()
  expect(await shown.find({ type: 'Text', text: /^Draft pricing page copy/ })).toBeDefined()
  await shown.press({ key: 'done:action' })
  expect(saved.get('hiddenDone')).toEqual(['action'])
  await shown.unmount()

  const folded = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await folded.find({ key: 'done:action' }))?.text).toBe('▸ Done (2)')
  expect(await folded.find({ type: 'Text', text: /^Draft pricing page copy/ })).toBeUndefined()
  // Open items stay; the other sections keep theirs shown.
  expect(await folded.find({ type: 'Text', text: /^Send revised proposal/ })).toBeDefined()
  expect(await folded.find({ type: 'Text', text: /^Stripe or Paddle/ })).toBeDefined()
  await folded.press({ key: 'done:action' })
  expect(saved.get('hiddenDone')).toEqual([])
  await folded.unmount()
})

test('the updater fills in a title and goal once, and every merge keeps the rest of the tracker', () => {
  const side = [{ agent: 'agent-1', title: 'Review', tracker: { actions: [], questions: [], decisions: [] } }]
  const changes = parseChanges('{"title":"Pricing launch","goal":"Launch paid plans by November."}')
  if (changes === undefined) return

  const framed = applyChanges({ ...SAMPLE, side }, changes, '2026-10-31')
  expect(framed.title).toBe('Pricing launch')
  expect(framed.goal).toBe('Launch paid plans by November.')
  // Helper agents' trackers survive a main update.
  expect(framed.side).toEqual(side)
  // A title or goal already there stands.
  const again = parseChanges('{"title":"Something else","goal":"Another goal."}')
  if (again === undefined) return
  expect(applyChanges(framed, again, '2026-10-31')).toMatchObject({ title: 'Pricing launch', goal: 'Launch paid plans by November.' })
  // The person's edits keep them too.
  expect(dismiss(framed, 'a1')).toMatchObject({ title: 'Pricing launch', side })
  expect(edit(framed, 'q1', { text: 'When do we launch?' })).toMatchObject({ goal: 'Launch paid plans by November.', side })
  expect(buildPrompt(framed, '<person>hi</person>', 0)).toContain('Title: Pricing launch\nGoal: Launch paid plans by November.')
})

test('the title and goal sit at the top, set by /tracker title and /tracker goal', async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  const command = aCommand(on, saved, '{}')
  const fills = messageBox(on, '', true)

  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await before.find({ type: 'Text', text: 'Untitled conversation' })).toBeDefined()
  expect((await before.find({ type: 'Text', text: /^Goal:/ }))?.text).toBe('Goal: not clear yet')
  await before.press({ key: 'set:title' })
  expect(fills).toEqual([{ text: '/tracker title ', mode: 'replace' }])
  await before.unmount()

  expect((await command.run($, 'title Pricing launch')).text).toBe('Set the title: Pricing launch')
  expect((await command.run($, 'goal   Launch paid plans by November. ')).text).toBe('Set the goal: Launch paid plans by November.')
  expect(trackerIn(saved)).toMatchObject({ title: 'Pricing launch', goal: 'Launch paid plans by November.' })

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: 'Pricing launch' }))?.props).toMatchObject({ bold: true, size: 'heading' })
  expect((await after.find({ type: 'Text', text: /^Goal:/ }))?.text).toBe('Goal: Launch paid plans by November.')
  await after.unmount()

  expect((await command.run($, 'goal')).text).toBe('Cleared the goal.')
  expect(trackerIn(saved).goal).toBeUndefined()
})

test('where no pane can draw (a cloud session), /tracker answers with the tracker as text', async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored({ ...SAMPLE, title: 'Pricing launch', goal: 'Launch paid plans.' })]])
  const command = aCommand(on, saved, '{}')
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))

  const said = (await command.run($, '')).text ?? ''
  expect(said.split('\n').slice(0, 6)).toEqual([
    'Pricing launch',
    'Goal: Launch paid plans.',
    '5 open · 3 done · 3 decisions',
    '',
    'Action items',
    '☐ Send revised proposal to client (owner: me, due: Nov 7) [a1]',
  ])
  expect(said).toContain('☑ Draft pricing page copy (done Oct 30) [a5]')
  expect(said).toContain('✓ Stripe or Paddle for payments? (done Oct 30, Stripe, since the account already exists) [q3]')
  expect(said).toContain('Oct 29: Launch with monthly billing only (simpler to support) [d1]')
  // /tracker show prints it anywhere.
  expect((await command.run($, 'show')).text).toBe(said)
})

test('the band stays out of the way while the pane is open', async ($, on) => {
  seat(on, new Map())
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ key: 'show' })).toBeUndefined()
  await ui.unmount()
})

test('once the pane is closed the band offers it back, on every surface', async ($, on) => {
  const saved = new Map<string, unknown>([['tracker', stored(SAMPLE)]])
  const opened: string[] = []
  seat(on, saved)
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    saved.set('isClosed', true)
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ key: 'show' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /open ·/ }))?.text).toBe('5 open · 3 done · 3 decisions')
    await ui.press({ key: 'show' })
    expect(saved.get('isClosed')).toBe(false)
    // This stand-in state redraws nobody on a write, as the band that drew
    // nothing went undrawn in the app: the mod's own redraw takes it down.
    expect(await ui.find({ key: 'show' })).toBeUndefined()
    await ui.unmount()
  }
  expect(opened).toEqual(['tracker', 'tracker', 'tracker', 'tracker'])
})
