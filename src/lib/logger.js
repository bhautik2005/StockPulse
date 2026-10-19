/**
 * Minimal structured logger (JSON lines).
 *
 * Deliberately dependency-free: a portfolio/enterprise service needs correlated,
 * machine-parseable logs far more than it needs a logging framework.
 */
import { env } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, message, context) {
  if (LEVELS[level] < threshold) return;
  const record = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(context && Object.keys(context).length ? { ctx: context } : {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (msg, ctx) => emit('debug', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
  child(bound) {
    return {
      debug: (msg, ctx) => emit('debug', msg, { ...bound, ...ctx }),
      info: (msg, ctx) => emit('info', msg, { ...bound, ...ctx }),
      warn: (msg, ctx) => emit('warn', msg, { ...bound, ...ctx }),
      error: (msg, ctx) => emit('error', msg, { ...bound, ...ctx }),
    };
  },
};