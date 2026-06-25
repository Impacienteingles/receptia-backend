const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const { data, error } = await supabase
    .from('prospects')
    .select('id, business_name, email, status, error_details')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error fetching prospects:', error);
  } else {
    console.log('--- RECENT PROSPECTS ---');
    data.forEach(item => {
      console.log(`Name: ${item.business_name} | Email: ${item.email} | Status: ${item.status} | Error: ${item.error_details}`);
    });
  }
}

main();
