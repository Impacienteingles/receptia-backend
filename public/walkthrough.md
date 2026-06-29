# Walkthrough: Sistema de Referidos y Mejoras en la Landing Page de Receptia

Se han desarrollado e integrado con éxito los cambios en el **Sistema de Referidos** y la **Landing Page** de Receptia.

## Cambios Realizados

### 1. Landing Page (`public/index.html`)
*   **Formulario de Contacto**: Conectado directamente al backend en el endpoint `/api/lead` para almacenar los leads de forma real.
*   **Iniciar sesión**: Redirigido el botón en el menú (escritorio y móvil) para apuntar directamente a `/app.html` (el panel del cliente), permitiendo un acceso rápido y directo a la consola del usuario.
*   **Footer**: Enlazado el texto `Corandar S.L.` con la web corporativa `https://corandar.com`.

### 2. Backend (`src/index.ts`)
*   **Endpoint `/api/lead`**:
    *   Registra al prospecto en la base de datos de Supabase.
    *   Envía de forma automatizada un email maquetado a `receptia@corandar.com` a través de Nodemailer con las credenciales configuradas en el entorno.
*   **Migración de Base de Datos**: Asegurada la creación automática de las columnas `notes` y `contact_name` en la tabla `prospects` de Supabase al iniciar el servidor.

### 3. Versionado del Proyecto (v1.5.61)
*   **package.json**: Versión bumped a `1.5.61`.
*   **admin.html**: Versión bumped a `v2.7.34`.
*   **app.html**: Versión bumped a `v1.3.16`.
