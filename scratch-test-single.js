const { Client } = require('pg');

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const host = 'aws-0-eu-west-1.pooler.supabase.com';
const port = 5432;
const user = `postgres.${projectRef}`;
const password = '1S67.!3CFitNmj';

async function run() {
  const client = new Client({
    host,
    port,
    database: 'postgres',
    user,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  try {
    console.log(`Connecting to ${host}:${port} as ${user}...`);
    await client.connect();
    console.log('🎉 SUCCESS! Connected successfully.');
    
    console.log('Running ALTER TABLE command...');
    await client.query(`
      ALTER TABLE prospects 
      ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS opened_count INT DEFAULT 0;
      
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS block_admin_access BOOLEAN DEFAULT FALSE;
      
      NOTIFY pgrst, 'reload schema';
    `);
    console.log('✅ Migration succeeded!');
  } catch (err) {
    console.error('❌ Failed:', err.message);
  } finally {
    try { await client.end(); } catch (e) {}
  }
}

run();
