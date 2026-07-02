import { supabase } from '../src/services/supabase';

async function run() {
  const { data: tenants, error: tErr } = await supabase
    .from('tenants')
    .select('*')
    .limit(1);
  
  if (tErr) {
    console.error('Error fetching tenants:', tErr);
  } else {
    console.log('--- TENANTS ---');
    console.log(JSON.stringify(tenants, null, 2));
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
