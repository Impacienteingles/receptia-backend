import axios from 'axios';
import dotenv from 'dotenv';
import { supabase } from '../src/services/supabase';

dotenv.config();

const RETELL_API_KEY = process.env.RETELL_API_KEY;

if (!RETELL_API_KEY) {
  console.error('RETELL_API_KEY not found in .env');
  process.exit(1);
}

const retellClient = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: {
    Authorization: `Bearer ${RETELL_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

async function run() {
  try {
    console.log('--- DATABASE CHECK ---');
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', '62d1ed82-287c-4329-941b-50b578c15b14')
      .single();

    if (error) {
      console.error('Error fetching Peluqueria tenant:', error.message);
    } else {
      console.log('Tenant database data:', JSON.stringify(tenant, null, 2));
    }

    console.log('\n--- RETELL PHONE NUMBERS ---');
    const phoneRes = await retellClient.get('/list-phone-numbers');
    console.log('Phone numbers:', JSON.stringify(phoneRes.data, null, 2));

    const agentId = tenant?.retell_agent_id || 'agent_5978b1e3e6d4bbb6ffc928dc6a';

    console.log(`\n--- RETELL AGENT ${agentId} ---`);
    const agentRes = await retellClient.get(`/get-agent/${agentId}`);
    console.log('Agent details:', JSON.stringify(agentRes.data, null, 2));

    const llmId = agentRes.data.response_engine?.llm_id;
    if (llmId) {
      console.log(`\n--- RETELL LLM ${llmId} ---`);
      const llmRes = await retellClient.get(`/get-retell-llm/${llmId}`);
      console.log('LLM details (Prompt preview):', llmRes.data.general_prompt?.substring(0, 1000) + '...');
    }

  } catch (err: any) {
    console.error('Error:', err.response?.data || err.message);
  }
}

run();
