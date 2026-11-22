import type { EngineInterface, Register } from 'claude-code'

import { applyEdit, familyOf, formattingOnly, isTestPath, judgeTestFile, rustTests, suppressionsAdded } from './analyze'
import type { FileVerdict } from './analyze'
import { isSetupFile, judgeSetup } from './setup'
import { isTestCommand, isTestish, judgeShell, mentionedFiles, testOutputFailed } from './shell'
import { freshTally, freshTurn, receipt, recordOutcome, report, shouldBlockStop, stopMessage } from './state'

const USAGE = 'Usage: /tamperproof [on | off]   (no argument: this session\'s report)'

// Module state: one session at a time. session.start resets it, turn.start refreshes the turn.
let turn = freshTurn('')
let tally = freshTally()
let paused = false
let lastPrompt = ''
// Each test file as the session first saw it, before any change of ours landed (empty when the file did not exist).
const baselines = new Map<string, string>()

// A file this big is generated or data, not a test someone wrote; judging it would only stall the edit.
const MAX_JUDGED = 1_500_000

type Query = { tool: string; input: unknown; tool_use_id?: string }

/** The tool's file path, relative to the project root when it is inside it. */
function relative(p: string, root: string): string {
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p
}

/** The file as the session first saw it; the first sighting is recorded. */
function baseline(rel: string, current: string): string {
  const seen = baselines.get(rel)
  if (seen !== undefined) return seen
  baselines.set(rel, current)

  return current
}

/** Reads the file an Edit or Write is about to change and judges the result. */
async function judge($: EngineInterface, e: Query): Promise<FileVerdict> {
  const root = await $.session.root()
  const input = (e.input ?? {}) as Record<string, unknown>

  if (e.tool === 'Bash') {
    if (typeof input.command !== 'string') return { kind: 'allow' }
    // A `>` or `tee` onto a file that does not exist yet creates it, which weakens nothing.
    const missing = new Set<string>()
    for (const tok of mentionedFiles(input.command)) {
      if (!isTestish(relative(tok, root))) continue
      try {
        await $.fs.read(tok.startsWith('/') ? tok : `${root}/${tok.replace(/^\.\//, '')}`)
      } catch {
        missing.add(tok)
      }
    }
    const verdict = judgeShell(input.command, tok => isTestish(relative(tok, root)), tok => !missing.has(tok))

    return verdict.kind === 'allow' ? { kind: 'allow' } : { kind: 'ask', file: relative(verdict.file, root), summary: verdict.summary, reason: verdict.reason }
  }

  const p = input.file_path
  if (typeof p !== 'string') return { kind: 'allow' }
  const rel = relative(p, root)

  // A new, unreadable or oversized file is allowed: there is nothing to compare with.
  let before: string
  try {
    const read = await $.fs.read(p)
    if (typeof read !== 'string' || read.length > MAX_JUDGED) return { kind: 'allow' }
    before = read
  } catch {
    // Claude is creating this file: whatever it writes is its own, so nothing in it is protected.
    if (e.tool === 'Write' && !baselines.has(rel)) baselines.set(rel, '')

    return { kind: 'allow' }
  }

  let after: string | undefined
  if (e.tool === 'Edit') {
    after = applyEdit(before, String(input.old_string ?? ''), String(input.new_string ?? ''), input.replace_all === true)
  } else if (typeof input.content === 'string') {
    after = input.content
  }
  if (after === undefined || after.length > MAX_JUDGED) return { kind: 'allow' }

  // Only test and setup files are judged, so the formatting check (the costly part) is not run for any other file.
  const rustTest = rel.endsWith('.rs') && /#\[test\]|#\[cfg\(test\)\]/.test(before)
  const judged = isSetupFile(rel) || isTestPath(rel) || rustTest
  if (judged && formattingOnly(before, after, rel.endsWith('.py'))) return { kind: 'allow' }

  if (isSetupFile(rel)) {
    const parts = judgeSetup(rel, before, after)

    return parts.length === 0
      ? { kind: 'allow' }
      : { kind: 'ask', file: rel, summary: parts.join('; '), reason: `${rel}: ${parts.join('; ')}. Weakening the test setup needs the user's yes.` }
  }

  if (isTestPath(rel)) return judgeTestFile(rel, baseline(rel, before), before, after, turn.red)
  if (rustTest) {
    // Production code and unit tests share the file: only the `#[cfg(test)]` module is judged.
    const cfg = before.includes('#[cfg(test)]')
    const part = (t: string): string => rustTests(t, cfg)

    return judgeTestFile(rel, part(baseline(rel, before)), part(before), part(after), turn.red)
  }

  if (familyOf(rel) !== undefined) {
    const kinds = suppressionsAdded(before, after)
    if (kinds.length > 0) return { kind: 'note', file: rel, editedAfterRed: false, kinds }
  }

  return { kind: 'allow' }
}

/** Decides one watched tool call: the ask to raise, or undefined to let the verdict below stand. */
async function review($: EngineInterface, e: Query): Promise<{ decision: 'ask'; reason: string } | undefined> {
  const verdict = await judge($, e)
  const id = e.tool_use_id

  if (verdict.kind === 'allow') {
    if (id !== undefined && verdict.track !== undefined) turn.notes.set(id, { file: verdict.track.file, editedAfterRed: false, kinds: [], track: verdict.track })

    return undefined
  }
  if (verdict.kind === 'note') {
    if (id !== undefined) turn.notes.set(id, { file: verdict.file, editedAfterRed: verdict.editedAfterRed, kinds: verdict.kinds, track: verdict.track })

    return undefined
  }

  const as = turn.lenient ? 'requested' : turn.approvedFiles.has(verdict.file) ? 'approved' : undefined
  if (as !== undefined) {
    if (id !== undefined) {
      turn.notes.set(id, { file: verdict.file, summary: verdict.summary, as, editedAfterRed: turn.red, kinds: [], track: verdict.track })
    }

    return undefined
  }
  if (id !== undefined) turn.asks.set(id, { file: verdict.file, summary: verdict.summary, track: verdict.track })

  return { decision: 'ask', reason: verdict.reason }
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const arg = args.trim()
  if (arg === '') return report(tally, paused)
  if (arg === 'off') {
    paused = true

    return 'tamperproof is paused until this session ends. /tamperproof on resumes it.'
  }
  if (arg === 'on') {
    paused = false

    return 'tamperproof is on.'
  }

  return USAGE
}

async function start($: EngineInterface): Promise<void> {
  turn = freshTurn('')
  tally = freshTally()
  paused = false
  lastPrompt = ''
  baselines.clear()
  await $.command.register({
    name: 'tamperproof',
    description: "Report or pause tamperproof's test-weakening guard for this session",
    argumentHint: '[on | off]',
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await start($)

    return next(e)
  })

  // Only the main loop's own prompts shape a turn: prompts Claude writes for subagents never do.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.text.trim() !== '') lastPrompt = e.text
      // A failing run stays red across turns until a test run passes.
      const red = turn.red
      turn = freshTurn(lastPrompt)
      turn.red = red
    }

    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const v = await next(e)
    if (paused || v.decision === 'deny' || e.op !== undefined || e.isReadOnly === true) return v
    if (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'Bash') return v

    return (await review($, e)) ?? v
  })

  on('tool.call', async ($, e, next) => {
    const out = await next(e)
    const id = e.tool_use_id
    const ok = out.deny === undefined && out.isError !== true
    // A test run that an ask refused never ran, so it says nothing about the tests.
    const ran = e.tool === 'Bash' && isTestCommand(e.command) && !(id !== undefined && turn.asks.has(id))
    // The exit code is not enough: `node --test | tail` exits 0 on failing tests, so read the output too.
    const passed = ok && !(ran && testOutputFailed(out.text ?? ''))
    const { nudge } = recordOutcome(turn, tally, id, ok, ran, passed)
    if (nudge !== undefined && out.deny === undefined) return { ...out, context: [...(out.context ?? []), nudge] }

    return out
  })

  on('classic.Stop', async ($, e, next) => {
    const out = await next(e)
    if (out.block !== undefined) return out
    if (paused || !shouldBlockStop(turn, e.stop_hook_active, e.last_assistant_message ?? '')) return out
    turn.stopBlocked = true

    return { ...out, block: stopMessage(turn) }
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined || paused) return out
    const line = receipt(turn)
    if (line === '') return out

    return { ...out, text: out.text === e.answer ? line : out.text + '\n' + line }
  })

  on('command.run', { command: 'tamperproof' }, async ($, e) => ({ text: await runCommand($, e.args) }))
}
