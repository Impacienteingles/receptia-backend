import { supabase } from '../src/services/supabase';

async function run() {
  try {
    // 1. Obtener token de SanaSalud
    const { data: sanasalud, error: getErr } = await supabase
      .from('tenants')
      .select('google_refresh_token')
      .eq('id', '27f84a8d-ee18-4f32-82a2-9a656b1d54da')
      .single();

    if (getErr || !sanasalud) {
      console.error('Error fetching SanaSalud token:', getErr?.message);
      return;
    }

    const token = sanasalud.google_refresh_token;
    if (!token) {
      console.error('SanaSalud does not have a Google refresh token!');
      return;
    }

    console.log(`Found token: ${token.substring(0, 15)}...`);

    // 2. Actualizar Peluquería Carlos Romero
    const { error: updateErr } = await supabase
      .from('tenants')
      .update({ google_refresh_token: token })
      .eq('id', '62d1ed82-287c-4329-941b-50b578c15b14');

    if (updateErr) {
      console.error('Error updating Peluqueria token:', updateErr.message);
      return;
    }

    console.log('Successfully copied Google Calendar refresh token to Peluquería Carlos Romero!');
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

run();
