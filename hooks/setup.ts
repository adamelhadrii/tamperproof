// Pure checks on test-setup files: the places where a test run can be made to pass without testing anything.
import { isTestCommand } from './shell'

const SETUP =
  /^(?:package\.json|(?:jest|vitest|vite|karma|playwright|cypress|ava|mocha)\.config\.[cm]?[jt]s|\.mocharc.*|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|\.coveragerc|tsconfig.*\.json|phpunit\.xml(?:\.dist)?)$/

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

export function isSetupFile(rel: string): boolean {
  return SETUP.test(baseName(rel))
}

const ALWAYS_OK = ['|| true', '|| exit 0', '; exit 0', '--passWithNoTests', '--pass-with-no-tests']
const COVERAGE = /\b(branches|functions|lines|statements|fail_under|fail-under|cov-fail-under|minimum_coverage)\b["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/gi
const PYTEST_SKIP = /(?:^|[\s"'[,])(?:-k(?=[\s"'=])|--deselect\b|--ignore\b|--ignore-glob\b|-p\s+no:)/g

/** Parses JSON with comments and trailing commas (tsconfig style); undefined when it does not parse. */
function parseJsonc(text: string): unknown {
  let noComments = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      noComments += c
      if (c === '\\') noComments += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      noComments += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      noComments += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      noComments += ' '
    } else {
      noComments += c
    }
  }

  let clean = ''
  inString = false
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i]!
    if (inString) {
      clean += c
      if (c === '\\') clean += noComments[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      clean += c
    } else if (c === ',' && /^\s*[}\]]/.test(noComments.slice(i + 1))) {
      // trailing comma: drop it
    } else {
      clean += c
    }
  }
  try {
    return JSON.parse(clean)
  } catch {
    return undefined
  }
}

const asObject = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

function scriptParts(before: string, after: string): string[] {
  const b = asObject(asObject(parseJsonc(before))?.scripts)
  const a = asObject(asObject(parseJsonc(after))?.scripts)
  if (!b || !a) return []
  const parts: string[] = []
  for (const name of Object.keys(a)) {
    const was = b[name]
    const now = a[name]
    if (!/test|ci|check|verify/i.test(name) || typeof was !== 'string' || typeof now !== 'string') continue
    const token = ALWAYS_OK.find(t => now.includes(t) && !was.includes(t))
    if (token !== undefined) parts.push(`makes the "${name}" script always succeed (${token})`)
    else if (isTestCommand(was) && /^\s*(?:echo\b|true\b|exit\s+0\b|:)/.test(now)) parts.push(`replaces the "${name}" script with \`${now}\``)
  }

  return parts
}

function thresholdParts(before: string, after: string): string[] {
  const pairs = (text: string): Map<string, number[]> => {
    const out = new Map<string, number[]>()
    for (const m of text.matchAll(COVERAGE)) {
      const key = m[1]!.toLowerCase()
      out.set(key, [...(out.get(key) ?? []), Number(m[2])])
    }

    return out
  }
  const b = pairs(before)
  const a = pairs(after)
  const parts: string[] = []
  for (const [key, was] of b) {
    const now = a.get(key) ?? []
    for (let i = 0; i < Math.min(was.length, now.length); i++) {
      if (now[i]! < was[i]!) parts.push(`lowers the coverage threshold ${key} from ${was[i]} to ${now[i]}`)
    }
  }

  return parts
}

function tsconfigParts(before: string, after: string): string[] {
  const b = asObject(asObject(parseJsonc(before))?.compilerOptions)
  const a = asObject(asObject(parseJsonc(after))?.compilerOptions)
  if (!b || !a) return []

  return ['strict', 'noImplicitAny', 'strictNullChecks'].filter(flag => b[flag] === true && a[flag] !== true).map(flag => `turns off TypeScript's ${flag}`)
}

function pytestParts(before: string, after: string): string[] {
  const addopts = (text: string): string => {
    const lines = text.split('\n')
    const kept: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes('addopts')) continue
      kept.push(lines[i]!)
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) kept.push(lines[++i]!)
    }

    return kept.join('\n')
  }
  const was = addopts(before)
  const now = addopts(after)
  const rose = (now.match(PYTEST_SKIP)?.length ?? 0) > (was.match(PYTEST_SKIP)?.length ?? 0)
  if (!rose) return []
  const token = (now.match(PYTEST_SKIP) ?? []).map(t => t.replace(/^[\s"'[,]+/, '').trim()).find(t => !was.includes(t)) ?? 'a skip option'

  return [`makes pytest skip tests by default (${token})`]
}

/** What a change to a setup file weakens; empty when nothing. Any result needs the user's yes. */
export function judgeSetup(rel: string, before: string, after: string): string[] {
  const name = baseName(rel)
  const parts: string[] = []
  if (name === 'package.json') parts.push(...scriptParts(before, after))
  parts.push(...thresholdParts(before, after))
  if (/^tsconfig.*\.json$/.test(name)) parts.push(...tsconfigParts(before, after))
  if (/^(?:pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/.test(name)) parts.push(...pytestParts(before, after))

  return parts
}
