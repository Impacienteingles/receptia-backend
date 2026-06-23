import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const RETELL_API_KEY = process.env.RETELL_API_KEY || 'key_384152d5e17c5727c0209defede3';

const client = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: {
    Authorization: `Bearer ${RETELL_API_KEY}`,
  },
});

async function main() {
  try {
    const response = await client.get('/list-voices');
    console.log('=== TODAS LAS VOCES DISPONIBLES ===');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('=====================================');
  } catch (error: any) {
    console.error('Error al listar voces:', error.message);
  }
}

main();
