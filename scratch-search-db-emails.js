const { supabase } = require('./dist/services/supabase');

async function run() {
  const { data, error } = await supabase.from('appointments').select('*').limit(20);
  if (error) {
    console.error('Error:', error.message);
    return;
  }
  
  data.forEach(app => {
    console.log(`ID: ${app.id}, Patient: ${app.patient_name}, Email: ${app.patient_email}`);
  });
}

run();
