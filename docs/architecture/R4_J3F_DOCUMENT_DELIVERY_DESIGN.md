# R4-J3F — Entrega gobernada del documento oficial de la cotización (diseño)

## Datos del documento

| Campo | Valor |
|---|---|
| Fecha | 2026-10-14 |
| Rama | `r4-j3f-document-delivery-design`, desde `origin/main` `092715e` |
| Referencia de contratos futuros | Rama publicada `r4-j3e-c-deterministic-commercial-offer` (`d19bffe`: `quote.create@5`, `sales-production@7`, GAP-16, ADR-036/037), leída sin mezclar su código |
| Estado | **DEFERRED** (decisión del owner, 2026-10-14). `J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA`. Se conserva como insumo de la iniciativa **R4 Media & Communications — Governed Multimodal Capabilities**. J3 se re-delimita sin entrega documental (`J3_DOCUMENT_DELIVERY=DEFERRED`). Sin implementación, sin cambios de harness, Sales ni Quote V2, sin migraciones (la `0011` no está autorizada) y sin despliegue |
| Decisión formal | [ADR-038](../adr/ADR-038-governed-document-outbound.md) (propuesto) |
| Plan | [R4_J3F_IMPLEMENTATION_PLAN.md](R4_J3F_IMPLEMENTATION_PLAN.md) |

**Meta de J3F:** cuando Quote V2 confirma una cotización emitida, entregar automáticamente su PDF oficial a la conversación autenticada donde se pidió. El mecanismo debe ser gobernado, durable, auditable e idempotente, y no debe depender de una decisión adicional del modelo.

**Etiquetas de evidencia** (mismas que la aceptación J3):

| Etiqueta | Significado |
|---|---|
| SOURCE | Código, con archivo y línea. Si no se indica otra cosa, es `main`. "J3E-C1:" indica la rama de referencia |
| DOC | Documento del repositorio |
| META-DOC | Documentación oficial de Meta, consultada el 2026-10-14 |

## Contenido

1. Resumen de la decisión
2. Auditoría: qué existe y qué falta
3. Arquitectura propuesta
4. WhatsApp Cloud API: verificación contra la documentación oficial (D4)
5. Contratos y mapeo de Sales
6. Documento bajo demanda (D2)
7. Mensajes posteriores del cliente y estado de la conversación (D3)
8. Atomicidad e idempotencia: los diez puntos de interrupción
9. Comunicación al cliente
10. **Matriz de riesgos y garantías**
11. Tests y evaluación
12. **Criterios de aceptación funcional**
13. **Bloqueos J3 y gates J7**
14. Rollout, operación y rollback
15. Decisiones pendientes del owner
16. Revisión de datos sensibles

---

## 1. Resumen de la decisión

| Pregunta del mandato | Respuesta |
|---|---|
| ¿Existe un mecanismo genérico reutilizable? | **No.** El outbound es solo texto. No hay origen de plataforma. Ningún efecto ocurre después de un recibo. Un step de plataforma no puede proponer acciones (§2) |
| ¿Hace falta extender el harness? | **Sí.** La extensión es aditiva y genérica: efecto derivado declarado, artefacto con el recibo, outbound documental y fuente de documentos verificada (ADR-038) |
| ¿Quién decide entregar? | La **capability** declara que su escritura produce un documento. La **Policy Engine** autoriza esa comunicación junto con la acción. La **puerta de entrega** decide el momento. El modelo no decide nada |
| ¿Quién es dueño del PDF? | Quote V2. R4 lo lee bajo demanda en el gateway, lo verifica en memoria y no lo almacena |
| ¿Cómo se evita perder la obligación? | El artefacto se escribe en la **misma transacción** que el recibo `succeeded`. El dueño de la entrega lo materializa de forma idempotente |
| ¿Cómo se evitan duplicados? | Una clave lógica por (binding, documento). Solo se reintenta lo "definitivamente no enviado". `unknown` nunca se reenvía |
| ¿Qué recibe el cliente? | El PDF con un caption determinista del pack (número, total, validez). Si el envío falla en forma definitiva, recibe un aviso neutral |
| ¿Qué no se afirma? | Una entrega física exactamente una vez. Tampoco "entregado" si Meta solo aceptó el envío |
| ¿Es parte de J3? | Sí: cierra GAP-01 y GAP-03. La activación en el número real de WhatsApp es J7 (§13) |

## 2. Auditoría: qué existe y qué falta

### 2.1 Lo que existe y se reutiliza

| Pieza | Hecho (SOURCE) | Uso en J3F |
|---|---|---|
| Dueño único de la entrega | `OutboundDeliveryRuntime` y `DeliveryDispatcher` solo en `apps/channel-gateway`. Claim con `FOR UPDATE SKIP LOCKED`, lease y generación. Intento durable antes de la llamada. Resultado con fencing (`packages/live-ops/src/outbound.ts:65-209`; `packages/persistence-postgres/src/production-store.ts:315-437`) | Se reutiliza tal cual; se agrega el despacho documental |
| Estados de entrega | `pending → dispatching → accepted → delivered → read`, más `failed`, `unknown` y `cancelled`. `unknown` nunca se reintenta (`delivery.ts:4-25`) | Mismos estados |
| Evidencia del proveedor | Única por `(channel, event_key)`, monótona; la evidencia sin id se aplica cuando el id llega (`production-store.ts:461-498`; `delivery.ts:149-163`) | Se reutiliza; se agrega correlación opaca |
| Puerta de entrega | `decideDispatch` en la transacción del claim (`delivery.ts:86-98`) | Rama nueva para el origen `platform` |
| Binding conversación ↔ task | Un binding abierto por conversación y uno por task (índices únicos parciales). El destinatario se lee del binding en el claim (`0007:47-68`; `production-store.ts:328,385`) | Única fuente del destinatario |
| Kill switch y rollout | Global y por canal para el outbound (`autonomy.ts`; `delivery.ts:88-90`) | Se aplican igual |
| Operador | Cancelar pendiente, resolver `unknown` con evidencia, atención (`operator.ts`; `apps/api/src/app.ts:251-293`) | Se reutilizan; se agrega `release` |
| Estado de entrega para el agente | `DeliveryStateContextSource`, episodio OBSERVED (`packages/live-ops/src/context-source.ts:25-58`) | Se extiende a documentos |
| Recibo inmutable y reconciliación | Recibo único por ejecución; reconciliación por clave en el worker (ADR-018/019/020/022) | El artefacto nace con el recibo |
| Lectura del PDF | `GET /v2/quotes/{id}/document`, `application/pdf`, 1 byte–20 MiB, buffer, cabecera `X-Document-Sha256` (`adapters/domains/quote/http/src/client.ts:41,120-131`) | La reutiliza la fuente de documentos Sales |
| Evidencia de emisión | `settle` exige el manifiesto, descarga, compara SHA-256, longitud y cabecera, y descarta los bytes. La salida trae `document{pdfSha256, byteLength, verification}`, nunca una URL (J3E-C1: `agents/sales/src/capabilities/quote-v2.ts:85-98,323-388`). `sales.quote_v2_issued` es inmutable (`agents/sales/migrations/0007…:46-68`) | De ahí sale el descriptor |
| Correlación con la task en el owner | `externalCorrelation.externalReference = taskId`, verificado en `settle` (J3E-C1: `quote-v2.ts:292,345`) | Base de la verificación de correspondencia |

### 2.2 Lo que falta

| Falta | Evidencia |
|---|---|
| Contenido no textual en el outbound | `OutboundSubmission.text: string` (`channel.ts:73-81`); `DispatchClaim.text` (`ports.ts:205`); `type: 'text'` fijo (`whatsapp-cloud/src/outbound.ts:51`); el proveedor falso solo lee `text.body` (`testing.ts:74`) |
| Un origen de outbound que no sea un `respond` ni un operador | `OUTBOUND_ORIGINS = ['agent','operator']` (`delivery.ts:27`) y el CHECK de `0007` |
| Un efecto de plataforma tras un recibo | `settleWithin` termina en la observation (`action-runtime.ts:637-706`). Una reconciliación conocida solo vuelve la task ejecutable (`temporal-runtime.ts:817-835`) |
| Un `propose_action` de plataforma | Prohibido: `0010_platform_step_decisions.sql:11`; `run-step.ts:88-89` |
| Autorización de comunicación externa | Ninguna capability usa `EXTERNAL_COMMUNICATION`. El default de esa clase es `require_approval` (`configuration.ts:68`) |
| Vínculo outbound ↔ acción | No hay columna ni FK entre `outbound_messages` y propuestas, ejecuciones o recibos |

### 2.3 Hallazgos laterales (no los resuelve J3F; se registran)

| Hallazgo | Evidencia | Clasificación |
|---|---|---|
| Un comando `prepared` cuyo run se abandona o cancela queda `prepared`: sin reconciliación y la task puede cerrar. No hubo llamada externa, así que no hay efecto perdido | `mutations.ts:129`; `task-store.ts:197-213`; `action-runtime.ts:855-863` | Para revisar en ADR-037; no afecta a J3F, porque J3F parte de un recibo |
| La correlación del owner usa `externalReferenceType: 'r4-task'`; el freeze dice `task` | J3E-C1: `quote-v2.ts:30`; DOC: `R4-J3A_QUOTE_SERVICE_R1.2_V2_CONTRACT_FREEZE.md:50-53` | Sin impacto: J3F compara solo `externalReference` |
| El fixture de Quote V2 responde 409 `document_not_available`; el contrato del owner dice 404 si no está emitida | `fixture-v2.ts:145`; DOC: R1.1 §S | La fuente de documentos trata 404 y 409 igual (§6.5) |
| La aceptación J3 §11 aún dice "ADR-037 no existe" | J3E-C1: `R4_J3_FINAL_ACCEPTANCE.md:383` vs `:561` | Corregir en J3F-D |

## 3. Arquitectura propuesta

### 3.1 Recorrido

```text
Cliente "Sí, emítela."
  └─ ChannelIngress → task_inputs (sin cambios)

Worker (sin cambios de cognición)
  kernel → propose_action quote.create@N {previewId}
  authorizeAction  [tx]  PolicyDecision allow
                         + policy_derived_decisions(artifact_delivery = allow)
                         + comando (execution_key)
  execute → Quote V2 createAndIssue → settle (manifiesto, PDF verificado, descriptor)
          → applied { result, artifact }
  settleWithin     [tx]  action_receipts(succeeded)
                         + action_artifacts
                         + observation(artifact.delivery = permitted)
                         + step observed
  kernel → modelo → respond (texto libre; las instrucciones v8 le piden no repetir cifras) → WAIT_FOR_INPUT

Gateway (único que habla con WhatsApp)
  tick.materialize [tx]  outbound_messages(origin platform, document, pending, r4-doc:…)   ← idempotente
  claim            [tx]  puerta (§7) → dispatching + intento
  fetch            (DocumentSource 'quote-v2', principal de solo lectura)       ← sin tx, bytes en memoria
  verify           (plataforma: SHA-256, longitud, %PDF-, cabecera, tamaño)
  registrar fase   [tx]  fetch/verify (renueva el lease)
  upload           POST /{phone-number-id}/media                                ← no visible para el cliente
  registrar fase   [tx]  media_ref + send_started_at (renueva el lease)
  send             POST /{phone-number-id}/messages type: document {id, filename, caption} + callback opaco
  registrar        [tx]  accepted | pending (definitivamente no enviado) | failed (+ aviso) | unknown

Webhook de estados
  sent/delivered/read/failed → evidencia monótona; la correlación opaca liga un unknown sin id
```

### 3.2 Cómo responde a cada punto de D1

| Elemento pedido | Mecanismo |
|---|---|
| Evidencia inmutable de cotización emitida | Recibo `succeeded` (ADR-020) + `action_artifacts` (inmutable, misma transacción) + `sales.quote_v2_issued` (Sales, inmutable) |
| Policy Engine | El efecto derivado `artifact_delivery` se evalúa en la decisión de la acción y se persiste con la política hasheada. Sin regla explícita ⇒ `deny` |
| Autorización de comunicación externa | La regla `derivedEffects` de la política. La puerta re-evalúa el kill switch, el rollout, el handoff, la ventana y el binding en cada claim |
| Transactional outbox | El artefacto + la decisión `allow`, escritos en la transacción del recibo, son el registro de outbox. El dueño de la entrega los consume (materialización idempotente) |
| Delivery lifecycle | Los estados de ADR-029, más fases dentro de `dispatching` |
| Trazabilidad del destinatario | Cadena completa (§3.4); el destinatario solo sale del binding por FK |
| Reconciliación y deduplicación | Clave lógica, `UNIQUE(channel, event_key)`, monotonía, callback opaco, operador para `unknown` |

### 3.3 Propiedad del estado

| Estado | Dueño | Escribe |
|---|---|---|
| Cotización, número, PDF, manifiesto | Quote V2 | Quote V2 |
| Evidencia de emisión Sales (`0007–0009`) | Sales | Handler de la capability |
| Recibo, artefacto, decisión derivada | Core (`task-runtime`) | `ActionRuntime` |
| Outbound documental, intentos, eventos | `@r4/live-ops` | `OutboundDeliveryRuntime` (y el operador por la API) |
| Bytes del PDF | Nadie en R4 | En memoria, durante un intento |
| Textos de caption y aviso | Sales (plantillas versionadas) | Dentro del descriptor, escritos con el recibo |

### 3.4 Trazabilidad reconstruible (sin chain-of-thought)

```text
task_inputs (confirmación) → action_proposals → policy_decisions + policy_derived_decisions
  → action_executions → action_execution_attempts → action_receipts → action_artifacts
  → outbound_messages (binding_id → recipient_ref) → outbound_delivery_attempts
    (fases: fetch, verificación, media_ref, send_started_at, provider_message_id)
  → outbound_delivery_events (sent/delivered/read/failed) → aviso de falla (notice_for)
```

## 4. WhatsApp Cloud API: verificación contra la documentación oficial (D4)

**Versión usada por R4:** `DEFAULT_GRAPH_VERSION = 'v25.0'`, configurable con `R4_WHATSAPP_GRAPH_VERSION` (`adapters/channels/whatsapp-cloud/src/config.ts:23,61-62`). Los ejemplos actuales de Meta usan `v25.0`.

| Tema | Lo que dice Meta (META-DOC, 2026-10-14) | Consecuencia para el diseño |
|---|---|---|
| MIME `application/pdf` | Tipo de documento soportado | Único tipo de esta versión |
| Tamaño máximo | PDF: **100 MB** | Límite efectivo `min(100 MB, 20 MiB de plataforma)` = 20 MiB, coherente con el contrato de lectura Quote V2. Se rechaza antes de llamar a Meta |
| Carga | `POST /{phone-number-id}/media`, multipart con `messaging_product=whatsapp`, `type=<MIME>` y `file`; responde `{id}` | Fase `upload` del adaptador; `FormData`/`Blob` nativos de Node, sin dependencias nuevas |
| Vigencia del id de medio | Los medios subidos persisten **30 días**; los ids devueltos por la API expiran a los 30 días. Una URL de descarga dura 5 minutos (no se usa) | El id solo se usa dentro de un intento. Cada intento nuevo vuelve a subir. Los huérfanos expiran solos |
| Reintentos de carga | Meta no documenta idempotencia ni deduplicación de cargas | Subir de nuevo es seguro porque un medio subido no es visible para nadie. Sí es una copia del PDF en Meta, igual que al enviarlo |
| `type: document` | `document: { id \| link, filename?, caption? }`. Se recomienda `id`; `link` necesita hosting público y se desaconseja | Solo `id`. `link` está prohibido por diseño |
| Filename y caption | `filename` con extensión (sin límite documentado); `caption` ≤ **1024** | Filename restringido por la plataforma (`^[A-Za-z0-9][A-Za-z0-9._-]{0,94}\.pdf$`); caption ≤ 1024 |
| Ventana de 24 h | El primer mensaje del usuario abre una ventana de 24 h y cada mensaje la renueva. Dentro se permite cualquier mensaje de servicio, **incluidos documentos**. Fuera, solo plantillas (error **131047**) | La puerta cancela `window_closed` antes de enviar; 131047 ⇒ `rejected/window_closed`. Sin plantillas |
| Respuesta del envío | "Esta respuesta solo indica que la API aceptó la solicitud… no indica la entrega" | `accepted` ≠ entregado (vocabulario §9.2) |
| TTL de entrega | Meta reintenta la entrega durante el período de validez del mensaje (por defecto 30 días) | Un `accepted` puede pasar a `delivered` mucho después |
| Estados del webhook | `sent`, `delivered`, `read`, `failed` (y `played`, solo audio). `read` puede llegar sin `delivered`. `errors` aparece solo en las fallas | Mapeo existente: `sent→accepted` (`inbound.ts:24`). La monotonía cubre `read` sin `delivered` |
| Errores | Llegan síncronos, por webhook **o por ambos**. Manejar por `code`, no por el estado HTTP | El adaptador clasifica por código; la evidencia asíncrona sigue la monotonía |
| Webhooks duplicados | Meta reintenta hasta 7 días; "los reintentos pueden producir notificaciones duplicadas" | `UNIQUE(channel, event_key)` (existente) |
| Idempotencia del envío | No documentada (la documentación no la menciona) | No se afirma exactamente una vez. `unknown` nunca se reenvía (ADR-029 §8) |
| `biz_opaque_callback_data` | Texto arbitrario (≤ 512) en mensajes libres desde 2023-11-14; se devuelve sin cambios en el objeto `statuses` del webhook | Correlación `r4o:<outboundId>:<attempt>` para ligar un `unknown` a su evidencia. Es evidencia positiva, nunca negativa |
| Errores relevantes | 131053: no se pudo subir el medio. 131026: no entregable. 130429: throughput. 131056: límite por par. 131000/1/2/131016: desconocido o temporal. 190: token vencido | Tabla de clasificación en §5.4 |

**Lo que la documentación no garantiza y se verifica con una sonda real (OD-9):**
- que un `failed` asíncrono traiga el dato opaco;
- el orden de llegada de los estados;
- el comportamiento con un PDF cercano a 20 MiB;
- que el nombre del archivo se muestre tal cual.

Fuentes:
- [Media reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)
- [Document messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/document-messages)
- [Send messages (customer service window)](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages)
- [Status webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)
- [Set up webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/)
- [Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
- [Changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)

## 5. Contratos y mapeo de Sales

### 5.1 Contratos genéricos (Core)

Están en ADR-038 §1, §2, §6 y §7:
- `derivedEffects` de la capability;
- descriptor `artifact` del `applied`;
- `derivedEffects` de la política, sin default;
- `DocumentSource`;
- contenido tipado del outbound;
- capacidad `documents` del adaptador.

Ninguno menciona cotizaciones.

### 5.2 Mapeo Sales (fuera de Core; versión provisional `quote.create@6`, ver OD-8)

| Campo del descriptor | Valor Sales |
|---|---|
| `source` | `'quote-v2'` (id que registra la composición Sales del gateway) |
| `ownerRef` | `quoteId` (UUID del owner) |
| `sha256`, `byteLength` | `document.pdfSha256` y `document.byteLength` del manifiesto (ya exigido por `settle`) |
| `integrity` | Resultado de la verificación de bytes en `settle`: `verified`; `unavailable` → `unverified`; `mismatch` |
| `filename` | `Cotizacion-<quoteNumber>.pdf` (p. ej. `Cotizacion-PC-000005.pdf`) |
| `caption` | Plantilla `r4-sales-issued-es-v1` (§9.1) |
| `failureNotice` | Plantilla `r4-sales-document-failed-es-v1` (§9.1) |

Reglas de la versión Sales:
- `quote.create@6` es `@5` (con la corrección de GAP-16) más `derivedEffects: [{ kind: 'artifact_delivery', target: 'origin_conversation' }]` y el descriptor.
- La semántica de emisión, la clave y la reconciliación no cambian.
- `@2–@5` y `classifySend` quedan intactos.
- La función de descriptor es nueva; no modifica `settle` compartido.

### 5.3 Fuente de documentos Sales `quote-v2`

Se compone **solo** en el gateway y usa el cliente HTTP existente con un token de solo lectura (§6.3).

1. `getQuote(ownerRef)` debe cumplir:
   - `status === 'issued'`;
   - `externalCorrelation.externalReference === taskId` (el de la obligación);
   - `document.available`;
   - `pdfSha256` y `byteLength` iguales a los esperados.

   Si no se cumple ⇒ `refused`, con el código `owner_state_not_issued`, `correspondence_mismatch` o `manifest_mismatch`.
2. `getDocument(ownerRef)` ⇒ `fetched {bytes, declaredSha256}`.

La fuente no verifica los bytes: lo hace la plataforma.

### 5.4 Clasificación del adaptador WhatsApp

| Fase | Respuesta | Resultado | Motivo |
|---|---|---|---|
| upload | 2xx con `id` | `uploaded` | — |
| upload | 2xx sin `id`, 5xx, timeout, cualquier error de red | `not_sent` | No visible: reintento seguro |
| upload | 429 | `not_sent` + `Retry-After` | — |
| upload | 400 (131053 u otro), 413 | `rejected` (`media_rejected`) | Configuración o contenido: definitivo |
| upload | 401/403 | `rejected` (`auth`/`permission`) | Definitivo |
| send | Clasificación del texto actual (`outbound.ts:14-30,44-89`) | `accepted` / `not_sent` / `rejected` / `unknown` | Sin cambio de semántica |
| send | 131047 | `rejected` (`window_closed`) | Existente |

## 6. Documento bajo demanda (D2)

### 6.1 Obtención

- La obtiene el gateway, en cada intento, mediante la `DocumentSource` registrada con el `source` del artefacto.
- Si la fuente no está registrada ⇒ **hold** `document_source_unavailable`. Sirve durante un rollback o una composición incompleta: el documento no se pierde y se ve en atención.

### 6.2 Verificación (plataforma, antes de cualquier byte hacia Meta)

| Control | Contra | Falla ⇒ |
|---|---|---|
| Quote ID y correspondencia con la task | Owner, por la fuente (§5.3) | `failed` `document_correspondence_mismatch`, 0 llamadas |
| Estado de emisión | Owner (`issued`) | `failed` `document_owner_state`, 0 llamadas |
| Manifiesto | Owner (`pdfSha256`, `byteLength`) = descriptor | `failed` `document_manifest_mismatch`, 0 llamadas |
| SHA-256 de los bytes | Descriptor | `failed` `document_integrity_mismatch`, 0 llamadas |
| Tamaño | Descriptor y `min(20 MiB, límite del adaptador)` | `failed` `document_too_large`, 0 llamadas |
| MIME | Cabecera `content-type` (cliente HTTP) y prefijo `%PDF-` | `failed` `document_integrity_mismatch`, 0 llamadas |
| Cabecera declarada del owner | Si existe, igual al descriptor | `failed` `document_integrity_mismatch`, 0 llamadas |
| Correspondencia con la emisión de esta tarea | `artifact.task_id` = `outbound.task_id` = `binding.task_id`, por FK y triggers; y `externalReference` en el owner | Irrepresentable; si el owner no coincide, `refused` |

### 6.3 Credenciales

| Opción | Evaluación |
|---|---|
| **(a) Principal Quote V2 de solo lectura** (`quotes:read`, `quotes:document:read`) para el gateway, p. ej. `r4-sales-document-reader`, con `R4_QUOTE_DOCUMENT_BEARER_TOKEN` | **Recomendada.** Mínimo privilegio. Quote V2 no cambia código: los scopes existen (contract freeze, notas R4 §6). Requiere aprovisionarlo el owner de Quote V2 (OD-2) |
| (b) Reusar el token de `r4-sales-integration` en el gateway | No recomendada: el gateway tendría `quotes:create` |
| (c) Que el worker obtenga los bytes y los deje en R4 | Rechazada por D2 |

En los tres casos, el adaptador WhatsApp **no** recibe credenciales de Quote V2:
- solo lee `R4_WHATSAPP_*`;
- recibe bytes ya verificados y nunca el cliente Quote.

Test de contrato: el paquete del adaptador no importa `adapters/domains` ni referencia `R4_QUOTE_`.

### 6.4 Memoria, streaming y tamaño

- El cliente Quote acumula la respuesta en un buffer (`arrayBuffer`, con tope de 20 MiB). La subida multipart usa un `Blob` en memoria.
- El dispatcher despacha de a uno. Pico de memoria ≈ 2 × 20 MiB por gateway. El PDF real observado pesa 29 605 bytes (PC-000005, EC2-DOC J3E-B).
- **Streaming evaluado y descartado.** Hashear mientras se sube pondría en los servidores de Meta bytes sin verificar, que podrían ser de otro documento. La invariante es "ningún byte sale de R4 sin verificar", y eso exige tener el buffer completo.
- **Higiene de los bytes:**
  - viven en el ámbito de la función de despacho;
  - no se pasan a loggers, telemetría ni errores;
  - los mensajes de error no reproducen cuerpos.

### 6.5 Fallos de lectura

| Respuesta del owner | Resultado de la fuente | Disposición |
|---|---|---|
| 5xx, red, timeout, cuerpo cortado (`quote_owner_connection_lost`) | `not_available` | `pending`: reintento dentro del plazo previo al envío |
| 404 / 409 `document_not_available` | `not_available` | Ídem. Una cotización emitida debería tener documento: si persiste hasta el plazo ⇒ `failed` + alerta |
| 401 / 403 | `refused` (`owner_unauthorized`) | `failed` + alerta (configuración) |
| `content-type` distinto o tamaño fuera de rango (contract_violation) | `refused` | `failed` `document_integrity_mismatch` |

**Plazo previo al envío:** las fallas antes del envío no consumen intentos de envío. Se reintentan con backoff ≤ 60 s hasta `R4_PROD_DOCUMENT_PRESEND_DEADLINE_MS` (default propuesto: 1 h), siempre con la ventana abierta. Es una perilla de calibración: una caída del owner dura minutos, no segundos, y el presupuesto actual del texto (3 intentos, ≈ 7 s) es demasiado corto para esto.

## 7. Mensajes posteriores del cliente y estado de la conversación (D3)

La puerta se evalúa en la transacción del claim, con la fila de la task bloqueada (mismo patrón que el texto). Regla general: **la emisión anterior sigue siendo válida; ningún mensaje desvía el documento a otra conversación.**

| # | Situación | Señal durable | Efecto en la puerta | Fundamento | Test |
|---|---|---|---|---|---|
| 1 | Mensaje nuevo sin efecto sobre la cotización | `task_inputs` nuevo | **Ninguno**: se despacha | D3. `superseded_by_newer_input` no aplica a `platform` | T-D3-1 |
| 2 | Solicitud explícita de cancelación ("no me lo mandes") | La plataforma no interpreta lenguaje. El agente no tiene capacidad para cancelar entregas (no elige documentos); puede pedir handoff | Con handoff ⇒ **hold** `human_owned`; el operador cancela o libera | El operador interviene antes de la ejecución. Límite honesto: solo surte efecto si llega antes del despacho (normalmente segundos después de emitir), y **no** cancela la cotización (R4 no tiene scope de cancelación) | T-D3-2 |
| 3 | Cambio de condiciones ("mejor dos racks") | Preview y emisión nuevos (ADR-034/035) | Ninguno sobre el documento anterior. La nueva cotización tiene su propio documento y su propia clave (otro `ownerRef`) | La emisión anterior sigue válida | T-D3-3 |
| 4 | Handoff a operador (pedido o activo) | `human_requests` handoff | **hold** `human_owned`. `manualReply` no cancela documentos | El operador decide: `POST /v1/outbound/:id/cancel` o `…/release`. Al liberar el handoff, la puerta se re-evalúa | T-D3-4 |
| 5 | Conversación cerrada | Binding `closed` | **cancel** `conversation_closed` | Nunca otra conversación. Si el cliente vuelve a escribir, se abre un binding nuevo con una task nueva | T-D3-5 |
| 6 | Cambio de binding o destinatario | Irrepresentable: FK al binding; identidad del binding inmutable (trigger); `task_id` igual (trigger) | Defensa en profundidad: **hold** `binding_mismatch` + alerta, nunca envío | Ningún mensaje puede desviar el documento | T-D3-6, T-LEAK |
| 7 | Kill switch activado | `autonomy_controls` (global o canal) | **hold** `autonomy_disabled`. Se despacha al reactivar, sin cancelar | Igual que el texto (ADR-029 §12) | T-D3-7 |
| 8 | Ventana de WhatsApp vencida | `now − last_inbound_at ≥ 24 h` | **cancel** `window_closed` + atención | Fuera de la ventana solo hay plantillas (fuera de alcance) | T-D3-8 |
| 9 | Task `cancelled` | Estado de la task o intención terminal | **cancel** `task_cancelled` | Intención explícita de cerrar | T-D3-9 |
| 10 | Task `failed` o run vencido, con el binding abierto | Estado de la task o del run | **Se despacha** (OD-5) | El documento pertenece a la emisión, no al run | T-D3-10, T-INT-9 |
| 11 | Task `completed` con el binding abierto | Estado de la task | Se despacha | Igual que el texto (`delivery.ts:93`) | T-D3-11 |
| 12 | El cliente repite "Sí, emítela." | Controles de ADR-034/035 (confirmación usada, snapshot autorizado) | No hay segunda cotización ni segundo documento. Clave lógica | — | T-D3-12 |

## 8. Atomicidad e idempotencia: los diez puntos de interrupción

**Clave lógica de entrega:** `r4-doc:` + `hex(sha256(binding_id ‖ 0x00 ‖ source ‖ 0x00 ‖ ownerRef))`. Para Sales, `ownerRef` es el Quote ID y `binding_id` es el binding original de la task emisora.

| # | Punto | Estado durable al morir | Qué hace R4 | Cliente | Test |
|---|---|---|---|---|---|
| 1 | Quote V2 emite y R4 pierde la respuesta | Intento sin outcome o `unknown`. Sin recibo ni artefacto | Reconciliación por clave (ADR-018; `@5` §14) ⇒ `applied` ⇒ recibo + artefacto en una transacción ⇒ materialización | 1 documento | T-INT-1 |
| 2 | R4 reconcilia una emisión ya aplicada | Ídem | Recibo `replayed`. Un artefacto por recibo; un recibo por ejecución | 1 documento | T-INT-2 |
| 3 | R4 confirma la emisión y el proceso termina antes de encolar | Recibo + artefacto + decisión `allow` **ya durables** (misma transacción) | El siguiente `tick` del gateway materializa. Si muere antes del commit del recibo, se está en el punto 1 | 1 documento | T-INT-3 |
| 4 | Descarga correcta; falla la subida a Meta | Intento con `document_verification = verified`, `media_outcome = not_sent` | `pending`; reintento (nueva descarga, verificación y subida) dentro del plazo previo al envío | 1 documento, o `failed` + aviso al vencer el plazo | T-INT-4 |
| 5 | Meta acepta la subida; falla el envío del mensaje | Intento con `media_ref` y `send_started_at` | Clasificación del envío: definitivamente no enviado ⇒ reintento; rechazo ⇒ `failed` + aviso; incierto ⇒ `unknown` | Nunca dos documentos | T-INT-5 |
| 6 | Meta acepta el mensaje y se pierde la respuesta HTTP | `send_started_at`, sin outcome ⇒ `unknown` | **Sin reenvío.** El webhook `sent`/`delivered` con el dato opaco liga el id ⇒ `accepted`/`delivered`. Sin evidencia ⇒ atención; el operador resuelve con evidencia | Posiblemente entregado; estado "no comprobado" | T-INT-6 |
| 7 | Llega un webhook de entrega duplicado | Evento con `event_key` existente | Ignorado (`UNIQUE`); monotonía | — | T-INT-7 |
| 8 | El worker o el gateway reinicia | Worker: ventanas de ADR-019. Gateway: fila `dispatching` con el lease vencido | Barrido: sin `send_started_at` ⇒ `pending`; con él ⇒ `unknown` | Nunca dos documentos | T-INT-8, T-REC-1/2 (SIGKILL) |
| 9 | El run original se agota | La obligación no depende del run | Si el recibo existe, el gateway entrega. Si la emisión seguía en curso, la reconciliación del worker escribe recibo + artefacto después | Documento y caption aunque el agente no haya respondido (mitiga ADR-037 L4) | T-INT-9 |
| 10 | La conversación cambia de estado con el documento pendiente | La puerta se evalúa en cada claim con la task bloqueada | Matriz §7. Nada se retracta después del despacho | Según §7 | T-D3-* |

**Garantía y límite:**
- Por construcción:
  - a lo sumo una obligación por clave lógica;
  - a lo sumo un envío sin evidencia de no-envío.
- No se afirma una entrega física exactamente una vez. Meta no documenta idempotencia. Ante un resultado incierto se conserva la evidencia (intentos, fases, eventos) y **se detienen los reintentos**.

## 9. Comunicación al cliente

### 9.1 Mensajes deterministas

Son plantillas Sales, versionadas y con golden. El texto exacto lo decide el owner (OD-6).

**Caption** (`r4-sales-issued-es-v1`). Viaja con el PDF, así que es verdadero por construcción cuando el cliente lo ve:

```text
Cotización PC-000005 emitida.
Total: $52.980 (IVA incluido).
Válida hasta el 18/10/2026.
Este es el documento oficial.
```

Reglas de la plantilla:
- usa solo valores del resultado de la emisión, que vienen del owner: número, total, `validThroughLocalDate`;
- no hace aritmética;
- no lleva `*`, `_` ni `~`;
- mide ≤ 1024 caracteres.

**Aviso de falla** (`r4-sales-document-failed-es-v1`). Solo cuando el documento queda `failed`, por cualquier camino:

```text
No pudimos enviarte por este medio el documento de la cotización PC-000005. Lo estamos revisando.
```

Es neutral a propósito:
- no afirma la emisión (la fuente pudo rechazar por estado);
- no repite cifras;
- no promete un operador (GAP-10).

**Sin mensaje automático** para `accepted`, `delivered`, `read`, `unknown` ni `cancelled`. WhatsApp ya muestra al cliente el envío y la lectura. Un aviso en `unknown` podría contradecir un documento que sí llegó.

### 9.2 Vocabulario de estados

| Estado de entrega | Etiqueta para el agente | Puede decir | No puede decir | Mensaje de plataforma |
|---|---|---|---|---|
| (recibo, `artifact.delivery = permitted`) | Emitida; entrega automática del documento permitida | "Emití tu cotización; el documento oficial llega en este chat" | Cifras (instrucción v8); "ya te lo envié" | — |
| `pending` (incluidos los holds) | Pendiente de envío | "Está pendiente de envío" | "Enviado", "entregado" | — |
| `accepted` | Enviado; WhatsApp no confirma la entrega | "Lo enviamos; aún sin confirmación de entrega" | "Te llegó", "entregado" | — |
| `delivered` / `read` | Entregado según WhatsApp | "WhatsApp confirma la entrega" | — | — |
| `failed` | No se pudo enviar | "No pudimos enviarlo por este medio" | "Enviado" | Aviso de falla |
| `unknown` | Envío no comprobado | "No puedo confirmar si se envió; lo estamos revisando" | "Enviado", "no enviado" | — (atención) |
| `cancelled` | No se enviará (motivo) | Según el motivo | "Enviado" | — |

- El agente recibe esto por `DeliveryStateContextSource`, extendida a los documentos, con todos sus estados y el `filename`.
- Nunca recibe bytes, `media_ref` ni el destinatario.
- Lo que el agente dice sigue siendo texto libre (ADR-031, R4-J1E-R2.2). Su fidelidad al estado se mide post-hoc (§11.4).

### 9.3 GAP-03 (mensaje de emisión redactado por el modelo)

| Alternativa | Evaluación |
|---|---|
| B2: el agente copia un `issuedMessage` renderizado | La copia no puede verificarse después de emitir sin un juez síncrono sobre `respond`, prohibido por ADR-031 R2.2. **Rechazada** |
| **Caption determinista con el documento** + instrucción v8 de no repetir cifras + métrica post-hoc | El mensaje de emisión con autoridad lo envía la plataforma con texto del pack. **Elegida** |
| T4: la plataforma cierra el turno tras el recibo con un `respond` de plataforma (`0010` ya lo admite) | Determinista también para el texto, pero cambia el kernel y quita el turno al agente. **Escalamiento** solo si la métrica muestra cifras mal copiadas (OD-10) |

### 9.4 Acuse durable de "emisión pendiente" (GAP-16, ADR-037 L3)

**Situación actual:**
- Con `@5`, una emisión autorizada cuyo owner no está disponible queda `unknown`, retenida en su clave.
- `action_retry` libera la task tras el backoff. Mientras tanto, el step `pending` bloquea al kernel (ADR-019).
- Resultado: silencio de ≈ 5 min en una caída breve (J3E-C1 aceptación §14.3), o hasta que la task quede `blocked`.

**Qué exigiría un acuse correcto:**
1. emitirlo sin el modelo, mientras el run está diferido o suspendido;
2. a lo sumo una vez por ejecución;
3. no afirmar emisión ni pedir confirmación;
4. un texto declarado por la capability;
5. un segundo aviso si la ejecución termina `failed/write_not_applied` (ADR-037 L2).

**Determinación: exige un slice separado del ciclo de vida de acciones, con ADR propio** (provisional: ADR-039, "Avisos durables de progreso de una escritura autorizada"). Motivos:
- El disparador es una transición del ciclo de vida de acciones (primer `unknown` de un comando autorizado con reintento diferido, o `needs_reconciliation`). ADR-019 mantiene deliberadamente lo desconocido invisible. Cambiarlo es una decisión de ese ciclo, no de la entrega.
- "Retenida" frente a "incierta" solo lo distingue el pack (fila de envío Sales, ADR-037 R4). Core solo ve `unknown`.
- Aparece semántica nueva para el cliente: retención → éxito, retención → no aplicada.

**Reutilización:** el slice reutilizaría lo que J3F-A deja: el origen `platform` del outbound, la puerta y el vocabulario. Solo agregaría una procedencia (`execution_id`) y su disparador.

**Clasificación propuesta:** **J7-PRODUCTION-GATE**, junto con ADR-037 L3; no es un bloqueo de J3. GAP-16 está corregido y J3F entrega el caption de emisión aun cuando el run ya terminó. El owner puede promoverlo a J3 (OD-7). **No se implementa dentro de J3F.**

## 10. Matriz de riesgos y garantías

| ID | Riesgo | Mecanismo | Garantía | Lo que **no** se garantiza | Verificación |
|---|---|---|---|---|---|
| G1 | PDF a otra conversación | Binding por FK desde el `task_id` del recibo; identidad del binding inmutable; `task_id` igual (triggers); puerta; correspondencia en el owner; el modelo no aporta nada | 0 envíos a un binding distinto del de la task emisora | Si el binding se abrió con un número equivocado: es autenticidad del ingress (firma, ADR-029) y no se rediseña aquí | T-LEAK + mutaciones M1–M3 |
| G2 | PDF equivocado o corrupto | Manifiesto, SHA-256, longitud, `%PDF-`, cabecera y correspondencia, antes de salir | 0 bytes sin verificar al proveedor | Un owner que sirve, para la cotización correcta, un PDF erróneo pero coherente con su propio manifiesto (verdad del owner) | T-VER-* + M4 |
| G3 | Documento duplicado | Clave lógica; reintento solo de "no enviado"; `unknown` sin reenvío; la subida es reintentable | 0 duplicados por decisión automática de R4 | La redistribución interna de Meta (TTL) | T-INT-4/5/6/8 + M5 |
| G4 | Obligación perdida tras emitir | Artefacto en la transacción del recibo; materialización idempotente | Todo recibo con artefacto permitido y binding produce exactamente una obligación mientras el gateway corra | Si el gateway está detenido, la obligación espera (no se pierde) | T-INT-3, T-MAT-* |
| G5 | "Entregado" falso | Los textos de plataforma no afirman entrega; vocabulario fijo; `accepted` ≠ `delivered` | 0 afirmaciones falsas en textos de plataforma | El texto libre del agente (modelo) | Golden + métrica §11.4 |
| G6 | Falla silenciosa | `failed` ⇒ aviso + atención; `unknown` ⇒ atención | Ningún `failed` sin aviso ni registro | Las alertas activas son J7 (GAP-11) | T-NOT-* |
| G7 | Bytes del PDF en logs, prompts, BD o trazas | Sin persistencia; solo en memoria; telemetría sin contenido | 0 bytes fuera del intento | — | Barrido T-PRIV |
| G8 | Exposición de credenciales | Token Quote solo en la fuente; principal de solo lectura | El adaptador no ve credenciales del owner | Depende de OD-2 | Contract C-ISO |
| G9 | Deriva de límites o versión de Meta | Constantes con fuente; mínimo de límites; sonda | Rechazo previo en vez de una falla en el proveedor | Cambios de Meta no anunciados | Sonda OD-9 |
| G10 | Ventana vencida | Puerta ⇒ `window_closed`; 131047 | Ningún intento fuera de la ventana | Que el cliente reciba el documento: sin plantillas, lo maneja un operador fuera de banda (J7) | T-D3-8 |
| G11 | Documento tardío tras una retención larga | La fuente exige `issued` | No se entrega una cotización vencida o cancelada | — | T-VER-state |
| G12 | Gateway muerto a mitad de una fase | Fases registradas; barrido por `send_started_at` | Antes del envío ⇒ reintento; después ⇒ `unknown` | — | T-REC-1/2 |
| G13 | Cambio de hash de políticas existentes | Campo opcional sin default | Hashes fijados idénticos | — | C-HASH |
| G14 | Rollback con documentos pendientes | Runbook de drenaje; hold `document_source_unavailable` | Ningún documento enviado como texto vacío | Requiere ejecutar el runbook | T-RB, runbook |
| G15 | Holds o `unknown` sin operadores | Atención | Nada se envía ni se reintenta a ciegas | Que alguien atienda (GAP-10, J7) | — |
| G16 | Webhook falsificado con dato opaco | Firma HMAC existente; solo liga filas `dispatching`/`unknown` del mismo canal y el mismo intento | Sin firma, no hay efecto | — | T-INT-6b |
| G17 | Exposición a otros agentes | Opt-in por capability y política | Sin cambios de comportamiento sin declaración | — | Regresión completa + C-HASH |

## 11. Tests y evaluación

Los identificadores son los que usa el plan.

### 11.1 Unit

- **T-POL:**
  - política sin `derivedEffects` ⇒ sin evaluación derivada;
  - con `allow`, `deny` o ausente;
  - `require_approval` rechazado por el esquema;
  - acción no `allow` ⇒ sin derivada.
- **C-HASH:** hashes fijados de `DEFAULT_ACTION_POLICY`, `SALES_PRODUCTION_ACTION_POLICY` y `sales-production-autonomous-policy@1` idénticos.
- **T-GATE:** tabla completa de §7 para `platform`. Las filas `agent` y `operator` no cambian.
- **T-DISP:** disposición por fase. Pre-envío dentro y fuera del plazo; envío por cada resultado; barrido con y sin `send_started_at`.
- **T-VER:** discrepancias de SHA, longitud, `%PDF-`, cabecera, tamaño y estado del owner.
- **T-WA:**
  - forma multipart de la subida;
  - cuerpo `type: document` con `{id, filename, caption}` y el dato opaco;
  - clasificación §5.4;
  - el token, el destinatario y los bytes nunca aparecen en errores ni en logs.
- **T-TPL:** golden del caption y del aviso. Límite de 1024; nombre de archivo válido.

### 11.2 Contract

- **C-CORE:** `packages/*` no menciona cotizaciones ni importa dominios.
- **C-ISO:** el adaptador WhatsApp no importa `adapters/domains` ni lee `R4_QUOTE_*`.
- **C-PROTO:** el protocolo de decisión no cambia (sin destinatario ni documento).
- **C-FP:** huellas de `quote.create@2–@5`, perfiles `@1–@7` y definiciones `@1–@7` sin cambio.
- **C-SALES:** Sales no envía nada y no importa el canal.

### 11.3 Integración (PostgreSQL), recuperación y E2E

- **T-INT-1…10:** los diez puntos de §8.
- **T-MAT:**
  - materialización concurrente (N ticks paralelos ⇒ 1 fila);
  - dos recibos con el mismo `ownerRef` y binding ⇒ 1 fila;
  - task sin binding ⇒ 0 filas (y el contexto no muestra ninguna entrega).
- **T-D3-1…12:** §7.
- **T-NOT:** aviso creado en la misma transacción que `failed`, por cada camino. La puerta se aplica al aviso.
- **T-LEAK (obligatorio):** dos conversaciones concurrentes, cada una con su cotización. Cada PDF (SHA) va solo al `recipient_ref` de su binding; 0 cruces.
  - Mutaciones que deben hacerlo fallar:
    - **M1:** materializar por "último binding abierto" en vez de por task.
    - **M2:** quitar la verificación de correspondencia.
    - **M3:** quitar el trigger de `task_id`.
- **Mutaciones adicionales:**
  - **M4:** quitar la verificación de SHA ⇒ falla T-VER.
  - **M5:** reintentar un `unknown` ⇒ falla T-INT-6.
  - **M6:** que un input nuevo cancele ⇒ falla T-D3-1.
- **T-REC-1/2:** SIGKILL real del gateway durante la subida (⇒ 1 documento) y después de `send_started_at` (⇒ `unknown`, 0 reenvíos).
- **T-PRIV:** se recorren los logs capturados, la telemetría, `observations`, `context_snapshot_items` y todas las columnas de texto y jsonb buscando `%PDF-` y fragmentos base64 del PDF de prueba ⇒ 0 coincidencias.
- **T-E2E:** canal sintético, owner Quote fixture y un adaptador de captura que registra el SHA, la longitud, el nombre y el destinatario del documento, **nunca los bytes**. Emisión ⇒ 1 documento capturado con SHA = manifiesto y destinatario = binding.

### 11.4 Evaluación (con el modelo real; umbrales congelados antes de correr)

- `issuance_figure_mismatch`: cifras del texto del agente posterior a la emisión distintas del recibo. Umbral propuesto: 0 en N conversaciones.
- `false_delivery_claim`: el agente afirma "entregado" con un estado inferior. Umbral propuesto: 0.
- `document_delivery_rate`: emisiones con documento capturado.
- `latency_issue_to_document`: tiempo entre la emisión y el documento.

Herramienta: `scripts/experiments/j3f-document-delivery/` (mismo patrón que `j3-acceptance`).

## 12. Criterios de aceptación funcional

Nivel de evidencia: LOCAL, REAL-MODEL (owners fixture), EC2 (owners reales, canal sintético) y WHATSAPP-REAL (J7).

| ID | Criterio | Nivel mínimo para J3 |
|---|---|---|
| AC-1 | Tras una emisión confirmada existe exactamente una obligación documental por (binding, cotización). Entre el recibo y la obligación hay 0 llamadas al modelo (trayectoria) | LOCAL + EC2 |
| AC-2 | Documento capturado: SHA-256 = manifiesto = artefacto; longitud igual; `application/pdf`; nombre `Cotizacion-PC-…pdf`; destinatario = `recipient_ref` del binding | LOCAL + EC2 |
| AC-3 | Repetir la confirmación, replay, reconciliación y webhooks duplicados dejan 1 obligación y ≤ 1 llamada de envío al proveedor | LOCAL |
| AC-4 | Discrepancia de integridad, manifiesto o correspondencia ⇒ 0 llamadas al proveedor, `failed`, aviso determinista y atención | LOCAL |
| AC-5 | No filtración: dos conversaciones concurrentes, cada PDF solo a la suya. Las mutaciones M1–M3 lo detectan | LOCAL |
| AC-6 | Los 12 casos de §7 se comportan como la tabla | LOCAL |
| AC-7 | Los 10 puntos de §8 tienen test. 0 reenvíos tras `unknown`. SIGKILL real del gateway sin duplicado | LOCAL |
| AC-8 | El caption y el aviso coinciden con su golden. Ningún texto de plataforma afirma entrega | LOCAL |
| AC-9 | Con el modelo real: `issuance_figure_mismatch = 0` y `false_delivery_claim = 0` en N conversaciones (N y umbrales congelados antes de correr); el agente no dice "no puedo enviarte el documento" | REAL-MODEL |
| AC-10 | 0 bytes de PDF en logs, telemetría, observations, snapshots ni tablas (T-PRIV). Sin almacenamiento de PDFs | LOCAL |
| AC-11 | Compatibilidad: huellas y hashes fijados idénticos; regresión completa en verde (unit, contract, integration, sales, shadow, recovery, salvo el preexistente GAP-15) | LOCAL |
| AC-12 | Canary EC2 aislado: 1 cotización real de Quote V2 ⇒ 1 documento capturado y verificado contra el manifiesto real. Producción sin cambios | EC2 |
| AC-13 (J7) | Número dedicado de WhatsApp: estado `delivered` del proveedor para el documento | WHATSAPP-REAL |

## 13. Bloqueos J3 y gates J7

> **Superado por la decisión del owner del 2026-10-14.** J3 se re-delimita como *Quote Integration & Autonomous Issuance* y excluye explícitamente la entrega del PDF. GAP-01 pasa a `DEFERRED_TO_R4_MEDIA`: deja de ser bloqueo de J3, pero sigue siendo requisito verificable antes de cualquier rollout comercial que prometa PDFs al cliente. La tabla de abajo es la clasificación propuesta antes de esa decisión y se conserva como historia.

| Punto | Clase | Lo cierra |
|---|---|---|
| GAP-01: el cliente no recibe el PDF | **J3-FUNCTIONAL-BLOCKER** | J3F (AC-1…AC-12) |
| GAP-03: mensaje de emisión del modelo | **J3-FUNCTIONAL** | J3F: caption determinista (§9.3), AC-8, AC-9 |
| GAP-02: canary de `@7` contra owners reales | J3-FUNCTIONAL-BLOCKER (fuera de J3F) | Antes de J3F-C; es prerrequisito, porque J3F parte de `quote.create@5` validado |
| Merge de J3E-C1 (`@5`, `@7`, ADR-036/037) | Prerrequisito de J3F-C | Revisión del owner |
| Sonda real de Meta (subida y documento a un número interno) | Recomendada en J3F-D con autorización; **obligatoria antes de J7** | OD-9 |
| Activación en el número dedicado: `delivered` real (GAP-14 extendido) | **J7-PRODUCTION-GATE** | AC-13 |
| Operadores para documentos retenidos, `unknown` o `failed` (GAP-10) | J7-PRODUCTION-GATE | OIDC real y tiempo de atención |
| Alertas: `document_*_mismatch`, `unknown`, `failed`, `binding_mismatch` (GAP-11) | J7-PRODUCTION-GATE | Observabilidad J7 |
| Runbook de rollback con drenaje de documentos (GAP-09) | J7-PRODUCTION-GATE | Runbook ensayado |
| Acuse de emisión pendiente (ADR-037 L3; §9.4) | J7-PRODUCTION-GATE (propuesto; OD-7) | Slice y ADR propios |
| Reenvío de un documento por un operador | J7 / FUTURE | ADR-038 §10 |
| Principal Quote V2 de solo lectura en producción | J7-PRODUCTION-GATE (en canary, J3F-D) | Owner de Quote V2 (OD-2) |
| Política Sales con `derivedEffects` aprobada para clientes reales | J7-PRODUCTION-GATE | Owner |
| Plantillas fuera de la ventana, email | FUTURE-ENHANCEMENT | — |

**J3 pasa a CLOSED cuando:**
- GAP-02 está cerrado (canary de `@7`);
- J3F cumple AC-1…AC-12;
- la aceptación J3 se actualiza en J3F-D.

J7 empieza recién después.

## 14. Rollout, operación y rollback

1. **J3F-A y J3F-B fusionados, inertes.**
   - Ninguna capability declara el efecto.
   - Regresión completa: 0 cambios de comportamiento; las huellas son idénticas.
2. **Migración `0011`** en la base aislada del canary. Es aditiva y hacia adelante; la producción no la recibe hasta J7.
3. **Perfil Sales nuevo** (`sales-production@8`, provisional) en el canary, con:
   - canal sintético y captura de documentos;
   - fuente `quote-v2` con el principal de solo lectura.
4. **Canary EC2 aislado** con Quote V2 real (AC-12).
5. **J7:** número dedicado, allowlist de una clave interna, sonda previa y alertas.

**Operación:**
- Atención lista los documentos en hold (`human_owned`, `binding_mismatch`, `document_source_unavailable`), `unknown` y `failed`.
- El operador puede cancelar, liberar (`release`) o resolver un `unknown` con evidencia.

**Desactivación inmediata:**
- El kill switch del canal o el global retiene los documentos pendientes.
- Volver al perfil `@7` deja de crear obligaciones. Las ya materializadas siguen su curso si la fuente sigue compuesta.

**Rollback del código del gateway por debajo de J3F-B:**
1. kill switch;
2. `SELECT count(*) FROM outbound_messages WHERE origin = 'platform' AND status IN ('pending','dispatching')` debe ser 0 (cancelar o dejar terminar);
3. desplegar.

La migración no se revierte.

## 15. Decisiones pendientes del owner

| ID | Decisión | Recomendación |
|---|---|---|
| OD-1 | Efectos derivados `allow \| deny` en la Policy Engine, con default `deny`; aprobación de entregas diferida | Aceptar |
| OD-2 | Credencial del gateway para Quote V2 | Principal nuevo de solo lectura (`quotes:read`, `quotes:document:read`) |
| OD-3 | Dato opaco de callback también para el texto | Sí: resuelve `unknown` del texto con evidencia, de forma aditiva. Alternativa: solo documentos en J3F |
| OD-4 | Handoff: retener el documento o enviarlo igual | Retener (`human_owned`); el operador decide |
| OD-5 | Task `failed` con el binding abierto: entregar o retener | Entregar (la emisión es válida) |
| OD-6 | Texto del caption y del aviso | Los de §9.1 como punto de partida |
| OD-7 | Acuse de emisión pendiente: J3 o J7 | J7, con slice y ADR-039 propios |
| OD-8 | Numeración: ADR-036 D4 reservó `quote.create@6` para la procedencia contractual | J3F toma el siguiente número libre al implementar y se actualiza la referencia de ADR-036 (o al revés, según qué se fusione primero) |
| OD-9 | Sonda real de Meta en J3F-D | Sí, con autorización explícita: 1 subida y 1 documento sintético a un número interno; nunca a clientes |
| OD-10 | Residuo de GAP-03 (texto libre del agente) | Aceptar caption + instrucción + métrica. T4 solo si la métrica falla |

## 16. Revisión de datos sensibles

Este documento, ADR-038 y el plan **no contienen**:
- tokens ni secretos;
- números de teléfono, wa_id ni identificadores de cuenta;
- hosts o rutas de servidores;
- datos de clientes.

Los ejemplos usan la cotización sintética PC-000005 del despliegue de integración, ya publicada en la aceptación J3, y textos ilustrativos. Las URLs son documentación pública de Meta. **No se publicaron** (sin push) hasta la revisión del owner.
