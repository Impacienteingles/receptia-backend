-- MIGRACIÓN V6: CREACIÓN DE LA TABLA caller_memories PARA EL RECUERDO SEMANAL DE LA IA
-- Ejecuta esta consulta en el SQL Editor de Supabase para habilitar la memoria de 7 días.

CREATE TABLE IF NOT EXISTS caller_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índice para búsquedas rápidas por teléfono y cliente
CREATE INDEX IF NOT EXISTS idx_caller_memories_phone_tenant ON caller_memories(phone_number, tenant_id);

-- Consulta para purgar recuerdos con antigüedad superior a 7 días (mantenimiento automático)
-- DELETE FROM caller_memories WHERE created_at < NOW() - INTERVAL '7 days';
