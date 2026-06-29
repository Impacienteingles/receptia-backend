import Stripe from 'stripe';
import axios from 'axios';
import { supabase, getSettingVal } from './supabase';

let stripeInstance: Stripe | null = null;

/**
 * Inicializa y devuelve la instancia del cliente de Stripe de forma asíncrona,
 * leyendo la clave secreta desde la base de datos o variables de entorno.
 */
export async function getStripeClient(): Promise<Stripe> {
  if (stripeInstance) return stripeInstance;

  const secretKey = await getSettingVal('STRIPE_SECRET_KEY');
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY no está configurada en los Ajustes del Administrador ni en el archivo .env.');
  }

  stripeInstance = new Stripe(secretKey, {
    apiVersion: '2023-10-16' as any
  });
  return stripeInstance;
}

/**
 * Mapea el ID de plan interno a la clave del ajuste dinámico donde se guarda su ID de precio en Stripe.
 */
const PLAN_PRICE_KEY_MAP: Record<string, string> = {
  inicial_mensual: 'STRIPE_PRICE_INICIAL_MENSUAL',
  estandar_mensual: 'STRIPE_PRICE_ESTANDAR_MENSUAL',
  premium_mensual: 'STRIPE_PRICE_PREMIUM_MENSUAL',
  inicial_anual: 'STRIPE_PRICE_INICIAL_ANUAL',
  estandar_anual: 'STRIPE_PRICE_ESTANDAR_ANUAL',
  premium_anual: 'STRIPE_PRICE_PREMIUM_ANUAL',
  // Fallbacks para IDs antiguos
  estandar: 'STRIPE_PRICE_ESTANDAR_MENSUAL',
  premium: 'STRIPE_PRICE_PREMIUM_MENSUAL',
  anual: 'STRIPE_PRICE_PREMIUM_ANUAL'
};

/**
 * Obtiene o crea un cliente en Stripe para un inquilino específico.
 */
export async function getOrCreateCustomer(tenantId: string): Promise<string> {
  const stripe = await getStripeClient();

  // 1. Obtener inquilino desde Supabase
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (tErr || !tenant) {
    throw new Error(`Inquilino no encontrado en la base de datos: ${tenantId}`);
  }

  if (tenant.stripe_customer_id) {
    return tenant.stripe_customer_id;
  }

  // 2. Si no tiene cliente en Stripe, crearlo
  console.log(`🤖 Creando cliente en Stripe para ${tenant.business_name} (${tenant.email})...`);
  const customer = await stripe.customers.create({
    email: tenant.email,
    name: tenant.business_name,
    metadata: {
      tenant_id: tenantId
    }
  });

  // 3. Guardar el ID de Stripe en Supabase
  const { error: updErr } = await supabase
    .from('tenants')
    .update({ stripe_customer_id: customer.id })
    .eq('id', tenantId);

  if (updErr) {
    console.error(`❌ Error al guardar stripe_customer_id para ${tenantId}:`, updErr.message);
  }

  return customer.id;
}

/**
 * Crea una sesión de Stripe Checkout para suscribirse a un plan.
 */
export async function createStripeCheckoutSession(
  tenantId: string,
  planId: string,
  originUrl: string
): Promise<string> {
  const stripe = await getStripeClient();

  // 1. Obtener o crear el cliente
  const customerId = await getOrCreateCustomer(tenantId);

  // 2. Obtener el Price ID de Stripe configurado para este plan
  const priceConfigKey = PLAN_PRICE_KEY_MAP[planId] || 'STRIPE_PRICE_ESTANDAR_MENSUAL';
  const priceId = await getSettingVal(priceConfigKey);

  if (!priceId) {
    throw new Error(
      `El ID de precio de Stripe para el plan '${planId}' (${priceConfigKey}) no está configurado en los Ajustes del Administrador.`
    );
  }

  // 3. Crear sesión de Stripe Checkout
  console.log(`🚀 Creando Checkout Session para el plan ${planId} (${priceId})...`);
  
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price: priceId,
      quantity: 1,
    }
  ];

  const isAnnual = planId.toLowerCase().includes('anual');
  const excessPriceKey = isAnnual ? 'STRIPE_PRICE_EXCESS_MINUTES_ANNUAL' : 'STRIPE_PRICE_EXCESS_MINUTES_MONTHLY';
  let excessPriceId = await getSettingVal(excessPriceKey);
  if (!excessPriceId || excessPriceId.trim() === '') {
    excessPriceId = await getSettingVal('STRIPE_PRICE_EXCESS_MINUTES');
  }

  if (excessPriceId && excessPriceId.trim() !== '') {
    console.log(`➕ Añadiendo ítem de cobro por minutos excedentes (${isAnnual ? 'Anual' : 'Mensual'}) al checkout: ${excessPriceId}`);
    lineItems.push({
      price: excessPriceId.trim()
    });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: lineItems,
    mode: 'subscription',
    success_url: `${originUrl}/?tenant_id=${tenantId}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${originUrl}/?tenant_id=${tenantId}&checkout=cancel`,
    metadata: {
      tenant_id: tenantId,
      plan_id: planId,
    },
    subscription_data: {
      metadata: {
        tenant_id: tenantId,
        plan_id: planId,
      },
      trial_period_days: 7,
      billing_mode: {
        type: 'classic'
      }
    } as any,
  });

  if (!session.url) {
    throw new Error('No se pudo generar la URL de redirección en la sesión de Stripe Checkout.');
  }

  return session.url;
}

/**
 * Crea una sesión de Stripe Customer Portal para gestionar la suscripción existente.
 */
export async function createStripePortalSession(
  tenantId: string,
  originUrl: string
): Promise<string> {
  const stripe = await getStripeClient();

  // 1. Obtener inquilino para recuperar su stripe_customer_id
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select('stripe_customer_id')
    .eq('id', tenantId)
    .single();

  if (tErr || !tenant || !tenant.stripe_customer_id) {
    throw new Error('El cliente no tiene un ID de Stripe registrado. Debe suscribirse primero.');
  }

  // 2. Crear sesión del portal de Stripe
  console.log(`🚀 Creando Customer Portal Session para Stripe Customer: ${tenant.stripe_customer_id}...`);
  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: `${originUrl}/?tenant_id=${tenantId}`,
  });

  if (!session.url) {
    throw new Error('No se pudo generar la URL de redirección del Stripe Customer Portal.');
  }

  return session.url;
}

/**
 * Procesa el consumo de minutos para un inquilino y reporta a Stripe
 * cualquier minuto de exceso que se haya acumulado en el ciclo actual.
 */
export async function processMeteredBillingForCall(tenantId: string, durationSeconds: number): Promise<void> {
  if (durationSeconds <= 0) return;

  try {
    // 1. Obtener inquilino
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .select('stripe_subscription_id, business_name')
      .eq('id', tenantId)
      .single();

    if (tErr || !tenant) {
      console.warn(`[Metered Billing] No se encontró el inquilino para facturación por uso: ${tenantId}`);
      return;
    }

    // Si no tiene suscripción de Stripe (ej: manual o trial), no se procesa cobro extra
    if (!tenant.stripe_subscription_id) {
      console.log(`[Metered Billing] El inquilino "${tenant.business_name}" no tiene suscripción activa en Stripe. Saltando.`);
      return;
    }

    const stripe = await getStripeClient();

    // 2. Obtener la suscripción desde Stripe para conocer las fechas de inicio/fin del ciclo actual
    console.log(`[Metered Billing] Consultando suscripción de Stripe ${tenant.stripe_subscription_id} para "${tenant.business_name}"...`);
    const subscription: any = await stripe.subscriptions.retrieve(tenant.stripe_subscription_id);
    
    const periodStart = subscription.current_period_start;
    console.log(`[Metered Billing] Ciclo actual de facturación: ${new Date(periodStart * 1000).toLocaleString()} hasta ${new Date(subscription.current_period_end * 1000).toLocaleString()}`);

    // 3. Obtener todas las llamadas de este inquilino finalizadas en el período actual
    const startDateString = new Date(periodStart * 1000).toISOString();
    const { data: logs, error: lErr } = await supabase
      .from('call_logs')
      .select('call_duration')
      .eq('tenant_id', tenantId)
      .gte('created_at', startDateString);

    if (lErr) {
      console.error(`[Metered Billing ERROR] No se pudieron consultar los logs de llamada para el inquilino ${tenantId}:`, lErr.message);
      return;
    }

    // 4. Calcular el total acumulado de minutos (redondeando cada llamada de forma individual)
    let totalPeriodMinutes = 0;
    if (logs && logs.length > 0) {
      totalPeriodMinutes = logs.reduce((acc, log) => acc + Math.ceil((log.call_duration || 0) / 60), 0);
    }

    // 5. Determinar el límite contratado en base al Price ID del plan principal en la suscripción
    const inicialMensualPrice = await getSettingVal('STRIPE_PRICE_INICIAL_MENSUAL');
    const estandarMensualPrice = await getSettingVal('STRIPE_PRICE_ESTANDAR_MENSUAL');
    const premiumMensualPrice = await getSettingVal('STRIPE_PRICE_PREMIUM_MENSUAL');
    const inicialAnualPrice = await getSettingVal('STRIPE_PRICE_INICIAL_ANUAL');
    const estandarAnualPrice = await getSettingVal('STRIPE_PRICE_ESTANDAR_ANUAL');
    const premiumAnualPrice = await getSettingVal('STRIPE_PRICE_PREMIUM_ANUAL');

    let limit = 200; // Límite por defecto (Estándar)
    let planLabel = 'Estándar';

    for (const item of subscription.items.data) {
      const priceId = item.price.id;
      if (priceId === inicialMensualPrice) { limit = 100; planLabel = 'Inicial Mensual'; break; }
      if (priceId === estandarMensualPrice) { limit = 200; planLabel = 'Estándar Mensual'; break; }
      if (priceId === premiumMensualPrice) { limit = 500; planLabel = 'Premium Mensual'; break; }
      if (priceId === inicialAnualPrice) { limit = 1200; planLabel = 'Inicial Anual'; break; }
      if (priceId === estandarAnualPrice) { limit = 2400; planLabel = 'Estándar Anual'; break; }
      if (priceId === premiumAnualPrice) { limit = 6000; planLabel = 'Premium Anual'; break; }
    }

    console.log(`[Metered Billing] Plan activo: ${planLabel}. Límite del plan: ${limit} min. Acumulado ciclo: ${totalPeriodMinutes} min.`);

    const callMinutes = Math.ceil(durationSeconds / 60);
    const prevPeriodMinutes = totalPeriodMinutes - callMinutes;

    // 6. Verificar si ha superado el límite
    if (totalPeriodMinutes > limit) {
      // Calcular la porción del exceso que corresponde a esta llamada concreta
      const excessMinutes = totalPeriodMinutes - Math.max(limit, prevPeriodMinutes);
      
      if (excessMinutes > 0) {
        // Encontrar el item metrado de minutos excedentes (Mensual o Anual o Legacy) en la suscripción de Stripe
        const excessPriceIdMonthly = await getSettingVal('STRIPE_PRICE_EXCESS_MINUTES_MONTHLY');
        const excessPriceIdAnnual = await getSettingVal('STRIPE_PRICE_EXCESS_MINUTES_ANNUAL');
        const legacyExcessPriceId = await getSettingVal('STRIPE_PRICE_EXCESS_MINUTES');

        const excessItem = subscription.items.data.find((item: any) => 
          item.price.id === excessPriceIdMonthly || 
          item.price.id === excessPriceIdAnnual || 
          item.price.id === legacyExcessPriceId
        );

        if (!excessItem) {
          console.warn(`[Metered Billing WARNING] No se encontró el ítem de minutos excedentes en la suscripción de Stripe para el inquilino. Asegúrate de que el plan por uso se haya añadido.`);
          return;
        }

        // Reportar el uso a Stripe
        console.log(`[Metered Billing] ⚠️ Límite excedido! Reportando +${excessMinutes} min adicionales a Stripe en el ítem ${excessItem.id}...`);
        
        const secretKey = await getSettingVal('STRIPE_SECRET_KEY');
        if (!secretKey) {
          throw new Error('STRIPE_SECRET_KEY no está configurada.');
        }

        const url = `https://api.stripe.com/v1/subscription_items/${excessItem.id}/usage_records`;
        const params = new URLSearchParams();
        params.append('quantity', String(excessMinutes));
        params.append('timestamp', String(Math.floor(Date.now() / 1000)));
        params.append('action', 'increment');

        await axios.post(url, params, {
          headers: {
            'Authorization': `Bearer ${secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Stripe-Version': '2023-10-16'
          }
        });
        
        console.log(`[Metered Billing] ✅ Exceso de minutos reportado con éxito.`);
      }
    } else {
      console.log(`[Metered Billing] Consumo dentro del límite (${totalPeriodMinutes}/${limit} min). No se requiere reportar exceso.`);
    }

  } catch (err: any) {
    console.error('[Metered Billing ERROR] Error al procesar facturación por uso de llamada:', err.message);
  }
}

/**
 * Crea una sesión de Stripe Checkout para cobrar una fianza de reserva (no-show deposit).
 */
export async function createNoShowDepositSession(
  tenantId: string,
  appointmentId: string,
  amount: number,
  patientPhone: string,
  originUrl: string
): Promise<string> {
  const stripe = await getStripeClient();

  console.log(`🚀 Creando sesión de Stripe Checkout para fianza de cita ${appointmentId} (${amount} EUR)...`);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Reserva de Cita (Fianza)',
            description: 'Depósito de fianza para mitigar inasistencias (no-shows).',
          },
          unit_amount: Math.round(amount * 100), // En céntimos
        },
        quantity: 1,
      },
    ],
    mode: 'payment', // Pago único
    success_url: `${originUrl}/payment-success?appointment_id=${appointmentId}`,
    cancel_url: `${originUrl}/payment-cancel?appointment_id=${appointmentId}`,
    metadata: {
      type: 'no_show_deposit',
      tenant_id: tenantId,
      appointment_id: appointmentId,
      patient_phone: patientPhone,
    },
  });

  if (!session.url) {
    throw new Error('No se pudo generar la URL de Stripe Checkout para la fianza.');
  }

  return session.url;
}

