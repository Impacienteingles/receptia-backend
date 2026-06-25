const { Client } = require('pg');

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const host = 'aws-0-eu-west-1.pooler.supabase.com';
const port = 5432;
const user = `postgres.${projectRef}`;

const passwords = [
  'Cortijo18-20Andar#',
  'Cortijo18-20Andar'
];

async function tryConnect(password) {
  const client = new Client({
    host,
    port,
    database: 'postgres',
    user,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });

  try {
    console.log(`Connecting to ${host}:${port} as ${user} with password: ${password}...`);
    await client.connect();
    console.log('🎉 SUCCESS! Connected.');
    await client.query(`
      ALTER TABLE prospects 
      ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS opened_count INT DEFAULT 0;
      
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS block_admin_access BOOLEAN DEFAULT FALSE;
      
      NOTIFY pgrst, 'reload schema';
    `);
    console.log('✅ Migration succeeded!');
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
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  process.exit(1);
}

run();
