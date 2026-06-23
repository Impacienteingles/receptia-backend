const axios = require('E:/APPS/Receptia/node_modules/axios');
const fs = require('fs');

let envContent = '';
try {
  envContent = fs.readFileSync('.env', 'utf-8');
} catch (e) {}

function getEnvVar(key) {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

const RETELL_API_KEY = getEnvVar('RETELL_API_KEY');

const retellClient = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: {
    Authorization: `Bearer ${RETELL_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

async function run() {
  const agentId = 'agent_fc831346f6baa67b35e7d11782';
  try {
    const res = await retellClient.get(`/get-agent/${agentId}`);
    console.log('AGENT:', JSON.stringify(res.data, null, 2));
  } catch (error) {
    console.log('ERROR:', error.message);
  }
}

run();
