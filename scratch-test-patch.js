const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: apiKeyData } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'RETELL_API_KEY')
    .maybeSingle();

  const apiKey = apiKeyData ? apiKeyData.value : null;
  if (!apiKey) {
    console.error('No RETELL_API_KEY found.');
    return;
  }

  const agentId = 'agent_fc831346f6baa67b35e7d11782'; // Cristina's agent ID
  const voiceId = 'custom_voice_d8074856348dc5cf47278e0c8d';

  console.log(`Trying to patch agent ${agentId} with voice ${voiceId} using API key...`);
  try {
    const response = await axios.patch(
      `https://api.retellai.com/update-agent/${agentId}`,
      { voice_id: voiceId },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Success:', response.data);
  } catch (err) {
    console.error('Error Status:', err.response?.status);
    console.error('Error Data:', err.response?.data);
  }
}

run();
