# Walkthrough: Sistema de Referidos, Mejoras en la Landing Page de Receptia y Flujo de Login Directo

Se han desarrollado e integrado con éxito los cambios en el **Sistema de Referidos**, la **Landing Page** y el **Acceso Directo al Panel** de Receptia.

## Cambios Realizados

### 1. Flujo de Login del Cliente (`public/app.html`)
*   **Acceso Directo**: Cuando el usuario hace clic en "Iniciar sesión" en la landing corporativa, es redirigido a `/app.html`.
*   **Ocultación de la Landing Antigua**: Si no se detecta una sesión activa (`tenant_id`), `/app.html` ahora oculta completamente la landing page antigua y abre **de forma automática e inmediata** el modal de login de cliente (`#landing-login-modal`) pidiéndole el Email y el PIN de acceso.
*   **Redirección Dinámica**: Si el usuario cancela o cierra el modal de login, es redirigido de vuelta a la página principal corporativa (`/`).

### 2. Formulario de Contacto Real (`public/index.html`)
*   **Registro**: Los leads de contacto se guardan en la tabla `prospects` de Supabase de forma real.
*   **Envío de Correo**: El servidor backend (`POST /api/lead`) utiliza **Nodemailer** para enviar una notificación de email a `receptia@corandar.com` mediante el SMTP de Gmail.

### 3. Footer (`public/index.html`)
*   **Firma**: El texto `Corandar S.L.` del footer está enlazado a [https://corandar.com](https://corandar.com).

### 4. Versionado del Proyecto (v1.5.62)
*   **package.json**: Versión bumped a `1.5.62`.
*   **admin.html**: Versión bumped a `v2.7.35`.
*   **app.html**: Versión bumped a `v1.3.17`.
