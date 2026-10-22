# R4-J4 SEC-S5 — Informe: capa comercial de la verificación

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06` (§2 Frente A, SEC-S5) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-otp-front-a`, **sobre la integración de SEC-S6** (merge `993388d`), como exige el mandato |
| Alcance | **Solo SEC-S5:** `identity.start_verification@1`, `identity.verification_status@1`, el mapeo comercial con `onboarding_required`, la política de inicio autónomo (OA-05), el cliente `start` de la CIA y la composición sintética. **Sin** perfiles productivos, onboarding real, URL, creación de cuentas, cambios en CIA, CP, contratos ni harness |

```text
SEC_S5_COMMERCIAL_VERIFICATION_IMPLEMENTED
SEC_S5_SYNTHETIC_VALIDATION_PASS
ONBOARDING_FALLBACK_DEFINED
R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
R4_HARNESS_UNCHANGED
GATE_RR1_PENDING
```

---

## 1. Qué implementa

| Pieza | Ubicación | Contenido |
|---|---|---|
| Esquema `start` fijado | `identity-http/contract/schemas/verification-start.v1.schema.json` y 6 fixtures `verification-start/*` | Copia byte a byte de CIA `7525395`. Los blobs coinciden con la CIA |
| Cliente `start` | `CiaVerificationStartClient` (`identity-http/src/start.ts`) | Credencial `agent` (OA-06), `idempotency-key` determinista, validación cerrada. Clasificación: 400 → `validation`; 401/403 → `unauthorized`; 409 `idempotency_conflict` → `conflict`; 409 `operation_in_progress`, 429 y 5xx → `temporarily_unavailable`; plazo → `timeout`; fuera de contrato → `contract_violation`. La telemetría no lleva email, sujeto, `verificationId` ni token |
| `identity.start_verification@1` | `agents/sales/src/capabilities/identity-verification.ts` | Escritura gobernada (`EXTERNAL_COMMUNICATION`, `idempotent_replay`), entrada estricta `{email}`. Pasos: modo `full` → V → email declarado → guarda de reenvío → expectativa `created` **antes** de la CIA → V → `start` → V → `markIssued`. La salida es `{status: 'challenge_issued', expiresAt, resendAvailableAt}`, sin `verificationId` ni email |
| `identity.verification_status@1` | mismo archivo | Lectura sin argumentos: V → última expectativa del binding **y** de la tarea → mapeo → V antes de devolver |
| Mapeo comercial | `commercialVerificationStatus` (puro) | La matriz completa de la decisión §7.3 (§2) |
| Política | `IDENTITY_VERIFICATION_ACTION_POLICY` | Autónoma por override explícito de la capacidad (OA-05); cualquier otra comunicación externa sigue exigiendo aprobación |
| `code_needed` | Migración `0014_identity_verification_withheld_submissions.sql`; `recordWithheld` (inspector, en la transacción del inbound); `codeNeeded` | Registra solo el motivo, sin texto, número, hash ni emisor |
| Store | `latestForBinding`, `codeNeeded`, `recordWithheld` | — |
| Composición | `composeSyntheticIdentityVerificationCapabilities` en `customer-synthetic.ts` | La **única** que registra las dos capacidades. Credencial `agent` sintética y en loopback; `R4_CUSTOMER_MODE=real` rechazado. No recibe la clave de códigos ni la credencial `channel-integration` |

### 1.1 Política de inicio (OA-05)

| Regla del owner | Materialización | Rechazo |
|---|---|---|
| Inicio autónomo gobernado | Override `autonomy: allow` de la capacidad; propuesta → política → ActionExecutor con la clave de ejecución | — |
| Solo ante intención explícita, con correo declarado; sin correos preventivos | El email debe aparecer, como token exacto, en el **último mensaje del cliente** registrado por la plataforma (sin contar marcadores de plataforma) | `email_not_declared` |
| Binding vigente | V antes de abrir la expectativa, antes de la CIA y después del 202 | `binding_not_current` |
| Respeta los límites de la CIA | Guarda local del intervalo de reenvío (60 s, contrato §4.1): un inicio que la CIA rechazaría con 429 **no reemplaza** un desafío fresco. 429 real → `rate_limited` y la expectativa nueva se cierra | `resend_not_available`, `rate_limited` |
| Una expectativa activa por conversación | Índice único (S2) y reemplazo (`superseded`) | — |
| Idempotencia | `startIdentities(executionKey)` deriva el id de la expectativa y la clave de la CIA: un replay reutiliza ambos | — |
| Componente apagado | `component_mode ≠ full` | `verification_disabled` |

**Desviación de diseño registrada.** El diseño reemplaza la expectativa viva antes de llamar a la CIA. Sin la guarda, un segundo inicio dentro de los 60 s cancelaría un desafío que el cliente puede estar leyendo, y la CIA rechazaría el nuevo con 429: la conversación quedaría sin desafío vivo. La guarda local lo impide sin cambiar la CIA ni S2.

---

## 2. Matriz comercial (§7.3) y onboarding (§7.4)

| Registro de la plataforma | Estado comercial |
|---|---|
| Sin expectativa para el binding | `none` |
| `created` / `awaiting_code` / `processing` | `in_progress` (`expiresAt`) |
| `awaiting_code` tras un número retenido sin enviar | `code_needed` |
| `awaiting_code` con `invalid_code` | `code_rejected` (`attemptsRemaining`) |
| `confirmed`: `linked` / `no_eligible_account` / `ineligible_account` / `ambiguous` / `conflicted` | `account_linked` / **`onboarding_required` {`onboarding: {available: false}`}** / `account_not_eligible` / `account_ambiguous` / `link_conflicted` |
| `rejected` | `verification_locked` |
| `expired` | `verification_expired`, o `verification_unavailable` si el plazo se agotó con la CIA no disponible |
| `cancelled` por fallo de `start` o `confirm` | `verification_unavailable` |
| `cancelled` por reemplazo o binding no vigente | `none` |

**Invariantes de `onboarding_required`:**
- Solo nace de `confirm.outcome = no_eligible_account` registrado para el binding **y la tarea** vigentes (prueba exhaustiva sobre 7 estados × 9 resultados × 2).
- No lleva `customerRef`, grant, email, `verificationId` ni URL.
- No llama a CP ni crea cuentas.
- No se hereda en un binding nuevo (AT-ONB-07).
- Un `resolve.not_linked` nunca lo produce: no es un resultado de verificación.

**OA-12:** con `onboarding.available = false`, la descripción de la capacidad indica informar que el registro desde el chat no está disponible todavía, sin enlace, sin redirección y sin promesa.

**Autoridad.** Ningún estado comercial concede acceso. El acceso a datos sigue exigiendo `customer.get_context@3` / `customer.get_purchase_history@2`, que resuelven en la CIA por invocación y revalidan V (SEC-S6).

---

## 3. Pruebas

| Archivo | Proyecto | Pruebas | IDs |
|---|---|---|---|
| `tests/unit/sales/identity-verification-status.test.ts` | unit | 25 | AT-ONB-01 (matriz), AT-ONB-04, AT-ONB-05, `onboarding_required` solo desde `no_eligible_account`, `code_needed`, política OA-05, identidades deterministas por comando |
| `tests/unit/customer-identity/start-client.test.ts` | unit | 11 | Petición fijada, rechazo previo a la red, clasificación por estado, respuesta fuera de contrato, telemetría sin secretos |
| `tests/integration/identity-verification-commercial.test.ts` | integration | 15 | Inicio autónomo completo con la expectativa creada antes de la CIA (orden de RX-02); OA-05 (email no declarado); AT-22; V previa (tarea cancelada, `humanOwned`, `protect_only`); V tras el 202 (residuo R-2); AT-23; 429 y caída de la CIA con replay; AT-26; AT-ONB-02, AT-ONB-03, AT-ONB-04 (con `code_needed` y `code_rejected`), AT-21, AT-ONB-07; **RR1-T09**; sin argumentos |
| Contratos | contract | +1 | Ninguna capacidad nueva fuera de `customer-synthetic.ts` e `identity-verification.ts`; fronteras de Sales (`identity-verification` permitido solo para registros de expectativas), de `identity-http` (copias y rutas) y de `customer-http` (usuarios) actualizadas explícitamente |

Las pruebas de integración usan el webhook real, el inspector y el despachador reales, el `ActionPolicyEngine` y el `ActionExecutor` reales para el inicio, y dobles en proceso de la CIA (`start` idempotente por clave; `confirm` con guion). La CIA real se ejercita en SEC-S7.

### 3.1 Resultados

Sobre el árbol que ya integra SEC-S6:

| Comprobación | Resultado |
|---|---|
| `build`, `typecheck`, `lint` (`--max-warnings=0`) | OK |
| `unit` | 85 archivos (1 omitido) · **1 519 PASS**, 4 skip, 0 FAIL. Antes 1 453; +30 de S6, +25 del mapeo y +11 del cliente `start` |
| `contract` | 31 archivos · **414 PASS**, 0 FAIL |
| `integration` (en paralelo, sin reintentos) | 41 archivos (1 omitido) · **579 PASS**, 12 skip, **0 FAIL**. Antes 562; +2 de S6 (RR1-T06) y +15 (`identity-verification-commercial`) |
| `sales` / `shadow` | **29/29** / **5/5** |
| Mutaciones SEC-S5 (`test:mutation:identity-verification-commercial`) | **9/9** |
| Mutaciones S4 / S3 / RR-1 (S6) / S1 / S2 | **11/11**, **13/13**, **5/5**, **23/23**, **16/16** |

**Mutaciones SEC-S5:** M1 una cuenta no elegible recibe onboarding; M2 inicio con un email no declarado; M3 V lee solo el binding y no el estado de la tarea; M4 sin V tras el 202; M5 sin guarda de reenvío; M6 (RR1-T09) estado devuelto sin revalidar; M7 el inicio exige aprobación humana (se pierde OA-05); M8 sin registro de números retenidos (`code_needed` no aparece); M9 la telemetría del inicio lleva el email.

---

## 4. RR-1 en las operaciones nuevas

| Operación | Revalidación | Prueba |
|---|---|---|
| `identity.start_verification@1` | V antes de la expectativa, antes de la CIA y después del 202 | Integración (V previa y V tras el 202) |
| `identity.verification_status@1` | V antes de leer y antes de devolver | RR1-T09 |
| Despachador (S4) | V antes de abrir el código | RR1-T07, RR1-T08 |
| `customer.*` (S6) | T1, T2', T4' | RR1-T01…T06 |

**RR-1 no se cierra con esto.** El gate exige además la aceptación escrita de los residuos R-1 a R-3 por el owner (`GATE_RR1_PENDING`).

---

## 5. Riesgos y limitaciones

| # | Riesgo | Estado |
|---|---|---|
| R5-01 | "Intención explícita" se aproxima con "el email está en el último mensaje del cliente". Un cliente que escribe su email sin querer verificarse permitiría un inicio | Tras el inicio, el cliente recibe un correo de la CIA y nada más ocurre sin el código. Aceptable en sintético. Para datos reales, revisar con D7 / OA-04 |
| R5-02 | El email declarado queda en la memoria conversacional (E1, OA-04) | Solo sintético; los correos reales requieren D7 |
| R5-03 | La guarda de reenvío usa `created_at` de la expectativa viva, no `resendAvailableAt` de la CIA | Conservadora (60 s del contrato); configurable solo en pruebas |
| R5-04 | Ningún perfil ni definición del agente registra las capacidades; el modelo real no las ha usado | Por mandato (sin perfiles productivos). Las descripciones llevan las instrucciones comerciales |
| R5-05 | Landing de onboarding inexistente (EXT-05) | `onboarding.available = false` fijo |

---

## 6. Baseline y commits

| | Valor |
|---|---|
| Baseline | `main` `38e19fd`; S3 `f0dd38d`; S4 `9d555cd`; integración de S6 `993388d` |
| CIA / CP | `7525395` / `bbd766e`, sin cambios |
| Commits | El commit de SEC-S5 de esta rama (implementación, pruebas e informe) |
| Autor | `MisterGoli <joaqutorres@alumnos.uai.cl>` |
