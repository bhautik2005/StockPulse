import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

console.log('🔍 Initializing explicit pool configuration...');

// Explicitly configure the pool properties to guarantee SSL rejection bypass
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  family: 4,
  ssl: {
    rejectUnauthorized: false
  }
});

async function runTest() {
  try {
    console.log('🔄 Connecting to Supabase pooler...');
    const client = await pool.connect();
    console.log('✅ Connection acquired successfully!');

    const res = await client.query('SELECT NOW() as db_time, current_database() as db_name;');
    console.log(`📂 Database Name: ${res.rows[0].db_name}`);
    console.log(`🕒 Supabase Server Time: ${res.rows[0].db_time}`);

    client.release();
    await pool.end();
    console.log('🎉 Test completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ CONNECTION FAILED:');
    console.error(err.message);
    process.exit(1);
  }
}

runTest();


