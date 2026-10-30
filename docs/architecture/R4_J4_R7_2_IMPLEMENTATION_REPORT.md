---
title: R4-J4-R7-2 — Turn Completion Guard & Steering — informe de implementación
status: R4_J4_R7_G2_READY_FOR_INDEPENDENT_REVIEW
mandate: «R4-J4-R7 — G1 Closure & R7-2 Implementation» (owner, 2026-10-29), Partes B–E
date: 2026-10-29
branch: feat/r4-j4-r7-2-turn-completion-guard (local, sin push ni merge)
base: feat/r4-j4-r7-1-runtime-contingency @ 665b50c (G1 aprobado: R4_J4_R7_G1_INDEPENDENT_REVIEW.md)
---

# R4-J4-R7-2 — Informe de implementación

```text
G1                     R4_J4_R7_G1_APPROVED (informe independiente en esta rama)
STEERING AUDIT         R4_J4_R7_2_STEERING_AUDIT.md: nivel 1 existente en F1, F2, F5, F6; F3 parcial; F4 ausente
TURN_COMPLETION_GUARD  IMPLEMENTED  complete (F4) y WAIT_FOR_INPUT del agente (F3): diferir / reconsiderar / ratificar
STEERING (nivel 1)     PRESERVED + TESTED  sin segunda implementación; F1/F2 sin cambios
INTERACTIVE (nivel 2)  ABSENT → J5-A (sin cambios al protocolo)
OBSERVE MODE           IMPLEMENTED  R4_TURN_GUARD=observe (worker): primera compuerta de canary y rollback
PROTOCOL_V5 / KERNEL   UNCHANGED (ni agent-kernel ni KernelSession)
MIGRATIONS             NONE (eventos en temporal_events)
NEW PROCESSES/QUEUES   NONE; sin supervisor, sin clasificador, sin segundo modelo
G-SEM                  PREPARED_NOT_AUTHORIZED (pre-registro); 0 llamadas a DeepSeek
G2                     READY_FOR_INDEPENDENT_REVIEW (no se declara aprobado)
```

## 1. Rama y método

- Worktree aislado `dev/r4-j4-r7-2`, rama `feat/r4-j4-r7-2-turn-completion-guard`, creada desde `665b50c`.
- Mismo montaje de `node_modules` que R7-1: terceros por junction y scopes de workspace apuntando a esta rama.
- **Orden de trabajo:** el código de R7-2 se escribió en el worktree mientras corrían las suites de G1, sin commit ni
  pruebas con base de datos hasta que la cadena G1 (incluida `recovery`) terminó en verde. El commit se hizo después de
  emitir `G1_APPROVED`.
- Sólo el PostgreSQL local de pruebas. Sin DeepSeek, WhatsApp, PrestaShop, CIA ni Customer Profile. Sin push, merge
  ni despliegue.

## 2. Qué se implementó (sólo lo ausente o incompleto según la auditoría)

| Componente | Archivo | Cambio |
|---|---|---|
| Obligación conversacional | `task-runtime/src/temporal-ports.ts`, `persistence-postgres/src/temporal-store.ts` | `TurnObligation`, `ConversationInputRef` y `turnObligation(task, H)`. Calcula UNSEEN (regla `seen` de `hasUnseenInput`), la frontera `L` (última entrada `actor_kind = 'user'`), `covered(L)` (un `respond` registrado que vio `L` y cuyo outbound no se descartó, o `turn.closed_without_reply(L)`) y el último `reconsider(L)` con `shown` (episodio **incluido** en `H`). Agrega `closures` a `interactionRecords` |
| Guard de `complete` (F4) | `task-runtime/src/execution-runtime.ts` | `TurnCompletionGuard` y `TurnCompletionVerdict`. En `finishExecution`, dentro de la misma tx y después de anexar el step `complete`: si el veredicto es `deferred`, la run termina como decidió el modelo (`details.turnGuard`) y la task sigue `running` sin run activa, como en ADR-028 |
| Núcleo del guard | `task-runtime/src/temporal-runtime.ts` | `completionWithin`: P-2/P-3 ⇒ `turn_closure_blocked`; UNSEEN ⇒ `turn_input_unseen`; UNANSWERED ⇒ `turn_reply_pending` + `reconsider`; con el episodio mostrado ⇒ ratificación. En `decide`, `WAIT_FOR_INPUT` del agente: step `refused` + `reconsider`, o ratificación. `observe` sólo registra `would_*`. `#reconsider` registra a lo sumo un evento por frontera |
| Episodio | `context-compiler/src/sources/platform.ts`, `source.ts` | Ítem OBSERVED `turn_closure:<eventId>` con `inputId`, `memoryItemId`, `receivedAt`, `code`, `decision` y texto fijo de plataforma. Un `wait` rechazado ya no presta su `reason` a la espera real (hallazgo A-2 de la auditoría) |
| Modo `observe` | `apps/worker/src/config.ts`, `platform.ts` | `R4_TURN_GUARD=enforce\|observe` (por defecto `enforce`); un valor inválido detiene el arranque |
| Telemetría | `observability/src/telemetry.ts` | `turn.closure.deferred`, `turn.closure.reconsider`, `turn.closed_without_reply`, `turn.closure.would_defer`, `turn.closure.would_refuse`. Sólo ids y códigos |
| Documentos | `docs/adr/ADR-044-turn-completion-guard.md` (propuesto), auditoría, pre-registro G-sem, revisión G1 y este informe | — |

**No cambian:**
- el protocolo `r4.agent_decision.v5`, `packages/agent-kernel` y `KernelSession`;
- Quote, Checkout y los perfiles;
- las instrucciones del pack Sales: el borrador v9 (diseño §3.4) queda para decisión del owner;
- las migraciones, los procesos y las colas.

**Sin texto del modelo en eventos:** los eventos guardan ids, códigos y marcas de tiempo; el `reason` del `wait` ya vive
en el step.

### 2.1 Desviaciones declaradas

| # | Desviación | Motivo |
|---|---|---|
| DV-1 | **`WAIT_UNTIL` no es un cierre.** La matriz del diseño §4.2 no distinguía la clase de `wait` | Ratificar un `WAIT_UNTIL` registraría `closed_without_reply(L)`, que cubre `L`. Al disparar el timer, un `WAIT_FOR_INPUT` silencioso pasaría sin reconsideración: el abandono que R7-2 debe impedir. En v5 tampoco se puede responder y programar un timer en el mismo turno. Detalle en la auditoría §3.1 (mandato §4.3). Prueba `temporal wait` y mutación TG-M4b |
| DV-2 | P-2/P-3 no tienen razón de handoff propia | `turn_closure_blocked` es un error de plataforma: el kernel registra `internal_failure` `ending_refused` (`details.refusedReason = completed`) y R7-1 entrega la task con `run_internal_failure` y el aviso. La prueba S28 lo fuerza por fixture. Una razón propia exigiría un caso nuevo en R7-1 sin evidencia de necesidad. **Corregido en G2:** esta fila decía «no alcanzable» y era falso. Una consulta superada por un takeover sí lo alcanzaba, y dejaba la task imposible de completar. Ahora una consulta abierta no bloquea (`R4_J4_R7_G2_INDEPENDENT_REVIEW.md`, H-5) |
| DV-3 | S56 y el reinicio durante la incorporación se prueban con el **cierre** del worker, no con SIGKILL | Prueba lo mismo: el diferimiento es durable y otro worker lo continúa una vez. Los SIGKILL reales del camino de recuperación siguen en la suite `recovery` |
| DV-4 | El ledger de steering es una **consulta** (diseño, anexo A), no una API | Está en la prueba S70 (`steeringLedger`). Se expone como API cuando el hilo del operador o la evaluación lo consuman (R7-4) |

## 3. Invariantes R7-2

| Invariante | Mecanismo | Prueba |
|---|---|---|
| S: ninguna entrada recibida desaparece | `complete` difiere ante UNSEEN; las entradas durante la run quedan en la misma task | S22, S31+S75, S56 |
| S: ninguna entrada nueva se da por vista sin evidencia | `seen` = ítem `memory:` en el snapshot de la decisión; ratificación sólo con el episodio **incluido** | S22, S35, S20 (S29) |
| S: ningún cierre cubre mensajes posteriores | `reconsider` y `closed_without_reply` ligados a `entity_id = L`; una entrada nueva es una frontera nueva | S26, S35 |
| S: la ratificación no se presenta como verificación | `basis: 'model_ratification'`, `policy: 'closure.v1'` | S21+S37, TG-M10 |
| S: el steering no lleva una operación comercial más allá de sus políticas | El guard no crea, altera ni re-ejecuta escrituras; no llama a Quote ni a Policy | Diff; suites `sales`, J3/J3E y `governed-execution*` en verde |
| L: toda obligación pendiente tiene una vía de progreso | El diferimiento deja una task reclamable (L1-b). La espera rechazada continúa la run (L1-a). `WAIT_UNTIL` tiene schedule (L1-c) | S20, S27, `temporal wait` |
| L: `running` no basta como evidencia | El diferimiento queda registrado (`details.turnGuard`) y el `reconsider` es durable | S20, S56 |
| L: una espera necesita una condición de reanudación verificable | `WAIT_FOR_INPUT` con la frontera sin respuesta se reconsidera; `WAIT_UNTIL` tiene timer | S27, `temporal wait` |
| L: las recuperaciones están acotadas | Una reconsideración por frontera; UNSEEN sólo se repite con entradas nuevas (la memoria carga todas las entradas); presupuesto de run ⇒ contingencia R7-1 | Presupuesto agotado durante la reconsideración; error de proveedor tras el diferimiento |
| D: generado ≠ entregado | `covered` exige que el outbound no esté `failed` o `cancelled` (salvo `duplicate_content`) | INV-D4 (respuesta `expired` ⇒ reconsideración) |
| D: sin envíos inciertos duplicados; Outbox idempotente | Sin cambios en entrega | `live-ops-*`, `run-failure-fallback` |

## 4. Pruebas

**Runtime (modelo guionado):** `tests/integration/turn-completion-guard.test.ts`, 30 pruebas sobre el testbed de
canal real (webhook, worker Sales productivo, entrega, WhatsApp falso). Más 2 unitarias (episodio y `R4_TURN_GUARD`) y
`tests/mutation/turn-guard-mutations.mjs` (`npm run test:mutation:turn-guard`).

| Escenario del mandato §7 | Prueba |
|---|---|
| «Ok, gracias», «Perfecto», «Muchas gracias, eso sería todo» | Catálogo (ambas ramas por mensaje); S23 y S24 |
| «Necesito cotizar un rack», «Mándame el precio», «Quiero agregar dos discos» | Catálogo; S20 y S21 (cierre ratificado sobre una solicitud real = residuo B1, documentado) |
| «Ya, dale», «Perfecto, avancemos», «Gracias, pero agrégale dos discos» | Catálogo |
| Cambio de cantidad durante una búsqueda | S70 (Catalog REAL con fixture, `sales-production@2`; el ledger registra la entrada en la iteración 2) |
| Mensaje durante una llamada de capacidad | S70 (la entrada llega dentro de `catalog.search`) |
| Mensaje antes de `complete` | S22 |
| Mensaje entre la reconsideración y la ratificación | S35 |
| Dos mensajes concurrentes | S31 + S75 (tres concurrentes) |
| Reinicio durante la incorporación de mensajes | S56 |
| Presupuesto agotado durante la reconsideración | `budget exhausted during the reconsideration` |
| Error del proveedor | `a provider error in the run after a deferral` |
| Espera inválida | S27 |
| Falla de persistencia | `a persistence failure while recording the reconsideration` (trigger en PostgreSQL que falla una vez) |
| Reinicio después de diferir el cierre | S56 |
| Otros del plan §3.2 | S25, S26, S28, S32 (`observe`), S33 (marcador de identidad), S34, INV-D4, `temporal wait` |

El catálogo prueba lo que el runtime **hace**, no lo que el modelo **entiende**: los nueve textos producen el mismo
resultado estructural en cada rama. La semántica se mide en G-sem (`R4_J4_R7_GSEM_PREREGISTRATION.md`).

**Pruebas existentes actualizadas** (cambio intencional F4; cada una con comentario `R4-J4-R7-2`):

| Prueba | Antes | Ahora |
|---|---|---|
| `temporal-waits` (continuidad de goals; input durante la decisión; WAIT_UNTIL interrumpible) | `complete` sin respuesta ⇒ `completed` | Primer `complete` diferido (`turn_reply_pending`), ratificado por un segundo `complete` en una run nueva |
| `human-collaboration` (handoff del agente y release) | ídem | ídem |
| `profile-pinned-claims` (rollback y reanudación) | 2 runs | 3 runs, todas con el perfil propio |
| `evaluation-trajectory` («Thanks, that is all.» ⇒ `complete`) | 2 runs; adherencia 3/3 | 3 runs; adherencia 4/4 (la decisión ratificadora) |
| `temporal-process-crash` (recovery: espera que sobrevive al reinicio de worker y API) | `complete` sin respuesta ⇒ `completed` | Diferido y ratificado, como `temporal-waits` |

## 5. Resultados

Evidencia: `docs/architecture/evidence/j4-r7-2/`.

**Cadena 1** (build limpio sobre `59041dc`; integración serial; mismo procedimiento que G1):

| Paso | Resultado |
|---|---|
| clean, build, typecheck, lint | verdes |
| unit | 1531 passed, 4 skipped |
| contract | 452 passed |
| integration | 672 passed, 12 skipped |
| sales | 29 passed |
| shadow | 5 passed |
| `test:mutation:runtime-contingency` (R7-1) | 11/11 detectadas |
| `test:mutation:turn-guard` | **falla de línea base**: tres nombres de prueba con `+` y `( )` no coincidían con `-t`, que vitest trata como regex |
| `test:mutation:recovery` | **12/14**: dos mutaciones anclaban en la primera aparición de `task = owned.task;`, que R7-2 añadió antes, en la rama de diferimiento; mutaban el código de R7-2, no el de recovery |
| recovery | **17/18**: `temporal-process-crash` esperaba `completed` tras un `complete` sin respuesta a «Value is 7.» (cambio intencional F4, el mismo de las pruebas actualizadas) |

Ninguna de las tres fallas es un defecto de producción. Las correcciones tocan sólo pruebas y scripts de mutación:
- `-t` recibe el nombre escapado;
- las dos mutaciones de recovery anclan en el comentario de su rama, que es único;
- `temporal-process-crash` ratifica con un segundo `complete`.

**Cadena 2** (tras las correcciones; sin cambios de producción desde la cadena 1):

| Paso | Resultado |
|---|---|
| typecheck, lint | verdes |
| `test:mutation:turn-guard` | **13/13 detectadas** (TG-M1…M12 y M4b); fuentes restauradas |
| `test:mutation:recovery` | **14/14 detectadas**; fuentes restauradas |
| recovery | **18/18** |

Llamadas reales a modelos: 0. G-sem preparado, no ejecutado.

## 6. Riesgos y bloqueos residuales

| Riesgo | Detalle | Mitigación |
|---|---|---|
| B1 persistente | El runtime acepta un silencio ratificado sobre una solicitud real (S21) | G-sem (M1 = 0 requerido); evaluación post-hoc; `observe` primero en el canary |
| Costo | Una llamada extra por cierre silencioso legítimo, y una run extra si fue `complete` | Medir en canary (`turn.closure.*`); O5/v6 queda como evolución futura |
| Cadena de `WAIT_UNTIL` sin respuesta | Cada espera está acotada, la cadena no (DV-1) | Detector de no-progreso (R7-5) |
| Reconsideración tras la respuesta de un operador | Un outbound de operador no cubre la entrada: tras un release, un cierre silencioso se reconsidera una vez | Costo de una llamada, nunca pérdida. Cubrir por respuesta humana exige comparar relojes distintos; se evaluará con datos del canary |
| Episodio excluido por presupuesto | **Corregido en G2.** Esta fila subestimaba el problema: `complete` se difería entre runs sin cota. Ahora, con el episodio o la entrada fuera del contexto, el cierre pasa de inmediato a contingencia (`turn_closure_undelivered`) | Revisión G2, H-1 a H-3 |
| P-2/P-3 | Handoff, aprobación, efecto incierto o intención terminal abiertos terminan en contingencia `run_internal_failure` (DV-2). Una consulta abierta ya no bloquea (G2, H-5) | S28, `G2 P-2` |
| BLK-AP1 | Sin cambios (R7-3) | Dependencia operativa vigente: ningún perfil REQUIRE_APPROVAL con clientes reales |
| Instrucciones v9 | No adoptadas. Con v8, el texto de la instrucción no menciona la reconsideración; sólo el episodio la explica | Decisión del owner; G-sem brazo B |
| Producción | Nada se desplegó. `observe` es la primera compuerta recomendada | — |

## 7. Estado

`R4_J4_R7_G2_READY_FOR_INDEPENDENT_REVIEW` al cerrar R7-2. No se inició R7-3. La revisión posterior está en
`R4_J4_R7_G2_INDEPENDENT_REVIEW.md`: sus correcciones (`77f0822`, `b12b7d5`, `205a659`) cambian lo que aquí se describe, y
ese informe prevalece.
