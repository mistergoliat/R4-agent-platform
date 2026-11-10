---
title: R4 — Entrega del PDF de la cotización por WhatsApp (sales-production@18, Core 0015)
status: R4_QUOTE_PDF_DELIVERY_READY_FOR_REVIEW — implementado y probado; no desplegado ni activado
mandate: «R4 — F1 CANARY CONTINUATION AND QUOTE DELIVERY», sección C (owner, 2026-11-10)
base: main a704319
---

# Entrega del PDF de la cotización

## 1. Auditoría de lo disponible

| Mecanismo | Estado | ¿Sirve para F1? |
|---|---|---|
| **Quote V2: entrega por correo** (`quote_deliveries`) | Existe en Quote. En la instalación actual el proveedor de correo está **apagado** (`QUOTE_EMAIL_PROVIDER=disabled`); el único envío registrado es la prueba W10 | No sin el owner de Quote. Además, R4 tendría que pedir el correo del cliente (dato personal nuevo, Customer no disponible en F1) |
| **Quote V2: lectura del documento** (`GET /v2/quotes/{id}/document`) | R4 ya lo usa: `quote.create@5` descarga el PDF al emitir y verifica su SHA-256 contra el manifiesto del owner | Sí: es la fuente del archivo |
| **R4 → Quote: puerto** | Solo `createAndIssue`, `getQuote`, `getOperation`, `lookupIdempotency` y `getDocument`; ningún método de envío | — |
| **R4 → WhatsApp** | El adaptador enviaba **solo texto** (`type: text`) | Faltaba el envío de documentos |
| **Avisos de plataforma** (ADR-041, R-4, Core `0014`) | Un pack encola un mensaje fijo por `(task, noticeKey)`; lo entrega el único dueño de la entrega con las compuertas de la salida del agente | Sí: es el camino, ampliado con un documento |

Restricciones de topología:

- La entrega la hace el **gateway**, que no tiene la credencial de Quote. Dársela ampliaría permisos.
- El **worker** tiene Quote y no envía mensajes.

Por eso el worker entrega al gateway los bytes que ya verificó, y el gateway no consulta Quote.

## 2. Diseño

1. `quote.create@5`, al liquidar una emisión, ya descarga el PDF y lo compara con el SHA-256 y el tamaño del manifiesto del owner.
2. **Solo en `@18`** y **solo si quedó `verified`**, `settle` encola un aviso de plataforma con el documento:
   - clave `sales.quote-document:<quoteId>`;
   - leyenda `Cotización N° … (PDF). Válida hasta el DD-MM-AAAA a las HH:MM (hora de Chile).`;
   - nombre `Cotizacion-<número>.pdf`.
3. Core `0015` (`outbound_documents`) guarda los bytes junto al outbound, con su SHA-256 y tamaño.
4. El gateway, por la ruta normal del outbound:
   - vuelve a verificar el SHA-256;
   - sube el archivo a la media del número de negocio;
   - envía **un** mensaje `document` con la leyenda al contacto de la conversación.
5. Cuando el outbound ya no puede reenviarse (aceptado, fallido, desconocido o cancelado), los bytes se **borran**; queda solo el manifiesto.

`@18` es `@17` más esta entrega, con la definición **v17**. v17 es v16 salvo una frase de la regla de `quote.create`: antes decía «no puedes compartir su documento»; ahora dice que la plataforma lo envía, y que el agente nunca lo envía, ni escribe un enlace, ni pide un correo. `@17` no cambia.

## 3. Requisitos del mandato

| # | Requisito | Cómo se cumple | Prueba |
|---|---|---|---|
| 1 | Recuperar el documento de la cotización emitida | Los bytes que `settle` acaba de leer de Quote para **esa** cotización; nunca otra fuente | `sales-quote-document` (`@18`) |
| 2 | Verificar identidad y referencia | La cotización ya pasó la liquidación estricta (correlación externa = la tarea, totales, validez, manifiesto). El archivo se acepta solo si su SHA-256 y tamaño coinciden con el manifiesto. El store vuelve a verificar el SHA-256 antes de guardarlo, y el gateway antes de enviarlo | `sales-quote-document` (corrupto → nada), `platform-notice-document` (SHA-256 falso → rechazo; bytes alterados → `document_integrity`) |
| 3 | No regenerar el PDF | R4 envía byte a byte el archivo del owner | Bytes recibidos por el proveedor = original |
| 4 | Solo al destinatario autorizado | El destinatario sale de la conversación de la tarea (binding), nunca del modelo; el modelo no participa | `platform-notice-document` |
| 5 | Idempotencia ante reintentos | Un aviso por `(tarea, cotización)`. Repetir la misma clave es una repetición; con otro archivo o sin archivo se rechaza. Una subida fallida es `not_sent` y se reintenta. El mensaje sigue la clasificación existente (un 5xx tras subir es `unknown` y nunca se reenvía) | `platform-notice-document`, `whatsapp-document` |
| 6 | Sin URL, documentos ni PII en logs | Ni el adaptador ni el runtime registran bytes, media id, nombre de archivo o destinatario. El log de Sales lleva solo `quoteId`, la tarea y un código | Contrato `@18` («a store failure is reported, never thrown»), `whatsapp-document` |
| 7 | Errores de entrega sin volver a emitir Quote | La entrega es un outbound aparte. Un fallo al encolar se registra (`quote.document.not_queued`) y la cotización sigue emitida | Contrato `@18`; `sales-quote-document` (`ownerCalls = 1`) |

Además:

- el kill switch retiene el documento como cualquier salida del agente (no se sube nada);
- un documento pendiente sin bytes se cancela (`document_unavailable`) y nunca sale como leyenda sola;
- un adaptador sin soporte de documentos lo rechaza (`document_unsupported`).

## 4. Evaluación

**Pruebas nuevas:**

| Prueba | Alcance | Casos |
|---|---|---|
| `tests/unit/live-ops/whatsapp-document.test.ts` | Subida y mensaje | Clasificación de 429, 400, 5xx, sin id, conexión caída y timeout |
| `tests/integration/platform-notice-document.test.ts` | Core `0015` sobre PostgreSQL con el proveedor local | 5 casos |
| `tests/integration/sales-quote-document.test.ts` | Canary aislado | `@18` con 1 documento, PDF corrupto con 0, `@17` con 0 |
| `tests/contract/sales-profile-v18.test.ts` | Perfil `@18` | Perfil, clave, nombre, leyenda (hora de Chile con y sin horario de verano), «nunca lanza» y diferencia v16 → v17 |

**Mutaciones:** `npm run test:mutation:quote-document` incluye 11 mutantes.

**Tests fijados actualizados:** el head del esquema (`0015`), las listas de perfiles (`@18`) y el alcance de F-ADV-2 (`@17`, `@18`).

**Pendiente de L3** (gate `document-delivery-l3`): una emisión real desde WhatsApp con `@18` que entregue exactamente un PDF igual al de Quote.

## 5. Despliegue (no autorizado en este PR)

- **Core `0015`** cambia la compatibilidad de ejecución, así que el despliegue es **coordinado**: gateway, workers y scheduler juntos, igual que con `0014` (procedimiento del PR #62, etapa 1).
- **El código viejo funciona sobre `0015`:** la tabla es nueva y readiness ignora migraciones extra.
- **El código nuevo no envía documentos con `@17`.** Activar `@18` es un cambio de carril aparte, con autorización por SHA: bootstrap `--lane` registra la definición v17, y `@17` queda como rollback.
- **Rollback:** antes de volver al código viejo no debe quedar ningún outbound pendiente con documento, porque el código viejo los enviaría como texto. Basta con cancelarlos o esperar a que se entreguen.
