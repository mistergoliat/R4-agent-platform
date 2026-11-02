---
title: R4-J4-R7 — G2 — revisión independiente del Turn Completion Guard
status: R4_J4_R7_G2_APPROVED
mandate: «R4-J4-R7 — G2 Closure & Semantic Validation», Partes A–C (owner, 2026-10-30)
date: 2026-10-30
branch: feat/r4-j4-r7-2-turn-completion-guard (local, sin push ni merge)
reviewed: 59041dc + ee17cdb (R7-2) sobre 665b50c (R7-1); correcciones 77f0822, b12b7d5, 205a659
---

# R4-J4-R7 — G2: revisión independiente

## 1. Resultado

**`R4_J4_R7_G2_APPROVED`**, sobre `205a659`. No autoriza push, merge ni despliegue.

La revisión encontró **siete defectos en el guard** que las suites de R7-2 no detectaban. Las garantías que el informe de
implementación declaraba sólo se cumplían con presupuesto `unbounded`, y dos filas de ese informe eran falsas (DV-2 y el
riesgo «episodio excluido»). Todos quedaron corregidos con prueba de regresión y mutación. Cuatro alcanzan a producción
tal como está configurada hoy (§5, H-4 a H-7).

**Alcance de la independencia.** El método parte del código y no del informe. Una segunda lectura adversarial la hizo un
subagente de sólo lectura, con el diff en `77f0822` y las garantías del mandato. Sus resultados se trataron como hipótesis
y se verificaron contra el código. Esta revisión la hizo la misma familia de agente que implementó R7-2: es independiente
del informe, no de su autor. No hubo revisión humana del código.

## 2. Parte A: garantías del guard

Referencias a la rama en `205a659`. `TR` = `packages/task-runtime/src/temporal-runtime.ts`, `ER` =
`packages/task-runtime/src/execution-runtime.ts`, `TS` = `packages/persistence-postgres/src/temporal-store.ts`, `IT` =
`tests/integration/turn-completion-guard.test.ts`, `XT` = `tests/integration/turn-guard-excluded-inputs.test.ts`.

### A1 — `complete`

| Garantía | Código | Prueba | Veredicto |
|---|---|---|---|
| Entrada nueva durante la decisión | `TR:428`, `TR:400` difiere con `turn_input_unseen` | `IT:130` S22, `IT:436` S31+S75 | Se cumple |
| Entrada pendiente | `TR:431`, `TR:404-406` difiere con `turn_reply_pending` y registra `reconsider` | `IT:74` S20 | Se cumple |
| Diferimiento atómico | `ER:640-681`: el step, el veredicto, el evento y el fin de la run comparten transacción | Prueba de falla de persistencia al registrar la reconsideración (`IT`, «rolls the closing back whole») | Se cumple |
| Task preservada, run terminada persistida | `ER:678-681` deja la task `running`; `ER:659-660` guarda `termination.details.turnGuard` | S20, S22 | Se cumple |
| Reanudación por otra run | Task `running` sin run activa: el siguiente claim abre una run, como en ADR-028 | S20, S22 | Se cumple |
| Sin carrera entre ingreso y cierre | `ER:641` y `submitInput` (`TR:531`) toman el mismo lock de fila; `TS:204` lee las entradas bajo ese lock. El ingreso posterior al commit encuentra la task terminal y abre una nueva (C-2) | `IT:455` G2 A1 (6 rondas en carrera) | Se cumple |
| Idempotencia tras reinicio | El evento y la decisión son la misma transacción; el reinicio recompila desde estado durable | `IT:483` S56 | Se cumple |

### A2 — `WAIT_FOR_INPUT`

| Garantía | Código | Prueba | Veredicto |
|---|---|---|---|
| Vista frente a atendida | `seen` (`TS:206`) responde a «evaluada»; `replied`/`closed` (`TS:211-217`) a «atendida» | S23, S27, `IT:192` S25 | Se cumple |
| Pendiente reconsiderada | `TR:311-316`: step `refused` + `reconsider`, y la run continúa | `IT:201` S27 | Se cumple |
| Ratificación | `TR:433`, `TR:320`, `TR:444-450` | `IT:165` S23, `IT:183` S24 | Se cumple |
| `turn.closed_without_reply` durable | `temporal_events` dentro de la transacción de la decisión | `IT:105` S21+S37 | Se cumple |
| Sin reanudaciones duplicadas | `task_waits_one_active`; `reconsider` único por frontera (`TR:431`: sólo si no existe) | S27, S26 | Se cumple |

### A3 — `WAIT_UNTIL`

`TR:311` limita el cierre a `WAIT_FOR_INPUT`. No hay reconsideración ni `turn.closed_without_reply`, no cubre la frontera y
el próximo cierre la enfrenta. El timer se programa en `TR:345`. Prueba: `IT:214`; `XT:173` X2f confirma que no hay bucle de
wake. Mutación TG-M4b. **Se cumple.** La cadena de `WAIT_UNTIL` sin respuesta queda como riesgo residual conocido (§5, R-3):
no se implementó supervisor ni detector, como pide el mandato.

### A4 — ratificación semántica

| Garantía | Código | Prueba | Veredicto |
|---|---|---|---|
| Entrada pendiente identificada | `reconsider` lleva `inputId`, `memoryItemId`, `receivedAt`, `pendingItemIds` (`TR:440`). Antes nombraba sólo la frontera (H-4) | `IT:260` G2 A2+A4 | Se cumple tras la corrección |
| El episodio llega al modelo | Ratifica sólo si `turn_closure:<id>` está `included` en `H` (`TS:230`, `TR:433`); si no, handoff (`TR:435`) | `XT:219` X4a, `XT:234` X4b | Se cumple tras la corrección (H-2) |
| Entrada posterior anula la ratificación | La consulta busca el `reconsider` de **esta** frontera (`TS:231`) | `IT:244` S35, `IT:231` S26, `XT:246` X5 | Se cumple |
| Una reconsideración por frontera | `TR:431`, `TR:435` | S21, X4a, X4b | Se cumple tras la corrección (antes se repetía sin límite entre runs) |
| `basis: model_ratification` | `TR:447` | S21 | Se cumple |
| No se presenta como verificación | Sólo `basis` y `policy`; `hadPriorReply` y `trailingCount` no deciden | `IT:372` S34, TG-M10 | Se cumple |

### A5 — steering

R7-2 no duplicó mecanismos: el guard reutiliza snapshots, wake por horizonte y `temporal_events`. `git diff 665b50c..HEAD`
no toca el kernel, `KernelSession`, el protocolo v5 ni las migraciones. `hasUnseenInput` (`TS:191`) sigue igual. F1
(`IT:413` S70), F2 (`turn-boundary.test.ts`), F3 (S27 y `temporal-waits.test.ts`), F5 (`runtime-contingency.test.ts`), F6
(`production-control.test.ts`) se conservan; F4 es lo nuevo. No hay steering interactivo.

## 3. Parte B: entradas excluidas

La brecha estaba confirmada: `seen` y `replied` aceptaban ítems excluidos. Evidencia antes de corregir, en
`docs/architecture/evidence/j4-r7-g2/excluded-inputs-before-fix.txt`: **9 de 13 pruebas fallaban**. X4a acumuló 8 `complete`
repetidos entre runs y X4b 20 refusals; X2a dejó `completed` una task con una entrada que el modelo nunca recibió.

**La corrección (`77f0822`) separa dos preguntas sin tocar `hasUnseenInput`:**
- **Despertar** (`hasUnseenInput`): ¿el compilador la evaluó? Preguntar por entrega despertaría la task en bucle.
- **Autorizar un cierre** (`turnObligation.undelivered`, `TS:226`): ¿el contenido llegó al modelo?

| # | Escenario | Qué recibió el modelo | Qué interpreta `turnObligation` | Decisión del guard | ¿Cobertura indebida? | Recuperación durable | Prueba |
|---|---|---|---|---|---|---|---|
| 1 | Incluida en el snapshot | El texto | `seen`, `in_horizon`; sin cubrir | Reconsidera y luego ratifica; o queda cubierta por el `respond` | No | No hace falta | `XT:78` X1 |
| 2 | Evaluada, excluida por presupuesto | Nada | `seen`, no `in_horizon`, no `decided_on` ⇒ `undelivered` | `complete` y `wait` del agente fallan con `turn_closure_undelivered`. La espera de plataforma tras `respond` también: un `respond` cubre sólo lo que su snapshot incluyó | No | R7-1: handoff `run_internal_failure` y aviso | `XT:90` X2a, `XT:104` X2b, `XT:115` X2c, `XT:126` X2d, `XT:161` X2g |
| 2′ | Recibida antes, excluida después | El texto, en una decisión anterior | `decided_on` ⇒ no `undelivered` | Cierre normal (sin falso positivo) | No | No hace falta | `XT:139` X2e |
| 3 | Compactada, recibida antes | El texto antes y luego el resumen | `decided_on` | Cierre normal | No | No hace falta | `XT:185` X3a |
| 3′ | Compactada sin haberse recibido nunca | Un extracto de 60 caracteres | `decision = excluded` ⇒ `undelivered`. **El extracto no cuenta como entrega** porque nada verifica que sea suficiente | Rechazo ⇒ contingencia | No | Handoff y aviso | `XT:202` X3b |
| 4 | Episodio de reconsideración excluido | La entrada, no el episodio | `reconsider.shown = false` | `undelivered` en el primer reintento. No ratifica ni repite | No | Handoff y aviso | `XT:219` X4a, `XT:234` X4b |
| 5 | Entrada nueva durante la reconsideración | Según presupuesto | Frontera nueva: no hay `reconsider` propio | Si cabe, reconsideración nueva (S35). Si no cabe, `undelivered` | No | Handoff y aviso, o reconsideración | `IT:244` S35, `XT:246` X5 |

**Criterio de aceptación del mandato:** «Ninguna entrada puede considerarse vista únicamente porque fue evaluada por el
compilador si su contenido no llegó al modelo ni quedó representado por una memoria semánticamente suficiente y
verificable.» **Se cumple**, con la lectura más estricta: ninguna memoria compactada se acepta como suficiente, porque hoy no
existe forma de verificarlo. X2f confirma que despertar sigue usando «evaluada» y no produce bucle; `observe` registra sin
actuar (`XT:266` X6).

Con `unbounded` (producción: `contextPolicy: {}` en Sales) el compilador no excluye nada, así que esta regla no cambia ningún
comportamiento actual. Los escenarios 2–5 exigen presupuesto `fixed` o `maxContextTokens`.

## 4. Mutaciones añadidas por esta revisión

`tests/mutation/turn-guard-mutations.mjs`: 24 mutaciones (TG-M1…M23 y M4b), 11 nuevas (TG-M13…M23). TG-M13…M19 cubren la Parte
B, TG-M20…M23 cubren los hallazgos H-4 a H-7. TG-M14 y TG-M16 quitan la regla de entrega, TG-M18 acepta el extracto, TG-M19
hace que el wake pregunte por entrega y TG-M15 prueba que no se bloquee lo recibido antes.

## 5. Hallazgos

| # | Severidad | ¿Alcanza a producción hoy? | Hallazgo | Corrección | Prueba |
|---|---|---|---|---|---|
| H-1 | Material | No (`fixed`) | `seen` y `replied` aceptaban ítems excluidos: un cierre ratificaba, o un `respond` cubría, algo que el modelo no recibió | `77f0822` | X2a–d, X3b, TG-M13/14/16/18 |
| H-2 | Material | No (`fixed`) | Con el episodio excluido, `complete` se difería **entre runs sin cota** (ADR-044 afirmaba lo contrario) y `wait` se rechazaba hasta agotar la run | `77f0822` | X4a, X4b, TG-M17 |
| H-3 | Material | No (`fixed`) | La espera de plataforma que cierra el turno ignoraba una entrada no entregada | `77f0822` | X2c, X2d, TG-M16 |
| H-4 | Material | **Sí** | Con varias entradas sin respuesta, el episodio nombraba sólo la frontera y el cierre sólo la cubría a ella. Una solicitud anterior se cerraba sin que el modelo la tuviera señalada | `b12b7d5`: `pendingItemIds`, `inputIds` | `IT:260`, TG-M22 |
| H-5 | Material | **Sí** | Una consulta abierta y superada por un takeover dejaba la task imposible de completar. Refuta DV-2 («no alcanzable») | `b12b7d5`: la consulta no bloquea con la task `running` | `IT:301`, TG-M21 |
| H-6 | Material | **Sí** | El episodio no se retiraba: tras responder, cada llamada posterior seguía diciendo al modelo que el mensaje no tenía respuesta | `b12b7d5`: proyección sólo mientras la frontera siga sin cubrir | `IT:280`, TG-M20 |
| H-7 | Material | **Sí** | Una respuesta cancelada como duplicado cubría la entrada aunque el original hubiera fallado | `b12b7d5`: `TS:214-216` | `IT:318`, TG-M23 |
| H-8 | Menor (prueba) | No | TG-M4 y TG-M4b quedaron con el ancla obsoleta tras `77f0822` y el script los saltó. Una cadena lo detectó como 22/24 | `205a659` | Cadena |

### Riesgos residuales aceptados en G2

| # | Riesgo | Por qué no bloquea | Cuándo revisar |
|---|---|---|---|
| R-1 | Con presupuesto `fixed`, una entrada que nunca llegó al modelo vuelve a llevar a handoff cada cierre tras un `release`; sólo `cancelTask` sale de ahí | Es seguro (persona y aviso, nunca silencio) y `fixed` no se usa en producción | **Antes de usar `fixed` con clientes** (ADR-044) |
| R-2 | Un cierre rechazado revierte su step, así que esa llamada al modelo falta del log de steps y de `run.usage` | Comportamiento previo de `ending_refused`; el costo real sigue en el proveedor. Impacto bajo | Con R7-1 canary, si la contabilidad lo exige |
| R-3 | Cadena de `WAIT_UNTIL` sin respuesta | Excluido expresamente por el mandato | R7-5 |
| R-4 | Silencio ratificado sobre una solicitud real (B1): el runtime no interpreta | Es lo que mide G-sem | G-sem |
| R-5 | La respuesta de un operador no cubre la entrada: tras un `release`, un cierre silencioso se reconsidera una vez | Cuesta una llamada, nunca se pierde nada | Datos del canary |

## 6. Parte C: regresión

Cadena en serie, sin suites concurrentes sobre PostgreSQL, sobre `205a659`: `npm run clean`, borrado de `dist`, build y luego
cada suite. Inicio 13:10:11, fin 14:10:16 (2026-10-30). Evidencia en `docs/architecture/evidence/j4-r7-g2/g2-chain-summary.txt` y
un log por paso.

| Paso | Resultado |
|---|---|
| clean + build | rc=0 |
| typecheck | rc=0 |
| lint (`--max-warnings=0`) | rc=0 |
| unit | 1531 pasan, 4 saltadas (85 archivos, 1 saltado) |
| contract | 452 pasan (33 archivos) |
| integration | 691 pasan, 12 saltadas (49 archivos, 1 saltado) |
| entradas excluidas | 14/14 (también dentro de integration) |
| sales | 29/29 |
| shadow | 5/5 |
| mutaciones Turn Guard | **24/24** detectadas |
| mutaciones Runtime Contingency | **11/11** detectadas |
| mutaciones Recovery | **14/14** detectadas |
| recovery | 18/18 |
| Árbol de fuentes tras la cadena | 0 archivos cambiados |

**Saltadas:** ninguna en archivos que esta rama modificó. Dependen de un servicio externo (`catalog-http-real`, `cp-synthetic-interop`)
o de la plataforma (`operator-auth`, permisos POSIX en Windows).

**Una cadena anterior se invalidó, no se promedió.** La primera cadena, en `b12b7d5`, dio 28 fallos en integración y 22/24 mutaciones.
Causa: al detener una cadena previa se mataron sus procesos vitest, pero no su shell, que siguió corriendo mutaciones y `recovery`
encima de la nueva. Los fallos son `57P01 terminating connection` y `the database system is shutting down`, en el minuto en que
`recovery` reinicia PostgreSQL. Esa contaminación explica los 28 fallos y anula toda esa ejecución, porque las mutaciones también
tocaron fuentes durante el build. Los 2 de 22/24 sí eran reales (H-8, TG-M4 y TG-M4b). Logs conservados en
`evidence/j4-r7-g2/invalidated-concurrent-chain/`. Antes de relanzar se verificó que no quedara ningún proceso de la cadena ni
conexiones a la base de R4. Un vitest de otro repo (Checkout) corría en paralelo, pero usa su propio servidor (55434/55500).

**Alcance.** `git diff 665b50c..HEAD` fuera de `docs/`, `tests/` y `scripts/experiments/` toca sólo `apps/worker` (config),
`context-compiler`, `observability`, `persistence-postgres`, `task-runtime` y `package.json`. Sin migraciones, kernel, Sales, Quote
ni Checkout.

## 7. Estado G2

| Condición del mandato | Veredicto |
|---|---|
| Sin defectos materiales abiertos | Se cumple: H-1 a H-7 corregidos. Los residuos R-1 a R-5 no pierden entradas ni producen silencio |
| Garantías del guard verificadas | Se cumple (§2) |
| La prueba de entradas excluidas pasa | Se cumple: 14/14, 9 de 13 fallaban antes de la corrección |
| Suites obligatorias verdes | Se cumple (§6) |
| Cambios dentro del alcance autorizado | Se cumple (§6) |

**`R4_J4_R7_G2_APPROVED`.** Esto habilita G-sem y nada más. La validación semántica es un resultado aparte y sigue abierta.
