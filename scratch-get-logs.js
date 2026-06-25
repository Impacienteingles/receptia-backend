const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config({ path: 'e:/APPS/Receptia - v2/.env' });

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const OWNER_ID = 'tea-d8qesrmgvqtc73a5mh5g';
const SERVICE_ID = 'srv-d8r9pr0js32c73bq2slg';

async function run() {
  try {
    console.log('Fetching logs from Render for service:', SERVICE_ID);
    const response = await axios.get('https://api.render.com/v1/logs', {
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: 'application/json'
      },
      params: {
        ownerId: OWNER_ID,
        resource: SERVICE_ID,
        direction: 'backward',
        limit: 100
      }
    });

    console.log('=== RENDER RUNTIME LOGS FILTERED ===');
    const logs = response.data;
    if (Array.isArray(logs)) {
      logs.reverse().forEach(log => {
        console.log(`[${log.timestamp}] ${log.text || ''}`);
      });
    } else {
      console.log('Logs output:', JSON.stringify(logs, null, 2));
    }
  } catch (error) {
    if (error.response) {
      console.error('Error response:', error.response.status, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error:', error.message);
    }
  }
}

run();
