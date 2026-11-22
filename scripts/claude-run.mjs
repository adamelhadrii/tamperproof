// Shared by e2e/run.mjs and e2e/measure.mjs: run `claude -p` and read its stream-json.
import { spawn } from 'node:child_process'

/**
 * Runs one headless session. The prompt follows `--` because --allowedTools is variadic.
 * Returns { events, result, code, timedOut, stderr, wallMs }.
 */
export function runClaude({ cwd, prompt, args = [], env = {}, timeoutMs = 600000 }) {
  const started = Date.now()

  return new Promise(resolve => {
    const child = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...args, '--', prompt], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const events = []
    let buffer = ''
    let stderr = ''
    let timedOut = false
    const take = line => {
      try {
        events.push(JSON.parse(line))
      } catch {
        // Not a JSON line: skip it.
      }
    }
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') take(line)
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10000).unref()
    }, timeoutMs)
    const done = code => {
      clearTimeout(timer)
      if (buffer.trim() !== '') take(buffer)
      const result = events.findLast(e => e.type === 'result')
      resolve({ events, result, code, timedOut, stderr, wallMs: Date.now() - started })
    }
    child.on('error', err => {
      stderr += String(err)
      done(null)
    })
    child.on('close', done)
  })
}

/** Commands the engine refused: [{ tool, agentId, reason }]. */
export const denials = events =>
  events
    .filter(e => e.type === 'system' && e.subtype === 'permission_denied')
    .map(e => ({ tool: e.tool_name, agentId: e.agent_id, reason: e.decision_reason ?? '' }))

/** The numbers worth keeping from a result event. */
export function usage(result) {
  const stats = result?.subagent_stats ?? {}
  const models = {}
  for (const [id, m] of Object.entries(result?.modelUsage ?? {})) models[id] = m.costUSD

  return {
    costUsd: result?.total_cost_usd ?? 0,
    durationMs: result?.duration_ms ?? 0,
    turns: result?.num_turns ?? 0,
    isError: result?.is_error ?? true,
    spawned: stats.spawned ?? 0,
    failed: stats.failed ?? 0,
    models,
  }
}

/** Runs a plugin command such as `/tamperproof`; it costs nothing. Returns the printed text. */
export async function command(root, line, env = {}) {
  const { result } = await runClaude({ cwd: root, prompt: line, args: ['--plugin-dir', root, '--model', 'haiku'], env, timeoutMs: 120000 })

  return result?.result ?? ''
}
