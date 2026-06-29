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
    .neq('id', 'dummy_id'); // Delete everything

  if (deleteError) {
    console.error('Error deleting legacy plans:', deleteError);
  } else {
    console.log('Legacy plans deleted successfully.');
  }

  // Insert new plans
  const newPlans = [
    {
      id: 'inicial_mensual',
      name: 'Plan Inicial Mensual',
      price: 79.00,
      cycle: 'monthly',
      features: [
        'Recepcionista de voz 24/7',
        'Google Calendar',
        'Voz estándar en español',
        'Confirmaciones por WhatsApp',
        'Garantía de reembolso de 14 días',
        'Cancela cuando quieras',
        'Descarga de facturas PDF',
        'Compra de minutos extra',
        'Pago seguro con Stripe'
      ],
      description: 'Para autónomos y profesionales que empiezan.'
    },
    {
      id: 'estandar_mensual',
      name: 'Plan Estándar Mensual',
      price: 149.00,
      cycle: 'monthly',
      features: [
        'Todo lo de Inicial',
        'Recordatorios automáticos por WhatsApp',
        'Modo vacaciones',
        'Sincronización con software médico (Gesden, Dentrix)',
        'Multi-profesional',
        'Fianza anti no-show',
        'Garantía de reembolso de 14 días',
        'Cancela cuando quieras',
        'Descarga de facturas PDF',
        'Compra de minutos extra',
        'Pago seguro con Stripe'
      ],
      description: 'Para clínicas y negocios en pleno crecimiento.'
    },
    {
      id: 'premium_mensual',
      name: 'Plan Premium Mensual',
      price: 249.00,
      cycle: 'monthly',
      features: [
        'Todo lo de Estándar',
        'Voz clonada (instant voice cloning)',
        'Campañas outbound automatizadas',
        'Análisis conversacional avanzado',
        'Múltiples números',
        'Garantía de reembolso de 14 días',
        'Cancela cuando quieras',
        'Descarga de facturas PDF',
        'Compra de minutos extra',
        'Pago seguro con Stripe'
      ],
      description: 'Para empresas con varios centros o alto volumen.'
    },
    {
      id: 'inicial_anual',
      name: 'Plan Inicial Anual',
      price: 900.00,
      cycle: 'annually',
      features: [
        'Recepcionista de voz 24/7',
        'Google Calendar',
        'Voz estándar en español',
        'Confirmaciones por WhatsApp',
        'Garantía de reembolso de 14 días (ahorro de 48€/año)',
        'Cancela cuando quieras',
        'Descarga de facturas PDF',
        'Compra de minutos extra',
        'Pago seguro con Stripe'
      ],
      description: 'Ahorras 48€/año'
    },
    {
      id: 'estandar_anual',
      name: 'Plan Estándar Anual',
      price: 1668.00,
      cycle: 'annually',
      features: [
        'Todo lo de Inicial',
        'Recordatorios automáticos por WhatsApp',
        'Modo vacaciones',
        'Sincronización con software médico (Gesden, Dentrix)',
        'Multi-profesional',
        'Fianza anti no-show',
        'Garantía de reembolso de 14 días (ahorro de 120€/año)',
        'Cancela cuando quieras',
        'Descarga de facturas PDF',
        'Compra de minutos extra',
        'Pago seguro con Stripe'
      ],
      description: 'Ahorras 120€/año'
    },
    {
      id: 'premium_anual',
      name: 'Plan Premium Anual',
      price: 2748.00,
      cycle: 'annually',
      features: [
        'Todo lo de Estándar',
        'Voz clonada (instant voice cloning)',
        'Campañas outbound automatizadas',
        'Análisis conversacional avanzado',
        'Múltiples números',
        'Garantía de reembolso de 14 días (ahorro de 240€/año)',
        'Cancela cuando quieras',
        'Descarga de facturas PDF',
        'Compra de minutos extra',
        'Pago seguro con Stripe'
      ],
      description: 'Ahorras 240€/año'
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
