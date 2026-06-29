require('dotenv').config();
const axios = require('axios');

async function main() {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    console.error('RETELL_API_KEY is not defined in .env');
    return;
  }
  console.log('API Key:', apiKey.substring(0, 10) + '...');

  try {
    const response = await axios.post('https://api.retellai.com/v2/list-agents', {
      filter_criteria: {
        channel: { op: 'eq', value: 'voice', type: 'string' }
      }
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    console.log('Success!', response.data);
  } catch (err) {
    console.error('Failed!', err.response ? err.response.status : err.message);
    if (err.response) {
      console.error('Response Data:', JSON.stringify(err.response.data));
    }
  }
}

main();
