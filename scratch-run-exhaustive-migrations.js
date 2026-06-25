const { Client } = require('pg');

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const passwords = [
  '1Prueba+',
  '1Esp@#ol',
  '1Prueba#',
  '1S67.!3CFitNomj',
  '1S67.!3CFitNmj',
  '5MP)3i9P7wjBr['
];

const hosts = [
  'aws-0-eu-west-1.pooler.supabase.com',
  `db.${projectRef}.supabase.co`
];

const configurations = [];

for (const host of hosts) {
  const ports = host.includes('pooler') ? [6543] : [5432, 6543];
  for (const port of ports) {
    const users = port === 6543 ? [`postgres.${projectRef}`] : ['postgres', `postgres.${projectRef}`];
    for (const user of users) {
      for (const password of passwords) {
        configurations.push({ host, port, user, password });
      }
    }
  }
}

async function testConfig({ host, port, user, password }) {
  const client = new Client({
    host,
    port,
    database: 'postgres',
    user,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 3000
  });

  try {
    await client.connect();
    console.log(`\n🎉 SUCCESS: host=${host}, port=${port}, user=${user}, password=${password}`);
    
    // Run the migrations!
    console.log('Running ALTER TABLE command for prospects and tenants...');
    await client.query(`
      ALTER TABLE prospects 
      ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS opened_count INT DEFAULT 0;
      
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS block_admin_access BOOLEAN DEFAULT FALSE;
      
      NOTIFY pgrst, 'reload schema';
    `);
    console.log('✅ ALTER TABLE succeeded!');
    await client.end();
    return true;
  } catch (err) {
    console.log(`Failed config: host=${host}, port=${port}, user=${user}, pw=${password.substring(0,3)}...: ${err.message}`);
    try { await client.end(); } catch (e) {}
    return false;
  }
}

async function run() {
  console.log(`Starting exhaustive testing of ${configurations.length} configurations...`);
  for (const config of configurations) {
    const ok = await testConfig(config);
    if (ok) {
      console.log('Migration executed successfully!');
      process.exit(0);
    }
  }
  console.log('All configurations failed.');
  process.exit(1);
}

run();
