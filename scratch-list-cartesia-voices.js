const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  try {
    // 1. Obtener la API Key de Cartesia desde la base de datos
    console.log('Querying CARTESIA_API_KEY from Supabase settings...');
    const { data: setting, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'CARTESIA_API_KEY')
      .maybeSingle();

    if (error) throw error;
    if (!setting || !setting.value) {
      console.error('❌ CARTESIA_API_KEY no encontrada en la tabla settings.');
      return;
    }

    const apiKey = setting.value;
    console.log(`✅ API Key encontrada (comienza por: ${apiKey.substring(0, 5)}...)`);

    // 2. Consultar voces de Cartesia
    console.log('Fetching voices from Cartesia API...');
    const response = await axios.get('https://api.cartesia.ai/voices', {
      headers: {
        'Cartesia-Version': '2024-06-18',
        'X-API-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    console.log('=== CARTESIA VOICES ===');
    const voices = response.data;
    if (Array.isArray(voices)) {
      // Filtrar y mostrar las voces en español o inglés
      const filtered = voices.filter(v => {
        const lang = (v.language || '').toLowerCase();
        return lang.includes('es') || lang.includes('en') || lang.includes('spanish') || lang.includes('english');
      });
      
      console.log(`Found ${filtered.length} Spanish/English voices out of ${voices.length} total voices:`);
      filtered.forEach(v => {
        console.log(`- Name: ${v.name} | Language: ${v.language} | ID: ${v.id}`);
      });
    } else {
      console.log('API Response:', JSON.stringify(voices, null, 2));
    }

  } catch (err) {
    if (err.response) {
      console.error('❌ API Error:', err.response.status, err.response.data);
    } else {
      console.error('❌ Error:', err.message);
    }
  }
}

run();
