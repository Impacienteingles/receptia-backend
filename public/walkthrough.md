# Walkthrough: Sistema de Referidos Completo en Receptia

Se ha desarrollado e integrado con éxito el **Sistema de Referidos y Promociones** en Receptia. Esta actualización conecta la trazabilidad de clientes apadrinados, las comisiones configurables, el abono automático al balance de Stripe y los apuntes de contabilidad en tiempo real.

## Cambios Realizados

### 1. Base de Datos (Supabase)
*   **[migration_v7_referral_system.sql](file:///Users/juanpablo/Desktop/APPS/Receptia/migration_v7_referral_system.sql)**:
    *   Tabla `referrals`: Almacena el referidor (`referrer_tenant_id`), los datos del referido, su estado (`pending`, `subscribed`, `cancelled`), y congela la modalidad de la promoción en el momento del registro.
    *   Tabla `referral_commissions`: Registra cada devengo de comisión mensual o única (`amount`, `period`, `status`, `applied_invoice_id`).

### 2. Backend y Rutas REST
*   **[src/routes/referrals.ts](file:///Users/juanpablo/Desktop/APPS/Receptia/src/routes/referrals.ts)**:
    *   Endpoints para consultar y editar la configuración global de referidos.
    *   Endpoint de registro seguro de referidos, validando auto-referidos y duplicados.
    *   Endpoints de estadísticas y desgloses contables para el panel del cliente y de administración.
*   **[src/index.ts](file:///Users/juanpablo/Desktop/APPS/Receptia/src/index.ts)**:
    *   Registrado el router Express en la ruta `/api/referrals`.
    *   **Stripe Webhook (`invoice.payment_succeeded`)**:
        *   Detecta automáticamente si el pagador es un nuevo referido, actualiza su estado a `subscribed` y devenga la comisión (fija o porcentual).
        *   Abona inmediatamente la comisión devengada al **Customer Balance de Stripe** del referidor para que se le reste de forma automática en su siguiente recibo.
        *   Concilia mediante FIFO las comisiones en Supabase cuando detecta que Stripe aplicó saldos a favor en la factura del referidor.
        *   Registra de forma automática apuntes en `accounting_transactions` por cada devengo de comisión y descuento aplicado para conciliación contable perfecta.

### 3. Panel de Administrador (`public/admin.html`)
*   **v2.7.31**:
    *   Añadida la pestaña **Promociones** en la barra de navegación lateral.
    *   Diseñada la vista `#tab-promotions` con 3 pestañas: *Configuración de Promoción* (toggle global y selector de modalidad), *Trazabilidad de Referidos* (tabla de recomendados y comisiones devengadas) y *Contabilidad* (conciliación del pasivo contable y balances por cliente).

### 4. Panel de Cliente (`public/app.html`)
*   **v1.3.13**:
    *   Agregada la opción **Referidos (Promo)** destacada con fondo rojo llamativo en la barra lateral, la cual se oculta o muestra dinámicamente según el estado de la promoción.
    *   Diseñada la vista `#client-view-referrals` con el formulario de apadrinar leads, tarjetas de ganancias acumuladas, proyecciones estimadas mensuales, listado de recomendados e historial de descuentos aplicados en facturas anteriores.
