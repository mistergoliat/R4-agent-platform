# ADR-035 — Verificación independiente de la intención del cliente por confirmación conversacional (sales-production@6)

- **Estado:** **Aceptado solo para experimentación y canary** (decisión del owner, 2026-10-14): `ADR_035=ACCEPTED_FOR_CANARY`. No está desplegado y ningún worker productivo selecciona `@6`. Para el canary se acepta provisionalmente el gate `single-input-producer`. La procedencia contractual sigue siendo requisito previo a producción.
- **Fecha:** 2026-10-14
- **Complementa:** ADR-034. Resuelve, para `@6`, el bloqueo `CUSTOMER_INTENT_INDEPENDENT_EVIDENCE_REQUIRED` de `@5`. `@5` no cambia y sigue siendo `MODEL_ATTESTED`.
- **Autoridad superior:** Constitución ("model output is untrusted"; "writes require governed execution"); ADR-016/017/018/021/028/029/034
- **Evidencia:** `docs/architecture/R4-J3E_B_INDEPENDENT_INTENT_VERIFICATION_REPORT.md`

## Contexto

En `@5`, la solicitud del cliente (`record_quote_request`) la registra el modelo. R4 solo verifica su estructura. El owner exige que una cotización autónoma se emita únicamente con **evidencia independiente y verificable** de que el cliente confirmó la propuesta vigente, sin obligarlo a escribir códigos numéricos.

## Auditoría del contrato existente: `ProductionStore.thread(taskId)`

| Pregunta | Hallazgo (SOURCE) |
|---|---|
| ¿Qué es un `contact`? | Una fila de `task_inputs` unida a `memory_entries`: un input que el runtime temporal aceptó en la tarea mediante `submitInput`. |
| ¿Quién crea inputs? | (1) `ChannelIngress`, después de `adapter.authenticate`, que en WhatsApp verifica la firma del webhook. El actor es `user:<canal>:<clave>` y el `sourceRef` es `channel:<canal>`. (2) La API de plataforma, `POST /v1/tasks/:id/inputs`, con el principal que resuelva `deps.principal` (por defecto *unauthenticated*). (3) El harness de pruebas de Sales. **Ninguna decisión del modelo crea inputs.** |
| ¿Identificador estable? | `inputId` (UUIDv7) para los mensajes del cliente. `stepId` para las respuestas del agente; su `delivery.outboundId` identifica el mensaje saliente. |
| ¿Orden y timestamps? | `cursor = <ISO>|<id>`. `received_at` del input y `created_at` del paso salen del **mismo reloj**: la base de datos. |
| ¿Estado saliente? | `pending`, `dispatching`, `accepted`, `delivered`, `read`, `failed`, `unknown`, `cancelled`. **`accepted` = el proveedor tomó el mensaje; no prueba entrega.** `delivered` y `read` solo existen si llegan callbacks del proveedor. |
| ¿`taskId` ↔ conversación? | Hay un binding por conversación (`channel_conversation_bindings`), y la tarea queda fijada a él. Los inputs de la tarea son de esa conversación. |
| ¿El agente puede fabricar un `contact`? | **No.** `respond` crea entradas `agent`, nunca `contact`. |
| ¿Disponible en execute y recovery? | Sí. Se lee de la base durable en cada llamada. La reconciliación no lo necesita, porque la decisión ya quedó registrada. |
| **Límite** | `thread()` **no expone el actor** del input. Por eso no puede distinguir un mensaje del cliente por el canal de un input enviado por la API de plataforma. |

**Veredicto de procedencia:** **confiable frente al modelo**, que es el criterio central, y **condicionada a la topología** para afirmar "solo el cliente". Hoy, en producción, solo corren gateway, worker y scheduler; la API no corre, así que el único productor de inputs es el ingress autenticado. Esta condición se convierte en un gate de despliegue (`single-input-producer`). Para que sea contractual hay que **exponer `actorKind` y `sourceRef` en `ThreadEntry.refs`**. Eso cambia el harness y exige una decisión arquitectónica independiente, que este ADR **no** toma.

## Decisión

1. **Perfil `sales-production@6`.** Es `@5` con los mismos dominios, canal, capacidades y política autónoma, más:
   - Sales definition v6;
   - `quote.preview@2`;
   - `quote.create@4`;
   - dos límites nuevos y obligatorios: `R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS` y `R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS`.

   `@1–@5`, `quote.create@2/@3` y `quote.preview@1` no cambian; sus huellas quedan fijadas en tests.
2. **Vínculo oferta ↔ snapshot sin confiar en el modelo.** `quote.preview@2` devuelve `presentation.reference = Q-<6 hex del previewId>-<versión comercial>` y el texto del total. Sales **deriva** la referencia; el cliente solo la lee y nunca la escribe. La **versión comercial** es la versión del workspace en el último cambio aplicado de ítems, cantidades, destino o despacho. Por eso un cambio y su reversión producen otra referencia, aunque el contenido sea idéntico.
3. **`quote.create@4`** recibe solo `{ previewId }` y, antes de congelar o enviar nada, exige desde `ProductionStore.thread`:
   1. el **último** mensaje del cliente se ajusta por completo a la gramática cerrada `r4-sales-confirmation-es-v1`;
   2. ningún mensaje del agente o de un operador lo sigue;
   3. el mensaje inmediatamente anterior es del agente y presenta la referencia exacta y el total bruto del snapshot **recalculado ahora**; entre ambos no hay otro mensaje del cliente;
   4. esa oferta fue tomada por el proveedor (`accepted`, `delivered` o `read`);
   5. la confirmación llegó dentro de la ventana configurada;
   6. bajo el lock de decisiones, ese `inputId` nunca autorizó otra cotización.

   Además se mantiene todo lo de `@3`: snapshot recalculado, límites, duplicados, frecuencia, cuerpo congelado y reconciliación.
4. **Gramática determinista.** El mensaje completo debe ajustarse a `[AFIRMACIÓN] CONFIRMACIÓN (CONECTOR CONFIRMACIÓN)* [CORTESÍA]` después de normalizarlo. Se rechazan:
   - preguntas;
   - negaciones;
   - condiciones ("pero", "cambia", "otro", "todavía", "después", "creo", …);
   - cualquier palabra fuera de la gramática.

   No hay búsqueda de palabras clave. La ambigüedad se rechaza, y el agente debe volver a presentar la oferta y pedir una confirmación explícita (puede sugerir "CONFIRMO").
5. **Evidencia** (Sales migration `0009`, append-only). Guarda la referencia, la versión comercial, el total presentado, el `stepId` y la hora de la oferta, su estado de entrega y `outboundId`, el `inputId` y la hora de la confirmación, el SHA-256 de ambos textos, y la versión y regla de la gramática. **No copia el texto del cliente**, que queda en el Core. `confirmation_input_id` es **único**: la confirmación se consume una sola vez. La evidencia se escribe en la misma transacción que la decisión autorizada (`0008`) y el cuerpo congelado (`0007`).
6. **Unidades totales.** El límite total de `@6` es independiente del límite por línea. `@5` conserva exactamente sus cinco límites.

## Límites (honestos)

- **Procedencia condicionada a la topología** (ver arriba). Es un gate de producción hasta que el harness exponga el actor.
- **`accepted` ≠ leído.** La evidencia prueba que el proveedor tomó la oferta, no que el cliente la leyó. Que el cliente responda después es un indicio fuerte, pero no una prueba de lectura.
- **El texto de la oferta lo escribe el modelo.** Sales verifica que contenga la referencia y el total del snapshot vigente. No verifica que las líneas y el despacho estén descritos completos ni sin errores. Una oferta con la referencia y el total correctos pero con una descripción falsa de los productos no se detectaría.
- **La gramática es en español y deliberadamente estrecha.** Habrá confirmaciones legítimas rechazadas ("dale nomás", "ya po"); se resuelven pidiendo una confirmación explícita. Ampliarla requiere una versión nueva de la gramática.
- **Comprensión.** La gramática prueba una aceptación explícita e incondicional de la última oferta; no prueba que el cliente la haya entendido.

## Consecuencias

- La intención deja de ser `MODEL_ATTESTED` en `@6`: queda verificada contra registros de la plataforma que el modelo no puede crear (con la condición de topología).
- No se cambia el harness ni se agregan dependencias.
- Gates de despliegue (`SALES_PRODUCTION_PROFILE_V6_GATE`):
  - aceptar este ADR;
  - límites aprobados;
  - migraciones `0008` y `0009`;
  - definición v6 registrada;
  - productor único de inputs;
  - canary `@6` real;
  - autorización explícita.
