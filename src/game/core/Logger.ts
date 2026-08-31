/**
 * Lightweight leveled logger with ring-buffer history (surfaced in the Options
 * screen's diagnostics panel). Keeps the console tidy in production builds.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  t: number
  level: LogLevel
  scope: string
  message: string
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

class LoggerImpl {
  private minLevel: LogLevel = import.meta.env.DEV ? 'debug' : 'info'
  private readonly history: LogEntry[] = []
  private readonly maxHistory = 200

  setLevel(level: LogLevel): void {
    this.minLevel = level
  }

  scope(scope: string) {
    return {
      debug: (msg: string, ...rest: unknown[]) => this.log('debug', scope, msg, rest),
      info: (msg: string, ...rest: unknown[]) => this.log('info', scope, msg, rest),
      warn: (msg: string, ...rest: unknown[]) => this.log('warn', scope, msg, rest),
      error: (msg: string, ...rest: unknown[]) => this.log('error', scope, msg, rest),
    }
  }

  getHistory(): readonly LogEntry[] {
    return this.history
  }

  private log(level: LogLevel, scope: string, message: string, rest: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    this.history.push({ t: performance.now(), level, scope, message })
    if (this.history.length > this.maxHistory) this.history.shift()
    const prefix = `%c[${scope}]`
    const style = level === 'error' ? 'color:#ff5c7a' : level === 'warn' ? 'color:#ffb347' : 'color:#7ef0ff'
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.info
    fn(prefix, style, message, ...rest)
  }
}

export const Logger = new LoggerImpl()
