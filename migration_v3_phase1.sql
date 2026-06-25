-- ========================================================
-- RECEPTIA DATABASE MIGRATION - FASE 1: PERSONALIDAD & TEXT-BACK
-- Ejecuta este script en el editor SQL de Supabase (https://supabase.com)
-- ========================================================

-- 1. Añadir columnas de personalidad de la IA a la tabla tenants
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS personality_tone INT DEFAULT 3,
ADD COLUMN IF NOT EXISTS personality_focus INT DEFAULT 3,
ADD COLUMN IF NOT EXISTS personality_speed NUMERIC DEFAULT 1.0;

-- 2. Añadir columnas de text-back (recuperación de llamadas perdidas) a la tabla tenants
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS text_back_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS text_back_message TEXT DEFAULT 'Hola! Vimos que nos llamaste pero no pudimos responder. ¿Te gustaría agendar una cita de forma rápida por este chat?';

-- 3. Notificar a PostgREST para recargar el esquema
NOTIFY pgrst, 'reload schema';
