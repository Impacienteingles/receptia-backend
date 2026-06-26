const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  try {
    const id = 'bec1eb97-c06e-4788-963a-9f4f959ef483';
    const { data: log, error } = await supabase
      .from('call_logs')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    console.log('=== ROW KEYS ===');
    console.log(Object.keys(log));
    console.log('Metadata:', log.metadata);
  } catch (error) {
    console.error('Error:', error);
  }
}

run();
