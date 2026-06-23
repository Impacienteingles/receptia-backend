const { supabase } = require('./dist/services/supabase');

async function run() {
  const { data, error } = await supabase.from('settings').select('*');
  if (error) {
    console.error('Error fetching settings:', error.message);
    return;
  }
  
  console.log('--- TWILIO SETTINGS ---');
  const twilioKeys = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_NUMBER'];
  data.forEach(item => {
    if (twilioKeys.includes(item.key)) {
      console.log(`${item.key}:`, item.value);
    }
  });
}

run();
