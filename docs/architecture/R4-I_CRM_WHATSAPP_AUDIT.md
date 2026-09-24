---
title: R4-I — Auditoría del WhatsApp existente en CRM-Customer-360 (prerrequisito del canal de producción)
status: draft (auditoría previa a implementación; ningún código de canal escrito)
owner: architecture
last_reviewed: 2026-09-24
r4_baseline: dd06a68ff078a18a81e3dd12f5fd0ca5ef177ec9 (R4 POST-H RECOVERY BASELINE)
crm_ref: CRM-Customer-360 @ 6526d2c (working tree con un doc sin trackear; sólo lectura)
---

# R4-I — Auditoría del WhatsApp existente en CRM-Customer-360

Sólo lectura. Nada de CRM se importa ni se accede desde R4 (AGENTS.md).
Evidencia = rutas de código de CRM-Customer-360 citadas abajo.

## 1. Qué existe (CRM-WA-1)

Dos caminos de entrada:

| Camino | Ruta | Estado |
|---|---|---|
| **Nativo** (autoridad actual) | Meta → `app/api/integrations/whatsapp/webhook/route.ts` → `lib/brain/native-whatsapp/service.ts#processNativeWhatsAppInbound` → (turn settlement opcional) → `runNativeAutonomousCycle` → outbox canónico → `lib/brain/messaging/autonomousOutboxTick.ts` → `lib/brain/messaging/metaClient.ts` (fetch real a Graph) | Piloto controlado en EC2 con allowlist; flujo real de WhatsApp reportado por el operador como `operational: verified` para `explore_catalog` (docs/CAPABILITY_MATRIX.md, ACTIVE_RELEASE §T02.6). Muchas piezas siguen `implemented_pending_real_smoke`. |
| **Legacy n8n** | `WA_00_Webhook_Master` (n8n) → `/api/brain/process-inbound`; tablas `n8n_wa_inbound_messages`, `n8n_conversation_cases`, `n8n_conversation_messages` | Compatibilidad; motor legacy deshabilitado por defecto (`BRAIN_LEGACY_SALES_CONSULTATIVE_ENABLED=false`). |

Persistencia: **MariaDB/MySQL** (`mysql2`): `conversation`, `conversation_message`,
`brain_message_outbox`, `crm_action_executions`/outcomes, `crm_opportunities`,
`crm_inbound_turn_settlements`, `customer_external_identity`, `hub_audit_log`.

`lib/brain/messaging/whatsapp-transport/*` (`WhatsAppMessageTransport`) es un adapter
**sandbox-only**, usado sólo con `FakeWhatsAppHttpClient`; no es el camino real de envío.

## 2. Matriz de capacidades

Clasificación: **A** reusar directo · **B** portar/adaptar semántica · **C** reemplazo R4 requerido · **D** fuera de R4-I.
"Probado en prod." = evidencia de uso real (piloto EC2) o de prueba contra MariaDB real, no sólo tests unitarios.

| # | Capacidad | Implementación CRM | Owner actual | Persistencia | ¿Específico de proveedor? | ¿Probado en prod.? | Requisito R4-I | Clase | Razón | Owner/componente R4 destino |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Verificación del webhook (GET `hub.mode/verify_token/challenge`) | `webhook/route.ts#GET`: exige `mode=subscribe`, token igual, challenge; 403 si no; 500 si falta token | Ruta Next.js | — | Sí (Meta) | Sí | §20 | **B** | Semántica correcta y conforme a la doc oficial de Meta; el código es Next.js (no importable). Portar tal cual. | Adapter `adapters/channels/whatsapp` (verificación) |
| 2 | Firma `X-Hub-Signature-256` (HMAC-SHA256 del cuerpo crudo con App Secret, `timingSafeEqual`) | `verifyMetaSignature` | Ruta Next.js | — | Sí | Sí | §20, §53 | **B** (+ cambio) | Algoritmo correcto (verificado contra doc oficial). **Límite:** fuera de `NODE_ENV=production` acepta sin secreto. R4 exige fail-closed siempre en modo producción ⇒ sin secreto no arranca. | Adapter WhatsApp |
| 3 | Extracción de `entry[].changes[].value.{messages,statuses,contacts,metadata}` | `extractMessages`, `extractPrimaryChangeValue` | Ruta | — | Sí | Sí | §77 | **B** (+ corrección) | Forma correcta. **Límite:** toma `phone_number_id`/`contacts` del *primer* `change` para todos los mensajes (`extractPrimaryChangeValue`); con varios `changes` en un POST podría atribuir mal. Portar leyendo metadata **por change**. | Adapter WhatsApp → `CanonicalInbound` |
| 4 | Normalización de wa_id (sólo dígitos) y timestamp (epoch s → ISO) | `normalizeWhatsAppRecipientDigits`, `toIsoTimestamp` | `whatsapp-transport/constants.ts` | — | Sí | Sí | §77 | **B** | Funciones puras correctas; se re-escriben (sin importar CRM). **Límite:** `toIsoTimestamp` cae a `now()` si el timestamp es inválido — R4 lo rechaza como inbound no canonicalizable. | Adapter WhatsApp |
| 5 | Allowlist de remitentes en la entrada (piloto), con auditoría del rechazo | `isAllowedRecipient` + `auditLog('whatsapp.inbound.rejected')`; inbound **no** persistido | Ruta | `hub_audit_log` | No (env CSV de números) | Sí | §43–45, §135 | **C** | R4 exige conservar el input y hacerlo visible (§135) y no guardar teléfonos en config (§45). En R4 el no-elegible se persiste y va a atención, no se descarta. Se conserva la *intención* (canary por identidad). | `@r4/production` rollout (allowlist con hash) |
| 6 | Dedupe de inbound por id de mensaje de Meta | Pre-check `SELECT` + `UNIQUE(provider, provider_message_id)` en `conversation_message`; el insert concurrente perdedor lanza, la tx hace rollback y el webhook responde 500 ⇒ Meta reintenta y el reintento encuentra el duplicado | `native-whatsapp/service.ts` | `conversation_message` | Id de Meta | Sí (+ test de concurrencia contra MariaDB, ACS-R1-05.1-T01) | §21–22, §65 | **B** | Semántica correcta: la unicidad la garantiza la BD. R4 la porta con `ON CONFLICT DO NOTHING` (sin 500 innecesario al proveedor). | `inbound_events` (`UNIQUE(channel, provider_event_id)`) — ingress de producción |
| 7 | Persistir primero; la cognición no bloquea la entrega del inbound | Inbound + evento + (turn settlement) en una tx; el ciclo autónomo corre después y sus fallos no deshacen el inbound. **Pero** con `settleDelayMs=0` (default) la cognición corre **dentro** del request HTTP del webhook | Servicio nativo | `conversation_message`, `crm_commercial_events` | No | Sí | §62–63 | **B** (+ cambio) | "Persistir antes que pensar" se conserva. Correr modelo/catálogo dentro del request del webhook contradice §63; en R4 el webhook sólo persiste y responde; el worker ejecuta. | Ingress R4 + worker (asíncrono) |
| 8 | Conversación = (canal, `phone_number_id`, wa_id), estable y reabrible | `conversation` con `UNIQUE(channel, channel_account_id, external_contact_id)`, `public_id = sha(phone_number_id, wa_id)`; un inbound reabre una conversación cerrada **conservando la propiedad** | Servicio nativo | `conversation` | Parcial | Sí | §23–25 | **B** | La identidad de conversación y la regla "un inbound nunca devuelve la conversación a la IA" se portan. Diferencia de modelo: CRM tiene una conversación eterna por contacto; R4 tiene tasks que pueden terminar ⇒ `ConversationBinding` (una binding abierta por conversación; trabajo terminal + contacto nuevo ⇒ task nueva, §24). | `channel_conversation_bindings` (integración, fuera de Core) |
| 9 | Resolución de identidad de cliente (external identity → master_customer, conflictos) | `resolveOrPersistNativeExternalIdentity` (+ detección de conflictos) | CRM Customer | `customer_external_identity`, `master_customer` | No | Sí | §36 | **D** | Es dominio Customer y vive en tablas de CRM (acceso prohibido). En R4-I Customer = UNAVAILABLE ⇒ cliente anónimo/desconocido; el wa_id es sólo dirección de canal. | Futuro adapter Customer (no R4-I) |
| 10 | Transcript continuo (inbound, outbound, eventos de sistema) | `conversation_message` (dirección, sender_type, status), leído por el workspace | CRM | `conversation_message` | No | Sí | "Humanidad" | **B/decisión** | En R4 el transcript canónico ya existe (inputs + steps `respond` + eventos humanos). **Conflicto de autoridad**: la UI del CRM lee `conversation_message`; si R4 es dueño del canal, esa UI deja de ver los mensajes. Ver §4. | R4: `task_inputs`/steps + `outbound_messages` |
| 11 | "Streaming" / actualización en vivo del hilo | No hay streaming: el workspace nativo re-lee en `router.refresh()`; la bandeja legacy (`ChatInbox`) hace polling con `setInterval` | UI CRM | Lectura de BD | No | Sí | Visibilidad | **B/decisión** | La semántica real es "la UI lee el estado durable". Se preserva si la UI lee una fuente durable con el hilo (ver §4). No hace falta construir streaming en R4-I. | Read API de R4 (o proyección, §4) |
| 12 | Turn settling (debounce de fragmentos "hola"/"como"/"estas") | `crm_inbound_turn_settlements` (una fila PENDING por conversación, unique generado), tick que junta fragmentos; default **desactivado** (`settleDelayMs=0`) | R3 | `crm_inbound_turn_settlements` | No | Validado con deuda (V1.8.1) | Humanidad | **D** (parcialmente cubierto) | En R4 cada input es durable y el claim es asíncrono: los fragmentos que llegan antes de que un worker reclame entran en el mismo snapshot; los que llegan durante una espera la despiertan una vez. Un debounce explícito no es necesario para seguridad; se difiere con justificación. | — (R4 ingress + claim) |
| 13 | Protección de turno obsoleto (no despachar si llegó un inbound más nuevo) | `superseded_by_newer_inbound` en el despacho de SalesAgentRuntime / turn settlement | R3 | settlement rows | No | Validado con deuda | Humanidad | **B/decisión** | Semántica valiosa ("no contestar algo ya superado"). En R4 la respuesta es una decisión aceptada; suprimirla por un input nuevo es una regla de entrega. Propuesta: portarla como regla del gate de entrega (configurable) o diferir — decisión humana. | Gate de entrega R4 |
| 14 | Take over humano atómico que **cancela** los envíos autónomos pendientes | `takeHumanControlTx` + `cancelPendingAutonomousSendsTx` (misma tx; `superseded_by_operator`) | CRM control | `conversation`, `brain_message_outbox` | No | Sí | §26–27, §49 | **B** | R4 ya tiene takeover (`POST /v1/tasks/:id/handoff`) que suspende la run. Falta la mitad del outbound: los outbound pendientes del agente se **cancelan** (no se retienen) cuando un humano toma la conversación — semántica probada, se porta. | Owner de entrega R4 (gate + cancelación) |
| 15 | Handoff pedido por la IA = mismo efecto que el take del operador | `takeHumanControlForAiHandoff` | CRM control | idem | No | Sí (TASK_001) | §26 | **A (semántica ya presente)** | R4 `request_handoff` ya produce el mismo estado que un takeover (E). | `TemporalRuntime` (sin cambio) |
| 16 | Mensajes del cliente durante el control humano | Se persisten; el ciclo autónomo no despacha (`ai_enabled=0`/`human_owner_active=1`) | CRM | `conversation_message` | No | Sí | §26 | **A (semántica ya presente)** | R4: `submitInput` sobre task `blocked` persiste y no despierta. | `TemporalRuntime` (sin cambio) |
| 17 | Devolver a la IA (`release`) | `release` pone `human_owner_active=0, ai_enabled=1` | CRM control | `conversation` | No | Sí | §133 | **A (semántica ya presente)** | R4 `release` despierta la task; la run nueva ve lo ocurrido en el período humano. | `TemporalRuntime` |
| 18 | Pausar IA sin dueño humano (`pause`), cerrar, reabrir | `applyConversationControl` pause/close/reopen | CRM control | `conversation`, `agent_sessions` | No | Sí | §49 | **B (parcial)** | `pause` ≈ kill switch por conversación; `close` ≈ cancel de task; `reopen` ≈ task nueva por binding. R4-I: pausa global (kill switch) + handoff; pausa por conversación se mapea a takeover. | Controles R4 |
| 19 | **Respuesta manual del operador** por WhatsApp (texto dentro de 24 h; plantilla `retomar_conversacion_v1` fuera de la ventana), con take over previo | `lib/domains/conversations/manual-reply.ts` | CRM | `conversation_message` | Sí (plantilla) | Sí | §49 (no listada), humanidad | **decisión (regresión si se omite)** | R4 no tiene hoy ningún camino para que un humano envíe un mensaje. Si R4 pasa a ser dueño del número, el operador pierde la capacidad de contestar ⇒ **regresión**. Ver §4. | Owner de entrega R4 (origen `operator`) o CRM (§4) |
| 20 | Ventana de 24 h de WhatsApp antes de enviar texto libre de IA | `isWhatsAppWindowOpen` en la revalidación previa al envío (cancela `window_closed` + auditoría de escalamiento) | Outbox tick | `conversation.last_inbound_at` | Sí (regla Meta) | Sí | Entrega honesta | **B** | Regla del proveedor probada; se porta dentro del adapter/gate WhatsApp como rechazo *definitivamente no enviado* (sin llamar a Meta). | Adapter WhatsApp (capacidad del canal) + gate |
| 21 | Outbox durable con dedupe por clave, claim atómico, revalidación inmediatamente antes del envío | `canonicalOutboxWriter` (`INSERT IGNORE` + unique `dedupe_key`), `lockOutboxRecord` (planned→locked), `revalidateBeforeSend` | Messaging | `brain_message_outbox` | No | Sí | §10–11, §111 | **B** | Semántica correcta y probada. R4 la porta con identidad = step `respond` aceptado, claim con lease + generación (fencing) en PostgreSQL. | `outbound_messages` + owner de entrega R4 |
| 22 | Reintento de envío: `meta_network_error` (incluye **timeout** por `AbortController`) y HTTP 429/5xx se reintentan hasta 5 veces con backoff | `isRetryableSendFailure`, `metaClient.ts` (timeout ⇒ `failed/meta_network_error`) | Outbox tick | `brain_message_outbox` | Sí | Sí | §14, §66, §100 | **C** | **Límite concreto:** un timeout después de que Meta aceptó el mensaje se reintenta ⇒ mensaje duplicado real posible (Meta no documenta idempotency key). R4 §14/§66 lo prohíben explícitamente (bloqueante de §100). Reemplazo: timeout / reset tras enviar / 5xx ⇒ `unknown`, nunca reintento ciego; sólo "definitivamente no enviado" (conexión rechazada, 429, 4xx de validación) es reintentable. | Owner de entrega R4 |
| 23 | Lock `locked` vencido (crash durante el envío) | Detectado y **sólo reportado** (`stale locked ... reported only`); nunca re-enviado | Outbox worker | `brain_message_outbox` | No | Sí | §92 | **B** | Conservador y correcto; R4 lo hace explícito: lease vencida en `dispatching` ⇒ `unknown` + atención (en vez de quedar `locked` indefinidamente). | Owner de entrega R4 |
| 24 | Callbacks de estado `sent/delivered/read/failed`: historia append-only idempotente + proyecciones monótonas por rango **en el WHERE del UPDATE** (sin read-then-write) | `applyMetaDeliveryStatus`, `DELIVERY_RANK_CASE` (sent=1, failed=2, delivered=3, read=4) | Servicio nativo | outcomes + `conversation_message.status` + `brain_message_outbox.provider_status` + `crm_opportunities` | Sí | Sí (+ hardening de concurrencia T04.1) | §16, §68 | **B** (+ ajuste) | Técnica probada (rango en SQL). Ajustes R4: (a) `failed` con rango 2 permite `failed → delivered`; R4 trata `failed` tras `accepted` como terminal salvo `delivered/read` posteriores explícitos — decisión documentada; (b) sin proyección a oportunidades (dominio Sales, fuera de Core); (c) no se guarda el payload crudo del status (CRM guarda `raw_payload` en `metadata_json`, §52). | `outbound_delivery_events` + lifecycle R4 |
| 25 | Correlación de status con el mensaje: sólo por `provider_message_id` (wamid) | `loadConversationMessageByProviderMessageId` | Servicio nativo | idem | Sí | Sí | §17, §92 | **B** (+ límite) | Si el envío terminó en timeout no hay wamid ⇒ un callback posterior queda huérfano (`message_not_found`). R4 conserva la correlación por wamid y registra los callbacks huérfanos para reconciliación manual. `biz_opaque_callback_data` **no** se usa: no pude verificarlo en la documentación oficial. | Owner de entrega R4 |
| 26 | Clasificación de errores del proveedor y saneamiento (token, dígitos largos, fbtrace enmascarado) | `classifyWhatsAppResponse`, `sanitizeWhatsAppProviderError` | Transport (sandbox) | — | Sí | Tests (camino sandbox) | §53, §82 | **B** | Funciones puras útiles: se re-escriben en el adapter (no importables). Ojo: aquí `timeout` es un estado propio (bien), pero el camino real (`metaClient`) no lo usa (fila 22). | Adapter WhatsApp |
| 27 | Header `X-Idempotency-Key` en el request | `buildWhatsAppTextRequest` (sólo sandbox) | Transport (sandbox) | — | — | No (el camino real no lo envía) | §15 | **C** | No es un mecanismo documentado por Meta: enviarlo no garantiza nada. R4 no afirma exactly-once. | — |
| 28 | Indicador "escribiendo" + marcar leído (`status:"read"`, `typing_indicator`) | `postMetaWhatsAppTypingIndicator` (turn settlement) | R3 | — | Sí | Validado con deuda | UX | **D** | UX, no correctitud; diferido (no es un efecto sobre el cliente que R4-I deba gobernar todavía). | — |
| 29 | Plantillas (fuera de 24 h) | `metaClient` (template), `manual-reply` | Messaging | — | Sí | Sí (manual) | — | **D** (salvo decisión fila 19) | El agente de R4-I no envía plantillas (sólo `respond` dentro de la ventana). | — |
| 30 | Media / audio / documentos / reacciones entrantes | Se persiste `messageType` con `text = ""` (el cuerpo queda vacío) | Servicio nativo | `conversation_message` | Sí | Sí | §78 | **C** | **Límite:** un adjunto llega como texto vacío (descarte silencioso del contenido). R4 lo clasifica explícitamente como no soportado y lo lleva a atención/handoff. | Adapter WhatsApp + ingress |
| 31 | Payload crudo en BD | `rawPayload` en eventos; status `raw_payload` en `conversation_message.metadata_json` | CRM | varias | Sí | Sí | §51–52 | **C** | R4 guarda campos canónicos + ids de proveedor; sin cuerpo crudo. | Ingress R4 |
| 32 | Legacy n8n (`n8n_wa_inbound_messages`, `n8n_conversation_cases/messages`, `WA_00_Webhook_Master`) | n8n + `/api/brain/process-inbound` | n8n / CRM | tablas `n8n_*` | Sí | Legacy | — | **D** | Camino de compatibilidad, no la autoridad actual; R4 no lo reemplaza ni lo lee. | — |
| 33 | Proyecciones comerciales (oportunidades, decisiones, commercial events) | `crm_opportunities`, `crm_agent_decisions`, `recordCommercialEvent` | CRM Sales | MariaDB | No | Sí | — | **C** | Conceptos de dominio: no entran en Core R4; en R4 viven en el pack Sales/Quality. | Pack Sales / G |

## 3. Qué agrega R4-I (CRM-WA-10)

Nada de esto existe en CRM y no se fuerza en su contrato:

- `AgentDecision.respond` → `OutboundMessage` con identidad durable = step `respond` aceptado (`UNIQUE(response_step_id)`); una recuperación ADR-028 es una run nueva con steps nuevos y nunca re-despacha un outbound existente.
- Estado `unknown` explícito (timeout / crash durante el envío), sin reintento ciego; reconciliación sólo por callback o por un operador.
- `ConversationBinding` conversación → task durable (continuidad tras fallo recuperable; task nueva tras trabajo terminal).
- Modo producción explícito fail-closed, perfil de política versionado, rollout estable por conversación (hash), kill switch durable (default: autonomía deshabilitada), precedencia kill switch > deny > rollout > política.
- Ownership humano de R4-E como única autoridad; correlación inbound → task → run → step → outbound → wamid; evaluación post-hoc de G.
- Concurrencia horizontal con leases + generación en PostgreSQL (outbound e inbound).

## 4. Decisiones que requieren autorización humana antes de implementar

**D-1. Autoridad del hilo y plano del operador (bloqueante de "no regresión").**
Meta entrega el webhook de un número a *una* app suscrita; CRM y R4 no pueden ser dueños
del mismo número a la vez sin duplicar respuestas. Hoy la UI de operadores (hilo, take over,
release, pausa, respuesta manual, estados de entrega) lee y escribe tablas MariaDB del CRM,
a las que R4 no puede acceder (AGENTS.md). Opciones:

- **(a) CRM sigue siendo dueño del número y del plano del operador; R4 detrás de un adapter.**
  El CRM reenvía el inbound ya autenticado y deduplicado al ingress canónico de R4 (HTTP,
  contrato genérico) y entrega los outbound de R4 por su outbox/Meta client. Sin regresión de
  UI; pero la entrega (unknown, fencing) queda partida entre dos sistemas y requiere cambios
  en el repo CRM (fuera de este repositorio).
- **(b) R4 es dueño del número (adapter WhatsApp propio) y expone una API de lectura del hilo
  y de acciones de operador (incluida la respuesta manual) que la UI del CRM consume.** Un
  solo owner de entrega (el que pide R4-I §120); requiere cambios en la UI del CRM y el
  endpoint de respuesta manual en R4 (fila 19) para no regresar.
- **(c) R4 dueño del número sólo para un número/canary separado** (p. ej. un número de
  prueba), con la API de operador de R4 (sin UI) mientras el número productivo sigue en el
  CRM. Sin regresión en el número productivo; la paridad de UI queda como bloqueante antes
  de migrar el número productivo.

Recomendación: **(c) ahora, diseñada para (b)**. Es la única que no rompe el plano del
operador existente, deja un único owner de entrega por número y no exige tocar el CRM en R4-I.

**D-2. Respuesta manual del operador (fila 19).** Con (b)/(c) hace falta un envío de
origen `operator` en el owner de entrega de R4 (mismo lifecycle, idempotency, unknown; sin
pasar por el agente). Propuesta: incluirlo en R4-I (texto dentro de 24 h); plantillas fuera de la ventana: diferidas.

**D-3. Protección de turno obsoleto (fila 13).** Portar como regla del gate de entrega
(no despachar un `respond` si llegó un input posterior al snapshot que lo produjo; se
cancela y queda visible para la cognición siguiente) o diferir.

**D-4. Política de reintento (fila 22).** Reemplazo justificado por R4-I §14/§66/§100:
timeout / reset / 5xx ⇒ `unknown`. Consecuencia visible: en un timeout real el cliente puede
quedar sin respuesta hasta que llegue el callback o actúe un operador, en lugar de arriesgar
un duplicado.

### Decisiones tomadas (2026-09-24, autorización humana)

- **D-1 → (c)**: número canary separado del que R4 es dueño de punta a punta: webhook de
  Meta, canonicalización del inbound, binding durable de conversación, entrega outbound y
  reconciliación de estados de entrega. El número productivo sigue **enteramente** en
  CRM-Customer-360 durante R4-I. **No** se introduce un puente de entrega CRM→R4→CRM.
  "R4 dueño del número productivo" (b) es la arquitectura objetivo de migración, no la
  elección de rollout de R4-I.
  - La semántica UX probada del CRM se preserva portándola: mensajes que llegan mientras
    se trabaja (en el CRM el "streaming" es polling del estado durable), visibilidad del hilo,
    respuesta manual, handoff humano y estados de entrega/lectura. En R4-I: API de hilo con
    cursor incremental (polling equivalente), acciones de operador (take/release/pause vía
    E + respuesta manual) e inspección de outbound.
  - **Bloqueante antes de migrar el número productivo**: R4 debe exponer APIs de hilo y de
    operador suficientes para la UI existente del CRM (o una superficie equivalente), de modo
    que la migración no regrese las operaciones humanas.
- **D-2 → sí**: envío de origen `operator` en el owner de entrega de R4, sólo texto dentro de
  la ventana de 24 h; plantillas diferidas.
- **D-3 → portar como invariante determinista de entrega**: un outbound de origen agente aún
  `pending` no se despacha si llegó un input del cliente posterior al estado conversacional
  sobre el que se generó la respuesta; se marca `cancelled` con
  `reason = superseded_by_newer_input`, y la run siguiente ve que no se envió. Se revalida
  inmediatamente antes de la llamada al proveedor (en la misma transacción que el claim). Se
  determina por referencia causal durable (inputs no evaluados por el ContextSnapshot que
  produjo el `respond`), no por relojes. Nunca se cancelan retroactivamente outbound
  `dispatching`, `accepted`, `delivered`, `read` ni `unknown`.
- **D-4**: reemplazo de la política de reintento aceptado implícitamente por R4-I §14/§66
  (timeout / reset / 5xx ⇒ `unknown`).

## 5. Resumen para el informe final (borrador)

- CRM-WA-1: §1.
- CRM-WA-2 (reuso directo): ningún módulo de código (Next.js/mysql2; prohibido importar CRM). Reuso directo de *semántica* ya presente en R4: filas 15–17.
- CRM-WA-3 (portado): filas 1–4, 6–8, 14, 20, 21, 23, 24, 25, 26.
- CRM-WA-4 (no reutilizado): filas 5, 9, 22, 27, 30–33 (con justificación por fila).
- CRM-WA-5 (inbound/streaming): no existe streaming; la semántica "la UI lee el estado durable" se preserva según D-1.
- CRM-WA-6 (continuidad de conversación): fila 8 → `ConversationBinding`.
- CRM-WA-7 (handoff): filas 14–18; R4-E ya cubre take/release/inputs durante control humano; falta la cancelación de outbound pendientes (se porta).
- CRM-WA-8 (estados de Meta): filas 24–25.
- CRM-WA-9 (persistencia): R4 es dueño sólo de binding, inbound dedupe y lifecycle de outbound; el transcript comercial y la identidad de cliente siguen fuera de R4 (D-1).
- CRM-WA-10: §3.
- CRM-WA-11 (regresiones potenciales): respuesta manual del operador (fila 19), visibilidad en la UI del CRM (filas 10–11), indicador escribiendo (fila 28, diferido), turn settling (fila 12, diferido con justificación). Ninguna se acepta sin decisión explícita (§4).
