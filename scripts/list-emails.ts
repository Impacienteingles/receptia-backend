import { supabase } from '../src/services/supabase';

async function run() {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, business_name, email, admin_pin, is_archived');
  if (error) {
    console.error(error);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
run();
