import Stripe from 'stripe';
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

  stripeInstance = new Stripe(secretKey);
  return stripeInstance;
}

/**
 * Mapea el ID de plan interno a la clave del ajuste dinámico donde se guarda su ID de precio en Stripe.
 */
const PLAN_PRICE_KEY_MAP: Record<string, string> = {
  estandar_mensual: 'STRIPE_PRICE_ESTANDAR_MENSUAL',
  premium_mensual: 'STRIPE_PRICE_PREMIUM_MENSUAL',
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
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
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
    },
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
