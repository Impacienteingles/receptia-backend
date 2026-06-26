const { Client } = require('pg');

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const host = 'aws-0-eu-west-1.pooler.supabase.com';
const port = 6543;
const user = `postgres.${projectRef}`;

const passwords = [
  '1S67.!3CFitNomj',
  'Cortijo18-20Andar#',
  'Cortijo18-20Andar',
  '5MP)3i9P7wjBr[',
  '1S67.!3CFitNmj',
  '1Prueba+',
  '1Esp@#ol'
];

async function run() {
  console.log('Waiting 10 seconds for PgBouncer circuit breaker to reset...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  for (const password of passwords) {
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
      console.log(`Connecting with password: ${password}...`);
      await client.connect();
      console.log(`🎉 SUCCESS! Connected to database using password: ${password}`);
      await client.end();
      return;
    } catch (err) {
      console.error(`Failed with password ${password}:`, err.message);
      try { await client.end(); } catch (e) {}
    }
  }
}

run();
