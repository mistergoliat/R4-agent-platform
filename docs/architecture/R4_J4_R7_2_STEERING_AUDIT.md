---
title: R4-J4-R7-2 — Auditoría del steering existente (código, no ADR)
status: COMPLETED (insumo de R7-2)
mandate: «R4-J4-R7 — G1 Closure & R7-2 Implementation», Parte B (owner, 2026-10-29)
date: 2026-10-29
base: feat/r4-j4-r7-1-runtime-contingency @ 665b50c (R7-1, revisado en G1)
---

# R4-J4-R7-2 — Auditoría del steering existente

```text
QUESTION       ¿Qué steering existe hoy en R4, dónde se implementa y qué garantiza?
ANSWER         Steering DURABLE de nivel 1 en 5 fronteras (F1, F2, F3, F5, F6), por recompilación desde estado
               durable y wake por horizonte. NO existe steering interactivo (nivel 2).
GAPS           F4 `complete` sin control (entrada huérfana); `wait` del agente acepta silencio sin registro;
               F7 aprobación (BLK-AP1, R7-3); F10 sólo en el dominio J3.
R7-2 SCOPE     Sólo F4 y la parte de F3 que falta (cierre explícito). Las demás fronteras se conservan con pruebas.
```

Método: lectura del código en `665b50c` y de sus pruebas. Cada fila cita archivo y función. Clases:
`IMPLEMENTED_AND_TESTED`, `IMPLEMENTED_NOT_TESTED`, `PARTIALLY_IMPLEMENTED`, `DESIGNED_ONLY`, `ABSENT`.

## 1. Respuestas a las diez preguntas del mandato

| # | Pregunta | Respuesta (código) |
|---|---|---|
| 1 | ¿Qué ocurre cuando llega un mensaje mientras una task está `running`? | `ChannelIngress.ingest` (`live-ops/src/ingress.ts:139`) ⇒ `TemporalRuntime.submitInput` (`temporal-runtime.ts:360`): bajo el lock de fila de la task (`execution-store.ts:103`, `for update`) inserta la `memory_entry` CONVERSATIONAL y la `task_input`, y emite `task.input.received`. Con la task `running` no hay espera activa: **no** hay wake ni interrupción. La entrada queda durable y la recoge la siguiente frontera |
| 2 | ¿Se incorpora a la task existente o genera otra? | A la **misma** task del binding (`ingress.ts:241-245`). Sólo si la task ya es terminal (`task_not_accepting_input`), el ingress cierra el binding (`task_terminal_race`) y abre una task nueva **una vez** (`ingress.ts:253-258`) |
| 3 | ¿Puede modificar el contexto de una run activa? | Sí, en la siguiente iteración: el kernel no guarda estado entre iteraciones; cada una empieza con `session.load()` (`kernel.ts:108`) y `prepareContext` recompila desde estado durable. `MemoryContextSource` carga **todas** las entradas de la task, sin tope (`context-compiler/src/sources/memory.ts:28-30`) |
| 4 | ¿Se incorpora entre decisiones consecutivas del modelo? | Sí: F1. Cada llamada al modelo va precedida de `load()` + `prepareContext()` (`kernel.ts:108-145`) |
| 5 | ¿Puede llegar durante una ejecución de herramienta? | Sí. La READ se ejecuta fuera de la transacción del lock de la task; `submitInput` sólo compite por el lock en sus escrituras. La entrada se persiste y entra en la llamada al modelo que sigue a la observación (F1). Nunca interrumpe la READ ni una escritura (F9) |
| 6 | ¿Se incorpora antes de ejecutar una nueva acción comercial? | Antes de **decidir** una propuesta, sí (F1: la propuesta sale de una llamada con la entrada en contexto). Antes de **autorizarla**, Core no lo comprueba (F10). Lo exige el dominio J3E: la última entrada del cliente debe ser una confirmación explícita posterior a la oferta (`agents/sales/src/capabilities/quote-v4.ts:192-206`). En la reanudación de una aprobación, la acción se ejecuta antes de cualquier llamada al modelo (F7, **BLK-AP1**, R7-3) |
| 7 | ¿Se incorpora antes de aceptar `complete`? | **No.** `case 'complete'` (`kernel.ts:229`) ⇒ `ExecutionRuntime.finishExecution` (`execution-runtime.ts:612`) ⇒ `completed` sin ninguna comprobación de entradas. Una entrada no vista queda en una task terminal (P02 de la auditoría R7) |
| 8 | ¿Se incorpora antes de aceptar `wait`? | Parcialmente. `TemporalRuntime.decide` acepta la espera y, en la **misma** tx, si `hasUnseenInput(task, horizonte)` (`temporal-store.ts:191`) la despierta (`temporal-runtime.ts:291-297`): una entrada **no vista** nunca queda atrapada. Pero una entrada **vista y no respondida** se cierra en silencio sin registro (B1) |
| 9 | ¿Qué ocurre cuando llega durante una solicitud humana? | Se persiste sin wake (`#submitInputWithin`, `temporal-runtime.ts:425`: sólo despiertan `WAIT_FOR_INPUT` y `WAIT_UNTIL`). La ve la run que sigue a la respuesta humana o al release. Con un hold de plataforma, el hold se aplica **antes** de insertar la entrada (`temporal-runtime.ts:411-414`) |
| 10 | ¿Qué sucede durante reinicios o pérdida del lease? | La entrada ya es durable antes de cualquier efecto. El heartbeat aborta el kernel con `KernelInterrupt('lease_lost')` (`apps/worker/src/worker.ts:200-204`); otro worker reanuda **la misma** run (`claimNext`, `execution-runtime.ts:309`), recompila (F1) y ve la entrada. Pasado `maxRunRecoveries`, R7-1 entrega la task a un humano en la tx del claim (no la falla) |

## 2. Inventario de mecanismos

| # | Mecanismo | Archivo · función | Trigger | Estado persistido | Garantía transaccional | Pruebas | Limitaciones | Clase |
|---|---|---|---|---|---|---|---|---|
| M1 | Persistencia de entradas antes de cualquier efecto | `temporal-runtime.ts` `#submitInputWithin` | Inbound autenticado (`ingress.ts:139`) o API | `memory_entries` (CONVERSATIONAL), `task_inputs`, `temporal_events` `task.input.received` | Una tx bajo el lock de fila de la task; idempotente por `(task, source_ref, external_key)` (`unique`, `0005`:156) | `temporal-waits.test.ts:152`, `live-ops-hardening.test.ts:46,58` | — | IMPLEMENTED_AND_TESTED |
| M2 | Deduplicación del inbound | `ingress.ts` `ingest`; `inbound_events` por id de proveedor | Webhook | `inbound_events` | Unicidad por id de proveedor | `live-ops-hardening.test.ts:46` | — | IMPLEMENTED_AND_TESTED |
| M3 | Serialización por conversación | Lock `agent_tasks … for update` (`execution-store.ts:103`); a lo sumo una run activa; `task_waits_one_active` (`0005`:81); `human_requests_one_handoff` (`0005`:56) | Toda transición | Índices únicos | Lock de fila + índices | `live-ops-hardening.test.ts:58`, `temporal-waits.test.ts:152` | — | IMPLEMENTED_AND_TESTED |
| M4 | **F1** recompilación por iteración | `kernel.ts:108` `session.load()`; `apps/worker/src/session.ts:106`; `MemoryContextSource.load` | Cada iteración de la run | `context_snapshots`, `context_snapshot_items` (cada ítem evaluado, incluido o excluido, ADR-015) | Snapshot durable antes de la llamada (`kernel.ts:140-145`) | `temporal-waits.test.ts:169`, `pure-agent-execution.test.ts:142` | Sólo en la frontera siguiente; no dentro de la llamada en vuelo | IMPLEMENTED_AND_TESTED |
| M5 | **F2** horizonte del cierre de turno tras `respond` | `kernel.ts:247` `#endTurn` (`inputHorizonSnapshotId` = snapshot de la llamada que redactó) ⇒ `temporal-runtime.ts:291-297` | `respond` registrado | Step `wait` de origen `platform`; `task_waits`; wake en la misma tx | Misma tx que suspende la run | `turn-boundary.test.ts:63`, `pure-agent-execution.test.ts:142` | — | IMPLEMENTED_AND_TESTED |
| M6 | Respuesta superada por una entrada más nueva | `production-store.ts:407-437` (`supersededByNewerInput`) + `delivery.ts` `decideDispatch` | Claim del outbound | `outbound_messages.cancel_reason = superseded_by_newer_input` | Gate en la tx del claim | `live-ops-hardening.test.ts:222`, `delivery.test.ts` | El borrador se cancela; la run nueva ve que no se envió (`context-source.ts`) | IMPLEMENTED_AND_TESTED |
| M7 | **F3** horizonte de `wait` del agente | `temporal-runtime.ts:291-297` `decide` (`hasUnseenInput`) | `wait` `WAIT_FOR_INPUT` o `WAIT_UNTIL` | Wake inmediato | Misma tx | `temporal-waits.test.ts:169,213` | **Sólo UNSEEN.** Una entrada vista y no respondida se cierra en silencio, sin evento | PARTIALLY_IMPLEMENTED |
| M8 | **F4** control de `complete` | — (`kernel.ts:229` ⇒ `finishExecution`) | `complete` | — | — | P02 (sonda R7, falla) | Entrada no vista o no respondida queda en task terminal | **ABSENT** |
| M9 | **F5** finales de plataforma | R7-1: `runFailureDisposition` + `handOffAfterRunFailureWithin` | Fallas de run, presupuesto, abandono | `human_requests` handoff de plataforma, `WAIT_FOR_HUMAN`, aviso ADR-041 | Misma tx que termina la run (o el claim) | `runtime-contingency.test.ts` S08–S16, S57 | Aviso aun sin entrada pendiente (UNANSWERED no existía; ver §4) | IMPLEMENTED_AND_TESTED (G1) |
| M10 | **F6** entrada durante una espera humana | `#submitInputWithin` (`temporal-runtime.ts:425`) | Entrada con `WAIT_FOR_HUMAN`/`WAIT_FOR_APPROVAL` | Entrada durable, sin wake | Lock de fila | `production-control.test.ts:352` | Sin aviso ni TTL (R7-3) | IMPLEMENTED_AND_TESTED (registro); avisos/TTL DESIGNED_ONLY |
| M11 | **F7** entradas posteriores a una aprobación | `session.ts:110` `carriedAction` ⇒ `kernel.ts:127-131` | Resolución de aprobación | — | — | Sondas A-W1/A-W2 (falla esperada) | BLK-AP1 | DESIGNED_ONLY (AH, R7-3) |
| M12 | **F8** llamada al modelo en vuelo | `worker.ts:186-224` (sólo `lease_lost`, `task_not_runnable`, `stopped`) | — | — | — | — | No se interrumpe por una entrada | ABSENT (J5-A) |
| M13 | **F9** escritura en vuelo | ADR-016/018 | — | Ledger de acciones | — | `governed-execution*` | Nunca se interrumpe, por diseño | IMPLEMENTED_AND_TESTED (por diseño, no es steering) |
| M14 | **F10** antes de autorizar una escritura | Dominio J3E `quote-v4.ts:192-206` | `propose_action` de emisión | — | — | Suites `sales-confirmed-intent*` | Core no lo comprueba | PARTIALLY_IMPLEMENTED (sólo dominio) |
| M15 | Reanudación tras reinicio o lease | `claimNext` (`execution-runtime.ts:309`), heartbeat (`worker.ts:181-224`) | Lease vencido | Misma run, `recoveries + 1` | Tx del claim | `worker-recovery.test.ts`, `temporal-waits.test.ts:41`, suite `recovery` | Abandono ⇒ handoff (R7-1) | IMPLEMENTED_AND_TESTED |
| M16 | Reapertura tras task terminal (C-2) | `ingress.ts:253-258` | Carrera con un cierre | Binding cerrado `task_terminal_race`; task nueva con la entrada | Un reintento | `live-ops-hardening.test.ts` | La task nueva no hereda contexto (R7-4) | IMPLEMENTED_AND_TESTED |
| M17 | Ledger de steering | Derivable de `task_inputs` ⨝ `context_snapshot_items` (diseño, anexo A) | — | Ya persistido | — | — | Sin consulta en código | DESIGNED_ONLY (derivable, sin estructura nueva) |
| M18 | Steering interactivo (nivel 2) | — | — | — | — | — | `respond` termina el turno (`kernel.ts:223-227`); v5 | ABSENT (J5-A) |

## 3. Matriz F1–F10: estado real frente al diseño R7

| F | Frontera | Estado real (`665b50c`) | Clase | Acción R7-2 |
|---|---|---|---|---|
| F1 | Antes de cada llamada al modelo | Recompila todo lo no visto | IMPLEMENTED_AND_TESTED | **Conservar.** Pruebas nuevas: cambio de cantidad durante una búsqueda (S70) y ráfaga (S75) |
| F2 | Cierre de turno tras `respond` | Horizonte ⇒ wake; borrador superado | IMPLEMENTED_AND_TESTED | **Conservar** (control P13, S30) |
| F3 | `wait` del agente | Horizonte ⇒ wake (UNSEEN). Silencio ante una entrada **vista** sin registro | PARTIALLY_IMPLEMENTED | **Completar** sólo para `WAIT_FOR_INPUT`, la espera cuya única continuación es el cliente: reconsideración ante UNANSWERED y ratificación registrada. `WAIT_UNTIL` no es un cierre (§3.1) |
| F4 | `complete` | Sin control | ABSENT | **Implementar:** diferir ante UNSEEN; reconsideración ante UNANSWERED; ratificación |
| F5 | Finales de plataforma | Contingencia R7-1 | IMPLEMENTED_AND_TESTED | **Conservar.** La reconsideración que agota el presupuesto usa esta vía |
| F6 | Suspensiones humanas | Entrada durable sin wake | IMPLEMENTED_AND_TESTED (registro) | Sin cambio (avisos y TTL son R7-3) |
| F7 | Resolución de una aprobación | BLK-AP1 | DESIGNED_ONLY | Fuera de alcance (R7-3) |
| F8 | Llamada al modelo en vuelo | No se interrumpe | ABSENT | Fuera de alcance (J5-A) |
| F9 | Escritura en vuelo | Nunca se interrumpe | IMPLEMENTED_AND_TESTED | Sin cambio (prueba S73f es R7-3) |
| F10 | Antes de autorizar una escritura | Sólo dominio J3E | PARTIALLY_IMPLEMENTED | Sin cambio en Core (J5-A) |

### 3.1 Clases de espera (mandato §4.3)

| Espera | Origen | Condición de reanudación verificable | ¿Cierre del turno? | Tratamiento R7-2 |
|---|---|---|---|---|
| Legítima: `WAIT_FOR_INPUT` con la frontera cubierta | Agente | La próxima entrada del cliente; nada pendiente | Sí | Se acepta |
| Sin condición de reanudación: `WAIT_FOR_INPUT` con la frontera **sin respuesta** | Agente | Ninguna: el cliente espera una respuesta que nadie dará | **Sí** | Reconsideración y luego ratificación registrada |
| Temporal: `WAIT_UNTIL` | Agente | Timer durable (`schedules`, `wake`) | **No** | Se acepta sin evento. La entrada sigue pendiente y el próximo cierre la enfrenta |
| Humana: consulta o handoff | Agente o plataforma | Respuesta humana; TTL de consulta y avisos en R7-3 | No | Sin cambio |
| Comercial: `approval_required`, `write_outcome_uncertain` | Plataforma | Decisión humana o reconciliación | No | Sin cambio (BLK-AP1 es R7-3) |
| Cierre de turno tras `respond` | Plataforma | La próxima entrada del cliente | Sí, ya cubierto por el `respond` | Sin cambio (F2) |

**Desviación declarada respecto de la matriz del diseño §4.2**, que no distinguía la clase de `wait`:
- Una ratificación de `WAIT_UNTIL` registraría `turn.closed_without_reply(L)`, que **cubre** `L`. Al disparar el
  timer, un `WAIT_FOR_INPUT` silencioso sobre la misma `L` pasaría sin reconsideración: es justo el abandono que R7-2
  debe impedir.
- En v5 el modelo tampoco puede responder y programar un timer en el mismo turno, porque `respond` cierra con
  `WAIT_FOR_INPUT`. Reconsiderar un `WAIT_UNTIL` sólo agregaría costo.
- Riesgo residual: un modelo que encadene `WAIT_UNTIL` sin responder nunca llega a un cierre. Cada espera tiene su
  testigo acotado (L1-c), pero la cadena no lo tiene. Es el detector de no-progreso de R7-5.

**Conclusión:** R7-2 sólo necesita código en **F3** (cierre explícito) y **F4**. F1, F2, F5, F6 y F9 se conservan; se
añaden únicamente las pruebas que faltan. No hace falta una segunda implementación de steering: el guard reutiliza la
regla `seen` de `hasUnseenInput` (ítem `memory:<entry>` evaluado en el snapshot) y el wake por horizonte existente.

## 4. Steering interactivo (nivel 2)

No existe ningún mecanismo que incorpore un mensaje **durante** una llamada al proveedor. El kernel sólo se aborta por
`lease_lost`, `task_not_runnable` o `stopped` (`worker.ts:111, 200, 204`); una entrada nueva nunca aborta la llamada.
Lo que sí existe y J5-A podría reutilizar: `KernelInterrupt`, la reanudación de la misma run y los intentos
versionados del snapshot (`execution-runtime.ts:509-557`). Bloqueo de v5: `respond` termina el turno
(`kernel.ts:223-227, 247-257`). Se conserva como capacidad **J5-A**. R7-2 no modifica el protocolo v5.

## 5. Hallazgos laterales

| # | Hallazgo | Efecto | Tratamiento |
|---|---|---|---|
| A-1 | `hasUnseenInput` considera **todas** las entradas, incluido el marcador de identidad (`actor_kind = system`) | Para el wake es conservador y correcto | Se conserva. El guard de cierre usa sólo entradas `actor_kind = 'user'` (diseño §2, S33) |
| A-2 | `interactionSource` toma el `reason` de cualquier `wait` de la run, aunque haya sido rechazado | Con R7-2 un `wait` rechazado podría prestar su razón a la espera real | Se filtra por `outcome = 'recorded'` |
| A-3 | `seen` cuenta ítems evaluados, también los excluidos por presupuesto o compactados | Igual que el wake existente; con presupuesto `unbounded` (producción) no ocurre | **Corregido en la revisión G2** (`R4_J4_R7_G2_INDEPENDENT_REVIEW.md`, ADR-044 punto 8). Esta fila concluía que bastaba con exigir el episodio incluido, y era insuficiente: la entrada misma podía faltar. El wake conserva la regla; el cierre exige entrega (`turnObligation.undelivered`) |
