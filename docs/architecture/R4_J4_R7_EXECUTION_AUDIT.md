---
title: R4-J4-R7 — Auditoría de ejecución, continuidad y recuperación conversacional
status: R4_J4_R7_G0_FINAL_REVIEW (addendum §10 por DESIGN-02 y §10.3 por la G0 Resolution)
mandate: R4-J4-R7-DESIGN-01 — Agent Conversation Reliability & Recovery (owner, 2026-10-28), modalidad read-only; addenda por R4-J4-R7-DESIGN-02 y Owner G0 Resolution
date: 2026-10-28
base: main d0bb7a7 (d0bb7a7d5bd7e4d69c2f7a113ee1d9f8a6618676, 2026-10-27 21:41 -0300)
companions: R4_J4_R7_DESIGN.md, R4_J4_R7_TEST_PLAN.md
---

# R4-J4-R7 — Auditoría de ejecución

```text
R7_AUDIT_EXECUTION_CYCLE_RECONSTRUCTED    (código de d0bb7a7; 13 sondas E2E locales, 13/13 reproducen lo afirmado)
R7_SILENT_PATHS_REPRODUCED                B1 B3 B4* B5 B7 B9 B10 B12 + X1 (expiresAt pasado) + X2 (finish_reason)
R7_SILENT_PATHS_PARTIAL                   B6 (unitario, no E2E) · B11 (código + pruebas sin canal, no E2E)
R7_LEGITIMATE_SILENCE_UNVERIFIABLE        B2: hoy se permite, pero ninguna regla verificable lo respalda
NO_PRODUCTION_CODE_CHANGED                (sólo documentación y evidencia bajo docs/architecture/)
```

`*` B4 reproducido por pruebas existentes y por el canary R6, no por una sonda nueva (ver §2).

## 0. Preflight y método

| Ítem | Resultado |
|---|---|
| Rama de trabajo | `docs/r4-j4-r7-design` (local, sin upstream), worktree aislado `dev/r4-j4-r7-design` creado desde `d0bb7a7` |
| Commit analizado | `d0bb7a7` = `origin/main` (merge PR #31). Es el árbol exacto del canary final R6 |
| Worktree original | `R4-agent-platform` en `feat/r4-j4-customer-adapter-r2` con un archivo sin seguimiento ajeno (`docs/architecture/R4_J4_R2_OWNER_REVIEW_REPORT.md`): **no se tocó** |
| ADR-028 | `docs/adr/ADR-028-recoverable-run-failures.md` (Propuesto; implementado en `execution-runtime.ts`) |
| Auditorías R6 | `R4_J4_R6_F1_STRUCTURED_OUTPUT_CORRECTION_REPORT.md` (en main); `R4_J4_R6_FINAL_INTEGRATED_CANARY_REPORT.md` (rama local `docs/r4-j4-r6-final-canary` @ `2ce797e`, no publicada) |
| Informe Native FC | `R4_NATIVE_FC_EXPERIMENT_REPORT.md` y `R4_NATIVE_HARNESS_AUDIT_01.md` (rama local `exp/r4-deepseek-native-function-calling` @ `3c362a8`, no publicada) |
| ADR-041 (aviso de plataforma) | Rama `fix/r4-p0-run-failure-fallback` @ `387b720` (PR #27): **no está en main** |
| Servicios | Sólo el PostgreSQL local de pruebas (`r4-agent-platform-postgres`, 127.0.0.1:55432). Ninguna llamada a DeepSeek, WhatsApp, PrestaShop, CIA ni Customer Profile |
| Dependencias | `node_modules` enlazado (junction) desde el worktree `r4-j4-r6-closure`, mismo commit y mismo `package-lock.json` |

**Niveles de evidencia** usados en todo el documento:

| Marca | Significado |
|---|---|
| **[V]** | Verificado en esta auditoría con una sonda E2E ejecutada (P01–P13, §9) |
| **[T]** | Cubierto por una prueba existente del repositorio, citada. No se re-ejecutó, salvo que se indique |
| **[C]** | Lectura de código en `d0bb7a7`, con ruta y líneas |
| **[I]** | Inferido de [C]/[V], sin ejecución directa |
| **[D]** | Afirmado por un informe previo y **no** re-verificado aquí |

Las sondas usan `LiveOpsTestbed`, la composición productiva real en proceso: webhook firmado → ingress → binding → task → worker productivo Sales con modelo guionado → dueño de entrega → WhatsApp falso. La fuente y la salida están en `docs/architecture/evidence/j4-r7/`. El archivo de prueba temporal se borró del árbol después de ejecutarlo, porque esta tarea no agrega pruebas al repositorio.

---

## 1. Auditoría A — Ciclo de ejecución real

### 1.1 Flujo de datos (mensaje entrante → resultado)

```text
WhatsApp ──POST firmado──► channel-gateway  ChannelIngress.receive / ingest            live-ops/src/ingress.ts:106-175
                            │ inbound_events (único por provider_event_id) status=received
                            ▼
                         #process                                                     ingress.ts:185-272
                            │ binding abierto?  ── task terminal ⇒ closeBinding + binding NUEVO   :195-203
                            │ sin task ⇒ TemporalRuntime.createTaskWithInput (1 tx)       :230-240
                            │ con task ⇒ TemporalRuntime.submitInput                      :241-246
                            │      └ task_inputs + memory_entries(CONVERSATIONAL) + wake si
                            │        WAIT_FOR_INPUT | WAIT_UNTIL                temporal-runtime.ts:383-416
                            ▼ inbound_events.status=ingested, disposition                 ingress.ts:247-251
worker ── Worker.runOnce ── ExecutionRuntime.claimNext (lease + run nueva o reanudada)   worker.ts:120-148, execution-runtime.ts:305-376
            │
            ▼ AgentKernel.run (bucle; cada iteración relee el estado durable)           agent-kernel/src/kernel.ts:102-235
            │   load → [pendingRead | pendingAction | turnResponse] → budget →
            │   prepareContext (ContextSnapshot durable ANTES de la llamada) → decide →
            │   ├ read_capability  → step pending → observation → continúa
            │   ├ propose_action   → step pending + ActionProposal → ActionRuntime → observation | suspensión
            │   ├ manage_goal      → TemporalRuntime.decide → continúa (o refused, continúa)
            │   ├ wait / consultation / handoff → TemporalRuntime.decide → run suspended
            │   ├ respond          → step recorded → (siguiente pasada) #endTurn: WAIT_FOR_INPUT de plataforma
            │   └ complete         → finishExecution(completed) → task completed (TERMINAL)
            ▼
channel-gateway ── OutboundDeliveryRuntime.tick: sweep → materialize → dispatch        live-ops/src/outbound.ts:141-151
                    materializeResponses: 1 outbound por step respond recorded       persistence-postgres/src/production-store.ts:269-339
                    claimNextOutbound + decideDispatch (gate)                        production-store.ts:363-429, live-ops/src/delivery.ts:86-98
                    pending → dispatching → accepted → delivered → read | failed | unknown | cancelled
```

### 1.2 Máquinas de estado vigentes

```text
TASK (task-runtime/src/lifecycle.ts:22-31)                 RUN (contracts/src/run.ts:33, 85-101)
 pending ─► running ◄──► waiting                            running ─► completed  (completed)
              │  ▲ ◄──► blocked                                    ├─► failed     (model_failure, invalid_decision,
              │  └──── requires_approval                           │               capability_failure, budget_exhausted,
              ▼                                                    │               internal_failure)
  completed | failed | cancelled   (sin salida)                    ├─► suspended  (waiting, human_handoff,
                                                                   │               approval_required, write_outcome_uncertain)
                                                                   ├─► abandoned  (lease_lost > maxRunRecoveries)
                                                                   └─► cancelled
WAIT (contracts/src/temporal.ts:19): una activa por task (BD)
 WAIT_FOR_INPUT · WAIT_UNTIL      ← los despierta una entrada (submitInput)
 WAIT_FOR_HUMAN · WAIT_FOR_APPROVAL · WAIT_FOR_RECONCILIATION  ← NO los despierta una entrada
```

Mapeo terminación → task, en `ExecutionRuntime.finishExecution` (`execution-runtime.ts:600-672`) con
`taskStatusForTermination` (`:199-215`) y `runFailureDisposition` (`contracts/src/run.ts:189-199`):

| Terminación de la run | Disposición ADR-028 | Task resultante |
|---|---|---|
| `completed` | — | **completed** (terminal) |
| `invalid_decision` | recoverable | sigue `running`, run nueva; al agotarse → `blocked` + handoff de plataforma |
| `model_failure` con `retryable: true` | recoverable | igual |
| `model_failure` no reintentable | human | `blocked` + handoff de plataforma |
| `capability_failure`, `budget_exhausted`, `internal_failure` | **terminal** | **failed** |
| `lease_lost` (abandono en `claimNext`, `:345-366`) | (no pasa por `finishExecution`) | **failed** |
| `waiting` / `human_handoff` / `approval_required` / `write_outcome_uncertain` | — | `waiting` / `blocked` / `requires_approval` / `blocked` |

### 1.3 Tabla de transiciones (foco: `respond`, `complete`, `wait`)

| # | Transición | Archivo : función | Precondiciones | Estado inicial → final | Escrituras persistentes (misma tx) | Obligaciones pendientes tras la transición | Recuperación disponible | Estados inconsistentes posibles |
|---|---|---|---|---|---|---|---|---|
| T1 | **`respond`** | `kernel.ts:221-226` → `DurableKernelSession.recordStep` → `ExecutionRuntime.recordStep` (`execution-runtime.ts:433-447`, `appendStepWithin` `:675-759`) | lease vigente; task `running`; ningún step `pending`; iteración = siguiente | run `running` (step `respond recorded`) | `agent_run_steps` (+uso de la run) | Turno cerrado aún no registrado | Si el proceso muere aquí, al reanudar `load()` detecta `turnResponse` y cierra el turno **sin** llamar al modelo (`kernel.ts:133-135`, `agent-kernel/src/context.ts:99-140`) [C][T `tests/recovery/live-ops-process-crash.test.ts:90`] | Ninguno durable: el `respond` ya es durable; el outbound se deriva de él |
| T2 | **cierre de turno** (WAIT_FOR_INPUT de plataforma) | `kernel.ts:245-257` `#endTurn` → `TemporalRuntime.decide` (`temporal-runtime.ts:234-296`) | último step = `respond recorded` | run `running→suspended(waiting)`; task `running→waiting` | step `wait` origin `platform` (0 tokens), run, transición, `task_waits` WAIT_FOR_INPUT, lease liberado | Ninguna si el snapshot del borrador contenía todas las entradas | Entrada no vista por el borrador (`inputHorizonSnapshotId`) ⇒ wake inmediato (`:287-293`) [V P13] | Si la espera no suspende → `internal_failure turn_not_closed` → task **failed** (`kernel.ts:255-256`) [C] |
| T3 | **outbound** | `OutboundDeliveryRuntime.materialize` → `materializeResponses` (`production-store.ts:269-339`) | binding con task; step `respond recorded` sin outbound | — → `outbound_messages(pending)` | outbound único por `response_step_id`, `idempotency_key = r4-out:<step>` | Entrega | Reintento sólo de "definitivamente no enviado" (`delivery.ts:132-143`); `unknown` nunca se reenvía | Cancelado en el gate (`expired`, `window_closed`…) **sin efecto sobre la task** [V P08] |
| T4 | **`complete`** | `kernel.ts:227-232` → `#finish` → `DurableKernelSession.finish` (`apps/worker/src/session.ts:276-284`) → `finishExecution` | decisión válida; `result.evidence` ⊆ observaciones de la task (`decision-parser.ts:87-93`) | run `running→completed`; task `running→completed` (**terminal**) | step final `complete recorded`, run, transición con `result`, lease liberado | **Ninguna comprobación**: entradas no vistas o sin respuesta quedan huérfanas | Ninguna: los estados terminales no tienen salida (`lifecycle.ts:22-31`) | Entrada llegada durante la llamada del modelo queda adjunta a una task `completed` [V P02]; el próximo mensaje abre una task sin contexto [V P01, P11] |
| T5 | **`wait`** del agente (WAIT_FOR_INPUT / WAIT_UNTIL) | `kernel.ts:189-197` → `TemporalRuntime.decide` (`temporal-runtime.ts:256-294`) | decisión válida | run `→suspended(waiting)`; task `→waiting` | step, run, transición, `task_waits`; `schedules(wake)` si WAIT_UNTIL | **Entrada vista pero sin respuesta**: nada lo comprueba | Entrada **no vista** ⇒ wake inmediato [V P12]; WAIT_UNTIL ⇒ timer durable [T `temporal-waits.test.ts:213`] | Cliente y agente esperan a la vez (espera mutua) [V P05] |
| T6 | `request_consultation` | `temporal-runtime.ts:263-283` | `contextRefs` ⊆ observaciones (parser `:98-101`) | task `→waiting`, WAIT_FOR_HUMAN | `human_requests(consultation)`; `human_expiry` **sólo si el modelo dio `expiresAt`** (`:277`) | Cliente sin aviso; entradas nuevas no despiertan (`:410-414`) | Respuesta humana o expiración (si existe) → wake | Sin `expiresAt`: espera indefinida [V P06]; `expiresAt` pasado ⇒ `internal_failure` ⇒ task **failed** [V P07] |
| T7 | `request_handoff` (agente) | ídem `:274`, task `→blocked` | ídem | task `→blocked` | `human_requests(handoff, initiatedBy agent)` | Cliente sin aviso; outbound de agente posterior cancelado `superseded_by_operator` (`delivery.ts:91`) | Humano acepta/libera/cancela | Seguimientos del cliente sin respuesta hasta que actúe un operador [V P10] |
| T8 | `propose_action` → `approval_required` | `action-runtime.ts:396-416` | Policy REQUIRE_APPROVAL | run `→suspended`; task `→requires_approval` | observación, `human_requests(approval)` con **`expiresAt: null`** (`:409`) | Cliente sin aviso; entradas no despiertan | Decisión humana → acción resuelta antes de cualquier llamada al modelo (`kernel.ts:127-131`) [T `human-collaboration.test.ts:157,200`] | La aprobación no vence nunca [C] |
| T9 | Falla recuperable (ADR-028) | `kernel.ts:160-178` → `finishExecution` `:634-650` | `invalid_decision` o `model_failure` reintentable | run `failed`; task sigue `running` sin run | run con `termination.details.runFailureRecovery` | Turno en curso | Run nueva con snapshot nuevo (`claimNext` `:327-338`) | Al agotarse: `blocked` + handoff **sin aviso al cliente** [V P04] |
| T10 | Presupuesto agotado | `kernel.ts:137-138, 144-147, 199-202, 211-214, 316-328` | límite alcanzado | run `failed`; task **failed** | run, transición | Turno en curso | **Ninguna** | Sin respuesta ni handoff; el siguiente mensaje abre una task sin contexto [V P03] |
| T11 | Excepción de capacidad / acción / interna | `kernel.ts:271-284, 296-314, 355-368` | — | task **failed** | run | Turno en curso | Ninguna | Igual que T10 [T `tests/unit/agent-kernel/kernel.test.ts:207-211`] |
| T12 | Interrupción (lease perdido, stop, BD caída) | `kernel.ts:105, 151-152, 162`; `worker.ts:165-177` | — | run sigue `running` | ninguna (o liberación del lease) | Igual que antes | Reanudación de **la misma** run; snapshot reutilizado si sus entradas no cambiaron (`apps/worker/src/session.ts:136-150`) | Más de `maxRunRecoveries` tomas ⇒ run `abandoned`, task **failed** (`execution-runtime.ts:345-366`) [C] |
| T13 | Reanudación posterior | `temporal-runtime.ts:383-416, 790-810`; `claimNext` | entrada sobre `waiting` (INPUT/UNTIL) o decisión humana | task `→running`; run nueva | wait completada, transición, `task.woken` | — | La run nueva compila contexto fresco con todas las entradas | Entradas sobre `WAIT_FOR_HUMAN/APPROVAL`, `blocked` o terminales **no** reanudan |

### 1.4 Hallazgos del ciclo

- **A-1 [C][V]** Sólo `respond` produce salida al cliente, y `respond` termina el turno (protocolo v5, `kernel.ts:221-226, 245-257`; `request.ts:28`). Todo cierre que no pase por `respond` es silencioso por construcción, y el único mecanismo que comprueba entradas pendientes es el horizonte de espera de `TemporalRuntime.decide` (`:287-293`), que cubre `WAIT_FOR_INPUT` y `WAIT_UNTIL`, nunca `complete` ni las terminaciones fallidas.
- **A-2 [C]** `finishExecution` es atómica (step final, run, task y lease en una tx, `execution-runtime.ts:600-672`): **no existe** un estado intermedio "decidido pero no aplicado". El problema no es atomicidad, es **qué** transición se aplica.
- **A-3 [C]** Los presupuestos se derivan de estado durable. `modelCalls`, `iterations` y `readCapabilityCalls` cuentan los steps **de la run** (`agent-kernel/src/context.ts:99-110`); `writeActions` cuenta el ledger **de la task** (`execution-runtime.ts:415`). Por eso un presupuesto por run se agota dentro de un solo turno [V P03], mientras que el de escrituras se acumula durante toda la conversación (R6-2 [D]).
- **A-4 [C]** Las capacidades de escritura se ofrecen al modelo mientras el **límite** sea > 0, no lo **restante** (`agent-kernel/src/context.ts:148-150`): con 6/6 escrituras el modelo sigue viendo la capacidad y la propuesta termina la task (R6-2).

---

## 2. Auditoría B — Terminaciones silenciosas

Clasificación: **SL** silencio legítimo · **EP** ejecución pendiente · **SA** suspensión autorizada · **FR** fallo
recuperable · **AS** abandono silencioso.

| ID | Ruta | Comportamiento observado en `d0bb7a7` | Clase actual | Evidencia | Observado vs inferido |
|---|---|---|---|---|---|
| **B1** | `complete` sin respuesta ante solicitud explícita | Task `completed`, 0 outbound, binding cerrado `task_completed`; el siguiente mensaje abre una task nueva sin padre (`parent_task_id = null`) y con 1 sola entrada conversacional | **AS** | [V P01]; [C `kernel.ts:227-232`, `ingress.ts:195-203`] | Observado |
| **B2** | `complete` ante cierre social («Ok, gracias») | Tras una respuesta entregada (`accepted`), `complete` cierra la task sin mensaje. Si el cliente vuelve («quiero el banco regulable que me dijiste»), una task nueva no tiene la conversación | **SL** semánticamente, pero **sin regla verificable** que lo distinga de B1; además rompe continuidad | [V P11]; R6-5 [D] | Observado. Hoy B1 y B2 son el **mismo** camino de código |
| **B3** | `wait` sin condición durable de reanudación | (a) WAIT_FOR_INPUT ante una pregunta sin responder: espera mutua, 0 outbound [V P05]. (b) WAIT_UNTIL: timer durable, correcto [T `temporal-waits.test.ts:213`]. (c) Consulta sin `expiresAt`: ningún `schedule`; tres mensajes del cliente sin respuesta ni wake [V P06]. (d) Aprobación: `expiresAt: null` siempre [C `action-runtime.ts:409`] | (a) **AS** · (b) correcto · (c)(d) **SA sin límite** | [V P05, P06]; [C] | (a)(c) observado; (d) código |
| **B4** | Presupuesto de escrituras (`maxWriteActions`, alcance task) | `budget_exhausted/max_write_actions` ⇒ task **failed**, sin respuesta ni handoff; la siguiente entrada abre una task sin contexto | **AS** + pérdida de contexto | [T `tests/integration/governed-execution.test.ts:314`, `run-failure-recovery.test.ts:340`]; [C `kernel.ts:209-214`, `run.ts:198`, `context.ts:148-150`]; R6-2 [D] | Terminación observada en las pruebas existentes; el efecto de canal es el mismo camino de B5 [V P03] |
| **B5** | Presupuesto de llamadas LLM / iteraciones / lecturas / duración / tokens / contexto | 20 decisiones idénticas rechazadas (`goal_not_found`) agotan `maxIterations` 20/20 ⇒ task **failed**, 0 `human_requests`, 0 outbound; el siguiente mensaje abre otra task | **AS** | [V P03]; [T `kernel.test.ts:99,112`] | Observado. **No existe detección de no-progreso**: 20 steps idénticos (R6-4 [D]: 39 búsquedas, respuesta en 40/40) |
| **B6** | Excepción durante una capacidad | READ que no produce evidencia ⇒ `capability_failure` ⇒ task **failed**. Acción no resoluble ⇒ `internal_failure action_execution_error` ⇒ **failed** | **AS** | [T `kernel.test.ts:207-211`]; [C `kernel.ts:271-284, 296-314`] | **Parcial**: unitario + código; no reproducido E2E (requiere fallar el almacén de observaciones). Nota: un error o timeout del handler (p. ej. CP caído) produce una observación fallida y la run **continúa** [C `capability-runtime/src/invoker.ts:182-190`; D R6 §7] |
| **B7** | Salidas inválidas repetidas | Run 1 `continued`, run 2 `exhausted` ⇒ task `blocked` `run_failure_recovery_exhausted` + handoff de plataforma `requested`; **0 outbound**; el seguimiento del cliente queda `human_owned` sin respuesta | **FR → SA sin aviso** (para el cliente es **AS**) | [V P04]; R6 `f1-c` [D]; ADR-041 fuera de main [C `git`] | Observado |
| **B8** | Interrupción o reinicio del worker | Misma run reanudada desde el log durable; READ y acciones nunca se re-deciden; `respond` registrado cierra el turno sin llamar al modelo. Más de `maxRunRecoveries` (3) tomas ⇒ `abandoned` ⇒ task **failed** | **EP** (correcto) · exceso de tomas: **AS** | [T `tests/recovery/worker-process-crash.test.ts:44`, `temporal-process-crash.test.ts:187`, `live-ops-process-crash.test.ts:66,90`, `run-failure-recovery-crash.test.ts:46`]; [C `execution-runtime.ts:345-366`] | Pruebas existentes (no re-ejecutadas aquí: `test:recovery` termina conexiones del PostgreSQL compartido) |
| **B9** | Entrada nueva durante una ejecución activa | Se registra en la task en ejecución (lock de fila). Destino según el final de la run: `respond` ⇒ borrador cancelado `superseded_by_newer_input` y run nueva que responde [V P13]; `wait` ⇒ wake inmediato [V P12]; **`complete` ⇒ entrada huérfana** en task `completed`, inbound `ingested` con `disposition: autonomous` (falso), ninguna run posterior [V P02]; presupuesto o falla terminal ⇒ huérfana en task `failed` [I de P02+P03]; consulta, handoff o aprobación ⇒ registrada sin wake [V P06, P10] | respond/wait: correcto · complete/falla: **AS** · humano: **SA** | [V P02, P12, P13] | Observado (salvo la variante terminal-por-falla, inferida) |
| **B10** | Handoff humano pendiente | Task `blocked`, ningún mensaje al cliente; seguimientos `human_owned` sin respuesta hasta la acción del operador; ningún vencimiento | **SA sin aviso ni límite** | [V P10] | Observado |
| **B11** | Autorización comercial pendiente (REQUIRE_APPROVAL) | La propuesta termina la run (`approval_required`) sin que el agente pueda avisar al cliente; la aprobación no vence; las entradas no despiertan | **SA sin aviso ni límite** | [C `action-runtime.ts:396-416`]; [T `human-collaboration.test.ts:157,200,332`] | **Parcial / INCONCLUSIVE E2E**: `sales-production@1` (perfil del testbed) no registra capacidades que requieran aprobación |
| **B12** | Error de entrega del canal | `expired` (y por el mismo gate `window_closed`, `failed`) cancela o falla el outbound; la task sigue en WAIT_FOR_INPUT; nada la despierta. `unknown` nunca se reenvía (correcto). `cancelled/expired` **no** aparece en `attention()` (sólo `unknown`, `failed`, retenidos) | **FR no gestionado** | [V P08]; [C `production-store.ts:643-650`]; [T `live-ops-process-crash.test.ts:66`] | Observado |

**Hallazgos adicionales (fuera de B1–B12):**

| ID | Hallazgo | Evidencia | Severidad propuesta |
|---|---|---|---|
| **X1** | Un valor elegido por el modelo termina la task: `request_consultation.expiresAt` en el pasado ⇒ `PlatformError(validation, expiry_in_past)` dentro de `TemporalRuntime.decide` ⇒ `#call` ⇒ `internal_failure internal_error` ⇒ task **failed**. El parser no valida la fecha (no tiene reloj) | [V P07]; [C `temporal-runtime.ts:266-268`, `kernel.ts:355-368`, `apps/worker/src/session.ts:371-382`] | P1 |
| **X2** | `finish_reason` se descarta: el adaptador lo mapea (`provider.ts:169-182`), el gateway lo emite sólo en telemetría (`gateway.ts:113-121`), y ni el kernel (`kernel.ts:89-100`), ni el step, ni la terminación lo guardan. Una salida truncada (`length`) es un `invalid_structured_output` cualquiera y ADR-028 la reintenta igual | [V P09] | P2 |
| **X3** | `inbound_events.disposition` dice `autonomous` para entradas que nada procesará autónomamente (huérfana en task completada; durante una consulta) | [V P02, P06]; [C `ingress.ts:247-248`] | P3 |
| **X4** | Sin detección de repetición o no-progreso: sólo conteos | [V P03]; R6-4 [D] | P2 |
| **X5** | Las tasks `failed` no aparecen en ninguna vista de atención (`TemporalRuntime.attention` `:192-207`; `ProductionStore.attention` `:643-650`) | [C] | P1 (agrava B4–B6) |

---

## 3. Auditoría C — ADR-028 y recuperación

### 3.1 Clasificación vigente de errores del proveedor y de la salida

| Situación | Dónde se clasifica | `ModelError.kind` / código | `retryable` | Disposición ADR-028 | Efecto |
|---|---|---|---|---|---|
| HTTP 429 | `provider.ts:129` | `rate_limited` | sí | recoverable | run nueva |
| HTTP 408/504, deadline del adaptador | `provider.ts:99,130` | `timeout` | sí | recoverable | run nueva |
| Timeout del gateway (proveedor que ignora abort) | `gateway.ts:84-90,128-133` | `timeout` | sí | recoverable | run nueva |
| Falla de transporte (red) | `provider.ts:100` | `provider_error` | sí | recoverable | run nueva |
| HTTP 5xx | `provider.ts:135` | `provider_error` | sí | recoverable | run nueva |
| HTTP 401/403 | `provider.ts:133` | `provider_error` | no | human | `blocked` + handoff |
| HTTP 400 por tamaño / envelope previo | `provider.ts:66-76,131-132` | `provider_error` (`model_envelope_exceeded`) | no | human | `blocked` + handoff |
| Otro 4xx | `provider.ts:136` | `provider_error` | no | human | `blocked` + handoff |
| Cuerpo no es chat completion | `provider.ts:111-113` | `invalid_provider_response` | no | human | `blocked` + handoff |
| Excepción desconocida del proveedor | `gateway.ts:139-141` | `provider_error` | no | human | `blocked` + handoff |
| **Abort / cancelación** (lease perdido, stop) | `gateway.ts:67-69,84-90,128-133`; `kernel.ts:151-152,162` | `cancelled` | — | **no es falla** | interrupción: la **misma** run se reanuda y reutiliza el snapshot (`apps/worker/src/session.ts:144-150`) |
| `finish_reason=stop` + JSON inválido o varios documentos | `decision-parser.ts:105-118` | `invalid_decision/*` | — | recoverable | run nueva (R6 `f1-c`: los 2 intentos fallaron) |
| **`finish_reason=length`** (truncada) | ignorado | `invalid_structured_output` | — | recoverable (como si fuera stop) | run nueva con contexto equivalente [V P09] |
| `finish_reason=content_filter` | ignorado | normalmente `invalid_structured_output` ("no output") | — | recoverable | reintento con alta probabilidad de repetir [I] |
| Contexto que no cabe en el presupuesto del compilador | `kernel.ts:144-147` | `budget_exhausted/max_context_tokens` | — | **terminal** | task **failed** |

### 3.2 Reintentos, presupuestos e idempotencia vigentes

| Mecanismo | Presupuesto | Contador | Persistencia de intentos | Idempotencia |
|---|---|---|---|---|
| Recuperación de run fallida (ADR-028) | `maxRunFailureRecoveries` = 1 (`R4_EXEC_MAX_RUN_FAILURE_RECOVERIES`) | derivado de `agent_runs` (`execution-runtime.ts:776-787`) | 1 run por intento + `termination.details.runFailureRecovery` | la run nueva no repite propuestas, READs ni receipts (ADR-028 §Invariantes) [C `kernel.ts:118-131`] |
| Toma de una run huérfana | `maxRunRecoveries` = 3 | `agent_runs.recoveries` | columna | misma run, mismos ids |
| Llamada al modelo dentro de un step | **ninguno**: 1 llamada = 1 step | `modelSteps.length` | el step final `model_failed` o `invalid`; los intentos interrumpidos no dejan step, sólo el snapshot `attempt` | snapshot reutilizado si sus entradas no cambiaron |
| READ | 1 intento | `readCapabilityCalls` | observación por `invocationId` | `invocationId` asignado antes de ejecutar (`execution-runtime.ts:705`) |
| Escritura gobernada | `retryPolicy` por capacidad (≤10) + `action_retry` durable | ledger | `action_execution_attempts` | `executionKey` de plataforma; `unknown` ⇒ reconciliación [T `governed-write-crash.test.ts:46`] |
| Entrega | `maxAttempts` sólo para `not_sent` | `outbound_messages.attempts` | `outbound_delivery_attempts` | `idempotency_key r4-out:<step>`; `unknown` nunca reenviado |

### 3.3 ¿Qué es recuperable sin repetir herramientas ni escrituras?

- **Antes de que exista una decisión** (transporte, timeout, 429, 5xx, abort, salida inválida, truncada): todo. No se
  produjo efecto. La run nueva o la reanudada recompila desde estado durable [C].
- **READ ejecutado y observado**: no se repite. La observación es evidencia de la task y la ve la run nueva [C `kernel.ts:118-124`].
- **Escritura en curso o con resultado incierto**: el ledger la resuelve antes de cualquier llamada al modelo
  (`kernel.ts:125-131`). Nunca se genera una clave nueva [C][T].
- **`respond` registrado**: nunca se re-decide. El turno se cierra al reanudar [C][T]. La preocupación "R4-I" de
  ADR-028 (una run que responde y luego falla) **ya no puede ocurrir en v5**: después de un `respond` no hay más
  decisiones del modelo en la run. El único fallo posterior posible es `turn_not_closed` (`kernel.ts:256`), y ése
  termina la task **failed**. Es un caso de T10/T11 [C].

### 3.4 Evaluación: recuperación dentro del mismo paso (concepto DeepSeek Harness)

El mandato pide evaluar una recuperación "dentro del mismo paso", inspirada en `agent/request-error` y
`assistant/attempt` de DeepSeek Harness. **No hay fuente de DeepSeek Harness en este entorno.** El concepto se toma
como lo describe el mandato: un error de request se registra como evento y genera un nuevo intento del asistente dentro
del mismo turno, en vez de fallar el turno. La fidelidad al original queda **INCONCLUSIVE**.

Mapeo a R4: "turno" = iteración (step) y "attempt" = llamada al modelo con el mismo `ContextSnapshot`.

| Clase | ¿Reintento en el mismo step? | Razón |
|---|---|---|
| Abort/cancelación | **Ya existe** | La run se reanuda y el snapshot se reutiliza (`session.ts:144-150`) |
| Transporte, timeout, 429, 5xx | Seguro (nada generado), **pero** sin registro durable del intento: `modelCalls` se deriva de los steps (`context.ts:106`) y un intento sin step sería invisible al presupuesto (la objeción de ADR-028 a los reintentos en adapter o gateway). Requiere un outcome de step no terminal (cambio de contrato de `RunStep`) o una migración | **Diferir**: 0 fallas de transporte en H (ADR-028) y ninguna reportada en R6 [D] |
| `length` | Repetir la misma petición tiende a repetir el truncamiento. R4 no envía `max_tokens` (perfil provider-managed): no hay palanca | No en el mismo step. Registrar `finishReason` y permitir **una** run nueva |
| `content_filter` | Determinista con el mismo contexto | No reintentar; contingencia |
| JSON inválido (`stop`) | Mismo contexto ⇒ alta repetición (ADR-041: 4/5 con el mismo contexto [D]); además ADR-008 prohíbe reparar | No en el mismo step; run nueva acotada y luego contingencia |

Conclusión de C: el problema no es la granularidad del reintento sino **qué ocurre al final de la recuperación**. Hoy
termina en `failed` (presupuestos y excepciones) o en un handoff mudo (ADR-028 agotado). La propuesta de política está
en `R4_J4_R7_DESIGN.md` §3.

---

## 4. Auditoría D — Continuidad entre tareas

### 4.1 Mapa de persistencia (Conversation → Task → Goal)

| Entidad | Tabla | Clave / relación | Vida | Visible para el modelo |
|---|---|---|---|---|
| Conversación de canal | `channel_conversation_bindings` | único abierto por `(channel, conversation_key)`; `task_id` | se cierra cuando la task es terminal (al llegar el siguiente mensaje) | no |
| Evento entrante | `inbound_events` | único por `provider_event_id`; `task_id`, `input_id`, `disposition` | permanente (contenido borrado al asentar) | no |
| Entrada canónica | `task_inputs` | único `(task_id, source_ref, external_key)`; `memory_entry_id` | de la task | sí, vía `memory_entries` CONVERSATIONAL |
| Texto dicho | `memory_entries` (CONVERSATIONAL / DERIVED_SUMMARY) | `task_id` | de la task | sí (compactable) |
| Task | `agent_tasks` | `parent_task_id` (existe, **no se usa** en canal), `root_goal_id`, `current_goal_id` | terminal sin salida | sí |
| Goals | `goals`, `goal_transitions` | `task_id` | de la task | sí |
| Run / step | `agent_runs`, `agent_run_steps` | `task_id` | de la task | respuestas de runs anteriores, esperas y rechazos de goal (`context-compiler/src/sources/platform.ts:149-236`) |
| Contexto evaluado | `context_snapshots`, `context_snapshot_items` | `(run_id, iteration, attempt)`; ítem `memory:<entry>` | inmutable | — |
| Evidencia | `observations`, `action_*`, `action_receipts` | `task_id` | de la task; **sólo citable dentro de la task** (`execution-runtime.ts:716-723`) | sí |
| Humanos / esperas / timers | `human_requests`, `task_waits`, `schedules`, `temporal_events` | `task_id` | de la task | sí (interacciones) |
| Salida | `outbound_messages`, `outbound_delivery_*` | `response_step_id` único | permanente | estado de entrega (`live-ops/src/context-source.ts:25-38`) |

### 4.2 Respuestas

1. **¿Puede una task terminal desvincular el historial?** Sí. `ingress.ts:197-201` cierra el binding y abre otro con
   una task nueva sin `parent_task_id` y sin memoria cruzada ("no cross-task memory"). La historia sigue en la BD,
   pero es inalcanzable desde la task nueva [V P01, P03, P11].
2. **¿Cómo se recuperan los mensajes anteriores?** Dentro de la task: cada iteración recompila desde
   `memory_entries` CONVERSATIONAL, las respuestas de runs anteriores, esperas, humanos y observaciones, con
   compactación no autoritativa [C]. Entre tasks: no se recuperan.
3. **¿Qué pasa cuando el cliente vuelve a escribir?** Depende del estado (§1.3 T13): `waiting` (INPUT/UNTIL) ⇒ wake;
   `running` ⇒ lo ve la siguiente iteración; `WAIT_FOR_HUMAN/APPROVAL/RECONCILIATION` o `blocked` ⇒ se registra
   sin wake; terminal ⇒ task nueva.
4. **¿Cómo se preservan las referencias comerciales?** Las observaciones y receipts son de la task y sólo son
   citables dentro de ella. El workspace Sales es estado de dominio fuera de Core. Una task nueva no lo hereda: R6-2,
   «no tengo ninguna cotización» [D] [I].
5. **Durante un handoff:** las entradas se registran; el operador ve el hilo; el outbound del agente pendiente se
   cancela (`superseded_by_operator`). Al liberar, la run nueva ve todas las entradas no vistas y responde [C][T].
6. **¿Una task nueva recupera estados y objetivos pendientes?** No. Recibe el goal raíz del pack, y ningún goal,
   consulta ni aprobación de la anterior [C `agents/sales/src/production/composition.ts:260-264`].
7. **Mensajes simultáneos:** inbound deduplicado por id de proveedor; `submitInput` y `materialize/claim` serializados
   por el lock de fila de la task; entrada idempotente por `(task, source, externalKey)`; a lo sumo una run activa y
   una espera activa; carrera binding/terminal resuelta con un reintento (`ingress.ts:253-258`) [C][T
   `temporal-waits.test.ts:152,169`][V P12, P13]. **Brecha:** la carrera "entrada durante la llamada que decide
   `complete` o termina por falla" deja la entrada huérfana [V P02].
8. **¿Qué entradas consumió cada ejecución?** Es **derivable sin estructuras nuevas**: `context_snapshot_items.item_id
   = 'memory:' || task_inputs.memory_entry_id` por snapshot, y `context_snapshots.run_id` por run. Es la misma
   relación que ya usan `hasUnseenInput` (`temporal-store.ts:191-199`) y la detección de supersesión
   (`production-store.ts:379-391`). Lo que **no** existe es la noción "respondida" ni "cerrada sin respuesta".

**Conclusión D:** las estructuras existentes bastan para identificar las entradas consumidas y las no vistas. Falta
(a) impedir que una entrada quede huérfana en una task terminal y (b) un vínculo de linaje entre la task terminal y la
siguiente del mismo binding. Para (b) ya existe `agent_tasks.parent_task_id`. No se demostró insuficiencia que
justifique una migración estructural.

---

## 5. Auditoría E — Outbox y autorizaciones

### 5.1 Garantías de entrega vigentes

| Garantía | Estado | Evidencia |
|---|---|---|
| Mensaje generado = step `respond recorded` durable antes de cerrar el turno | Cumple | [C `kernel.ts:221-226,135`] |
| Persistido: 1 outbound por step (`unique response_step_id`), clave `r4-out:<step>` | Cumple | [C `production-store.ts:328-333`] |
| Pendiente → claim con lease y fencing; gate evaluado en la tx del claim | Cumple | [C `production-store.ts:363-429`] |
| Enviado ≠ entregado: `accepted` (id de proveedor) vs `delivered/read` (callbacks monotónicos) | Cumple (INV-D4 de hecho) | [C `delivery.ts:149-163`] |
| Reintentos sólo de "definitivamente no enviado"; `unknown` nunca reenviado | Cumple | [C `delivery.ts:132-143`][T `live-ops-process-crash.test.ts:66`] |
| Duplicados: `duplicate_content` sólo con prueba causal de igual frontera | Cumple | [C `production-store.ts:288-326`] |
| Falla permanente visible | Parcial: `failed` y `unknown` en `attention()`; **`cancelled` (`expired`, `window_closed`) no** | [C `production-store.ts:643-650`][V P08] |
| Retroalimentación a la conversación de una entrega fallida o cancelada | **No existe**: sólo un episodio en la próxima cognición (`context-source.ts`), que no ocurre si nadie despierta la task | [V P08] |

**¿Puede la task cerrarse antes de establecer un resultado durable?** Para `respond`, no: el step es durable antes del
cierre. El problema es el inverso: la task se cierra (o se suspende) **sin** que exista resultado alguno para la
entrada (`complete`, presupuestos, fallas, consulta, handoff, aprobación) [V P01–P07, P10].

### 5.2 Autorizaciones, grants, handoff, suspensión, reactivación, cancelación

| Mecanismo | Comportamiento | ¿Implica abandonar la conversación? | Evidencia |
|---|---|---|---|
| Aprobación (REQUIRE_APPROVAL) | Durable en `human_requests`; sobrevive reinicios; la política se re-evalúa al aprobar; **no vence**; la propuesta termina la run **sin** aviso al cliente | Sí, de hecho: la petición de permiso deja al cliente sin respuesta hasta la decisión humana | [C `action-runtime.ts:396-416`][T `human-collaboration.test.ts:157,200`] |
| Grants de Customer Profile / CIA (J4) | Estado de dominio consumido por capacidades Sales; una verificación pendiente produce observaciones `unavailable/not_verified` y el agente responde; **no** suspende la task | No | [C capacidades `customer-v3.ts`, `identity-verification.ts`][D R6 §7] |
| Grants internos de intento de acción | Permiso de una llamada externa, durable antes de ejecutarse | No (interno) | [C `action-runtime.ts:83-99`] |
| Handoff (agente, operador, plataforma) | `blocked`; `humanOwned` incluye `requested` ⇒ todo outbound de agente se cancela; ningún aviso automático en main | Sí hasta que actúe un humano | [C `production-store.ts:703-712`, `delivery.ts:91`][V P04, P10] |
| Suspensión de IA (kill switch, deny, rollout, contenido no soportado) | Hold en ingress (handoff de plataforma) y hold en dispatch; entradas durables | Suspensión autorizada por operador: silencio **por diseño** | [C `ingress.ts:213-221`, `delivery.ts:88-90`] |
| Reactivación | `releasePlatformHold` ⇒ wake ⇒ la run nueva ve las entradas no vistas | No | [C `temporal-runtime.ts:471-494`] |
| Cancelación | `cancelTask` / `cancelTaskByPlatform`: run, espera, humanos y timers cancelados; intención terminal diferida si hay efectos inciertos | Acto humano explícito: legítimo | [C `temporal-runtime.ts:660-689`] |

---

## 6. Limitaciones identificadas

| ID | Limitación | Rutas |
|---|---|---|
| L-1 | No existe noción durable de "obligación conversacional": nada impide cerrar o suspender con una entrada sin respuesta | B1, B3a, B9 |
| L-2 | `complete` siempre es terminal y nunca comprueba entradas no vistas ni sin respuesta | B1, B2, B9 |
| L-3 | Presupuestos, excepciones y abandono por lease son **terminales** (`run.ts:198`, `execution-runtime.ts:362`) | B4, B5, B6, B8 |
| L-4 | Ninguna contingencia determinista hacia el cliente en main (ADR-041 sin fusionar) | B4–B7, B10, B11 |
| L-5 | Consultas y aprobaciones sin vencimiento por defecto | B3c, B3d, B11 |
| L-6 | Task terminal ⇒ binding nuevo sin linaje (`parent_task_id` nulo) ni memoria | B1, B2, B4, B5 |
| L-7 | `finish_reason` descartado; truncamiento indistinguible de protocolo inválido | X2 |
| L-8 | Validaciones de la plataforma sobre valores del modelo que terminan la task en vez de rechazar el step | X1 |
| L-9 | Entrega cancelada o fallida sin retroalimentación a la conversación ni a la atención (`expired`, `window_closed`) | B12 |
| L-10 | Sin detección de no-progreso | B5, X4 |
| L-11 | Tasks `failed` invisibles para operadores | X5 |
| L-12 | `disposition` del inbound no refleja el destino real | X3 |
| L-13 | El contrato `KernelSession.finish` no puede rechazar una terminación y continuar **la misma run** (`agent-kernel/src/session.ts:61`). El diseño evita ese cambio difiriendo la transición de la task (run nueva). Continuar la misma run requeriría KC-1, una evolución versionada del puerto (D-5: no ahora) | B1, B2 |

## 7. Riesgos de compatibilidad (para cualquier corrección)

- **Semántica de estados:** convertir finales `failed` en `blocked` cambia métricas, listados, `attention()`, clientes
  de la API y pruebas que hoy esperan `failed`: `tests/unit/task-runtime/execution-lifecycle.test.ts:70-71`,
  `tests/unit/contracts/decision-and-execution-contracts.test.ts:69-70`, `tests/integration/governed-execution.test.ts:314,335`,
  `tests/integration/run-failure-recovery.test.ts:340`, más los casos shadow H08* y las mutaciones de recuperación.
- **Vida de las tasks:** si menos tasks terminan, la conversación vive más, el contexto crece (lo absorbe la
  compactación) y `maxWriteActions` (alcance task) se acumula más.
- **Protocolo v5 / ADR-008:** cualquier campo nuevo en `AgentDecision` es una versión nueva del protocolo. El diseño lo
  evita (ver diseño §6).
- **J3 (cotización autónoma):** `locateConfirmation` (`agents/sales/src/capabilities/quote-v4.ts:185-207`) sólo
  considera entradas `agent`/`operator` del hilo. Un aviso de plataforma entre la oferta y la confirmación no la
  invalidaría. **Decidido en DESIGN-02 (D-4):** es el comportamiento deseado (los avisos son informativos), así que
  no requiere cambio.
- **Migración ADR-041 (`0012`):** si se revierte el código después de crear outbounds `platform`, el gate antiguo los
  trata como salida de agente (`delivery.ts:87` sólo distingue `operator`). Con `humanOwned` se cancelan, sin riesgo
  de envío fuera de control [C].
- **Perfiles pinneados (EV-2):** las tasks `blocked` siguen pinneadas a su definición; sin impacto [C
  `profile-pinned-claims`].

## 8. Contraste con auditorías previas

| Afirmación previa | Fuente | Verificación en `d0bb7a7` |
|---|---|---|
| Sólo `respond` produce salida; los demás cierres son mudos | NATIVE_HARNESS_AUDIT_01 §0.2 | **Confirmada** [V P01, P03, P05, P06, P10] |
| Task terminal ⇒ binding nuevo sin memoria | ídem §0.3 | **Confirmada** [V P01, P11] |
| Agotar cualquier conteo termina la task en silencio | ídem §0.4 | **Confirmada** para `max_iterations` [V P03] y por pruebas para el resto [T] |
| R4 ignora `finish_reason` | ídem §0.5 | **Confirmada** [V P09] |
| Capacidades de escritura visibles con 0 restantes | ídem §4.1 | **Confirmada** [C `context.ts:148-150`] |
| Aprobación nunca vence | ídem §5.4 #19 | **Confirmada** [C `action-runtime.ts:409`] |
| "21 de 30 rutas pueden dejar una entrada sin respuesta" | ídem §5.4 | **No re-verificada en su totalidad** [D]. Las rutas relevantes a B1–B12 sí se verificaron (tabla §2) |
| F-1 `f1-c`: doble salida inválida ⇒ handoff sin mensaje | R6 canary §6 | **Mecanismo confirmado** [V P04]; el dato del canary es [D] |
| R6-2 (`max_write_actions`), R6-3 (consulta), R6-5 (`complete` ante «gracias») | R6 canary §6 | **Mecanismos confirmados** [T][V P06][V P11] |
| ADR-028: "la recuperación no re-ejecuta propuestas ni receipts" | ADR-028 | **Confirmada** por código [C `kernel.ts:118-131`] y pruebas [T] |
| ADR-028 R4-I: "una run de recuperación podría responder otra vez" | ADR-028 §Consecuencias | **Obsoleta en v5** (§3.3) |
| ADR-041 corrige F-1 hacia el cliente | ADR-041 | **No está en main** [C `git merge-base`]; sólo cubre los handoffs de falla de run |

## 9. Anexo — Sondas ejecutadas

Fuente: `docs/architecture/evidence/j4-r7/r4-j4-r7-probes.test.ts.txt`. Salida: `probes-evidence.jsonl.txt`,
`probes-summary.txt` (13 passed, 2026-10-28 17:11:40 -0300, 61 s, PostgreSQL local).

| Sonda | Ruta | Resultado actual (lo que afirma la sonda) |
|---|---|---|
| P01 | B1 | `completed`, 0 outbound, binding `task_completed`, task nueva sin padre y con 1 entrada |
| P02 | B9 | entrada durante la llamada que decide `complete`: 2 inputs en task `completed`, inbound `ingested/autonomous`, 0 runs nuevas |
| P03 | B5 | 20 steps `refused` idénticos ⇒ `budget_exhausted/max_iterations` ⇒ `failed`, 0 handoffs, 0 outbound, task nueva al volver |
| P04 | B7 | `continued` → `exhausted` ⇒ `blocked` + handoff de plataforma, 0 outbound, seguimiento `human_owned` |
| P05 | B3a | WAIT_FOR_INPUT ante una pregunta: `waiting`, 0 outbound |
| P06 | B3c / R6-3 | consulta sin `expiresAt`: 0 schedules, 3 entradas, 0 outbound, seguimiento `autonomous` |
| P07 | X1 | `expiresAt` pasado ⇒ `internal_failure/internal_error` ⇒ `failed` |
| P08 | B12 | outbound `cancelled/expired`; task en WAIT_FOR_INPUT; ninguna run |
| P09 | X2 | `finish_reason=length` ⇒ `invalid_structured_output`; sin rastro de `finishReason` en la terminación |
| P10 | B10 | handoff del agente: `blocked`, 0 outbound, seguimiento `human_owned` |
| P11 | B2 | respuesta `accepted` + «Ok, gracias» ⇒ `complete`; al volver, task nueva con 1 entrada |
| P12 | control | entrada durante la llamada que decide `wait` ⇒ wake inmediato y respuesta |
| P13 | control | entrada durante el borrador de `respond` ⇒ borrador `superseded_by_newer_input`, respuesta nueva |

Re-ejecución: copiar la fuente a `tests/integration/r4-j4-r7-probes.test.ts` en un worktree de `d0bb7a7` con el
PostgreSQL de pruebas activo y ejecutar `npx vitest run --project integration tests/integration/r4-j4-r7-probes.test.ts`.
No ejecutar en paralelo con `npm run test:recovery`.

## 10. Addendum DESIGN-02 — Steering y referencias (2026-10-28)

### 10.1 Estado actual del steering (nivel 1) en `d0bb7a7`

| Frontera | Comportamiento | Evidencia | Clase |
|---|---|---|---|
| Antes de cada llamada al modelo (misma run) | Recompila desde estado durable: toda entrada nueva entra en la siguiente iteración | [C `kernel.ts:107-150`][T `temporal-waits.test.ts:169`] | Confirmado |
| Cierre de turno tras `respond` | Una entrada no vista por el borrador despierta la task; el borrador se cancela `superseded_by_newer_input` | [V P13] | Confirmado |
| `wait` del agente | Horizonte ⇒ wake inmediato | [V P12] | Confirmado |
| `complete` | Sin control: entrada huérfana | [V P02] | Confirmado (defecto) |
| Finales terminales por falla | Entrada adjunta a una task `failed` | [C][I de P02 + P03] | Inferido |
| Suspensiones humanas | Registrada, sin wake ni aviso | [V P06, P10] | Confirmado |
| **Resolución de una aprobación** | Tras aprobar, `load()` carga la propuesta aprobada como `carriedAction` y el kernel la ejecuta **antes** de cualquier llamada al modelo: las entradas recibidas durante la espera (W1) o después de la decisión (W2) no la afectan | [C `apps/worker/src/session.ts:110`, `agent-kernel/src/context.ts:116-117`, `kernel.ts:125-131`][**V A-W1, A-W2**] | **Confirmado por ejecución** (§10.3) |
| Llamada al modelo y escrituras en vuelo | Nunca se interrumpen (la interrupción sólo llega por lease o stop) | [C `worker.ts:186-224`] | Confirmado por código |
| Autorización de escritura (J3) | El dominio exige que la última entrada del cliente sea una confirmación explícita posterior a la oferta | [C `quote-v4.ts:192-206`] | Confirmado por código |
| Precondiciones de cierre ante efecto incierto | `transitionTaskWithin` difiere sólo `cancelled`/`failed` (`mutations.ts:77-82`). Hoy un `completed` con efecto incierto no es alcanzable porque el claim excluye esas tasks | [C][I] | Inferido |

### 10.2 Referencias consultadas para DESIGN-02

| Referencia | Estado | Uso |
|---|---|---|
| Manual tahan-tech Ed. 1 (`~/Downloads/manual-harness-tahan-tech.pdf`), secciones 7.4, 7.6, 7.7, 7.11, 9.8–9.10, 14.5–14.6 | **Leídas** [M] (el capítulo 8 sólo a través del resumen de 7.7) | Diseño §3.5 |
| PR #27 (ADR-041) | Abierto, head `93fe35a`, sin revisión, `mergeable: UNKNOWN`, actualizado el 2026-10-26 (`gh pr view`, sólo lectura) | Diseño §5.2, D-8 |
| DeepSeek Harness (`agent/request-error`, `assistant/attempt`) | Sigue sin fuente local: INCONCLUSIVE (§3.4) | — |

Nuevo nivel de evidencia: **[M]** = sección del manual tahan-tech leída en este mandato (describe tahan-tech, no R4).

### 10.3 Addendum G0 Resolution — aprobación pendiente y modificación de la solicitud

**Sondas A-W1 y A-W2** (`docs/architecture/evidence/j4-r7/r4-j4-r7-approval-probes.test.ts.txt`, salida en
`approval-probes-evidence.jsonl.txt`; 2/2 sobre `d0bb7a7`, 2026-10-28 18:27:03 -0300). Usan el harness de
`tests/integration/human-collaboration.test.ts` con la capacidad IRREVERSIBLE_WRITE de prueba y la política `WRITES`.

| Sonda | Guion | Observado |
|---|---|---|
| A-W1 | Propuesta (100 kg) ⇒ `require_approval`; **antes** de decidir entra «Mejor que sean 120 kg»; el humano aprueba; corre el worker | Task `requires_approval` tras la entrada (sin wake). Decisiones `[require_approval, allow/human_approved]`; **1** ejecución con los argumentos originales; receipt `succeeded`. La **primera** llamada al modelo ya contiene la observación `succeeded` **y** el cambio |
| A-W2 | Ídem, pero la entrada llega **después** de aprobar y antes de que corra el worker | Idéntico |

**Garantías verificadas por componente** (detalle en diseño §5.4.1):
- **ActionRuntime:** re-prepara argumentos y pide una decisión nueva (`action-runtime.ts:299-321, 879-882`).
- **Policy Engine:** liga la aprobación a propuesta, versión y hash de argumentos y re-evalúa la política
  (`policy-engine/src/engine.ts:31-77`). No recibe hechos de la conversación, por diseño.
- **J3 `quote.create@2`:** verifica los hechos del dueño en el primer intento, pero **no** la conversación.
- **J3E `@6`–`@8`:** sí verifica que la última entrada sea la confirmación (`quote-v4.ts:192-206`), pero no usa
  aprobaciones.
- **Inspección de aprobaciones:** no muestra el hilo (`agents/sales/src/production/approvals.ts:74-82`).
- **Unicidad:** `human_requests.proposal_id` es único (`0005_temporal_human_runtime.sql:43`).

**Conclusión:** la brecha existe y es **BLK-AP1** (diseño §5.4): ningún componente impide hoy ejecutar una acción
aprobada después de que el cliente cambió la solicitud. **No se asume que el modelo la resuelva:** las sondas muestran
que el modelo no es consultado antes de la ejecución.
