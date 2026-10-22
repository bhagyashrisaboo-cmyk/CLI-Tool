/**
 * Tiny levelled logger.
 *  - Console (stderr): warnings and errors by default, info with --verbose,
 *    debug with --debug. Silent with --quiet.
 *  - File: everything at debug level, appended to <home>/actiontrack.log,
 *    so problems can be investigated after the fact.
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

class Logger {
  constructor() {
    this.consoleLevel = LEVELS.warn;
    this.filePath = null;
    this.stream = process.stderr;
  }

  configure({ level = 'warn', filePath = null, stream = process.stderr } = {}) {
    this.stream = stream;
    this.consoleLevel = LEVELS[level] ?? LEVELS.warn;
    this.filePath = filePath;
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch {
        this.filePath = null;
      }
    }
  }

  log(level, msg) {
    if (LEVELS[level] >= this.consoleLevel) {
      this.stream.write(`${level === 'info' ? '' : `${level}: `}${msg}\n`);
    }
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}\n`);
      } catch {
        this.filePath = null; // never let logging break the command
      }
    }
  }

  debug(msg) { this.log('debug', msg); }
  info(msg) { this.log('info', msg); }
  warn(msg) { this.log('warn', msg); }
  error(msg) { this.log('error', msg); }
}

export const logger = new Logger();
