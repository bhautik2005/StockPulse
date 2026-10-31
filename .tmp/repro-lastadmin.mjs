import { bootstrapAdmin, resetDatabase, closePool } from '../qa-security-suite/phase1/setup/db.js';
import { createClient } from '../qa-security-suite/phase1/helpers/client.js';
import { uniqueKey } from '../qa-security-suite/phase1/helpers/fixtures.js';

await closePool();
await resetDatabase();
const admin = await bootstrapAdmin({ email: 'lone@stockpulse.test' });
console.log('admin role:', admin.role, 'id:', admin.id);
const api = createClient();
await api.login(admin.email, 'Password1234');
console.log('logged in as admin');
const patchRes = await api.patch(`/api/users/${admin.id}`, { role: 'Staff' });
console.log('status:', patchRes.status);
console.log('body:', JSON.stringify(patchRes.body));
process.exit(0);
