# R4-J4 SEC-S4 — Informe: confirmación diferida en la CIA

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06` (§2 Frente A, SEC-S4) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-otp-front-a`, sobre SEC-S3 (`f0dd38d`) |
| Alcance | **Solo SEC-S4:** cliente `confirm` de la CIA (credencial `channel-integration`), despachador en el gateway (reclamo, lease, fencing, idempotencia, revalidación V, reintentos, disyuntor, reanudación sin resultado, barrido), trazabilidad de resultados descartados. **Sin** capacidades (S5), cambios en CIA, CP, contratos ni harness |

```text
SEC_S4_CIA_CONFIRM_DISPATCH_IMPLEMENTED
SEC_S4_SYNTHETIC_VALIDATION_PASS
CIA_V1_D2_CONTRACT_UNCHANGED
R4_HARNESS_UNCHANGED
GATE_RR1_PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

---

## 1. Qué implementa

| Pieza | Ubicación | Contenido |
|---|---|---|
| Esquema de `confirm` fijado | `adapters/domains/identity/http/contract/schemas/verification-confirm.v1.schema.json` y 13 fixtures `verification-confirm/*` | Copia byte a byte de CIA `7525395` (`contract/cia/v1/...`). `SOURCE.json` registra sha256, contentSha256 y blob de git; los blobs coinciden con los de la CIA |
| Configuración | `loadCiaVerificationConfirmConfig(env)` (`identity-http/src/config.ts`) | `R4_CUSTOMER_MODE=synthetic` (con `real` **rechazado**), CIA solo en loopback, `R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN` sintético, plazo fijo de 3 s |
| Cliente | `CiaVerificationConfirmClient` (`identity-http/src/confirm.ts`) | Un intento por llamada, `redirect: 'manual'`, tope de 16 KiB y validación cerrada de petición y respuesta. Clasificación del plan §4.5: `outcome` (200), `retry` (409 `operation_in_progress` con `Retry-After` ≤ 30 s, 429, 5xx, red, plazo) o `refused` (400, 401/403 con `credentialRejected`, 409 `idempotency_conflict`, 3xx, fuera de contrato). La telemetría no lleva código, `verificationId`, sujeto, token ni cuerpo |
| Despachador | `VerificationConfirmDispatcher` (`identity-verification/src/dispatcher.ts`) | Ciclo `claim → plazo → V → abrir → confirm → registrar → reanudar`. Puertos estructurales: el paquete no importa `identity-http` |
| Composición | `identityVerificationInspection({ requested, codeKeys, confirm })` | En `full` crea el despachador con el cliente que entrega la composición. Sin cliente arranca en `protect_only` (`confirm_credential_unavailable`). `start` / `stop` corren con el gateway |
| Store | `abandonClaim`, `recordDiscardedOutcome`, `resolvedAwaitingResume`; `ResponseClaim.deadlineAt` | Todas con fencing y bajo el lock de la conversación |
| Traza no sensible | Migración `0013_identity_verification_discarded_outcomes.sql` | Condición especial del mandato (§3) |

### 1.1 Revalidación antes de abrir el código (plan §4.3; RR-1 §5.2)

| Condición | Si falla |
|---|---|
| `now < deadline_at − 5 s` | `expired`: `confirm_unavailable` si un intento anterior no obtuvo respuesta; `challenge_expired` si no |
| `V(task, binding)`: el binding de la tarea es el de la expectativa, está `open`, con el mismo canal y cuenta; la tarea no es terminal, no tiene `terminalIntent` ni es `humanOwned` (OA-09) | `cancelled(binding_not_current)`, **sin llamar a la CIA**, con el cifrado borrado |
| Apertura del sellado | `failed(unknown_key | decrypt_failed)` + alerta, sin llamada |

El `context` sale del binding (`channel`, `channelAccountRef = accountRef`, `subjectRef = recipientRef`, `sessionRef = bindingId`, `subjectAssurance: provider_signed`). Es idéntico en cada reintento, igual que la `idempotency-key` (`vr.<sha256(channel‖providerEventId)>`).

### 1.2 Resultados y reintentos (plan §4.5)

| Respuesta | Respuesta capturada | Expectativa | Siguiente |
|---|---|---|---|
| 200 resultado de consumo | `resolved` (cifrado borrado) | `confirmed` | Reanudar |
| 200 `invalid_code` (n > 0) | `resolved` | `awaiting_code` (`attempts_remaining = n`) | Reanudar |
| 200 `invalid_code` (0) / `locked` | `resolved` | `rejected` | Reanudar |
| 200 `expired` | `resolved` | `expired` | Reanudar |
| `retry` | `pending`, `next_attempt_at` = `Retry-After` o `min(500 ms·2ⁿ⁻¹, 10 s)` ± 50 % | Sin cambio | Misma clave; si no cabe antes del plazo, `expired(confirm_unavailable)` |
| `refused` | `failed` | `cancelled(confirm_<code>)` | Alerta. Tres 401/403 seguidos abren el **disyuntor**: el inspector pasa a `protect_only`, el modo durable también, y la redacción continúa |

**Reanudación.** Solo si la expectativa era la vigente: `submitInput(taskId, {externalKey: 'verification-update:<responseId>', content: '[identity verification update available]', sourceRef: 'platform:identity-verification'})` con el actor `system`. El marcador **no lleva resultado** (OA-11): el modelo lo lee con `identity.verification_status@1` (S5). Si la tarea es terminal, la respuesta pasa a `notified` sin despertar nada. Si la reanudación falla, el barrido la reintenta (idempotente por `externalKey`).

**Barrido.** Cada 30 s: expiración, reanudaciones pendientes de más de 10 s y purga.

**Ningún lock se retiene durante la llamada.** El reclamo confirma su transacción antes de la red, y el registro abre otra bajo el lock (RX-08).

---

## 2. Condición especial del mandato: `confirm` en vuelo con la expectativa reemplazada

| Requisito | Implementación | Prueba |
|---|---|---|
| El resultado obsoleto no contamina la expectativa nueva | El reemplazo cancela la respuesta en vuelo y borra su cifrado (trigger S2). El registro con fencing la encuentra cerrada: `stale` | Expectativa nueva con la misma `version`, `cia_outcome = null` y sin reanudación |
| Trazabilidad no sensible de la operación externa | `recordDiscardedOutcome` inserta en `identity_verification.discarded_outcomes` (`response_id`, `expectation_id`, `lease_generation`, `cia_outcome`, `response_state`, `recorded_at`), solo si la respuesta se cerró con **la misma** generación (un lease perdido ante otro despachador no se registra) | La fila existe, con exactamente esas columnas |
| No conservar OTP | La respuesta queda `cancelled` con `code_ciphertext = null`; la traza no tiene columna de código, cifrado, `verificationId`, sujeto ni cliente | Prueba de esquema S2 (sin columna de texto plano) y prueba de la condición |
| No reutilizar grants | `confirm` no devuelve grants (contrato §5.2); nada de S4 llama a `resolve` | — |

**Sin cambio en S2 ni en el contrato de la CIA.** Basta una tabla aditiva (`0013`) y un método del store.

**Residuo (R-3 de RR-1):** si el código era correcto, la CIA pudo crear el vínculo. R4 no lo usa por ese camino: el acceso sigue exigiendo `resolve` por invocación.

---

## 3. Pruebas

| Archivo | Proyecto | Pruebas | IDs |
|---|---|---|---|
| `tests/unit/customer-identity/confirm-client.test.ts` | unit | 22 | Configuración (incluido `real` rechazado), petición fijada y reproducible, clasificación de los 8 resultados y de las respuestas fuera de contrato, reintentables frente a definitivas, sin secretos en la telemetría |
| `tests/integration/identity-verification-dispatch.test.ts` | integration | 22 | Ciclo completo con el webhook real; AT-05, AT-06, AT-09, AT-14, AT-16, AT-17, AT-29, AT-30 (dos), AT-31 (tres), RR1-T07 (binding cerrado, tarea cancelada, `humanOwned`), RR1-T08, RX-08, condición especial, clave desconocida, eventos sin secretos, AT-27c (credencial), disyuntor compuesto, `protect_only` sin captura |
| `tests/contract/identity-verification-boundaries.test.ts` | contract | +2 | AT-19: ningún pack, worker, API, scheduler ni paquete del Core referencia `SecretBox`, `Keyring`, el despachador, el cliente `confirm` ni sus variables; el cliente vive solo en `identity-http` |
| `tests/contract/identity-http-contract.test.ts` | contract | ajustado | Copias byte a byte (ahora 41 archivos); rutas permitidas: `resolve` y `verifications/confirm`; la ruta `confirm` nunca usa la credencial `agent` |
| `tests/contract/alternative-inputs-inventory.test.ts` | contract | ajustado | El despachador es un llamador de `submitInput` inventariado (solo el marcador de plataforma) |

**La CIA de estas pruebas es un doble en proceso** con la semántica de idempotencia del contrato (I06: una clave aplicada devuelve la primera respuesta). AT-25 (credencial cruzada → 403) y la CIA real son parte de SEC-S7 (interop).

### 3.1 Resultados

| Comprobación | Resultado |
|---|---|
| `build`, `typecheck`, `lint` (`--max-warnings=0`) | OK |
| `unit` | 82 archivos (1 omitido) · **1 453 PASS**, 4 skip, 0 FAIL. Antes 1 431; +22 (cliente `confirm`) |
| `contract` | 31 archivos · **413 PASS**, 0 FAIL. Antes 411; +2 (AT-19 de S4). `identity-http-contract` ajustado a 41 copias y a las rutas `resolve` + `confirm` |
| `integration` (en paralelo) | 40 archivos (1 omitido) · **561 PASS**, 1 FAIL, 12 skip. El fallo fue `worker-readiness` ("graceful shutdown…"), un caso de tiempos sin relación que ya fallaba por carga en el head del PR #16. **Corrida en serie del archivo: 18/18.** Combinado: **562 PASS, 0 fallos reales**. Antes 540; +22 (`identity-verification-dispatch`) |
| `sales` / `shadow` | **29/29** / **5/5** |
| Mutaciones SEC-S4 (`test:mutation:identity-verification-dispatch`) | **11/11** detectadas (incluida la obligatoria RR1-T07), fuentes restauradas |
| Mutaciones SEC-S3 / SEC-S1 / SEC-S2 | **13/13**, **23/23**, **16/16** |

**Mutaciones SEC-S4:** M1 (RR1-T07) sin revalidación V; M2 `humanOwned` ignorado; M3 un reintento que no cabe antes del plazo se programa igual (se gastaría un reclamo sin intento en la CIA). La primera corrida mostró que M3 sobrevivía: el reclamo siguiente también expira. Se reforzó AT-30 con "intentos registrados = llamadas a la CIA". M4 sin traza del resultado descartado; M5 el marcador de reanudación lleva otro texto; M6 una clave nueva en el reintento; M7 el disyuntor nunca abre; M8 una tarea terminal nunca se liquida; M9 un 401/403 se reintenta; M10 el cliente sigue redirecciones; M11 la telemetría lleva el código.

---

## 4. Riesgos y limitaciones

| # | Riesgo | Estado |
|---|---|---|
| R4-01 | Vínculo creado por un `confirm` en vuelo cuando la sesión terminó o la expectativa fue reemplazada (RR-1 R-3) | Registrado en `discarded_outcomes`; pendiente de aceptación del owner (gate RR-1) |
| R4-02 | El disyuntor deja el componente en `protect_only` hasta que un operador lo recomponga. No hay reapertura automática | Por diseño (plan §5, emergencia) |
| R4-03 | La reanudación no aplica las retenciones del kill switch que aplica la ingesta | Una tarea reanudada solo corre si el worker la admite (el kill switch se consulta antes de cada reclamo); una conversación `humanOwned` no se confirma (V) |
| R4-04 | El plazo se compara con el reloj del gateway (margen de 5 s); las transiciones usan el reloj de la base | Margen del plan |
| R4-05 | Inmutabilidad de las columnas de identidad del binding (trigger de ADR-038:312, RR-1 R-4) | Pendiente, mandato propio; precondición de la idempotencia del `confirm` |
| R4-06 | Custodia de la credencial `channel-integration` y de las claves | OA-10 |

---

## 5. Baseline y commits

| | Valor |
|---|---|
| Baseline | `main` `38e19fd5dbe84548ccaea28545946c0ef7905265`; SEC-S3 `f0dd38dd0c5b6496260163487189d28ae27ea56a` |
| CIA / CP | `7525395` / `bbd766e`, sin cambios |
| Commits | El commit de SEC-S4 de esta rama (implementación, pruebas e informe) |
| Autor | `MisterGoli <joaqutorres@alumnos.uai.cl>` |
