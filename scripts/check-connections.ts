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
    console.log('Fetching phone numbers from Retell...');
    const phoneRes = await retellClient.get('/v2/list-phone-numbers');
    console.log('Phone numbers found in Retell:', JSON.stringify(phoneRes.data, null, 2));

    console.log('\nFetching agent details...');
    const agentRes = await retellClient.get('/v2/get-agent/agent_fc831346f6baa67b35e7d11782');
    console.log('Agent details:', JSON.stringify(agentRes.data, null, 2));
  } catch (err: any) {
    console.error('Error querying Retell:', err.response?.data || err.message);
  }
}

run();
