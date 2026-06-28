-- MIGRACIÓN V7: TABLAS PARA EL SISTEMA DE REFERIDOS Y COMISIONES EN RECEPTIA
-- Ejecuta este script en el SQL Editor de Supabase para activar el sistema de referidos.

-- 1. Tabla de Referidos Registrados
CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    referred_name TEXT NOT NULL,
    referred_email TEXT NOT NULL,
    referred_phone TEXT NOT NULL,
    referred_company TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'subscribed', 'cancelled'
    referred_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL, -- Vinculación con su cuenta SaaS
    commission_type TEXT NOT NULL, -- 'percentage' | 'fixed'
    commission_value NUMERIC NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índices de búsqueda y no duplicados
CREATE INDEX IF NOT EXISTS idx_referrals_email ON referrals(referred_email);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_tenant_id);

-- 2. Tabla de Devengos y Liquidaciones de Comisiones
CREATE TABLE IF NOT EXISTS referral_commissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_id UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
    referrer_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    amount NUMERIC NOT NULL, -- Importe en €
    period TEXT, -- 'YYYY-MM' para modalidad recurrente (o NULL para fija)
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' (acumulado), 'applied' (descontado)
    applied_invoice_id TEXT, -- ID de la factura de Stripe
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_referral_commissions_referrer ON referral_commissions(referrer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_status ON referral_commissions(status);
