const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const RENDER_API_KEY = process.env.RENDER_API_KEY;

const renderClient = axios.create({
  baseURL: 'https://api.render.com/v1',
  headers: {
    Authorization: `Bearer ${RENDER_API_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

async function run() {
  try {
    console.log('Fetching services list from Render...');
    const servicesList = await renderClient.get('/services');
    const existingService = servicesList.data.find(s => s.service.name === 'corandar');
    if (!existingService) {
      console.error('Service corandar not found.');
      return;
    }
    const serviceId = existingService.service.id;
    console.log(`Service ID: ${serviceId}`);

    console.log('Fetching env vars...');
    const envVarsRes = await renderClient.get(`/services/${serviceId}/env-vars`);
    console.log('Env vars:', JSON.stringify(envVarsRes.data, null, 2));
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}

run();
