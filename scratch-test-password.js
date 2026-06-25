const { Client } = require('pg');

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const host = 'aws-0-eu-west-1.pooler.supabase.com';
const port = 6543;
const user = `postgres.${projectRef}`;
const password = '1S67.!3CFitNmj';

async function run() {
  console.log('Waiting 10 seconds for PgBouncer circuit breaker to reset...');
  await new Promise(resolve => setTimeout(resolve, 10000));

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
    console.log('Connecting with single correct password...');
    await client.connect();
    console.log('🎉 SUCCESS! Connected to database.');
    await client.end();
  } catch (err) {
    console.error('Failed:', err.message);
  }
}

run();
