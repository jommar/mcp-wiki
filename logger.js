import fs from 'fs';
import path from 'path';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
const LOG_DIR = process.env.LOG_DIR || path.resolve(import.meta.dirname, 'logs');
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS, 10) || 10;
const LOG_PREFIX = 'wiki';

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function logFileName(date = new Date()) {
  return `${LOG_PREFIX}-${dateStamp(date)}.log`;
}

function format(level, message, data) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (!data) return base;
  return `${base} ${JSON.stringify(data)}`;
}

let currentStream = null;
let currentDate = null;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getStream() {
  const today = dateStamp();

  if (currentStream && currentDate === today) return currentStream;

  if (currentStream) currentStream.end();

  ensureDir();
  const filePath = path.join(LOG_DIR, logFileName());
  currentStream = fs.createWriteStream(filePath, { flags: 'a' });
  currentDate = today;

  return currentStream;
}

function writeToFile(formatted) {
  try {
    const stream = getStream();
    stream.write(formatted + '\n');
  } catch {
    // file logging failure should never crash the server
  }
}

function purgeOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS);
    const cutoffStamp = dateStamp(cutoff);

    const files = fs.readdirSync(LOG_DIR);
    for (const file of files) {
      if (!file.startsWith(LOG_PREFIX) || !file.endsWith('.log')) continue;

      const stamp = file.slice(LOG_PREFIX.length + 1, file.length - 4); // extract YYYY-MM-DD
      if (stamp < cutoffStamp) {
        fs.unlinkSync(path.join(LOG_DIR, file));
      }
    }
  } catch {
    // purge failure should never crash the server
  }
}

// Purge on startup
purgeOldLogs();

// Purge daily at midnight + check for log rotation
const maintenanceInterval = setInterval(() => {
  purgeOldLogs();
  // Force stream rotation check on next write
  const today = dateStamp();
  if (currentDate !== today) {
    if (currentStream) currentStream.end();
    currentStream = null;
    currentDate = null;
  }
}, 60 * 60 * 1000); // every hour is enough — rotation happens lazily on next write

maintenanceInterval.unref();

export const logger = {
  debug(message, data) {
    if (LOG_LEVEL > LEVELS.debug) return;
    const line = format('debug', message, data);
    console.error(line);
    writeToFile(line);
  },

  info(message, data) {
    if (LOG_LEVEL > LEVELS.info) return;
    const line = format('info', message, data);
    console.error(line);
    writeToFile(line);
  },

  warn(message, data) {
    if (LOG_LEVEL > LEVELS.warn) return;
    const line = format('warn', message, data);
    console.error(line);
    writeToFile(line);
  },

  error(message, data) {
    if (LOG_LEVEL > LEVELS.error) return;
    const line = format('error', message, data);
    console.error(line);
    writeToFile(line);
  },

  /** Write a line synchronously to the log file. Used during process exit when async writes may not flush. */
  flushSync(level, message, data) {
    const line = format(level, message, data);
    console.error(line);
    try {
      ensureDir();
      fs.appendFileSync(path.join(LOG_DIR, logFileName()), line + '\n');
    } catch {
      // best-effort; never crash during exit
    }
  },

  /** Close the active log stream. Call on shutdown. */
  close() {
    clearInterval(maintenanceInterval);
    if (currentStream) {
      return new Promise((resolve) => {
        currentStream.end(() => {
          currentStream = null;
          currentDate = null;
          resolve();
        });
      });
    }
    return Promise.resolve();
  },
};
