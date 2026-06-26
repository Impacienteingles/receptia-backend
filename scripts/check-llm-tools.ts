import axios from 'axios';
import dotenv from 'dotenv';

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
    const agentId = 'agent_5978b1e3e6d4bbb6ffc928dc6a';
    const agentRes = await retellClient.get(`/get-agent/${agentId}`);
    const llmId = agentRes.data.response_engine?.llm_id;
    if (llmId) {
      const llmRes = await retellClient.get(`/get-retell-llm/${llmId}`);
      console.log('LLM tools:', JSON.stringify(llmRes.data.general_tools, null, 2));
    }
  } catch (err: any) {
    console.error('Error:', err.response?.data || err.message);
  }
}

run();
