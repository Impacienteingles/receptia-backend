-- ========================================================
-- RECEPTIA DATABASE MIGRATION - OUTREACH V2 & PRIVACY
-- Ejecuta este script en el editor SQL de Supabase (https://supabase.com)
-- ========================================================

-- 1. Añadir columnas de seguimiento de aperturas a la tabla prospects
ALTER TABLE prospects 
ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS opened_count INT DEFAULT 0;

-- 2. Añadir columna de bloqueo de administración a la tabla tenants
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS block_admin_access BOOLEAN DEFAULT FALSE;

-- 3. Añadir columna de ID de llamada de Retell a la tabla call_logs
ALTER TABLE call_logs 
ADD COLUMN IF NOT EXISTS retell_call_id TEXT;

-- 4. Notificar a PostgREST para recargar el esquema
NOTIFY pgrst, 'reload schema';
