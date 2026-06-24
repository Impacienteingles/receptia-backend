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

    // Limitar a los 10 primeros resultados para no sobrecargar de forma asíncrona
    const topResults = results.slice(0, 10);

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

      // 2. Extraer información del sitio web (email y especialidades) si tiene web
      let email = '';
      let specialties: string[] = [];

      if (website) {
        const scraped = await scrapeWebsiteDetails(website, sector);
        email = scraped.email;
        specialties = scraped.specialties;
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
        specialties
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
async function scrapeWebsiteDetails(url: string, sector: string): Promise<{ email: string; specialties: string[] }> {
  let email = '';
  let specialties: string[] = [];

  try {
    console.log(`[Scraper] Analizando sitio web: ${url}...`);
    const response = await axios.get(url, {
      timeout: 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const html = response.data;
    if (typeof html !== 'string') return { email, specialties };

    // 1. Extraer Email mediante mailto y regex sobre texto plano
    const mailtoRegex = /href="mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/i;
    const mailtoMatch = html.match(mailtoRegex);
    
    if (mailtoMatch && mailtoMatch[1]) {
      email = mailtoMatch[1].trim().toLowerCase();
    } else {
      // Intentar regex sobre texto plano
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const matches = html.match(emailRegex);
      if (matches && matches.length > 0) {
        // Descartar correos genéricos como png, jpg, gif o de librerías
        const validEmails = matches.filter(e => {
          const lower = e.toLowerCase();
          return !lower.endsWith('.png') && !lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.gif') && !lower.endsWith('.js') && !lower.endsWith('.css');
        });
        if (validEmails.length > 0) {
          email = validEmails[0].trim().toLowerCase();
        }
      }
    }

    // 2. Extraer especialidades buscando keywords relevantes del sector en el texto
    const cleanText = html.replace(/<[^>]*>/g, ' ').toLowerCase();
    const keywords = getSectorKeywords(sector);
    
    specialties = keywords.filter(kw => cleanText.includes(kw.toLowerCase()));
    
    // Limitar especialidades a máximo 4
    specialties = specialties.slice(0, 4);

  } catch (err: any) {
    console.log(`[Scraper WARNING] No se pudo hacer scrape a la web ${url}: ${err.message}`);
  }

  return { email, specialties };
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
    peluqueria: ['Pelas Estilo y Elegancia', 'Barbería Golden Touch', 'Salón de Belleza Aura', 'Peluquería Carlos Romero', 'Hair Studio Vintage'],
    dental: ['Clínica Dental Sana Dent', 'Odontología Avanzada Smile', 'Centro Dental Oria', 'Clínica Dental Doctora Martínez', 'VitalDent Centro'],
    medica: ['Policlínica Medica Centro', 'Centro Médico Familiar', 'Clínica Ginecológica Albor', 'Dermatología Avanzada Nova', 'Centro Pediátrico Central'],
    fisioterapia: ['FisioSport Centro', 'Clínica de Fisioterapia Kinesia', 'Fisioterapia y Pilates Vital', 'Osteopatía Integral', 'Centro de Rehabilitación Activa'],
    abogados: ['Bufete de Abogados Alcaraz', 'LegalAsesores Abogados', 'Despacho Penal y Laboral Vega', 'Consultoría Jurídica Integral', 'Abogados de Familia y Divorcios']
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
      specialties
    });
  });

  return leads;
}
