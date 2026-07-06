import { supabase } from '../src/services/supabase';

async function run() {
  console.log('--- Listing current tenants and their pins ---');
  const { data: tenants, error: err } = await supabase
    .from('tenants')
    .select('id, business_name, admin_pin');

  if (err) {
    console.error('Error listing tenants:', err);
    return;
  }

  for (const t of tenants || []) {
    console.log(`- ${t.business_name} (${t.id}): PIN = "${t.admin_pin}"`);
  }

  console.log('\n--- Updating pins ---');
  // Update Carlos Romero to 'cortijo2018'
  const { error: err1 } = await supabase
    .from('tenants')
    .update({ admin_pin: 'cortijo2018' })
    .eq('id', '62d1ed82-287c-4329-941b-50b578c15b14');

  if (err1) {
    console.error('Error updating Carlos Romero PIN:', err1);
  } else {
    console.log('✅ Updated Carlos Romero PIN to "cortijo2018".');
  }

  // Update other standard tenants to '12345678'
  const standardIds = [
    '22222222-2222-2222-2222-222222222222', // Duo Peluqueros (pre-made)
    '33333333-3333-3333-3333-333333333333', // La Niña de los Peines (pre-made)
    '44444444-4444-4444-4444-444444444444', // Caravaning Plaza (pre-made)
    '21e9607a-dd4f-4d2d-9882-866f672682a0', // Duo Peluqueros (active)
    '77777777-7777-7777-7777-777777777777'  // Receptia Atención al Cliente
  ];

  for (const id of standardIds) {
    const { error: errStd } = await supabase
      .from('tenants')
      .update({ admin_pin: '12345678' })
      .eq('id', id);
    if (errStd) {
      console.error(`Error updating standard tenant ${id}:`, errStd);
    } else {
      console.log(`✅ Updated standard tenant ${id} PIN to "12345678".`);
    }
  }

  console.log('\n--- Final check of all pins ---');
  const { data: updatedTenants } = await supabase
    .from('tenants')
    .select('id, business_name, admin_pin');
  for (const t of updatedTenants || []) {
    console.log(`- ${t.business_name} (${t.id}): PIN = "${t.admin_pin}"`);
  }
}

run();
