const axios = require('axios');
require('dotenv').config();

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID = 'srv-d8r9pr0js32c73bq2slg';

async function run() {
  try {
    console.log('Triggering redeploy on Render...');
    const response = await axios.post(`https://api.render.com/v1/services/${SERVICE_ID}/deploys`, {}, {
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
    console.log('🎉 SUCCESS! Redeploy triggered.');
    console.log('Deploy Details:', response.data);
  } catch (error) {
    if (error.response) {
      console.error('Error response:', error.response.status, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error:', error.message);
    }
  }
}

run();
