import { supabase } from '../src/services/supabase';

async function seed() {
  console.log('🌱 Starting database seeding for ElevenLabs agents...');

  // 1. Update existing "Demostración" tenant
  console.log('Updating Demostración agent...');
  const { error: errDemo } = await supabase
    .from('tenants')
    .update({
      business_name: 'Receptia Departamento de Demostraciones',
      business_description: 'Departamento de Demostraciones de Receptia. Atiende a futuros clientes para mostrarles cómo funcionan los recepcionistas virtuales por IA de Receptia.',
      pricing_details: 'Demostración gratuita de 5 minutos.',
      custom_instructions: 'Preséntate siempre como asistente virtual del departamento de demostraciones de Receptia. Pregunta al usuario el nombre del negocio del que desea escuchar la demostración. Usa la herramienta "obtener_telefono_negocio" para obtener el número de teléfono virtual del negocio solicitado. Si la herramienta devuelve un número de teléfono, dile al usuario de forma muy amable "Perfecto, te voy a transferir ahora mismo con el agente de [nombre del negocio] para que escuches su demostración" y llama inmediatamente a la herramienta del sistema "transfer_to_number" pasándole el número devuelto. Si la herramienta no encuentra el negocio o no devuelve ningún número, indícale amablemente que en este momento solo tenemos disponible la demostración de "Peluquería Carlos Romero". Ofrécete a transferirle a esa demostración.',
      knowledge_base_content: 'RECEPTIA - DEPARTAMENTO DE DEMOSTRACIONES\n\nEste agente atiende llamadas en el teléfono de demostración para derivar a los usuarios a los diferentes agentes de voz configurados.\n\nDemos disponibles:\n- Peluquería Carlos Romero (teléfono: +34858215153)\n\nInstrucciones de enrutado:\n- Cuando pidan "peluquería carlos romero", consultar en la base de datos y transferir al número correspondiente.\n- Si piden cualquier otro negocio, informar educadamente que no está disponible la demo, pero que pueden probar la de "Peluquería Carlos Romero".',
      working_hours: {
        monday: [{ start: '00:00', end: '23:59' }],
        tuesday: [{ start: '00:00', end: '23:59' }],
        wednesday: [{ start: '00:00', end: '23:59' }],
        thursday: [{ start: '00:00', end: '23:59' }],
        friday: [{ start: '00:00', end: '23:59' }],
        saturday: [{ start: '00:00', end: '23:59' }],
        sunday: [{ start: '00:00', end: '23:59' }],
        apply_break_rule: false
      }
    })
    .eq('id', 'd1180213-8036-4acd-a6de-3e3287ba73dc');

  if (errDemo) {
    console.error('Error updating Demostración:', errDemo);
  } else {
    console.log('✅ Demostración agent updated successfully.');
  }

  // 2. Create Receptia Atención al Cliente
  const supportId = '77777777-7777-7777-7777-777777777777';
  console.log('Creating Receptia Atención al Cliente...');
  const { error: errSupport } = await supabase
    .from('tenants')
    .upsert({
      id: supportId,
      business_name: 'Receptia Atención al Cliente',
      email: 'soporte@receptia.ai',
      phone_number: '+34858215345',
      business_description: 'Servicio de atención al cliente de Receptia. Explica qué es Receptia y qué puede hacer por los negocios de los futuros clientes.',
      pricing_details: 'Plan Estándar: 149€/mes. Plan Premium: 249€/mes.',
      custom_instructions: 'Eres un asistente de atención al cliente de Receptia. Sé muy profesional, educado y servicial. Tu objetivo es explicar qué es Receptia (una plataforma de recepcionistas virtuales con inteligencia artificial que contestan llamadas 24/7, agendan citas en Google Calendar, responden preguntas frecuentes y envían confirmaciones de WhatsApp). Explica los planes: Estándar por 149€/mes y Premium por 249€/mes. Si el cliente quiere probar el servicio, invítale a colgar e iniciar una demostración gratuita o a visitar receptia.corandar.com.',
      phone_provider: 'zadarma',
      sip_username: '574545-102',
      sip_password: 'cg1x58BLsr',
      sip_server: 'sip.zadarma.com',
      subscription_status: 'active',
      admin_pin: '11223344',
      working_hours: {
        monday: [{ start: '00:00', end: '23:59' }],
        tuesday: [{ start: '00:00', end: '23:59' }],
        wednesday: [{ start: '00:00', end: '23:59' }],
        thursday: [{ start: '00:00', end: '23:59' }],
        friday: [{ start: '00:00', end: '23:59' }],
        saturday: [{ start: '00:00', end: '23:59' }],
        sunday: [{ start: '00:00', end: '23:59' }],
        apply_break_rule: false
      }
    }, { onConflict: 'id' });

  if (errSupport) {
    console.error('Error creating Receptia Atención al Cliente:', errSupport);
  } else {
    console.log('✅ Receptia Atención al Cliente created/updated successfully.');
    // Assign virtual phone number
    const { error: errPhone } = await supabase
      .from('virtual_phones')
      .update({ tenant_id: supportId, status: 'assigned' })
      .eq('phone_number', '+34858215345');
    if (errPhone) {
      console.error('Error assigning virtual phone to support:', errPhone);
    } else {
      console.log('✅ Virtual phone +34858215345 assigned to support agent.');
    }
  }

  // 3. Create Peluquería Duo Peluqueros
  console.log('Creating Peluquería Duo Peluqueros...');
  const { error: errDuo } = await supabase
    .from('tenants')
    .upsert({
      id: '22222222-2222-2222-2222-222222222222',
      business_name: 'Peluquería Duo Peluqueros',
      email: 'duopeluqueros@receptia.ai',
      phone_number: '+34600000001',
      business_description: 'Peluquería moderna Duo Peluqueros. Ofrecemos cortes de caballero, señora, peinados y tintes de última moda.',
      pricing_details: 'Corte caballero: 15€. Corte señora: 25€. Lavado y peinado: 20€.',
      custom_instructions: 'Eres la recepcionista virtual de Peluquería Duo Peluqueros. Tu tono es juvenil, profesional y cercano. Saluda cordialmente y ofrece reservar citas para cortes de pelo, tintes y peinados. Utiliza las herramientas para agendar citas.',
      subscription_status: 'active',
      admin_pin: '22222222',
      working_hours: {
        monday: [{ start: '09:00', end: '20:00' }],
        tuesday: [{ start: '09:00', end: '20:00' }],
        wednesday: [{ start: '09:00', end: '20:00' }],
        thursday: [{ start: '09:00', end: '20:00' }],
        friday: [{ start: '09:00', end: '20:00' }],
        saturday: [{ start: '09:00', end: '14:00' }],
        sunday: [],
        apply_break_rule: false
      }
    }, { onConflict: 'id' });

  if (errDuo) {
    console.error('Error creating Duo Peluqueros:', errDuo);
  } else {
    console.log('✅ Peluquería Duo Peluqueros created/updated successfully.');
  }

  // 4. Create Peluquería La Niña de los Peines
  console.log('Creating Peluquería La Niña de los Peines...');
  const { error: errNina } = await supabase
    .from('tenants')
    .upsert({
      id: '33333333-3333-3333-3333-333333333333',
      business_name: 'Peluquería La Niña de los Peines',
      email: 'laninadelospeines@receptia.ai',
      phone_number: '+34600000002',
      business_description: 'Peluquería tradicional La Niña de los Peines. Especialistas en peinados de flamenca, recogidos de novia y cortes clásicos.',
      pricing_details: 'Peinado de flamenca: 35€. Recogido de novia: 80€. Corte clásico señora: 22€.',
      custom_instructions: 'Eres la recepcionista virtual de Peluquería La Niña de los Peines. Tu tono es muy educado, clásico y acogedor. Ofrece reservar citas y responde sobre nuestros servicios tradicionales y peinados especiales.',
      subscription_status: 'active',
      admin_pin: '33333333',
      working_hours: {
        monday: [{ start: '09:30', end: '19:30' }],
        tuesday: [{ start: '09:30', end: '19:30' }],
        wednesday: [{ start: '09:30', end: '19:30' }],
        thursday: [{ start: '09:30', end: '19:30' }],
        friday: [{ start: '09:30', end: '19:30' }],
        saturday: [{ start: '09:30', end: '13:30' }],
        sunday: [],
        apply_break_rule: false
      }
    }, { onConflict: 'id' });

  if (errNina) {
    console.error('Error creating La Niña de los Peines:', errNina);
  } else {
    console.log('✅ Peluquería La Niña de los Peines created/updated successfully.');
  }

  // 5. Create Caravaning Plaza
  console.log('Creating Caravaning Plaza...');
  const { error: errCaravan } = await supabase
    .from('tenants')
    .upsert({
      id: '44444444-4444-4444-4444-444444444444',
      business_name: 'Caravaning Plaza',
      email: 'caravaningplaza@receptia.ai',
      phone_number: '+34600000003',
      business_description: 'Caravaning Plaza. Venta, alquiler y taller de mantenimiento de caravanas y autocaravanas.',
      pricing_details: 'Alquiler autocaravana: desde 90€/día. Revisión general en taller: 120€. Limpieza completa: 80€.',
      custom_instructions: 'Eres el asistente de voz de Caravaning Plaza. Tu tono es técnico, servicial e informativo. Gestiona reservas de cita para mantenimiento o consultas sobre alquiler de caravanas.',
      subscription_status: 'active',
      admin_pin: '44444444',
      working_hours: {
        monday: [{ start: '08:30', end: '18:30' }],
        tuesday: [{ start: '08:30', end: '18:30' }],
        wednesday: [{ start: '08:30', end: '18:30' }],
        thursday: [{ start: '08:30', end: '18:30' }],
        friday: [{ start: '08:30', end: '18:30' }],
        saturday: [],
        sunday: [],
        apply_break_rule: false
      }
    }, { onConflict: 'id' });

  if (errCaravan) {
    console.error('Error creating Caravaning Plaza:', errCaravan);
  } else {
    console.log('✅ Caravaning Plaza created/updated successfully.');
  }

  console.log('🌿 Seeding completed successfully.');
}

seed();
