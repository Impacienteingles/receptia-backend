const { Client } = require('pg');

const host = 'aws-0-eu-west-1.pooler.supabase.com';
const port = 5432;

const passwords = [
  '1S67.!3CFitNmj',
  '5MP)3i9P7wjBr['
];

async function tryConnect(password) {
  const client = new Client({
    host,
    port,
    database: 'postgres',
    user: 'postgres',
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });

  try {
    console.log(`Connecting to ${host}:${port} as postgres with password: ${password.substring(0,3)}...`);
    await client.connect();
    console.log('🎉 SUCCESS! Connected.');
    await client.end();
    return true;
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    try { await client.end(); } catch (e) {}
    return false;
  }
}

async function run() {
  for (const pw of passwords) {
    const ok = await tryConnect(pw);
    if (ok) {
      process.exit(0);
    }
  }
  process.exit(1);
}

run();
