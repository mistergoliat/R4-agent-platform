# R4-J4-SEC-OTP — Plan de implementación incremental

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-DESIGN-01` |
| Fecha | 2026-10-21 |
| Para | Owner de R4 (autorización de slices), implementadores |
| Base | Arquitectura A (`R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md`). Amenazas y pruebas en `R4_J4_SEC_OTP_THREAT_MODEL.md`. RR-1 en `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` |
| Estado | **Plan. Nada implementado.** Cada slice exige autorización explícita, sigue siendo sintético y entrega su evaluación junto con la implementación |

---

## 1. Prerrequisitos (decisiones antes del primer slice con código)

| Prerrequisito | Ref. | Bloquea |
|---|---|---|
| DEP-11: `live-ops` y `channel-gateway` fuera del harness | OA-01 | SEC-S3 en adelante. SEC-S1 y SEC-S2 son reutilizables también con B |
| ADR-040: enmienda R4-I.1 | OA-02 | SEC-S3 |
| Alcance de la redacción (rango, gracia) | OA-07 | SEC-S1 |
| Un consumidor y dos credenciales en la CIA sintética | OA-06 | SEC-S4 |
| Política de la capacidad de inicio y E1/E2 | OA-04, OA-05 | SEC-S5 |
| Marcadores visibles al modelo | OA-08, OA-11 | SEC-S4 |

---

## 2. Cambios mínimos por repositorio y paquete

| Repositorio / paquete | Cambio | ¿Harness? |
|---|---|---|
| `packages/live-ops` | `InboundContentInspector` (puerto + opción en `ChannelIngressOptions`); `VerificationResponseInspector` (clasificador, normalizador, redactor; función pura + lecturas del store); `SecretBox`; `VerificationConfirmDispatcher`; puertos `VerificationExpectationStore`, `VerificationResponseStore`, `IdentityVerificationConfirmer`; 3 líneas en `ChannelIngress.ingest` | No (DEP-11) |
| `packages/persistence-postgres` | Migración `0011_identity_verification_channel.sql` (2 tablas, índices, CHECK); métodos en `production-store.ts` o en un `verification-store.ts` hermano: `activeExpectation`, `openExpectation`, `markIssued`, `closeExpectation`, `recordInboundWithVerificationResponse`, `claimNextVerificationResponse`, `recordConfirmAttempt`, `resolveVerificationResponse`, `sweepVerification` | No (infraestructura) |
| `apps/channel-gateway` | Composición: flag `R4_GATEWAY_VERIFICATION` (por defecto `false`), carga de claves y credencial, arranque del despachador junto a `DeliveryDispatcher`, guardia de arranque (AT-27). `GatewayBindings` gana un campo opcional `verification` | No |
| `adapters/domains/identity/http` | `CiaVerificationConfirmClient` + `loadCiaConfirmConfig` (variables propias, loopback y `synthetic-` en este alcance, `real` rechazado); `CiaVerificationStartClient` junto a `resolve`. Esquemas `verification-start.v1` y `verification-confirm.v1` fijados por SHA a CIA `7525395` | No |
| `agents/sales` | `identity.start_verification@1` (escritura gobernada, `strictObject {email}`), registrada **solo** en `customer-synthetic.ts`; instrucciones del pack para pedir el email y el código; mitigación RR-1 en una versión nueva de las capacidades `customer.*` (análisis RR-1 §6) | No |
| `tests/` | Unit (clasificador, `SecretBox`, despachador con doble de la CIA), contract (fronteras AT-19, contratos CIA), integration (`LiveOpsTestbed`), interop (CIA sintética), mutation (controles críticos) | — |
| Kernel y Core (`agent-kernel`, `task-runtime`, `capability-runtime`, `context-compiler`, `model-gateway`, `policy-engine`, `contracts`, `observability`) | **Ninguno** | — |
| CIA | **Ninguno en código.** Configuración sintética: credencial `channel-integration` para `r4-sales` (ya existe en `tests/interop/support/cia-synthetic-instance.mjs:30-38`). Aclaración documental del contrato §2 (OA-06), por mandato de la CIA | — |
| CP | **Ninguno** | — |

---

## 3. Slices

| Slice | Contenido | Pruebas de cierre | Depende de |
|---|---|---|---|
| **SEC-S1** Clasificador | `VerificationResponseInspector` como función pura `classify(text) → {redacted, candidates[]}`, normalización y neutralización de marcadores. Sin conexión a la ingesta | AT-02 completa (unit). Mutaciones: quitar NFKC, quitar `\p{Nd}`, aceptar 2 candidatos. Las tres deben hacer fallar AT-02 | OA-07 |
| **SEC-S2** Persistencia y cifrado | Migración `0011`, store, `SecretBox` (AES-256-GCM, `key_id`, AAD), barrido | AT-20, AT-15, AT-13 (parte de base). Integración Postgres. Prueba de rotación de claves | SEC-S1 |
| **SEC-S3** Inspección en la ingesta | Opción `inspector` en `ChannelIngress` y composición del gateway tras el flag (por defecto apagado). Captura en una transacción | AT-01, AT-03, AT-04, AT-07, AT-08, AT-10, AT-11, AT-12 (sin la CIA), AT-18, AT-27. **Regresión completa sin inspector, byte a byte idéntica** (suites `integration` y `sales`) | SEC-S2, OA-01, OA-02 |
| **SEC-S4** Confirmación diferida | `CiaVerificationConfirmClient`, `VerificationConfirmDispatcher`, reanudación con marcador | AT-05, AT-06, AT-09, AT-14, AT-16, AT-17, AT-29, AT-30, AT-31 (doble de la CIA con I01–I10); AT-25 (interop) | SEC-S3, OA-06, OA-08, OA-11 |
| **SEC-S5** Inicio gobernado | `identity.start_verification@1`, `CiaVerificationStartClient`, expectativa `created` → `awaiting_code`, composición sintética | AT-21, AT-22, AT-23, AT-24, AT-26 | SEC-S4, OA-04, OA-05 |
| **SEC-S6** RR-1 | Revalidación en las capacidades `customer.*` (versión nueva) y en el despachador | RR1-T01…T08 (análisis RR-1 §6) | SEC-S5 (para el despachador); independiente para `customer.*` |
| **SEC-S7** Campaña E2E sintética | Webhook firmado sintético → gateway → CIA sintética (buzón falso) → `confirm` → `resolve` → CP sintético, sin WhatsApp real | AT-12 (barrido N-15 completo), 3 ejecuciones limpias, una sobre un clon limpio | SEC-S1…S6 |

**Paralelismo:**
- SEC-S1 y SEC-S2 pueden avanzar antes de DEP-11, porque B también los necesitaría.
- La parte `customer.*` de SEC-S6 puede ir antes que todo lo demás.

---

## 4. Especificación del worker (`VerificationConfirmDispatcher`)

### 4.1 Proceso y ciclo

- Corre en el proceso `channel-gateway`, junto al `DeliveryDispatcher`.
  - Es el único proceso con `R4_PROD_VERIFICATION_CODE_KEYS` y `R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN`.
- **Ciclo:** `claim → recheck → open → confirm → record → notify`, con sondeo de 250 ms y un impulso en proceso tras cada captura. La latencia típica queda por debajo de 1 s sin bloquear el webhook.
- **Concurrencia:** hasta N respuestas en paralelo (configurable, por defecto 4), **nunca dos de la misma expectativa**.

### 4.2 Reclamo y lease

```sql
-- 1) Bloquear una expectativa con trabajo pendiente, sin esperar a otras réplicas
select e.* from verification_expectations e
 where e.state in ('created','awaiting_code','processing')
   and exists (select 1 from verification_responses r
                where r.expectation_id = e.expectation_id and r.state in ('pending','dispatching')
                  and r.next_attempt_at <= clock_timestamp()
                  and (r.state = 'pending' or r.lease_expires_at < clock_timestamp()))
 order by e.created_at
 for update skip locked limit 1;
-- 2) Tomar la respuesta MÁS ANTIGUA (received_seq) de esa expectativa, lease 30 s, generation+1,
--    attempts+1, expectativa → processing (version+1); todo en la misma transacción.
```

Las escrituras del resultado exigen `lease_owner` y `lease_generation` iguales a los del reclamo (fencing). Si no coinciden, el resultado se descarta (otra réplica lo reclamó) y la idempotencia de la CIA garantiza que no hubo doble intento.

### 4.3 Revalidación antes de llamar (RR-1 en el despachador)

**Antes de abrir el cifrado:**

| Condición | Si falla |
|---|---|
| La expectativa sigue siendo la viva de su conversación | `cancelled(challenge_replaced)` |
| `verification_id` no es nulo | Si la expectativa sigue en `created`: devolver a `pending` con `next_attempt_at` +2 s. A partir de `created_at + 600 s`: `expired` |
| `now < deadline_at - 5 s` | `expired` (marcador `challenge_expired` o `unavailable`, según la causa) |
| Binding `open` e igual a `expectation.binding_id`; tarea no terminal, sin `terminalIntent` | `cancelled(binding_not_current)`, **sin llamar a la CIA** |

Las ventanas que siguen abiertas después de esta comprobación se analizan en RR-1 §5.3.

### 4.4 Llamada

- `POST /v1/identity/verifications/confirm`:
  - `Authorization: Bearer <channel-integration>`;
  - `idempotency-key: vr.<sha256hex(channel ‖ 0x00 ‖ providerEventId)[0..64]>`, que cumple `^[A-Za-z0-9._:-]{16,128}$`;
  - `x-correlation-id: verification-<responseId>`;
  - cuerpo `{schemaVersion: 1, context, verificationId, code}`.
- `context` = `{channel, channelAccountRef: binding.account_ref, subjectRef: binding.recipient_ref, sessionRef: binding_id, subjectAssurance: 'provider_signed'}`, leído del binding de la expectativa. Es **el mismo en cada reintento**: la CIA calcula el fingerprint sobre el cuerpo completo (JCS) y un cambio daría 409 `idempotency_conflict`.
  - Depende de que `account_ref` y `recipient_ref` del binding no cambien. Hoy no hay trigger que lo garantice: se propone el trigger de inmutabilidad ya sugerido en ADR-038:312 (fuera de este plan) y una prueba que lo verifique.
- `timeout` de 3 s, `redirect: 'manual'` y sin reintentos dentro del cliente: los gobierna el despachador.

### 4.5 Semántica de respuestas, reintentos y recuperación

| Respuesta de la CIA | Clase | Respuesta capturada | Expectativa | Reintento | Marcador a la tarea |
|---|---|---|---|---|---|
| 200 `linked` | outcome | `resolved` | `confirmed` | — | `outcome=linked` |
| 200 `no_eligible_account` / `ineligible_account` / `ambiguous` / `conflicted` | outcome | `resolved` | `rejected` | — | `outcome=<x>` |
| 200 `invalid_code` (n > 0) | outcome | `resolved` | `awaiting_code` (`attempts_remaining = n`) | No (es un intento consumido) | `outcome=invalid_code; attempts_remaining=n` |
| 200 `invalid_code` (0) / `locked` | outcome | `resolved` | `rejected` | — | `outcome=<x>` |
| 200 `expired` | outcome | `resolved` | `expired` | — | `outcome=expired` |
| 409 `operation_in_progress` | retryable | `pending` | sin cambio | Tras `Retry-After` (≤ 30 s), misma clave | — |
| 429 `rate_limited` | retryable | `pending` | sin cambio | Backoff, misma clave (la CIA no crea registro antes de reservar, AMEND-S1-01) | — |
| 503 `dependency_unavailable` | retryable | `pending` | sin cambio | Backoff, misma clave (I03: nada consumido) | — (el agente ya dijo "procesando"; contrato §5.2) |
| Timeout, red o 5xx sin cuerpo válido | retryable | `pending` | sin cambio | Backoff, misma clave (la CIA deduplica 24 h) | — |
| 400 `invalid_request` | terminal | `failed` | `cancelled(confirm_invalid_request)` | No. Alerta: bug o deriva del contrato | `not_processed; reason=unavailable` |
| 401 / 403 | terminal | `failed` | `cancelled(confirm_not_authorized)` | No. Alerta de configuración. **Disyuntor:** 3 respuestas 401/403 seguidas pausan el despachador 5 min | `not_processed; reason=unavailable` |
| 409 `idempotency_conflict` | terminal | `failed` | `cancelled(confirm_idempotency_conflict)` | No. Alerta: error de programación | `not_processed; reason=unavailable` |
| Respuesta que no valida el esquema | terminal | `failed` | `cancelled(confirm_unexpected_response)` | No | `not_processed; reason=unavailable` |
| `deadline_at` agotado con reintentos pendientes | — | `expired` | `expired` | — | `not_processed; reason=unavailable` |

**Backoff:**
- `min(500 ms · 2^attempt, 10 s)` con jitter completo, o `Retry-After` si existe.
- No se programa ningún intento después de `deadline_at - 5 s`. El tope práctico es de unos 60 intentos en 600 s.

**Cada transición de salida de `pending|dispatching` anula el cifrado en la misma sentencia** (CHECK, §5.2 de la decisión).

### 4.6 Reanudación de la tarea

Tras registrar el resultado (`resolved`) y en una transacción posterior:

```ts
temporal.submitInput(expectation.taskId,
  { externalKey: `verification-outcome:${responseId}`, content: marker, sourceRef: 'platform:identity-verification', occurredAt: now },
  { kind: 'system', ref: 'platform:identity-verification' }, `verification-${responseId}`);
```

**Errores posibles:**
- `task_not_accepting_input` o `task_terminal`: `notified` con `failure_code = 'task_terminal'`, sin reintento.
- Cualquier otro error: el barrido lo reintenta, idempotente por `externalKey`.

**Solo reanuda la tarea:**
- la respuesta de la expectativa **viva o recién cerrada por ella misma**;
- un resultado de una expectativa reemplazada se registra sin reanudar.

### 4.7 Barrido (cada 30 s, en el gateway)

1. Expectativas `awaiting_code|processing` con `challenge_expires_at ≤ now` pasan a `expired`, y sus respuestas `pending` a `expired`, con el cifrado anulado.
2. Expectativas `created` con `created_at + 600 s ≤ now` pasan a `expired`.
3. Respuestas `dispatching` con lease vencido: no hace nada, porque las recoge el siguiente reclamo.
4. Respuestas `resolved` sin `notified` de más de 10 s: reintentar la reanudación.
5. Se borran las filas con `purge_after ≤ now`. Las expectativas cerradas hace más de 24 h se borran o se compactan según D7.

---

## 5. Rollback

| Nivel | Acción | Efecto |
|---|---|---|
| 1. Detener nuevos inicios | Quitar `identity.start_verification@1` de la composición (o un kill switch por capacidad) | No se crean expectativas. Las vivas siguen protegidas |
| 2. Drenaje | Esperar a que `max(redact_until)` de las expectativas vivas sea pasado: como máximo 20 min | Ningún código pendiente de redacción ni de confirmación |
| 3. Apagar el inspector y el despachador | `R4_GATEWAY_VERIFICATION=false` | `ChannelIngress` vuelve a ser byte a byte la actual. El gateway **se niega a arrancar** sin inspector si quedan expectativas vivas (AT-27), salvo `R4_GATEWAY_VERIFICATION_FORCE_OFF=true` documentado |
| 4. Esquema | La migración `0011` es aditiva. Sus tablas pueden quedar vacías. No se requiere migración inversa | Sin pérdida de datos conversacionales |

**Rollback de emergencia** (fuga sospechada):
1. Nivel 1 y nivel 3 con `FORCE_OFF`.
2. `UPDATE verification_responses SET state='cancelled', code_ciphertext=NULL, … WHERE state IN ('pending','dispatching')`.
3. Rotar la clave y la credencial `confirm`.
4. Los desafíos de la CIA expiran solos en 10 min.

---

## 6. Controles de proceso en cada slice

- `git diff --stat main -- packages/agent-kernel packages/task-runtime packages/capability-runtime packages/context-compiler packages/model-gateway packages/policy-engine packages/contracts packages/observability` **vacío** (R4_HARNESS_UNCHANGED).
- La capacidad de inicio y las versiones nuevas de `customer.*` se registran solo en `customer-synthetic.ts`. La prueba de frontera `customer-http-contract.test.ts:172-185` se amplía para cubrirlas (R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED).
- `R4_CUSTOMER_MODE=real` sigue rechazado también en los clientes nuevos de `start` y `confirm` (CUSTOMER_REAL_DATA_ACCESS_BLOCKED).
- Regresión completa (`unit`, `contract`, `integration`, `sales`, `shadow`), además de `interop` en SEC-S4, SEC-S5 y SEC-S7.
  - No ejecutar campañas en paralelo con `test:recovery`.
  - La CIA limita el reenvío del OTP por sujeto (60 s) y por email (5/día).

---

## 7. Dependencias externas

| Dependencia | Owner | Necesaria para |
|---|---|---|
| Credencial `channel-integration` de `r4-sales` en la CIA | CIA (D1) | SEC-S4 (sintética), datos reales (productiva) |
| Aclaración del contrato §2 (un consumidor, dos credenciales) | CIA | SEC-S4 |
| AMEND-S1-01 incorporado al texto de v1-d2 §4.1 (el orden de los límites de tasa) | CIA | Coherencia documental; el código ya lo cumple |
| Proveedor de correo real (DEP-5), custodia de claves (DEP-6), legal (DEP-10) | CIA + operación | Datos reales |
| Política de datos personales del email y retención (D7) | Owner de datos | E1 con datos reales |
| G-16, AP-01…AP-11 | CP | Datos reales (no se resuelven aquí) |
| DEP-13 (WhatsApp Flows u override del webhook) | Owner del número | Solo C o B |
| Custodia de `R4_PROD_VERIFICATION_CODE_KEYS` en EC2 y revisión de nginx/PM2 | Operación R4 | Datos reales (OA-10) |

---

## 8. Fuera de alcance

- Activación productiva, `sales-production@8`, datos reales, OTP reales y despliegue.
- La alternativa C (Flows) y la variante E2 del email, salvo que se aprueben.
- Cambios en el harness, incluidos la señal de cancelación hacia las capacidades y la marca visual de entradas de plataforma.
- Resolver G-16, AP-*, D7 o RR-1 por implicación. RR-1 tiene su propio gate.
