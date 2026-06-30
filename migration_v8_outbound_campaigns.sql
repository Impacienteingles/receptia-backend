-- MIGRACIÓN V8: TABLAS PARA LAS CAMPAÑAS OUTBOUND Y DESTINATARIOS EN RECEPTIA
-- Ejecuta este script en el SQL Editor de Supabase para activar las campañas salientes.

-- 1. Tabla de Campañas Outbound
CREATE TABLE IF NOT EXISTS outbound_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR NOT NULL,
    status VARCHAR DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índices de búsqueda
CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_tenant ON outbound_campaigns(tenant_id);

-- 2. Tabla de Destinatarios de Campañas Outbound
CREATE TABLE IF NOT EXISTS outbound_campaign_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
    client_name VARCHAR NOT NULL,
    client_phone VARCHAR NOT NULL,
    custom_variable VARCHAR,
    status VARCHAR DEFAULT 'pending', -- 'pending', 'calling', 'completed', 'failed', 'no_answer', 'completed_with_booking'
    call_id VARCHAR,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índices de búsqueda
CREATE INDEX IF NOT EXISTS idx_outbound_campaign_recipients_campaign ON outbound_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_outbound_campaign_recipients_status ON outbound_campaign_recipients(status);
