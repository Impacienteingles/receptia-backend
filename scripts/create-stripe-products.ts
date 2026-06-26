import Stripe from 'stripe';
import { supabase, getSettingVal } from '../src/services/supabase';

async function main() {
  const secretKey = await getSettingVal('STRIPE_SECRET_KEY');
  if (!secretKey) {
    console.error('❌ Error: No se encontró STRIPE_SECRET_KEY en la base de datos de settings.');
    process.exit(1);
  }

  const stripe = new Stripe(secretKey);

  const plans = [
    {
      id: 'estandar_mensual',
      name: 'Receptia - Plan Estándar Mensual',
      price: 149.00,
      cycle: 'month',
      description: '1 Agente de Voz IA activo, 1 Número telefónico en Retell AI, Integración con Google Calendar, Panel de control de cliente, Hasta 200 minutos incluidos / mes, Minuto adicional a 0.20€/min.'
    },
    {
      id: 'premium_mensual',
      name: 'Receptia - Plan Premium Mensual',
      price: 249.00,
      cycle: 'month',
      description: 'Todo lo del Plan Estándar, Conexión SIP Zadarma avanzada, Soporte de Voz ElevenLabs de alta calidad, Prompt e instrucciones optimizadas, Hasta 500 minutos incluidos / mes, Minuto adicional a 0.20€/min.'
    },
    {
      id: 'estandar_anual',
      name: 'Receptia - Plan Estándar Anual',
      price: 1290.00,
      cycle: 'year',
      description: '1 Agente de Voz IA activo, 1 Número telefónico en Retell AI, Integración con Google Calendar, Panel de control de cliente, Hasta 200 minutos incluidos / mes, Minuto adicional a 0.20€/min, Ahorro de casi 3 meses de suscripción.'
    },
    {
      id: 'premium_anual',
      name: 'Receptia - Plan Premium Anual',
      price: 2290.00,
      cycle: 'year',
      description: 'Todo lo del Plan Premium, Soporte VIP priorizado 24/7, Ahorro de 2 meses de suscripción, Minutos ilimitados controlados.'
    }
  ];

  console.log('🚀 Iniciando creación de productos y precios en Stripe...');

  const priceIds: Record<string, string> = {};

  for (const plan of plans) {
    try {
      console.log(`\n📦 Creando producto: ${plan.name}...`);
      const product = await stripe.products.create({
        name: plan.name,
        description: plan.description,
        metadata: { plan_id: plan.id }
      });

      console.log(`💸 Creando precio de ${plan.price} EUR (${plan.cycle === 'month' ? 'Mensual' : 'Anual'}) para ${plan.name}...`);
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(plan.price * 100), // En céntimos
        currency: 'eur',
        recurring: {
          interval: plan.cycle as any,
        },
        metadata: { plan_id: plan.id }
      });

      printSuccessMessage(plan.id, price.id);
      priceIds[plan.id] = price.id;
    } catch (err: any) {
      console.error(`❌ Error al crear producto/precio para ${plan.id}:`, err.message);
    }
  }

  // Guardar los Price IDs en settings de Supabase
  console.log('\n💾 Guardando Price IDs en los Ajustes de la base de datos...');
  const settingsToUpsert = [
    { key: 'STRIPE_PRICE_ESTANDAR_MENSUAL', value: priceIds['estandar_mensual'] },
    { key: 'STRIPE_PRICE_PREMIUM_MENSUAL', value: priceIds['premium_mensual'] },
    { key: 'STRIPE_PRICE_ESTANDAR_ANUAL', value: priceIds['estandar_anual'] },
    { key: 'STRIPE_PRICE_PREMIUM_ANUAL', value: priceIds['premium_anual'] }
  ].filter(s => s.value !== undefined);

  if (settingsToUpsert.length > 0) {
    const { error } = await supabase
      .from('settings')
      .upsert(settingsToUpsert);

    if (error) {
      console.error('❌ Error al guardar settings en Supabase:', error.message);
    } else {
      console.log('OK: Todos los Price IDs se han guardado con éxito en los Ajustes.');
    }
  }

  console.log('\nProcess finished!');
  console.log(JSON.stringify(priceIds, null, 2));
}

function printSuccessMessage(planId: string, priceId: string) {
  // Evitar imprimir emojis no soportados por el codepage cp1252 de Windows
  console.log(`Product created successfully for [${planId}]. Price ID: ${priceId}`);
}

main();
