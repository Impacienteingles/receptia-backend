const { Client } = require('pg');

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const host = 'aws-0-eu-west-1.pooler.supabase.com';
const port = 5432;
const user = `postgres.${projectRef}`;
const password = '1S67.!3CFitNmj';

async function run() {
  console.log('Waiting 30 seconds for PgBouncer circuit breaker to reset...');
  await new Promise(resolve => setTimeout(resolve, 30000));

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
    console.log('Connecting directly on 5432 with single correct password...');
    await client.connect();
    console.log('🎉 SUCCESS! Connected directly to database.');
    
    console.log('Altering table...');
    await client.query(`
      ALTER TABLE prospects 
      ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS opened_count INT DEFAULT 0;
      
      NOTIFY pgrst, 'reload schema';
    `);
    console.log('✅ ALTER TABLE succeeded!');
    await client.end();
  } catch (err) {
    console.error('Failed:', err.message);
  }
}

run();
