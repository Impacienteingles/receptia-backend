-- MIGRACIÓN V6: AÑADIR COLUMNAS city Y tags A LA TABLA prospects

-- 1. Añadir columna city para clasificar por localización
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS city TEXT;

-- 2. Añadir columna tags para almacenar etiquetas de acción comercial (ej: ["Llamada 1", "Email enviado"])
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;

-- 3. Inicializar todos los registros existentes asignando 'Granada' como ciudad por defecto
UPDATE prospects SET city = 'Granada' WHERE city IS NULL;
