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
  const payload = {
    phone_number: '+34858215153',
    termination_uri: 'sip.zadarma.com',
    nickname: 'Zadarma - Peluqueria',
    inbound_agent_id: 'agent_5978b1e3e6d4bbb6ffc928dc6a'
  };

  const updatePayload = {
    inbound_agent_id: 'agent_5978b1e3e6d4bbb6ffc928dc6a',
    nickname: 'Zadarma - Peluqueria'
  };

  try {
    console.log('Attempting to update phone number in Retell...');
    const res = await retellClient.patch('/update-phone-number/+34858215153', updatePayload);
    console.log('Success! Updated phone number:', JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error('Error importing phone number:', err.response?.data || err.message);
  }
}

run();
