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
  const agentId = 'agent_fc831346f6baa67b35e7d11782'; // Cristina Agent
  console.log(`Trying to patch Agent: ${agentId}`);
  try {
    const res = await retellClient.patch(`/update-agent/${agentId}`, {
      responsiveness: 1.0
    });
    console.log('Success:', res.data);
  } catch (error) {
    console.log('STATUS:', error.response?.status);
    console.log('DATA:', JSON.stringify(error.response?.data));
  }
}

run();
