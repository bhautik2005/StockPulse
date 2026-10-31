import { bootstrapAdmin, query, resetDatabase, closePool } from '../qa-security-suite/phase1/setup/db.js';
import { createClient } from '../qa-security-suite/phase1/helpers/client.js';

await closePool();
await resetDatabase();
const admin = await bootstrapAdmin({ email: 'lone@stockpulse.test' });
const api = createClient();
const login = await api.login(admin.email, admin.password);
console.log('login status:', login.status);
console.log('user id:', admin.id);

const patch = await api.patch(`/api/users/${admin.id}`, { role: 'Staff' });
console.log('self demote result:', patch.status, JSON.stringify(patch.body?.error));
process.exit(0);
