// Minimal structured logger — no external deps
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function log(level, msg, meta) {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const line = meta
    ? `[${ts()}] ${level.toUpperCase().padEnd(5)} ${msg} ${JSON.stringify(meta)}`
    : `[${ts()}] ${level.toUpperCase().padEnd(5)} ${msg}`;

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};

module.exports = logger;
