# Walkthrough: Versión 1.1.0 de Receptia Mobile e Integración del Footer Completo en Comparativas

He implementado los requerimientos de recordar sesión, recuperación de PIN y el cambio a llamadas absolutas para evitar fallos de login, además de rediseñar los márgenes y footers de las páginas comparativas.

## Cambios Realizados y Despliegue

### 1. Actualización Semántica de la App Móvil a la Versión 1.1.0
*   **API Base URL Absoluta**: He modificado `public/mobile/app.js` para realizar todas las llamadas de la API a `https://receptia.corandar.com` de forma absoluta. Esto soluciona de raíz el fallo de login cuando la app se ejecutaba en el clon de Webempresa, ya que Apache (WordPress/Corandar.com) no tiene el backend de Express para procesar `/api/auth/login`.
*   **Casilla de Verificación "Recordar datos de acceso"**:
    *   Añadido un checkbox estilizado en el formulario de login.
    *   Si está marcado, guarda de forma persistente las credenciales (`email`, `pin` y `tenant_id`) en `localStorage`.
    *   Si no está marcado, guarda los datos únicamente en `sessionStorage` para la pestaña actual de navegación y limpia cualquier rastro de `localStorage`.
*   **¿Olvidaste tu PIN?**:
    *   Añadido un enlace en la pantalla de login que abre un modal modal premium instruyendo al usuario para contactar al soporte de Receptia vía correo electrónico o WhatsApp.
*   **Incremento Gradle**: Modificado `receptia-app/app/build.gradle.kts` subiendo `versionCode = 2` y `versionName = "1.1.0"`. Se ha compilado el APK y copiado a `/public/descargas/receptia-v1.1.0.apk`.

### 2. Optimización Visual de las Comparativas y Footer Completo
*   **Mapeo de Footer**: He replicado el footer completo de la home (con sitemap estructurado de Producto, Sectores, Comparativas y Empresa) en las tres páginas de comparativas:
    *   `/public/comparar/ringover/index.html` (Ringover ✅)
    *   `/public/comparar/contestador/index.html` (Contestador ✅)
    *   `/public/comparar/asistente-humano/index.html` (Asistente Humano ✅)
*   **Separación y Márgenes de la Tabla**: Se ha aumentado el margen vertical en el contenedor de las tablas comparativas a `my-12 md:my-16` para otorgar un aspecto desahogado y premium.
*   **Padding superior**: Aumentado a `pt-40 md:pt-48` en el contenedor `<main>` para evitar que el header fixed tape la cabecera del artículo.

---

## Verificación de Salud en Producción (v1.1.0)
*   **Vercel (Landing Oficial)**:
    *   Comparativa Ringover: `https://receptia.corandar.com/comparar/ringover/` (Disponible ✅)
    *   Comparativa Asistente Humano: `https://receptia.corandar.com/comparar/asistente-humano/` (Disponible ✅)
    *   Descarga APK v1.1.0: `https://receptia.corandar.com/descargas/receptia-v1.1.0.apk` (Disponible ✅)
*   **Webempresa (Clon Corandar)**:
    *   Comparativa Ringover: `https://corandar.com/receptia/comparar/ringover/` (Disponible ✅)
    *   Comparativa Asistente Humano: `https://corandar.com/receptia/comparar/asistente-humano/` (Disponible ✅)
    *   Descarga APK v1.1.0: `https://corandar.com/receptia/descargas/receptia-v1.1.0.apk` (Disponible ✅)
