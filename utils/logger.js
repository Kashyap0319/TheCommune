/**
 * Structured logger with timestamps and log levels.
 * Set LOG_LEVEL env var to: ERROR, WARN, INFO (default), or DEBUG
 */

const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function log(level, ...args) {
    if (LEVELS[level] > currentLevel) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level}]`;
    if (level === 'ERROR') console.error(prefix, ...args);
    else if (level === 'WARN') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
}

module.exports = {
    error: (...args) => log('ERROR', ...args),
    warn: (...args) => log('WARN', ...args),
    info: (...args) => log('INFO', ...args),
    debug: (...args) => log('DEBUG', ...args),
};
