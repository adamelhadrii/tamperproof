// Pure per-turn and per-session bookkeeping, the receipt, and the Stop gate.
import type { Track } from './analyze'
import { claimsGreen, isLenient } from './words'

export type Item = { file: string; summary: string }
export type Ask = Item & { track?: Track }
/** A change that went through without a question, held until its tool call reports back. */
export type Pending = {
  file: string
  summary?: string
  /** Set when the change would have asked: the user wording allowed it, or the file was approved earlier. */
  as?: 'requested' | 'approved'
  editedAfterRed: boolean
  kinds: string[]
  track?: Track
}
export type Turn = {
  lenient: boolean
  red: boolean
  passedSinceRefusal: boolean
  stopBlocked: boolean
  refused: Item[]
  approved: Item[]
  requested: Item[]
  editedAfterRed: string[]
  suppressed: { file: string; kinds: string[] }[]
  approvedFiles: Set<string>
  asks: Map<string, Ask>
  notes: Map<string, Pending>
}
export type Tally = {
  refused: number
  approved: number
  requested: number
  editedAfterRed: Set<string>
  suppressions: number
  first: Map<string, number>
  now: Map<string, number>
}

export function freshTurn(prompt: string): Turn {
  return {
    lenient: isLenient(prompt),
    red: false,
    passedSinceRefusal: false,
    stopBlocked: false,
    refused: [],
    approved: [],
    requested: [],
    editedAfterRed: [],
    suppressed: [],
    approvedFiles: new Set(),
    asks: new Map(),
    notes: new Map(),
  }
}

export function freshTally(): Tally {
  return { refused: 0, approved: 0, requested: 0, editedAfterRed: new Set(), suppressions: 0, first: new Map(), now: new Map() }
}

export const nudge = (kinds: string[], rel: string): string =>
  `tamperproof note: this edit adds ${kinds.join(', ')} in ${rel}. Prefer fixing the underlying error; if you keep it, tell the user why.`

function commit(tally: Tally, track: Track | undefined): void {
  if (track === undefined) return
  if (!tally.first.has(track.file)) tally.first.set(track.file, track.before)
  tally.now.set(track.file, track.after)
}

/**
 * Folds one finished tool call into the turn and the session tally. `id` is the
 * call's tool_use_id, `ok` whether the tool ran without a refusal or error,
 * `isTestRun` whether it was a Bash test command, and `passed` whether that
 * run's tests passed (by default `ok`; a run can exit 0 and still print
 * failures, as `node --test | tail` does). Returns a note for the model when the
 * change added check suppressions.
 */
export function recordOutcome(t: Turn, tally: Tally, id: string | undefined, ok: boolean, isTestRun: boolean, passed: boolean = ok): { nudge?: string } {
  if (isTestRun) {
    t.red = !passed
    if (passed && t.refused.length > 0) t.passedSinceRefusal = true
  }
  if (id === undefined) return {}

  const ask = t.asks.get(id)
  if (ask !== undefined) {
    t.asks.delete(id)
    if (ok) {
      t.approved.push({ file: ask.file, summary: ask.summary })
      t.approvedFiles.add(ask.file)
      tally.approved++
      commit(tally, ask.track)
    } else {
      t.refused.push({ file: ask.file, summary: ask.summary })
      t.passedSinceRefusal = false
      tally.refused++
    }

    return {}
  }

  const note = t.notes.get(id)
  if (note === undefined) return {}
  t.notes.delete(id)
  if (!ok) return {}

  commit(tally, note.track)
  if (note.as !== undefined) {
    const item = { file: note.file, summary: note.summary ?? '' }
    if (note.as === 'requested') {
      t.requested.push(item)
      tally.requested++
    } else {
      t.approved.push(item)
      tally.approved++
    }
  }
  if (note.editedAfterRed) {
    if (!t.editedAfterRed.includes(note.file)) t.editedAfterRed.push(note.file)
    tally.editedAfterRed.add(note.file)
  }
  if (note.kinds.length > 0) {
    t.suppressed.push({ file: note.file, kinds: note.kinds })
    tally.suppressions += note.kinds.length

    return { nudge: nudge(note.kinds, note.file) }
  }

  return {}
}

const MAX = 3
const list = (xs: string[]): string => (xs.length > MAX ? `${xs.slice(0, MAX).join(', ')}, +${xs.length - MAX} more` : xs.join(', '))
const items = (xs: Item[]): string => list(xs.map(i => `${i.file} (${i.summary})`))

/** The one-line note under the answer; empty when nothing happened this turn. */
export function receipt(t: Turn): string {
  const parts: string[] = []
  if (t.refused.length > 0) parts.push(`refused ${t.refused.length} test-weakening change${t.refused.length === 1 ? '' : 's'}: ${items(t.refused)}`)
  if (t.approved.length > 0) parts.push(`you approved ${t.approved.length}: ${items(t.approved)}`)
  if (t.requested.length > 0) parts.push(`allowed ${t.requested.length} because you asked for test changes: ${items(t.requested)}`)
  if (t.editedAfterRed.length > 0) parts.push(`edited after a failing test run: ${list(t.editedAfterRed)}`)
  if (t.suppressed.length > 0) parts.push(`check suppressions added: ${list(t.suppressed.map(s => `${s.file} (${s.kinds.join(', ')})`))}`)

  return parts.join(' · ')
}

/** The Stop-gate message for the model. */
export const stopMessage = (t: Turn): string =>
  `Before you finish: this turn tamperproof refused a change that weakened tests (${[...new Set(t.refused.map(i => i.file))].join(', ')}), and no test run has passed since. Your reply says the tests pass. Run the tests again and report the real result, or tell the user plainly what still fails and why.`

/** True when Claude is about to finish with a green claim right after a refusal and no passing run since. */
export function shouldBlockStop(t: Turn, stopHookActive: boolean, lastMessage: string): boolean {
  return !stopHookActive && !t.stopBlocked && t.refused.length > 0 && !t.passedSinceRefusal && claimsGreen(lastMessage)
}

/** The `/tamperproof` report. */
export function report(tally: Tally, paused: boolean): string {
  const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)
  const tracked = tally.first.size === 0 ? 'none changed yet' : `${sum(tally.first)} → ${sum(tally.now)}`

  return [
    `tamperproof is ${paused ? 'paused' : 'on'}. This session:`,
    `  refused ${tally.refused} · you approved ${tally.approved} · allowed on your request ${tally.requested}`,
    `  test files edited after a failing run: ${tally.editedAfterRed.size}`,
    `  check suppressions added: ${tally.suppressions}`,
    `  assertions in the test files it saw change: ${tracked}`,
    '/tamperproof off pauses it until the session ends; /tamperproof on resumes it.',
  ].join('\n')
}
