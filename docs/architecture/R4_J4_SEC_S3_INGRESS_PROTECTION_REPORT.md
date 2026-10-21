# R4-J4 SEC-S3 — Informe: punto de inspección genérico e ingesta protegida

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06` (§1 merge de SEC-S2; §2 Frente A, SEC-S3) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-otp-front-a` (worktree `dev/r4-j4-sec-a`), desde `main` `38e19fd5dbe84548ccaea28545946c0ef7905265` |
| Alcance | **Solo SEC-S3:** puerto `InboundInspector` v1 en `live-ops`; transacción de la ingesta serializada por conversación; `VerificationInspector`; modos `full` / `protect_only` / `absent`; guardia sin override; ADR-040; inventario BA-01 a BA-06; revisión de cobertura textual. **Sin** despachador ni llamadas a la CIA (SEC-S4), capacidades (SEC-S5), cambios en el harness ni despliegue |

```text
SEC_S3_INGRESS_PROTECTION_IMPLEMENTED
SEC_S3_SYNTHETIC_VALIDATION_PASS
ADR_040_FILED
SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING
BA_01_TO_BA_06_OPEN
R4_HARNESS_UNCHANGED
R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

---

## 1. Qué implementa

| Pieza | Ubicación | Contenido |
|---|---|---|
| Puerto genérico v1 | `packages/live-ops/src/inspection.ts` | `InboundInspector` (`version: 1`, `id`, `inspect`, `protectionActive`), `TrustedChannelContext`, `InspectionDecision` (`pass` / `replace`) y `conversationLockKey`. Sin nombres de canal, OTP, CIA ni "code" (AT-19) |
| Atestación de conversación directa | `InboundChannelAdapter.directConversations?` (`channel.ts`); `WhatsAppInboundAdapter.directConversations = true` | El contexto marca `direct` solo si el adaptador lo atestigua **y** `senderRef === conversationRef`. La igualdad sola no basta (S1 §3.1) |
| Ingesta | `ChannelIngress` (`ingress.ts`): opción `inspector`. Con inspector usa `recordInboundInspected`; sin él, `recordInbound` como en R4-I | — |
| Transacción inspeccionada | `PostgresProductionStore.recordInboundInspected` (`production-store.ts`) | `BEGIN` → `pg_advisory_xact_lock(conversationLockKey)` → duplicado (`duplicate_deliveries + 1`, sin inspección) → binding abierto + `taskState` + `clock_timestamp()` en la transacción → `inspect` → inserción del texto decidido y de su `sha256` → `COMMIT`. Un `throw` del inspector aborta todo |
| Inspector de verificación | `adapters/domains/identity/verification/src/inspector.ts` | Lee la protección primero (si falla, la transacción aborta). Después, bajo un savepoint: expectativa viva, cancelación `binding_not_current` si no es la del binding y tarea vigentes, clasificación SEC-S1, sellado y captura `pending` solo en `full`. Un fallo posterior reemplaza el mensaje entero (`messageWithheld`) y revierte sus propios efectos |
| Lock idéntico | `keys.ts` reexporta `conversationLockKey` de `live-ops` | El vector fijado en S2 sigue pasando (`secret-box.test.ts`) |
| Modo durable | Migración `0012_identity_verification_mode.sql` (`identity_verification.component_mode`); `IdentityVerificationStore.mode()` / `setMode()` | El gateway registra el modo efectivo. Entrar en `protect_only` cancela toda respuesta abierta y borra su cifrado en la misma transacción. El worker (S5) lee este modo para rechazar inicios |
| Punto de composición genérico del gateway | `apps/channel-gateway/src/inspection.ts`: `GatewayBindings.inspection?: GatewayInspectionFactory` (recibe pool, store, temporal, id del gateway y un logger sin contenido) y `assertNoOpenProtection(pool)` | El gateway **no importa adaptadores** (fronteras `dependency-boundaries` y `sales-boundaries` intactas): el inspector llega por composición, como los adaptadores de canal. Sin inspector, la guardia lee el esquema `identity_verification` directamente y rechaza el arranque si hay alguna `protect_until` futura, aunque el componente no se componga. No existe override |
| Fábrica del componente | `identityVerificationInspection({ requested, codeKeys })` (`adapters/domains/identity/verification/src/gateway.ts`) | `protect_only`: solo redacción. `full`: redacción y captura; sin claves válidas arranca en `protect_only`. Registra el modo durable. Valores OA-07 por defecto (S3-DEP-03). La clave la entrega la composición; el paquete no lee el entorno |
| ADR | `docs/adr/ADR-040-ingress-inspection-point.md` | Texto de §9.1 decidido por el owner (OA-02), con su materialización y pruebas |

**Deshabilitado por defecto.** Ningún perfil productivo, CLI ni composición del pack enchufa `inspection` (prueba de contrato sobre `agents/`). Solo la composición sintética de las pruebas (`tests/support/live-ops.ts`) lo activa.

**Desviación respecto al plan §2 (registrada).** El plan ubicaba la composición del inspector y del despachador dentro de `apps/channel-gateway`. Eso obligaba al gateway a importar adaptadores, lo que violan dos fronteras vigentes (`dependency-boundaries.test.ts`: "anything not listed needs an ADR"; `sales-boundaries.test.ts`: ninguna app importa adaptadores). Se resolvió sin tocar esas fronteras: el gateway expone un punto genérico (`GatewayBindings.inspection`) y conserva la guardia; la fábrica vive en el paquete de verificación. El comportamiento exigido (modos, guardia sin override, arranque en `protect_only`) no cambia.

---

## 2. Coherencia transaccional (§6.1, §6.4)

| Garantía | Mecanismo | Prueba |
|---|---|---|
| El algoritmo del lock de la ingesta y el del componente coinciden | Una sola función en `live-ops`, reexportada | Contrato S3-DEP-01 y vector fijado |
| Duplicado antes de inspeccionar | `update … duplicate_deliveries + 1 … returning` bajo el lock | RX-05, AT-08 |
| Apertura de expectativa ∥ inbound | Ambos bajo el lock; orden FIFO del lock | RX-01, RX-02 |
| Reemplazo ∥ inbound | `openExpectation` cancela y borra en su transacción | RX-03, RX-04 |
| Expiración (barrido) ∥ inbound | `protect_until` decide la redacción; la captura exige `now < challenge_expires_at` con el reloj de la base | RX-06 |
| Resultado del despachador ∥ reemplazo | Fencing (S2): el resultado obsoleto se descarta | RX-07 |
| Captura | `captureResponse` en la transacción del inbound | AT-11, RX-01 |
| Ningún lock durante la red | La ingesta y el inspector no hacen red | AT-07 (RX-08 en S4, con el despachador) |

Las pruebas RX toman el lock en una transacción de prueba y esperan una **condición** (`pg_locks` con sesiones en espera), nunca un tiempo.

---

## 3. Pruebas

| Archivo | Proyecto | Pruebas | IDs |
|---|---|---|---|
| `tests/integration/identity-verification-ingress.test.ts` | integration | 31 | AT-01, AT-02 (negativos e2e), N-08, AT-03, AT-04, AT-07, AT-08, AT-10, AT-11, AT-18, RX-01…RX-07, emisor no atestiguado, revisión de cobertura (RS-01…RS-04 y grupo de control), AT-29b (dos casos), AT-27, AT-27b, AT-27c, `absent` permitido sin protección |
| `tests/contract/identity-verification-boundaries.test.ts` | contract | 11 (antes 9) | AT-19: dependencias del paquete, importaciones por archivo, `live-ops` sin OTP/verificación/CIA/canales, puerto sin "code", usuarios del paquete fuera de él, lock idéntico, sin override, ninguna composición productiva lo activa |
| `tests/contract/alternative-inputs-inventory.test.ts` | contract | 3 | AT-ALT-01 (§5) |

**AT-ALT-01 y AT-19 son de contrato; AT-27 / AT-27b / AT-27c ejercen la composición real del gateway** (`createGatewayPlatform`) sobre la misma base.

### 3.1 Resultados

| Comprobación | Resultado |
|---|---|
| `npm run build`, `typecheck`, `lint` (`--max-warnings=0`) | OK |
| `unit` | 81 archivos (1 omitido) · **1 431 PASS**, 4 skip, 0 FAIL (igual que S2: S3 no añade pruebas unitarias) |
| `contract` | 31 archivos · **411 PASS**, 0 FAIL. Antes 406; +5 (2 de AT-19 y 3 de AT-ALT-01). La primera corrida mostró 1 fallo en la regla nueva "ninguna composición productiva enchufa el inspector": la expresión era demasiado amplia y coincidía con una `inspection` de aprobaciones del canary. Se acotó y el archivo volvió a pasar (11/11) |
| `integration` (PostgreSQL local, en paralelo) | 38 archivos (1 omitido) · **540 PASS**, 12 skip preexistentes, 0 FAIL. Antes 509; +31 (`identity-verification-ingress`). **Regresión sin inspector idéntica**: los 509 previos pasan sin cambios |
| `sales` | **29/29** |
| `shadow` | **5/5** |
| Mutaciones SEC-S3 (`test:mutation:identity-verification-ingress`) | **13/13** detectadas, fuentes restauradas byte a byte |
| Mutaciones SEC-S1 / SEC-S2 (store modificado) | **23/23** y **16/16** |

**Mutaciones SEC-S3:** M1 texto original persistido; M2 sin duplicado previo a la inspección; M3 sin lock en la ingesta; M4 lock distinto en la ingesta y el componente; M5 fallo del inspector persiste el original; M6 captura con binding o tarea no vigentes; M7 captura tras expirar el desafío; M8 emisor no atestiguado tratado como sujeto; M9 `humanOwned` ignorado (OA-09); M10 gateway sin inspector con protección vigente; M11 `full` sin claves no degrada a `protect_only`; M12 `protect_only` conserva cifrados pendientes; M13 `live-ops` nombra un concepto de verificación.

**Carga de la máquina.** Durante la validación corrían otras suites de `vitest` ajenas. Esta corrida de integración no tuvo timeouts. Las de SEC-S2 previas al merge sí los tuvieron, en archivos sin relación (`sales-*-canary`, `production-control`, `worker-readiness`), y pasaron 144/144 en serie.

---

## 4. Revisión de cobertura textual (`SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING`)

El mandato pide revisar, con el inspector integrado, los mensajes no reconocibles durante una expectativa activa. Resultado, probado por la ingesta real:

| Formato (informe S1 §9) | Con expectativa activa | ¿Se captura? |
|---|---|---|
| RS-01 `482 luego 913`, `482 y también 913` | **Llega sin redactar** al modelo | No |
| RS-02 `4829131234` | **Llega sin redactar** | No |
| RS-03 `482 9131 234` | **Llega sin redactar** | No |
| RS-04 `cuatro ocho dos nueve uno tres` | **Llega sin redactar** | No |
| Control: `482913`, `482 913`, `482-913`, `４８２９１３`, `482 y 913`, `pedido 482913`, `482913 1234` | Redactado (y capturado solo el "solo código") | Según §8.2 |

**Conclusión.** La protección cubre las formas reconocibles; las cuatro clases residuales llegan al modelo y a la persistencia conversacional si el cliente escribe así el código. **No se declara `OTP_LEAKAGE_IMPOSSIBLE`.** El comportamiento residual queda **pendiente de decisión del owner** y es un gate para conectar tráfico real. Opciones para esa decisión (no implementadas):

1. Aceptar el residuo (el correo de la CIA pide escribir solo el código; el código expira en 10 min y es de un solo uso).
2. Ampliar la redacción durante la protección a toda secuencia con 4 o más dígitos o palabras numéricas, con mayor costo comercial.
3. Retener el mensaje entero (`messageWithheld`) cuando, con protección vigente, aparezca cualquier dígito no clasificado.

---

## 5. Entradas alternativas: inventario BA-01 a BA-06 actualizado (AT-ALT-01)

Verificado contra el código de esta rama. **Solo E-1 pasa por el inspector.** Ninguna otra ruta es una entrada de canal equivalente protegida.

| # | Ruta o llamada | Texto que acepta | ¿Inspector? | Gate |
|---|---|---|---|---|
| E-1 | `POST /v1/channels/:channel/webhook` (`apps/channel-gateway/src/platform.ts`) → `ChannelIngress` → `recordInboundInspected` | Mensaje del canal | **Sí** | — |
| E-2 | `POST /v1/tasks/:id/inputs` (`apps/api/src/app.ts:168`) → `temporal.submitInput` | `content` ≤ 8000 | **No** | **BA-01**: deshabilitar para tareas con binding de canal o aplicar inspección equivalente antes de activar |
| E-3 | `POST /v1/tasks` (`app.ts:108`) | `request.input` (contexto) | No | BA-02 |
| E-4 | `POST /v1/human-requests/:id/respond` (`app.ts:201`) | `content` ≤ 8000 (contexto) | No | BA-03 |
| E-5 | `POST /v1/tasks/:id/handoff` (`app.ts:182`) | `note` ≤ 8000 (contexto) | No | BA-04 |
| E-6 | `POST /v1/tasks/:id/operator-messages` (`app.ts:272`) | `text` ≤ 4096 (al cliente y persistido) | No | BA-05 |
| E-7 | `POST /v1/outbound/:id/resolve` (`app.ts:281`) | `note` ≤ 1000 | No | Procedimiento de BA-02 |
| **E-9 (nuevo)** | `POST /v1/production/controls` (`app.ts:245`) | `reason` ≤ 500 (eventos de control; no entra al contexto de tareas) | No | Procedimiento de BA-02 |
| — | `POST /v1/tasks/:id/cancel`, `POST /v1/outbound/:id/cancel` | Cuerpo vacío | — | — |
| — | `POST /v1/executions/:id/reconciliation/reschedule` | Solo `responseKey` (identificador) | — | — |
| E-8 | `agents/sales/src/harness/runtime.ts` (`submitInput` en proceso; el shadow pasa por él) | Corpus sintético | No | **BA-06**: nunca alimentarlo con tráfico real fuera de la ingesta protegida |

Las pruebas de esta campaña **no** envían OTP por ninguna ruta alternativa. BA-01 a BA-06 siguen **abiertos**.

---

## 6. Fronteras

- **Harness sin cambios:** `git diff --stat main -- packages/{agent-kernel,task-runtime,capability-runtime,context-compiler,model-gateway,policy-engine,contracts,observability}` vacío.
- `live-ops` gana solo el puerto genérico, la opción `inspector`, `directConversations?` y el método de puerto `recordInboundInspected`. `persistence-postgres` gana la transacción inspeccionada.
- El paquete `identity-verification` depende de `@r4/persistence-postgres` y de los puertos de `@r4/live-ops`. Ningún paquete de `packages/`, app ni pack lo importa: solo la composición sintética de las pruebas lo enchufa al gateway. Las fronteras `dependency-boundaries` y `sales-boundaries` no se modificaron.
- El evento de telemetría del inspector va por el logger del gateway con `{event, reason, captured, channel, expectationId, errorCode}`: sin texto, código ni identificadores de la persona. `observability` (harness) no cambió.
- CIA y CP sin cambios. Sin red en el paquete. `R4_CUSTOMER_MODE=real` sigue rechazado.

---

## 7. Riesgos y limitaciones

| # | Riesgo | Estado |
|---|---|---|
| R3-01 | Cobertura textual (§4) | Pendiente de decisión del owner; gate de tráfico real |
| R3-02 | La atestación `directConversations` del adaptador de WhatsApp es declarativa: el adaptador construye `conversationRef = senderRef = from` y no procesa mensajes de grupo | Un canal con grupos debe atestiguar por mensaje (puerto preparado: el contexto ya separa `direct`) |
| R3-03 | Un error transitorio de la base **después** de leer la protección se convierte en `messageWithheld` (fallo cerrado) en vez de 500 y reentrega: el cliente debe reenviar | Elegido por ADR-040 inv. 5; un error de conexión aborta igual (500) |
| R3-04 | Réplicas mixtas (un gateway con inspector y otro sin él sobre la misma base) | La guardia impide arrancar sin inspector con protección vigente; una réplica antigua ya en marcha no se detecta. Procedimiento de despliegue |
| R3-05 | Entradas alternativas (§5) | BA-01…BA-06 abiertos |
| R3-06 | Custodia de claves | OA-10 pendiente; claves solo sintéticas |

---

## 8. Baseline y commits

| | Valor |
|---|---|
| Baseline | `main` `38e19fd5dbe84548ccaea28545946c0ef7905265` (merge del PR #16) |
| CIA / CP | `7525395` / `bbd766e`, sin cambios |
| Commits | El commit de SEC-S3 de esta rama (implementación, pruebas, ADR-040 e informe) |
| Autor | `MisterGoli <joaqutorres@alumnos.uai.cl>` |
