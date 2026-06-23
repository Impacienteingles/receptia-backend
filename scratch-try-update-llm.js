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
  const llmId = 'llm_06357a288a25e20e7d8960a807eb'; // LLM ID of Cristina
  console.log(`Trying to patch LLM: ${llmId}`);
  try {
    const res = await retellClient.patch(`/update-retell-llm/${llmId}`, {
      general_prompt: 'Test prompt update'
    });
    console.log('Success:', res.data);
  } catch (error) {
    console.log('STATUS:', error.response?.status);
    console.log('DATA:', JSON.stringify(error.response?.data));
  }
}

run();
