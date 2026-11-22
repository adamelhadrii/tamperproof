import { expect, test } from 'claude-code/testing'

import { freshTally, freshTurn, nudge, receipt, recordOutcome, report, shouldBlockStop, stopMessage } from './state'

const ask = (t: ReturnType<typeof freshTurn>, id: string, file: string, summary = 'removes 1 of 2 assertions') => t.asks.set(id, { file, summary, track: { file, before: 2, after: 1 } })

test('freshTurn reads leniency from the prompt', async () => {
  expect(freshTurn('make the tests pass').lenient).toBe(false)
  expect(freshTurn('update the tests for the new separator').lenient).toBe(true)
})

test('a refused ask is recorded and clears the pass flag', async () => {
  const t = freshTurn('')
  const tally = freshTally()
  ask(t, 'u1', 'a.test.js')
  recordOutcome(t, tally, 'u1', false, false)
  expect(t.refused).toEqual([{ file: 'a.test.js', summary: 'removes 1 of 2 assertions' }])
  expect(tally.refused).toBe(1)
  expect(t.asks.size).toBe(0)
  expect(tally.first.size).toBe(0)
  expect(t.approvedFiles.size).toBe(0)
})

test('an approved ask is remembered per file and committed to the tally', async () => {
  const t = freshTurn('')
  const tally = freshTally()
  ask(t, 'u1', 'a.test.js')
  recordOutcome(t, tally, 'u1', true, false)
  expect(t.approved).toHaveLength(1)
  expect(t.approvedFiles.has('a.test.js')).toBe(true)
  expect(tally.approved).toBe(1)
  expect([...tally.first]).toEqual([['a.test.js', 2]])
  expect([...tally.now]).toEqual([['a.test.js', 1]])
})

test('test runs set red and the passed-since-refusal flag', async () => {
  const t = freshTurn('')
  const tally = freshTally()
  recordOutcome(t, tally, undefined, false, true)
  expect(t.red).toBe(true)
  recordOutcome(t, tally, undefined, true, true)
  expect(t.red).toBe(false)
  expect(t.passedSinceRefusal).toBe(false)

  ask(t, 'u1', 'a.test.js')
  recordOutcome(t, tally, 'u1', false, false)
  recordOutcome(t, tally, undefined, true, true)
  expect(t.passedSinceRefusal).toBe(true)
  ask(t, 'u2', 'b.test.js')
  recordOutcome(t, tally, 'u2', false, false)
  expect(t.passedSinceRefusal).toBe(false)
})

test('a run that exits 0 but printed failures is red and does not count as passing', async () => {
  const t = freshTurn('')
  const tally = freshTally()
  ask(t, 'u1', 'a.test.js')
  recordOutcome(t, tally, 'u1', false, false)
  recordOutcome(t, tally, undefined, true, true, false)
  expect(t.red).toBe(true)
  expect(t.passedSinceRefusal).toBe(false)
  recordOutcome(t, tally, undefined, true, true, true)
  expect(t.red).toBe(false)
  expect(t.passedSinceRefusal).toBe(true)
})

test('notes: suppressions give a nudge, edits after red are kept, failures are dropped', async () => {
  const t = freshTurn('')
  const tally = freshTally()
  t.notes.set('n1', { file: 'src/a.ts', editedAfterRed: false, kinds: ['@ts-ignore', 'eslint-disable'] })
  const out = recordOutcome(t, tally, 'n1', true, false)
  expect(out.nudge).toBe(nudge(['@ts-ignore', 'eslint-disable'], 'src/a.ts'))
  expect(out.nudge).toContain('adds @ts-ignore, eslint-disable in src/a.ts')
  expect(tally.suppressions).toBe(2)

  t.notes.set('n2', { file: 'a.test.js', editedAfterRed: true, kinds: [], track: { file: 'a.test.js', before: 3, after: 3 } })
  expect(recordOutcome(t, tally, 'n2', true, false)).toEqual({})
  expect(t.editedAfterRed).toEqual(['a.test.js'])
  expect(tally.first.get('a.test.js')).toBe(3)

  t.notes.set('n3', { file: 'b.test.js', editedAfterRed: true, kinds: [], track: { file: 'b.test.js', before: 1, after: 0 } })
  recordOutcome(t, tally, 'n3', false, false)
  expect(t.editedAfterRed).toEqual(['a.test.js'])
  expect(tally.first.has('b.test.js')).toBe(false)
})

test('notes: requested and auto-approved changes are counted when they land', async () => {
  const t = freshTurn('')
  const tally = freshTally()
  t.notes.set('r1', { file: 'a.test.js', summary: 'removes 1 of 2 assertions', as: 'requested', editedAfterRed: false, kinds: [] })
  t.notes.set('r2', { file: 'a.test.js', summary: 'adds 1 skip marker', as: 'approved', editedAfterRed: false, kinds: [] })
  recordOutcome(t, tally, 'r1', true, false)
  recordOutcome(t, tally, 'r2', true, false)
  expect(t.requested).toHaveLength(1)
  expect(t.approved).toHaveLength(1)
  expect([tally.requested, tally.approved]).toEqual([1, 1])
})

test('receipt: empty, each part, singular and plural, and the +N more cut', async () => {
  const t = freshTurn('')
  expect(receipt(t)).toBe('')
  t.refused.push({ file: 'slug.test.mjs', summary: 'rewrites 1 existing assertion' })
  t.editedAfterRed.push('stats.test.mjs')
  expect(receipt(t)).toBe('refused 1 test-weakening change: slug.test.mjs (rewrites 1 existing assertion) · edited after a failing test run: stats.test.mjs')

  for (let i = 0; i < 4; i++) t.refused.push({ file: `f${i}.test.js`, summary: 's' })
  t.approved.push({ file: 'a.test.js', summary: 'adds 1 skip marker' })
  t.requested.push({ file: 'b.test.js', summary: 'removes 1 of 2 assertions' })
  t.suppressed.push({ file: 'src/a.ts', kinds: ['@ts-ignore'] })
  expect(receipt(t)).toBe(
    'refused 5 test-weakening changes: slug.test.mjs (rewrites 1 existing assertion), f0.test.js (s), f1.test.js (s), +2 more · ' +
      'you approved 1: a.test.js (adds 1 skip marker) · ' +
      'allowed 1 because you asked for test changes: b.test.js (removes 1 of 2 assertions) · ' +
      'edited after a failing test run: stats.test.mjs · ' +
      'check suppressions added: src/a.ts (@ts-ignore)',
  )
})

test('the Stop gate blocks once, only after a refusal and a green claim', async () => {
  const t = freshTurn('')
  const tally = freshTally()
  expect(shouldBlockStop(t, false, 'All tests pass now.')).toBe(false)
  ask(t, 'u1', 'a.test.js')
  recordOutcome(t, tally, 'u1', false, false)
  expect(shouldBlockStop(t, false, 'All tests pass now.')).toBe(true)
  expect(shouldBlockStop(t, true, 'All tests pass now.')).toBe(false)
  expect(shouldBlockStop(t, false, 'I could not get it green; the tests still fail.')).toBe(false)
  t.stopBlocked = true
  expect(shouldBlockStop(t, false, 'All tests pass now.')).toBe(false)
  t.stopBlocked = false
  recordOutcome(t, tally, undefined, true, true)
  expect(shouldBlockStop(t, false, 'All tests pass now.')).toBe(false)
  expect(stopMessage(t)).toContain('(a.test.js)')
})

test('report prints the session tally', async () => {
  const tally = freshTally()
  tally.refused = 2
  tally.approved = 1
  tally.editedAfterRed.add('a.test.js')
  tally.suppressions = 2
  tally.first.set('a.test.js', 41)
  tally.now.set('a.test.js', 44)
  expect(report(tally, false)).toBe(
    [
      'tamperproof is on. This session:',
      '  refused 2 · you approved 1 · allowed on your request 0',
      '  test files edited after a failing run: 1',
      '  check suppressions added: 2',
      '  assertions in the test files it saw change: 41 → 44',
      '/tamperproof off pauses it until the session ends; /tamperproof on resumes it.',
    ].join('\n'),
  )
  expect(report(freshTally(), true)).toContain('tamperproof is paused.')
  expect(report(freshTally(), true)).toContain('none changed yet')
})
