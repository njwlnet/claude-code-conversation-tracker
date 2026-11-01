// Dates are ISO calendar days (YYYY-MM-DD); the pane shows them as "Nov 7".

export type ActionItem = {
  id: string
  text: string
  // Set when the person dismisses it: kept, shown only under Dismissed.
  dismissed?: true
  owner?: string
  due?: string
  status: 'open' | 'done'
  doneOn?: string
  // How it got done, after the date: "(done Oct 31, you finished it)".
  doneNote?: string
  // Set once the person edits the item's details by hand: the updater fills in
  // no owner or due date on it. Ticking it still follows the conversation.
  locked?: true
}

export type Question = {
  id: string
  text: string
  dismissed?: true
  status: 'open' | 'resolved'
  answer?: string
  resolvedOn?: string
  locked?: true
}

export type Decision = {
  id: string
  text: string
  dismissed?: true
  reason?: string
  decidedOn: string
}

// A supporting or adjacent to-do the updater suggests unasked, and `why` it
// would help; ticked like an action item.
export type Sidequest = {
  id: string
  text: string
  why?: string
  dismissed?: true
  status: 'open' | 'done'
  doneOn?: string
  doneNote?: string
}

// The four lists an item can be on, and what the person typed for one, as
// read into fields: only those they gave.
export type Kind = 'action' | 'question' | 'decision' | 'sidequest'
export type Entry = { text: string; owner?: string; due?: string; reason?: string; why?: string }


export type Tracker = {
  // What the conversation is about, and what the person wants from it: filled
  // in by the updater once clear, or set by the person; absent until then.
  title?: string
  goal?: string
  actions: ActionItem[]
  questions: Question[]
  decisions: Decision[]
  // Absent on a tracker stored before sidequests existed: read it as none.
  sidequests?: Sidequest[]
  // One small tracker per helper agent this conversation started, by its id,
  // titled with the agent's task. Absent until one has something.
  side?: Side[]
}

export type Side = { agent: string; title: string; tracker: Tracker }

declare module 'claude-code' {
  interface PluginState {
    'conversation-tracker': { tracker: Shaped<Tracker>; isClosed: boolean; note: string | null; replyingTo: string | null; showDismissed: boolean; loadedFor: string | null; openSides: string[]; hiddenDone: Kind[] }
  }
}
