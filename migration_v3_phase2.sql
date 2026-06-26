-- ========================================================
-- RECEPTIA DATABASE MIGRATION - FASE 2: CHATBOTS & MENSAJES
-- Ejecuta este script en el editor SQL de Supabase (https://supabase.com)
-- ========================================================

-- 1. Añadir columnas de chatbot a la tabla tenants
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS chatbot_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS chatbot_welcome_message TEXT DEFAULT '¡Hola! ¿En qué puedo ayudarte hoy?';

-- 2. Crear tabla de mensajes de chat para widget y WhatsApp
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  sender TEXT NOT NULL, -- 'user' o 'ai'
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Crear índice para búsquedas rápidas por sesión
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(tenant_id, session_id);

-- 4. Notificar a PostgREST para recargar el esquema
NOTIFY pgrst, 'reload schema';
