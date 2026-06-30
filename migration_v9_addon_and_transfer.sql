-- MIGRACIÓN V9: AÑADIR COLUMNAS PARA TRANSFERENCIA DE LLAMADAS Y MINUTOS EXTRA EN RECEPTIA
-- Ejecuta este script en el SQL Editor de Supabase (https://supabase.com) para activar estas características.

-- 1. Asegurar columna transfer_phone_number en tenants si no existe
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS transfer_phone_number TEXT;

-- 2. Asegurar columna addon_minutes en tenants si no existe
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS addon_minutes INTEGER DEFAULT 0;

-- 3. Asegurar columna voice_locked en tenants si no existe
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS voice_locked BOOLEAN DEFAULT false;

-- 4. Notificar a PostgREST para recargar el esquema de forma inmediata
NOTIFY pgrst, 'reload schema';
