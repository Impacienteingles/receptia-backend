const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const OWNER_ID = 'tea-d8qesrmgvqtc73a5mh5g';
const SERVICE_ID = 'srv-d8r9pr0js32c73bq2slg';

async function run() {
  try {
    // We want to fetch around 2026-06-26T13:42:13Z.
    // Page 7 nextEndTime was 2026-06-26T13:42:21Z.
    // So we pass endTime = 2026-06-26T13:44:00Z to cover that window.
    console.log('Fetching logs around 13:42:13Z...');
    const response = await axios.get('https://api.render.com/v1/logs', {
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: 'application/json'
      },
      params: {
        ownerId: OWNER_ID,
        resource: SERVICE_ID,
        direction: 'backward',
        limit: 100,
        endTime: '2026-06-26T13:44:00Z'
      }
    });

    const data = response.data;
    const logs = data.logs || [];
    console.log(`Fetched ${logs.length} logs.`);
    
    logs.reverse().forEach(log => {
      const msg = log.text || log.message || JSON.stringify(log);
      console.log(`[${log.timestamp}] ${msg}`);
    });
  } catch (error) {
    console.error('Error:', error.message);
  }
}

run();
