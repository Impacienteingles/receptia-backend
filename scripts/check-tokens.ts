import { supabase } from '../src/services/supabase';

async function run() {
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, business_name, google_refresh_token');

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('Tenants Google tokens:');
  for (const tenant of tenants) {
    console.log(`- ${tenant.business_name}: Has token? ${!!tenant.google_refresh_token}`);
    if (tenant.google_refresh_token) {
      console.log(`  Token: ${tenant.google_refresh_token.substring(0, 15)}...`);
    }
  }
}

run();
