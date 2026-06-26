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

    if (!setting || !setting.value) {
      console.error('❌ CARTESIA_API_KEY no encontrada.');
      return;
    }

    const response = await axios.get('https://api.cartesia.ai/voices', {
      headers: {
        'Cartesia-Version': '2024-06-18',
        'X-API-Key': setting.value,
        'Content-Type': 'application/json'
      }
    });

    console.log('=== SPANISH VOICES FOUND ===');
    const spanishVoices = response.data.filter(v => (v.language === 'es'));
    spanishVoices.forEach(v => {
      console.log(`- Name: ${v.name} | Gender: ${v.gender} | Language: ${v.language} | ID: ${v.id}`);
    });
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
