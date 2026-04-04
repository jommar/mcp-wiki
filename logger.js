const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function format(level, message, data) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (!data) return base;
  return `${base} ${JSON.stringify(data)}`;
}

export const logger = {
  debug(message, data) {
    if (LOG_LEVEL <= LEVELS.debug) console.error(format('debug', message, data));
  },
  info(message, data) {
    if (LOG_LEVEL <= LEVELS.info) console.error(format('info', message, data));
  },
  warn(message, data) {
    if (LOG_LEVEL <= LEVELS.warn) console.error(format('warn', message, data));
  },
  error(message, data) {
    if (LOG_LEVEL <= LEVELS.error) console.error(format('error', message, data));
  },
};
