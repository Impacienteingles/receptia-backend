import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey || supabaseUrl === 'YOUR_SUPABASE_URL' || supabaseServiceKey === 'YOUR_SUPABASE_SERVICE_ROLE_KEY') {
  console.warn(
    '⚠️ ADVERTENCIA: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configurados en el archivo .env.'
  );
}

// Inicializar el cliente utilizando la clave service_role para eludir RLS en operaciones de backend seguro
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseServiceKey || 'placeholder-key'
);

const settingsCache: { [key: string]: { value: string | undefined; timestamp: number } } = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // Cache de 5 minutos

/**
 * Obtiene el valor de un ajuste dinámico desde Supabase.
 * Utiliza un caché en memoria con TTL para evitar consultas redundantes y reducir latencia.
 * Si no está configurado, hace un fallback a la variable de entorno (.env).
 */
export async function getSettingVal(key: string): Promise<string | undefined> {
  const cached = settingsCache[key];
  const now = Date.now();
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error) {
      if (error.code !== '42P01') { // Ignorar error de tabla no existente en primera carga
        console.warn(`[getSettingVal] Error al buscar ajuste ${key}:`, error.message);
      }
    } else if (data && data.value !== undefined && data.value !== '') {
      settingsCache[key] = { value: data.value, timestamp: now };
      return data.value;
    }
  } catch (err: any) {
    console.warn(`[getSettingVal] Excepción al buscar ajuste ${key}:`, err.message);
  }

  const envValue = process.env[key];
  // Guardar en caché el valor de env (o undefined) para evitar re-consultar constantemente si falla
  settingsCache[key] = { value: envValue, timestamp: now };
  return envValue;
}
