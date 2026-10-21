# R4-J4 RR-1 — Análisis de la carrera de cierre concurrente del binding

| Campo | Valor |
|---|---|
| Mandatos | `R4-J4-SEC-OTP-DESIGN-01` (§7) · `R4-J4-SEC-OTP-DESIGN-OWNER-REVISION-02` (§8: gate independiente; `V` lee `bindingByTask` y `taskState`; se añade la lectura de estado de verificación) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Origen | `R4_J4_R3_OWNER_MERGE_REPORT.md` §2 (OWNER-R3-03) y §6 (RR-1): "Clausura concurrente de un binding durante una invocación ya iniciada. La invocación puede completar con el binding leído al inicio" |
| Estado | **Riesgo evaluado. Sin cambios ejecutables.** Gate de seguridad separado para cualquier activación real (§7) |

```text
R4_RR1_CONCURRENCY_RISK_ASSESSED
R4_HARNESS_UNCHANGED
```

---

## 1. Conclusión

1. **La persistencia ya está protegida.** Un binding solo se cierra cuando su tarea ya es terminal (o tiene `terminalIntent`), y ese estado implica que la run no tiene lease. La escritura de la observación está cercada por lease (`apps/worker/src/session.ts:84-94`, `execution-runtime.ts:452-455`). Por eso **nada de lo leído tras el cierre llega a la base ni al modelo.**
2. **Lo que sigue expuesto son efectos externos de lectura:**
   - un `resolve` en la CIA, que emite un grant de ≤ 300 s y deja auditoría;
   - una lectura en CP, que audita `accepted`;
   - ambos sobre una sesión que ya terminó.
   - **La CIA no lo impide:** `resolve` ignora la `sessionRef` para reutilizar el vínculo (CIA `CIA_S3_IDENTITY_RESOLUTION_REPORT.md:99`).
3. **La carrera más probable no es el cierre del binding sino la cancelación de la tarea.** La cancelación administrativa **no cierra** el binding (`administration.ts:119-120`; mutación M10), así que releer `binding.status` **no la detecta**. La revalidación debe mirar también `taskState`.
4. **Mitigación sin tocar el harness.** Basta revalidar desde el handler en tres puntos (antes de CIA, entre CIA y CP, y antes de devolver) con `bindingByTask` + `taskState`. El residuo queda acotado a la duración de **una** llamada externa (≤ 3 s).
5. **Eliminar ese residuo exige propagar la cancelación** a la `signal` de la capacidad, lo cual es un **cambio del harness**. Se expone como alternativa y **no se recomienda ahora** (§5.4).

---

## 2. Garantías actuales

### 2.1 Representación del binding

| Aspecto | Hecho | Evidencia |
|---|---|---|
| Estado | `status ∈ {open, closed}` + `closed_at` + `closed_reason`. **No hay versión, época ni generación** | `0007_governed_production.sql:47-68`; `ports.ts:87-105` |
| Monotonía | `closeBinding` solo actúa sobre `status = 'open'`, y `openBinding` siempre inserta una fila nueva. Un binding cerrado **nunca se reabre** | `production-store.ts:180-202` |
| Relación con la tarea | Índice único `(task_id) where task_id is not null`: una tarea tiene a lo sumo un binding, y `bindingByTask` devuelve siempre el mismo `bindingId` | `0007:47-68` |
| Inmutabilidad de `account_ref` / `recipient_ref` / `task_id` | **No garantizada por trigger** (solo propuesta en ADR-038:312) | — |

**Consecuencia de la monotonía.** Si una relectura posterior a una llamada externa ve el **mismo** `bindingId` en estado `open`, el binding estuvo abierto durante toda la llamada: no pudo cerrarse y reabrirse. **No hace falta una versión.**

### 2.2 Qué ofrece `bindingByTask`

`select * from channel_conversation_bindings where task_id = $1` (`production-store.ts:208-210`):
- es una lectura de autocommit, sin `FOR UPDATE`, con READ COMMITTED por defecto;
- devuelve el binding **abierto o cerrado**;
- **no garantiza nada después** de devolver.

### 2.3 Quién cierra un binding

| Quién | Cuándo | Evidencia |
|---|---|---|
| `ChannelIngress.#process` | Cuando llega un inbound nuevo y la tarea vinculada es terminal, tiene `terminalIntent` o no existe | `ingress.ts:182-189` |
| `ChannelIngress.#process` | `submitInput` falla con `task_not_accepting_input`/`task_terminal` (`task_terminal_race`) | `ingress.ts:241-245` |
| Cancelación administrativa, `cancelTaskByPlatform`, handoff, operador, scheduler | **Nunca** | `administration.ts:119-120`; `temporal-runtime.ts:651`; mutación M10 (`tests/mutation/production-control-mutations.mjs:98-104`) |

**El cierre es perezoso y siempre posterior a la terminalidad de la tarea.** Un binding de una tarea cancelada sigue `open` hasta el próximo mensaje del cliente (`tests/integration/live-ops-hardening.test.ts:66-80`).

### 2.4 Cancelación y fencing

| Aspecto | Hecho | Evidencia |
|---|---|---|
| Cancelación de la tarea | Bloquea la tarea, termina la run, libera el lease y cancela esperas y schedules en una transacción | `temporal-runtime.ts:660-689` |
| Escrituras del dueño de la run | `lockOwnedExecution`: lock de la tarea + `assertLeaseHeld` (owner + generation) + `status = 'running'` | `execution-runtime.ts:236-246` |
| Observación tras la cancelación | `recordObservation` lanza `task_not_runnable`, que se convierte en `KernelInterrupt`. El resultado **no se persiste ni llega al modelo** | `session.ts:84-94,376-377` |
| `signal` de la capacidad | Solo se aborta por `definition.timeoutMs`. **La cancelación no la alcanza** | `invoker.ts:167-181`; `registry.ts:15-16` |
| Kernel | Comprueba su señal entre pasos y en la llamada al modelo, no dentro de una capacidad | `kernel.ts:105,150-152` |

---

## 3. Línea temporal de `customer.get_context@2`

`agents/sales/src/capabilities/customer-v2.ts:57-61,82-86` y `customer-profile-outputs.ts:127-144`:

```text
T1  bindingByTask(taskId)            ── lectura sin lock; si closed → anonymous, sin llamadas
T2  CIA POST /v1/identity/resolve    ── context = binding leído en T1 (sessionRef = bindingId)
T3  coherentGrant(...)               ── solo comprueba expiración y propósito del grant
T4  CP getSalesContext(grant)        ── lectura protegida; CP audita accepted
T5  proyección + tope de tamaño      ── return al invoker
T6  recordObservation (fenced)       ── falla si la run ya no tiene lease
```

| El cierre o la cancelación ocurre… | Hoy | Persistencia o modelo | Efecto externo |
|---|---|---|---|
| antes de T1 | `anonymous` (si el binding ya está `closed`). **Si solo se canceló la tarea, el binding sigue `open` y se continúa** | No llega (T6 falla) | **CIA y CP se llaman igualmente** (cancelación no detectada) |
| durante T2 (CIA) | Se completa el `resolve` y se emite el grant | No llega | Grant emitido; CP se llama en T4 |
| entre T2 y T4 | No hay revalidación | No llega | CP se llama |
| durante T4 (CP) | Se completa | No llega | CP audita `accepted` |
| entre T5 y T6 | — | T6 falla: no llega | Ya ocurridos |

**Lo mismo vale para `customer.get_purchase_history@1`, y para las operaciones nuevas del diseño SEC-OTP:**
- `identity.start_verification@1`: un `start` envía un **correo** al cliente, que es un efecto externo visible. Es más grave que una lectura.
- El despachador de `confirm`: un `confirm` puede **crear un vínculo** en la CIA.

---

## 4. Definición operativa de "asociación de canal válida"

Una invocación sigue autorizada a actuar por el sujeto del canal si y solo si, en el instante de la comprobación:

```text
V(taskId, bindingId₀) ≡ bindingByTask(taskId).bindingId = bindingId₀
                       ∧ bindingByTask(taskId).status = 'open'
                       ∧ taskState(taskId).status ∉ {completed, cancelled, failed}
                       ∧ ¬ taskState(taskId).terminalIntent
                       ∧ (OA-09) ¬ taskState(taskId).humanOwned   ← decisión del owner
```

- `bindingId₀` es el binding leído en T1.
- `taskState` ya existe en el puerto `ProductionStore` (`production-store.ts:655-665`), así que no hace falta ninguna API nueva.

---

## 5. Dónde revalidar

### 5.1 Capacidades `customer.*` (pack Sales, sin harness)

- Las dependencias pasan de `Pick<ProductionStore,'bindingByTask'>` a `Pick<ProductionStore,'bindingByTask'|'taskState'>`. Ya existe el precedente de `quoteCreateV5Capability({conversation: options.store})` en `production/composition.ts:162-164`.

```text
T1   b₀ ← bindingByTask; exigir V(taskId, b₀)            → si falla: anonymous, sin CIA ni CP
T2   CIA resolve
T2'  exigir V(taskId, b₀)                                 → si falla: descartar el grant, anonymous, sin CP
T4   CP read
T4'  exigir V(taskId, b₀)                                 → si falla: descartar los datos, anonymous
T5   return
```

**Coste:** cuatro lecturas indexadas más por invocación.

**Versión:** se implementa como versión nueva (`customer.get_context@3`, `customer.get_purchase_history@2`), según la convención del repositorio de no cambiar el comportamiento de una versión publicada. Los hashes históricos de `@2` y `@1` no cambian.

**¿Por qué un `anonymous` en T4' si el modelo ya no recibirá nada?** Es defensa en profundidad:
- en T4' la run podría seguir viva si `humanOwned` se cuenta como no válido (OA-09);
- además, el resultado de la invocación queda coherente con la autorización en el instante de devolverlo.

### 5.2 Operaciones SEC-OTP

| Operación | Revalidación | Si falla |
|---|---|---|
| `identity.start_verification@1` | `V` antes de `openExpectation`, antes de la llamada a la CIA y después del 202 | Antes de la CIA: rechazar sin efecto. Después del 202: expectativa `cancelled(binding_not_current)`. **El correo ya salió** (residuo R-2) |
| Inspector de la ingesta | `expectation.binding_id = ctx.binding.bindingId` y `ctx.binding.taskAcceptsInput`. `ChannelIngress` lee ambos (binding abierto y `taskState`) **dentro de la transacción del inbound**, bajo el lock de la conversación (`TrustedChannelContext`, decisión §5.1) | Redactar sin enviar y cancelar la expectativa |
| `identity.verification_status@1` (lectura comercial) | `V(taskId, b₀)` antes de leer el estado y antes de devolverlo | `{status: 'none'}`. Un estado de otro binding nunca se hereda (AT-ONB-07) |
| Despachador de `confirm` | `V(expectation.task_id, expectation.binding_id)` justo antes de abrir el cifrado | `cancelled(binding_not_current)`, sin llamar a la CIA y con el cifrado borrado |
| Reanudación | `submitInput` ya rechaza tareas terminales (`temporal-runtime.ts:394-396`) | `notified(task_terminal)` |

### 5.3 Qué pasa si el cierre ocurre durante la petición

| Petición en vuelo | Resultado con la mitigación | Residuo |
|---|---|---|
| CIA `resolve` | T2' falla: grant descartado, CP no se llama | Grant emitido y no usado (≤ 300 s, sin portador fuera del proceso). Auditoría de la CIA |
| CP `getSalesContext` | T4' falla: datos descartados; además T6 falla | Lectura auditada `accepted` en CP |
| CIA `start` | Expectativa cancelada | **Correo enviado** a un cliente cuya sesión terminó. El código expira en 10 min y no puede confirmarse con otra `sessionRef` (SR-02) |
| CIA `confirm` | El resultado se registra; la tarea no se reanuda | **Vínculo creado** si el código era correcto. El sujeto demostró el control del buzón; la CIA es la autoridad. Se propone aceptarlo (OA-09) |

### 5.4 Alternativa que exige cambiar el harness (no recomendada ahora)

**H-ALT-1 — Propagar la cancelación.** El worker ya aborta el controlador del kernel cuando pierde el lease o la tarea deja de estar `running` (`apps/worker/src/worker.ts:184-215`). Para que esa señal llegue a `CapabilityHandlerContext.signal` haría falta:
- que `KernelSession.executeRead` acepte la señal (`agent-kernel/src/session.ts:49`);
- que `CapabilityInvoker.invoke` la combine con su timeout (`AbortSignal.any`, `capability-runtime/src/invoker.ts:167-181`);
- que `apps/worker/src/session.ts` la pase.

**Efecto:** cortaría la llamada a la CIA o a CP en vuelo. Los adaptadores ya respetan `options.signal` (`identity/http/src/client.ts:184-185`).

**Costo:**
- toca tres paquetes del Core (`agent-kernel`, `capability-runtime`) y el worker;
- solo acorta la ventana: una petición ya recibida por el servidor puede completarse igual.

**Recomendación:** no adoptarla para el gate RR-1. Reconsiderarla si la latencia de la detección por relectura (§5.1) resultara insuficiente con datos reales. **Requiere un mandato de harness propio.**

**Notificar al binding desde la cancelación** (cerrar el binding al cancelar la tarea) contradice la decisión vigente M10 y la separación R4-I ("closing it stays the ingress's job"). No se propone. La relectura de `taskState` cubre ese caso sin cambiarla.

---

## 6. Pruebas deterministas de carrera

Todas se basan en **barreras de promesas**, sin temporizadores. El patrón es el de `tests/integration/worker-recovery.test.ts:142-181` (`gateA`).

| ID | Nivel | Montaje | Barrera | Acción en la barrera | Aserción |
|---|---|---|---|---|---|
| RR1-T01 | Unit (`tests/unit/sales/customer-v2-capabilities.test.ts`: `binding()`, `vi.fn` `bindingByTask` sobre un mapa mutable, `FakeClock`, `InMemoryObservationStore`) | `resolve` del doble de la CIA espera `gate` | Dentro de `resolve` | El mapa pasa el binding a `closed` | `getSalesContext` **no** se llama; salida `anonymous` |
| RR1-T02 | Unit | Igual | Dentro de `resolve` | `taskState` pasa a `cancelled` (binding sigue `open`) | `getSalesContext` no se llama (hoy **sí** se llama: la prueba documenta el defecto) |
| RR1-T03 | Unit | `getSalesContext` del doble de CP espera `gate` | Dentro de CP | binding `closed` | Salida `anonymous`; los datos de CP no aparecen en la salida |
| RR1-T04 | Unit | Igual | Antes de T1 | `taskState.terminalIntent = true` | Ni CIA ni CP se llaman |
| RR1-T05 | Unit | `bindingByTask` devuelve en T2' otro `bindingId` (simulación de corrupción; índice `one_per_task`) | — | — | `anonymous`; sin CP |
| RR1-T06 | Integration (`LiveOpsTestbed`, Postgres real, worker real; doble de CIA y CP en proceso con barrera) | Webhook → tarea → `customer.get_context@3` en vuelo | Doble de la CIA bloqueado | `api.temporal.cancelTask(taskId)` y luego un webhook nuevo del mismo cliente (cierra el binding) | El doble de CP no recibe peticiones. Ninguna observación de la invocación en la base. El nuevo inbound abre un binding nuevo |
| RR1-T07 | Unit (despachador) | Doble de la CIA `confirm` | Antes del reclamo | binding `closed` | Sin llamada a `confirm`; respuesta `cancelled`, cifrado anulado |
| RR1-T08 | Unit (despachador) | Doble de la CIA `confirm` bloqueado | Dentro de `confirm` | Tarea `cancelled` | Resultado registrado; `submitInput` no crea entrada (`task_terminal`); expectativa sin reanudación |
| RR1-T09 | Unit (`identity.verification_status@1`) | Store de expectativas con `onboarding_required` para el binding A | Dentro de la lectura del store | Tarea `cancelled` (binding A sigue `open`) | `{status: 'none'}`. El estado no sale de la invocación |

**Mutaciones obligatorias** (`tests/mutation`):
- quitar T2': RR1-T01 y RR1-T02 deben fallar;
- quitar la comprobación de `taskState`: RR1-T02 y RR1-T04 deben fallar;
- quitar la revalidación del despachador: RR1-T07 debe fallar.

---

## 7. Gate RR-1 (separado, para una activación real)

```text
GATE_RR1 = CLOSED (bloquea activación real) hasta que:
  1. Las capacidades customer.* activables revaliden V en T1, T2' y T4' (versión nueva).
  2. identity.start_verification, identity.verification_status y el despachador de confirm
     revaliden V (§5.2). V lee SIEMPRE bindingByTask Y taskState: releer solo el binding
     no detecta la cancelación de la tarea.
  3. RR1-T01…T09 en verde y las mutaciones del §6 detectadas.
  4. El owner acepte por escrito los residuos R-1…R-3 (§8) o autorice H-ALT-1 por mandato de harness.
  5. OA-09 decidido: ¿humanOwned invalida la asociación?
```

Este gate **no** se resuelve por implicación al cerrar SEC-OTP-01/02, G-16, AP-* ni D7, y no los resuelve. En particular, **que la campaña SEC-OTP (SEC-S7) funcione no cierra RR-1**: su cierre exige los cinco puntos anteriores, verificados por separado.

---

## 8. Residuos

| # | Residuo | Cota | Propuesta |
|---|---|---|---|
| R-1 | Una lectura en la CIA o en CP en vuelo cuando la sesión termina | Una llamada (≤ 3 s, `R4_CUSTOMER_IDENTITY_TIMEOUT_MS` / timeout de CP) | Aceptar: auditoría en el owner, sin persistencia ni exposición en R4 |
| R-2 | Correo de verificación enviado a una sesión que terminó durante el `start` | Un correo; el código no es confirmable desde otra sesión | Aceptar |
| R-3 | Vínculo creado por un `confirm` en vuelo tras el cierre | Requiere el código correcto del mismo sujeto | Aceptar: la CIA es la autoridad y el sujeto probó el control del buzón |
| R-4 | Ausencia de trigger de inmutabilidad en las columnas de identidad del binding | — | Implementar el trigger propuesto en ADR-038:312 en un mandato propio. Es una precondición de la idempotencia del `confirm` (plan §4.4) |
