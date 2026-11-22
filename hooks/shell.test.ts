import { expect, test } from 'claude-code/testing'

import { isTestCommand, isTestish, judgeShell, mentionedFiles, segments, testOutputFailed } from './shell'

const kind = (cmd: string): string => judgeShell(cmd, isTestish).kind
const summary = (cmd: string): string => {
  const v = judgeShell(cmd, isTestish)

  return v.kind === 'ask' ? v.summary : ''
}

test('segments split on operators outside quotes and drop wrappers', async () => {
  expect(segments('cd a && FOO=1 sudo rm -rf x; ls | wc -l\nnpm test')).toEqual([
    ['cd', 'a'], ['rm', '-rf', 'x'], ['ls'], ['wc', '-l'], ['npm', 'test'],
  ])
  expect(segments(`grep "a|b; c" 'x && y' f`)).toEqual([['grep', 'a|b; c', 'x && y', 'f']])
  expect(segments('a || b')).toEqual([['a'], ['b']])
  expect(segments('time nice env X=1 pytest -q')).toEqual([['pytest', '-q']])
})

test('isTestish table', async () => {
  for (const t of ['a.test.js', './tests/a.js', 'tests', 'test/', '"spec"', '*.test.ts', 'x/test_*.py', 'pkg/*_test.go', 'src/__tests__', 'e2e/']) {
    expect(`${t}:${isTestish(t)}`).toBe(`${t}:true`)
  }
  for (const t of ['src/a.js', 'coverage', 'test-results', 'node_modules/x/test/a.js', '-f', '', '.']) {
    expect(`${t}:${isTestish(t)}`).toBe(`${t}:false`)
  }
})

test('rule 1: deleting test files asks; deleting build output does not', async () => {
  expect(summary('rm tests/a.test.js')).toBe('deletes test files from the shell (tests/a.test.js)')
  expect(summary('rm -rf src/a.js tests')).toBe('deletes test files from the shell (tests)')
  expect(summary('git rm a.test.ts b.spec.ts')).toBe('deletes test files from the shell (a.test.ts, b.spec.ts)')
  expect(kind('find . -name "*.test.js" -delete')).toBe('ask')
  expect(kind('find tests -exec rm {} \;')).toBe('ask')
  expect(kind('trash a.test.js')).toBe('ask')
  expect(kind('rm -rf coverage test-results')).toBe('allow')
  expect(kind('rm -rf node_modules dist .next')).toBe('allow')
  expect(kind('find . -name "*.log" -delete')).toBe('allow')
  expect(kind('ls tests')).toBe('allow')
})

test('rule 1 reason is exact', async () => {
  const v = judgeShell('rm a.test.js', isTestish)
  if (v.kind !== 'ask') throw new Error('expected ask')
  expect(v.reason).toBe('deletes test files from the shell (a.test.js), where tamperproof cannot check what changes. Use the Edit tool for test changes, or ask the user first.')
  expect(v.file).toBe('a.test.js')
})

test('rule 2: moving a test file out of the suite asks', async () => {
  expect(summary('mv tests/a.test.js /tmp/a.js')).toBe('moves a test file out of the test suite (tests/a.test.js → /tmp/a.js)')
  expect(kind('git mv a.test.js a.test.js.bak')).toBe('ask')
  expect(kind('mv a.test.js b.test.js')).toBe('allow')
  expect(kind('mv src/a.js src/b.js')).toBe('allow')
  expect(kind('mv tests/a.js tests/old/')).toBe('allow')
})

test('rule 3: in-place edits of test files ask', async () => {
  expect(summary("sed -i 's/2/3/' a.test.js")).toBe('edits a test file in place (a.test.js)')
  expect(kind("sed -i.bak 's/2/3/' tests/a.js")).toBe('ask')
  expect(kind("perl -pi -e 's/2/3/' a.test.js")).toBe('ask')
  expect(kind("gawk -i inplace '{print}' a.test.js")).toBe('ask')
  expect(kind('ed a.test.js')).toBe('ask')
  expect(kind("sed -i 's/2/3/' src/a.js")).toBe('allow')
  expect(kind("sed -n '1,5p' a.test.js")).toBe('allow')
  expect(kind("sed 's/2/3/' a.test.js")).toBe('allow')
})

test('rule 4: overwriting a test file asks; appends and fd redirects do not', async () => {
  expect(summary('echo hi > a.test.js')).toBe('overwrites a test file (a.test.js)')
  expect(kind('echo hi >a.test.js')).toBe('ask')
  expect(kind('cat > tests/a.js <<EOF\nx\nEOF')).toBe('ask')
  expect(kind('echo hi | tee a.test.js')).toBe('ask')
  expect(kind('cp backup.js a.test.js')).toBe('ask')
  expect(kind('echo hi >> a.test.js')).toBe('allow')
  expect(kind('echo hi | tee -a a.test.js')).toBe('allow')
  expect(kind('node --test 2>/dev/null')).toBe('allow')
  expect(kind('node --test 2>&1')).toBe('allow')
  expect(kind('node --test &>out.log')).toBe('allow')
  expect(kind('echo hi > out.txt')).toBe('allow')
  expect(kind('cp a.test.js /tmp/backup/')).toBe('allow')
})

test('rule 5: reverting test files asks', async () => {
  expect(summary('git checkout -- a.test.js')).toBe('reverts a test file to an older version (a.test.js)')
  expect(kind('git restore tests/a.js')).toBe('ask')
  expect(kind('git checkout HEAD~1 -- tests/')).toBe('ask')
  expect(kind('git checkout main')).toBe('allow')
  expect(kind('git checkout -b feature/tests')).toBe('allow')
  expect(kind('git restore --staged tests/a.js')).toBe('allow')
  expect(kind('git checkout -- src/a.js')).toBe('allow')
})

test('rule 6: snapshot regeneration asks, with the flag named', async () => {
  const v = judgeShell('npx jest -u', isTestish)
  if (v.kind !== 'ask') throw new Error('expected ask')
  expect(v.reason).toBe(
    "regenerates test snapshots to match the current output (-u). That turns a failing snapshot test green without checking the output, so it needs the user's yes.",
  )
  expect(kind('vitest run --update-snapshots')).toBe('ask')
  expect(kind('npm test -- --updateSnapshot')).toBe('ask')
  expect(kind('cargo insta accept')).toBe('ask')
  expect(kind('insta review')).toBe('ask')
  expect(kind('npx jest')).toBe('allow')
  expect(kind('ls -u')).toBe('allow')
  expect(kind('cp -u a b')).toBe('allow')
})

test('the first matching rule wins', async () => {
  expect(summary('rm a.test.js && echo x > b.test.js')).toBe('deletes test files from the shell (a.test.js)')
  expect(summary('echo x > b.test.js && rm a.test.js')).toBe('deletes test files from the shell (a.test.js)')
})

test('isTestCommand table', async () => {
  for (const c of [
    'npm test', 'npm run test', 'pnpm test', 'yarn test', 'bun test', 'npx jest', 'npx vitest run', 'jest --ci', 'pytest -q',
    'python -m pytest', 'python3 -m unittest', 'go test ./...', 'cargo test', 'cargo nextest run', 'node --test',
    'node --import x --test', 'deno test', 'dotnet test', './mvnw -q test', 'gradle test', 'make test', 'make check', 'ctest',
    'swift test', 'mix test', 'bundle exec rspec', 'rspec spec/', 'rake test', 'bin/rails test', 'rails test test/models', 'bundle exec rake spec', 'phpunit', 'cd app && npm test', 'tox', 'FOO=1 pytest',
  ]) {
    expect(`${c}:${isTestCommand(c)}`).toBe(`${c}:true`)
  }
  for (const c of ['ls', 'npm install', 'npm run build', 'git status', 'echo pytest', 'pip install pytest', 'cat jest.config.js', 'grep -r vitest .', 'node server.js', 'git commit -m "fix pytest"']) {
    expect(`${c}:${isTestCommand(c)}`).toBe(`${c}:false`)
  }
})

test('routine cleanup inside test folders asks nothing', async () => {
  for (const c of [
    'rm -rf tests/__pycache__',
    'find tests -name __pycache__ -exec rm -rf {} +',
    'find tests -name "*.pyc" -delete',
    'rm -rf e2e/out',
    'rm -rf tests/tmp tests/output',
    'rm tests/run.log',
    'npm test > test/log.txt',
    'echo x > tests/fixtures/out.txt',
    'cp a.db tests/data.db',
    'rm -rf node_modules/pkg/tests',
  ]) {
    expect(`${c}:${kind(c)}`).toBe(`${c}:allow`)
  }
  // The real thing still asks.
  for (const c of ['rm -rf tests', 'rm -rf tests/__pycache__ tests/test_a.py', 'find tests -delete', 'echo x > tests/test_a.py', 'rm e2e/login.spec.ts']) {
    expect(`${c}:${kind(c)}`).toBe(`${c}:ask`)
  }
})

test('truncating a test file and vitest --update ask', async () => {
  expect(summary('truncate -s0 a.test.js')).toBe('overwrites a test file (a.test.js)')
  expect(summary('truncate -s 0 tests/test_a.py')).toBe('overwrites a test file (tests/test_a.py)')
  expect(kind('truncate -s0 build.log')).toBe('allow')
  expect(summary('npx vitest --update')).toBe('regenerates test snapshots (--update)')
  expect(kind('npx vitest run -u')).toBe('ask')
  expect(kind('npx vitest run')).toBe('allow')
})

test('testOutputFailed reads the failure lines of each runner and ignores passing output', async () => {
  const failing = [
    'ℹ tests 3\nℹ pass 2\nℹ fail 1',
    '# tests 3\n# pass 2\n# fail 1',
    'not ok 2 - b',
    'Tests:       1 failed, 2 passed, 3 total',
    ' Test Files  1 failed | 1 passed (2)',
    '      Tests  1 failed | 4 passed (5)',
    ' FAIL  src/a.test.ts > adds',
    '  ✖ adds (0.5ms)',
    '  ✕ adds (2 ms)',
    '=========== 1 failed, 2 passed in 0.12s ===========',
    '1 failed, 2 passed in 0.12s',
    'FAILED tests/test_a.py::test_x - assert 1 == 2',
    'FAILED (failures=1)',
    '--- FAIL: TestA (0.00s)',
    'FAIL\texample.com/a\t0.002s',
    'FAIL',
    'test a ... FAILED',
    'test result: FAILED. 1 passed; 1 failed',
    'error: could not compile `a` (lib test) due to 1 previous error',
    '  1 failing',
    '  2 tests failed',
    '3 examples, 1 failure',
    '3 runs, 4 assertions, 0 failures, 1 errors, 0 skips',
    'Tests run: 3, Failures: 1, Errors: 0, Skipped: 0',
    '5 tests completed, 1 failed',
    'BUILD FAILED in 3s',
    'Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3',
    'FAILURES!\nTests: 3, Assertions: 4, Failures: 1.',
    'FAILED | 2 passed | 1 failed (12ms)',
    "Executed 3 tests, with 1 failures (0 unexpected) in 0.01 seconds",
    '1 tests failed out of 4',
    '(pass) a [0.1ms]\n(fail) b [0.2ms]\n\n 1 pass\n 1 fail',
    ' 1 fail',
    '=================================== FAILURES ===================================',
  ]
  for (const t of failing) expect(`${JSON.stringify(t)}:${testOutputFailed(t)}`).toBe(`${JSON.stringify(t)}:true`)

  const passing = [
    '',
    'ℹ tests 3\nℹ pass 3\nℹ fail 0',
    '# pass 3\n# fail 0',
    'Tests:       3 passed, 3 total',
    '      Tests  5 passed (5)',
    '  ✔ handles 2 failed logins (1ms)',
    '  ✓ retries after 3 failed attempts',
    '3 passed in 0.10s',
    '0 failed, 3 passed',
    'ok  \texample.com/a\t0.002s',
    'test result: ok. 2 passed; 0 failed; 0 ignored',
    '  3 passing (9ms)',
    '3 examples, 0 failures',
    '3 runs, 4 assertions, 0 failures, 0 errors, 0 skips',
    'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\nBUILD SUCCESS',
    'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3',
    'OK (3 tests, 4 assertions)',
    'ok | 3 passed | 0 failed (12ms)',
    '(pass) handles (fail) in the name [0.1ms]\n\n 3 pass\n 0 fail',
    '3 passed, 0 failed, 11 fail-safe checks',
  ]
  for (const t of passing) expect(`${JSON.stringify(t)}:${testOutputFailed(t)}`).toBe(`${JSON.stringify(t)}:false`)
})

test('rule 1: build and cache folders under a test folder are noise, a test file in one is not', async () => {
  for (const c of ['rm -rf test/dist', 'rm -rf e2e/.cache', 'rm -rf spec/reports', 'rm -rf tests/coverage tests/target', 'rm -rf tests/build', 'find tests -name dist -exec rm -rf {} +']) {
    expect(`${c}:${kind(c)}`).toBe(`${c}:allow`)
  }
  for (const c of ['rm tests/build/a.test.js', 'rm -rf tests/out/a.test.js', 'rm tests/reports/test_a.py']) expect(`${c}:${kind(c)}`).toBe(`${c}:ask`)
})

test('rule 4: writing a test file that does not exist yet is not an overwrite', async () => {
  const cmd = 'cat > tests/new.test.js <<EOF\ntest("a", () => {})\nEOF'
  expect(kind(cmd)).toBe('ask')
  const missing = new Set(['tests/new.test.js', 'tests/b.test.js'])
  const verdict = (c: string): string => judgeShell(c, isTestish, t => !missing.has(t)).kind
  expect(verdict(cmd)).toBe('allow')
  expect(verdict('echo x | tee tests/b.test.js')).toBe('allow')
  expect(verdict('cp /tmp/a.js tests/b.test.js')).toBe('allow')
  // A file that exists is still overwritten.
  expect(verdict('echo x > tests/old.test.js')).toBe('ask')
  expect(mentionedFiles('cat >tests/new.test.js <<EOF && cp a tests/b.test.js -f')).toEqual(['cat', 'tests/new.test.js', '<<EOF', 'cp', 'a', 'tests/b.test.js'])
})

test('rule 2: a move that leaves the file out of what the runner collects asks', async () => {
  for (const c of ['mv tests/test_a.py tests/disabled_a.py', 'git mv tests/test_slug.py tests/old_slug.py', 'mv tests/a.test.js tests/a.test.js.bak', 'mv tests/a_test.go tests/a_test.go.off', 'mv tests/test_a.py tests/helpers.py']) {
    expect(`${c}:${kind(c)}`).toBe(`${c}:ask`)
  }
  for (const c of ['mv tests/test_a.py tests/test_b.py', 'mv tests/a.test.js tests/unit/', 'git mv tests/a.test.js tests/b.test.js', 'mv tests/a.test.js tests/unit', 'mv tests/helpers.js tests/util.js']) {
    expect(`${c}:${kind(c)}`).toBe(`${c}:allow`)
  }
})
