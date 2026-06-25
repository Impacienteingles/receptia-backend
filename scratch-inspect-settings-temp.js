const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const { data, error } = await supabase
    .from('settings')
    .select('*');

  if (error) {
    console.error('Error fetching settings:', error);
  } else {
    console.log('--- SETTINGS IN SUPABASE ---');
    data.forEach(item => {
      console.log(`${item.key}: ${item.value}`);
    });
  }
}

main();
