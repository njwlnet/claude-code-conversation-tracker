import type { SessionMessage } from 'claude-code'

import type { Quote } from '../types'

const MAX_QUOTE = 160
const MAX_AROUND = 200

// The line an item came from, with the sentences either side of it in the
// same message.
export type Context = Quote & { before?: string; after?: string }

// Words too common to tell one sentence from another.
const COMMON = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'can', 'will', 'with', 'this', 'that', 'what', 'who',
  'how', 'when', 'from', 'into', 'about', 'should', 'would', 'could', 'does', 'did', 'has', 'have', 'its', 'our',
  'all', 'any', 'one', 'use', 'get', 'let', 'lets', 'also', 'just', 'need', 'needs', 'some', 'than', 'then',
])

// Each word cut to its first five letters, so "drafting" meets "draft".
function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => word.length >= 3 && !COMMON.has(word))
    .map(word => word.slice(0, 5))
}

function plain(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ')
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '')
}

// The person's prompts and Claude's replies, each as its sentences.
function said(messages: readonly SessionMessage[]): { by: Quote['by']; lines: string[] }[] {
  return messages.flatMap(message => {
    const isPrompt = message.role === 'user' && (message.toolResults ?? []).length === 0
    // Text the engine adds beside a prompt (reminders, notices) opens with a tag.
    if (!(isPrompt || message.role === 'assistant') || message.text.trimStart().startsWith('<')) return []

    return [{ by: isPrompt ? ('person' as const) : ('claude' as const), lines: sentences(message.text) }]
  })
}

function around(by: Quote['by'], lines: string[], at: number): Context {
  const before = lines[at - 1]
  const after = lines[at + 1]

  return {
    by,
    text: (lines[at] ?? '').slice(0, MAX_QUOTE),
    ...(before === undefined ? {} : { before: before.slice(-MAX_AROUND) }),
    ...(after === undefined ? {} : { after: after.slice(0, MAX_AROUND) }),
  }
}

// Where in the conversation an item came from, with the sentence either side.
// With a line saved, the sentence holding it (the speaker's own first). With
// none, the sentence sharing the most of the item's words: of equals, the
// person's beats Claude's (Claude may have suggested the very words), then the
// earliest, as an item is made where it first comes up; none when no sentence
// shares at least half of them.
export function findContext(messages: readonly SessionMessage[], itemText: string, saved?: Quote): Context | undefined {
  const all = said(messages)

  if (saved !== undefined) {
    const wanted = plain(saved.text)
    for (const speaker of [saved.by, saved.by === 'person' ? 'claude' : 'person']) {
      for (const { by, lines } of all) {
        if (by !== speaker) continue
        const at = lines.findIndex(line => plain(line).includes(wanted))
        if (at !== -1) return around(by, lines, at)
      }
    }
  }

  const wanted = new Set(words(itemText))
  if (wanted.size === 0) return undefined

  let best: { score: number; context: Context } | undefined
  for (const { by, lines } of all) {
    for (let at = 0; at < lines.length; at += 1) {
      const score = new Set(words(lines[at] ?? '').filter(word => wanted.has(word))).size
      const isBetter =
        best === undefined
          ? score > 0
          : score > best.score || (score === best.score && by === 'person' && best.context.by === 'claude')
      if (isBetter) best = { score, context: around(by, lines, at) }
    }
  }

  return best !== undefined && best.score * 2 >= wanted.size ? best.context : undefined
}
