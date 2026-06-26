-- ========================================================
-- RECEPTIA DATABASE MIGRATION - FASE 4: SISTEMA DE COMERCIALES
-- Ejecuta este script en el editor SQL de Supabase (https://supabase.com)
-- ========================================================

-- 1. Tabla de Agentes Comerciales
CREATE TABLE IF NOT EXISTS comerciales (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR NOT NULL,
  email VARCHAR UNIQUE NOT NULL,
  phone VARCHAR,
  company VARCHAR,
  pin VARCHAR NOT NULL,
  status VARCHAR DEFAULT 'active' NOT NULL, -- 'active', 'inactive'
  commission_mode VARCHAR DEFAULT 'percentage' NOT NULL, -- 'percentage', 'fixed'
  commission_value NUMERIC DEFAULT 10.00 NOT NULL,
  stripe_connect_account_id VARCHAR,
  payment_method VARCHAR DEFAULT 'manual' NOT NULL, -- 'manual', 'stripe'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Asegurar que prospects tenga la columna comercial_id
ALTER TABLE prospects 
ADD COLUMN IF NOT EXISTS comercial_id UUID REFERENCES comerciales(id) ON DELETE SET NULL;

-- 3. Tabla de Payouts / Pagos a Comerciales
CREATE TABLE IF NOT EXISTS comercial_payouts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  comercial_id UUID REFERENCES comerciales(id) ON DELETE CASCADE NOT NULL,
  amount NUMERIC NOT NULL,
  commission_recurring_amount NUMERIC DEFAULT 0 NOT NULL,
  commission_fixed_amount NUMERIC DEFAULT 0 NOT NULL,
  payment_method VARCHAR DEFAULT 'manual' NOT NULL, -- 'manual', 'stripe'
  stripe_transfer_id VARCHAR,
  status VARCHAR DEFAULT 'completed' NOT NULL, -- 'completed', 'pending', 'failed'
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Tabla de Registro de Comisiones
CREATE TABLE IF NOT EXISTS comercial_commissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  comercial_id UUID REFERENCES comerciales(id) ON DELETE CASCADE NOT NULL,
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  payout_id UUID REFERENCES comercial_payouts(id) ON DELETE SET NULL,
  type VARCHAR NOT NULL, -- 'percentage', 'fixed'
  amount NUMERIC NOT NULL,
  status VARCHAR DEFAULT 'pending' NOT NULL, -- 'pending', 'paid'
  period VARCHAR NOT NULL, -- 'YYYY-MM' o 'unique'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Tabla de Historial y Actividades del Prospecto
CREATE TABLE IF NOT EXISTS prospect_activities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE NOT NULL,
  comercial_id UUID REFERENCES comerciales(id) ON DELETE SET NULL,
  action VARCHAR NOT NULL, -- 'status_change', 'note', 'email_sent', etc.
  from_status VARCHAR,
  to_status VARCHAR,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Notificar a PostgREST para recargar el esquema
NOTIFY pgrst, 'reload schema';
