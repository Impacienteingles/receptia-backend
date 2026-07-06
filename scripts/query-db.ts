import { supabase } from '../src/services/supabase';

async function run() {
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', '62d1ed82-287c-4329-941b-50b578c15b14')
    .single();
  
  if (tErr) {
    console.error('Error fetching tenant:', tErr);
  } else {
    console.log('--- CARLOS ROMERO TENANT ---');
    console.log(JSON.stringify(tenant, null, 2));
  }

  const { data: phones, error: pErr } = await supabase
    .from('virtual_phones')
    .select('id, phone_number, tenant_id, status');

  if (pErr) {
    console.error('Error fetching virtual phones:', pErr);
  } else {
    console.log('--- VIRTUAL PHONES ---');
    console.log(JSON.stringify(phones, null, 2));
  }
}

run();
