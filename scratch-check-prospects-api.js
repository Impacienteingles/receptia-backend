const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const { data, error } = await supabase
    .from('prospects')
    .select('id, business_name, opened_at, opened_count')
    .limit(1);

  if (error) {
    console.error('Error fetching prospects:', error);
  } else {
    console.log('🎉 API Success! Columns details:', data);
  }
}

main();
