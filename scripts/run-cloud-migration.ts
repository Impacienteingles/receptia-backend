import { Client } from 'pg';

const projectRef = 'vnlbxfhzfuamzyqylkvd';
const password = '1Impaciente!';

async function main() {
  console.log('--- RUNNING WHATSAPP CLOUD API AND REMINDERS MIGRATION ---');
  
  const client = new Client({
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  try {
    await client.connect();
    console.log('✅ Connected successfully to Supabase PostgreSQL.');

    console.log('Adding columns to tenants table...');
    await client.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS whatsapp_cloud_token TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_cloud_phone_number_id TEXT;
    `);
    console.log('✅ WhatsApp Cloud API columns verified/added.');

    console.log('Adding whatsapp_reminder_sent to appointments table...');
    await client.query(`
      ALTER TABLE appointments 
      ADD COLUMN IF NOT EXISTS whatsapp_reminder_sent BOOLEAN DEFAULT FALSE;
    `);
    console.log('✅ whatsapp_reminder_sent column verified/added.');

    // Notify PostgREST to reload schema
    await client.query("NOTIFY pgrst, 'reload schema';");
    console.log('✅ Sent schema reload notification to PostgREST.');

    await client.end();
    console.log('--- MIGRATION COMPLETED SUCCESSFULLY ---');
  } catch (err: any) {
    console.error('❌ Migration failed:', err.message);
    try { await client.end(); } catch (e) {}
  }
}

main();
