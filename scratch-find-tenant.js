const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('*');

    if (error) throw error;

    console.log(`Found ${tenants.length} tenants:`);
    tenants.forEach(t => {
      console.log(`- ID: ${t.id}`);
      console.log(`  Name: ${t.business_name}`);
      console.log(`  Sector: ${t.business_sector}`);
      console.log(`  Agent ID: ${t.retell_agent_id}`);
      console.log('------------------------------');
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
