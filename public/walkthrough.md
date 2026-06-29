# Walkthrough: Hotfix de Integración SMTP, Supabase y Flujo de Despliegue de Receptia

Se han desarrollado e integrado con éxito los cambios en el **Sistema de Referidos**, la **Landing Page** y el **Acceso Directo al Panel** de Receptia.

## Cambios Realizados y Validaciones

### 1. Inserción de Leads Compatible con Supabase (`src/index.ts`)
*   **Problema**: Supabase fallaba al guardar el lead debido a que las columnas `contact_name` y `notes` no se pudieron migrar (por falta de credenciales directas de Postgres en producción).
*   **Solución**: Se modificó el endpoint `POST /api/lead` para mapear el lead en columnas existentes y válidas de Supabase:
    *   Nombre de la empresa concatenado con el contacto: `${company} (Contacto: ${name})`.
    *   Información del contacto y mensaje del cliente almacenados en la columna `commercial_notes` de tipo TEXT.
*   **Validación**: Confirmada a través del script `check_new_leads.js`. Las inserciones en Supabase ahora finalizan con éxito `200` y sin excepciones en el schema cache.

### 2. Persistencia de Variables de Entorno en el Script de Despliegue (`scripts/deploy.ts`)
*   **Problema**: Cada vez que se ejecutaba `npm run deploy`, el script de Render realizaba un `PUT` de variables de entorno estático, borrando las variables SMTP que se hubieran editado manualmente desde el dashboard de Render.
*   **Solución**: Se actualizó `scripts/deploy.ts` para leer las variables del `.env` local (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `CONTACT_RECEIVER_EMAIL`) e inyectarlas dinámicamente en Render durante cada despliegue.

### 3. Recuperación de Credenciales SMTP
*   Se recuperó la contraseña del SMTP de Webempresa para `hola@corandar.com` desde la consola de Render y se actualizó en el `.env` local para asegurar la consistencia.

### 4. Versiones del Proyecto (v1.5.64)
*   **package.json**: Versión bumped a `1.5.64`.
*   **admin.html**: Versión bumped a `v2.7.37`.
*   **app.html**: Versión bumped a `v1.3.19`.
