-- ========================================================
-- RECEPTIA DATABASE MIGRATION - FASE 3: PMS LOCAL & OUTBOUND CAMPAIGNS
-- Ejecuta este script en el editor SQL de Supabase (https://supabase.com)
-- ========================================================

-- 1. Añadir columnas de integración PMS y optimización a la tabla tenants
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS pms_sync_token TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS pms_last_sync TIMESTAMP WITH TIME ZONE DEFAULT NULL,
ADD COLUMN IF NOT EXISTS pms_database_type TEXT DEFAULT 'none',
ADD COLUMN IF NOT EXISTS agenda_optimization_enabled BOOLEAN DEFAULT FALSE;

-- 2. Crear tabla de Campañas Outbound
CREATE TABLE IF NOT EXISTS outbound_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL, -- 'pending', 'running', 'completed', 'failed'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Crear tabla de Recipientes de Campaña
CREATE TABLE IF NOT EXISTS outbound_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  custom_variable TEXT DEFAULT NULL, -- ej: last appointment date
  status TEXT DEFAULT 'pending' NOT NULL, -- 'pending', 'calling', 'completed', 'failed', 'no_answer', 'completed_with_booking'
  call_id TEXT DEFAULT NULL, -- Retell Call ID
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Crear índice en call_id de recipients
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_call ON outbound_campaign_recipients(call_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_camp ON outbound_campaign_recipients(campaign_id);

-- 5. Notificar a PostgREST para recargar el esquema
NOTIFY pgrst, 'reload schema';
