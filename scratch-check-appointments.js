const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  try {
    console.log('Querying Supabase appointments for 2026-06-30...');
    const { data: apps, error } = await supabase
      .from('appointments')
      .select('*')
      .gte('date_time', '2026-06-30T00:00:00.000Z')
      .lte('date_time', '2026-06-30T23:59:59.999Z');

    if (error) throw error;

    console.log(`Found ${apps.length} appointments:`);
    apps.forEach(app => {
      console.log(`- ID: ${app.id}`);
      console.log(`  Tenant ID: ${app.tenant_id}`);
      console.log(`  Patient: ${app.patient_name}`);
      console.log(`  Phone: ${app.patient_phone}`);
      console.log(`  Email: ${app.patient_email}`);
      console.log(`  Time: ${app.date_time}`);
      console.log(`  Status: ${app.status}`);
      console.log(`  Google Event: ${app.google_event_id}`);
      console.log('------------------------------');
    });
  } catch (error) {
    console.error('Error querying database:', error);
  }
}

run();
