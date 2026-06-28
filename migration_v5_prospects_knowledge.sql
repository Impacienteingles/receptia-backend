-- MIGRACIÓN V5: AÑADIR COLUMNA scraped_knowledge A LA TABLA prospects
-- Ejecuta esta consulta en el SQL Editor de Supabase para habilitar el guardado de datos web de prospectos.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS scraped_knowledge TEXT;
