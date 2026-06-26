const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const OWNER_ID = 'tea-d8qesrmgvqtc73a5mh5g';
const SERVICE_ID = 'srv-d8r9pr0js32c73bq2slg';

async function run() {
  try {
    let nextEndTime = null;
    let pagesToFetch = 80; 

    console.log(`\n=== SEARCHING LOGS (up to ${pagesToFetch} pages) ===`);

    for (let page = 0; page < pagesToFetch; page++) {
      console.log(`Fetching page ${page + 1}...`);
      const params = {
        ownerId: OWNER_ID,
        resource: SERVICE_ID,
        direction: 'backward',
        limit: 100
      };
      if (nextEndTime) {
        params.endTime = nextEndTime;
      }

      const response = await axios.get('https://api.render.com/v1/logs', {
        headers: {
          Authorization: `Bearer ${RENDER_API_KEY}`,
          Accept: 'application/json'
        },
        params
      });

      const data = response.data;
      const items = data.logs || [];
      nextEndTime = data.nextEndTime;

      const filtered = items.filter(log => {
        const text = (log.text || log.message || '').toLowerCase();
        if (text.includes('whatsapp web') || text.includes('creds.update')) return false;
        return text.includes('error') || text.includes('fail') || text.includes('exception') || text.includes('invalid') || text.includes('rebound') || text.includes('occup') || text.includes('busy') || text.includes('cancel-appointment') || text.includes('book-appointment') || text.includes('reschedule-appointment') || text.includes('webhook') || text.includes('appointment');
      });

      if (filtered.length > 0) {
        console.log(`[Page ${page + 1}] Found ${filtered.length} matching logs:`);
        filtered.forEach(log => {
          const msg = log.text || log.message || JSON.stringify(log);
          console.log(`  [${log.timestamp}] ${msg}`);
        });
      }

      if (!nextEndTime || items.length === 0) {
        break;
      }

      // Evitar Rate Limit (429) con un delay de 500ms
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error('Error:', error.stack || error.message);
  }
}

run();
