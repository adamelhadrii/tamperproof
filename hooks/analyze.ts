// Pure test-weakening analysis. No imports and only erasable TypeScript syntax,
// because e2e/run.mjs imports this file straight from Node.

export type Family = 'js' | 'py' | 'go' | 'rs' | 'jvm' | 'rb' | 'php' | 'cs' | 'swift' | 'snap'
export type Strength = { tests: number; assertions: number; skips: number; focus: number; tautologies: number }
export type Track = { file: string; before: number; after: number }
export type FileVerdict =
  | { kind: 'allow'; track?: Track }
  | { kind: 'note'; file: string; editedAfterRed: boolean; kinds: string[]; track?: Track }
  | { kind: 'ask'; file: string; summary: string; reason: string; track?: Track }

const TEST_PATH: RegExp[] = [
  /(^|\/)(__tests__|__test__|tests?|specs?|e2e)\//i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /_test\.go$/,
  /_(spec|test)\.rb$/,
  /(Test|Tests|Spec|IT)\.(java|kt|kts|scala|cs|php|swift)$/,
  /\.snap$/,
]

/** True when the POSIX root-relative path names a test file or a file inside a test folder. */
export function isTestPath(rel: string): boolean {
  return TEST_PATH.some(re => re.test(rel))
}

/** True when the file's own name is one a test runner collects (`a.test.js`, `test_a.py`, `a_test.go`), wherever it sits. */
export function isTestFileName(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1)

  return TEST_PATH.slice(1).some(re => re.test(name))
}

const EXT: Record<string, Family> = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js',
  py: 'py',
  go: 'go',
  rs: 'rs',
  java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm',
  rb: 'rb',
  php: 'php',
  cs: 'cs',
  swift: 'swift',
  snap: 'snap',
}

export function familyOf(rel: string): Family | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(rel)

  return m ? EXT[m[1]!.toLowerCase()] : undefined
}

const C_LIKE: Family[] = ['js', 'go', 'rs', 'jvm', 'php', 'cs', 'swift']
const HASH: Family[] = ['py', 'rb', 'php']

/** Removes comments, so a commented-out assertion counts as removed. */
export function stripComments(text: string, f: Family): string {
  let s = text
  if (C_LIKE.includes(f)) s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  // PHP 8 attributes (#[Test]) start with a hash too, so they are not comments.
  if (HASH.includes(f)) s = s.replace(f === 'php' ? /(^|\s)#(?!\[).*$/gm : /(^|\s)#.*$/gm, '$1')

  return s
}

type Regexes = { tests: RegExp[]; assertions: RegExp[]; skips: RegExp[]; focus: RegExp[]; tautologies: RegExp[] }

const NONE: RegExp[] = []
const R: Record<Family, Regexes> = {
  js: {
    tests: [/(?<![.\w$])(?:it|test)(?:\.(?:each|concurrent|failing|only|skip|todo|skipIf|runIf)\b[^(\n]*)?\s*\(/g],
    assertions: [
      /(?<![.\w$])expect\s*\(|(?<![\w$])assert(?:\.\w+)*\s*\(|\bt\.(?:is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|regex|snapshot|like|assert)\s*\(|\.should\b/g,
    ],
    skips: [
      /(?<![.\w$])(?:it|test|describe|suite|context)\.(?:skip|todo)\b|(?<![.\w$])x(?:it|test|describe|context)\s*\(|\.(?:skipIf|runIf)\s*\(|(?<![.\w$])(?:it|test)\.failing\b/g,
      // node:test: `test('name', { skip: true }, fn)`; the title is read as a string so a title that says "skip" does not count.
      /(?<![.\w$])(?:it|test|describe|suite|context)\s*\(\s*(["'`])(?:\\.|(?!\1)[^\\\n])*\1\s*,\s*\{[^}]{0,120}?\b(?:skip|todo)\s*:(?!\s*false\b)/g,
      // `t.skip()`, `t.todo()`, mocha's `this.skip()`, vitest's `ctx.skip()`.
      /(?<![.\w$])(?:t|ctx|this)\.(?:skip|todo)\s*\(/g,
    ],
    focus: [/(?<![.\w$])(?:it|test|describe|suite|context)\.only\b|(?<![.\w$])f(?:it|describe)\s*\(/g],
    tautologies: [
      /expect\(\s*(true|1)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/g,
      /expect\(\s*true\s*\)\s*\.\s*toBeTruthy\(\s*\)/g,
      /(?<![\w$.])assert(?:\.ok)?\(\s*true\s*\)/g,
      /assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*(true|1)\s*,\s*\1\s*\)/g,
    ],
  },
  py: {
    tests: [/^\s*(?:async\s+)?def\s+test\w*\s*\(/gm],
    assertions: [/^\s*assert\b|\bself\.assert\w+\s*\(|\bpytest\.raises\s*\(|\bnp\.testing\.assert\w*\s*\(/gm],
    skips: [
      /@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.(?:skip|xfail|importorskip)\s*\(|\bself\.skipTest\s*\(/g,
      // Module-level `pytestmark = pytest.mark.skip(...)` (or a list holding it) skips every test in the file.
      /^\s*pytestmark\s*=.*\bpytest\.mark\.(?:skip|skipif|xfail)\b/gm,
    ],
    focus: NONE,
    tautologies: [/^\s*assert\s+(?:True|1)\s*$/gm, /\bself\.assertTrue\(\s*True\s*\)/g],
  },
  go: {
    tests: [/^func\s+(?:Test|Benchmark|Fuzz)\w*\s*\(/gm],
    assertions: [/\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\s*\(/g],
    skips: [/\bt\.Skip(?:f|Now)?\s*\(/g],
    focus: NONE,
    tautologies: NONE,
  },
  rs: {
    tests: [/#\[(?:tokio::)?test\]/g],
    assertions: [/\b(?:assert|assert_eq|assert_ne|debug_assert\w*)!\s*\(|#\[should_panic/g],
    skips: [/#\[ignore\b/g],
    focus: NONE,
    tautologies: [/\bassert!\(\s*true\s*\)/g],
  },
  jvm: {
    tests: [/@(?:Test|ParameterizedTest|RepeatedTest)\b/g],
    assertions: [/\bassert(?:Equals|NotEquals|True|False|Null|NotNull|Same|NotSame|That|Throws|DoesNotThrow|ArrayEquals|IterableEquals|All)\s*\(|\bverify\s*\(/g],
    skips: [/@(?:Disabled|Ignore)\b|\bassume(?:True|False|That)\s*\(/g],
    focus: NONE,
    tautologies: [/\bassertTrue\(\s*true\s*\)/g],
  },
  rb: {
    tests: [/^\s*(?:it|specify|scenario|example)\b\s*(?:\(|["'{]|do\b)|^\s*def\s+test_\w*/gm],
    assertions: [/\bexpect\s*[({]|\bis_expected\b|\bassert(?:_\w+)?\b|\.should\b/g],
    skips: [/^\s*(?:xit|xspecify|xdescribe|xcontext|skip|pending)\b/gm],
    focus: NONE,
    tautologies: NONE,
  },
  php: {
    tests: [/function\s+test\w*\s*\(|@test\b|#\[Test\]/g],
    assertions: [/(?:\$this->|self::|static::)assert\w+\s*\(/g],
    skips: [/markTestSkipped|markTestIncomplete/g],
    focus: NONE,
    tautologies: NONE,
  },
  cs: {
    tests: [/\[(?:Test|TestCase|Fact|Theory|TestMethod)\b/g],
    assertions: [/\bAssert\.\w+\s*\(|\.Should\(\)/g],
    skips: [/\[Ignore\b|Skip\s*=/g],
    focus: NONE,
    tautologies: NONE,
  },
  swift: {
    tests: [/\bfunc\s+test\w*\s*\(|@Test\b/g],
    assertions: [/\bXCTAssert\w*\s*\(|#expect\s*\(|#require\s*\(/g],
    skips: [/\bXCTSkip\w*\s*\(/g],
    focus: NONE,
    tautologies: NONE,
  },
  snap: {
    tests: [/^exports\[/gm],
    assertions: [/^exports\[/gm],
    skips: NONE,
    focus: NONE,
    tautologies: NONE,
  },
}

const count = (s: string, res: RegExp[]): number => res.reduce((n, re) => n + (s.match(re)?.length ?? 0), 0)

/** Counts tests, assertions and weakening markers over the comment-free text. */
export function measure(text: string, f: Family): Strength {
  const s = stripComments(text, f)
  const r = R[f]

  return {
    tests: count(s, r.tests),
    assertions: count(s, r.assertions),
    skips: count(s, r.skips),
    focus: count(s, r.focus),
    tautologies: count(s, r.tautologies),
  }
}

const isWord = (c: string | undefined): boolean => c !== undefined && /\w/.test(c)

/**
 * Normalizes formatting only: quote style, whitespace outside quotes (kept as a
 * single space only between two word characters), and a trailing `,` or `;`
 * (before a closing bracket or the end of the text; a `;` also at a line end).
 * The text inside string literals is never touched.
 */
export function normText(s: string): string {
  let out = ''
  // The last character emitted: reading it back from `out` would flatten the string on every
  // whitespace run, which is quadratic on a large file.
  let last = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1
      out += '"' + s.slice(i + 1, Math.min(j, s.length)) + '"'
      last = '"'
      i = j + 1
    } else if (/\s/.test(c)) {
      let j = i
      while (j < s.length && /\s/.test(s[j]!)) j++
      if (isWord(last) && isWord(s[j])) {
        out += ' '
        last = ' '
      }
      i = j
    } else if (c === ',' || c === ';') {
      let j = i + 1
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\r')) j++
      const atLineEnd = c === ';' && (j >= s.length || s[j] === '\n')
      let k = j
      while (k < s.length && /\s/.test(s[k]!)) k++
      const closes = k >= s.length || ')]}'.includes(s[k]!)
      if (!atLineEnd && !closes) {
        out += c
        last = c
      }
      i++
    } else {
      out += c
      last = c
      i++
    }
  }

  return out
}

const indents = (s: string): string =>
  s
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => /^[ \t]*/.exec(l)![0].length)
    .join(',')

/**
 * True when two texts differ only in formatting (see normText). With
 * `indentMatters` (Python) the indentation of every line has to match too.
 */
export function formattingOnly(a: string, b: string, indentMatters = false): boolean {
  return normText(a) === normText(b) && (!indentMatters || indents(a) === indents(b))
}

const parens = (s: string): number => (s.match(/\(/g)?.length ?? 0) - (s.match(/\)/g)?.length ?? 0)

const indentOf = (l: string): number => /^[ \t]*/.exec(l)![0].length

// What can keep a Python assertion from running: the blocks it can sit under.
const PY_GUARDS = new Set(['if', 'elif', 'else', 'while'])

/** The `if`/`else`/`while` blocks a Python line sits inside, up to its enclosing `def` or `class`. */
function pyGuard(lines: string[], i: number): string {
  let ind = indentOf(lines[i]!)
  const kinds: string[] = []
  for (let k = i - 1, n = 0; k >= 0 && ind > 0 && n < 200; k--, n++) {
    const l = lines[k]!
    if (l.trim() === '' || indentOf(l) >= ind) continue
    ind = indentOf(l)
    const word = /^\s*(\w+)/.exec(l)?.[1] ?? ''
    if (word === 'def' || word === 'async' || word === 'class') break
    if (PY_GUARDS.has(word)) kinds.push(word)
  }

  return kinds.join('>')
}

const GO_IF = /^\s*(?:\}\s*else\s*)?if\b.*\{\s*$/
const GO_FAIL_LINE = /^\s*t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b/

type Line = { raw: string; norm: string; guard: string }

/**
 * The lines of the comment-free text that hold an assertion. A statement whose
 * parentheses stay open runs on over the next lines (at most 10), so a
 * multi-line `expect(` is compared whole and a changed expected value is seen.
 * In Go the `if` line above a `t.Errorf` is part of the assertion (that is where
 * the comparison is), and in Python `guard` names the `if`/`while` blocks around it.
 */
export function assertionLines(text: string, f: Family): Line[] {
  const lines = stripComments(text, f).split('\n')
  const res = R[f].assertions.map(re => new RegExp(re.source, re.flags.replace('g', '')))
  const out: Line[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!res.some(re => re.test(lines[i]!))) continue
    let raw = lines[i]!.trim()
    let open = f === 'snap' ? 0 : parens(lines[i]!)
    for (let j = i + 1; open > 0 && j < lines.length && j <= i + 10; j++) {
      raw += ' ' + lines[j]!.trim()
      open += parens(lines[j]!)
    }
    if (f === 'go' && GO_FAIL_LINE.test(lines[i]!)) {
      let p = i - 1
      while (p >= 0 && lines[p]!.trim() === '') p--
      if (p >= 0 && GO_IF.test(lines[p]!)) raw = lines[p]!.trim() + ' ' + raw
    }
    out.push({ raw, norm: normText(raw), guard: f === 'py' ? pyGuard(lines, i) : '' })
  }

  return out
}

/** Applies an Edit the way the Edit tool does; undefined when the tool would fail. */
export function applyEdit(cur: string, o: string, n: string, all: boolean): string | undefined {
  if (o === '') return undefined
  const first = cur.indexOf(o)
  if (first === -1) return undefined
  if (!all) {
    if (cur.indexOf(o, first + 1) !== -1) return undefined

    return cur.slice(0, first) + n + cur.slice(first + o.length)
  }
  let out = ''
  let at = 0
  for (let i = first; i !== -1; i = cur.indexOf(o, at)) {
    out += cur.slice(at, i) + n
    at = i + o.length
  }

  return out + cur.slice(at)
}

const SUPPRESSIONS: [string, RegExp][] = [
  ['@ts-ignore', /@ts-ignore\b/g],
  ['@ts-nocheck', /@ts-nocheck\b/g],
  ['@ts-expect-error', /@ts-expect-error\b/g],
  ['eslint-disable', /eslint-disable(?:-next-line|-line)?\b/g],
  ['# type: ignore', /#\s*type:\s*ignore\b/g],
  ['# noqa', /#\s*noqa\b/g],
  ['pylint: disable', /pylint:\s*disable\b/g],
  ['//nolint', /\/\/\s*nolint\b/g],
  ['#[allow(…)]', /#!?\[allow\(/g],
  ['@SuppressWarnings', /@SuppressWarnings\b/g],
  ['istanbul ignore', /istanbul\s+ignore\b/g],
  ['c8 ignore', /c8\s+ignore\b/g],
  ['pragma: no cover', /pragma:\s*no\s*cover\b/g],
]

/** The check-suppression kinds whose count rose from `before` to `after`. */
export function suppressionsAdded(before: string, after: string): string[] {
  return SUPPRESSIONS.filter(([, re]) => count(after, [re]) > count(before, [re])).map(([kind]) => kind)
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const clip = (s: string): string => (s.length > 80 ? s.slice(0, 80) + '…' : s)

const uniq = (ls: Line[]): Line[] => {
  const seen = new Set<string>()

  return ls.filter(l => !seen.has(l.norm) && (seen.add(l.norm), true))
}

const bag = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)

  return m
}

// What an assertion says: literals (the expected values), then the assertion call, matcher and operators.
const TOKEN =
  /(["'`])(?:\\.|(?!\1)[^\\\n])*\1|\b\d+(?:\.\d+)?\b|\b(?:true|false|null|undefined|None|True|False|nil)\b|\.(?:not|to[A-Z]\w*|resolves|rejects|should)\b|===|!==|==|!=|<=|>=|(?<![=<>-])[<>](?![=>])|\b(?:assert|Assert|XCTAssert|require|verify)[.\w]*(?=[\s(!])|\bexpect(?=\s*[({])|\bis_expected\b|\bt\.[A-Za-z]\w*/g

const isLiteral = (tok: string): boolean => /^(?:["'`]|\d|(?:true|false|null|undefined|None|True|False|nil)$)/.test(tok)

// A test's title says nothing about what it expects, so it is not one of the tokens.
const TITLE = /(?<![.\w$])(?:it|test|specify|scenario|example)(?:\.\w+)*\s*\(?\s*(["'`])(?:\\.|(?!\1)[^\\\n])*\1\s*,?/g

// In Go the message of a `t.Errorf` says how a failure reads, not what is expected, so its strings are not tokens.
const GO_REPORT = /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|Log|Logf|Skip|Skipf)\s*\([^\n]*/g

function tokens(text: string, f: Family): string[] {
  const t = f === 'go' ? text.replace(GO_REPORT, m => m.replace(STRING, ' ')) : text

  return (t.replace(TITLE, ' ').match(TOKEN) ?? []).map(x => (/^["'`]/.test(x) ? `"${x.slice(1, -1)}"` : x))
}

/** The tokens whose count in the whole file fell from `before` to `after`, with how many fewer there are. */
function lostTokens(before: string, after: string, f: Family): Map<string, number> {
  const now = bag(tokens(stripComments(after, f), f))
  const out = new Map<string, number>()
  for (const [k, n] of bag(tokens(stripComments(before, f), f))) if (n > (now.get(k) ?? 0)) out.set(k, n - (now.get(k) ?? 0))

  return out
}

const STRING = /(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g

/** The names called in the given lines (`name(`), outside string literals. */
function callees(lines: Line[]): Set<string> {
  const out = new Set<string>()
  for (const l of lines) for (const m of l.raw.replace(STRING, '""').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]!)

  return out
}

/**
 * Whether dropping the `lost` assertion lines (baseline assertions that no
 * longer appear anywhere) in favour of the `gained` ones weakens the test.
 * It does when an expected value (a literal) is gone from the file, when every
 * one was just deleted, or when a one-for-one rewrite changes anything else
 * about the assertion. A literal that merely moved (into a `test.each` table,
 * a helper's arguments, a merged assertion) is still in the file, so merging
 * assertions, extracting helpers and renaming what is called are not weakening.
 */
function weakened(lost: Line[], gained: Line[], gone: Map<string, number>, afterText: string, f: Family): boolean {
  if (lost.length === 0) return false
  if (gained.length === 0) return true
  const lb = bag(lost.flatMap(l => tokens(l.raw, f)))
  const gb = bag(gained.flatMap(l => tokens(l.raw, f)))
  const short = (k: string): boolean => (lb.get(k) ?? 0) > (gb.get(k) ?? 0) && gone.has(k)
  const keys = [...lb.keys()]
  if (keys.some(k => isLiteral(k) && short(k))) return true
  if (gained.length !== lost.length) return false
  if (keys.some(short) || [...gb].some(([k, n]) => n > (lb.get(k) ?? 0))) return true

  // Same values and matchers, but the call under test was swapped for another while the old one is
  // still in use elsewhere (`slug(x)` became `fileSlug(x)`). Renaming it everywhere is not a swap.
  const gc = callees(gained)
  const text = afterText.replace(STRING, '""')

  return [...callees(lost)].some(c => !gc.has(c) && new RegExp(`(?<![\\w$.])${c.replace(/\$/g, '\\$')}\\b`).test(text))
}

// An added message argument says nothing about what is expected: `assert x == 3, 'adds'`,
// `assertEquals("adds", 3, f())`, `assert.Equal(t, 3, f(), "adds")`.
const PY_MSG = /,\s*(["'])(?:\\.|(?!\1)[^\\\n])*\1\s*$/
const PY_CALL_MSG = /,\s*(["'])(?:\\.|(?!\1)[^\\\n])*\1\s*\)\s*$/
const JVM_MSG = /\b(assert\w+)\(\s*(["'])(?:\\.|(?!\2)[^\\\n])*\2\s*,\s*/
const GO_MSG = /,\s*(["'`])(?:\\.|(?!\1)[^\\\n])*\1\s*\)\s*$/

/** The assertion without a message argument it carries (the text itself when it has none). */
function withoutMessage(raw: string, f: Family): string {
  if (f === 'py') {
    if (/^assert\b/.test(raw)) return raw.replace(PY_MSG, '')
    if (/^self\.assert(?!\w*(?:Regex|Match))/.test(raw)) return raw.replace(PY_CALL_MSG, ')')
  }
  if (f === 'jvm') return raw.replace(JVM_MSG, '$1(')
  if (f === 'go' && /^(?:assert|require)\./.test(raw)) return raw.replace(GO_MSG, ')')

  return raw
}

// Constructs that make an assertion unable to fail: an `if` that is never true.
const NEVER_TRUE: Partial<Record<Family, RegExp>> = {
  js: /\bif\s*\(\s*(?:false|0|!true)\s*\)/g,
  jvm: /\bif\s*\(\s*(?:false|0|!true)\s*\)/g,
  cs: /\bif\s*\(\s*(?:false|0|!true)\s*\)/g,
  php: /\bif\s*\(\s*(?:false|0|!true)\s*\)/g,
  go: /\bif\s+(?:false|0)\s*\{/g,
  rs: /\bif\s+false\s*\{/g,
  swift: /\bif\s+false\s*\{/g,
  py: /^\s*(?:if|while)\s+(?:False|0|None)\s*:/gm,
  rb: /\bif\s+(?:false|nil)\b|\bunless\s+true\b|\brescue\s+nil\b/g,
}

const nonGlobal = (re: RegExp): RegExp => new RegExp(re.source, re.flags.replace('g', ''))

/** Brace languages: `try { ...assertion... } catch {}` hides a failure. Counts those blocks. */
function swallowedBraces(text: string, f: Family): number {
  const res = R[f].assertions.map(nonGlobal)
  let n = 0
  for (const m of text.matchAll(/\btry\s*\{/g)) {
    const start = m.index! + m[0].length
    let depth = 1
    let j = start
    while (j < text.length && depth > 0) {
      const c = text[j]
      if (c === '{') depth++
      else if (c === '}') depth--
      j++
    }
    if (depth !== 0 || !/^\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(text.slice(j, j + 200))) continue
    const body = text.slice(start, j - 1)
    if (res.some(re => re.test(body))) n++
  }

  return n
}

/** Python: `try:` with an assertion in it and an `except` whose body is `pass`. Counts those blocks. */
function swallowedPy(text: string): number {
  const lines = text.split('\n')
  const res = R.py.assertions.map(nonGlobal)
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*try\s*:/.test(lines[i]!)) continue
    const ind = indentOf(lines[i]!)
    let e = i + 1
    while (e < lines.length && (lines[e]!.trim() === '' || indentOf(lines[e]!) > ind)) e++
    const handler = e < lines.length && indentOf(lines[e]!) === ind ? /^\s*except\b[^:\n]*:\s*(\S.*)?$/.exec(lines[e]!) : null
    if (handler === null || handler === undefined) continue
    let rest = handler[1]?.trim()
    if (rest === undefined) {
      let k = e + 1
      while (k < lines.length && lines[k]!.trim() === '') k++
      rest = k < lines.length && indentOf(lines[k]!) > ind ? lines[k]!.trim() : ''
    }
    if (rest !== 'pass' && rest !== '...') continue
    if (res.some(re => re.test(lines.slice(i + 1, e).join('\n')))) n++
  }

  return n
}

/** How many constructs in the comment-free text keep an assertion from ever failing. */
function blinds(text: string, f: Family): number {
  const never = NEVER_TRUE[f]
  const ifs = never === undefined ? 0 : (text.match(never)?.length ?? 0)
  const swallowed = f === 'py' ? swallowedPy(text) : ['js', 'jvm', 'cs', 'php'].includes(f) ? swallowedBraces(text, f) : 0

  return ifs + swallowed
}

/**
 * Judges one change to a test-bearing file. `baseline` is the file as the
 * session first saw it (empty when Claude created it), `before` the file as it
 * is now, `after` the file once the change lands, and `red` whether the latest
 * test run failed (it only adds a note). Only assertions that were in the
 * baseline are protected: ones Claude added since may be edited freely.
 */
export function judgeTestFile(rel: string, baseline: string, before: string, after: string, red: boolean): FileVerdict {
  const f = familyOf(rel)
  if (f === undefined) return { kind: 'allow' }
  const b = measure(before, f)
  const a = measure(after, f)
  const track: Track = { file: rel, before: b.assertions, after: a.assertions }
  const ask = (summary: string, reason: string): FileVerdict => ({ kind: 'ask', file: rel, summary, reason, track })

  const baseLines = assertionLines(baseline, f)
  const base = new Set(baseLines.map(l => l.norm))
  const bLines = assertionLines(before, f)
  const aLines = assertionLines(after, f)
  const inAfter = new Set(aLines.map(l => l.norm))
  const inBefore = new Set(bLines.map(l => l.norm))
  let lost = uniq(bLines.filter(l => base.has(l.norm) && !inAfter.has(l.norm)))
  let gained = uniq(aLines.filter(l => !inBefore.has(l.norm)))

  // An assertion that only gained a message argument is not rewritten.
  const lostNorms = new Set(lost.map(l => l.norm))
  const withMessage = new Set<string>()
  const messageOnly = gained.filter(g => {
    const plain = normText(withoutMessage(g.raw, f))
    if (plain === g.norm || !lostNorms.has(plain) || withMessage.has(plain)) return false
    withMessage.add(plain)

    return true
  })
  if (messageOnly.length > 0) {
    lost = lost.filter(l => !withMessage.has(l.norm))
    gained = gained.filter(g => !messageOnly.includes(g))
  }

  const weak = weakened(lost, gained, lostTokens(before, after, f), stripComments(after, f), f)

  const parts: string[] = []
  if (after.trim() === '' && before.trim() !== '' && baseline.trim() !== '') parts.push('empties the file')
  if (weak && b.assertions > a.assertions) parts.push(`removes ${b.assertions - a.assertions} of ${plural(b.assertions, 'assertion')}`)
  if (weak && b.tests > a.tests) parts.push(`removes ${b.tests - a.tests} of ${plural(b.tests, 'test')}`)
  // Fewer tests but no fewer assertions: a test was disabled by taking away what marks it as one (`def test_b` to `def _b`, a removed `#[test]` or `@Test`).
  if (!weak && b.tests > a.tests && a.assertions >= b.assertions) {
    parts.push(`stops ${b.tests - a.tests} of ${plural(b.tests, 'test')} from being run as a test (the marker that makes it one is gone, the assertions are not)`)
  }
  if (a.skips > b.skips) parts.push(`adds ${plural(a.skips - b.skips, 'skip marker')}`)
  if (a.focus > b.focus) parts.push(`adds ${plural(a.focus - b.focus, 'focus marker')} (.only), which stops the other tests from running`)
  if (a.tautologies > b.tautologies) parts.push(`adds ${plural(a.tautologies - b.tautologies, 'always-true assertion')}`)
  if (baseline.trim() !== '') {
    const blind = blinds(stripComments(after, f), f) - blinds(stripComments(before, f), f)
    if (blind > 0) parts.push(`adds ${plural(blind, 'construct')} that keep an assertion from ever failing (an always-false \`if\`, or a \`try\` that swallows it)`)
    if (f === 'py') {
      const was = new Set(bLines.map(l => `${l.guard}|${l.norm}`))
      const nested = uniq(aLines.filter(l => l.guard !== '' && base.has(l.norm) && !was.has(`${l.guard}|${l.norm}`)))
      if (nested.length > 0) parts.push(`puts ${plural(nested.length, 'existing assertion')} under a new \`if\`, \`else\` or \`while\`, where it may never run`)
    }
  }
  if (parts.length > 0) {
    const summary = parts.join(', ')

    return ask(summary, `${rel}: ${summary}. A weaker test needs the user's yes. Fix the code under test, or tell the user why this test is wrong.`)
  }

  if (weak && f !== 'snap') {
    const what = gained[0] === undefined ? `(\`${clip(lost[0]!.raw)}\` was removed)` : `(\`${clip(lost[0]!.raw)}\` became \`${clip(gained[0].raw)}\`)`

    return ask(
      `rewrites ${plural(lost.length, 'existing assertion')}`,
      `${rel}: rewrites ${plural(lost.length, 'existing assertion')} ${what}. Changing what a test expects needs the user's yes. Fix the code under test, or tell the user why this test is wrong.`,
    )
  }

  // A stored snapshot is generated, so any hand edit to one that existed before the session is suspect.
  if (f === 'snap' && baseline.trim() !== '' && before.trim() !== '') {
    return ask(
      'edits a stored snapshot by hand',
      `${rel}: edits a stored snapshot by hand. That makes a snapshot test pass without checking the output, so it needs the user's yes.`,
    )
  }

  const kinds = suppressionsAdded(before, after)
  if (red || kinds.length > 0) return { kind: 'note', file: rel, editedAfterRed: red, kinds, track }

  return { kind: 'allow', track }
}

/** The text of a Rust file that holds its tests: from `#[cfg(test)]` on when `hasCfg`, else all of it. */
export function rustTests(text: string, hasCfg: boolean): string {
  if (!hasCfg) return text
  const i = text.indexOf('#[cfg(test)]')

  return i === -1 ? '' : text.slice(i)
}
