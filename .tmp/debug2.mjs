import { bootstrapAdmin, resetDatabase, closePool } from '../qa-security-suite/phase1/setup/db.js';
import { createClient } from '../qa-security-suite/phase1/helpers/client.js';
import bcrypt from 'bcryptjs';

// Set vitest's secret environment before anything imports config/env.js
process.env.JWT_SECRET = 'qa-suite-only-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789';
process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
await closePool();
await resetDatabase();
const admin = await bootstrapAdmin({ email: 'lone@stockpulse.test', password: 'Password1234' });
console.log('admin:', admin.id, admin.email, admin.role);
const api = createClient();
const login = await api.login(admin.email, 'Password1234');
console.log('login:', login.status);
const patchRes = await api.patch(`/api/users/${admin.id}`, { role: 'Staff' });
console.log('result:', patchRes.status, JSON.stringify(patchRes.body));
console.log('rowCount after:', await (await import('../src/db/pool.js')).query('SELECT role, is_active FROM users WHERE id = $1', [admin.id]).then((r) => r.rows[0]));
process.exit(0);
