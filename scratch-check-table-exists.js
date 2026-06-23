const { supabase } = require('./dist/services/supabase');

async function run() {
  console.log('Querying voices_catalog table...');
  const { data, error } = await supabase.from('voices_catalog').select('*').limit(1);
  if (error) {
    console.log('Error status:', error.code, error.message);
  } else {
    console.log('Success! Table exists. Data:', data);
  }
}

run();
