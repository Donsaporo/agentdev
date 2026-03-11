type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'];

function format(level: LogLevel, module: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] [${module}] ${msg}`;
  return data ? `${base} ${JSON.stringify(data)}` : base;
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: unknown) => {
      if (LEVELS.debug >= threshold) console.debug(format('debug', module, msg, data));
    },
    info: (msg: string, data?: unknown) => {
      if (LEVELS.info >= threshold) console.info(format('info', module, msg, data));
    },
    warn: (msg: string, data?: unknown) => {
      if (LEVELS.warn >= threshold) console.warn(format('warn', module, msg, data));
    },
    error: (msg: string, data?: unknown) => {
      if (LEVELS.error >= threshold) console.error(format('error', module, msg, data));
    },
  };
}
