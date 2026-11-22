// Pure shell-command analysis: what a Bash command does to test files.
import { isTestFileName, isTestPath } from './analyze'

export type ShellVerdict = { kind: 'allow' } | { kind: 'ask'; file: string; summary: string; reason: string }

const WRAPPERS = new Set(['sudo', 'env', 'command', 'time', 'nice'])

/** Splits a command into segments on && || ; | and newlines (outside quotes), then into tokens. */
export function segments(cmd: string): string[][] {
  const raw: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote !== '') {
      if (c === quote) quote = ''
      cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      raw.push(cur)
      cur = ''
      if ((c === '|' && cmd[i + 1] === '|') || c === '&') i++
    } else {
      cur += c
    }
  }
  raw.push(cur)

  const out: string[][] = []
  for (const part of raw) {
    const tokens = [...part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
    while (tokens.length > 0 && (/^[A-Za-z_]\w*=/.test(tokens[0]!) || WRAPPERS.has(tokens[0]!))) tokens.shift()
    if (tokens.length > 0) out.push(tokens)
  }

  return out
}

const RUNNER =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpx\s+(?:jest|vitest|mocha|ava|playwright\s+test)\b|(?:^|[\s;&|(])(?:jest|vitest|mocha|ava|pytest|py\.test|tox|nox|rspec|phpunit|pest)\b|\bgo\s+test\b|\bcargo\s+(?:test|nextest)\b|\bnode\s+(?:[^|;&]*\s)?--test\b|\bdeno\s+test\b|\bdotnet\s+test\b|\bmvnw?\b[^|;&]*\btest\b|\bgradlew?\b[^|;&]*\btest\b|\bmake\s+(?:test|check)\b|\bctest\b|\bswift\s+test\b|\bmix\s+test\b|\bbundle\s+exec\s+(?:rspec|rake\s+(?:test|spec))\b|\brake\s+(?:test|spec)\b|\brails\s+(?:test|spec)\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b/

// Commands that only mention a runner (install it, print it, search for it).
const NOT_A_RUN = new Set([
  'echo', 'printf', 'cat', 'grep', 'rg', 'ls', 'which', 'type', 'man', 'pip', 'pip3', 'apt', 'apt-get', 'brew', 'git',
  'cd', 'head', 'tail', 'less', 'vim', 'nano', 'code', 'open', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'sed', 'awk', 'find', 'wc', 'diff',
])

/** True when some segment of the command runs a known test runner. */
export function isTestCommand(cmd: string): boolean {
  return segments(cmd).some(seg => !NOT_A_RUN.has(seg[0]!) && RUNNER.test(seg.join(' ')))
}

// Lines that only a failing run prints, per runner. Each is anchored to a line start, so a test
// named "handles 2 failed logins" in a passing run does not match.
const FAILED_OUTPUT: RegExp[] = [
  /^(?:ℹ|#) fail [1-9]/m, // node:test, tap
  /^not ok\b/m, // tap
  /^\s*(?:Tests?|Test Suites?|Test Files?):?\s+.*\b[1-9]\d* failed\b/m, // jest, vitest
  /^\s*FAIL\s+\S/m, // jest, vitest, go test (FAIL <pkg>)
  /^FAIL$/m, // go test
  /^\s*--- FAIL:/m, // go test
  /^\s*[✖✕×]\s/mu, // node:test spec reporter, jest, vitest
  /^(?:=+\s*)?(?:[1-9]\d* (?:failed|errors?)\b|FAILED\b)/m, // pytest
  /^FAILED \((?:failures|errors)=/m, // unittest
  /^\s*[1-9]\d* failing\b/m, // mocha
  /^\s*[1-9]\d* tests? failed\b/m, // ava
  /\btest result: FAILED\b|^test .* \.\.\. FAILED$|^error: (?:test failed|could not compile)/m, // cargo
  /^\s*\d+ (?:examples?|runs|tests?),.*\b[1-9]\d* (?:failures?|errors?)\b/m, // rspec, rake test, minitest
  /^Tests run:.*\b(?:Failures|Errors): [1-9]|^\s*\d+ tests? completed, [1-9]\d* failed|^BUILD FAILED/m, // maven, gradle
  /^Failed!\s+-\s+Failed:\s*[1-9]|^\s*Failed:\s*[1-9]\d*,/m, // dotnet
  /^FAILURES!|^Tests: \d+,.*\b(?:Failures|Errors): [1-9]/m, // phpunit
  /\|\s*[1-9]\d* failed\b/, // deno
  /^Executed \d+ tests?, with [1-9]\d* failures?/m, // swift, xctest
  /\b[1-9]\d* tests? failed out of\b/, // ctest
  /^\(fail\)\s|^\s*[1-9]\d* fail\s*$/m, // bun
  /^=+ (?:FAILURES|ERRORS) =+$/m, // pytest, when `| head` cut the summary off
]

/**
 * True when a test run's own output shows failures. The exit code alone is not
 * enough: `node --test 2>&1 | tail -80` exits 0 even when tests fail.
 */
export function testOutputFailed(text: string): boolean {
  return FAILED_OUTPUT.some(re => re.test(text))
}

const DEPS = /(^|\/)node_modules\//

/** True when a command argument names a test file or a test folder. */
export function isTestish(tok: string): boolean {
  const t = tok.replace(/^\.\//, '').replace(/^["']|["']$/g, '')
  if (t === '' || DEPS.test(t)) return false

  return isTestPath(t) || /(^|\/)(tests?|__tests__|specs?|e2e)\/?$/.test(t) || /\*\.(test|spec)\.|_test\.go$|(^|\/)test_\*|\*_test\.py/.test(t)
}

const flagless = (toks: string[]): string[] => toks.filter(t => !t.startsWith('-'))

// Generated or throwaway paths inside test folders: deleting or overwriting them weakens nothing.
// A file that is itself named like a test (`out/a.test.js`) is never noise.
const NOISE = /(^|\/)(?:__pycache__|\.pytest_cache|\.cache|out|tmp|output|dist|reports|coverage|target|build)(?:\/|$)|\.(?:log|txt|db|pyc)$/
const noise = (tok: string): boolean => {
  const t = tok.replace(/^\.\//, '')

  return NOISE.test(t) && !isTestFileName(t)
}

/** The words of a command that may name a file: every token, with a leading `>` or `>>` taken off. */
export function mentionedFiles(cmd: string): string[] {
  return [...new Set(segments(cmd).flat().map(t => t.replace(/^>>?/, '')).filter(t => t !== '' && !t.startsWith('-')))]
}

type Hit = { file: string; summary: string }

const SNAPSHOT_FLAGS = new Set(['-u', '--update', '--update-snapshot', '--updateSnapshot', '--update-snapshots', '--snapshot-update'])

function deletes(seg: string[], testish: (t: string) => boolean): Hit | undefined {
  const [cmd, sub] = seg
  const rm = ['rm', 'unlink', 'rmdir', 'trash', 'shred'].includes(cmd!) || (cmd === 'git' && sub === 'rm')
  const find = cmd === 'find' && (seg.includes('-delete') || seg.some((t, i) => t === '-exec' && seg[i + 1] === 'rm'))
  if (!rm && !find) return undefined
  // `find tests -name __pycache__ -exec rm -rf {} +` only removes what the pattern names.
  if (find && seg.some((t, i) => /^-(?:i?name|i?path|iwholename|wholename)$/.test(t) && noise(seg[i + 1] ?? ''))) return undefined
  const files = flagless(seg.slice(1)).filter(t => testish(t) && !noise(t))

  return files.length === 0 ? undefined : { file: files[0]!, summary: `deletes test files from the shell (${files.join(', ')})` }
}

function moves(seg: string[], testish: (t: string) => boolean): Hit | undefined {
  const mv = seg[0] === 'mv' || (seg[0] === 'git' && seg[1] === 'mv')
  if (!mv) return undefined
  const args = flagless(seg.slice(seg[0] === 'git' ? 2 : 1))
  if (args.length < 2) return undefined
  const dest = args[args.length - 1]!
  const src = args.slice(0, -1).find(testish)
  if (src === undefined) return undefined
  // Into a folder, or to a new name that a runner still collects, the test stays in the suite.
  const folder = /\/$/.test(dest) || !/\./.test(dest.slice(dest.lastIndexOf('/') + 1))
  const stays = testish(dest) && (folder || !isTestFileName(src) || isTestFileName(dest))
  if (stays) return undefined

  return { file: src, summary: `moves a test file out of the test suite (${src} → ${dest})` }
}

function editsInPlace(seg: string[], testish: (t: string) => boolean): Hit | undefined {
  const [cmd] = seg
  const inPlace =
    (['sed', 'perl', 'ruby'].includes(cmd!) && seg.slice(1).some(t => /^-[a-zA-Z]*i/.test(t) || t === '--in-place' || t.startsWith('--in-place='))) ||
    ((cmd === 'awk' || cmd === 'gawk') && seg.some((t, i) => t === '-i' && seg[i + 1] === 'inplace')) ||
    cmd === 'ed' ||
    cmd === 'ex'
  if (!inPlace) return undefined
  const files = flagless(seg.slice(1)).filter(testish)

  return files.length === 0 ? undefined : { file: files[0]!, summary: `edits a test file in place (${files.join(', ')})` }
}

/** The target of a single `>` redirect in the segment, if any (`>>`, `2>`, `&>` and `>&` do not count). */
function redirectTarget(seg: string[]): string | undefined {
  for (let i = 0; i < seg.length; i++) {
    const m = /^>(?![>&|])(.*)$/.exec(seg[i]!)
    if (m) return m[1] !== '' ? m[1] : seg[i + 1]
  }

  return undefined
}

function overwrites(seg: string[], testish: (t: string) => boolean, exists: (t: string) => boolean): Hit | undefined {
  const target = redirectTarget(seg)
  // Writing a file that does not exist yet creates it: nothing is overwritten.
  const hits = (t: string): boolean => testish(t) && !noise(t) && exists(t)
  let file: string | undefined = target !== undefined && hits(target) ? target : undefined
  if (file === undefined && seg[0] === 'tee' && !seg.some(t => t === '-a' || t === '--append')) file = flagless(seg.slice(1)).find(hits)
  if (file === undefined && seg[0] === 'truncate') file = flagless(seg.slice(1)).find(hits)
  if (file === undefined && seg[0] === 'cp') {
    const args = flagless(seg.slice(1))
    const dest = args.length >= 2 ? args[args.length - 1]! : undefined
    if (dest !== undefined && hits(dest)) file = dest
  }

  return file === undefined ? undefined : { file, summary: `overwrites a test file (${file})` }
}

function reverts(seg: string[], testish: (t: string) => boolean): Hit | undefined {
  if (seg[0] !== 'git' || (seg[1] !== 'checkout' && seg[1] !== 'restore')) return undefined
  const rest = seg.slice(2)
  // A new branch or a bare unstage reverts no file.
  if (rest.some(t => ['-b', '-B', '-c', '-C', '--orphan', '--detach'].includes(t))) return undefined
  if (rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')) return undefined
  const dd = rest.indexOf('--')
  const files = flagless(dd === -1 ? rest : rest.slice(dd + 1)).filter(testish)

  return files.length === 0 ? undefined : { file: files[0]!, summary: `reverts a test file to an older version (${files.join(', ')})` }
}

/**
 * Judges a shell command. The first matching rule wins: delete, move out,
 * in-place edit, overwrite, revert, then snapshot regeneration.
 */
export function judgeShell(cmd: string, testish: (tok: string) => boolean, exists: (tok: string) => boolean = () => true): ShellVerdict {
  const segs = segments(cmd)
  const rules = [deletes, moves, editsInPlace, (seg: string[], t: (tok: string) => boolean) => overwrites(seg, t, exists), reverts]
  for (const rule of rules) {
    for (const seg of segs) {
      const hit = rule(seg, testish)
      if (hit !== undefined) {
        return {
          kind: 'ask',
          file: hit.file,
          summary: hit.summary,
          reason: `${hit.summary}, where tamperproof cannot check what changes. Use the Edit tool for test changes, or ask the user first.`,
        }
      }
    }
  }

  for (const seg of segs) {
    const insta = seg[0] === 'cargo' && seg[1] === 'insta' && (seg[2] === 'accept' || seg[2] === 'review')
    const plain = seg[0] === 'insta' && (seg[1] === 'accept' || seg[1] === 'review')
    const flag = seg.find(t => SNAPSHOT_FLAGS.has(t))
    const runner = isTestCommand(seg.join(' ')) || (seg[0] === 'cargo' && seg[1] === 'insta')
    if (!(insta || plain || (runner && flag !== undefined))) continue
    const what = flag ?? `insta ${insta ? seg[2] : seg[1]}`

    return {
      kind: 'ask',
      file: 'snapshots',
      summary: `regenerates test snapshots (${what})`,
      reason: `regenerates test snapshots to match the current output (${what}). That turns a failing snapshot test green without checking the output, so it needs the user's yes.`,
    }
  }

  return { kind: 'allow' }
}
