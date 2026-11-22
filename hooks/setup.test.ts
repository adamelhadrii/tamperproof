import { expect, test } from 'claude-code/testing'

import { isSetupFile, judgeSetup } from './setup'

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'x', scripts, ...extra }, null, 2)

test('isSetupFile by basename', async () => {
  for (const p of ['package.json', 'a/jest.config.ts', 'vitest.config.mjs', 'playwright.config.js', '.mocharc.json', 'pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml', '.coveragerc', 'tsconfig.json', 'tsconfig.base.json', 'phpunit.xml', 'phpunit.xml.dist']) {
    expect(`${p}:${isSetupFile(p)}`).toBe(`${p}:true`)
  }
  for (const p of ['src/a.ts', 'package-lock.json', 'README.md', 'tsconfig.ts']) expect(`${p}:${isSetupFile(p)}`).toBe(`${p}:false`)
})

test('package.json: a test script that always succeeds', async () => {
  const before = pkg({ test: 'jest', build: 'tsc' })
  expect(judgeSetup('package.json', before, pkg({ test: 'jest || true', build: 'tsc' }))).toEqual(['makes the "test" script always succeed (|| true)'])
  expect(judgeSetup('package.json', before, pkg({ test: 'jest --passWithNoTests' }))).toEqual(['makes the "test" script always succeed (--passWithNoTests)'])
  expect(judgeSetup('package.json', before, pkg({ test: 'jest; exit 0' }))).toEqual(['makes the "test" script always succeed (; exit 0)'])
  expect(judgeSetup('package.json', before, pkg({ test: 'echo "no tests"' }))).toEqual(['replaces the "test" script with `echo "no tests"`'])
  expect(judgeSetup('package.json', before, pkg({ test: 'exit 0' }))).toEqual(['replaces the "test" script with `exit 0`'])
})

test('package.json: harmless changes pass', async () => {
  const before = pkg({ test: 'jest', build: 'tsc' })
  expect(judgeSetup('package.json', before, pkg({ test: 'vitest run', build: 'tsc' }))).toEqual([])
  expect(judgeSetup('package.json', before, pkg({ test: 'jest', build: 'tsc || true' }))).toEqual([])
  expect(judgeSetup('package.json', before, pkg({ test: 'jest', 'test:unit': 'echo hi' }))).toEqual([])
  expect(judgeSetup('package.json', before, '{ not json')).toEqual([])
  expect(judgeSetup('package.json', pkg({ test: 'jest || true' }), pkg({ test: 'jest || true' }))).toEqual([])
})

test('coverage thresholds that drop are reported per key, in order', async () => {
  const before = pkg({}, { jest: { coverageThreshold: { global: { branches: 80, functions: 90 } } } })
  const after = pkg({}, { jest: { coverageThreshold: { global: { branches: 60, functions: 90 } } } })
  expect(judgeSetup('package.json', before, after)).toEqual(['lowers the coverage threshold branches from 80 to 60'])
  expect(judgeSetup('package.json', after, before)).toEqual([])
  expect(judgeSetup('.coveragerc', '[report]\nfail_under = 90\n', '[report]\nfail_under = 50\n')).toEqual(['lowers the coverage threshold fail_under from 90 to 50'])
  expect(judgeSetup('pytest.ini', 'addopts = --cov-fail-under=85', 'addopts = --cov-fail-under=70')).toEqual(['lowers the coverage threshold cov-fail-under from 85 to 70'])
})

test('tsconfig: turning strict flags off', async () => {
  const before = '{\n  // comment\n  "$schema": "https://json.schemastore.org/tsconfig",\n  "compilerOptions": { "strict": true, "noImplicitAny": true, },\n}\n'
  expect(judgeSetup('tsconfig.json', before, before.replace('"strict": true', '"strict": false'))).toEqual(["turns off TypeScript's strict"])
  expect(judgeSetup('tsconfig.json', before, before.replace('"noImplicitAny": true,', ''))).toEqual(["turns off TypeScript's noImplicitAny"])
  expect(judgeSetup('tsconfig.json', before, before.replace('"strict": true', '"strict": true, "target": "es2022"'))).toEqual([])
  expect(judgeSetup('tsconfig.json', before, '{ broken')).toEqual([])
})

test('pytest addopts that skip tests by default', async () => {
  const before = '[pytest]\naddopts = -q\n'
  expect(judgeSetup('pytest.ini', before, '[pytest]\naddopts = -q -k "not slow"\n')).toEqual(['makes pytest skip tests by default (-k)'])
  expect(judgeSetup('pytest.ini', before, '[pytest]\naddopts = -q --ignore=tests/slow\n')).toEqual(['makes pytest skip tests by default (--ignore)'])
  expect(judgeSetup('pytest.ini', before, '[pytest]\naddopts = -q\n  --deselect tests/a.py::t\n')).toEqual(['makes pytest skip tests by default (--deselect)'])
  expect(judgeSetup('pytest.ini', before, '[pytest]\naddopts = -q -x\n')).toEqual([])
  expect(judgeSetup('pyproject.toml', 'x = 1\n', 'x = 1\n# -k later\n')).toEqual([])
})
