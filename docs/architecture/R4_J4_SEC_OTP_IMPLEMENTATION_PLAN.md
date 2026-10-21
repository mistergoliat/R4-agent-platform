# R4-J4-SEC-OTP — Plan de implementación incremental

| Campo | Valor |
|---|---|
| Mandatos | `R4-J4-SEC-OTP-DESIGN-01` · `R4-J4-SEC-OTP-DESIGN-OWNER-REVISION-02` |
| Fecha | 2026-10-21 |
| Para | Owner de R4 (autorización de slices) e implementadores |
| Base | `R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md` (revisión 02) · `R4_J4_SEC_OTP_THREAT_MODEL.md` · `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` |
| Estado | **Plan. Nada implementado** (`SEC_OTP_IMPLEMENTATION_NOT_STARTED`). Cada slice exige autorización explícita, sigue siendo sintético y entrega su evaluación junto con la implementación |

---

## 1. Decisiones ya tomadas y prerrequisitos

| Ref. | Estado | Bloquea |
|---|---|---|
| OA-01 frontera, OA-03 alternativa A | **Decididos** | — |
| OA-02 contenido de ADR-040 / R4-I.1 | **Decidido.** El archivo ADR se redacta en SEC-S3 | — |
| OA-06 un consumidor y dos credenciales | **Decidido.** CIA-CLAR-01 pendiente (no bloquea el sintético) | — |
| OA-07 rangos, gracia y separación `redact`/`submit` | **Decidido** (sintético) | — |
| OA-07b lista permitida `CODE_CONTEXT` | Pendiente (hay propuesta) | SEC-S1 (cierre) |
| OA-08 / OA-11 marcadores y `role: participant` | Pendientes | SEC-S4 |
| OA-04 / OA-05 política del email y del inicio | Pendientes | SEC-S5 |
| OA-12 respuesta comercial sin landing | Pendiente | SEC-S5 |
| OA-09 gate RR-1 | Pendiente | Activación real |

---

## 2. Cambios mínimos por repositorio y paquete

| Paquete | Cambio | ¿Sabe de OTP o CIA? | ¿Harness? |
|---|---|---|---|
| `packages/live-ops` | `InboundInspector` v1, `TrustedChannelContext` e `InspectionDecision` (`channel.ts`). Opción `inspector` en `ChannelIngressOptions`. `ingest` usa la transacción inspeccionada cuando hay inspector. `conversationLockKey(channel, key)`. Guardia genérica `assertInspectorRemovable` (llama a `protectionActive`) | **No** | No (OA-01) |
| `packages/persistence-postgres` | `recordInboundInspected(event, ctx, inspector)` en `production-store.ts`: transacción, `pg_advisory_xact_lock`, duplicado antes de inspeccionar, lectura de binding y `taskState` en la transacción, inserción con el texto decidido. Expone el ejecutor de la transacción como `Tx` opaco | No | No |
| **Nuevo** `adapters/domains/identity/verification` (`@r4-adapters/identity-verification`) | Clasificador y normalizador; política `redact`/`submitForConfirmation`; `VerificationInspector` (implementa `InboundInspector`); esquema `identity_verification` con migraciones propias; `SecretBox`; stores de expectativas y respuestas; `VerificationConfirmDispatcher`; barrido; modos `full`/`protect_only`; puerto de lectura de estado | Sí | No |
| `adapters/domains/identity/http` | `CiaVerificationConfirmClient` + configuración propia (credencial `channel-integration`, loopback y `synthetic-`, `real` rechazado); `CiaVerificationStartClient` junto a `resolve`. Esquemas `verification-start.v1` y `verification-confirm.v1` fijados por SHA a CIA `7525395` | Sí | No |
| `apps/channel-gateway` | Composición: inspector y despachador en el modo configurado; guardia de arranque (sin override); arranque en `protect_only` si falta la clave o la credencial | Solo composición | No |
| `agents/sales` | `identity.start_verification@1` (escritura gobernada `{email}`); `identity.verification_status@1` (lectura sin argumentos); mapeo puro `CommercialVerificationStatus` (incluido `onboarding_required`); instrucciones; versiones nuevas de `customer.*` con revalidación RR-1. Todo registrado **solo** en `customer-synthetic.ts` | Solo estado comercial | No |
| `tests/` | unit, contract (fronteras AT-19, AT-ALT-01, contratos de la CIA), integration (`LiveOpsTestbed`, RX, AT-TR), interop (CIA sintética), mutation | — | — |
| Harness (`agent-kernel`, `task-runtime`, `capability-runtime`, `context-compiler`, `model-gateway`, `policy-engine`, `contracts`, `observability`) | **Ninguno** | — | — |
| CIA / CP | **Ninguno.** Configuración sintética de la credencial `channel-integration` (ya existe en `tests/interop/support/cia-synthetic-instance.mjs:30-38`) | — | — |

---

## 3. Slices SEC-S1 a SEC-S7 (actualizados)

| Slice | Contenido | Pruebas de cierre | Depende de |
|---|---|---|---|
| **SEC-S1** Clasificación | Paquete `identity-verification` (solo lógica pura): normalización, candidatos, `redact(candidate)`, `submitForConfirmation(candidate, context)`, lista permitida, neutralización de marcadores, fallo cerrado | AT-02 completa (positivos, negativos de envío, negativos de redacción, grupo, fallo cerrado). Mutaciones: quitar NFKC, quitar `\p{Nd}`, permitir 2 candidatos, permitir una palabra fuera de la lista. Las cuatro deben hacer fallar AT-02 | OA-07 (decidido), OA-07b |
| **SEC-S2** Estado y cifrado | Esquema `identity_verification` (CHECK corregidos + trigger de terminalidad), stores, `SecretBox`, barrido, `protectionActive` | AT-TR-01…13, AT-20, AT-15 (parte de base), rotación de claves | SEC-S1 |
| **SEC-S3** Punto de inspección genérico | Puerto v1 en `live-ops`; `recordInboundInspected` con lock y duplicado previo; composición del gateway; guardia sin override; modos `full`/`protect_only`. **Archivo ADR-040** | RX-01…RX-08, AT-01, AT-03, AT-04, AT-07, AT-08, AT-10, AT-11, AT-18, AT-19, AT-27, AT-27b, AT-27c, AT-29b. **Regresión completa sin inspector, idéntica** (`integration`, `sales`, `shadow`) | SEC-S2 |
| **SEC-S4** Confirmación diferida | Cliente `confirm`; despachador (reclamo, revalidación `V`, llamada, registro bajo lock, reanudación con `[identity verification update available]`) | AT-05, AT-06, AT-09, AT-14, AT-16, AT-17, AT-29, AT-30, AT-31 (doble de la CIA I01–I10); AT-25 (interop); RR1-T07/T08 | SEC-S3, OA-08, OA-11 |
| **SEC-S5** Capa comercial | `identity.start_verification@1`, `identity.verification_status@1`, mapeo comercial con `onboarding_required`, instrucciones (ofrecer sin redirigir; sin URL mientras `available = false`) | AT-ONB-01…07, AT-21, AT-22, AT-23, AT-24, AT-26, RR1-T09 | SEC-S4, OA-04, OA-05, OA-12 |
| **SEC-S6** RR-1 | Versiones nuevas de `customer.*` con `V` en T1/T2'/T4' | RR1-T01…T06 + mutaciones | Ninguna (puede ir antes) |
| **SEC-S7** Campaña E2E sintética | Webhook firmado sintético → gateway → CIA sintética (buzón falso) → `confirm` → `resolve` → CP sintético; además, un camino `no_eligible_account` → `onboarding_required` → cuenta sintética creada en el proveedor falso de la CIA → nuevo desafío → `linked` | AT-12 (barrido N-15 en ambos caminos), AT-ONB-06, AT-ALT-01; 3 ejecuciones limpias, una desde un clon limpio | S1–S6 |

**Fuera de los slices** (gates de activación real):
- BA-01 a BA-06;
- OA-10;
- EXT-02, EXT-03, EXT-05 y EXT-07.

---

## 4. Especificación del worker (`VerificationConfirmDispatcher`)

### 4.1 Proceso y ciclo

- Pertenece al paquete de verificación y lo **compone y ejecuta** el proceso `channel-gateway`, el único con `R4_PROD_VERIFICATION_CODE_KEYS` y `R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN`.
- **Ciclo:** `claim → revalidar V → abrir → confirm → registrar (bajo el lock de la conversación) → reanudar`.
- **Ritmo:** sondeo de 250 ms con impulso en proceso tras cada captura.
- **Concurrencia:** N en paralelo (por defecto 4), nunca dos de la misma expectativa.
- **En `protect_only`** el despachador no reclama: cancela las `pending` (borrando el cifrado) y termina.

### 4.2 Reclamo, lease y fencing

```sql
-- TX corta (sin lock consultivo: no decide contenido persistible)
select e.expectation_id from identity_verification.expectations e
 where e.state in ('created','awaiting_code','processing')
   and exists (select 1 from identity_verification.responses r
                where r.expectation_id = e.expectation_id and r.state in ('pending','dispatching')
                  and r.next_attempt_at <= clock_timestamp()
                  and (r.state = 'pending' or r.lease_expires_at < clock_timestamp()))
 order by e.created_at for update of e skip locked limit 1;
-- luego: la respuesta más antigua (received_seq) → dispatching, lease 30 s, generation+1, attempts+1;
--        expectativa → processing (version+1). COMMIT. Ningún lock queda retenido durante la llamada.
```

El registro del resultado se hace en una transacción nueva:
1. `pg_advisory_xact_lock(conversationLockKey)`;
2. comprobar `lease_owner`/`lease_generation` y `version`/estado de la expectativa;
3. aplicar las transiciones.

Si el fencing falla, se descarta lo local: la idempotencia de la CIA evita el doble intento.

### 4.3 Revalidación antes de abrir el cifrado

| Condición | Si falla |
|---|---|
| La expectativa sigue siendo la viva de su conversación | `cancelled(challenge_replaced)` |
| `verification_id` no nulo | En `created`: devolver a `pending`, +2 s. Pasados `created_at + 600 s`: `expired` |
| `now < deadline_at - 5 s` | `expired` |
| `V(task_id, binding_id)`: binding `open` e igual; tarea no terminal y sin `terminalIntent` (RR-1 §4) | `cancelled(binding_not_current)`, **sin llamar a la CIA** |

### 4.4 Llamada

- `POST /v1/identity/verifications/confirm`;
- `Authorization: Bearer <channel-integration>`;
- `idempotency-key: vr.<sha256hex(channel ‖ 0x00 ‖ providerEventId)[0..64]>`;
- `x-correlation-id: verification-<responseId>`;
- cuerpo `{schemaVersion: 1, context, verificationId, code}`.

El `context` sale del binding de la expectativa (`channel`, `accountRef`, `recipientRef`, `bindingId`, `subjectAssurance: 'provider_signed'`) y es **idéntico** en cada reintento: el fingerprint JCS de la CIA lo exige.
- Depende de que las columnas de identidad del binding no cambien. Se propone el trigger de inmutabilidad de ADR-038:312 en un mandato propio (RR-1, R-4).

Timeout de 3 s, `redirect: 'manual'` y ningún reintento interno.

### 4.5 Respuestas, reintentos y recuperación

| Respuesta de la CIA | Respuesta capturada | Expectativa (`cia_outcome`) | Reintento |
|---|---|---|---|
| 200 `linked` / `no_eligible_account` / `ineligible_account` / `ambiguous` / `conflicted` | `resolved` | `confirmed` (outcome) | — |
| 200 `invalid_code` (n > 0) | `resolved` | `awaiting_code` (`attempts_remaining = n`) | No |
| 200 `invalid_code` (0) / `locked` | `resolved` | `rejected` | — |
| 200 `expired` | `resolved` | `expired` | — |
| 409 `operation_in_progress` | `pending` | sin cambio | Tras `Retry-After` (≤ 30 s), misma clave |
| 429 / 503 / timeout / red / 5xx | `pending` | sin cambio | Backoff `min(500 ms·2^n, 10 s)` con jitter, misma clave, nunca después de `deadline_at - 5 s` |
| 400 / 401 / 403 / 409 `idempotency_conflict` / esquema inválido | `failed` | `cancelled(confirm_<code>)` | No. Alerta. Disyuntor: 3 respuestas 401/403 seguidas pasan a `protect_only` hasta que intervenga un operador |
| `deadline_at` agotado | `expired` | `expired` (estado comercial `verification_unavailable`) | — |

**Toda salida de `pending|dispatching` anula el cifrado en la misma sentencia** (CHECK `secret_only_while_open`).

### 4.6 Reanudación

Tras registrar el resultado y **solo** si la expectativa era la vigente:

```ts
temporal.submitInput(taskId,
  { externalKey: `verification-update:${responseId}`, content: '[identity verification update available]',
    sourceRef: 'platform:identity-verification', occurredAt: now },
  { kind: 'system', ref: 'platform:identity-verification' }, `verification-${responseId}`);
```

- `task_not_accepting_input` / `task_terminal` → `notified(task_terminal)`.
- Cualquier otro error → reintento del barrido (idempotente por `externalKey`).
- El modelo obtiene el estado con `identity.verification_status@1`.

### 4.7 Barrido (cada 30 s, en el gateway)

Cada transición de expectativa toma el lock de su conversación.
1. `awaiting_code|processing` con `challenge_expires_at ≤ now` → `expired`, con sus `pending` expiradas y el cifrado anulado.
2. `created` con `created_at + 600 s ≤ now` → `expired`.
3. `resolved` sin `notified` de más de 10 s → reintentar la reanudación.
4. Borrar las respuestas con `purge_after ≤ now`.
5. Borrar o compactar las expectativas cerradas con `protect_until` pasado hace más de 24 h, según D7. **Nunca antes de `protect_until`.**

---

## 5. Rollback (sin override de la protección)

| Paso | Acción | Efecto |
|---|---|---|
| 1. Detener los inicios | El pack deja de registrar `identity.start_verification@1` (o un kill switch por capacidad) | No hay expectativas nuevas. La protección sigue |
| 2. Detener la confirmación (opcional) | Modo `protect_only` | Sin capturas nuevas y sin llamadas a la CIA; las `pending` se cancelan con el cifrado borrado. **La redacción sigue** |
| 3. Esperar | Hasta que `protectionActive()` sea falso: todas las `protect_until` pasadas, como máximo unos 20 min tras la última expectativa | — |
| 4. Retirar el inspector | Composición sin inspector (`absent`) | Solo se permite si la guardia confirma que no hay obligación de protección. **No existe `FORCE_OFF`** |
| 5. Esquema | Las migraciones del paquete son aditivas; sus tablas pueden quedar | Sin pérdida de datos conversacionales |

**Emergencia** (fuga sospechada):
1. Pasos 1 y 2 de inmediato.
2. Rotar la clave y la credencial `confirm`.
3. La redacción **continúa**. Los desafíos de la CIA expiran solos en 10 min.

**Fallos** (decisión §9.3):
- inspector: fallo cerrado, o 500 sin persistencia;
- Postgres: 500 y reentrega, como hoy;
- falta de clave o credencial: arranque en `protect_only`.

---

## 6. Controles en cada slice

- `git diff --stat main --` sobre los paquetes del harness, **vacío** (`R4_HARNESS_UNCHANGED`).
- `live-ops` sin términos de OTP, CIA ni nombres de canal (AT-19, ampliando `live-ops-boundaries.test.ts`).
- Las capacidades nuevas solo en `customer-synthetic.ts`; la prueba de frontera `customer-http-contract.test.ts:172-185` se amplía.
- `R4_CUSTOMER_MODE=real` rechazado también en los clientes `start` y `confirm` (`CUSTOMER_REAL_DATA_ACCESS_BLOCKED`).
- Regresión completa, más `interop` en S4, S5 y S7.
  - No ejecutarla en paralelo con `test:recovery`.
  - Respetar los límites de la CIA: reenvío ≥ 60 s; 5/día por email.

---

## 7. Dependencias externas

| ID | Dependencia | Owner | Necesaria para |
|---|---|---|---|
| EXT-01 | **CIA-CLAR-01**: aclarar el ejemplo del contrato §2 (un consumidor y dos credenciales) e incorporar AMEND-S1-01 a §4.1 | Owner de la CIA | Coherencia documental. No bloquea el sintético |
| EXT-02 | Credencial `channel-integration` productiva de `r4-sales` | CIA (D1) | Datos reales |
| EXT-03 | Correo real (DEP-5), custodia de claves (DEP-6), legal (DEP-10), credencial PrestaShop (DEP-2) | CIA + operación | Datos reales |
| EXT-04 | Política de datos personales del email y retención (D7) | Owner de datos | E1 con datos reales; contrato de la landing |
| EXT-05 | **Landing de onboarding**: owner, contrato (URL, datos que recibe, cómo vuelve el cliente) | Por designar | `onboarding.available = true` |
| EXT-06 | G-16, AP-01…AP-11 | CP | Datos reales (no se resuelven aquí) |
| EXT-07 | Canales sin firma de proveedor (webchat): equivalencia de `subjectAssurance` o revisión del contrato de la CIA | Owner de la CIA + R4 | Cualquier canal no `provider_signed` (**detenido**) |
| EXT-08 | Adaptadores de Instagram y Messenger, con autenticación y pruebas | R4 (mandatos propios) | Declarar esos canales soportados |
| EXT-09 | WhatsApp Flows (DEP-13) | Owner del número | Solo la interfaz opcional C |

---

## 8. Gates pendientes

| Gate | Estado |
|---|---|
| SEC-OTP-01 / SEC-OTP-02 | Pendientes de implementación (S1 a S7) |
| RR-1 (`GATE_RR1`) | Cerrado. Independiente: **no se resuelve porque SEC-OTP funcione** |
| BA-01 a BA-06 (entradas alternativas) | Cerrados. Bloquean la activación real |
| G-16, AP-*, D7 | Pendientes; cada uno con su mandato |
| `SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING` | **Dependencia de SEC-S3** (owner, `R4-J4-SEC-S1-OWNER-MERGE-05`): los formatos numéricos no detectados por SEC-S1 (informe S1 §9) se evalúan antes de conectar el inspector a tráfico real. No se declara `OTP_LEAKAGE_IMPOSSIBLE`. Con una obligación de protección y contenido no determinable con seguridad, la inspección falla cerrada |
| OA-04, OA-05, OA-07b, OA-08, OA-09, OA-10, OA-11, OA-12 | Pendientes |
| EXT-05 (landing), EXT-07 (webchat) | Pendientes y fuera de R4 |
| Datos reales | **Bloqueados** |
