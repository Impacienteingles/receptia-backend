import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log('Seeding plans in Supabase...');

  // Delete legacy plans
  const { error: deleteError } = await supabase
    .from('plans')
    .delete()
    .in('id', ['estandar', 'premium', 'anual']);

  if (deleteError) {
    console.error('Error deleting legacy plans:', deleteError);
  } else {
    console.log('Legacy plans deleted successfully.');
  }

  // Insert new plans
  const newPlans = [
    {
      id: 'estandar_mensual',
      name: 'Plan Estándar Mensual',
      price: 149.00,
      cycle: 'monthly',
      features: ['1 Agente de Voz IA activo', '1 Número telefónico en Retell AI', 'Integración con Google Calendar', 'Panel de control de cliente', 'Hasta 200 minutos incluidos / mes', 'Minuto adicional a 0.20€/min'],
      description: 'Plan estándar para medianos y pequeños comercios.'
    },
    {
      id: 'premium_mensual',
      name: 'Plan Premium Mensual',
      price: 249.00,
      cycle: 'monthly',
      features: ['Todo lo del Plan Estándar', 'Conexión SIP Zadarma avanzada', 'Soporte de Voz ElevenLabs de alta calidad', 'Prompt e instrucciones optimizadas', 'Hasta 500 minutos incluidos / mes', 'Minuto adicional a 0.20€/min'],
      description: 'Más Popular'
    },
    {
      id: 'estandar_anual',
      name: 'Plan Estándar Anual',
      price: 1290.00,
      cycle: 'annually',
      features: ['1 Agente de Voz IA activo', '1 Número telefónico en Retell AI', 'Integración con Google Calendar', 'Panel de control de cliente', 'Hasta 200 minutos incluidos / mes', 'Minuto adicional a 0.20€/min', 'Ahorro de casi 3 meses de suscripción'],
      description: 'Ahorro de casi 3 meses de suscripción'
    },
    {
      id: 'premium_anual',
      name: 'Plan Premium Anual',
      price: 2290.00,
      cycle: 'annually',
      features: ['Todo lo del Plan Premium', 'Soporte VIP priorizado 24/7', 'Ahorro de 2 meses de suscripción', 'Minutos ilimitados controlados'],
      description: 'Ahorro de 2 meses de suscripción'
    }
  ];

  const { error: insertError } = await supabase
    .from('plans')
    .upsert(newPlans);

  if (insertError) {
    console.error('Error inserting new plans:', insertError);
  } else {
    console.log('Structured plans inserted/updated successfully.');
  }
}

run().catch(console.error);
