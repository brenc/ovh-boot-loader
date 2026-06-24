/** Logger options. The `env` and `moduleName` fields are accepted for
 * compatibility with the call sites inherited from the original tool but are
 * only used to format log lines.
 */
export interface LoggerOptions {
  /** When `true`, `debug` messages are printed. Otherwise they are dropped. */
  debug: boolean;
  /** Deployment environment (e.g. `"production"` or `"development"`). */
  env: 'production' | 'development';
  /** Short module name to prefix log lines with. */
  moduleName: string;
}

/** Minimal logger interface used by the CLI subcommands. */
export interface Logger {
  debug: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Format an ISO 8601 timestamp to a local-time, millisecond-precision string
 * suitable for log lines (e.g. `"2026-06-24 12:34:56.789"`).
 * @param date - Date instance to format
 * @returns Formatted timestamp
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Create a stdout/stderr logger that prefixes each line with a timestamp,
 * level, and module name. `debug` is silent unless `options.debug` is true.
 * @param options - Logger configuration
 * @returns Logger with `info`/`warn`/`error`/`debug` methods
 */
export function createLogger(options: LoggerOptions): Logger {
  const prefix = `[${options.moduleName}]`;
  const format = (level: string, msg: string): string =>
    `${formatTimestamp(new Date())} ${level.padEnd(5)} ${prefix} ${msg}`;

  return {
    debug: (msg: string) => {
      if (options.debug) console.log(format('DEBUG', msg));
    },
    error: (msg: string) => console.error(format('ERROR', msg)),
    info: (msg: string) => console.log(format('INFO', msg)),
    warn: (msg: string) => console.warn(format('WARN', msg)),
  };
}
