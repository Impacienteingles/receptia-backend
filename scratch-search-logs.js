const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const OWNER_ID = 'tea-d8qesrmgvqtc73a5mh5g';
const SERVICE_ID = 'srv-d8r9pr0js32c73bq2slg';

async function run() {
  try {
    console.log('Fetching logs...');
    const response = await axios.get('https://api.render.com/v1/logs', {
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: 'application/json'
      },
      params: {
        ownerId: OWNER_ID,
        resource: SERVICE_ID,
        direction: 'backward',
        limit: 1000
      }
    });

    const logs = response.data;
    if (Array.isArray(logs)) {
      console.log(`Total logs fetched: ${logs.length}`);
      
      const filtered = logs.filter(log => {
        const text = (log.text || '').toLowerCase();
        return text.includes('appointment') || text.includes('error') || text.includes('citas') || text.includes('cancel');
      });
      
      console.log(`\n=== FILTERED LOGS (${filtered.length}) ===`);
      filtered.reverse().forEach(log => {
        console.log(`[${log.timestamp}] ${log.text || ''}`);
      });
    } else {
      console.log('Logs output:', logs);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

run();
