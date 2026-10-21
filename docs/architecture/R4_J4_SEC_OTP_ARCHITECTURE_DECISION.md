# R4-J4-SEC-OTP — Decisión de arquitectura: captura y confirmación segura del OTP

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-DESIGN-01` |
| Fecha | 2026-10-21 |
| Para | Owner de R4, owner de la CIA, owner de datos |
| Naturaleza | **Investigación, diseño y decisiones.** Ningún cambio en código ejecutable, migraciones, workers, webhook, harness, CIA ni CP. Sin despliegue |
| Estado | **Propuesta.** Requiere las aprobaciones del §11 antes de cualquier implementación |
| Documentos hermanos | `R4_J4_SEC_OTP_THREAT_MODEL.md` · `R4_J4_SEC_OTP_IMPLEMENTATION_PLAN.md` · `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` |
| Fuentes normativas | Contrato CIA `v1-d2` §3, §4.1, §5, §9 y §10 (CIA `7525395`) · ADR-039 · `R4_J4_R3_SEC_OTP_FOLLOWUP.md` · `R4_J4_R3_OWNER_MERGE_REPORT.md` |

```text
SEC_OTP_ARCHITECTURE_DESIGNED
SEC_OTP_01_IMPLEMENTATION_PENDING
SEC_OTP_02_IMPLEMENTATION_PENDING
R4_RR1_CONCURRENCY_RISK_ASSESSED
R4_HARNESS_UNCHANGED
R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

---

## 0. Resumen

**Alternativa recomendada: A, intercepción pre-persistencia en la infraestructura de canal con confirmación diferida.** Tiene cuatro partes:
- un puerto genérico de inspección en `ChannelIngress`, entre la canonicalización y `recordInbound`;
- un registro de expectativas de verificación sin secretos;
- un almacén efímero del código, cifrado con AES-256-GCM;
- un despachador de confirmación que corre en el proceso `channel-gateway`, el único que guarda la credencial `identity.verification.confirm` y la clave de cifrado.

**Por qué A:**
- Es el **único punto del código actual** donde el texto de un mensaje está autenticado y todavía no se ha persistido (`ingress.ts:111`→`:140`).
- Ahí ya existen la autenticación HMAC, la deduplicación durable `(channel, provider_event_id)` y la clave de conversación.
- La confirmación diferida **cumple literalmente** el invariante R4-I: dentro de la petición no se llama a ningún owner de dominio.
- El kernel, `task-runtime`, `capability-runtime`, `context-compiler`, `model-gateway` y `policy-engine` **no cambian**.

**Condición que este mandato no puede resolver: DEP-11.** El owner debe confirmar que `packages/live-ops` y `apps/channel-gateway` son infraestructura de canal y no harness (§10).
- Si el owner considera la ingesta parte del harness, A queda bloqueada y la alternativa es B. Este documento describe B con sus costos, sin implementarla.

**C (WhatsApp Flows) no sustituye a A ni a B.** El cliente puede escribir el código en el chat de todas formas, así que el tratamiento de SEC-OTP-02 sigue siendo obligatorio. Queda como mejora opcional posterior, solo para WhatsApp, que reutiliza el almacén y el despachador de A.

---

## 1. Baseline verificado

| Repositorio | Mandato | Verificado (2026-10-21) | Nota |
|---|---|---|---|
| R4 | `origin/main @ ad2c39b`, PR #13 pendiente | `origin/main @ 6c16999` | **Deriva documental.** El PR #13 ya está fusionado. `git diff ad2c39b 6c16999` = solo `R4_J4_R3_OWNER_MERGE_REPORT.md` (+165). Este diseño parte de `6c16999` (rama `docs/r4-j4-sec-otp-design`) |
| CIA | `main @ 7525395` | `origin/main @ 7525395` | Sin cambios. Contrato `v1-d2` aceptado solo para interoperabilidad sintética (`V1_D2_ACCEPTANCE.md` §2) |
| CP | `main @ bbd766e` | `origin/main @ bbd766e` | Sin cambios. S5 integrado, no desplegado |

**Puntos inspeccionados:**
- **Webhook y canal:**
  - `apps/channel-gateway/src/platform.ts` (Fastify, cuerpo crudo, `disableRequestLogging`, error handler);
  - `adapters/channels/whatsapp-cloud/src/inbound.ts` (HMAC `x-hub-signature-256`, `parse`);
  - `packages/live-ops/src/{ingress,channel,ports,autonomy,outbound,delivery}.ts`.
- **Persistencia y harness:**
  - `packages/persistence-postgres/src/production-store.ts` y las migraciones `0003`, `0005` y `0007`;
  - `packages/task-runtime/src/temporal-runtime.ts` (`#submitInputWithin`);
  - `apps/worker`, `apps/scheduler`.
- **Capacidades y adaptadores:**
  - `agents/sales/src/capabilities/customer-v2.ts`;
  - `adapters/domains/identity/http`.
- **Prueba de frontera:** `tests/contract/live-ops-boundaries.test.ts`.
- **Revisión previa no fusionada:** `R4_J4_R3_CIA_OMNICHANNEL_DESIGN_REVIEW.md`, rama `docs/r4-j4-r3-cia-discovery`. Este documento retoma sus opciones O1, O2 y O3 como A, B y C, y corrige O1, que llamaba a la CIA de forma síncrona.

---

## 2. Hechos del código que condicionan el diseño

| # | Hecho | Evidencia | Consecuencia |
|---|---|---|---|
| H1 | El texto se persiste por primera vez en `recordInbound`, **antes** de buscar el binding | `ingress.ts:136-155` | Cualquier inspección debe ocurrir entre `canonicalInboundSchema.parse` (`:137`) y `:140` |
| H2 | `conversationKey` ya está calculada en `:138` (HMAC de `channel‖accountRef‖conversationRef`) | `rollout.ts:14-16` | La expectativa puede buscarse por `(channel, conversationKey)` sin persistir nada |
| H3 | El texto sobrevive en hashes permanentes: `inbound_events.content_sha256` (queda tras `settleInbound`) y `task_inputs.request_hash` (inmutable, incluye el texto) | `ingress.ts:147`; `temporal-runtime.ts:388,408`; `0005:158` | **Un hash de 6 dígitos se invierte por fuerza bruta (10⁶).** La redacción debe ocurrir **antes de calcular cualquier hash**, no solo antes de guardar el texto |
| H4 | El texto entra para siempre en `memory_entries` (append-only, sin borrado), en `context_snapshots.compiled_context` (inmutable) y en `/v1/tasks/:id/thread` | `temporal-runtime.ts:404-407`; `0003:11-53,71`; `production-store.ts:552` | No existe "borrar después": solo sirve no escribir |
| H5 | El webhook responde 200 solo cuando todo es durable; 500 ante fallo de infraestructura, y Meta reintenta (seguro por la deduplicación) | `ingress.ts:95-133`; `platform.ts:117-122` | La captura del código y su registro cifrado deben ser durables antes del 200, y deduplicables |
| H6 | No hay cifrado en reposo, KMS ni rotación en el repositorio. "Memory has no encryption: SECRET is not storable" | `0003:21`; `contracts/src/memory.ts:52` | El almacén cifrado es un primitivo **nuevo**, acotado a este uso |
| H7 | `live-ops` no puede nombrar canales (`whatsapp`, `wamid`, `meta`). Solo `production-store.ts` puede insertar en `inbound_events`. El Core no importa `live-ops` | `tests/contract/live-ops-boundaries.test.ts:39-47,66-69` | El puerto de inspección es genérico. La SQL nueva vive en `production-store.ts` o en un store hermano de `persistence-postgres` |
| H8 | `apps/channel-gateway` construye `PostgresProductionStore` y `ChannelIngress` por sí mismo. `GatewayOverrides` solo admite logger, reloj e ids | `platform.ts:27-40,94,104-106` | Hoy **no hay punto de extensión**. A requiere editar `live-ops` (opción nueva de `ChannelIngressOptions`) y `channel-gateway` (composición) |
| H9 | `InboundChannelAdapter.parse` es síncrono y no tiene acceso a la base | `channel.ts:63-71` | Un decorador del adaptador no puede consultar expectativas: descartado como punto de inspección |
| H10 | El despachador de salida (`outbound.ts`, `production-store.ts:221-455`) ya implementa reclamo `for update skip locked`, lease con `generation`, intento registrado antes de la llamada, backoff y barrido. Corre **dentro del gateway** (`R4_GATEWAY_DISPATCH`) | `delivery.ts:141`; `config.ts:13` | Patrón reutilizable para el despachador de confirmación, en el mismo proceso |
| H11 | `temporal.submitInput` acepta una entrada con `sourceRef` y `externalKey` arbitrarios (idempotente por `(task, sourceRef, externalKey)`) y despierta la tarea en `WAIT_FOR_INPUT` | `temporal-runtime.ts:346,383-416`; `contracts/src/temporal.ts:93` | La reanudación con un marcador de plataforma **no requiere cambiar el harness** |
| H12 | `memory_entries.content.actor.role` es siempre `participant` | `temporal-runtime.ts:405` | Un marcador de plataforma se verá como texto del participante. Ver §6.4: el marcador **no otorga autoridad** |
| H13 | La CIA asigna el `start` a la credencial **agent** y el `confirm` **solo** a la de channel-integration. La configuración impide mezclarlas. Ambas deben compartir el mismo `consumerId` | Contrato §5, SR-03; CIA `src/config.ts`; `verification.ts #sameContext` | Dos credenciales, un consumidor `r4-sales`. **Inconsistencia**: el ejemplo del contrato §2 sugiere dos consumidores (§11, OA-06) |
| H14 | La CIA no limita `resolve` por `sessionRef`: otra `sessionRef` del mismo sujeto reutiliza vínculo y prueba | CIA `CIA_S3_IDENTITY_RESOLUTION_REPORT.md:99` | La CIA no protege contra RR-1. La revalidación es responsabilidad de R4 |
| H15 | Solo los mensajes `text` llegan como texto. Los demás tipos (imagen, interactivo, botón…) llegan como `[unsupported inbound content: <tipo>]`, y los perfiles v2–v7 aplican `handoff` | `inbound.ts:102-119`; `profile-v6.ts:29` | Una foto del correo con el código no expone el código a R4. C exigiría soportar `interactive/nfm_reply` |

---

## 3. Alternativas evaluadas

### 3.1 A — Intercepción pre-persistencia en la infraestructura de canal, con confirmación diferida

**Flujo:**
1. `ChannelIngress.ingest` canonicaliza y calcula `conversationKey`.
2. Llama a un **`InboundContentInspector`** opcional.
   - Sin expectativa activa para `(channel, conversationKey)`, devuelve el evento intacto (camino actual, una lectura indexada).
   - Con expectativa activa, devuelve el texto **redactado** y, si hay exactamente un candidato normalizable, un **código capturado**.
3. La ingesta persiste en **una transacción**:
   - la fila de `inbound_events` con el texto redactado;
   - la fila cifrada de `verification_responses`.
4. Sigue el camino ordinario con el texto redactado y responde 200.
5. Fuera de la petición, el `VerificationConfirmDispatcher` del gateway descifra, llama a `confirm`, registra el resultado, borra el cifrado y reanuda la tarea con un marcador sin código.

### 3.2 B — Relay externo de verificación

Un servicio delante del webhook recibe todo el tráfico del número (override del webhook por número, DEP-13). Detecta el código, lo confirma ante la CIA y reenvía el resto a R4.

**Hallazgos sobre B:**
- **Autenticación.** El relay debe custodiar el `appSecret` de Meta para verificar la firma. Para entregar a R4 un lote del que quitó un mensaje tiene tres opciones, y todas tienen costo:
  - (i) reenviar el cuerpo original firmado: no puede quitar el OTP;
  - (ii) volver a firmar con el `appSecret`: R4 deja de distinguir entre Meta y el relay, y la confianza pasa al relay;
  - (iii) usar una ruta nueva autenticada relay→R4: es un cambio en la ingesta de R4, justo lo que B pretendía evitar.
- **Estado.** El relay necesita la expectativa activa. La crea el `start`, que necesita la `sessionRef` (= `bindingId`, interna de R4).
  - O bien R4 llama al relay al iniciar (integración saliente nueva), o bien el relay lee la base de R4 (viola la frontera).
- **Reanudación.** La tarea de R4 debe enterarse del resultado: hace falta una ruta autenticada de reanudación en R4.
- **Disponibilidad.** El relay queda en el camino crítico del **100 %** del tráfico del número, con su propia deduplicación, su propio almacén cifrado y sus propios reintentos.
- **Multicanal.** Hace falta un relay por canal, o un relay que conozca todos los formatos de proveedor.

### 3.3 C — Interacción nativa del canal (WhatsApp Flows)

**Capacidades reales, según la documentación de Meta** (no probadas con la cuenta):
- Los Flows admiten `TextInput` con `input-type` `passcode` o `password`.
- Un Flow con endpoint intercambia datos cifrados (RSA-OAEP-SHA256 + AES-GCM, clave pública subida y firmada por Meta). El endpoint recibe `INIT`/`data_exchange` con un `flow_token` generado por el negocio.
- Al completarse llega al webhook de mensajes un mensaje `interactive`/`nfm_reply` con `response_json`. Con endpoint, su contenido lo controla la respuesta final del endpoint, así que puede omitir el código.
- Los campos `password`/`passcode` y los marcados `sensitive` se excluyen del resumen visible para el usuario.
  - **No verificado:** si un campo `sensitive` sin endpoint igualmente viaja en `response_json` hacia el webhook. Hay que asumir que **sí**.
- Las *authentication templates* de WhatsApp sirven para **enviar** un OTP por WhatsApp, no para capturarlo. No aplican: aquí el código prueba el control de un **buzón de correo**.

**Costos en R4:**
- Mensajes salientes interactivos: hoy solo hay salida `text` (`outbound.ts:51`).
- Reconocer `nfm_reply`: hoy cualquier `interactive` es `unsupported` → `handoff`.
- Operar un endpoint HTTPS de Flows con su par de claves, monitoreo de salud y la respuesta 421 ante rotación.
- Publicar el Flow (DEP-13).

**Límite estructural:** el correo de la CIA dice "Escríbelo solo en {displayName}" y nada impide que el cliente lo escriba como texto. **C no elimina SEC-OTP-02.**

### 3.4 Comparación

Escala: ●●● mejor · ● peor.

| Criterio | A | B | C |
|---|---|---|---|
| **Aislamiento del harness** | ●●● Ningún paquete del harness cambia. Cambian `live-ops`, `channel-gateway`, `persistence-postgres`, adaptadores y pack Sales (sujeto a DEP-11) | ●●● R4 no cambia su ingesta (opción i/ii). Con la opción iii, sí | ●● Exige ampliar el adaptador WhatsApp, la salida y la política de contenido no soportado |
| **Seguridad del OTP** | ●● El código existe en R4 solo en memoria del gateway y cifrado en un almacén dedicado con TTL ≤ 20 min. Nunca en almacenes conversacionales ni hashes | ●●● R4 nunca ve el código, pero el relay custodia el `appSecret` y el código | ●●● si el cliente usa el Flow: el código va por un canal cifrado de extremo a extremo hasta el endpoint. ● si lo escribe en el chat: cae a A o B |
| **Complejidad operacional** | ●●● Un proceso existente, una tabla, una clave, un flag | ● Servicio nuevo en el camino crítico, override de webhook, otro almacén y otra custodia de secretos | ● Flow publicado, endpoint con cifrado de Flows, claves, monitoreo de Meta |
| **Latencia del webhook** | ●●● +1 lectura indexada por mensaje de texto. Con expectativa activa: +2 lecturas y +1 inserción en la misma transacción. Sin llamadas de red | ● +1 salto de red para todo el tráfico | ●●● El webhook no cambia. El endpoint del Flow tiene su propio plazo |
| **Durabilidad** | ●●● Misma transacción que `inbound_events`. Meta reintenta ante 500 | ●● Depende del almacén del relay | ●● Igual que A si reutiliza el almacén |
| **Recuperación ante fallos** | ●●● Lease + generación + idempotencia de la CIA de 24 h: reintento seguro con la misma clave | ●● Hay que diseñarla de nuevo | ●● Reutiliza la de A |
| **Acoplamiento** | ●●● Puerto genérico. La CIA solo la conoce un adaptador | ● El relay conoce el formato de Meta, la CIA y la `sessionRef` interna de R4 | ●● Acoplado a WhatsApp Flows |
| **Costo de implementación** | ●● 6 slices pequeños (plan §3) | ● Servicio completo y cambios en R4 de todos modos (reanudación, registro de expectativa) | ● Además de A |
| **Compatibilidad multicanal** | ●●● Todo canal que entre por `ChannelIngress` | ● Un relay por canal | ● Solo WhatsApp |
| **Extensibilidad** | ●●● C puede añadirse después sobre el mismo almacén y despachador | ●● | ●● |

### 3.5 Decisión

| Alternativa | Dictamen |
|---|---|
| **A** | **Recomendada**, condicionada a **DEP-11** y a la **enmienda documental de R4-I** (§10). Es la única que se apoya en un punto del código actual donde coinciden autenticidad del proveedor, ausencia de persistencia, identidad de conversación y deduplicación durable |
| **B** | **Descartada como primera opción.** Rehabilitada **solo si el owner resuelve DEP-11 en contra** (la ingesta es harness). Aun así exige cambios en R4 (registro de expectativa y reanudación) y traslada la custodia del `appSecret` |
| **C** | **Descartada como sustituto. Mejora opcional posterior** para WhatsApp (menos errores de tecleo, el código no aparece en el chat). Reutiliza el almacén y el despachador de A. Requiere DEP-13 y soporte de `interactive` |

Ninguna alternativa exige modificar el kernel ni ningún invariante del Core. **A sí exige modificar `packages/live-ops`.** Si eso cuenta como "harness" es la decisión DEP-11, que este documento **no toma**.

---

## 4. Arquitectura seleccionada (A)

### 4.1 Componentes y ubicación

| Componente | Paquete | Proceso | Conoce el código | Credencial o clave |
|---|---|---|---|---|
| `InboundContentInspector` (puerto) y `VerificationResponseInspector` (implementación genérica: clasificador + redactor) | `packages/live-ops` | gateway | Sí, en memoria durante la petición | — |
| `VerificationExpectationStore` / `VerificationResponseStore` (puertos) | `packages/live-ops/src/ports.ts` | — | — | — |
| Implementación Postgres + migración `0011_identity_verification_channel` | `packages/persistence-postgres` | gateway, worker | Solo el cifrado | — |
| `SecretBox` (AES-256-GCM, `key_id`, AAD) | `packages/live-ops` (primitivo propio, `node:crypto`; ver §5.3) | gateway | Lo cifra y lo descifra | `R4_PROD_VERIFICATION_CODE_KEYS` |
| `IdentityVerificationConfirmer` (puerto) | `packages/live-ops/src/ports.ts` | — | — | — |
| `CiaVerificationConfirmClient` | `adapters/domains/identity/http` (cliente y configuración **separados** del de `resolve`) | gateway | Lo envía | `R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN` (scope exclusivo `identity.verification.confirm`) |
| `VerificationConfirmDispatcher` | `packages/live-ops` (patrón de `DeliveryDispatcher`) | **gateway** | Lo descifra | — |
| Capacidad gobernada `identity.start_verification@1` | `agents/sales/src/capabilities` (composición sintética solamente) | sales worker | **No** | Credencial **agent** existente (`R4_CUSTOMER_IDENTITY_BEARER_TOKEN`) |
| `CiaVerificationStartClient` | `adapters/domains/identity/http` (junto a `resolve`) | sales worker | No | Credencial agent |

**Separación por proceso.** El sales worker (el proceso que corre el modelo y las capacidades) **no recibe** ni la clave de cifrado ni la credencial de confirmación. Tampoco puede descifrar el almacén aunque comparta la base. Ver T-17 y T-18 del modelo de amenazas.

### 4.2 Puertos (contratos tipados, sin nombres de canal)

```ts
// packages/live-ops/src/channel.ts — nuevo, opcional en ChannelIngressOptions
export interface InboundContentInspector {
  /** Called once per canonical TEXT inbound, before ANY persistence or hashing. Must not throw on content. */
  inspect(event: CanonicalInbound, conversationKey: string): Promise<InboundInspection>;
}
export type InboundInspection =
  | { readonly kind: 'pass' }                                     // identical to today's path
  | { readonly kind: 'redacted'; readonly text: string;           // text that WILL be persisted (marker inside)
      readonly capture: CapturedVerificationResponse | null; readonly reason: RedactionReason };
export interface CapturedVerificationResponse {
  readonly expectationId: string;
  readonly sealed: SealedSecret;          // AES-GCM output; the plaintext never leaves the inspector
}
export type RedactionReason = 'single_candidate' | 'multiple_candidates' | 'non_six_digit_candidate'
  | 'expectation_not_current' | 'expectation_expired_grace';

// packages/live-ops/src/ports.ts — nuevos
export interface VerificationExpectationStore {
  activeExpectation(channel: string, conversationKey: string): Promise<VerificationExpectationRecord | null>;
  openExpectation(input: NewVerificationExpectation): Promise<VerificationExpectationRecord>; // supersedes the previous one atomically
  markIssued(expectationId: string, issued: { verificationId: string; expiresAt: string; resendAvailableAt: string }): Promise<VerificationExpectationRecord>;
  closeExpectation(expectationId: string, to: 'cancelled' | 'expired', reason: string): Promise<void>;
}
export interface IdentityVerificationConfirmer {
  confirm(request: { context: VerificationContext; verificationId: string; code: string; idempotencyKey: string },
          options: { signal: AbortSignal; correlationId: string }): Promise<ConfirmResult>;
}
export type ConfirmResult =
  | { kind: 'outcome'; outcome: 'linked' | 'no_eligible_account' | 'ineligible_account' | 'ambiguous' | 'conflicted' | 'invalid_code' | 'expired' | 'locked'; attemptsRemaining?: number }
  | { kind: 'retryable'; code: 'operation_in_progress' | 'rate_limited' | 'dependency_unavailable' | 'timeout' | 'network' | 'server_error'; retryAfterMs?: number }
  | { kind: 'terminal'; code: 'invalid_request' | 'unauthenticated' | 'consumer_not_allowed' | 'idempotency_conflict' | 'unexpected_response' };
```

`ChannelIngress` solo gana una dependencia **opcional**:
- **Sin `inspector`**, el comportamiento es byte a byte el actual. Así se hace el rollback (plan §5).
- **Con `inspector`**, los cambios en `ingest` se reducen a tres:
  1. llamar a `inspect` después de `:138`;
  2. usar `text` redactado para `content` y `contentSha256`;
  3. si hay `capture`, llamar a `store.recordInboundWithVerificationResponse(...)` en lugar de `recordInbound` (una transacción).

### 4.3 Secuencia: inicio de la verificación

```mermaid
sequenceDiagram
  autonumber
  participant C as Cliente (WhatsApp)
  participant M as Modelo (sales worker)
  participant K as Capability runtime (governed write)
  participant H as Handler identity.start_verification@1
  participant S as ProductionStore (expectativas)
  participant CIA as CIA /v1/identity/verifications
  C->>M: "quiero ver mis compras" (texto ordinario)
  M->>K: customer.get_purchase_history@1
  K-->>M: unavailable: not_linked / not_verified (resolve por invocación, ADR-039)
  M->>C: "Para eso necesito verificar tu correo. ¿Cuál es?"
  C->>M: "ana@ejemplo.test" (dato declarado, no confiable)
  M->>K: proposal identity.start_verification@1 {email}
  K->>K: policy (DEP-8) → ActionCommand (executionKey)
  K->>H: execute(executionKey, args{email})
  H->>S: bindingByTask(taskId) + taskState(taskId): open y no terminal, si no → refused
  H->>S: openExpectation(state=created, binding, startKey=f(executionKey)), supersede la anterior
  H->>CIA: POST verifications {context(binding), verificationPurpose, email, purposes}<br/>Bearer agent · idempotency-key=startKey
  CIA-->>H: 202 {verificationId, expiresAt, resendAvailableAt}
  H->>S: markIssued(expectationId, verificationId, expiresAt) → awaiting_code
  H-->>K: receipt {status: challenge_issued, expiresAt, resendAvailableAt} (sin verificationId, sin email)
  K-->>M: observation
  M->>C: "Te envié un código a tu correo. Respóndeme solo con el código."
```

Reglas del inicio (§7 detalla el estado):
- **La expectativa se crea antes de llamar a la CIA (`created`).** Desde ese instante la ingesta ya redacta (fail-closed). Si el proceso muere después del 202 y antes de `markIssued`, la expectativa queda en `created`:
  - los códigos que lleguen se capturan igual;
  - el despachador espera a que la acción se reconcilie: `idempotent_replay` con la misma `idempotency-key` devuelve el mismo 202 de la CIA durante 24 h;
  - si no se reconcilia, la expectativa vence (plan §4.3).
- **El handler nunca devuelve el `verificationId`** (contrato §3: "nunca llega al modelo") **ni repite el email.**
- **Errores de la CIA en el inicio:**
  - 503 `delivery_unavailable` y 429: expectativa `cancelled` (motivo `start_unavailable` o `start_rate_limited`). El modelo recibe "no disponible, intenta más tarde", sin distinguir la causa ante el cliente.
  - 400: `cancelled` (`start_invalid_email`). El modelo puede pedir el correo otra vez.
  - 401, 403 y 409 `idempotency_conflict`: `cancelled` + alerta (configuración o programación).
  - 409 `operation_in_progress`: reintento de la acción con la misma clave.

### 4.4 Secuencia: captura y confirmación diferida

```mermaid
sequenceDiagram
  autonumber
  participant C as Cliente (WhatsApp)
  participant W as Meta Cloud API
  participant G as channel-gateway (Fastify)
  participant I as ChannelIngress + Inspector
  participant DB as Postgres
  participant D as VerificationConfirmDispatcher (gateway)
  participant CIA as CIA /verifications/confirm
  participant T as TemporalRuntime (submitInput)
  C->>W: "mi código es 482 913"
  W->>G: POST webhook (raw body + x-hub-signature-256)
  G->>I: receive(): authenticate (HMAC) → parse
  I->>I: canonicalize · conversationKey
  I->>DB: activeExpectation(channel, conversationKey)
  DB-->>I: awaiting_code (bindingId, expiresAt)
  I->>DB: findOpenBinding + taskState (¿binding vigente = binding de la expectativa?)
  I->>I: normaliza (NFKC + dígitos Nd) · detecta candidatos · 1 candidato de 6 → seal(AES-GCM)
  I->>DB: TX {inbound_events(content="mi código es [verification code withheld by platform]", sha256(redactado)),<br/>verification_responses(pending, ciphertext, expectation, provider_event_id)}
  I->>DB: #process ordinario con texto redactado (binding, submitInput, settle)
  G-->>W: 200 (sin esperar a la CIA)
  Note over D: fuera de la petición
  D->>DB: claim (FOR UPDATE SKIP LOCKED sobre la expectativa, lease 30 s + generation)
  D->>DB: recheck: expectativa vigente · binding open · tarea no terminal
  D->>D: open(ciphertext) → "482913" (solo en memoria)
  D->>CIA: POST confirm {context(binding de la expectativa), verificationId, code}<br/>Bearer channel-integration · idempotency-key=vr.<sha256(channel‖providerEventId)>
  CIA-->>D: 200 {outcome: linked}
  D->>DB: TX {response=resolved(outcome), ciphertext=NULL, expectativa=confirmed}
  D->>T: submitInput(taskId, "[identity verification handled by the platform: outcome=linked]",<br/>sourceRef=platform:identity-verification, externalKey=verification-outcome:<responseId>)
  D->>DB: response=notified
  T-->>T: despierta la tarea (WAIT_FOR_INPUT)
```

**El modelo recibe dos entradas, ninguna con el código:**
1. el texto redactado, de inmediato;
2. el marcador de resultado, al terminar.

El contrato §5.2 exige mostrar un 503 como "procesando", y por eso el texto redactado se ingiere de inmediato: el agente puede responder "estoy validando tu código" sin conocer el resultado.

### 4.5 Marcadores de plataforma

| Marcador (texto exacto que se persiste) | Cuándo |
|---|---|
| `[verification code withheld by platform]` | Sustituye **cada** secuencia candidata dentro del texto (§6). Si el mensaje era solo el código, el texto persistido es solo el marcador |
| `[identity verification handled by the platform: outcome=<outcome>]` | Entrada de reanudación. `<outcome>` ∈ `linked`, `no_eligible_account`, `ineligible_account`, `ambiguous`, `conflicted`, `locked`, `expired`, `invalid_code; attempts_remaining=<n>` |
| `[identity verification handled by the platform: outcome=not_processed; reason=<r>]` | `r` ∈ `multiple_candidates` (pedir solo el código), `not_six_digits` (pedir el código de 6 dígitos), `challenge_replaced`, `challenge_expired`, `unavailable` (TTL agotado con la CIA no disponible) |

Siguen el patrón de `unsupportedContentMarker` (`ingress.ts:51-54`): texto de plataforma en inglés, entre corchetes, sin datos del cliente. **Ningún marcador contiene dígitos del código, el email ni el `verificationId`.**

---

## 5. Política de almacenamiento transitorio

### 5.1 Dónde vive el código

| Lugar | ¿Código? |
|---|---|
| Memoria del proceso gateway, durante `inspect` y durante el intento del despachador | Sí, en claro. Variable local, nunca en logs ni errores |
| `verification_responses.code_ciphertext` | **Solo cifrado**, mientras el estado no sea terminal (CHECK, §5.2) |
| `inbound_events.content` / `content_sha256` | No: texto redactado y su hash |
| `task_inputs` (incluido `request_hash`), `memory_entries`, `context_snapshots`, `observations`, `action_*`, `agent_run_steps` | No |
| `verification_expectations` | No. Guarda `verification_id` (inútil sin el código, contrato §4.1) y metadatos |
| Telemetría y logs | No. Solo ids, `reason`, `outcome` y contadores |
| CIA | Solo como `HMAC(clave, verificationId‖código)` (SR-05) |
| CP | **Nunca** |

### 5.2 Esquema propuesto (migración `0011`, **no creada en este mandato**)

```sql
-- verification_expectations: estado del desafío por conversación (sin secretos)
create table verification_expectations (
  expectation_id      uuid primary key,
  channel             text not null,
  conversation_key    text not null check (conversation_key ~ '^[0-9a-f]{64}$'),
  account_ref         text not null,
  binding_id          uuid not null references channel_conversation_bindings(binding_id),
  task_id             uuid not null references agent_tasks(task_id),
  consumer_id         text not null,                  -- 'r4-sales'
  start_idempotency_key text not null unique,
  verification_id     text,                           -- null mientras created
  state               text not null check (state in ('created','awaiting_code','processing','confirmed','rejected','expired','cancelled')),
  outcome             text,                           -- último outcome de la CIA
  attempts_remaining  smallint,
  created_at          timestamptz not null default clock_timestamp(),
  challenge_expires_at timestamptz,                   -- expiresAt de la CIA (≤ created_at + 600 s)
  redact_until        timestamptz not null,           -- challenge_expires_at + gracia (OA-07)
  closed_at           timestamptz,
  closed_reason       text,
  version             integer not null default 1,     -- +1 por transición (control optimista)
  check ((state in ('created')) = (verification_id is null)),
  check ((state in ('confirmed','rejected','expired','cancelled')) = (closed_at is not null))
);
create unique index verification_expectations_one_live
  on verification_expectations (channel, conversation_key)
  where state in ('created','awaiting_code','processing');

-- verification_responses: código capturado, cifrado y efímero
create table verification_responses (
  response_id         uuid primary key,
  expectation_id      uuid not null references verification_expectations(expectation_id),
  channel             text not null,
  provider_event_id   text not null,
  received_seq        bigint generated always as identity,  -- orden de llegada
  occurred_at         timestamptz not null,
  state               text not null check (state in ('pending','dispatching','resolved','notified','cancelled','failed','expired')),
  code_ciphertext     bytea, code_iv bytea, code_tag bytea, key_id text,
  confirm_idempotency_key text not null unique,
  attempts            integer not null default 0,
  next_attempt_at     timestamptz not null default clock_timestamp(),
  lease_owner text, lease_generation bigint not null default 0, lease_expires_at timestamptz,
  outcome             text, failure_code text,
  deadline_at         timestamptz not null,             -- = challenge_expires_at (o created+600 s)
  purge_after         timestamptz not null,             -- deadline_at + 24 h (retención de la clave en la CIA)
  unique (channel, provider_event_id),
  check ((state in ('pending','dispatching')) = (code_ciphertext is not null)),
  check ((code_ciphertext is null) = (code_iv is null) and (code_iv is null) = (code_tag is null) and (code_tag is null) = (key_id is null))
);
```

**Garantías del esquema:**
- Un estado terminal **implica** el cifrado borrado: un `UPDATE` que pase a `resolved` sin anular el cifrado viola el CHECK.
- Las filas sin cifrado se conservan hasta `purge_after`. Así un reintento de Meta posterior encuentra la fila y no crea una confirmación nueva.
- Un barrido (plan §4.3) borra las filas vencidas y expira las expectativas.

### 5.3 Cifrado autenticado y gestión de claves

| Aspecto | Política |
|---|---|
| Algoritmo | AES-256-GCM (`node:crypto`), IV aleatorio de 96 bits por registro y tag de 128 bits. Sin dependencias nuevas |
| Texto plano | Exactamente 6 dígitos ASCII normalizados. Nunca el mensaje original |
| AAD | `response_id ‖ expectation_id ‖ channel ‖ provider_event_id`. Impide trasplantar un cifrado a otra fila o expectativa |
| Claves | `R4_PROD_VERIFICATION_CODE_KEYS`: lista `key_id:base64(32 bytes)`. La primera cifra; todas descifran. Rotación = añadir una clave nueva al frente y retirar la anterior tras 20 min (TTL + gracia) |
| Separación | Clave **distinta** de `R4_PROD_IDENTITY_HASH_KEY` y de cualquier otra. Solo el proceso gateway la recibe. El sales worker, la API y el scheduler **no** |
| Fallo de clave | Sin clave configurada con el inspector activo: el gateway **no arranca** (fail-closed). Error de descifrado (rotación incompleta o manipulación): respuesta `failed` (`decrypt_failed`) + alerta, sin llamar a la CIA |
| Sintético | Claves generadas por la prueba. **No se define custodia productiva** (KMS o gestor de secretos): es una dependencia (DEP-6 de la CIA y OA-10 de este documento) |

### 5.4 Control de acceso, borrado y exclusión de trazas

**Acceso:**
- Solo `production-store.ts` (o un `verification-store.ts` hermano en `persistence-postgres`) escribe estas tablas. Una prueba de frontera nueva lo comprueba, como `live-ops-boundaries.test.ts:66-69`.
- Ninguna ruta de la API ni `ProductionStore.thread()` lee `verification_responses`.
- El rol de base de datos es único hoy. Separar roles (`GRANT` solo al gateway) es una mejora para datos reales (OA-10), no un control sintético.

**Borrado:**
- En la misma transacción que registra el resultado terminal (CHECK).
- Al cancelar o reemplazar la expectativa.
- Al vencer `deadline_at`, en el barrido.
- Filas completas, en el barrido tras `purge_after`.

**Logs:**
- El inspector y el despachador nunca registran el evento canónico, el texto ni el código.
- Los errores se registran como `{name, code}`, el mismo patrón que `platform.ts:120`.
- El cliente de confirmación nunca incluye el cuerpo en sus errores.

**Errores de la base:** un `DatabaseError` de `pg` incluye `detail` ("Failing row contains…") con valores de la fila. Por eso:
- el texto redactado se calcula **antes** del `INSERT`, y una violación de CHECK de `inbound_events` solo puede contener texto redactado;
- en `verification_responses`, una violación contendría solo el cifrado;
- además, el despachador mapea los errores de `pg` a `{name, code}` (H-L2 del modelo de amenazas).

**Volcados de diagnóstico:**
- `agents/sales/src/harness/diagnostics.ts`, los informes y el evaluador leen memoria conversacional: el código nunca está ahí.
- Un volcado de `verification_responses` contiene solo el cifrado.

---

## 6. Aislamiento del código (SEC-OTP-02): clasificación y redacción

### 6.1 Condición de activación

El inspector **solo** actúa si `activeExpectation(channel, conversationKey)` devuelve una expectativa con:
- `state ∈ {created, awaiting_code, processing}` y `now < redact_until`; **o bien**
- `state` terminal cerrado hace menos de la gracia, con `now < redact_until`. Cubre códigos tardíos.

**Sin expectativa, el mensaje sigue la ingesta actual** (N-08: un número de 6 dígitos sin desafío no se toca).

`conversationKey` ya identifica `(channel, channelAccountRef, subjectRef)`. En WhatsApp `conversationRef` es el `wa_id` del remitente (`inbound.ts:112`), así que **otro sujeto u otra cuenta de canal nunca coinciden con la expectativa**.

### 6.2 Normalización

Se aplica sobre una **copia** del texto, solo para detectar. Lo que se persiste es el texto original con las secuencias sustituidas.
1. NFKC: dígitos de ancho completo, superíndices y compatibilidad.
2. Todo carácter `\p{Nd}` (árabe-índico, devanagari, etc.) pasa a su valor ASCII. Unicode garantiza que cada bloque `Nd` es una secuencia contigua de 0 a 9.
3. Se eliminan los caracteres de formato `\p{Cf}` (ZWSP, ZWJ, marcas de dirección) y las marcas de keycap (`U+FE0F`, `U+20E3`), para que `4️⃣8️⃣2️⃣…` se reconozca.
4. Se trata como **separador** a: espacios (`\p{Zs}`), `-`, `‐`, `–`, `—`, `.`, `·`, `/`, `_`, `,`.

### 6.3 Detección y decisión

**Secuencia candidata:** una corrida maximal de dígitos con a lo sumo **un** separador (de cualquier longitud de espacios) entre dígitos consecutivos, y con **4 a 8 dígitos** en total. Se detecta con un recorrido de caracteres, no con una sola regex.

| Caso | Ejemplo (expectativa activa) | Texto persistido | Captura |
|---|---|---|---|
| Solo el código | `482913` | `[verification code withheld by platform]` | Sí |
| Separado | `482 913`, `482-913`, `4 8 2 9 1 3`, `48.29.13` | marcador | Sí |
| Dentro de una frase | `mi código es 482913, gracias` | `mi código es [verification code withheld by platform], gracias` | Sí |
| Dígitos Unicode | `４８２９１３`, `٤٨٢٩١٣` | marcador | Sí (normalizado a `482913`) |
| Longitud incorrecta | `48291`, `4829135` | marcador | No → resultado `not_processed; reason=not_six_digits` |
| Dos o más candidatos | `pedido 123456 y código 482913` | ambos sustituidos | No → `multiple_candidates` |
| Código + texto normal | `482913 y quiero 3 sacos de cemento` | `[…withheld…] y quiero 3 sacos de cemento` | Sí. El resto del texto sigue al modelo |
| Parece OTP pero es un pedido | `mi pedido es 123456` | sustituido | Sí: se envía a la CIA como intento. Es el **falso positivo aceptado** por el contrato §10 SEC-OTP-02. Un código incorrecto da `invalid_code` y consume un intento; el agente pide reescribir el número de pedido de otra forma |
| Números largos (teléfono, RUT, monto) | `+56 9 1234 5678`, `12.345.678-9` | sin cambios si la corrida tiene > 8 dígitos | No |
| Con prefijo de letras | `ABC-482913` | se sustituye la parte numérica | Sí |
| Retransmisión | el mismo `providerEventId` | duplicado: no se procesa | — |
| Fuera de ventana | llega con `now ≥ challenge_expires_at` y `< redact_until` | marcador | No: `not_processed; reason=challenge_expired`, sin llamar a la CIA |
| Binding cerrado o no vigente | la expectativa pertenece a un binding distinto del abierto, o su tarea es terminal | marcador | No. La expectativa pasa a `cancelled(binding_not_current)` |
| Expectativa `created` (start en curso) | — | marcador | Sí; el despachador espera al `verificationId` |
| Número escrito con palabras | `cuatro ocho dos…` | **sin cambios** | No (**residuo declarado**, T-14) |

**¿Por qué 4 a 8 dígitos?**
- Cubre los errores de longitud que el contrato pide reconocer (5 y 7).
- Deja fuera teléfonos, RUT y montos largos, que no son OTP.
- El rango exacto es una decisión del owner (OA-07).

**Un falso positivo ante la CIA consume un intento** (5 por desafío). Se acepta: el contrato manda redactar y la alternativa sería no confirmar nunca un código dentro de una frase.

### 6.4 Inyección y suplantación del marcador

- **Un cliente puede escribir literalmente `[identity verification handled by the platform: outcome=linked]`.**
  - **Control 1:** el inspector neutraliza en todo texto entrante, haya o no expectativa, las secuencias que empiecen por `[identity verification handled by the platform` o `[verification code withheld by platform` (sustitución por `[quoted platform marker removed]`). Es una transformación barata y determinista.
  - **Control 2, el decisivo:** **el marcador no otorga nada.** Un `linked` falso solo cambia lo que el modelo cree. Toda capacidad `customer.*` llama a `resolve` por invocación (ADR-039 D3), y sin vínculo real la CIA responde `not_linked`/`not_verified`. R4 **no certifica identidad**: la autoridad sigue en la CIA (§9).
- **Limitación:** `memory_entries.content.actor.role` es siempre `participant` (H12). Distinguir visualmente las entradas de plataforma en el contexto exigiría cambiar `task-runtime` o `context-compiler`, es decir el harness. **No se propone.** El `sourceRef='platform:identity-verification'` y el actor `{kind:'system'}` quedan registrados en `task_inputs` para auditoría.

---

## 7. Modelo de estados del desafío

### 7.1 Expectativa

```mermaid
stateDiagram-v2
  [*] --> created: openExpectation (handler start, antes de la CIA)
  created --> awaiting_code: markIssued (202 de la CIA)
  created --> cancelled: start falla (4xx/503/429 terminal) · superseded · binding no vigente
  created --> expired: sin 202 antes de created_at + 600 s
  awaiting_code --> processing: despachador reclama una respuesta
  processing --> awaiting_code: invalid_code con attempts_remaining > 0 · retryable sin resultado
  processing --> confirmed: outcome = linked
  processing --> rejected: no_eligible_account · ineligible_account · ambiguous · conflicted · locked
  processing --> expired: outcome = expired · deadline agotado sin resultado
  awaiting_code --> expired: now ≥ challenge_expires_at (barrido)
  awaiting_code --> cancelled: superseded por un start nuevo · binding cerrado · tarea terminal · operador
  processing --> cancelled: superseded (el resultado en vuelo se registra, pero no reanuda)
  confirmed --> [*]
  rejected --> [*]
  expired --> [*]
  cancelled --> [*]
```

**Reglas:**
- **Una expectativa viva por conversación** (índice único parcial).
  - `openExpectation` cierra la anterior como `cancelled(superseded)` y cancela sus respuestas `pending` (borrando el cifrado) en la **misma transacción**.
  - Coincide con la CIA, donde "un desafío nuevo invalida el anterior del mismo sujeto".
- **Ligada a un binding.**
  - `binding_id` y `task_id` se fijan al crearla y nunca cambian.
  - Un binding nuevo para la misma conversación **no hereda** la expectativa: el inspector la cancela (`binding_not_current`).
  - La CIA lo refuerza: otro `sessionRef` en `confirm` da `invalid_code` (SR-02).
- **Nunca derivada del texto ni del modelo.**
  - La crea solo el handler del `start`, con `bindingByTask(taskId)`.
  - La cierran el despachador, el inspector (binding no vigente), el barrido o un `start` nuevo.
  - El modelo no tiene ningún argumento que la nombre.
- **Control optimista.** Cada transición es `UPDATE … WHERE expectation_id = $1 AND version = $2 AND state = $3`. Si pierde, se relee.
- **`processing` es una vista del lease.** La expectativa entra en `processing` cuando el despachador reclama una respuesta suya con `FOR UPDATE SKIP LOCKED` y vuelve al terminar el intento. Un lease vencido se recupera en el siguiente reclamo (§8.4 del plan).

### 7.2 Respuesta capturada

`pending → dispatching → resolved → notified`, con las salidas terminales:
- `cancelled`: expectativa reemplazada o cerrada, o binding no vigente;
- `expired`: `deadline_at` agotado;
- `failed`: 4xx terminal, descifrado o configuración.

Toda salida de `pending|dispatching` borra el cifrado.

### 7.3 Concurrencia, reinicios y duplicados

| Situación | Comportamiento |
|---|---|
| Dos códigos seguidos del cliente | Se procesan en orden de `received_seq` y nunca en paralelo, porque el reclamo bloquea la expectativa. El segundo espera el resultado del primero. Si el primero da `linked`, el segundo pasa a `cancelled(already_confirmed)` sin llamar a la CIA |
| Start nuevo con un código en vuelo | El código en vuelo termina: la CIA lo evalúa contra el desafío ya invalidado y responde `invalid_code`. Su resultado se registra, pero **no reanuda** la tarea, porque la expectativa ya no es la vigente. Los `pending` se cancelan |
| Reinicio del gateway durante la confirmación | Lease vencido → nuevo reclamo → misma `idempotency-key`. La CIA devuelve el resultado guardado (`completed`) o `operation_in_progress` (reintento tras `Retry-After`). **Nunca hay doble intento** (I04) |
| Reinicio entre `resolved` y `notified` | El barrido reenvía `submitInput` con el mismo `externalKey`: idempotente (H11) |
| Meta reentrega el webhook | `unique (channel, provider_event_id)` en ambas tablas: duplicado, sin captura nueva |
| Cierre de sesión (tarea terminal) | El próximo inbound o el barrido cancelan la expectativa. Un resultado posterior no reanuda: `submitInput` rechaza `task_not_accepting_input`, y la respuesta queda `notified` con `failure_code='task_terminal'` |

---

## 8. Inicio de la verificación: quién pide el email y qué sabe el agente

| Paso | Responsable | Detalle |
|---|---|---|
| Pedir el correo | Modelo (conversación) | Solo cuando una capacidad `customer.*` devolvió `not_linked`/`not_verified` y el cliente quiere datos privados. Lo fijan las instrucciones del pack |
| Validar el dato declarado | Handler (Zod) | `email` `strictObject`, máximo 254, formato email, sin `\| % [ ]` ni espacios (SR-10). En sintético, solo dominios `.test` (la CIA lo exige igualmente). **No** es una prueba de propiedad |
| Asociarlo al sujeto confiable | Handler | `context` = `bindingByTask(taskId)` (OWNER-R3-01). El modelo no aporta `channel`, `subjectRef` ni `sessionRef` (contrato §3) |
| Iniciar el desafío | Handler → CIA (credencial agent) | Escritura gobernada (envía un correo a un tercero, DEP-8). `idempotency-key` derivada de `executionKey`. `purposes` = constante del handler (`sales_context`, `purchase_history`): la CIA exige que el `start` declare todo propósito que `resolve` pida después |
| Registrar la expectativa | Handler → `ProductionStore` | **Antes** de la CIA (`created`) y después (`awaiting_code`). §4.3 |
| Informar al cliente | Modelo | Con la observación `{status: challenge_issued, expiresAt, resendAvailableAt}` |

**Qué no hace el inicio:**
- No genera acceso comercial ni concede grant.
- No declara identidad verificada.
- No consulta al proveedor de cuentas: la CIA tampoco lo hace en el inicio (§5.1, SR-04).
- Un `challenge_issued` es uniforme para cualquier email.

**Qué parte del correo conoce cada actor:**

| Variante | El modelo y la memoria conversacional | La infraestructura de integración |
|---|---|---|
| **E1 (recomendada para sintético)** | El email que escribió el cliente: ya está en `memory_entries`, porque es texto ordinario. El handler **no lo devuelve** en la observación. El argumento queda en `action_proposals`/`action_executions` | El handler lo envía a la CIA. La CIA lo guarda cifrado hasta consumir o expirar el desafío, y después solo su HMAC |
| E2 (alternativa si el owner de datos prohíbe el email en memoria conversacional) | Nada: el modelo invoca `identity.start_verification` **sin argumentos** | La expectativa nace en el estado `awaiting_email`. El inspector captura el siguiente mensaje que parezca un email, lo redacta (`[email withheld by platform]`), lo cifra y el despachador del gateway llama al `start`. **Exige dar al gateway también la credencial agent**, con dos credenciales en el mismo proceso, más estados y más clasificación |

**Dependencia registrada:** la política de tratamiento de datos personales del email (owner de datos; D7, retención y purga; DEP-10 de la CIA, legal). **Sin esa decisión E1 solo vale para datos sintéticos.**

**Prohibido:** diseñar `confirm` como capacidad del modelo, o que alguna capacidad reciba o devuelva el código, el `verificationId` o el grant (ADR-039 I1; contrato §3).

---

## 9. Invariantes preservados

| Invariante | Cómo se preserva |
|---|---|
| El kernel R4 no conoce OTP | Ningún cambio en `agent-kernel`, `task-runtime`, `capability-runtime`, `context-compiler`, `model-gateway`, `policy-engine`, `contracts` ni `observability`. El inspector vive en `live-ops`. Se comprueba con `git diff --stat` vacío sobre esas rutas en cada slice (plan §6) |
| El modelo no ve el OTP | Redacción antes de cualquier persistencia y hash. Las capacidades no reciben ni devuelven el código. El sales worker no tiene clave ni credencial de confirmación |
| El webhook no llama síncronamente a la CIA | Inspector = lecturas e inserciones en Postgres. La CIA la llama solo el despachador, fuera de la petición. Hay una prueba que falla si el inspector usa red (plan, AT-07) |
| La CIA conserva la autoridad de verificación | R4 transporta el código normalizado. El resultado lo decide la CIA. R4 no compara ni almacena hashes del código |
| R4 no certifica identidad | `linked` es un marcador informativo. El acceso sigue exigiendo `resolve` por invocación (ADR-039 D3) |
| CP no recibe códigos | El despachador solo habla con la CIA. Los adaptadores CP no cambian |
| Grants por invocación | Sin cambios en `customer-v2.ts` salvo la mitigación de RR-1 (análisis RR-1) |
| `CustomerAccessGrant` opaco | Sin cambios |
| Ningún código en persistencia conversacional | §5.1. Barrido de búsqueda N-15 (modelo de amenazas, AT-12) |
| Ningún cambio autoriza datos reales | `R4_CUSTOMER_MODE=real` sigue rechazado. La capacidad de inicio solo se registra en la composición sintética. `sales-production@8` no existe |
| Sin cambios productivos en este mandato | Solo documentos en `docs/architecture/` |

---

## 10. Conflicto con el harness e invariante R4-I

**DEP-11 (pendiente, owner de R4):**
- **Pregunta:** ¿`packages/live-ops`, `apps/channel-gateway` y `adapters/channels/*` son infraestructura de canal fuera del harness?
- **Evidencia a favor:**
  - `tests/contract/live-ops-boundaries.test.ts:29` enumera el Core sin `live-ops`;
  - la descripción raíz de `package.json:5` sitúa R4-I Governed Production ("durable channel ingress and outbound delivery") "outside Core execution";
  - el encabezado de `OWNERSHIP_MATRIX.md:3` dice lo mismo: "R4-I Governed Production (IN PROGRESS, outside Core execution)".
- **Evidencia ambigua:** `OWNERSHIP_MATRIX.md:116` describe el binding como "Ingress Sales (harness / futuro channel adapter)".
- **Si la respuesta es sí:** A procede tal como está diseñada.
- **Si la respuesta es no:** A queda **detenida**. Las opciones son B con sus costos (§3.2), o autorizar expresamente el cambio en la ingesta como excepción documentada.

**Enmienda de R4-I (pendiente, owner de R4).** El texto de `ingress.ts:56-61` dice que la ingesta produce "durable canonical input on the bound task — and nothing else".
- A **no viola** la prohibición de llamar a owners de dominio dentro de la petición.
- Sí añade dos cosas:
  - (a) una transformación determinista del contenido antes de persistir;
  - (b) un registro durable de respuesta de verificación junto al inbound.
- **Texto de enmienda propuesto** (para el ADR que la formalice, no aplicado):

> R4-I.1 — Antes de persistir, la ingesta PUEDE pasar el contenido canónico por un inspector de plataforma configurado por composición. El inspector solo lee estado de plataforma, no hace llamadas de red, no invoca modelos ni owners de dominio, y su único efecto es (a) sustituir secuencias por marcadores de plataforma y (b) registrar, en la misma transacción que el inbound, un secreto sellado para un despachador asíncrono. Sin inspector configurado, la ingesta es idéntica a R4-I.

**Harness: ningún cambio propuesto.** Dos mejoras quedan identificadas como **opcionales y no recomendadas ahora**, porque exigirían tocarlo:
- marcar visualmente las entradas de plataforma en el contexto (H12);
- propagar la cancelación de la tarea a la `signal` de las capacidades (RR-1, análisis §5).

---

## 11. Puntos que requieren aprobación

| ID | Decisión | Owner | Bloquea |
|---|---|---|---|
| **OA-01** | DEP-11: clasificar `live-ops` y `channel-gateway` como infraestructura de canal fuera del harness | R4 | Toda la alternativa A |
| **OA-02** | Enmienda R4-I.1 (§10) en un ADR (ADR-040 propuesto) | R4 | SEC-S3 |
| **OA-03** | Adoptar A. B solo como contingencia de OA-01. C como mejora posterior | R4 | — |
| **OA-04** | E1 frente a E2 y política de datos personales del email (incluida su presencia en `action_proposals` y `memory_entries`) | Owner de datos + R4 | SEC-S5 con datos reales. Sintético con E1 permitido si R4 lo aprueba |
| **OA-05** | Política de `identity.start_verification@1`: autónoma, con límites de la CIA, o con aprobación humana (DEP-8). Frecuencia máxima por conversación | R4 | SEC-S5 |
| **OA-06** | Configuración en la CIA: **un consumidor `r4-sales` con dos credenciales** (`agent`; `channel-integration` con scope exclusivo `identity.verification.confirm`). Corregir el ejemplo del contrato §2, que sugiere dos consumidores (con dos, todo `confirm` daría `invalid_code`) | CIA | SEC-S4 |
| **OA-07** | Alcance de la redacción: rango de 4 a 8 dígitos, separadores admitidos y gracia de `redact_until` (propuesta: 10 min tras `challenge_expires_at`) | R4 (+ CIA informada) | SEC-S1 |
| **OA-08** | Texto exacto de los marcadores y resultados que ve el modelo (§4.5), incluida la revelación de `ambiguous`/`conflicted` | R4 | SEC-S4 |
| **OA-09** | Gate RR-1 y residuos aceptables (análisis RR-1 §7) | R4 | Activación real |
| **OA-10** | Custodia productiva de claves (KMS o gestor de secretos), separación de roles de base de datos, revisión de logs de nginx/PM2 | R4 + operación | Datos reales |
| **OA-11** | Aceptar que las entradas de plataforma se registren con `role: participant` (H12) en lugar de cambiar el harness | R4 | SEC-S4 |

---

## 12. Fuentes externas consultadas (alternativa C)

- [WhatsApp Flows — Implementing your Flow endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/implementingyourflowendpoint)
- [WhatsApp Flows — Encryption](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/whatsapp-business-encryption)
- [WhatsApp Flows — Components (TextInput `input-type`)](https://developers.facebook.com/docs/whatsapp/flows/reference/components)
- [WhatsApp Flows — Best practices (resumen de respuesta, `password`/`passcode`, `sensitive`)](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/bestpractices)
- [WhatsApp Flows — Receive Flow response](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/receiveflowresponse)
- [Hookdeck — WhatsApp webhooks: features and best practices](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices) (entrega al menos una vez, deduplicación por `messages[].id`)

Ninguna de estas capacidades se probó con la cuenta de WhatsApp del negocio.
