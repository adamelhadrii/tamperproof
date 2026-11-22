import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const COMMAND = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const TWO = "test('a', () => {\n  expect(f()).toBe(1)\n  expect(g()).toBe(2)\n})\n"
const ONE = "test('a', () => {\n  expect(f()).toBe(1)\n})\n"

// Every bottom hook is registered before the first `$` call, as the kit requires.
// `bash` is the text a Bash call prints when it does not fail with an exit code.
function bottoms(on: On, files: Record<string, string>, redWhen: () => boolean = () => false, bash: () => string = () => 'ok'): void {
  on('session.root', () => ({ value: '/repo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'tamperproof' } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('classic.Stop', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'Bash') return { result: 'ok', text: 'ok' }
    if (redWhen()) return { isError: true, result: 'Exit code 1', text: 'Exit code 1\nnot ok' }

    return { result: bash(), text: bash() }
  })
}

const edit = (file: string, oldS: string, newS: string) => ({ tool: 'Edit', input: { file_path: file, old_string: oldS, new_string: newS } }) as const

test('an edit that removes 1 of 2 assertions asks, with an exact reason', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const v = await $.tool.check(edit('/repo/a.test.js', '  expect(g()).toBe(2)\n', ''))
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('a.test.js: removes 1 of 2 assertions')
  expect(v.reason).toContain("A weaker test needs the user's yes.")
})

test('an edit that adds a test is allowed', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'add a test', turnId: 't1' })
  const v = await $.tool.check(edit('/repo/a.test.js', '})\n', "})\ntest('b', () => {\n  expect(h()).toBe(3)\n})\n"))
  expect(v.decision).toBe('allow')
})

test('a quote and whitespace reformat through Write is allowed; a new file is allowed', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': "test('a', () => {\n  expect(f()).toBe('x')\n})\n" })
  await $.session.start(START)
  await $.turn.start({ text: 'tidy', turnId: 't1' })
  const fmt = await $.tool.check({ tool: 'Write', input: { file_path: '/repo/a.test.js', content: 'test("a", () => { expect(f()).toBe("x"); });\n' } })
  expect(fmt.decision).toBe('allow')
  const fresh = await $.tool.check({ tool: 'Write', input: { file_path: '/repo/new.test.js', content: 'x' } })
  expect(fresh.decision).toBe('allow')
})

test('a rewrite of a baseline assertion asks with no failing run before it, and a passing run does not excuse it', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const rewrite = edit('/repo/a.test.js', 'toBe(2)', 'toBe(3)')
  const v = await $.tool.check(rewrite)
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('rewrites 1 existing assertion (`expect(g()).toBe(2)` became `expect(g()).toBe(3)`)')
  expect(v.reason).not.toContain('failing test run')

  await $.tool.call({ tool: 'Bash', command: 'node --test' })
  expect((await $.tool.check(rewrite)).decision).toBe('ask')
})

test('an assertion Claude added itself can be corrected after a failing run, a baseline one cannot', async ($, on) => {
  const files: Record<string, string> = { '/repo/a.test.js': TWO }
  bottoms(on, files, () => true)
  await $.session.start(START)
  await $.turn.start({ text: 'add a test for f(5)', turnId: 't1' })
  const add = edit('/repo/a.test.js', 'expect(g()).toBe(2)\n', 'expect(g()).toBe(2)\n  expect(f(5)).toBe(9)\n')
  expect((await $.tool.check(add)).decision).toBe('allow')
  // The edit lands, then the run fails, then Claude corrects its own wrong expectation.
  files['/repo/a.test.js'] = TWO.replace('expect(g()).toBe(2)\n', 'expect(g()).toBe(2)\n  expect(f(5)).toBe(9)\n')
  await $.tool.call({ tool: 'Bash', command: 'node --test' })
  expect((await $.tool.check(edit('/repo/a.test.js', 'toBe(9)', 'toBe(6)'))).decision).toBe('allow')
  expect((await $.tool.check(edit('/repo/a.test.js', 'toBe(2)', 'toBe(3)'))).decision).toBe('ask')
})

test('a test file Claude creates is its own: later edits to it are free', async ($, on) => {
  const files: Record<string, string> = {}
  bottoms(on, files)
  await $.session.start(START)
  await $.turn.start({ text: 'write a test for f', turnId: 't1' })
  const content = "test('f', () => {\n  expect(f()).toBe(1)\n})\n"
  expect((await $.tool.check({ tool: 'Write', input: { file_path: '/repo/n.test.js', content } })).decision).toBe('allow')
  files['/repo/n.test.js'] = content
  expect((await $.tool.check(edit('/repo/n.test.js', 'toBe(1)', 'toBe(2)'))).decision).toBe('allow')
})

test('the baseline is per session: a new session protects what the file holds then', async ($, on) => {
  const files: Record<string, string> = { '/repo/a.test.js': TWO }
  bottoms(on, files)
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const weaken = edit('/repo/a.test.js', 'toBe(2)', 'toBe(3)')
  expect((await $.tool.check(weaken)).decision).toBe('ask')
  files['/repo/a.test.js'] = TWO.replace('toBe(2)', 'toBe(3)')
  // The change landed (say the user approved it); the new text is no longer a baseline assertion.
  expect((await $.tool.check(edit('/repo/a.test.js', 'toBe(3)', 'toBe(4)'))).decision).toBe('allow')
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't2' })
  expect((await $.tool.check(edit('/repo/a.test.js', 'toBe(3)', 'toBe(4)'))).decision).toBe('ask')
})

// [command, what a failing run prints, what a passing run prints]. All exit 0, as `... | tail` does.
const RUNNERS: [string, string, string][] = [
  ['node --version && node --test 2>&1 | tail -80', 'ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ cancelled 0', 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ cancelled 0'],
  ['npm test | tail -20', 'not ok 1 - a\n# pass 2\n# fail 1', '# pass 3\n# fail 0'],
  ['npx jest 2>&1 | tail', 'Tests:       1 failed, 2 passed, 3 total', 'Tests:       3 passed, 3 total'],
  ['npx vitest run | tail', ' Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 4 passed (5)', ' Test Files  2 passed (2)\n      Tests  5 passed (5)'],
  ['pytest -q | tail', 'FAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed, 2 passed in 0.12s', '3 passed in 0.10s'],
  ['go test ./... | tail', '--- FAIL: TestA (0.00s)\nFAIL\nFAIL\texample.com/a\t0.002s', 'ok  \texample.com/a\t0.002s'],
  ['cargo test 2>&1 | tail', 'test a ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored', 'test result: ok. 2 passed; 0 failed; 0 ignored'],
  ['npx mocha | tail', '  2 passing (9ms)\n  1 failing', '  3 passing (9ms)'],
  ['bundle exec rspec | tail', 'Finished in 0.1 seconds\n3 examples, 1 failure', '3 examples, 0 failures'],
  ['bin/rails test | tail', '3 runs, 4 assertions, 1 failures, 0 errors, 0 skips', '3 runs, 4 assertions, 0 failures, 0 errors, 0 skips'],
  ['mvn test | tail', 'Tests run: 3, Failures: 1, Errors: 0, Skipped: 0\nBUILD FAILURE', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\nBUILD SUCCESS'],
  ['dotnet test | tail', 'Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3', 'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3'],
  ['phpunit | tail', 'FAILURES!\nTests: 3, Assertions: 4, Failures: 1.', 'OK (3 tests, 4 assertions)'],
]

test('a test run that exits 0 but prints failures counts as failing, for every runner', async ($, on) => {
  let out = ''
  bottoms(on, { '/repo/a.test.js': TWO }, () => false, () => out)
  await $.session.start(START)
  const claim = { stop_hook_active: false, last_assistant_message: 'All tests pass now.' }
  let n = 0
  for (const [command, failing, passing] of RUNNERS) {
    // A refused weakening, then a run: the Stop gate lets the green claim through only when the run really passed.
    await $.turn.start({ text: 'make the tests pass', turnId: `f${n++}` })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
    out = failing
    await $.tool.call({ tool: 'Bash', command })
    expect(`${command}: ${(await $.classic.Stop(claim)).block !== undefined}`).toBe(`${command}: true`)

    await $.turn.start({ text: 'make the tests pass', turnId: `p${n++}` })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
    out = passing
    await $.tool.call({ tool: 'Bash', command })
    expect(`${command}: ${(await $.classic.Stop(claim)).block !== undefined}`).toBe(`${command}: false`)
  }
})

test('a failing run stays red across turns until a run passes', async ($, on) => {
  let out = 'ℹ tests 2\nℹ pass 1\nℹ fail 1'
  bottoms(on, { '/repo/a.test.js': TWO }, () => false, () => out)
  await $.session.start(START)
  const done = (turnId: string) => $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  const addTest = { tool: 'Edit', file_path: '/repo/a.test.js', old_string: '})\n', new_string: "})\ntest('b', () => {\n  expect(h()).toBe(3)\n})\n" } as const

  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'node --test 2>&1 | tail -80' })
  await $.turn.start({ text: 'now add a test', turnId: 't2' })
  await $.tool.call(addTest)
  expect((await done('t2')).text).toBe('edited after a failing test run: a.test.js')

  out = 'ℹ tests 3\nℹ pass 3\nℹ fail 0'
  await $.turn.start({ text: 'run the tests again', turnId: 't3' })
  await $.tool.call({ tool: 'Bash', command: 'node --test 2>&1 | tail -80' })
  await $.turn.start({ text: 'add another test', turnId: 't4' })
  await $.tool.call(addTest)
  expect((await done('t4')).text).toBe('Done.')
})

test('a lenient prompt lets the weakening through and the receipt says so', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'update the tests, the second expectation is wrong', turnId: 't1' })
  const change = edit('/repo/a.test.js', '  expect(g()).toBe(2)\n', '')
  expect((await $.tool.check({ ...change })).decision).toBe('allow')
  const done = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
  expect(done.isError).toBeUndefined()
  const end = await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(end.text).toContain('allowed 1 because you asked for test changes: a.test.js (removes 1 of 2 assertions)')
})

test('a refusal blocks a green claim once; a passing run afterwards lets it through', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO }, () => false)
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const refused = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
  expect(refused.isError).toBe(true)

  const claim = { stop_hook_active: false, last_assistant_message: 'All tests pass now.' }
  const stop = await $.classic.Stop(claim)
  expect(stop.block).toContain('Before you finish')
  expect(stop.block).toContain('(a.test.js)')
  expect((await $.classic.Stop({ ...claim, stop_hook_active: true })).block).toBeUndefined()
  expect((await $.classic.Stop(claim)).block).toBeUndefined()

  await $.turn.start({ text: 'make the tests pass', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
  await $.tool.call({ tool: 'Bash', command: 'node --test' })
  expect((await $.classic.Stop(claim)).block).toBeUndefined()
})

test('the Stop gate stays quiet when nothing was refused or the claim is not green', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All tests pass now.' })).block).toBeUndefined()
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
  expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'I could not fix it; the tests still fail.' })).block).toBeUndefined()
})

test('turn.complete adds the receipt on the main loop and leaves a subagent alone', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const quiet = await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(quiet.text).toBe('Done.')

  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
  const main = await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(main.text).toBe('refused 1 test-weakening change: a.test.js (removes 1 of 2 assertions)')
  const sub = await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't9', reason: 'answer', agentId: 'agent-1' })
  expect(sub.text).toBe('Done.')
})

test('a check suppression in source code adds a note for the model', async ($, on) => {
  bottoms(on, { '/repo/src/a.ts': 'export const a = 1\n' })
  await $.session.start(START)
  await $.turn.start({ text: 'fix the type error', turnId: 't1' })
  const out = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'export const a = 1', new_string: '// @ts-ignore\nexport const a = 1' })
  expect(out.isError).toBeUndefined()
  expect((out.context ?? []).join('\n')).toContain('adds @ts-ignore')
  const end = await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(end.text).toContain('check suppressions added: src/a.ts (@ts-ignore)')
})

test('a shell command that deletes a test file asks', async ($, on) => {
  bottoms(on, {})
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const v = await $.tool.check({ tool: 'Bash', input: { command: 'rm -f /repo/tests/a.test.js' } })
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('deletes test files from the shell')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf coverage test-results' } })).decision).toBe('allow')
})

test('a setup file change that makes the tests pass for free asks', async ($, on) => {
  bottoms(on, { '/repo/package.json': '{"scripts":{"test":"jest"}}' })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const v = await $.tool.check({ tool: 'Write', input: { file_path: '/repo/package.json', content: '{"scripts":{"test":"jest || true"}}' } })
  expect(v.decision).toBe('ask')
  expect(v.reason).toBe('package.json: makes the "test" script always succeed (|| true). Weakening the test setup needs the user\'s yes.')
})

test('/tamperproof off lets the edit through, on makes it ask again, and the report counts', async ($, on) => {
  bottoms(on, { '/repo/a.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const weaken = edit('/repo/a.test.js', '  expect(g()).toBe(2)\n', '')
  expect((await $.tool.check(weaken)).decision).toBe('ask')

  const off = await $.command.run({ command: 'tamperproof', args: 'off', ...COMMAND })
  expect(off.text).toBe('tamperproof is paused until this session ends. /tamperproof on resumes it.')
  expect((await $.tool.check(weaken)).decision).toBe('allow')

  const on_ = await $.command.run({ command: 'tamperproof', args: 'on', ...COMMAND })
  expect(on_.text).toBe('tamperproof is on.')
  expect((await $.tool.check(weaken)).decision).toBe('ask')

  const bad = await $.command.run({ command: 'tamperproof', args: 'maybe', ...COMMAND })
  expect(bad.text).toBe("Usage: /tamperproof [on | off]   (no argument: this session's report)")

  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.test.js', old_string: '  expect(g()).toBe(2)\n', new_string: '' })
  const rep = await $.command.run({ command: 'tamperproof', args: '', ...COMMAND })
  expect(rep.text).toContain('tamperproof is on. This session:')
  expect(rep.text).toContain('refused 1 · you approved 0 · allowed on your request 0')
})

test('a trimmed string argument is a rewrite, not formatting', async ($, on) => {
  const text = "test('trims', () => {\n  assert.equal(slug('  Hi  '), 'hi')\n})\n"
  bottoms(on, { '/repo/a.test.js': text })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const v = await $.tool.check({ tool: 'Write', input: { file_path: '/repo/a.test.js', content: text.replace("'  Hi  '", "'Hi'") } })
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('rewrites 1 existing assertion')
})

test('a Rust source file is judged by its #[cfg(test)] module only', async ($, on) => {
  const src = 'pub fn run() -> bool {\n    assert!(ready());\n    true\n}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn a() {\n        assert_eq!(1, 1);\n        assert_eq!(2, 2);\n    }\n}\n'
  bottoms(on, { '/repo/src/lib.rs': src })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  expect((await $.tool.check(edit('/repo/src/lib.rs', '    assert!(ready());\n', ''))).decision).toBe('allow')
  const v = await $.tool.check(edit('/repo/src/lib.rs', '        assert_eq!(2, 2);\n', ''))
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('src/lib.rs: removes 1 of 2 assertions')
})

test('routine cleanup in a test folder does not ask', async ($, on) => {
  bottoms(on, {})
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  for (const command of ['rm -rf /repo/tests/__pycache__', 'rm -rf /repo/e2e/out', 'npm test > /repo/test/log.txt']) {
    expect(`${command}:${(await $.tool.check({ tool: 'Bash', input: { command } })).decision}`).toBe(`${command}:allow`)
  }
})

test('creating a test file from the shell with a heredoc does not ask, overwriting an existing one does', async ($, on) => {
  bottoms(on, { '/repo/tests/old.test.js': TWO })
  await $.session.start(START)
  await $.turn.start({ text: 'add a test', turnId: 't1' })
  const heredoc = (file: string): string => `cat > ${file} <<'EOF'\ntest('n', () => { expect(1).toBe(1) })\nEOF`
  expect((await $.tool.check({ tool: 'Bash', input: { command: heredoc('tests/new.test.js') } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'echo x | tee tests/new2.test.js' } })).decision).toBe('allow')
  const v = await $.tool.check({ tool: 'Bash', input: { command: heredoc('tests/old.test.js') } })
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('overwrites a test file (tests/old.test.js)')
})

test('moving a test to a name the runner no longer collects asks', async ($, on) => {
  bottoms(on, {})
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const v = await $.tool.check({ tool: 'Bash', input: { command: 'git mv tests/test_slug.py tests/old_slug.py' } })
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('moves a test file out of the test suite')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'git mv tests/test_slug.py tests/test_text.py' } })).decision).toBe('allow')
})

test('disabling a test by renaming its marker asks at hook level', async ($, on) => {
  const py = 'def test_a():\n    assert f() == 1\n\n\ndef test_b():\n    assert g() == 2\n'
  bottoms(on, { '/repo/tests/test_a.py': py })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const v = await $.tool.check(edit('/repo/tests/test_a.py', 'def test_b', 'def _b'))
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('tests/test_a.py: stops 1 of 2 tests from being run as a test')
})

test('large files: a 2 MB generated file is not judged and costs well under a second, an oversized test file is allowed unjudged', async ($, on) => {
  let big = ''
  for (let i = 0; big.length < 2_000_000; i++) big += `test('case ${i}', () => {\n  expect(f(${i}, "a b")).toBe(${i});\n})\n`
  bottoms(on, { '/repo/src/generated.js': big, '/repo/big.test.js': big })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const t = performance.now()
  const gen = await $.tool.check(edit('/repo/src/generated.js', 'toBe(7);', 'toBe(8);'))
  const test_ = await $.tool.check(edit('/repo/big.test.js', 'toBe(7);', 'toBe(8);'))
  const ms = performance.now() - t
  expect(gen.decision).toBe('allow')
  // Above 1.5 MB a test file is allowed unjudged (documented in the README limits).
  expect(test_.decision).toBe('allow')
  // Measured at a few milliseconds; the margin is for a slow or busy machine.
  expect(ms).toBeLessThan(1000)
})

test('a 5,000-line test file is judged at hook level well under a second', async ($, on) => {
  let five = ''
  for (let i = 0; five.split('\n').length < 5000; i++) five += `test('case ${i}', () => {\n  expect(f(${i}, "a b")).toBe(${i});\n})\n`
  bottoms(on, { '/repo/five.test.js': five })
  await $.session.start(START)
  await $.turn.start({ text: 'make the tests pass', turnId: 't1' })
  const t = performance.now()
  const v = await $.tool.check(edit('/repo/five.test.js', 'toBe(7);', 'toBe(8);'))
  const ms = performance.now() - t
  expect(v.decision).toBe('ask')
  expect(ms).toBeLessThan(1000)
})
