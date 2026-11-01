import type { Tracker } from '../types'

// Each conversation's tracker is kept in a file of its own, named by the
// conversation's id, which a resumed conversation keeps: under the home
// folder, so it outlives the session and any reinstall of the mod.
export type Saved = { version: 1; conversation: string; savedAt: string; isClosed: boolean; tracker: Tracker }

export function savedPath(home: string | undefined, pluginRoot: string, conversation: string): string {
  const folder = home === undefined || home === '' ? `${pluginRoot}/data` : `${home}/.claude/conversation-tracker`

  return `${folder}/${conversation.replace(/[^\w.-]/g, '_')}.json`
}

export function encode(saved: Saved): string {
  return `${JSON.stringify(saved, null, 2)}\n`
}

// A saved file as read back; undefined when it isn't one this mod wrote.
export function decode(text: string): Saved | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const body = raw as Record<string, unknown>
  const t = body.tracker as Record<string, unknown> | undefined
  const isList = (value: unknown) => Array.isArray(value)
  if (body.version !== 1 || typeof t !== 'object' || t === null) return undefined
  if (!isList(t.actions) || !isList(t.questions) || !isList(t.decisions)) return undefined
  if (t.sidequests !== undefined && !isList(t.sidequests)) return undefined

  return {
    version: 1,
    conversation: typeof body.conversation === 'string' ? body.conversation : '',
    savedAt: typeof body.savedAt === 'string' ? body.savedAt : '',
    isClosed: body.isClosed === true,
    tracker: t as Tracker,
  }
}
