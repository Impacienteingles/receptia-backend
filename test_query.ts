import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  const { data: virtualPhones } = await supabase.from('virtual_phones').select('*');
  console.log('Virtual phones:', JSON.stringify(virtualPhones, null, 2));

  const { data: plans } = await supabase.from('plans').select('*');
  console.log('Plans:', JSON.stringify(plans, null, 2));

  const { data: settings } = await supabase.from('settings').select('*');
  console.log('Settings:', JSON.stringify(settings, null, 2));
}
run();
