# R4 — Recuperación de cotizaciones y seguimiento (M3)

Estado: **diseño + primer paso implementado** (rama `feat/r4-quote-recovery`). El seguimiento proactivo (§6) es una fase
posterior que **requiere autorización separada** y no está implementado.

Autoridad: Constitución > PRD > ADR > esta tarea. Quote V2 (MS-pesaschile-quote-service) es la autoridad sobre las
cotizaciones; R4 sólo registra lo que pidió y lo que el dueño respondió.

## 1. Lo que el contrato Quote V2 ofrece (auditoría)

Fuentes: `MS-pesaschile-quote-service/docs/v2/openapi.yaml`, `QUOTE_V2_STATE_MACHINE.md`, `QUOTE_V2_VALIDITY_POLICY.md`,
`QUOTE_V2_DOMAIN_CONTRACT.md` §14, `QUOTE_V2_SECURITY_SCOPES.md`, `QUOTE_V2_CONTRACT_FREEZE.md` (C16). Puerto R4:
`adapters/domains/src/quote/v2.ts` (`QuoteV2Service`), cliente `adapters/domains/quote/http/src/client.ts`.

| Tema | Contrato | En el puerto R4 |
|---|---|---|
| Estados | `QuoteStatus = draft \| issuing \| issued \| expired \| cancelled` (openapi `QuoteStatus`). `accepted`/`paid` **no** son estados V2. `expired` y `cancelled` son terminales (state machine §5). | `QuoteV2Status`, igual |
| Vencimiento | `expired ⇔ now ≥ validity.validUntilExclusive`. `getQuote` lo **proyecta** aunque el job aún no lo materialice (T9). Validez congelada al emitir (V-3): `cl-retail-5-calendar-days-v1` o `cl-retail-session-60m-v1` (seleccionada por el servidor; el carril F1 usa 60 min). No hay endpoint para vencer. | `QuoteV2Validity` |
| Lectura por id | `GET /v2/quotes/{quoteId}` (`getQuote`), scope `quotes:read`; visible para el principal creador (o `quotes:read:any`). | `getQuote` |
| Por clave de idempotencia | `GET /v2/idempotency/current?operation=` con header `Idempotency-Key` (sólo las claves del propio principal). | `lookupIdempotency` |
| Por referencia externa | `GET /v2/quotes?sourceSystem=&externalReferenceType=&externalReference=&status=&limit≤50&cursor=` (`listQuotesByCorrelation`). Varias cotizaciones pueden compartir referencia. | **No** expuesto en el puerto |
| Por cliente | **No existe** (no hay búsqueda por cliente, teléfono ni RUT). | — |
| Por conversación | Sólo vía la referencia externa anterior, si R4 la hubiera enviado; hoy R4 envía `externalCorrelation` sin referencia por conversación. | — |
| Renovación / reemplazo | **No existe**. "No revisions in V2: a commercial change after acceptance is a new quote (new key, new number)" (C16, state machine §5). No hay `extend`, `renew` ni `supersede`; un `expired` nunca revive. | — |
| Cancelación | `POST /v2/quotes/{id}/cancel` (draft, issued no vencido, issuing con operación fallida), sólo el creador. | No expuesto (R4 nunca cancela) |

Consecuencia: "actualizar una propuesta" es **siempre una cotización nueva** (clave y número nuevos), construida otra vez
desde Catalog/Shipping. R4 no puede listar cotizaciones de un cliente en Quote; la relación conversación → cotizaciones
vive en los registros de R4.

## 2. Lo que R4 registra hoy

- `sales.quote_v2_requests` (0007): cuerpo congelado por clave de ejecución (líneas con descripción y cantidad, despacho,
  sin datos más allá del cliente `guest`).
- `sales.quote_v2_acceptances` / `sales.quote_v2_issued` (0007): `quote_id`, número, `issued_at`, `valid_through_local_date`,
  `valid_until_exclusive`, verificación del PDF. **Por `task_id`.**
- `sales.quote_autonomous_decisions` (0008): la instantánea comercial autorizada (líneas con `itemKey` del workspace).
- `sales.quote_intent_evidence` (0009) y `quote_v2_sends.validation` (0011): evidencia de aceptación y revalidación.
- Workspace (`sales.workspaces`): por task; una task nueva empieza vacía.
- Continuidad entre tasks (R7-4): una task terminal nunca revive; el siguiente mensaje abre otra task. El linaje es
  `channel_conversation_bindings` con el mismo `(channel, conversation_key)` (índice 0013). `PriorConversationContextSource`
  muestra lo **dicho** antes, nunca evidencia ni estado.

Hueco: nada mostraba al agente, en una task nueva (o días después en la misma), qué cotizaciones existen en la conversación
ni su estado **actual**.

## 3. Estados que R4 distingue

| Estado | Dónde vive | Autoridad |
|---|---|---|
| Consulta exploratoria | Conversación (turnos), sin items en el workspace | conversacional |
| Interés comercial | Workspace con items / destino (`sales.workspace.update`) | Sales (estado de trabajo) |
| Propuesta guardada (no emitida) | `quote.preview` (observación, `previewId`) y `quoteRequest` del workspace; caduca con su evidencia | Sales + dueños (Catalog/Shipping) |
| Cotización enviada (emitida) | `sales.quote_v2_issued` + `getQuote` → `issued` | **Quote V2** |
| Cotización vencida | `getQuote` → `expired` (o, sin dueño, `now ≥ valid_until_exclusive` registrado) | **Quote V2** |
| Cotización anulada | `getQuote` → `cancelled` | **Quote V2** |
| Cliente interesado / no interesado | Lo que el cliente dice (conversación) y, si se registra, un `fact` del workspace declarado por el cliente. **No** se infiere de silencios. | cliente |
| Propuesta recuperada / actualizada | Una **nueva** `quote.preview` sobre los mismos items + una **nueva** aceptación del cliente + `quote.create` → número nuevo | Quote V2 |

Reglas:

1. Quote V2 manda: el estado mostrado es el de `getQuote` en el momento de compilar el contexto; si el dueño no responde
   se muestra lo registrado por R4 y `stillValid` es `null` (desconocido) antes del vencimiento registrado y `false`
   después (expirada o anulada; ambas terminales). Nunca se supone vigencia.
2. Varias propuestas legítimas por cliente: se muestran las 3 más recientes de la conversación, más nuevas primero,
   con `olderQuotesOmitted`, emitidas dentro de la ventana `R4_PROD_PRIOR_CONVERSATION_DAYS` (la misma de la
   continuidad entre tasks; 30 días por defecto).
3. Reintentos nunca duplican: la recuperación es sólo lectura; una cotización nueva usa la ruta normal (clave de ejecución
   = `Idempotency-Key`, cuerpo congelado en 0007, reconciliación por `lookupIdempotency`). Nunca se reemite
   automáticamente ni se reutiliza número, total o validez de otra cotización.
4. Aislamiento: sólo el linaje `(channel, conversation_key)` de la task actual; nunca búsqueda por cliente. Sin PII nueva:
   número, fechas, total del dueño, descripción/cantidad de los items y comuna de despacho (ya dichos en la conversación).

## 4. Primer paso implementado

`SalesQuoteRecoveryContextSource` (paquete Sales, `agents/sales/src/workspace/quote-recovery-source.ts`), registrado vía
`WorkerBindings.contextSources` (no Core):

- linaje: `ProductionStore.earlierConversationTasks(taskId, maxTasks)` (live-ops, genérico, mismo SQL que
  `earlierConversationTurns`);
- registros: `PostgresSalesStore.conversationQuotes(taskIds, { since, limit })` (sólo esquema `sales`);
- estado actual: `QuoteV2Service.getQuote` por cotización mostrada, con plazo de 2 s y memoria **por run** (el contexto se
  compila en cada iteración). La respuesta guardada se reproyecta con el reloj de cada compilación, como hace el dueño
  (T9): una `issued` cuyo `validUntilExclusive` pasó durante el run se muestra `expired`, `stillValid: false`;
- visibilidad: `getQuote` sólo ve las cotizaciones del principal creador (o con `quotes:read:any`). Si cambia el principal
  Quote de R4, las anteriores responden 404 y se muestran `unknown` (`stateFrom: r4_record`; seguro por defecto). El L3
  previo a la activación debe confirmar la visibilidad;
- un item `state` AUTHORITATIVE `live` `sales_quotes:<task>` con, por cotización: `quoteNumber`, `issuedAt`, `earlierTask`,
  `state`, `stateFrom` (`quote_owner` | `r4_record`), `stillValid`, `meaning`, `validThroughLocalDate`,
  `validUntilExclusive`, `totalGrossClp` (sólo del dueño), `items` (`itemKey` cuando hubo instantánea autónoma), `delivery`;
- texto `about` con las reglas del §3 (actualizar = workspace → `quote.preview` → oferta → aceptación → `quote.create`).

Activación: `R4_SALES_QUOTE_RECOVERY=enabled` (por defecto `disabled`; cualquier otro valor rechaza el arranque), y sólo
en perfiles con Quote REAL. Sin versión nueva de definición: la instrucción viaja en el item de contexto, como los demás
sources; desplegar el código no cambia el contexto del carril hasta que el owner active la variable.

## 5. Límites conocidos

- `R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION` cuenta por task: si el despliegue lo fija en 1, una cotización actualizada en
  **la misma task** será rechazada por `quote.create` (en una task nueva no). Decisión del owner.
- Una cotización que quedó en `issuing` (aceptada sin `quote_v2_issued`) no se muestra.
- No se usa `listQuotesByCorrelation`: R4 no envía referencia por conversación (evitar exponer el `conversation_key`).

## 6. Fase posterior (NO implementada; requiere autorización separada): seguimiento proactivo

Reglas mínimas propuestas para cuando se autorice:

- **Consentimiento**: sólo a contactos que pidieron o aceptaron explícitamente ser contactados sobre esa cotización; el
  consentimiento se registra con fecha y texto de la pregunta, y se revoca con cualquier negativa.
- **Rechazo**: "no me interesa", "no me escriban", bloqueo o reacción negativa ⇒ cero mensajes proactivos para esa
  conversación, de forma permanente y auditada; nunca reintentar con otro tono.
- **Anti-spam**: como máximo un seguimiento por cotización, ninguno si el cliente escribió después, ninguno fuera de horario
  de atención, ninguno tras vencer la ventana de 24 h de WhatsApp sin plantilla aprobada por Meta; tope global diario.
- **Contenido**: plantilla fija aprobada por el owner; nunca precios ni promesas de vigencia; una cotización vencida sólo
  se ofrece "actualizar" (nueva cotización por la ruta normal), nunca se reemite sola.
- **Gobierno**: el envío proactivo es una escritura gobernada (Policy Engine, kill switch, recibo), con evaluación y
  métricas de quejas/bajas antes de ampliar.
