import { expect, test } from 'claude-code/testing'

import {
  applyEdit,
  assertionLines,
  familyOf,
  formattingOnly,
  isTestPath,
  judgeTestFile,
  measure,
  normText,
  rustTests,
  stripComments,
  suppressionsAdded,
} from './analyze'

test('isTestPath table', async () => {
  const yes = [
    'src/__tests__/a.ts', 'test/a.js', 'tests/x/y.py', 'spec/models/user_spec.rb', 'e2e/login.ts', 'a.test.ts', 'a.spec.mjs',
    'src/b.e2e.tsx', 'pkg/test_utils.py', 'pkg/utils_test.py', 'pkg/x_test.go', 'app/user_spec.rb', 'app/user_test.rb',
    'src/UserTest.java', 'src/UserTests.kt', 'src/UserIT.java', 'src/UserSpec.scala', 'Tests/FooTests.swift', 'a/b.snap',
  ]
  const no = ['src/a.ts', 'src/latest.ts', 'README.md', 'src/contest/a.ts', 'src/testing.ts', 'protest.js', 'src/attest.py', 'lib/tests.ts']
  for (const p of yes) expect(`${p}:${isTestPath(p)}`).toBe(`${p}:true`)
  for (const p of no) expect(`${p}:${isTestPath(p)}`).toBe(`${p}:false`)
})

test('familyOf maps extensions', async () => {
  expect(familyOf('a.test.mjs')).toBe('js')
  expect(familyOf('a_test.go')).toBe('go')
  expect(familyOf('x/a.PY')).toBe('py')
  expect(familyOf('a.kt')).toBe('jvm')
  expect(familyOf('a.snap')).toBe('snap')
  expect(familyOf('Makefile')).toBeUndefined()
  expect(familyOf('data.json')).toBeUndefined()
})

test('measure js counts tests, assertions, skips, focus and tautologies', async () => {
  const src = `
    it('a', () => { expect(f()).toBe(1) })
    test.skip('b', () => { assert.equal(f(), 2) })
    xit('c', () => {})
    describe.only('d', () => { it.only('e', () => { expect(true).toBe(true) }) })
    test('t', (t) => { t.is(1, 1); assert(true) })
  `
  const m = measure(src, 'js')
  expect(m.tests).toBe(4)
  expect(m.assertions).toBe(5)
  expect(m.skips).toBe(2)
  expect(m.focus).toBe(2)
  expect(m.tautologies).toBe(2)
})

test('measure: a commented-out assertion counts as removed', async () => {
  const live = `it('a', () => {\n  expect(f()).toBe(1)\n})\n`
  const dead = `it('a', () => {\n  // expect(f()).toBe(1)\n})\n`
  const block = `it('a', () => {\n  /* expect(f()).toBe(1) */\n})\n`
  expect(measure(live, 'js').assertions).toBe(1)
  expect(measure(dead, 'js').assertions).toBe(0)
  expect(measure(block, 'js').assertions).toBe(0)
  expect(measure('def test_a():\n    # assert f() == 1\n    pass\n', 'py').assertions).toBe(0)
  expect(stripComments('const u = "http://x.y" // c', 'js')).toContain('http://x.y')
})

test('measure python', async () => {
  const src = `
import pytest
@pytest.mark.skip
def test_a():
    assert f() == 1
    assert True
def test_b(self):
    self.assertEqual(f(), 2)
    with pytest.raises(ValueError):
        pass
`
  const m = measure(src, 'py')
  expect(m.tests).toBe(2)
  expect(m.assertions).toBe(4)
  expect(m.skips).toBe(1)
  expect(m.tautologies).toBe(1)
})

test('measure go, rust, jvm, ruby, php, c#, swift, snapshots', async () => {
  const go = measure('func TestA(t *testing.T) {\n  t.Skip("x")\n  if f() != 1 { t.Errorf("bad") }\n  assert.Equal(t, 1, f())\n}\n', 'go')
  expect([go.tests, go.assertions, go.skips]).toEqual([1, 2, 1])
  const rs = measure('#[test]\n#[ignore]\nfn a() { assert_eq!(f(), 1); assert!(true); }\n', 'rs')
  expect([rs.tests, rs.assertions, rs.skips, rs.tautologies]).toEqual([1, 2, 1, 1])
  const jvm = measure('@Test @Disabled void a() { assertEquals(1, f()); assertTrue(true); }', 'jvm')
  expect([jvm.tests, jvm.assertions, jvm.skips, jvm.tautologies]).toEqual([1, 2, 1, 1])
  const rb = measure('describe "x" do\n  it "a" do\n    expect(f).to eq(1)\n  end\n  xit "b" do\n  end\nend\n', 'rb')
  expect([rb.tests, rb.assertions, rb.skips]).toEqual([1, 1, 1])
  const php = measure('<?php\n#[Test]\npublic function testA() { $this->assertSame(1, f()); $this->markTestSkipped(); }', 'php')
  expect([php.tests, php.assertions, php.skips]).toEqual([2, 1, 1])
  const cs = measure('[Fact] public void A() { Assert.Equal(1, F()); }\n[Fact(Skip = "x")] void B() {}', 'cs')
  expect([cs.tests, cs.assertions, cs.skips]).toEqual([2, 1, 1])
  const sw = measure('func testA() { XCTAssertEqual(f(), 1); try XCTSkip("x") }', 'swift')
  expect([sw.tests, sw.assertions, sw.skips]).toEqual([1, 1, 1])
  const snap = measure('exports[`a 1`] = `x`;\nexports[`b 1`] = `y`;\n', 'snap')
  expect([snap.tests, snap.assertions]).toEqual([2, 2])
})

test('applyEdit: single, replace_all, missing and ambiguous old_string', async () => {
  expect(applyEdit('a b a', 'b', 'X', false)).toBe('a X a')
  expect(applyEdit('a b a', 'a', 'X', false)).toBeUndefined()
  expect(applyEdit('a b a', 'a', 'X', true)).toBe('X b X')
  expect(applyEdit('a b a', 'zzz', 'X', true)).toBeUndefined()
  expect(applyEdit('a b a', '', 'X', false)).toBeUndefined()
  expect(applyEdit('x $& y', '$&', "$'", false)).toBe("x $' y")
  expect(applyEdit('aaa', 'aa', 'b', true)).toBe('ba')
})

test('formattingOnly ignores whitespace, quote style and trailing separators', async () => {
  expect(formattingOnly("expect(a).toBe('x');\n", 'expect( a )\n  .toBe("x")')).toBe(true)
  expect(formattingOnly("expect(a).toBe('x')", "expect(a).toBe('y')")).toBe(false)
  expect(formattingOnly('f(1,\n  2,\n)', 'f(1, 2)')).toBe(true)
  expect(formattingOnly('const a = [1, 2,]\n', 'const a = [1, 2]')).toBe(true)
})

test('formattingOnly sees changes inside string literals and between arguments', async () => {
  // The fixture's own "trims" test: the argument loses its spaces.
  expect(formattingOnly('expect(slug("  Hi  "))', 'expect(slug("Hi"))')).toBe(false)
  expect(formattingOnly("expect(slug('a  b'))", "expect(slug('a b'))")).toBe(false)
  expect(formattingOnly('expect(add(1,2))', 'expect(add(12))')).toBe(false)
  expect(formattingOnly('expect(add(1, 2))', 'expect(add(1,2))')).toBe(true)
  expect(formattingOnly('return x', 'returnx')).toBe(false)
  expect(normText("x = 'a, b';")).toBe('x="a, b"')
})

test('formattingOnly: for Python a change of indentation is not formatting', async () => {
  const inside = 'if ok:\n    assert f() == 1\n'
  const outside = 'if ok:\nassert f() == 1\n'
  expect(formattingOnly(inside, outside)).toBe(true)
  expect(formattingOnly(inside, outside, true)).toBe(false)
})

test('assertionLines joins multi-line statements and normalizes', async () => {
  const a = assertionLines("it('a', () => {\n  expect(\n    f(),\n  ).toBe(1)\n})\n", 'js')
  expect(a).toHaveLength(1)
  expect(a[0]!.norm).toBe('expect(f()).toBe(1)')
  const b = assertionLines("expect(f()).toBe('x');\nconst y = 1\n", 'js')
  expect(b.map(l => l.raw)).toEqual(["expect(f()).toBe('x');"])
  expect(assertionLines('// expect(a)\n', 'js')).toHaveLength(0)
})

const T = 'a.test.js'
const two = "test('a', () => {\n  expect(f()).toBe(1)\n  expect(g()).toBe(2)\n})\n"
// Judges a change to a file that was `two` when the session first saw it, unless a baseline says otherwise.
const judge = (after: string, o: { before?: string; baseline?: string; red?: boolean; rel?: string } = {}) => {
  const before = o.before ?? two

  return judgeTestFile(o.rel ?? T, o.baseline ?? two, before, after, o.red ?? false)
}
const asked = (v: ReturnType<typeof judge>) => {
  if (v.kind !== 'ask') throw new Error(`expected ask, got ${v.kind}`)

  return v
}

test('judgeTestFile: removing an assertion asks with an exact reason', async () => {
  const after = "test('a', () => {\n  expect(f()).toBe(1)\n})\n"
  const v = asked(judge(after))
  expect(v.summary).toBe('removes 1 of 2 assertions')
  expect(v.reason).toContain('a.test.js: removes 1 of 2 assertions. A weaker test needs the user\'s yes.')
  expect(v.track).toEqual({ file: T, before: 2, after: 1 })
})

test('judgeTestFile: emptying, skips, focus and tautologies', async () => {
  expect(asked(judge('\n')).summary).toBe('empties the file, removes 2 of 2 assertions, removes 1 of 1 test')
  expect(asked(judge(two.replace("test('a'", "test.skip('a'"))).summary).toBe('adds 1 skip marker')
  expect(asked(judge(two.replace("test('a'", "test.only('a'"))).summary).toContain('adds 1 focus marker (.only), which stops the other tests from running')
  expect(asked(judge(two.replace('expect(g()).toBe(2)', 'expect(true).toBe(true)'))).summary).toBe('adds 1 always-true assertion')
})

test('judgeTestFile: added tests and assertions are allowed, and noted after a failing run', async () => {
  const after = two + "test('b', () => {\n  expect(h()).toBe(3)\n})\n"
  expect(judge(after, { red: true }).kind).toBe('note')
  const plain = judge(after)
  expect(plain.kind).toBe('allow')
  expect(plain.kind === 'allow' ? plain.track : undefined).toEqual({ file: T, before: 2, after: 3 })
})

test('judgeTestFile: rewriting a baseline assertion asks whether or not a run failed', async () => {
  const after = two.replace('toBe(2)', 'toBe(3)')
  for (const red of [false, true]) {
    const v = asked(judge(after, { red }))
    expect(v.summary).toBe('rewrites 1 existing assertion')
    expect(v.reason).toContain('a.test.js: rewrites 1 existing assertion (`expect(g()).toBe(2)` became `expect(g()).toBe(3)`).')
    expect(v.reason).toContain('Fix the code under test, or tell the user why this test is wrong.')
  }
  // A weaker matcher, a loosened value and an added argument are all seen, with no failing run before.
  asked(judge(two.replace('expect(g()).toBe(2)', 'expect(g()).toBeTruthy()')))
  asked(judge(two.replace('toBe(2)', 'toBeDefined()')))
  const call = "test('a', () => {\n  assert.equal(slug('Hello World'), 'hello_world')\n})\n"
  const withArg = call.replace("slug('Hello World')", "slug('Hello World', '_')")
  expect(asked(judge(withArg, { baseline: call, before: call })).reason).toContain('became')
  // Trimming the argument of an existing assertion is a rewrite, not formatting.
  const trims = "test('t', () => {\n  assert.equal(slug('  Hi  '), 'hi')\n})\n"
  asked(judge(trims.replace("'  Hi  '", "'Hi'"), { baseline: trims, before: trims }))
  asked(judge("test('a', () => { expect(add(12)).toBe(3) })", { baseline: "test('a', () => { expect(add(1,2)).toBe(3) })", before: "test('a', () => { expect(add(1,2)).toBe(3) })" }))
})

test('judgeTestFile: an assertion Claude added itself may be edited freely', async () => {
  // The session first saw `two`; Claude then added a third assertion, which is now on disk.
  const mine = two.replace('})\n', '  expect(f(5)).toBe(9)\n})\n')
  expect(judge(mine.replace('toBe(9)', 'toBe(6)'), { before: mine, red: true }).kind).toBe('note')
  expect(judge(mine.replace('toBe(9)', 'toBe(6)'), { before: mine }).kind).toBe('allow')
  // Deleting it again is free too, but one of the baseline assertions is still protected.
  expect(judge(two, { before: mine }).kind).toBe('allow')
  asked(judge(mine.replace('  expect(g()).toBe(2)\n', ''), { before: mine }))
  // A file Claude created (empty baseline) is all its own.
  expect(judge(two.replace('toBe(2)', 'toBe(3)'), { baseline: '' }).kind).toBe('allow')
  expect(judge('\n', { baseline: '' }).kind).toBe('allow')
  // Once a baseline assertion was already changed (approved), a later edit to the new text is free.
  const approved = two.replace('toBe(2)', 'toBe(3)')
  expect(judge(approved.replace('toBe(3)', 'toBe(4)'), { before: approved }).kind).toBe('allow')
})

test('judgeTestFile: refactors that keep every expected value are not weakening', async () => {
  const dup = "test('a', () => {\n  expect(f()).toBe(1)\n  expect(g()).toBe(2)\n})\n"
  // Two expects merged into one toEqual.
  expect(judge("test('a', () => {\n  expect([f(), g()]).toEqual([1, 2])\n})\n", { baseline: dup, before: dup }).kind).toBe('allow')
  // Assertions moved into a helper that takes the expected value.
  const helper = "function check(x, want) {\n  expect(x).toBe(want)\n}\ntest('a', () => {\n  check(f(), 1)\n  check(g(), 2)\n})\n"
  expect(judge(helper, { baseline: dup, before: dup }).kind).toBe('allow')
  // A repeated assertion collapsed into a helper.
  const rep = "test('a', () => { expect(ok()).toBeTruthy() })\ntest('b', () => { expect(ok()).toBeTruthy() })\n"
  expect(judge("function v() { expect(ok()).toBeTruthy() }\ntest('a', () => { v() })\ntest('b', () => { v() })\n", { baseline: rep, before: rep }).kind).toBe('allow')
  // Two tests turned into test.each.
  const two2 = "test('a', () => { expect(sq(1)).toBe(1) })\ntest('b', () => { expect(sq(2)).toBe(4) })\n"
  const each = "test.each([[1, 1], [2, 4]])('sq %i', (n, want) => { expect(sq(n)).toBe(want) })\n"
  expect(judge(each, { baseline: two2, before: two2 }).kind).toBe('allow')
  // Renaming what is called.
  expect(judge(two.replace('f()', 'first()'), {}).kind).toBe('allow')
  // But deleting an assertion, or a whole test with its expected value, still asks.
  asked(judge(two2.replace("test('b', () => { expect(sq(2)).toBe(4) })\n", ''), { baseline: two2, before: two2 }))
  asked(judge("function check(x) {\n  expect(x).toBeTruthy()\n}\ntest('a', () => {\n  check(f())\n  check(g())\n})\n", { baseline: dup, before: dup }))
})

test('judgeTestFile: swapping the call under test is a rewrite, renaming it everywhere is not', async () => {
  // The e2e fixture: the test is pointed at a new function while `slug` stays in use elsewhere.
  const fixture = 'import { slug } from "./slug.mjs"\ntest("a", () => {\n  assert.equal(slug("Hello World"), "hello-world")\n})\ntest("b", () => {\n  assert.equal(slug("Hello World"), "hello_world")\n})\n'
  const swapped = fixture.replace('import { slug }', 'import { slug, fileSlug }').replace('assert.equal(slug("Hello World"), "hello_world")', 'assert.equal(fileSlug("Hello World"), "hello_world")')
  const v = asked(judge(swapped, { baseline: fixture, before: fixture }))
  expect(v.reason).toContain('rewrites 1 existing assertion (`assert.equal(slug("Hello World"), "hello_world")` became `assert.equal(fileSlug("Hello World"), "hello_world")`)')
  // Renamed in every place (a Write of the whole file): nothing is left of the old name.
  expect(judge(fixture.replaceAll('slug', 'toSlug'), { baseline: fixture, before: fixture }).kind).toBe('allow')
})

test('judgeTestFile: a multi-line rewrite is seen', async () => {
  const before = "test('a', () => {\n  expect(\n    f(),\n  ).toBe(1)\n})\n"
  const after = "test('a', () => {\n  expect(\n    f(),\n  ).toBe(2)\n})\n"
  expect(judge(after, { baseline: before, before }).kind).toBe('ask')
})

test('judgeTestFile: a removal names what was removed', async () => {
  const v = asked(judge(two.replace('  expect(g()).toBe(2)\n', '  g()\n')))
  expect(v.summary).toBe('removes 1 of 2 assertions')
})

test('judgeTestFile: a baseline snapshot edited by hand asks, a new one does not', async () => {
  const before = 'exports[`a 1`] = `x`;\n'
  const after = 'exports[`a 1`] = `y`;\n'
  const snap = 'a.test.js.snap'
  const v = asked(judgeTestFile(snap, before, before, after, false))
  expect(v.summary).toBe('edits a stored snapshot by hand')
  expect(judgeTestFile(snap, '', before, after, false).kind).toBe('allow')
})

test('judgeTestFile: a suppression added to a test file is a note', async () => {
  const v = judge(two.replace('expect(f())', '// eslint-disable-next-line\n  expect(f())'))
  expect(v.kind).toBe('note')
  expect(v.kind === 'note' ? v.kinds : []).toEqual(['eslint-disable'])
})

test('judgeTestFile: python and a test path with no known language', async () => {
  const before = 'def test_a():\n    assert f() == 1\n    assert g() == 2\n'
  const v = asked(judgeTestFile('tests/test_a.py', before, before, 'def test_a():\n    assert f() == 1\n', false))
  expect(v.summary).toBe('removes 1 of 2 assertions')
  expect(judgeTestFile('tests/data.json', '{"a":1}', '{"a":1}', '{}', true).kind).toBe('allow')
  // Python: an operator change is a rewrite.
  asked(judgeTestFile('tests/test_a.py', before, before, before.replace('g() == 2', 'g() != 2'), false))
})

test('rustTests keeps only the cfg(test) module', async () => {
  const src = 'fn run() { assert!(ok()); }\n#[cfg(test)]\nmod t {\n  #[test]\n  fn a() { assert_eq!(1, 1); }\n}\n'
  expect(rustTests(src, true)).toBe('#[cfg(test)]\nmod t {\n  #[test]\n  fn a() { assert_eq!(1, 1); }\n}\n')
  expect(rustTests('fn run() {}', true)).toBe('')
  expect(rustTests(src, false)).toBe(src)
  // Removing a production assert!() leaves the judged part untouched.
  const prod = src.replace('assert!(ok());', '')
  expect(judgeTestFile('src/lib.rs', rustTests(src, true), rustTests(src, true), rustTests(prod, true), false).kind).toBe('allow')
})

test('suppressionsAdded reports only kinds whose count rose', async () => {
  expect(suppressionsAdded('a\n', 'a // @ts-ignore\n')).toEqual(['@ts-ignore'])
  expect(suppressionsAdded('// @ts-ignore\n', '// @ts-ignore\n')).toEqual([])
  expect(suppressionsAdded('x = 1', 'x = 1  # noqa\ny = 2  # type: ignore')).toEqual(['# type: ignore', '# noqa'])
  expect(suppressionsAdded('', '/* eslint-disable */ // nolint\n#[allow(dead_code)]\n// istanbul ignore next\n')).toEqual([
    'eslint-disable', '//nolint', '#[allow(…)]', 'istanbul ignore',
  ])
})

// ---- performance ----
const generated = (minChars: number): string => {
  let s = ''
  for (let i = 0; s.length < minChars; i++) s += `test('case ${i}', () => {\n  expect(f(${i}, "a b")).toBe(${i});\n  assert.equal(g(${i}),  ${i})\n})\n`
  return s
}
const timed = <T>(fn: () => T): { ms: number; value: T } => {
  const t = performance.now()
  const value = fn()

  return { ms: performance.now() - t, value }
}

test('performance: a 2 MB generated file is normalized well under a second', async () => {
  const big = generated(2_000_000)
  // normText reads the last emitted character on every whitespace run; that used to be quadratic.
  const norm = timed(() => normText(big))
  const fmt = timed(() => formattingOnly(big, big + '\n// x'))
  expect(big.length).toBeGreaterThan(2_000_000)
  // Measured at about 0.15 s; the margin is for a slow or busy machine.
  expect(norm.ms).toBeLessThan(1000)
  expect(fmt.ms).toBeLessThan(1500)
})

test('performance: judging a 5,000-line test file takes well under a second', async () => {
  const text = generated(1).repeat(1)
  let five = ''
  for (let i = 0; five.split('\n').length < 5001; i++) five += `test('case ${i}', () => {\n  expect(f(${i}, "a b")).toBe(${i});\n  assert.equal(g(${i}),  ${i})\n})\n`
  expect(text.length).toBeGreaterThan(0)
  const r = timed(() => judgeTestFile('a.test.js', five, five, five.replace('toBe(7)', 'toBe(8)'), false))
  expect(r.value.kind).toBe('ask')
  expect(r.ms).toBeLessThan(1000)
})

// ---- a test disabled by taking away its marker ----
test('judgeTestFile: removing what marks a test as a test asks, merging tests does not', async () => {
  const cases: [string, string, string, string][] = [
    ['tests/test_a.py', 'def test_a():\n    assert f() == 1\n\ndef test_b():\n    assert g() == 2\n', 'def test_b', 'def _b'],
    ['a_test.go', 'func TestA(t *testing.T) {\n\tif f() != 1 {\n\t\tt.Errorf("bad")\n\t}\n}\n\nfunc TestB(t *testing.T) {\n\tif g() != 2 {\n\t\tt.Errorf("bad")\n\t}\n}\n', 'func TestB', 'func testB'],
    ['src/lib_test.rs', '#[test]\nfn a() { assert_eq!(f(), 1); }\n\n#[test]\nfn b() { assert_eq!(g(), 2); }\n', '#[test]\nfn b', 'fn b'],
    ['src/FooTest.java', '@Test\nvoid a() { assertEquals(1, f()); }\n\n@Test\nvoid b() { assertEquals(2, g()); }\n', '@Test\nvoid b', 'void b'],
    ['a.test.js', "test('a', () => {\n  expect(f()).toBe(1)\n})\ntest('b', () => {\n  expect(g()).toBe(2)\n})\n", "test('b'", "void ('b'"],
    ['a.test.js', "test('a', () => {\n  expect(f()).toBe(1)\n})\ntest('b', () => {\n  expect(g()).toBe(2)\n})\n", "test('b'", "xtest_b ('b'"],
  ]
  for (const [rel, text, from, to] of cases) {
    const v = asked(judgeTestFile(rel, text, text, text.replace(from, to), false))
    expect(`${rel}: ${v.summary}`).toContain('from being run as a test')
  }
  // A merge keeps no more assertions than before and every expected value, so it is still allowed.
  const two2 = "test('a', () => { expect(sq(1)).toBe(1) })\ntest('b', () => { expect(sq(2)).toBe(4) })\n"
  const each = "test.each([[1, 1], [2, 4]])('sq %i', (n, want) => { expect(sq(n)).toBe(want) })\n"
  expect(judgeTestFile(T, two2, two2, each, false).kind).toBe('allow')
})

// ---- skip idioms: one test per pattern ----
const SKIP_IDIOMS: [string, string, string][] = [
  ['node:test { skip: true }', 'a.test.js', "test('b', { skip: true }, () => { assert.equal(g(), 2) })\n"],
  ['node:test { todo: "later" }', 'a.test.js', "test('b', { todo: 'later' }, () => { assert.equal(g(), 2) })\n"],
  ['node:test options on a later key', 'a.test.js', "test('b', { timeout: 5, skip: 'flaky' }, () => { assert.equal(g(), 2) })\n"],
  ['node:test t.skip()', 'a.test.js', "test('b', (t) => { t.skip('later'); assert.equal(g(), 2) })\n"],
  ['node:test t.todo()', 'a.test.js', "test('b', (t) => { t.todo(); assert.equal(g(), 2) })\n"],
  ['mocha this.skip()', 'a.test.js', "it('b', function () { this.skip(); expect(g()).to.equal(2) })\n"],
  ['vitest ctx.skip()', 'a.test.js', "it('b', (ctx) => { ctx.skip(); expect(g()).toBe(2) })\n"],
  ['vitest it.runIf(false)', 'a.test.js', "it.runIf(false)('b', () => { expect(g()).toBe(2) })\n"],
  ['vitest it.skipIf(true)', 'a.test.js', "it.skipIf(true)('b', () => { expect(g()).toBe(2) })\n"],
  ['jest test.failing', 'a.test.js', "test.failing('b', () => { expect(g()).toBe(2) })\n"],
  ['pytest module-level pytestmark', 'tests/test_a.py', 'pytestmark = pytest.mark.skip(reason="later")\ndef test_b():\n    assert g() == 2\n'],
  ['pytest pytestmark list', 'tests/test_a.py', 'pytestmark = [pytest.mark.xfail]\ndef test_b():\n    assert g() == 2\n'],
  ['pytest.importorskip', 'tests/test_a.py', 'np = pytest.importorskip("missing_module")\ndef test_b():\n    assert g() == 2\n'],
  ['JUnit assumeTrue(false)', 'src/FooTest.java', '@Test\nvoid b() { assumeTrue(false); assertEquals(2, g()); }\n'],
  ['JUnit assumeFalse', 'src/FooTest.java', '@Test\nvoid b() { assumeFalse(true); assertEquals(2, g()); }\n'],
  ['JUnit Assumptions.assumeThat', 'src/FooTest.java', '@Test\nvoid b() { Assumptions.assumeThat(false); assertEquals(2, g()); }\n'],
]
for (const [name, rel, added] of SKIP_IDIOMS) {
  test(`skip idiom: ${name} counts as a skip marker and asks`, async () => {
    const f = familyOf(rel)!
    expect(measure(added, f).skips).toBeGreaterThan(0)
    // Adding the test beside an untouched one asks only because of the skip.
    const base = rel.endsWith('.py') ? 'def test_a():\n    assert f() == 1\n' : rel.endsWith('.java') ? '@Test\nvoid a() { assertEquals(1, f()); }\n' : "test('a', () => { expect(f()).toBe(1) })\n"
    const v = asked(judgeTestFile(rel, base, base, base + added, false))
    expect(v.summary).toContain('skip marker')
  })
}

test('skip idioms: ordinary uses of the same words do not count', async () => {
  const ordinary = [
    "test('should skip the cache', () => { expect(f()).toBe(1) })",
    "it('todo items render', () => { expect(f()).toBe(1) })",
    "test('b', { skip: false }, () => { expect(f()).toBe(1) })",
    "test('b', () => { expect(db.find({}, { skip: 10, limit: 5 })).toEqual([]) })",
    "test('b', () => { expect(msg).toBe('ctx.skip is documented') })",
    "test('b', () => { expect(paginate(list).skip(2)).toBe(1) })",
    "it.runs = 1",
  ]
  for (const t of ordinary) expect(`${t}: ${measure(t, 'js').skips}`).toBe(`${t}: 0`)
  expect(measure('def test_a():\n    assert "pytestmark = pytest.mark.skip" in doc\n', 'py').skips).toBe(0)
})

// ---- Go: the `if` above t.Errorf is the assertion ----
test('judgeTestFile go: the expected value in `if got != want` is protected, a changed message is not', async () => {
  const go = 'func TestAdd(t *testing.T) {\n\tif got := Add(1, 2); got != 3 {\n\t\tt.Errorf("Add(1, 2) = %d, want 3", got)\n\t}\n}\n'
  const lines = assertionLines(go, 'go')
  expect(lines).toHaveLength(1)
  expect(lines[0]!.raw).toContain('if got := Add(1, 2); got != 3 {')
  // `!= 3` became `!= 4`: caught now (the Errorf line alone did not show it).
  asked(judgeTestFile('add_test.go', go, go, go.replace('got != 3', 'got != 4'), false))
  // Only the message text changed: not a rewrite.
  expect(judgeTestFile('add_test.go', go, go, go.replace('want 3', 'expected three'), false).kind).toBe('allow')
  // A table-driven refactor keeps every expected value.
  const table =
    'func TestAdd(t *testing.T) {\n\tfor _, tt := range []struct{ a, b, want int }{{1, 2, 3}} {\n\t\tif got := Add(tt.a, tt.b); got != tt.want {\n\t\t\tt.Errorf("Add(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.want)\n\t\t}\n\t}\n}\n'
  expect(judgeTestFile('add_test.go', go, go, table, false).kind).toBe('allow')
  // ...and a table whose row lost the value does not.
  asked(judgeTestFile('add_test.go', go, go, table.replace('{1, 2, 3}', '{1, 2, 4}'), false))
})

// ---- assertions made unable to fail ----
test('judgeTestFile: wrapping a baseline assertion so it cannot fail asks', async () => {
  const js = "test('a', () => {\n  expect(f()).toBe(1)\n})\n"
  const swallowed = "test('a', () => {\n  try {\n    expect(f()).toBe(1)\n  } catch {}\n})\n"
  expect(asked(judgeTestFile(T, js, js, swallowed, false)).summary).toContain('keep an assertion from ever failing')
  expect(asked(judgeTestFile(T, js, js, "test('a', () => {\n  try { expect(f()).toBe(1) } catch (e) { /* ignore */ }\n})\n", false)).summary).toContain('ever failing')
  expect(asked(judgeTestFile(T, js, js, js.replace('expect(f())', 'if (false) expect(f())'), false)).summary).toContain('ever failing')
  // A try with a real handler, and a try around no assertion, are ordinary.
  const handled = "test('a', () => {\n  try {\n    expect(f()).toBe(1)\n  } catch (e) {\n    throw e\n  }\n})\n"
  expect(judgeTestFile(T, js, js, handled, false).kind).toBe('allow')
  const cleanup = js.replace('})', '  try { fs.rmSync(tmp) } catch {}\n})')
  expect(judgeTestFile(T, js, js, cleanup, false).kind).toBe('allow')
  // A file Claude created is its own.
  expect(judgeTestFile(T, '', js, swallowed, false).kind).toBe('allow')

  const py = 'def test_a():\n    assert f() == 1\n'
  const tp = 'tests/test_a.py'
  expect(asked(judgeTestFile(tp, py, py, 'def test_a():\n    try:\n        assert f() == 1\n    except AssertionError:\n        pass\n', false)).summary).toContain('ever failing')
  expect(asked(judgeTestFile(tp, py, py, 'def test_a():\n    if False:\n        pass\n    assert f() == 1\n', false)).summary).toContain('ever failing')
  expect(asked(judgeTestFile(tp, py, py, 'def test_a():\n    if 0:\n        assert f() == 1\n', false)).summary).toContain('ever failing')
})

test('judgeTestFile python: nesting an existing assertion under a new if or else asks', async () => {
  const py = 'def test_a():\n    x = f()\n    assert x == 1\n'
  const tp = 'tests/test_a.py'
  const nested = asked(judgeTestFile(tp, py, py, 'def test_a():\n    x = f()\n    if os.environ.get("CI"):\n        assert x == 1\n', false))
  expect(nested.summary).toBe('puts 1 existing assertion under a new `if`, `else` or `while`, where it may never run')
  // An assertion that was already under an if stays there; `with` and `for` wrappers are ordinary.
  const guarded = 'def test_a():\n    x = f()\n    if ok:\n        assert x == 1\n'
  expect(judgeTestFile(tp, guarded, guarded, guarded.replace('x = f()', 'x = f() + 0'), false).kind).toBe('allow')
  expect(judgeTestFile(tp, py, py, 'def test_a():\n    x = f()\n    with ctx():\n        assert x == 1\n', false).kind).toBe('allow')
  // Putting every test in a class moves the indentation but guards nothing.
  expect(judgeTestFile(tp, py, py, 'class TestA:\n    def test_a(self):\n        x = f()\n        assert x == 1\n', false).kind).not.toBe('ask')
})

// ---- false positives ----
test('judgeTestFile: an added message argument is not a rewrite, an added argument is', async () => {
  const py = 'def test_a():\n    assert f() == 3\n'
  expect(judgeTestFile('tests/test_a.py', py, py, py.replace('== 3', "== 3, 'adds'"), false).kind).toBe('allow')
  const call = "class T(TestCase):\n    def test_a(self):\n        self.assertEqual(f(), 3)\n"
  expect(judgeTestFile('tests/test_a.py', call, call, call.replace('3)', "3, 'adds')"), false).kind).toBe('allow')
  const java = '@Test\nvoid a() { assertEquals(3, f()); }\n'
  expect(judgeTestFile('src/FooTest.java', java, java, java.replace('assertEquals(', 'assertEquals("adds", '), false).kind).toBe('allow')
  // A message does not hide a changed expected value or a changed argument.
  asked(judgeTestFile('tests/test_a.py', py, py, py.replace('== 3', "== 4, 'adds'"), false))
  asked(judgeTestFile('tests/test_a.py', py, py, py.replace('f()', "f('x')"), false))
})

test('measure ruby: RSpec is_expected and expect { } are assertions', async () => {
  const rb = 'describe "x" do\n  it { is_expected.to eq(3) }\n  it "raises" do\n    expect { f }.to raise_error(Boom)\n  end\nend\n'
  const m = measure(rb, 'rb')
  expect([m.tests, m.assertions]).toEqual([2, 2])
  const before = 'describe "x" do\n  it { is_expected.to eq(3) }\n  it { is_expected.to eq(4) }\nend\n'
  expect(asked(judgeTestFile('spec/x_spec.rb', before, before, before.replace('  it { is_expected.to eq(4) }\n', ''), false)).summary).toBe('removes 1 of 2 assertions, removes 1 of 2 tests')
})
