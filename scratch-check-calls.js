const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  const apiKey = process.env.RETELL_API_KEY;
  try {
    const tenantId = '62d1ed82-287c-4329-941b-50b578c15b14';
    console.log(`Querying Supabase call_logs for tenant ${tenantId}...`);
    const { data: logs, error } = await supabase
      .from('call_logs')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    const response = await axios.post(`https://api.retellai.com/v2/list-calls`, {}, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    console.log('Recent calls from Retell:', JSON.stringify(response.data.slice(0, 5), null, 2));

    console.log(`Found ${logs.length} call logs:`);
    logs.forEach(log => {
      console.log(`- ID: ${log.id}`);
      console.log(`  Call ID (Retell): ${log.retell_call_id}`);
      console.log(`  Created At: ${log.created_at}`);
      console.log(`  Phone: ${log.patient_phone}`);
      console.log(`  Recording: ${log.recording_url}`);
      console.log(`  Summary: ${log.summary}`);
      console.log(`  Transcript: ${log.transcript ? log.transcript.substring(0, 300) + '...' : 'N/A'}`);
      console.log('------------------------------');
    });
  } catch (error) {
    console.error('Error querying database:', error);
  }
}

run();
