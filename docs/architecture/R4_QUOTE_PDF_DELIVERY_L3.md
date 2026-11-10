---
title: R4 — L3 de la entrega del PDF por WhatsApp (sales-production@18 sobre 2b3b5a2)
status: R4_QUOTE_PDF_DELIVERY_DEPLOYED_VALIDATED — L3 aprobado; el carril volvió a @17 y espera la aprobación de activación
date: 2026-11-10
mandate: «R4 — PDF DELIVERY, UX AND CHECKOUT NEXT INCREMENT», secciones A y B
---

# L3 de la entrega del PDF (`@18`)

## Despliegue técnico

- R4 `2b3b5a2` (merge del PR #63, tras la revisión independiente) desplegado con el procedimiento coordinado: kill switch, drenaje, respaldo nuevo, los 4 procesos detenidos y arrancados juntos.
- Migración Core `0015` aplicada en 1 s.
- **Preflight:** ensayo sobre una copia restaurada de producción. `0015` se aplicó y una segunda corrida no aplicó nada. Readiness OK con el código nuevo y también con el desplegado antes (`a704319`) sobre `0015`, así que el rollback de código es viable.
- **Después del despliegue:** carril en `@17`, 0 advertencias o errores, observación OK.

## L3 por WhatsApp

**Montaje:**

- Carril de la allowlist cambiado temporalmente a `@18`, con el bootstrap `--lane` que registró la definición v17.
- Dos emisiones reales pedidas por el owner desde su número. Por el límite F1 de 1 cotización por conversación, la conversación de la primera se cerró antes de la segunda.
- Después, el carril volvió a `@17`, también con autorización del owner.

| # | Requisito | Emisión 1 (normal) | Emisión 2 (gateway detenido tras la confirmación) |
|---|---|---|---|
| 1 | Cotización real emitida | Sí: `issued`, `cl-retail-session-60m-v1`, sin despacho | Sí, igual |
| 2 | PDF recuperado desde Quote | Sí: verificación `verified` | Sí |
| 3 | Hash verificado | SHA-256 idéntico en el manifiesto de Quote, el recibo de R4 y el documento enviado | Idéntico |
| 4 | Documento enviado a WhatsApp | 1 intento, aceptado (HTTP 200) | 1 intento, aceptado tras levantar el gateway |
| 5 | Recepción del documento | `delivered` y `read` en WhatsApp; el owner lo abrió y se veía bien | `delivered` y `read`; recibido por el owner |
| 6 | Fecha y hora de vencimiento | La leyenda dice la misma hora de Chile que el `valid_until_exclusive` de Quote (minuto exacto) | Igual |
| 7 | Sin duplicados | 1 cotización, 1 clave de idempotencia, 1 documento, 1 intento | Igual |
| 8 | Recuperación ante interrupciones | — | El gateway se detuvo 0,1 s después de que se ingirió la confirmación. Con el gateway abajo, la emisión terminó y el PDF quedó pendiente. Al levantarlo (unos 20 s) salieron el PDF y la respuesta, una vez cada uno |
| 9 | Ningún fallo documental genera una cotización nueva | `quote.create` = 1 | `quote.create` = 1 durante toda la interrupción |

**Además:**

- `document.delivery = queued` en ambos recibos;
- los bytes en R4 se borraron tras la entrega (2 de 2);
- la verificación de rollback (§5 de `R4_QUOTE_PDF_DELIVERY.md`) da 0 documentos pendientes;
- 0 advertencias o errores.

**Lo que este L3 no ejercitó en producción, y dónde está cubierto:**

- Fallos del proveedor (subida rechazada, 429, ventana cerrada, timeout, lease vencido) y un PDF que no coincide: pruebas de integración y mutación (`whatsapp-document`, `platform-notice-document`, `sales-quote-document`; mutaciones `quote-document` 11/11).
- En todos esos casos la cotización sigue emitida y no se vuelve a emitir.

## Estado y solicitud

- El carril quedó otra vez en **`@17`**.
- `@18` está desplegado, registrado y validado, pero **inactivo**.
- **Se solicita al owner la aprobación para activar `@18` en la allowlist actual** (SHA `2b3b5a2`, `@17` como rollback): `FROM=sales-production@17 TO=sales-production@18 SHA=2b3b5a2 ~/r4-lane-switch.sh`.
- `ops/r4-f1-canary/observe.sh` ahora también vigila los documentos:
  - pendientes por más de 2 minutos;
  - `not_queued`;
  - `failed`, `unknown` o `cancelled`.
