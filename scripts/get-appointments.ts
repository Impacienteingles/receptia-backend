import { supabase } from '../src/services/supabase';

async function listAppointments() {
  console.log('Fetching appointments from Supabase...');
  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching appointments:', error.message);
    return;
  }

  console.log('\n--- Appointments ---');
  console.log(JSON.stringify(data, null, 2));
}

listAppointments();
