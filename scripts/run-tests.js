/**
 * In-process test runner.
 *
 * `npm test` (`node --test tests/`) is the preferred way to run this suite: it
 * gives every file its own process and therefore a fully isolated database.
 *
 * Some restricted environments forbid the child processes the test runner needs
 * to spawn (`spawn EPERM`). This entry point imports every suite into a single
 * process instead. node:test still executes the top-level suites sequentially,
 * and each suite rebuilds the schema in its own `before()` hook, so isolation is
 * preserved.
 *
 * Lives in scripts/ rather than tests/ so it is never mistaken for a test file.
 */
import '../tests/p0-orders-atomicity.test.js';
import '../tests/p0-orders-lifecycle.test.js';
import '../tests/p0-schema-integrity.test.js';
import '../tests/p0-inventory.test.js';
import '../tests/p0-rbac.test.js';