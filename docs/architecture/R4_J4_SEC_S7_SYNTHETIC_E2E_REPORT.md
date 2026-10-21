# R4-J4 SEC-S7 — Informe: campaña sintética integral de SEC-OTP

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06` (§6, SEC-S7) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-otp-front-a`. La campaña corre el commit `129586c` (S3 + S4 + S6 integrado + S5 + campaña) |
| Servicios | CIA: clon limpio `7525395d14d72c36853add31b327c6ebd5fb9e73`, compilado, ejecutado por su propio `createCia`. CP: clon limpio `bbd766ef4b32c0ceb1065f9b7791f63f46798ef9`, servicio compilado. **Ningún artefacto de CIA ni de CP se modificó** (`git status` vacío en ambos clones) |
| Alcance | Componentes reales de R4 contra CIA y CP sintéticos. Sin correo real, OTP real, cliente real, despliegue ni perfil productivo |

```text
SEC_S7_SYNTHETIC_E2E_PASS
R4_HARNESS_UNCHANGED
R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
CIA_V1_D2_CONTRACT_UNCHANGED
SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING
GATE_RR1_PENDING
BA_01_TO_BA_06_OPEN
```

---

## 1. Qué es real y qué es sintético

| Pieza | En la campaña |
|---|---|
| Webhook | `POST /v1/channels/whatsapp/webhook` del gateway real, con firma HMAC sintética (adaptador de WhatsApp real) |
| Ingesta | `ChannelIngress` → `recordInboundInspected` (lock por conversación) → `VerificationInspector`, sobre PostgreSQL real |
| Inicio | `identity.start_verification@1` por el `ActionPolicyEngine` y el `ActionExecutor` reales → `CiaVerificationStartClient` → CIA real (credencial `agent` sintética) |
| Correo | El `FakeEmailSender` de la propia CIA (buzón en memoria). La prueba lee el OTP de ese buzón |
| Confirmación | `VerificationConfirmDispatcher` real (bucle con sondeo de 100 ms) → `CiaVerificationConfirmClient` → CIA real (credencial `channel-integration` sintética) |
| Reanudación | `TemporalRuntime.submitInput` real, con el marcador sin resultado |
| Estado y datos | `identity.verification_status@1`, `customer.get_context@3` y `customer.get_purchase_history@2` por el `CapabilityInvoker` real → `resolve` en la CIA real → grant → CP real (grant `required`) |
| Proveedor de cuentas | El doble HTTP de la propia CIA. La creación de cuenta del camino B es un `push` en ese doble (proveedor sintético) |
| **No ejercitado** | El modelo y el bucle del worker: ningún perfil ni definición registra estas capacidades (mandato: sin perfiles productivos). La campaña invoca las capacidades con contextos de ejecución de las tareas reales que creó el webhook |

**Dos instancias de la CIA.** La principal usa los valores del contrato (OTP 600 s, reenvío 60 s). Una segunda, con OTP de 20 s y reenvío de 1 s **mediante la opción `settings` de la propia composición de la CIA** (nunca su código), sirve solo para los escenarios dependientes del tiempo: código vencido, reemplazo y tarea cancelada.

---

## 2. Escenarios (cada ejecución corre todos)

| Camino | Escenario | Tipo | Resultado esperado y verificado |
|---|---|---|---|
| **A** | Cuenta existente | E2E | `history@2` sin vínculo (`not_linked`) → email declarado → inicio autónomo → OTP del buzón → mensaje persistido como `mi código es [verification code received by platform]` → `confirm` → `linked` → marcador de reanudación sin resultado → `account_linked` → `get_context@3` `verified` (CP `accepted`) → `get_purchase_history@2` `verified` |
| **B** | Onboarding | E2E | OTP correcto → `no_eligible_account` → `onboarding_required {available: false}` → `get_context` `not_linked`, sin llamada a CP → cuenta creada en el proveedor sintético → **sigue `not_linked`** (AT-ONB-06) → espera del reenvío (61 s) → nuevo inicio → nuevo OTP distinto → `linked` → `get_context` `verified` (sin historial) → `history` `verified` con 0 ítems |
| C | Código incorrecto | E2E | `invalid_code` (`code_rejected`, 4 intentos) y luego `linked` |
| C | Código vencido | E2E | Redactado, **sin `confirm`**; `verification_expired` tras el barrido |
| C | Código duplicado | E2E | 3 reentregas en paralelo → 1 captura y 1 `confirm`; el mismo código tras vincular no se envía |
| C | Cambio de binding | E2E | Tarea terminal + mensaje nuevo → expectativa `cancelled(binding_not_current)`; el código viejo se redacta y no se envía; el binding nuevo ve `none` |
| C | Cancelación de tarea | E2E | Código redactado, no capturado, no enviado |
| C | Reemplazo | E2E | Inicio A, inicio B → A `cancelled(superseded)`; el código de A se confirma contra B (`invalid_code`); el de B vincula |
| C | Reinicio durante la confirmación | FAULT | Código pendiente con el despachador detenido → **gateway nuevo** → confirma. Además, la respuesta de la CIA se corta tras aplicarse → reintento con **la misma clave** → la CIA devuelve la respuesta guardada → `linked` |
| C | CIA temporalmente no disponible | FAULT | Dos 503 inyectados → backoff con la misma clave → `linked` |
| C | Mensajes ambiguos | E2E | `mi pedido es NNNNNN` → retenido, **sin intento consumido**, `code_needed` → luego el código vincula |
| C | Fallo del inspector | FAULT | Tabla de respuestas renombrada durante el mensaje → mensaje entero `messageWithheld` (fallo cerrado), sin captura → tras recuperar, el código vincula |
| C | Fallo de persistencia | FAULT | Restricción temporal sobre `inbound_events` → webhook 500, **nada persistido** (ni inbound ni respuesta) → reentrega del mismo cuerpo → 200 → una captura → `linked` |
| C | AT-24 bloqueo | E2E | 5 códigos incorrectos → `verification_locked`; un sexto no se envía |
| C | Rollback con protección vigente | E2E | Gateway sin inspector → **rechazado** (`identity_verification_protection_active`); en `protect_only` el inicio se rechaza (`verification_disabled`) |
| C | AT-25 credenciales | E2E | `start` con la credencial de canal → 403; `confirm` con la credencial `agent` → 403 (CIA real) |
| C | Rutas alternativas | E2E | Inventario: la única ruta protegida es el webhook; `POST /v1/tasks/:id/inputs` y las demás son gates (BA-01…BA-06). **Ningún OTP se envía por ellas** |
| AT-12 | Barrido N-15 | E2E | Ningún OTP de la ejecución, ni con espacios, guiones o dígitos de ancho completo, en ninguna tabla de R4 (`public`, `sales`, `identity_verification`) de ambas bases, ni en el log del gateway, las observaciones o la telemetría (identidad, perfil, `confirm`). Ningún cifrado pendiente al final. Ningún token ni clave en esas superficies |

El barrido quita antes las marcas de tiempo, los UUID, los digests hexadecimales y los campos numéricos de log, y exige que el código aparezca solo, entre caracteres que no sean dígitos. Así se evitan falsos positivos por coincidencia de dígitos.

---

## 3. Ejecuciones

Tres ejecuciones completas e independientes del proyecto `interop` entero: la campaña R3 (`cia-cp-campaign`, ahora sobre `customer.*@3/@2`) y esta campaña. Cada ejecución arranca instancias nuevas de la CIA (esquemas nuevos), de CP y de R4 (bases nuevas). **Ninguna fue parcial.**

| Ejecución | Checkout | HEAD | Resultado | Duración | Árbol antes / después |
|---|---|---|---|---|---|
| 1 | Worktree `dev/r4-j4-sec-a` | `129586c55d3f90120fe3bb01db45f38710bfd87e` | **2 archivos · 41/41** (R3 23, SEC-OTP 18) | 22:10:45–22:13:49 UTC | limpio / limpio |
| 2 | Worktree `dev/r4-j4-sec-a` | `129586c55d3f90120fe3bb01db45f38710bfd87e` | **2 archivos · 41/41** | 22:13:50–22:16:14 UTC | limpio / limpio |
| 3 | **Clon limpio desde GitHub** (`git clone --branch feat/r4-j4-sec-otp-front-a`, `npm ci`, `build`) en `C:\Users\dell\i\r4` | `129586c55d3f90120fe3bb01db45f38710bfd87e` | **2 archivos · 41/41** | 22:16:34–22:18:51 UTC | limpio / limpio |

**Registros y hashes** (en `docs/architecture/evidence/sec-s7/run-N/`, junto con `summary.txt` y `head.txt`):

| Ejecución | `campaign.log` | `sec-otp-evidence.json` | `r3-evidence.json` |
|---|---|---|---|
| 1 | `3f9ba25f9bbef6ffeb3780d1777fe02887afb7d0a7971aaccbf8a026cdbc0f2e` | `0b76690bb37206a32f0b1b45ec87292f57e752522441a235f5dc72178871237d` | `773c0741a63be27099e74d48aa18f7d26d5b5f4212710ffa92d07dd939d3c84d` |
| 2 | `f8a84b8636991775f3867ccb3a2c0bb53e6965cbd208fc8896a1a19ad177490c` | `2a82c55a44a443d31234cec21d40e8a93f544a393fa06e5263031ce9621d76d1` | `e2967f04f3243b6c83c55cdeb389b81e043745f4861a713ee2b11eca85e82fae` |
| 3 | `fcf6f713dbfca317c6238efec27ef6da05dd429f67df0e3211b5843a7d63fd0a` | `f3bcf2773aa343a1dd4bb82224582c703ace8988cbdd01b6a27156905d3d04e7` | `f3c117e53c77bbc39af177d6241a09fe97dda5d247c0a82ded34227107c067f1` |

Cada `sec-otp-evidence.json` tiene 19 registros (preparación + 18 escenarios). El barrido de la ejecución 3 comprobó 16 OTP distintos (64 variantes), 351 líneas de log del gateway y 15 observaciones, y terminó sin cifrados pendientes. Las evidencias no contienen emails, tokens ni códigos.

Los clones de la CIA y de CP siguen en `7525395` / `bbd766e` con `git status` vacío tras las tres ejecuciones.

Hallazgo durante la depuración previa a las ejecuciones oficiales (no fue una ejecución oficial):
- Un email con 4 a 8 dígitos seguidos, declarado **dentro** de una ventana de protección, queda redactado (OA-07) y el inicio se rechaza (`email_not_declared`). Es el costo comercial declarado de OA-07, ahora observado también sobre emails. Ver riesgos.

---

## 4. Riesgos y limitaciones

| # | Riesgo | Estado |
|---|---|---|
| R7-01 | El modelo real no participa: la campaña no demuestra que un modelo use bien las capacidades | Sin perfil por mandato. Se necesita una evaluación con modelo antes de cualquier activación |
| R7-02 | Escenarios de tiempo con una CIA de OTP corto (20 s), configurada por su opción `settings` | Declarado. El camino A, el B y el resto de C usan los valores del contrato |
| R7-03 | La creación de cuenta del camino B es un `push` en el doble del proveedor de la CIA | Es la simulación pedida ("proveedor sintético"); no hay onboarding real (EXT-05) |
| R7-04 | Email con dígitos declarado durante una protección (§3) | Pendiente de decisión del owner junto con `SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING` |
| R7-05 | Cobertura textual residual (RS-01…RS-04) | Pendiente del owner; gate de tráfico real |
| R7-06 | Entradas alternativas | BA-01…BA-06 abiertos |
| R7-07 | Custodia de claves y credenciales | OA-10 |
| R7-08 | RR-1 | Revalidación implementada en todas las operaciones; residuos R-1…R-3 sin aceptación escrita |

---

## 5. Cómo repetirla

```text
R4_INTEROP_CIA_DIR=<clon limpio compilado de la CIA @ 7525395>
R4_INTEROP_CP_DIR=<clon limpio compilado de CP @ bbd766e, ruta corta>
PostgreSQL de la CIA en 127.0.0.1:55433 y de R4 en 127.0.0.1:55432
npm run test:interop      (opcional: R4_INTEROP_SEC_OTP_EVIDENCE=<archivo>, R4_INTEROP_EVIDENCE=<archivo>)
```
