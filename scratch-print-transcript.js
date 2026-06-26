const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  try {
    const id = 'bec1eb97-c06e-4788-963a-9f4f959ef483';
    console.log(`Querying call_logs for ID: ${id}...`);
    const { data: log, error } = await supabase
      .from('call_logs')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    console.log('=== METADATA ===');
    console.log(`Created At: ${log.created_at}`);
    console.log(`Phone: ${log.patient_phone}`);
    console.log(`Summary: ${log.summary}`);
    console.log('\n=== FULL TRANSCRIPT ===');
    console.log(log.transcript);
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
