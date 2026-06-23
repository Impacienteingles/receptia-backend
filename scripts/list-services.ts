import axios from 'axios';

const RENDER_API_KEY = 'rnd_79YVffYDrFcDxfadHeg5SyVJUOft';

const client = axios.create({
  baseURL: 'https://api.render.com/v1',
  headers: {
    Authorization: `Bearer ${RENDER_API_KEY}`,
  },
});

async function main() {
  try {
    const response = await client.get('/services');
    console.log('=== SERVICIOS EN RENDER ===');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('============================');
  } catch (error: any) {
    console.error('Error al listar servicios:', error.message);
  }
}

main();
