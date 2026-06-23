const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'PREMIUM_VOICES_CATALOG')
    .maybeSingle();

  if (error) {
    console.error('Error fetching settings:', error.message);
    return;
  }
  
  if (data && data.value) {
    console.log('Voices catalog in settings:');
    console.log(JSON.stringify(JSON.parse(data.value), null, 2));
  } else {
    console.log('No custom voices catalog found, using defaults.');
  }
}

run();
