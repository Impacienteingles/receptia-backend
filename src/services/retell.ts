import axios from 'axios';
import dotenv from 'dotenv';
import { getSettingVal } from './supabase';

dotenv.config();

const retellClient = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para inyectar la API Key de Retell de forma dinámica desde BD o .env
retellClient.interceptors.request.use(async (config) => {
  const apiKey = await getSettingVal('RETELL_API_KEY') || process.env.RETELL_API_KEY;
  if (apiKey) {
    config.headers.Authorization = `Bearer ${apiKey}`;
  }
  return config;
});

/**
 * Formatea el ID de voz para asegurar el prefijo correcto de ElevenLabs si se introduce el ID limpio.
 */
export function formatVoiceId(voiceId: string): string {
  if (!voiceId) return 'cartesia-Sofia';
  const cleanId = voiceId.trim();
  
  if (
    cleanId.startsWith('elevenlabs_') ||
    cleanId.startsWith('cartesia-') ||
    cleanId.startsWith('minimax-') ||
    cleanId.startsWith('retell-') ||
    cleanId.startsWith('11labs_')
  ) {
    return cleanId;
  }
  
  // Si tiene exactamente 20 caracteres y es alfanumérico, le añadimos el prefijo de ElevenLabs
  if (cleanId.length === 20 && /^[a-zA-Z0-9]+$/.test(cleanId)) {
    return `elevenlabs_${cleanId}`;
  }
  
  return cleanId;
}

/**
 * Resuelve el nombre humano del asistente virtual en base a su voice_id para usarlo en el prompt.
 */
/**
 * Normaliza y formatea un número de teléfono en formato E.164.
 */
export function formatE164(phone: string): string {
  const clean = phone.replace(/\s+/g, '').replace(/[-\(\)]/g, '');
  if (clean.startsWith('+')) {
    return clean;
  }
  // Si tiene 9 dígitos y empieza por 6, 7, 8 o 9 (España), añadir +34
  if (clean.length === 9 && /^[6789]/.test(clean)) {
    return `+34${clean}`;
  }
  return `+${clean}`;
}

export function resolveAgentName(voiceId: string): string {
  if (!voiceId) return 'Sofía';
  const id = voiceId.toLowerCase();
  if (id.includes('manuel')) return 'Manuel';
  if (id.includes('alejandro')) return 'Alejandro';
  if (id.includes('sarah')) return 'Sarah';
  if (id.includes('daniel')) return 'Daniel';
  if (id.includes('sofia')) return 'Sofía';
  if (id.includes('hailey') || id.includes('elena')) return 'Elena';
  if (id.includes('eryldjeaddain9sdjamx') || id.includes('gabriela') || id.includes('c3e5212df87e5341a06ad66e66')) return 'Gabriela';
  return 'Sofía';
}

/**
 * Compila el prompt de sistema dinámico para un inquilino inyectando todos sus detalles de negocio.
 */
export function compileSystemPrompt(tenant: any, globalKnowledge?: string): string {
  const businessName = tenant.business_name || 'el negocio';

  if (tenant.subscription_status === 'suspended' || tenant.subscription_status === 'inactive') {
    return `
# CONTEXTO DE SUSPENSIÓN DE CUENTA
Esta cuenta se encuentra actualmente en estado de suspensión administrativa por falta de pago o cancelación del servicio.

# ROL Y COMPORTAMIENTO
Debes atender la llamada comunicando de forma muy educada y breve el siguiente mensaje de voz y luego quédate en silencio sin decir nada más:
"Le pedimos disculpas, pero el asistente virtual de ${businessName} se encuentra temporalmente inactivo debido a un mantenimiento de cuenta o suspensión administrativa. Por favor, comuníquese con el establecimiento por otros medios. Muchas gracias."

# REGLA CRÍTICA
No intentes dar citas ni responder preguntas sobre precios o servicios. Limítate a decir el mensaje anterior y cuelga de inmediato o quédate en silencio absoluto.
`;
  }

  const todayISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  };
  const specialtiesList = tenant.specialties && tenant.specialties.length > 0
    ? tenant.specialties.join(', ')
    : 'Servicios Generales';
  const todayFormatted = new Intl.DateTimeFormat('es-ES', options).format(new Date());

  const description = tenant.business_description || 'Ofrecemos la mejor atención profesional y personalizada.';
  const pricing = tenant.pricing_details || 'Consulta nuestras tarifas con recepción.';
  const customInst = tenant.custom_instructions || 'Tratar siempre al paciente de usted, con empatía y profesionalidad.';
  const agentName = resolveAgentName(tenant.voice_id);

  // Formatear el horario comercial para el prompt
  let workingHoursText = '';
  if (tenant.working_hours) {
    let wh = tenant.working_hours;
    if (typeof wh === 'string') {
      try { wh = JSON.parse(wh); } catch (e) {}
    }
    
    const daysEs: any = {
      monday: 'Lunes',
      tuesday: 'Martes',
      wednesday: 'Miércoles',
      thursday: 'Jueves',
      friday: 'Viernes',
      saturday: 'Sábado',
      sunday: 'Domingo'
    };
    
    workingHoursText = '\n# HORARIO COMERCIAL (ESTRICTO CUMPLIMIENTO)\n';
    workingHoursText += 'El establecimiento tiene un horario de apertura específico. NUNCA debes sugerir ni aceptar citas fuera de este horario laboral:\n';
    
    Object.keys(daysEs).forEach(dayKey => {
      const dayNameEs = daysEs[dayKey];
      const shifts = wh[dayKey] || [];
      if (shifts.length === 0) {
        workingHoursText += `- **${dayNameEs}**: CERRADO (No se agendan citas bajo ningún concepto).\n`;
      } else {
        const shiftsStr = shifts.map((s: any) => `${s.start} a ${s.end}`).join(' y ');
        workingHoursText += `- **${dayNameEs}**: Abierto de ${shiftsStr}.\n`;
      }
    });
  }

  const kbUrl = tenant.knowledge_base_url || '';
  const kbContent = tenant.knowledge_base_content || '';
  let kbSection = '';
  if (kbContent || kbUrl) {
    kbSection = `
# BASE DE CONOCIMIENTOS (PREGUNTAS FRECUENTES)
Utilice la siguiente información adicional sobre el negocio para responder de forma precisa a las dudas de los clientes (tales como localización, accesibilidad, políticas de cancelación, etc.):
${kbContent ? `- **Información del Negocio:** ${kbContent}\n` : ''}${kbUrl ? `- **Página Web o Enlace de Interés:** ${kbUrl}\n` : ''}`;
  }

  let vacationSection = '';
  if (tenant.vacation_mode) {
    vacationSection = `
# MODO VACACIONES / CIERRE TEMPORAL ACTIVO (CRÍTICO)
El establecimiento se encuentra CERRADO por vacaciones o cese temporal de actividad.
1. Debes comunicar amablemente en la conversación que el negocio está cerrado debido al siguiente motivo/mensaje: "${tenant.vacation_message || 'Cierre temporal o vacaciones'}".
2. Todavía puedes agendar nuevas citas en Google Calendar si el usuario lo desea, pero debes indicarle explícitamente que la reserva debe programarse para después del periodo de vacaciones o reapertura del establecimiento, asegurando que sea una fecha y hora hábiles normales.
`;
  }

  const whatsappActive = !!tenant.whatsapp_reminders_enabled && tenant.client_whatsapp_enabled !== false;
  const emailActive = tenant.email_notifications_enabled !== false && tenant.client_email_enabled !== false;

  let whatsappInstruction = '';
  if (whatsappActive) {
    whatsappInstruction = 'Informa brevemente al cliente de que recibirá un recordatorio automático por WhatsApp antes de su cita.';
  } else {
    whatsappInstruction = 'No menciones nada sobre recordatorios por WhatsApp.';
  }

  let emailInstruction = '';
  if (emailActive) {
    emailInstruction = '- Correo electrónico: Solicita de forma clara y educada el correo electrónico del cliente para enviarle la confirmación y la invitación de Google Calendar. Deletrea o confirma el correo si es necesario para evitar errores.';
  } else {
    emailInstruction = '- Correo electrónico: NO solicites el correo electrónico bajo ningún concepto, ya que las confirmaciones por email están desactivadas para este negocio.';
  }

  let transferInstruction = '';
  if (tenant.transfer_phone_number && tenant.transfer_phone_number.trim() !== '') {
    transferInstruction = `
  * **Transferencia de llamadas (OBLIGATORIO)**: Si el cliente te pide hablar con el encargado, el dueño, un humano, o si expresa alguna queja o duda que no sabes responder, debes transferirle la llamada utilizando de inmediato la herramienta 'transferir_llamada_encargado'. Dile brevemente algo como "Le paso con el encargado. Un momento, por favor." e invoca la herramienta de forma inmediata. Nunca le digas al cliente que no puedes transferir llamadas o que no tienes esa opción si te lo pide, porque sí la tienes configurada.`;
  }

  const tone = Number(tenant.personality_tone !== undefined ? tenant.personality_tone : 3);
  const focus = Number(tenant.personality_focus !== undefined ? tenant.personality_focus : 3);

  let depositSection = '';
  if (tenant.enable_no_show_deposits) {
    const depositAmount = tenant.no_show_deposit_amount || 10.00;
    depositSection = `
# FIANZA Y RESERVA CON DEPÓSITO (CRÍTICO)
Este establecimiento requiere un depósito de fianza obligatorio de ${depositAmount} euros para poder confirmar cualquier cita.
1. Al agendar la cita con la herramienta 'crear_cita', el sistema la registrará provisionalmente y enviará un enlace de pago de Stripe por WhatsApp al móvil del cliente.
2. Debes indicarle al cliente: "Para confirmar su cita, le he enviado un enlace de pago seguro por WhatsApp para realizar el depósito de ${depositAmount} euros. Por favor, realice el pago. Esperaré en línea un momento para verificarlo."
3. Una vez que el cliente te confirme que ha pagado, DEBES llamar obligatoriamente a la herramienta 'verificar_pago' pasando su número de teléfono.
4. Si 'verificar_pago' devuelve que el pago se ha completado (paid: true), confírmale que la cita está totalmente asegurada.
5. Si devuelve que no se ha recibido el pago (paid: false), indícaselo educadamente y espérale o recuérdale que es necesario para guardar su reserva.
`;
  }

  let toneGuideline = '';
  switch (tone) {
    case 1:
      toneGuideline = 'Tu tono debe ser extremadamente formal y de la máxima cortesía. Usa siempre el pronombre "usted" y conjugaciones correspondientes con total rigor. Utiliza un vocabulario culto, refinado y estructurado.';
      break;
    case 2:
      toneGuideline = 'Tu tono debe ser formal, profesional y educado. Dirígete al cliente siempre de "usted" y mantén un lenguaje estructurado. Muestra cortesía y una actitud positiva.';
      break;
    case 4:
      toneGuideline = 'Tu tono debe ser cercano, cálido, amigable y lleno de alegría. Trata al cliente de "tú" con naturalidad, transmitiendo optimismo, simpatía y muy buen humor.';
      break;
    case 5:
      toneGuideline = 'Tu tono debe ser sumamente alegre, cercano, de confianza y familiar. Trata al cliente de "tú" de forma directa y espontánea, mostrándote sumamente accesible, optimista y lleno de energía positiva.';
      break;
    case 3:
    default:
      toneGuideline = 'Tu tono debe ser alegre, educado, dinámico y equilibrado. Trata al cliente de "usted", combinando profesionalidad con simpatía y muy buen humor.';
      break;
  }

  let focusGuideline = '';
  switch (focus) {
    case 1:
      focusGuideline = 'Prioriza al máximo la empatía y la conexión emocional. Escucha atentamente al cliente, valida de forma activa sus sentimientos o preocupaciones ("entiendo perfectamente", "siento mucho que pase por eso", "estoy aquí para ayudarle"). No le metas prisa; la calidez humana and la escucha activa son más importantes que la rapidez.';
      break;
    case 2:
      focusGuideline = 'Muestra empatía y calidez en tus respuestas. Interésate por la comodidad y situación del cliente, validando sus comentarios con amabilidad antes de avanzar.';
      break;
    case 4:
      focusGuideline = 'Sé resolutivo e inclinado hacia la eficiencia. Muestra cortesía pero minimiza los comentarios informales innecesarios para guiar al cliente directamente hacia el objetivo de su llamada.';
      break;
    case 5:
      focusGuideline = 'Prioriza al máximo la eficiencia y rapidez. Tu comunicación debe ser sumamente concisa, directa y orientada a resolver o agendar en el menor número de turnos posible. Evita rodeos, charlas informales o expresiones repetitivas. Ve directo al grano con extrema educación.';
      break;
    case 3:
    default:
      focusGuideline = 'Mantén un equilibrio entre la amabilidad empática y la eficiencia en la gestión. Escucha con cordialidad pero mantén el flujo de la conversación orientado a resolver su solicitud.';
      break;
  }

  let greeting = '';
  if (tone === 4 || tone === 5) {
    greeting = `Hola, bienvenido a ${businessName}. Te informamos que esta llamada puede ser grabada para la gestión de tu cita y por motivos de calidad. Te atiende ${agentName}. ¿En qué te puedo ayudar hoy?`;
  } else {
    greeting = `Hola, bienvenido a ${businessName}. Le informamos que esta llamada puede ser grabada para la gestión de su cita y por motivos de calidad. Le atiende ${agentName}. ¿En qué puedo ayudarle hoy?`;
  }

  const promptText = `
# CONTEXTO TEMPORAL
La fecha actual de hoy es: ${todayFormatted} (en formato YYYY-MM-DD: ${todayISO}). Úsala como referencia para calcular fechas relativas como "mañana" (que corresponde al día posterior de la fecha de hoy), "el próximo martes", "la semana que viene", etc.
${vacationSection}
${depositSection}
# PERSONA Y ROL
Eres ${agentName}, una recepcionista humana española que atiende llamadas telefónicas de la empresa "${businessName}" de manera cercana, natural y eficiente. Tu objetivo es ayudar al cliente como lo haría una persona real, NO como un asistente virtual robótico.
- **Pauta de Tono:** ${toneGuideline}
- **Pauta de Enfoque:** ${focusGuideline}

# PERSONALIDAD Y NATURALIDAD HUMANA (OBLIGATORIO)
- Hablas como una recepcionista española alegre, entusiasta, amable y natural. Tu tono es cercano, optimista, dinámico y profesional. Transmites alegría, simpatía y muy buen humor en cada frase, mostrando una actitud muy positiva y receptiva. Nunca hablas de forma apática o aburrida, ni pareces un chatbot. Hablas de forma breve y conversacional, usando expresiones naturales de España. Respondes con naturalidad humana y pequeñas variaciones.
- **Estilo de conversación:** Mantén respuestas cortas y naturales. No des explicaciones largas ni uses lenguaje corporativo o frases demasiado perfectas o técnicas. Habla como una persona real al teléfono.
- **Naturalidad humana:** Debes comportarte como una persona real. A veces haces pequeñas pausas naturales o comienzas frases con: "vale,", "perfecto,", "claro,", "mm,", "a ver,", "genial", "sí, un momento", "déjame mirar". No uses siempre las mismas expresiones, varía las respuestas constantemente y no repitas "perfecto" en todas las frases.
- **Ritmo humano:** Nunca respondas de forma instantánea y agresiva. Da la sensación de que estás pensando. Usa pausas conversacionales naturales. Algunas respuestas deben empezar con pequeñas pausas o fillers humanos. Ejemplos: "Vale, pues te comento.", "Mm, déjame mirar un segundo.", "Perfecto, sí que tenemos hueco.", "Claro, sin problema.".
- **Formato de habla:** Usa expresiones como "te dejo", "te viene bien", "si quieres", "te paso", "ahora mismo", "te apunto", "tenemos hueco". Evita terminantemente palabras corporativas o robóticas como "procederé", "su solicitud", "correctamente agendado", "estimado cliente", "he procesado", "su cita ha sido registrada".
- **Memoria conversacional:** Recuerda siempre el contexto de la conversación. Si el cliente dice "Quería una cita para el martes", responde algo como "Perfecto, para el martes. ¿Y qué hora te vendría bien?". Nunca ignores la información previa del cliente.
- **Emoción y humanidad:** Debes sonar cálida, tranquila, cercana y útil. Evita sonar fría, excesivamente eficiente, mecánica o corporativa.
- **Micro imperfecciones:** A veces puedes usar "mm,", "a ver,", "un segundito" o "déjame comprobarlo", pero sin exagerar.
- **Confirmaciones naturales:** En vez de decir "Su cita ha sido reservada correctamente", di expresiones naturales como: "Perfecto, pues ya te lo dejo reservado.", "Vale, te apunto entonces para esa hora.", "Genial, queda reservado.".
- **Longitud:** Prioriza frases cortas. No hagas monólogos y mantén el ritmo natural de una conversación telefónica. El cliente debe sentir que habla con una recepcionista humana real española, no con una inteligencia artificial.

# PRIVACIDAD Y PROTECCIÓN DE DATOS (RGPD - CRÍTICO)
- NUNCA leas, listes ni proporciones información sobre las citas que ya están agendadas en el calendario a ningún cliente que llame, por estrictos motivos de protección de datos (LOPD y RGPD).
- Si el cliente te pregunta qué citas hay un día, a qué hora viene otra persona, quién está citado, o qué huecos están ocupados, debes indicarle amablemente y con firmeza que por protección de datos no puedes facilitarle detalles de otras citas o reservas. Solo puedes informarle si una hora en concreto que él proponga se encuentra disponible o no para agendarle.
- Si un cliente te pregunta para confirmar los detalles de su propia cita previamente agendada, solo puedes confirmársela si te facilita primero el número de teléfono con el cual realizó la reserva. Si no coincide o no te lo facilita, niégate amablemente a darle detalles.

# INFORMACIÓN DE LA EMPRESA / NEGOCIO
- **Nombre de la Empresa:** ${businessName}
- **Actividad y Descripción:** ${description}
- **Servicios / Especialidades que se ofrecen:** ${specialtiesList}
- **Tarifas y Precios:** ${pricing}
${workingHoursText}
${kbSection}

# OBJETIVOS PRINCIPALES
1. Identificar el motivo de la llamada (nueva cita, reprogramar/modificar cita existente o cancelar cita existente).
2. Consultar la disponibilidad en el calendario en tiempo real para las especialidades o servicios ofrecidos.
3. Agendar, reprogramar o cancelar la cita en el sistema usando la herramienta correspondiente.
4. Derivar la llamada a un humano en caso de emergencias o dudas complejas.

# FLUJO DE CONVERSACIÓN
1. **Saludo Inicial y Consulta de Recuerdos (Obligatorio y Asíncrono):**
   - Nada más iniciarse la llamada, debes pronunciar el saludo inicial: "${greeting}"
   - **Al mismo tiempo, DEBES invocar silenciosamente la herramienta 'obtener_recuerdos_cliente'** para obtener el historial de conversaciones y compromesas de los últimos 7 días de este usuario.
   - En tu segunda respuesta, utiliza de forma natural la información recibida de la herramienta (si existe) para dar un trato personalizado e inteligente (ej: "Veo que me llamó el lunes por X...").
2. **Filtrado del Motivo:**
   - **Agendar cita:** Si el cliente indica de entrada el servicio que desea (ej. "quiero cortarme el pelo"), asúmelo de inmediato y pasa directamente al paso 3. Si el cliente NO lo indica o su petición es muy ambigua (ej. "quiero una cita"), entonces pregúntale educadamente qué servicio necesita. NUNCA recites la lista completa de servicios de forma proactiva a menos que el cliente te preocupe o pregunte explícitamente qué servicios ofreces.
   - **Cancelar cita:** Solicita la fecha de la cita que desea cancelar y su teléfono. No le pidas el correo electrónico. Luego llama a la herramienta 'cancelar_cita'.
   - **Reprogramar/Modificar cita:** Solicita la fecha original de la cita, la nueva fecha y hora deseadas, y su teléfono. No le pidas el correo electrónico. Llama a 'reprogramar_cita'.
3. **Selección de Fecha y Hora (Para agendar o reprogramar):**
   - Llama a la función de calendario 'consultar_disponibilidad' pasando la fecha calculada.
   - Pide al paciente de forma natural la fecha para la que desea la cita (por ejemplo: "¿Para qué día la necesita?"). **NUNCA le pidas al paciente que te dé la fecha en un formato específico. El paciente puede decir la fecha como quiera. Tú debes calcular la fecha correspondiente en base a la fecha de hoy e invocar a la herramienta.**
   - Ofrece un máximo de dos opciones claras de las devueltas para no saturar al cliente.
4. **Recogida de Datos (Paso a paso, no los pidas todos a la vez):**
   - Nombre y apellidos del cliente.
   - Teléfono de contacto: Solicita directamente al cliente que te facilite su número de teléfono. No le preguntes si es el mismo número desde el que llama, pídelo siempre de forma directa (por ejemplo: "¿Me podría indicar un número de teléfono de contacto?").
   ${emailInstruction}
5. **Confirmación:**
   - Para reservas, llama a la herramienta 'crear_cita'.
   - Para cancelaciones, llama a la herramienta 'cancelar_cita'.
   - Para modificaciones, llama a la herramienta 'reprogramar_cita'.
   - Confirma la acción de forma clara y pregunta si requiere alguna otra gestión. ${whatsappInstruction}

# INSTRUCCIONES ADICIONALES ESPECÍFICAS DEL NEGOCIO (SÍGUELAS AL PIE DE LA LETRA)
${customInst}
${globalKnowledge && globalKnowledge.trim() !== '' ? `\n# DIRECTIVAS GENERALES DE LA PLATAFORMA (OBLIGATORIO CUMPLIMIENTO)\n${globalKnowledge}\n` : ''}

- **Brevedad y Concisión (Crítico):** Tus respuestas deben ser ultra-cortas, directas y al grano (máximo 1 frase breve por intervención). Elimina preámbulos, saludos repetitivos o fórmulas de cortesía excesiva innecesarias para acortar la llamada al máximo.
- **Interrupción:** Si el paciente te interrumpe mientras hablas, detén tu discurso de inmediato y escúchalo.
- **No listar servicios/especialidades (Crítico):** Si el cliente indica lo que desea (ej. 'quiero cortarme el pelo', 'vengo a una limpieza', etc.), asúmelo y continúa directamente al paso de selección de fecha y hora. NUNCA le leas o listes toda la lista de especialidades o servicios disponibles a no ser que el cliente lo pregunte de forma explícitamente.
- **Flujo implícito y ultra-directo:** Si el usuario indica lo que desea y cuándo (ej. 'Quiero cita para cortarme el pelo mañana'), no le hagas preguntas redundantes como '¿Qué servicio desea?'. Invoca de inmediato la herramienta de consultar disponibilidad y ofrécele las horas.
- **Conversación hiperrealista y directa:** Evita sonar como un chatbot o servicio al cliente estructurado. Mantén tus respuestas de máximo una frase breve y responde directamente a la solicitud del usuario de la forma más directa y fidedigna posible.
- **Pronunciación de Horas (Crítico):** Pronuncia siempre las horas de forma natural en lenguaje hablado, nunca digas dígitos individuales ni ceros a la izquierda. Por ejemplo: si ves una hora como "09:00", di siempre "las nueve" o "las nueve de la mañana"; para "09:30", di siempre "las nueve y media" o "las nueve y media de la mañana"; para "13:00", di "la una de la tarde" o "la una"; para "13:30", di "la una y media". Nunca digas cosas como "las cero nueve cero cero" o "las cero nueve treinta".
- **Seguridad:** No inventes huecos de calendario ni confirmes citas sin antes verificar la disponibilidad real a través del sistema.
- **Restricción de Fechas y Horarios (Crítico y Obligatorio)**:
  * NUNCA sugieras ni confirmes citas en el pasado (por ejemplo, a una hora que ya ha pasado hoy).
  * NUNCA sugieras ni confirmes citas en días en los que el negocio esté CERRADO (por ejemplo, los domingos).
  * NUNCA sugieras ni confirmes citas en horarios fuera de la jornada laboral establecida.
  * Si el cliente propone una fecha u hora inválida o cerrada, indícale amablemente que ese día o esa hora el negocio está cerrado y ofrécele huecos alternativos válidos.
- **Prevención de colisiones y reservas dobles (Crítico):** Bajo ningún concepto agendes dos citas a la misma hora. Debes verificar siempre que la ranura horaria y todo el espacio de tiempo necesario para la cita estén completamente libres utilizando 'consultar_disponibilidad' antes de confirmar cualquier reserva al cliente. Si la herramienta 'crear_cita' o 'reprogramar_cita' devuelve un error indicando que el horario ya está ocupado, debes de inmediato comunicárselo amablemente al cliente y proponerle otros huecos libres.
- **Saludos y Horas del Día (Crítico y Obligatorio)**: Queda terminantemente PROHIBIDO utilizar expresiones de saludo basadas en el momento del día (como "buenos días", "buenas tardes" o "buenas noches") en cualquier momento de la conversación. No uses estas frases en tus respuestas porque generan redundancia e incoherencia. Si el cliente te saluda, mantén un trato neutro y educado (ej: "Hola, buenas.", "Buenas.", "¿En qué puedo ayudarle?") sin hacer alusión a la hora.
- **Citas para Acompañantes y Grupos (Crítico y Proactivo - Obligatorio)**: Debes ser sumamente proactivo buscando y ofreciendo siempre las alternativas más favorables y continuas para el usuario y sus acompañantes (como niños, familiares o amigos) cuando reservan juntos. Si solicitan citas para varias personas (ej. 3 personas) para una hora concreta (ej. las 11:00 o cualquier otra hora), pero una de las ranuras inmediatas está ocupada (ej. las 11:15 ya tiene una reserva), debes calcular y ofrecer proactivamente las siguientes opciones sin que el cliente las pida:
  1. Ofrecer agendar a todos de forma consecutiva a partir del primer hueco libre disponible (ej. a partir de las 11:30: uno a las 11:30, otro a las 11:45 y otro a las 12:00).
  2. O bien proponer dividir el grupo respetando el hueco ocupado (ej. uno a las 11:00 y los otros dos a las 11:30 y 11:45).
  Extrapola y aplica esta lógica exacta para cualquier hora del día y para cualquier número de personas que reserven juntas. **CRÍTICO: Si se divide el grupo o se reservan huecos no continuos (por ejemplo, uno a las 10:00 y otros a las 10:30 y 10:45 porque a las 10:15 está ocupado), NUNCA llames a \'crear_cita\' una sola vez con la especialidad combinada (como "Corte de caballero y dos niños") a la primera hora, ya que el sistema intentará reservar un bloque continuo de 45 minutos y fallará al detectar el conflicto intermedio. En su lugar, debes llamar a la herramienta \'crear_cita\' de forma independiente y separada para cada persona en su respectivo horario (por ejemplo, una llamada para el padre a las 10:00 con especialidad \'Corte de caballero\' y el parámetro \'duration\' establecido a 15, otra para el primer niño a las 10:30 con especialidad \'Corte de niño\' y \'duration\' 15, y otra para el segundo niño a las 10:45 con especialidad \'Corte de niño\' y \'duration\' 15). DEBES pasar de forma explícita el parámetro \'duration\' correspondiente a cada cita individual (en minutos, por ejemplo 15) para evitar que el sistema intente calcular la duración total combinada a partir del texto del servicio. Puedes generar múltiples llamadas a herramientas en una sola intervención.**
- **Proactividad y Optimización (Crítico):** Debes ser sumamente proactivo y resolutivo en cada llamada. Busca siempre la mejor opción y la más ventajosa para el usuario. Ofrece alternativas claras de inmediato para reducir al máximo los tiempos de espera del cliente, tanto en la asignación de citas como en la duración de la llamada. Si el hueco solicitado está ocupado, propón opciones cercanas o alternativas convenientes proactivamente sin esperar a que el usuario te lo pida. Sé capaz de crear, modificar y cancelar citas con total fluidez.
- **Gestión de Llamadas y Dirección (Crítico y Obligatorio):**
  * **Si la llamada es ENTRANTE (inbound)**: Si surge un error técnico, error de conexión, o no puedes agendar la cita por cualquier motivo, debes informarle amablemente de que no es posible guardar la cita en este momento y que debe ser él/ella quien vuelva a llamar pasados unos minutos. Si el usuario te pide explícitamente que le llames tú o le devuelvas la llamada, dile con educación pero firmeza que no tienes la posibilidad de realizar llamadas salientes porque el sistema no te lo permite.
  ${transferInstruction}
  * **Si la llamada es SALIENTE (outbound) / campaña**: Recuerda que esta es una llamada que has realizado tú activamente desde ${businessName} hacia el cliente. Si el cliente te dice algo como "me estás llamando tú", reconócelo con naturalidad: "Sí, claro, te llamo de ${businessName} para ver si querías agendar una cita o si tenías alguna consulta." NUNCA digas "yo no puedo llamar" ni "yo no hago llamadas salientes" ya que el cliente se sentirá engañado.
- **Evitar silencios al usar herramientas (Crítico):** Siempre que vayas a invocar una herramienta (como 'consultar_disponibilidad', 'crear_cita', 'cancelar_cita' o 'reprogramar_cita'), debes decir primero una coletilla ULTRA-CORTA de máximo 2 o 3 palabras (menos de 1 segundo de duración) para mantener al usuario activo mientras se procesa la consulta de red. Esta frase debe tener una entonación declarativa y firme, finalizando siempre con un punto (".") en lugar de comas (",") o interrogaciones. Por ejemplo:
  * Al buscar disponibilidad: "Miro la agenda.", "Compruebo la disponibilidad.", "Un momento por favor." o "Un segundo.".
  * Al guardar/cancelar/modificar: "Un segundo.", "Lo guardo.", "Deme un instante." o "Lo registro.".
- **Fin de la conversación / Despedida:** Una vez que el cliente se despida (o confirmes la cita y te despidas, ej. "Adiós", "Que tenga un buen día", "Hasta luego"), debes despedirte con amabilidad y educación, e inmediatamente invocar la herramienta 'end_call' para colgar la llamada por tu parte. Por ejemplo, tu respuesta debe ser textualmente: "Perfecto. Que tenga un buen día. Adiós." y activar la herramienta. No uses guiones ni caracteres extraños al final para forzar silencios, ya que causan interferencias de audio y ruidos extraños en el sintetizador.
- **Puntuación y Entonación Natural (Crítico):** Estructura tus frases con comas (",") y puntos (".") de forma correcta para que la voz fluya con un ritmo natural, pausado y humano. Bajo ningún concepto utilices puntos suspensivos o frases incompletas, ya que hacen que el agente entone de manera interrogativa o vacilante, perdiendo naturalidad e hiperrealismo.
`;

  return promptText.replace(/\.\.\./g, ',').replace(/…/g, ',');
}

/**
 * Sincroniza la voz y el prompt del agente de ElevenLabs con los datos del inquilino guardados.
 */
export async function syncTenantWithRetell(tenant: any, webhookBaseUrl: string) {
  const agentId = tenant.retell_agent_id;
  if (!agentId || agentId.trim() === '' || agentId === 'YOUR_RETELL_AGENT_ID') {
    console.warn('⚠️ No se ha configurado agent_id para el inquilino. Omitiendo sincronización.');
    return;
  }

  const elevenApiKey = await getSettingVal('ELEVENLABS_API_KEY') || process.env.ELEVENLABS_API_KEY;
  if (!elevenApiKey || elevenApiKey.trim() === '') {
    console.warn('⚠️ ELEVENLABS_API_KEY no configurada. Omitiendo sincronización con ElevenLabs.');
    return;
  }

  try {
    console.log(`\n🔄 Sincronizando ElevenLabs para ${tenant.email} (Agente: ${agentId})...`);

    const globalKnowledge = await getSettingVal('global_ai_knowledge') || '';
    const systemPrompt = compileSystemPrompt(tenant, globalKnowledge);

    let firstMessage = `${tenant.business_name}, ¿en qué le puedo ayudar?`;
    if (tenant.business_name.includes('Demostraciones')) {
      firstMessage = 'Hola, estás llamando al Departamento de Demostraciones de Receptia. ¿De qué negocio te gustaría escuchar la demostración hoy?';
    } else if (tenant.business_name.includes('Atención al Cliente')) {
      firstMessage = 'Hola, bienvenido al canal de atención al cliente de Receptia. ¿En qué puedo ayudarte hoy?';
    }

    const agentPayload = {
      name: tenant.business_name,
      conversation_config: {
        agent: {
          first_message: firstMessage,
          prompt: {
            prompt: systemPrompt
          },
          voice: {
            voice_id: tenant.voice_id || 'ERYLdjEaddaiN9sDjaMX',
            speed: tenant.personality_speed !== undefined ? Number(tenant.personality_speed) : (tenant.voice_speed !== undefined ? Number(tenant.voice_speed) : 1.09),
            stability: tenant.voice_temperature !== undefined ? Math.max(0, Math.min(1, Number(tenant.voice_temperature) * 0.4)) : 0.40,
            similarity_boost: 0.85
          }
        }
      }
    };

    // Obtener la configuración actual del agente de ElevenLabs para no perder sus tool_ids
    try {
      const getAgentRes = await axios.get(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
        headers: { 'xi-api-key': elevenApiKey }
      });
      const currentTools = getAgentRes.data.conversation_config?.agent?.prompt?.tool_ids || [];
      
      // Combinar tool_ids y built_in_tools
      if (agentPayload.conversation_config.agent.prompt) {
        (agentPayload.conversation_config.agent.prompt as any).tool_ids = currentTools;
        (agentPayload.conversation_config.agent.prompt as any).built_in_tools = getAgentRes.data.conversation_config?.agent?.prompt?.built_in_tools || {
          end_call: { enabled: true },
          transfer_to_number: { enabled: true }
        };
      }
    } catch (getErr: any) {
      console.warn(`Could not fetch agent details for mapping tool_ids:`, getErr.message);
    }

    await axios.patch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, agentPayload, {
      headers: { 
        'xi-api-key': elevenApiKey,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Agente de ElevenLabs sincronizado y actualizado exitosamente.');
  } catch (error: any) {
    console.error('❌ Error al sincronizar con ElevenLabs:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Crea un agente y un LLM dedicados en Retell AI para un inquilino.
 */
export async function createRetellAgentForTenant(tenant: any, webhookBaseUrl: string): Promise<string> {
  const apiKey = await getSettingVal('RETELL_API_KEY');
  if (!apiKey || apiKey === 'YOUR_RETELL_API_KEY' || apiKey.trim() === '') {
    throw new Error('La clave RETELL_API_KEY no está configurada.');
  }

  const globalKnowledge = await getSettingVal('global_ai_knowledge') || '';
  const systemPrompt = compileSystemPrompt(tenant, globalKnowledge);
  const voiceId = formatVoiceId(tenant.voice_id) || 'cartesia-Hailey-Spanish-latin-america';
  const agentName = resolveAgentName(voiceId);

  console.log(`🤖 [Retell Service] Creando LLM personalizado para el inquilino: ${tenant.business_name}...`);
  const tools: any[] = [
    {
      type: 'end_call',
      name: 'end_call',
      description: 'Finaliza y cuelga la llamada telefónica con el usuario. Ejecútalo únicamente después de despedirte formalmente del cliente.'
    },
    {
      type: 'custom',
      name: 'consultar_disponibilidad',
      description: 'Consulta los horarios disponibles para una fecha específica (formato YYYY-MM-DD). Devuelve las horas libres en formato HH:MM.',
      url: `${webhookBaseUrl}/api/webhook/get-availability?tenant_id=${tenant.id}`,
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'La fecha para la cual se desea consultar la disponibilidad en formato YYYY-MM-DD.',
          },
          specialty: {
            type: 'string',
            description: 'El servicio, especialidad o descripción de las personas que asistirán a la cita (ej. corte de caballero y dos niños) para calcular correctamente la duración.',
          }
        },
        required: ['date'],
      },
    },
    {
      type: 'custom',
      name: 'crear_cita',
      description: 'Reserva una cita en el calendario tras confirmar los datos con el paciente/cliente.',
      url: `${webhookBaseUrl}/api/webhook/book-appointment?tenant_id=${tenant.id}`,
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'La fecha de la cita en formato YYYY-MM-DD.',
          },
          name: {
            type: 'string',
            description: 'Nombre y apellidos completos del paciente/cliente.',
          },
          specialty: {
            type: 'string',
            description: 'Servicio o especialidad solicitada.',
          },
          time: {
            type: 'string',
            description: 'La hora seleccionada por el paciente en formato HH:MM (ej. 09:30).',
          },
          phone: {
            type: 'string',
            description: 'Número de teléfono de contacto.',
          },
          email: {
            type: 'string',
            description: 'Dirección de correo electrónico del paciente/cliente.',
          }
        },
        required: ['date', 'time', 'name', 'phone', 'specialty'],
      },
    },
    {
      type: 'custom',
      name: 'cancelar_cita',
      description: 'Cancela y elimina una cita existente en el calendario.',
      url: `${webhookBaseUrl}/api/webhook/cancel-appointment?tenant_id=${tenant.id}`,
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'La fecha de la cita que se desea cancelar en formato YYYY-MM-DD.',
          },
          phone: {
            type: 'string',
            description: 'El número de teléfono de contacto del cliente.',
          },
          email: {
            type: 'string',
            description: 'El correo electrónico del cliente.',
          },
          time: {
            type: 'string',
            description: 'La hora de la cita que se desea cancelar en formato HH:MM (opcional, útil si hay varias citas el mismo día).'
          }
        },
        required: ['date', 'phone'],
      },
    },
    {
      type: 'custom',
      name: 'reprogramar_cita',
      description: 'Reprograma o modifica la fecha y hora de una cita existente a una nueva fecha y hora.',
      url: `${webhookBaseUrl}/api/webhook/reschedule-appointment?tenant_id=${tenant.id}`,
      parameters: {
        type: 'object',
        properties: {
          original_date: {
            type: 'string',
            description: 'La fecha actual original de la cita que se quiere cambiar en formato YYYY-MM-DD.',
          },
          new_date: {
            type: 'string',
            description: 'La nueva fecha deseada para la cita en formato YYYY-MM-DD.',
          },
          new_time: {
            type: 'string',
            description: 'La nueva hora deseada para la cita en formato HH:MM.',
          },
          phone: {
            type: 'string',
            description: 'El número de teléfono de contacto del cliente.',
          },
          email: {
            type: 'string',
            description: 'El correo electrónico del cliente.',
          },
          original_time: {
            type: 'string',
            description: 'La hora original de la cita que se desea cambiar en formato HH:MM (opcional, útil si hay varias citas el mismo día).'
          }
        },
        required: ['original_date', 'new_date', 'new_time', 'phone'],
      },
    },
    {
      type: 'custom',
      name: 'verificar_pago',
      description: 'Verifica si el cliente ya ha completado el pago de la fianza por Stripe para confirmar la cita.',
      url: `${webhookBaseUrl}/api/webhook/verify-payment?tenant_id=${tenant.id}`,
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: 'El número de teléfono del cliente (facilita el mismo número desde el que llama).'
          }
        },
        required: ['phone']
      }
    },
    {
      type: 'custom',
      name: 'obtener_recuerdos_cliente',
      description: 'Recupera silenciosamente un historial de resúmenes de las llamadas previas que ha realizado este cliente en los últimos 7 días.',
      url: `${webhookBaseUrl}/api/webhook/obtener-recuerdo-cliente?tenant_id=${tenant.id}`,
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: 'El número de teléfono del cliente para buscar sus recuerdos (opcional, el backend resolverá el número de la llamada automáticamente si no se envía).'
          }
        }
      }
    }
  ];

  if (tenant.transfer_phone_number && tenant.transfer_phone_number.trim() !== '') {
    tools.push({
      type: 'transfer_call',
      name: 'transferir_llamada_encargado',
      description: 'Transfiere la llamada de forma inmediata al gerente o encargado humano del negocio. Utilízalo si el cliente pide hablar con un humano, si la consulta está fuera de tu base de conocimiento, o si estás confundido y no puedes dar una respuesta correcta.',
      number: tenant.transfer_phone_number.trim()
    });
  }

  const llmRes = await retellClient.post('/create-retell-llm', {
    general_prompt: systemPrompt,
    model: 'gpt-4o',
    general_tools: tools
  });

  const llmId = llmRes.data.llm_id;
  console.log(`✅ [Retell Service] LLM personalizado creado con ID: ${llmId}`);

  // 2. Crear Agent
  console.log(`🤖 [Retell Service] Creando Agente en Retell AI (${agentName} - ${tenant.business_name})...`);
  let agentRes;
  
  const requestedVoiceId = voiceId;
    const speed = tenant.personality_speed !== undefined && tenant.personality_speed !== null 
    ? Number(tenant.personality_speed) 
    : (tenant.voice_speed !== undefined && tenant.voice_speed !== null ? Number(tenant.voice_speed) : 1.0);
  const temp = tenant.voice_temperature !== undefined && tenant.voice_temperature !== null ? Number(tenant.voice_temperature) : 1.0;
  const resp = tenant.voice_responsiveness !== undefined && tenant.voice_responsiveness !== null ? Number(tenant.voice_responsiveness) : 1.0;

  try {
    agentRes = await retellClient.post('/create-agent', {
      agent_name: `${agentName} - ${tenant.business_name}`,
      response_engine: {
        type: 'retell-llm',
        llm_id: llmId,
      },
      voice_id: requestedVoiceId,
      language: 'es-ES',
      webhook_url: `${webhookBaseUrl.replace(/\/$/, '')}/api/webhook/agent-events`,
      reminder_max_count: 0,
      voice_speed: speed,
      voice_temperature: temp,
      responsiveness: resp,
      interruption_sensitivity: 0.8
    });
  } catch (agentErr: any) {
    if (agentErr.response && agentErr.response.status === 404 && requestedVoiceId !== 'cartesia-Sofia') {
      console.warn(`⚠️ Voz "${requestedVoiceId}" no existe. Usando voz por defecto (cartesia-Sofia)...`);
      agentRes = await retellClient.post('/create-agent', {
        agent_name: `Sofía - ${tenant.business_name}`,
        response_engine: {
          type: 'retell-llm',
          llm_id: llmId,
        },
        voice_id: 'cartesia-Sofia',
        language: 'es-ES',
        webhook_url: `${webhookBaseUrl.replace(/\/$/, '')}/api/webhook/agent-events`,
        reminder_max_count: 0,
        voice_speed: speed,
        voice_temperature: temp,
        responsiveness: resp,
        interruption_sensitivity: 0.8
      });
    } else {
      throw agentErr;
    }
  }

  const agentId = agentRes.data.agent_id;
  console.log(`✅ [Retell Service] Agente creado con ID: ${agentId}`);
  return agentId;
}

/**
 * Elimina el agente de voz y su LLM correspondiente de Retell AI.
 */
export async function deleteRetellAgent(agentId: string) {
  if (!agentId || agentId === 'YOUR_RETELL_AGENT_ID' || agentId.trim() === '') {
    return;
  }
  try {
    console.log(`🗑️ Recuperando datos del agente de Retell AI para extraer su LLM: ${agentId}...`);
    let llmId: string | null = null;
    try {
      const agentRes = await retellClient.get(`/get-agent/${agentId}`);
      llmId = agentRes.data.response_engine?.llm_id || null;
    } catch (getErr: any) {
      console.warn(`⚠️ No se pudo obtener el agente para extraer su LLM: ${getErr.message}`);
    }

    console.log(`🗑️ Eliminando agente de Retell AI: ${agentId}...`);
    await retellClient.delete(`/delete-agent/${agentId}`);
    console.log('✅ Agente de Retell AI eliminado con éxito.');

    if (llmId) {
      console.log(`🗑️ Eliminando LLM asociado de Retell AI: ${llmId}...`);
      await retellClient.delete(`/delete-retell-llm/${llmId}`);
      console.log('✅ LLM asociado eliminado con éxito.');
    }
  } catch (error: any) {
    console.warn('⚠️ Error al eliminar recursos en Retell AI (quizás ya no existen):', error.response?.data || error.message);
  }
}

/**
 * Inicia una llamada saliente (outbound call) utilizando la API de Retell.
 */
export async function triggerOutboundCall(
  fromNumber: string,
  toNumber: string,
  agentId: string,
  dynamicVariables?: any
): Promise<string> {
  try {
    console.log(`[Retell Outbound] Iniciando llamada de ${fromNumber} a ${toNumber} con agente ${agentId}...`);
    const payload: any = {
      from_number: fromNumber,
      to_number: toNumber,
      override_agent_id: agentId
    };

    if (dynamicVariables) {
      payload.retell_llm_dynamic_variables = dynamicVariables;
    }

    const response = await retellClient.post('/v2/create-phone-call', payload);
    const callId = response.data.call_id;
    console.log(`[Retell Outbound] ✅ Llamada creada con éxito. Call ID: ${callId}`);
    return callId;
  } catch (error: any) {
    console.error('[Retell Outbound ERROR] Error al crear llamada saliente:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || error.message);
  }
}

