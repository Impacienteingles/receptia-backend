const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const { data, error } = await supabase
    .from('prospects')
    .select(`
      *,
      tenants:demo_tenant_id (
        contract_start_date
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching prospects:', error);
  } else {
    console.log('🎉 API Success! Columns details:', data);
  }
}

main();
