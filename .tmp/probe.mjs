import { bootstrapAdmin, resetDatabase, closePool } from '../qa-security-suite/phase1/setup/db.js';
import { createClient } from '../qa-security-suite/phase1/helpers/client.js';
import { createUser, createSimpleWorld, adminSession } from '../qa-security-suite/phase1/helpers/fixtures.js';

await closePool();
await resetDatabase();
const world = await createSimpleWorld({ stock: 30 });
console.log('world:', world.admin.email, 'manager role check...');

const manager = await createUser(world.admin.api, { role: 'Manager', warehouse_ids: [world.warehouse.id] });
console.log('manager email:', manager.email);

// Scan the DB for user role + is_active status for manager:
const rows = await import('../src/db/pool.js').then((m) => m.query(
  `SELECT id, email, role, is_active FROM users WHERE email IN ($1, $2, $3)`,
  [manager.email, world.admin.email, world.client?.email ?? 'none'],
));
console.log(rows.rows.map((r) => `${r.email}: ${r.role} active=${r.is_active}`));

// Now try to list inventory as manager:
const api = createClient();
const login = await api.login(manager.email, manager.password);
console.log('manager login:', login.status);
const listRes = await api.get('/api/inventory?limit=200');
console.log('status:', listRes.status, 'body:', JSON.stringify(listRes.body).slice(0, 500));
process.exit(0);
