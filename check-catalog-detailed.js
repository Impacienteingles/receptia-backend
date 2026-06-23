const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('Querying current PREMIUM_VOICES_CATALOG from DB...');
  try {
    const { data, error } = await supabase.from('settings').select('*').eq('key', 'PREMIUM_VOICES_CATALOG').maybeSingle();
    if (error) {
      console.error('❌ Error:', error.message);
    } else if (data) {
      console.log('✅ Current Catalog Value:');
      console.log(JSON.stringify(JSON.parse(data.value), null, 2));
    } else {
      console.log('❌ Key not found.');
    }
  } catch (err) {
    console.error('❌ Excepción:', err.message);
  }
}

run();
