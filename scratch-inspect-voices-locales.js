const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  try {
    const { data: setting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'CARTESIA_API_KEY')
      .maybeSingle();

    const response = await axios.get('https://api.cartesia.ai/voices', {
      headers: {
        'Cartesia-Version': '2024-06-18',
        'X-API-Key': setting.value,
        'Content-Type': 'application/json'
      }
    });

    console.log('=== INSPECTING SPANISH VOICES DETAILS ===');
    const spanish = response.data.filter(v => v.language === 'es');
    spanish.slice(0, 15).forEach(v => {
      console.log(`Name: ${v.name}`);
      console.log(`ID: ${v.id}`);
      console.log(`Gender: ${v.gender}`);
      console.log(`Description: ${v.description}`);
      console.log(`Metadata/Info:`, JSON.stringify(v.metadata || v.info || {}, null, 2));
      console.log('---------------------------------------------');
    });

  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
