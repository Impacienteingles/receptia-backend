-- ========================================================
-- SCHEMA DE BASE DE DATOS PARA RECEPTIA MULTI-INQUILINO (SaaS)
-- Ejecuta este script en el editor SQL de Supabase
-- ========================================================

-- Habilitar extensión para generación de UUIDs si no está habilitada
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabla de Inquilinos (Médicos, Peluqueros, Centros, etc.)
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  google_refresh_token TEXT,
  retell_agent_id TEXT,
  specialties TEXT[] DEFAULT '{}',
  
  -- Campos de personalización avanzada SaaS
  voice_id TEXT DEFAULT 'cartesia-Hailey-Spanish-latin-america',
  phone_number TEXT,
  business_description TEXT,
  pricing_details TEXT,
  custom_instructions TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Tabla de Citas Agendadas por la IA
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  patient_name TEXT NOT NULL,
  patient_phone TEXT NOT NULL,
  patient_email TEXT NOT NULL,
  date_time TIMESTAMP WITH TIME ZONE NOT NULL,
  specialty TEXT NOT NULL,
  status TEXT DEFAULT 'confirmed' NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Inserción del inquilino de prueba
INSERT INTO tenants (id, business_name, email, specialties, voice_id, business_description, pricing_details, custom_instructions)
VALUES (
  '11111111-1111-1111-1111-111111111111', 
  'Clínica Médica SanaSalud', 
  'yoyrenfe@gmail.com', 
  ARRAY['Medicina General', 'Odontología', 'Fisioterapia'],
  'cartesia-Hailey-Spanish-latin-america',
  'Clínica médica y dental especializada en atención familiar, implantes, estética y tratamientos fisioterapéuticos.',
  'Consulta de medicina general: 50 euros. Limpieza bucal: 35 euros. Sesión de fisioterapia de 45 minutos: 40 euros.',
  'Tratar siempre al paciente con el pronombre usted. Ser amable, hablar con calma. Si se solicita cita en viernes por la tarde, sugerir otra fecha ya que no trabajamos los viernes de tarde.'
) ON CONFLICT (email) DO NOTHING;

-- ========================================================
-- NUEVAS TABLAS PARA CONTABILIDAD, TARIFAS Y CONTRATOS
-- ========================================================

-- 4. Tabla de Planes de Precios Editables
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  cycle TEXT NOT NULL, -- 'monthly' o 'annually'
  features TEXT[] DEFAULT '{}',
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Registrar planes por defecto si no existen
-- Registrar planes por defecto si no existen
DELETE FROM plans WHERE id IN ('estandar', 'premium', 'anual');
INSERT INTO plans (id, name, price, cycle, features, description) VALUES
('estandar_mensual', 'Plan Estándar Mensual', 149.00, 'monthly', ARRAY['1 Agente de Voz IA activo', '1 Número telefónico en Retell AI', 'Integración con Google Calendar', 'Panel de control de cliente', 'Hasta 200 minutos incluidos / mes', 'Minuto adicional a 0.20€/min'], 'Plan estándar para medianos y pequeños comercios.'),
('premium_mensual', 'Plan Premium Mensual', 249.00, 'monthly', ARRAY['Todo lo del Plan Estándar', 'Conexión SIP Zadarma avanzada', 'Soporte de Voz ElevenLabs de alta calidad', 'Prompt e instrucciones optimizadas', 'Hasta 500 minutos incluidos / mes', 'Minuto adicional a 0.20€/min'], 'Más Popular'),
('estandar_anual', 'Plan Estándar Anual', 1290.00, 'annually', ARRAY['1 Agente de Voz IA activo', '1 Número telefónico en Retell AI', 'Integración con Google Calendar', 'Panel de control de cliente', 'Hasta 200 minutos incluidos / mes', 'Minuto adicional a 0.20€/min', 'Ahorro de casi 3 meses de suscripción'], 'Ahorro de casi 3 meses de suscripción'),
('premium_anual', 'Plan Premium Anual', 2290.00, 'annually', ARRAY['Todo lo del Plan Premium', 'Soporte VIP priorizado 24/7', 'Ahorro de 2 meses de suscripción', 'Minutos ilimitados controlados'], 'Ahorro de 2 meses de suscripción')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  cycle = EXCLUDED.cycle,
  features = EXCLUDED.features,
  description = EXCLUDED.description;

-- 5. Tabla de Transacciones Manuales (Contabilidad)
CREATE TABLE IF NOT EXISTS accounting_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL, -- 'income' (ingreso) o 'expense' (gasto)
  concept TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Tabla de Plantillas de Contratos
CREATE TABLE IF NOT EXISTS contract_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Columnas en tenants para asociar Contratos
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS contract_template_id UUID REFERENCES contract_templates(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS signed_contract_content TEXT,
ADD COLUMN IF NOT EXISTS is_trial BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS trial_ends_at DATE,
ADD COLUMN IF NOT EXISTS legal_address TEXT,
ADD COLUMN IF NOT EXISTS tax_id TEXT,
ADD COLUMN IF NOT EXISTS representative_name TEXT,
ADD COLUMN IF NOT EXISTS representative_id TEXT,
ADD COLUMN IF NOT EXISTS representative_role TEXT,
ADD COLUMN IF NOT EXISTS signing_city TEXT DEFAULT 'Madrid';

-- ========================================================
-- PROPUESTAS DE ÉXITO SAAS: RECORDATORIOS, FIANZAS, MULTI-PROFESIONAL Y LLAMADAS
-- ========================================================

-- 8. Tabla de Registro de Llamadas (Call Logs)
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  caller_phone TEXT,
  call_duration INTEGER, -- en segundos
  recording_url TEXT,
  transcript TEXT,
  summary TEXT,
  intent_tag TEXT, -- 'Cita Agendada', 'Llamada Perdida', 'Consulta General', 'Queja'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 9. Columnas en tenants para propuestas de éxito SaaS
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS whatsapp_reminders_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS enable_no_show_deposits BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS no_show_deposit_amount NUMERIC DEFAULT 10.00,
ADD COLUMN IF NOT EXISTS enable_multi_professional BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS professionals JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS knowledge_base_url TEXT,
ADD COLUMN IF NOT EXISTS knowledge_base_content TEXT;

-- 10. Columnas adicionales en appointments para soporte de multi-calendario y fianza
ALTER TABLE appointments
ADD COLUMN IF NOT EXISTS google_calendar_id TEXT DEFAULT 'primary',
ADD COLUMN IF NOT EXISTS professional_name TEXT;

-- 11. Tabla de Ajustes Dinámicos (APIs de Terceros)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ========================================================
-- v2.2.6: SUSPENSIÓN, ARCHIVADO Y CALCULADORA ROI
-- ========================================================

-- 12. Columnas en tenants para control de ciclo de vida del cliente
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS archived_reason TEXT, -- 'non_payment', 'voluntary_cancel', 'fraud', 'other'
ADD COLUMN IF NOT EXISTS business_sector TEXT DEFAULT 'general'; -- 'peluqueria', 'dental', 'medica', 'oficina', 'general'

-- Instrucciones a ejecutar en el panel SQL de Supabase:
-- Estas columnas permiten:
-- 1. is_archived: Mover clientes a un historial sin borrarlos (soft delete)
-- 2. archived_at / archived_reason: Trazabilidad del motivo y fecha de archivado
-- 3. business_sector: Base para la calculadora de ahorro ROI en el portal del cliente


-- ========================================================
-- v2.4.18: MONETIZACIÓN E INTEGRACIÓN CON STRIPE BILLING
-- ========================================================

-- 13. Columnas en tenants para asociar perfiles de Stripe
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;


