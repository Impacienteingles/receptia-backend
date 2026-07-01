# Tareas de Ejecución: Guía Comercial, Prospecto Manual y Ajustes WhatsApp Cloud API

- `[x]` Actualizar la lógica JavaScript de `switchMainTab(tabName)` en `public/comercial.html` para soportar la pestaña `'guide'`
- `[x]` Adaptar el diseño responsivo del Playbook "Guía Comercial" en el panel comercial
- `[x]` Crear la ruta backend `POST /api/admin/prospects/manual` con validación de duplicados y deduplicación inteligente
- `[x]` Modificar el formulario en `public/admin.html` para admitir campos opcionales (Teléfono, Email, URL) al crear prospectos manualmente
- `[x]` Implementar la opción de sector "Otro (especificar manualmente)" en `public/admin.html` para ingresar sectores personalizados
- `[x]` Programar la lógica JavaScript para añadir los sectores dinámicos a los selects de prospección automática y manual en el cliente
- `[x]` Actualizar la función `renderProspectsTable()` en `public/admin.html` para marcar prospectos manuales con un fondo gris tenue (`rgba(255,255,255,0.03)`) y la etiqueta `"Manual"`
- `[x]` Extraer e inyectar dinámicamente sectores personalizados desde la base de datos al cargar prospectos
- `[x]` Añadir botón y lógica de descarga en PDF para la "Guía Comercial / Playbook de Crecimiento" en el Panel de Administrador (`admin.html`)
- `[x]` Corregir desalineaciones sintácticas en los scripts de `app.html` y `comercial.html`
- `[x]` Consolidar la versión visual y de logs a la `v1.1.5`
- `[x]` Compilar código con `npm run build` y verificar que no existan errores
- `[x]` Empujar y desplegar cambios a Render (vía GitHub) y Vercel (`npx vercel --prod --yes`)
