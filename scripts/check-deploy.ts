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
    const servicesRes = await client.get('/services');
    const service = servicesRes.data.find((s: any) => s.service.name === 'corandar');
    if (!service) {
      console.error('No se encontró el servicio corandar en Render.');
      return;
    }
    const serviceId = service.service.id;
    const response = await client.get(`/services/${serviceId}/deploys`);
    console.log('=== DESPLIEGUES EN RENDER ===');
    const latestDeploy = response.data[0]?.deploy;
    if (latestDeploy) {
      console.log(`ID Despliegue: ${latestDeploy.id}`);
      console.log(`Estado: ${latestDeploy.status}`); // 'building', 'live', 'failed', etc.
      console.log(`Creado en: ${latestDeploy.createdAt}`);
      console.log(`Actualizado en: ${latestDeploy.updatedAt}`);
    } else {
      console.log('No se encontraron despliegues.');
    }
    console.log('=============================');
  } catch (error: any) {
    console.error('Error al consultar deploys:', error.message);
  }
}

main();
