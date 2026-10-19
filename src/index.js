/**
 * Server bootstrap with graceful shutdown.
 *
 * On SIGTERM/SIGINT the server stops accepting new connections, lets in-flight
 * requests finish, then closes the pool. Without this, a deploy kills requests
 * mid-transaction and Postgres is left rolling back orphaned work.
 */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';

async function startServer() {
  try {
    const appliedCount = await migrate();
    logger.info(
      appliedCount === 0 ? 'database schema already up to date' : 'database migrations applied',
      { count: appliedCount },
    );
  } catch (error) {
    logger.error('database migration failed; server will not start', { error: error.message });
    await closePool();
    process.exitCode = 1;
    return;
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info('stockpulse api listening', {
      port: env.PORT,
      env: env.NODE_ENV,
      cors: env.CORS_ORIGIN,
    });
  });

  let shuttingDown = false;

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutting down', { reason });

    const forceExit = setTimeout(() => {
      logger.error('shutdown timed out, exiting forcibly');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async () => {
      try {
        await closePool();
      } catch (error) {
        logger.error('error closing pool', { error: error.message });
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejected promise nobody handled is a bug that must be visible, not a
  // silent no-op that surfaces later as a mystery 500.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
}

await startServer();