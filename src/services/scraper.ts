import axios from 'axios';
import { getSettingVal } from './supabase';

interface ProspectLead {
  business_name: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  sector: string;
  specialties: string[];
  scraped_knowledge?: string;
}

/**
 * Busca prospectos en Google Places y hace scraping de sus sitios webs para extraer emails y especialidades.
 * Si no está configurada la clave de Google Places, hace un fallback a leads simulados de alta calidad.
 */
export async function scrapeProspects(city: string, country: string, sector: string): Promise<ProspectLead[]> {
  const apiKey = await getSettingVal('GOOGLE_PLACES_API_KEY');
  
  if (!apiKey || apiKey === 'YOUR_GOOGLE_PLACES_API_KEY') {
    console.log('[Scraper] GOOGLE_PLACES_API_KEY no configurado. Utilizando fallback de leads simulados...');
    return getSimulatedLeads(city, country, sector);
  }

  try {
    const query = `${sector} en ${city}, ${country}`;
    console.log(`[Scraper] Buscando en Google Places con query: "${query}"...`);
    
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}&language=es`;
    const response = await axios.get(url);
    
    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API Error: ${response.data.status} - ${response.data.error_message || ''}`);
    }

    const results = response.data.results || [];
    const leads: ProspectLead[] = [];

    // Limitar a los 20 primeros resultados para no sobrecargar de forma asíncrona
    const topResults = results.slice(0, 20);

    for (const place of topResults) {
      // 1. Obtener detalles ampliados del lugar (especialmente sitio web si existe)
      let website = '';
      let formattedPhone = place.formatted_phone_number || '';
      
      if (place.place_id) {
        try {
          const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=website,formatted_phone_number&key=${apiKey}&language=es`;
          const detailRes = await axios.get(detailUrl);
          if (detailRes.data.status === 'OK') {
            website = detailRes.data.result.website || '';
            if (detailRes.data.result.formatted_phone_number) {
              formattedPhone = detailRes.data.result.formatted_phone_number;
            }
          }
        } catch (err: any) {
          console.warn(`[Scraper] Error al obtener detalles del place_id ${place.place_id}:`, err.message);
        }
      }

      // 2. Extraer información del sitio web (email, especialidades y conocimiento) si tiene web
      let email = '';
      let specialties: string[] = [];
      let scrapedKnowledge = '';

      if (website) {
        const scraped = await scrapeWebsiteDetails(website, sector);
        email = scraped.email;
        specialties = scraped.specialties;
        scrapedKnowledge = await extractKnowledgeFromWeb(scraped.htmlText, sector, place.name);
      } else {
        scrapedKnowledge = generateFallbackKnowledge(place.name, sector);
      }

      // 3. Si no se encontró especialidades, usar las genéricas del sector
      if (specialties.length === 0) {
        specialties = getDefaultSpecialties(sector);
      }

      // 4. Si no se encontró email en el scraper, generar uno corporativo por defecto basado en el dominio o nombre
      if (!email) {
        email = generateFallbackEmail(place.name, website);
      }

      leads.push({
        business_name: place.name,
        email,
        phone: formattedPhone || 'No disponible',
        website: website || 'No disponible',
        address: place.formatted_address || place.vicinity || 'No disponible',
        sector,
        specialties,
        scraped_knowledge: scrapedKnowledge
      });
    }

    return leads;
  } catch (error: any) {
    console.error('[Scraper ERROR] Error general en el scraping:', error.message);
    throw error;
  }
}

/**
 * Realiza un crawling básico y ligero de un sitio web para extraer emails y especialidades usando regex.
 */
async function scrapeWebsiteDetails(url: string, sector: string): Promise<{ email: string; specialties: string[]; htmlText: string }> {
  let email = '';
  let specialties: string[] = [];
  let htmlText = '';

  try {
    console.log(`[Scraper] Analizando sitio web: ${url}...`);
    const response = await axios.get(url, {
      timeout: 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const html = response.data;
    if (typeof html !== 'string') return { email, specialties, htmlText };

    // 1. Limpiar el HTML para la extracción de texto plano legible
    htmlText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // remover scripts
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')   // remover estilos
      .replace(/<[^>]*>/g, ' ')                                           // remover tags HTML
      .replace(/\s+/g, ' ')                                               // colapsar espacios múltiples
      .trim();

    // 2. Extraer Email mediante mailto y regex sobre texto plano
    const mailtoRegex = /href="mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/i;
    const mailtoMatch = html.match(mailtoRegex);
    
    if (mailtoMatch && mailtoMatch[1]) {
      email = mailtoMatch[1].trim().toLowerCase();
    } else {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const matches = html.match(emailRegex);
      if (matches && matches.length > 0) {
        const validEmails = matches.filter(e => {
          const lower = e.toLowerCase();
          return !lower.endsWith('.png') && !lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.gif') && !lower.endsWith('.js') && !lower.endsWith('.css');
        });
        if (validEmails.length > 0) {
          email = validEmails[0].trim().toLowerCase();
        }
      }
    }

    // 3. Extraer especialidades buscando keywords en minúscula
    const cleanTextLower = htmlText.toLowerCase();
    const keywords = getSectorKeywords(sector);
    
    specialties = keywords.filter(kw => cleanTextLower.includes(kw.toLowerCase()));
    specialties = specialties.slice(0, 4);

  } catch (err: any) {
    console.log(`[Scraper WARNING] No se pudo hacer scrape a la web ${url}: ${err.message}`);
  }

  return { email, specialties, htmlText };
}

/**
 * Palabras clave según el sector seleccionado
 */
function getSectorKeywords(sector: string): string[] {
  const keywords: { [key: string]: string[] } = {
    peluqueria: ['Corte de caballero', 'Corte de mujer', 'Tinte', 'Mechas', 'Peinado', 'Barba', 'Alisado', 'Lavado y peinado', 'Tratamiento capilar'],
    dental: ['Limpieza dental', 'Implante dental', 'Endodoncia', 'Ortodoncia', 'Carillas', 'Blanqueamiento', 'Odontopediatría', 'Extracción dental', 'Férula dental'],
    medica: ['Consulta médica', 'Pediatría', 'Ginecología', 'Dermatología', 'Ecografía', 'Análisis clínico', 'Nutrición', 'Fisioterapia', 'Electrocardiograma'],
    fisioterapia: ['Masaje terapéutico', 'Rehabilitación', 'Punción seca', 'Osteopatía', 'Fisioterapia deportiva', 'Pilates clínico', 'Drenaje linfático', 'Terapia manual'],
    abogados: ['Asesoramiento civil', 'Defensa penal', 'Derecho laboral', 'Divorcios', 'Herencias', 'Reclamaciones', 'Derecho mercantil', 'Contratos', 'Despidos'],
    psicologia: ['Terapia individual', 'Terapia de pareja', 'Ansiedad', 'Depresión', 'Psicología infantil', 'Autoestima', 'Duelo', 'Estrés', 'Terapia online'],
    taller: ['Cambio de aceite', 'Frenos', 'Revisión pre-ITV', 'Pintura', 'Neumáticos', 'Diagnóstico de motor', 'Amortiguadores', 'Batería', 'Aire acondicionado'],
    veterinaria: ['Vacunación', 'Desparasitación', 'Consulta veterinaria', 'Cirugía animal', 'Radiografía veterinaria', 'Peluquería canina', 'Urgencias 24h', 'Analítica'],
    spa: ['Masaje relajante', 'Circuito de aguas', 'Tratamiento facial', 'Exfoliación', 'Jacuzzi', 'Sauna', 'Envoltura corporal', 'Aromaterapia'],
    gimnasio: ['Entrenamiento personal', 'Crossfit', 'Pilates', 'Yoga', 'Nutrición deportiva', 'Musculación', 'Spinning', 'Zumba'],
    academia: ['Apoyo escolar', 'Clases de inglés', 'Preparación de exámenes', 'Matemáticas', 'Idiomas', 'Cursos intensivos', 'Clases particulares'],
    inmobiliaria: ['Compra de pisos', 'Alquiler de viviendas', 'Valoración gratuita', 'Gestión de hipotecas', 'Venta de locales', 'Asesoramiento inmobiliario'],
    general: ['Consulta básica', 'Presupuesto', 'Atención al cliente', 'Información', 'Reserva de cita']
  };

  return keywords[sector.toLowerCase()] || keywords.general;
}

function getDefaultSpecialties(sector: string): string[] {
  const list = getSectorKeywords(sector);
  return list.slice(0, 3);
}

function generateFallbackEmail(businessName: string, website: string): string {
  const cleanName = businessName.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .replace(/[^a-z0-9]/g, '');

  if (website && website.includes('.')) {
    try {
      const urlObj = new URL(website);
      const domain = urlObj.hostname.replace('www.', '');
      return `contacto@${domain}`;
    } catch (e) {
      // Ignorar e ir al fallback
    }
  }
  return `info@${cleanName || 'negocio'}.com`;
}

/**
 * Leads de prueba simulados realistas para cuando no está la API Key
 */
function getSimulatedLeads(city: string, country: string, sector: string): ProspectLead[] {
  const normalizedSector = sector.toLowerCase();
  const leads: ProspectLead[] = [];

  const namesBySector: { [key: string]: string[] } = {
    peluqueria: [
      'Pelas Estilo y Elegancia', 'Barbería Golden Touch', 'Salón de Belleza Aura', 'Peluquería Carlos Romero', 'Hair Studio Vintage',
      'Tijeras & Arte Barbería', 'Glamour & Chic Estilistas', 'El Rincón del Peinado', 'Corte Urbano Salón', 'Estilo Único Peluqueros'
    ],
    dental: [
      'Clínica Dental Sana Dent', 'Odontología Avanzada Smile', 'Centro Dental Oria', 'Clínica Dental Doctora Martínez', 'VitalDent Centro',
      'Sana Dent Clínica Familiar', 'Implantes & Estética Dental', 'Sonrisas Sanas Odontología', 'Centro Dental Odontofit', 'Clínica Dental DentyCare'
    ],
    medica: [
      'Policlínica Medica Centro', 'Centro Médico Familiar', 'Clínica Ginecológica Albor', 'Dermatología Avanzada Nova', 'Centro Pediátrico Central',
      'Salud y Bienestar Policlínica', 'Centro Médico Integral', 'Clínica SanaSalud Especialistas', 'Policlínica del Doctor Torres', 'Centro de Diagnóstico San Rafael'
    ],
    fisioterapia: [
      'FisioSport Centro', 'Clínica de Fisioterapia Kinesia', 'Fisioterapia y Pilates Vital', 'Osteopatía Integral', 'Centro de Rehabilitación Activa',
      'FisioVital Terapia Manual', 'Clínica de Fisioterapia Kineo', 'Rehabilitación y Deporte Center', 'FisioMas Masajes Terapéuticos', 'Centro de Fisioterapia Avanzada'
    ],
    abogados: [
      'Bufete de Abogados Alcaraz', 'LegalAsesores Abogados', 'Despacho Penal y Laboral Vega', 'Consultoría Jurídica Integral', 'Abogados de Familia y Divorcios',
      'Defensa Legal Despacho Asociado', 'Bufete Lex & Asociados', 'Asistencia Jurídica Laboral', 'García & Socios Bufete Civil', 'Abogados de Herencias y Contratos'
    ],
    psicologia: [
      'Mente Sana Psicología', 'Centro de Psicología Integra', 'PsicoApoyo Familiar', 'Clínica de Psicología Emociona', 'Espacio Psicoterapéutico',
      'Psicoterapia Cognitiva Vital', 'Consulta Psicológica Bienestar', 'Centro Psicopedagógico Crecer', 'Terapia y Equilibrio Psicólogos', 'PsicoSalud Mente Activa'
    ],
    taller: [
      'Taller Mecánico Rápido', 'Autocentro Garaje Central', 'Mecánica y Electricidad Motor', 'Taller Multimarca Express', 'Car Service Integral',
      'Electromecánica de Precisión', 'Taller de Chapa y Pintura Pro', 'Servicio Rápido del Neumático', 'Boxes Taller de Mecánica', 'Taller Mecánico El Box'
    ],
    veterinaria: [
      'Clínica Veterinaria Mascotas', 'Centro Veterinario San Antón', 'Hospital Veterinario Huellas', 'Veterinaria Fauna Sana', 'Consultorio Canino y Felino',
      'Clínica Veterinaria El Arca', 'Urgencias Veterinarias 24h', 'Centro Veterinario Mi Fiel Amigo', 'Peluquería y Veterinaria Canina', 'Fauna y Salud Centro Veterinario'
    ],
    spa: [
      'Zenith Spa & Wellness', 'Balneario Urbano Oasis', 'Termas de Relajación Aqua', 'Spa & Beauty Sentidos', 'Templo del Masaje y Bienestar',
      'Spa Termal Aguas Limpias', 'Wellness & Relax Balneario', 'Oasis de Relajación Termal', 'Eco Spa Masajes Orgánicos', 'Spa Boutique Bienestar'
    ],
    gimnasio: [
      'Gimnasio Iron Fit', 'Studio Entrenamiento Activo', 'Centro de Fitness & Power', 'Gimnasio Vitality', 'Gimnasio Olimpo Body',
      'Fitness Zone Gimnasio', 'Crossfit & Strength Studio', 'Gimnasio Powerhouse', 'Pilates y Yoga Gimnasio', 'Gimnasio Cardio & Fit'
    ],
    academia: [
      'Academia Saber Más', 'Centro de Estudios Cum Laude', 'School Idiomas y Apoyo', 'Academia Prepara Plus', 'Espacio de Aprendizaje',
      'Academia de Matemáticas e Idiomas', 'Centro de Estudios Alfa', 'Academia de Apoyo Universitario', 'Clases Particulares e Idiomas', 'Escuela de Formación y Refuerzo'
    ],
    inmobiliaria: [
      'Inmobiliaria Piso Rápido', 'Hogar Dulce Hogar Real Estate', 'Gestión Inmobiliaria Global', 'Inmobiliaria Premium House', 'Soluciones Habitacionales',
      'Pisos & Locales Inmobiliaria', 'Gestión de Alquileres Inmo', 'Inmobiliaria Costa Blanca', 'Propiedades Urbanas Inmobiliaria', 'Tu Nuevo Hogar Real Estate'
    ]
  };

  const selectedNames = namesBySector[normalizedSector] || ['Negocio Local y Servicios', 'Centro Profesional Activo', 'Servicios Profesionales B2B'];

  selectedNames.forEach((name, index) => {
    const cleanName = name.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');

    const domain = `${cleanName}.es`;
    const specialties = getDefaultSpecialties(sector);

    leads.push({
      business_name: `${name} ${city}`,
      email: `contacto@${domain}`,
      phone: `+34 9${index}${index} 123 456`,
      website: `https://www.${domain}`,
      address: `Calle Mayor ${10 + index * 5}, ${city}, ${country}`,
      sector: normalizedSector,
      specialties,
      scraped_knowledge: generateFallbackKnowledge(`${name} ${city}`, sector)
    });
  });

  return leads;
}

/**
 * Llama a la API de Gemini para estructurar la información clave extraída de la web del prospecto
 */
async function extractKnowledgeFromWeb(cleanText: string, sector: string, businessName: string): Promise<string> {
  const apiKey = await getSettingVal('GEMINI_API_KEY');
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY') {
    console.log('[Scraper] GEMINI_API_KEY no configurado para extracción de conocimiento. Usando fallback...');
    return generateFallbackKnowledge(businessName, sector);
  }

  // Limitar el texto a los primeros 6000 caracteres para evitar excesos
  const truncatedText = (cleanText || '').substring(0, 6000);
  if (!truncatedText.trim()) {
    return generateFallbackKnowledge(businessName, sector);
  }

  try {
    const modelUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const systemPrompt = `Eres un asistente experto en estructuración de información de negocios locales. Tu objetivo es procesar el texto plano de un sitio web y extraer información de forma sumamente limpia, detallada y estructurada para entrenar a un agente de voz telefónico. 
Debes estructurar los siguientes bloques redactándolos en formato markdown legible en español:
### Horario Comercial
(Especifica de forma muy clara los días y horas de apertura detallados)

### Servicios y Tratamientos
(Lista completa de servicios, tratamientos o productos ofrecidos con sus precios si se mencionan)

### Información del Negocio
(Dirección, especialidad principal y cualquier pauta importante para los clientes como métodos de pago, fianza, reservas o políticas)`;

    const payload = {
      contents: [{
        role: 'user',
        parts: [{ text: `Texto del sitio web de la empresa "${businessName}" (Sector: ${sector}):\n\n${truncatedText}` }]
      }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      }
    };

    console.log(`[Scraper LLM] Extrayendo conocimiento estructurado de la web para: "${businessName}"...`);
    const res = await axios.post(modelUrl, payload);
    const textResponse = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (textResponse) {
      return textResponse.trim();
    }
  } catch (err: any) {
    console.error('[Scraper LLM Error] Error al extraer conocimiento con Gemini:', err.message);
  }

  return generateFallbackKnowledge(businessName, sector);
}

/**
 * Genera el conocimiento estructurado base si no hay web o falla la API de IA
 */
function generateFallbackKnowledge(businessName: string, sector: string): string {
  const list = getSectorKeywords(sector);
  return `### Horario Comercial
- Lunes a Viernes: 09:00 a 20:00
- Sábado: 09:00 a 14:00
- Domingo: Cerrado

### Servicios y Tratamientos
${list.map(s => `- ${s}`).join('\n')}

### Información del Negocio
- Nombre: ${businessName}
- Sector: ${sector.toUpperCase()}
- Nota: Datos autogenerados por defecto para pruebas comerciales.`;
}
