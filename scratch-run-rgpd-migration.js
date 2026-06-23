const { Client } = require('pg');

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const host = 'aws-0-eu-west-1.pooler.supabase.com';

const passwords = [
  '1Prueba+',
  '1Esp@#ol',
  '1Prueba#',
  '1S67.!3CFitNomj',
  '1S67.!3CFitNmj',
  '5MP)3i9P7wjBr['
];

async function tryConnect(password) {
  const client = new Client({
    host,
    port: 6543,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log(`\n🎉 SUCCESS WITH PASSWORD: ${password}`);
    const res = await client.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS rgpd_accepted BOOLEAN DEFAULT FALSE;
    `);
    console.log('✅ ALTER succeeded: added rgpd_accepted column!');
    await client.end();
    return true;
  } catch (err) {
    console.log(`Failed with password ${password.substring(0, 5)}... : ${err.message}`);
    try { await client.end(); } catch (e) {}
    return false;
  }
}

async function run() {
  for (const pw of passwords) {
    const ok = await tryConnect(pw);
    if (ok) {
      console.log('All done!');
      process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  console.log('All attempts failed.');
  process.exit(1);
}

run();
