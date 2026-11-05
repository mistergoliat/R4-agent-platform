---
title: R4-J4-R7-4 — continuidad conversacional entre tasks
status: R4_R7_4_READY_FOR_PR_REVIEW
mandate: «R4 — R7-4 Cross-Task Continuity», «R7-4 Final Hardening and L2» (etapa de endurecimiento), la corrección de R74-5, «R4 — R7-4 L2 Validation» y «R4 — R7-4 L2 Unblock and Final Validation» (owner); base main@52a58f4
date: 2026-11-04
---

# R4-J4-R7-4: continuidad conversacional entre tasks

## 1. Conclusión

**Antes de este cambio**, cuando una task terminaba, el siguiente mensaje del cliente abría una task nueva que no veía nada de la conversación anterior: ni el producto que se mencionó ni la respuesta que se dio. Dentro de una misma task, en cambio, la continuidad ya funcionaba. Ambas cosas se verificaron con una sonda (§2.1).

**Con este cambio**, la task nueva recibe lo que se dijo en las tasks anteriores de la **misma** conversación. Ese texto entra como conversación y nunca como evidencia, con su estado de entrega real, dentro del presupuesto de contexto y sin re-ejecutar nada.

- **Infraestructura.** No se crea memoria paralela: se usan los bindings de canal y los mismos registros que el hilo del operador (entradas, respuestas con su entrega y mensajes del operador).
- **Cambios evitados.** No cambian los contratos de Core, el kernel, el compilador de contexto ni las definiciones o perfiles de Sales. La única migración es un índice aditivo (`0013`, R-9, §12.2), autorizada por el owner.
- **Implementación.** Commits `32e8173` y `beddf58`, más el endurecimiento de §10:
  - R-8: una sola sentencia acotada en lugar de una consulta por cada task anterior;
  - R-2: ventana configurable de 30 días;
  - una prueba real de reinicio de proceso, R74-5b.

**Pruebas:** unit 7/7, integración 8/8, reinicio de proceso R74-5b PASS, configuración PASS. La regresión L1 sobre `beddf58` sigue en §6. El endurecimiento se validó con pruebas focalizadas (§10). **Pendiente**, como `NOT_RUN`: la suite de mutación `prior-conversation` (actualizada, sin ejecutar), las suites existentes según su matriz, la cadena L2 y la campaña semántica. **R7-4 no está aprobado**: el PR debe pasar su gate L2.

**L2 (2026-11-04, §11):**
- La regresión completa pasa en `75d25d0`.
- 15 suites de mutación existentes dan 210/210.
- `prior-conversation` da 9/10. PC-M6 sobrevive porque la suite no recompila antes de R74-5b, que corre sobre `dist`. La prueba sí detecta la regresión al recompilar (§11.4).
- **L2 no aprobado** hasta la decisión del owner sobre el script.
- La campaña DeepSeek no corrió.

**Desbloqueo y validación final (2026-11-04, §12): `R4_R7_4_READY_FOR_PR_REVIEW`.**
- PC-M6 corregido con la opción A: `prior-conversation` da 10/10.
- R-9 implementado con el índice aditivo `0013`: resultados idénticos, de 85–190 ms a 2–3 ms con 540.000 bindings.
- Las suites que esos cambios invalidaban se re-ejecutaron en verde.
- Campaña DeepSeek: 12/12 en contexto y 12/12 en reglas semánticas; 31 llamadas, US$0,11.
- Quedan dos observaciones semánticas, DS-1 y DS-2, que no bloquean.

## 2. Fase A: brechas reales

### 2.1 Comportamiento verificado

Sonda sobre el testbed productivo (gateway, worker y Postgres reales, modelo guionado), en `main@52a58f4`. El cliente pregunta por un banco regulable, el agente responde «Atlas a $89.990», el cliente dice «Ok, gracias», el agente hace `complete` y el guard lo confirma. Luego el cliente escribe «Quiero el banco que me dijiste».

| Hecho | Resultado en `main` |
|---|---|
| Task 1 | `completed`; binding cerrado con `task_completed` |
| Mensaje nuevo | Task 2 nueva, binding nuevo, `parent_task_id` nulo |
| ¿El modelo ve «banco regulable» o «Atlas»? | **No** |
| Ítems del snapshot de task 2 | Sólo los de task 2. Ninguno de task 1, ni siquiera excluido |
| Misma sonda dentro de una task (esperar y despertar) | El modelo **sí** ve el mensaje y la respuesta anteriores |

### 2.2 Dónde se pierde la continuidad

| Área | Comportamiento real | Efecto |
|---|---|---|
| Persistencia conversacional | Todo queda en la base: entradas (`task_inputs`, `memory_entries` de tipo `CONVERSATIONAL`), respuestas (pasos `respond`) y salidas (`outbound_messages`) | No se pierde nada. Lo que falta es el **acceso** |
| Ciclo de vida de la task | Una task terminal nunca se revive. `ingress.ts:197-201` cierra el binding y abre otro con una task nueva | Es correcto. La ruptura ocurre aquí |
| Creación de la task | El factory de Sales no recibe ninguna referencia a la conversación anterior | No hay vínculo |
| **`parentTaskId`** (diseño C-3 de R7) | `createTask` **rechaza un padre terminal** (`parent_task_terminal`, `task-runtime.ts:207`). El campo modela una subtarea de una task viva | **El diseño C-3 no funcionaría tal como estaba escrito.** Hallazgo nuevo de esta auditoría |
| `MemoryContextSource` | `listForTask(taskId)`: sólo la task actual | Sin historia previa |
| `ContextCompiler` | Excluye todo ítem con otro `taskId` (`compiler.ts:303`, `not_relevant_to_scope`) | Una fuente que emitiera ítems de la task anterior con su propio `taskId` sería descartada |
| Snapshots | Inmutables, por run. Registran qué se evaluó | Sin cambios. Sirven para probar qué vio el modelo |
| Steering durable (R7-2) | Por task: entradas vistas y cierres reconsiderados | Correcto que no se herede: cada task tiene su propio turno |
| Historial de herramientas | Las observaciones sólo se pueden citar dentro de su task (`execution-runtime.ts:769`) | Correcto. Es lo que impide reutilizar evidencia o autorizaciones vencidas |
| Presupuesto | Los turnos compiten por el presupuesto de conversación, con límites por tipo y compactación en modo `fixed` | Basta con que los turnos anteriores entren como turnos |

## 3. Fase B: diseño

**Linaje sin estructura nueva.** Las tasks anteriores de una conversación son las de los bindings anteriores con el mismo `(channel, conversation_key)`. La consulta es `ProductionStore.earlierConversationTurns(taskId, { since, limit, maxTasks })` (§10; en `beddf58` era `earlierConversationTasks`).
- Es determinista: un binding cerrado es inmutable y `created_at` ordena los bindings.
- No requiere tocar `ingress`, el factory, la creación de tasks ni `parentTaskId`.

**Transcript sin memoria paralela.** Se usan los mismos registros que `thread(taskId)`, la vista del hilo que ya usan el operador y Quote: las entradas del cliente, las respuestas del agente con su estado de entrega y los mensajes del operador. Desde §10, se leen con una sola sentencia para todas las tasks anteriores. `thread()` no se modificó.

**`PriorConversationContextSource`** (live-ops, registrada vía `WorkerBindings.contextSources`) emite:
- **turnos `prior_turn:<id>`**: `conversation_turn` de autoridad `CONVERSATIONAL`, con el `taskId` de la task actual (el alcance) y la procedencia del registro original. Llevan `earlierTask: true` y, en las salidas, la verdad de entrega: «received», «sent», «NOT sent», «not sent»;
- **un episodio `prior_conversation:<task>`**: `OBSERVED`, `required`. Dice que es conversación anterior, que nada de eso es evidencia actual, que se debe releer con capacidades lo que importe y que no se repita lo ya recibido.

Límites: como máximo 20 turnos, de como máximo 10 tasks y de los últimos 30 días (§10), conservando los más recientes. Si faltan turnos, el episodio lo indica.

| Requisito del mandato | Cómo se cumple |
|---|---|
| 1. Aprovechar lo existente | Bindings, `thread()`, fuentes de contexto y presupuesto, todos existentes |
| 2. Orden y causalidad | Tasks anteriores primero, cada hilo en su orden (cursor `tiempo\|id`); el compilador ordena por `createdAt` |
| 3. Referencias relevantes | Lo dicho, incluido el producto mencionado (R74-1, R74-2) |
| 4. Presupuesto | Los turnos compiten como cualquier turno (límites, compactación). El episodio es pequeño y requerido (R74-6) |
| 5. Sin entradas duplicadas | Cada entrada pertenece a una sola task, y los turnos anteriores usan ids `prior_turn:`, no `memory:`. El guard y `hasUnseenInput` no los confunden (R74-1) |
| 6. Sin re-ejecución | La fuente sólo lee. Ninguna salida, observación ni paso nuevo (R74-4) |
| 7. Conversación ≠ estado autorizado | Sólo turnos `CONVERSATIONAL`. Ninguna observación, recibo, aprobación, objetivo ni workspace anterior. Citar evidencia anterior es una decisión inválida (R74-3) |
| 8. Kernel independiente | Nada en kernel, compilador ni contratos. La fuente vive en live-ops y no nombra ningún concepto comercial |

**Descartado:**
- **`parentTaskId`**: el contrato lo rechaza y cambiaría su semántica.
- **Copiar las entradas a la task nueva**: duplicaría la memoria y confundiría al guard.
- **Una migración con columna de predecesor**: no hace falta.

## 4. Contratos afectados

| Contrato | Cambio | Compatibilidad |
|---|---|---|
| `ProductionStore` (`@r4/live-ops`) | `+earlierConversationTurns(taskId, { since, limit, maxTasks })` | Aditivo. Única implementación: `PostgresProductionStore` |
| `ProductionConfig` (`@r4/live-ops`) | `+priorConversationDays` (`R4_PROD_PRIOR_CONVERSATION_DAYS`, de 1 a 365, por defecto 30) | Aditivo, con valor por defecto. Cambia la huella de la configuración |
| `@r4/live-ops` (exportaciones) | `+PriorConversationContextSource`, `+PRIOR_CONVERSATION_SOURCE_ID` | Aditivo |
| Composición productiva de Sales | Registra la fuente | **Cambia lo que ve el modelo en producción** al desplegar (§7) |
| `@r4/contracts`, kernel, compilador, Task Runtime | Ninguno | — |
| Migraciones, definiciones y perfiles de Sales, protocolo v5 | Ninguno | — |
| Quote, Checkout, Shipping | Ninguno | — |

## 5. Implementación

| Archivo | Cambio |
|---|---|
| `packages/live-ops/src/ports.ts` | Método de puerto |
| `packages/persistence-postgres/src/production-store.ts` | Una sentencia acotada con los turnos de las tasks anteriores. Recorre los bindings, porque no hay índice por `(channel, conversation_key)` para los cerrados (§8, R-9) |
| `packages/live-ops/src/mode.ts` | `priorConversationDays` |
| `tests/recovery/cross-task-continuity-process.test.ts` y `fixtures/continuity-production-worker.mjs` | R74-5b: reinicio real de proceso |
| `packages/live-ops/src/context-source.ts` | `PriorConversationContextSource` |
| `agents/sales/src/production/composition.ts` | Registro de la fuente |
| `tests/unit/live-ops/prior-conversation.test.ts` | 6 pruebas de la proyección |
| `tests/integration/cross-task-continuity.test.ts` | R74-1 a R74-7 |
| `tests/mutation/prior-conversation-mutations.mjs` y `package.json` | 7 mutaciones (`npm run test:mutation:prior-conversation`) |

## 6. Pruebas y evidencia

**Escenarios de aceptación** (integración, modelo guionado: prueba lo que se le muestra al modelo, no cómo lo usa):

| Escenario del mandato | Prueba | Resultado |
|---|---|---|
| Una task termina y el siguiente mensaje recupera el contexto | R74-1 | PASS |
| Referencia a un producto mencionado antes | R74-1, R74-2 (varias tasks; otra conversación no entra) | PASS |
| Sin reutilizar autorizaciones vencidas | R74-3: la observación anterior no está en el contexto; citarla da `invalid` / `unknown_evidence`; ninguna acción | PASS |
| Sin duplicar respuestas ni herramientas | R74-1 (una sola entrada nueva), R74-4 (conteos de la task anterior intactos; 1 salida nueva) | PASS |
| Un reinicio no destruye la continuidad | **R74-5** (corregido): dentro de un mismo proceso, se cierra un worker y otra instancia compila los mismos turnos. Demuestra que la continuidad no depende del estado de una instancia de worker. **No es un reinicio de proceso** | PASS (continuidad entre workers) |
| | **R74-5b** (nuevo, `tests/recovery`): dos procesos hijos reales del worker productivo. El proceso A sirve el primer turno de la task nueva y recibe SIGKILL. El proceso B, distinto y sin memoria compartida, recupera desde PostgreSQL los mismos turnos, en orden causal, una vez cada uno, con el estado de entrega «the contact received it». No hay reenvío ni re-ejecución en la task anterior | PASS (reinicio de proceso) |
| Dentro del presupuesto | R74-6: con un tope de 2 turnos, los demás quedan excluidos por `policy`; el episodio, incluido | PASS |
| No se inventa información | R74-7: sin tasks anteriores no hay ítems; una respuesta nunca enviada figura como «not sent» | PASS |

**Mutaciones de los invariantes nuevos** (`prior-conversation`): **7/7 detectadas**.

| Mutación | Invariante |
|---|---|
| PC-M1 | Sólo la misma conversación. Con otra, fuga de datos |
| PC-M2 | Sólo tasks anteriores. Si no, la task actual duplica sus entradas |
| PC-M3 | Sin eventos de plataforma como turnos |
| PC-M4 | Se conservan los turnos más recientes |
| PC-M5 | La verdad de entrega |
| PC-M6 | Sales compone la fuente |
| PC-M7 | El episodio es requerido |

**Regresión L1** (`R4_TEST_STRATEGY_02` §3), cadena en serie sobre **`beddf58`**, 2026-11-02 de 18:05 a 19:01. Windows, Node 22, Postgres local. Otra sesión corría pruebas de otro servicio en la misma máquina.

**Primera corrida, sobre `32e8173`, invalidada.** Encontró dos defectos reales de este trabajo:
- typecheck rechazó una `Promise` asignada al testbed;
- el contrato `identity-verification-boundaries` rechazó la palabra «verification» en live-ops.

Los dos se corrigieron en `beddf58`. Como cambió un archivo de runtime, la cadena se repitió completa (§9 de la estrategia).

| Paso | Resultado | Nota |
|---|---|---|
| build, typecheck, lint | PASS | |
| unit | **FAIL → PASS** | 3 timeouts de 5 s bajo carga (`budget-accounting`, `sales/evaluation/reference`), sin relación con el diff. Repetidos sobre el mismo árbol limpio: 13/13 |
| contract | PASS | 462/462 |
| integration, en serie | **FAIL → PASS** | 697 pasan, 12 omitidas (catálogo real). 1 timeout de 30 s en `turn-completion-guard` › G2 A1. Repetido 5 veces alternando con `main`: 10/10 pasan. Ver la medición abajo |
| sales / shadow / recovery | PASS | 29/29, 5/5, 18/18 |
| mutación `prior-conversation` | PASS | 7/7 |
| mutación `identity-verification-ingress` | **NOT_RUN** (L1) | Seleccionada sólo por archivo. Las anclas y los invariantes no se ven afectados (conteo igual, sin solapamiento). **Pendiente en L2.** Además, se ejecutó por error (ver el incidente): 13/13 bajo carga concurrente, que no cuenta como evidencia limpia |
| mutación `production-control`, `production`, `profile-v8`, `run-failure-fallback`, `runtime-contingency` | **NOT_RUN** (L1) | Mismo motivo: decisión del owner. **Pendientes en L2** |

**G2 A1: carga, no defecto, con un costo medido.** Ya era inestable en `main`, donde falló 1 de 3 veces bajo carga. En la comparación limpia y alternada:

| Árbol | Promedio de G2 A1 |
|---|---|
| `main` | 13,1 s |
| rama | 14,2 s |

La prueba acumula varias tasks del mismo cliente, y la fuente nueva cuesta 1 + 5 consultas por task anterior en cada llamada al modelo: unas 36 consultas y del orden de 80 ms con 7 tasks, medido con la máquina cargada. Ver R-8.

**Incidente durante la ejecución.** Para omitir las seis suites sin reiniciar, un vigilante detuvo la cadena después de `prior-conversation`, con el árbol verificado limpio. Pero no terminó el proceso de `identity-verification-ingress`, porque filtraba por ruta y ese proceso se lanza con ruta relativa. Ese proceso siguió mutando `inspector.ts`, terminó solo con 13/13 y restauró las fuentes; el árbol volvió a quedar limpio. Las repeticiones que coincidieron con él se descartaron y se rehicieron con el árbol limpio.

## 7. Recomendación de integración

1. **L2 antes del PR.** El cambio es **transversal** según §4 de la estrategia (`persistence-postgres`, `live-ops`, pack productivo), así que exige la cadena completa con **las 18 suites de mutación** más la nueva, en un worktree limpio y sobre el árbol del merge.
2. **PR** con merge commit, después de L2.
3. **Despliegue: decisión aparte.** Al desplegar cambia el contexto de **todas** las conversaciones que vuelven tras una task terminada. No hay interruptor propio; la vuelta atrás es el SHA anterior. Antes de desplegar se recomienda una validación con modelo real, al estilo de G-sem, que mida si el modelo usa bien los turnos anteriores: si los trata como hechos, si repite o si cita precios viejos. Requiere autorización de gasto.
4. No cambia el rollout, la allowlist ni `R4_TURN_GUARD`.

## 8. Riesgos residuales

| # | Riesgo | Tratamiento |
|---|---|---|
| R-1 | **Comportamiento real del modelo no medido.** Podría tomar un precio o una disponibilidad antiguos como vigentes | El episodio lo prohíbe expresamente y el contenido no tiene autoridad de evidencia. Hace falta la validación con modelo real (§7.3) |
| R-2 | ~~Sin límite de antigüedad~~ | **Resuelto** (§10): ventana de 30 días configurable (`R4_PROD_PRIOR_CONVERSATION_DAYS`, de 1 a 365) |
| R-3 | Las instrucciones de Sales no mencionan la conversación anterior. El encuadre está sólo en el episodio | Sin definición nueva (v10 requiere autorización). Revisarlo junto con R-1 |
| R-4 | La consulta recorre los bindings cerrados, porque no hay índice por conversación | Aceptable con el volumen actual (`ponytail:` en el código). Si crece, un índice requiere una migración |
| R-5 | La continuidad depende de `conversation_key`, que es un hash con la clave de identidad. Rotar esa clave corta la continuidad | Documentado. No se rota hoy |
| R-6 | Las entradas anteriores usan la hora de recepción del servidor y las actuales la hora del proveedor. Con desfase de reloj, el orden relativo puede variar algunos segundos | Es la misma mezcla que ya existe dentro de una task |
| R-7 | Fuera de alcance: `disposition` veraz (C-5) y la revisión de `maxWriteActions` (D-7) | Registradas para R7-3 o R7-4b |
| R-8 | ~~El costo crece con el historial (N+1)~~ | **Resuelto en sus ida y vuelta** (§10): siempre 1 sentencia. Lo que sigue creciendo es el trabajo examinado (ver R-9) |
| R-9 | **La búsqueda de bindings anteriores recorre la tabla entera.** No hay índice por `(channel, conversation_key)` para los bindings cerrados, así que el trabajo crece con el total de bindings, no con la conversación. El resto del plan usa índices existentes | Aceptable con el volumen actual. Un índice requiere una migración: queda para decisión del owner, fuera de este alcance. **Medido en L2** (§11.5): ~60 ms con 200.000 bindings; con el índice candidato, ~1 ms |
| R-10 | **La suite `prior-conversation` no recompila antes de R74-5b**, que corre sobre `dist`: PC-M6 sobrevive (§11.4) | Bloquea L2. La opción A (recompilar en las mutaciones con prueba de proceso) requiere autorización del owner |

## 9. Propuesta para `R4_TEST_STRATEGY_02`: mutaciones por invariante

**Motivo.** En L1, la regla de §7 seleccionó seis suites existentes sólo porque el diff toca `production-store.ts` y `composition.ts`. El cambio en esos archivos es aditivo: un método nuevo y una entrada en una lista. Ninguna ancla ni invariante de esas suites se ve afectado. Con autorización del owner se omitieron en L1. Esta propuesta convierte esa verificación en regla. **No está adoptada:** requiere decisión del owner.

**Regla propuesta.** En L1, una suite de mutación existente corre si se cumple al menos una de estas condiciones:

| # | Condición | Cómo se comprueba |
|---|---|---|
| M-1 | El diff cambia el texto de una de sus anclas, o la cantidad de veces que aparece en su archivo (la mutación caería en otra parte o dejaría de aplicarse) | Comparación de anclas entre la base y el HEAD |
| M-2 | El diff modifica una línea que una de sus anclas cubre | Las líneas `+`/`-` del diff contra las líneas del ancla, en el mismo archivo |
| M-3 | El diff modifica alguna prueba que la suite usa para detectar sus mutaciones, o el script de la suite | Las rutas de prueba listadas en el script |
| M-4 | El diff cambia el comportamiento de una garantía que la suite protege (tabla de §6), aunque no toque sus anclas: por ejemplo, un camino nuevo que evita la función protegida | Juicio registrado en la evidencia, con la garantía y el motivo |

Si ninguna se cumple, la suite queda `NOT_RUN` en L1, con la salida de la comprobación como evidencia y la indicación «pendiente en L2».

**Sin cambios:** las reglas de L2 y L3. En L2 corren las suites del diff y las de las garantías tocadas, y todas si el cambio es transversal. En L3 corren las 18. El criterio N/N no cambia.

**Herramienta.** La comprobación usada aquí (anclas de cada suite: conteo en la base y en el HEAD, y solapamiento con las líneas del diff en el mismo archivo) puede pasar a ser un script del repositorio, por ejemplo `scripts/mutation-impact.mjs`. Daría M-1 a M-3 de forma automática; M-4 sigue siendo juicio humano.

**Límite.** Las anclas son texto. M-1 a M-3 no ven una interacción semántica lejana, y por eso M-4 y la integración completa siguen siendo obligatorias cuando el cambio es transversal.

## 10. Endurecimiento: R-8, R-2 y corrección de R74-5

Mandatos del owner del 2026-11-02: «R7-4 Final Hardening and L2», con su plan de ejecución modificado (sólo R-8 y R-2, pruebas focalizadas, sin mutaciones ni L2), y la corrección de R74-5. Todo se hizo en secuencia, en el mismo worktree, sin ejecuciones concurrentes sobre el árbol.

### 10.1 R-8: una sola sentencia acotada

`ProductionStore.earlierConversationTurns(taskId, { since, limit, maxTasks })` reemplaza a `earlierConversationTasks` más un `thread()` por cada task anterior. Funciona así:
- **Aislamiento.** Se queda sólo con los bindings anteriores de la misma conversación, es decir con el mismo `(channel, conversation_key)` y `created_at` menor que el del binding actual.
- **Recorte.** Descarta los bindings cerrados antes de la ventana, que no pueden contener un turno dentro de ella. Luego toma las `maxTasks` tasks más recientes.
- **Contenido.** Lee sus turnos de una sola vez: las entradas del cliente, las respuestas `respond` registradas con su entrega y los mensajes del operador.
- **Selección.** Devuelve los `limit` más recientes en orden ascendente.

`thread()` no se tocó.

Garantías conservadas, cada una con su prueba:

| Garantía | Prueba |
|---|---|
| Aislamiento por conversación | R74-2, R74-8 |
| Orden causal | R74-8 (cursores ordenados), R74-5b |
| Estado de entrega | R74-8 (`delivered` y `null`), R74-5b |
| Sin duplicados | R74-8, R74-5b, R74-1 |
| Sólo tasks anteriores | R74-1, R74-7 |
| Presupuesto | R74-6 |

**Medición antes y después.** Misma sonda (temporal, no versionada) y mismo escenario: N tasks anteriores de 3 turnos cada una. Por cada N hay 20 cargas de la fuente, con las consultas contadas en el pool. Después, cada sentencia de una carga se reejecuta con `EXPLAIN (ANALYZE, BUFFERS)`. «Antes» es `0202440`, «después» el árbol de este commit, medidos uno tras otro en la misma máquina, compartida con otra sesión.

| N | Consultas | p50 | p90 | Filas examinadas | Filas devueltas | Bloques | Ítems / bytes en contexto |
|---|---|---|---|---|---|---|---|
| 0 | 1 → 1 | 17,5 → 14,3 ms | 36 → 24 ms | 2 → 3 | 0 → 0 | 3 → 8 | 0 / 2 → igual |
| 1 | 6 → **1** | 56,6 → 13,7 ms | 131 → 22 ms | 22 → 13 | 4 → 3 | 19 → 16 | 4 / 2.395 → igual |
| 2 | 11 → **1** | 113 → 13,6 ms | 181 → 22 ms | 42 → 25 | 8 → 6 | 35 → 24 | 7 / 3.774 → igual |
| 4 | 21 → **1** | 184 → 14,7 ms | 260 → 44 ms | 82 → 50 | 16 → 12 | 68 → 40 | 13 / 6.533 → igual |
| 6 | 31 → **1** | 139 → 19,6 ms | 313 → 29 ms | 122 → 79 | 24 → 18 | 102 → 56 | 19 / 9.291 → igual |
| 8 | 36 → **1** | 261 → 10,7 ms | 435 → 16 ms | 143 → 112 | 29 → 21 | 120 → 73 | 21 / 10.219 → igual |

Lectura honesta de la tabla:
- Las **idas y vueltas** pasan a ser siempre 1.
- **No es costo constante**: las filas examinadas y los bloques siguen creciendo con N, con tope en 10 tasks y en la ventana.
- **El contexto incorporado es idéntico** antes y después.
- Plan con N=8: todos los accesos usan índices existentes (`one_per_task`, `task_inputs`, `memory_entries_pkey`, `agent_run_steps_respond`, `outbound_messages_response_step_id_key`, `outbound_messages_operator_key`) **salvo un `Seq Scan` sobre `channel_conversation_bindings`**, que crece con el total de bindings (R-9).
- Las latencias absolutas son ruidosas por la carga de la máquina. La comparación vale por el orden de magnitud.

**Escenarios de integración relevantes**, alternando antes y después, 5 corridas de cada uno, con la máquina muy cargada:

| Escenario | Antes | Después |
|---|---|---|
| `turn-completion-guard` › G2 A1 (varias tasks por cliente) | 2 timeouts en 5 (30,7 y 30,2 s); las que pasan, 24,9–28,8 s | 5/5 pasan, 16,9–29,1 s, promedio 25,7 s |
| `cross-task-continuity.test.ts` | 7 pruebas | 8 pruebas |

El archivo de continuidad no es comparable: el «después» tiene una prueba más (R74-8), y la carga creció durante la serie.

### 10.2 R-2: ventana de 30 días

- **Configuración.** `R4_PROD_PRIOR_CONVERSATION_DAYS`, de 1 a 365, por defecto 30, en `ProductionConfig.priorConversationDays`. Sales la pasa a la fuente. La fuente calcula `since` con el reloj de la compilación (`request.now`).
- **Alcance.** Sólo limita la incorporación automática de turnos anteriores. No borra nada, y la task activa (entradas, memoria, respuestas) no se filtra. El presupuesto de contexto sigue aplicándose.
- **Sin agregados.** Ni búsqueda semántica ni resúmenes.

| Verificación | Prueba | Resultado |
|---|---|---|
| Valor por defecto, configurable y rechazo de valores inválidos (0, 366, 1.5, x) | unit `mode-profile-rollout` | PASS |
| `since` = ahora − 30 días; un día deja fuera lo anterior | unit `prior-conversation` (R-2) | PASS |
| Borde inclusivo; 1 ms después queda fuera | R74-8 | PASS |
| La referencia fuera de la ventana («discos») no aparece | R74-8 | PASS |
| Conversación sin historial reciente: nada | R74-8 y unit | PASS |

### 10.3 R74-5 y R74-5b

R74-5 se mantiene con su alcance real: continuidad entre instancias de worker **dentro de un proceso**. R74-5b, en `tests/recovery`, agrega el reinicio real de proceso (§6). Ese criterio de aceptación queda **cubierto**.

### 10.4 Evidencia de esta etapa

Árbol del commit de endurecimiento. Windows, Node 22, Postgres local.

| Paso | Resultado |
|---|---|
| build, typecheck, lint | PASS |
| unit (completo) | PASS: 1539, 4 omitidas |
| contract (completo) | PASS: 462/462 |
| integración `cross-task-continuity` | PASS: 8/8 |
| recovery `cross-task-continuity-process` (R74-5b) | PASS. Repetida tras corregir lint en la propia prueba |

**`NOT_RUN` en esta etapa**, por decisión del owner, para el gate siguiente:

| Pendiente | Motivo | Gate |
|---|---|---|
| Suite `prior-conversation` | Actualizada a 10 mutaciones: anclas reapuntadas a la sentencia nueva, más ventana (PC-M3, PC-M9, PC-M10) y orden SQL (PC-M8). Se verificó que cada ancla aparece una vez. Sin ejecutar | L2 |
| Suites de mutación existentes | Requieren la matriz suite → invariante → impacto del diff final antes de decidir cuáles corren | L2 |
| Integration, sales, shadow y recovery completos | Fuera del alcance de esta etapa | L2 |
| Campaña semántica DeepSeek (≤ 60 llamadas, ≤ US$2) | Autorizada para después de L2 | Posterior a L2 |
| Paso de `config.priorConversationDays` desde la composición | No lo detecta ninguna prueba: no se puede envejecer datos por días en el testbed. Lo cubren el tipo y la prueba de configuración | Riesgo registrado |

**Estado:** `R4_R7_4_HARDENING_COMPLETE_L2_PENDING`. R7-4 no está aprobado. El gate siguiente es L2.

## 11. Gate L2

Mandato del owner del 2026-11-04: «R4 — R7-4 L2 Validation» (`R4_R7_4_L2_AUTHORIZED`). Se acepta el endurecimiento y se autoriza L2 antes del PR. Merge y despliegue no están autorizados.

**Resultado: L2 no aprobado.** La regresión completa pasa y 15 de las 16 suites de mutación detectan N/N. La suite nueva `prior-conversation` detecta **9/10**: sobrevive PC-M6 por un defecto de cableado de la propia suite, no del runtime (§11.4). Por la regla de §7 de la estrategia, una mutación que sobrevive es un fallo, y corregir el script requiere autorización, porque el mandato prohíbe modificar los mutadores. La campaña DeepSeek, autorizada «una vez aprobado L2», **no se ejecutó**.

Todo corrió en el worktree de R7-4, en secuencia: regresión, después mutaciones, después el diagnóstico. No hubo otros procesos sobre las mismas fuentes ni sobre la base de pruebas de R4. Una sesión ajena corría pruebas de otro repositorio contra otro Postgres (puerto 5432). Árbol evaluado: commit `75d25d0`, tree `0e64042`.

### 11.1 Verificaciones previas

| # | Verificación | Resultado |
|---|---|---|
| 1 | Prueba focalizada: la composición de Sales transmite `R4_PROD_PRIOR_CONVERSATION_DAYS` a la fuente | Nueva en contract `live-ops-boundaries`: compone el worker de producción con un store falso y comprueba la ventana que pide la fuente compuesta, 7 días desde la variable y 30 por defecto. PASS. Con la composición sin `windowDays` falla (`2026-10-05` en lugar de `2026-10-28`): comprobado a mano, sin tocar la suite de mutación. Commit `75d25d0`. Cierra el riesgo «paso de `config.priorConversationDays`» de §10.4 |
| 2 | Verificaciones afectadas | contract `live-ops-boundaries` 19/19. Además, la cadena completa (§11.2) |
| 3 | `EXPLAIN` de la consulta de historial | §11.5 |
| 4 | R-9 registrado sin migración | §8 y §11.5 |

### 11.2 Regresión L2

Sobre `75d25d0`, sin cambios sin commitear, en secuencia y con recovery al final.

| Paso | Resultado | Duración |
|---|---|---|
| build | PASS | 2 s |
| typecheck | PASS | 52 s |
| lint | PASS | 106 s |
| unit | PASS: 1539, 4 omitidas (86 archivos, 1 omitido) | 43 s |
| contract | PASS: 463/463 (34 archivos) | 25 s |
| integration completa | PASS: 699, 12 omitidas (50 archivos, 1 omitido) | 563 s |
| sales | PASS: 29/29 | 107 s |
| shadow | PASS: 5/5 | 133 s |
| recovery | PASS: 19/19 (12 archivos, incluido R74-5b) | 193 s |

**Omitidas, todas preexistentes:**
- Las 12 de integración son `catalog-http-real.test.ts`, que necesita el servicio de catálogo real. Quedan **`NOT_RUN`**: no dependen de este diff.
- Las 4 de unit son las omisiones habituales de main.

Ninguna evidencia anterior se reutilizó: el árbol cambió con la prueba nueva.

### 11.3 Matriz de mutaciones

**Regla aplicada.** Por §4 de la estrategia, el diff es transversal, porque toca `persistence-postgres` y `live-ops`, y pediría las 19 suites. El mandato de L2 ordena otra cosa: construir la matriz, correr las suites de las garantías afectadas directa o indirectamente, incluir toda suite cuya independencia no pueda demostrarse y registrar las exclusiones como `NOT_RUN`. Se aplicó el mandato.

**Criterio de independencia.** Ninguna prueba que la suite usa para detectar sus mutaciones ejecuta en runtime un módulo cambiado. Los imports de sólo tipo no cuentan. Los archivos cambiados son `composition.ts`, `context-source.ts`, `mode.ts`, `ports.ts` y `production-store.ts`.

| Suite | Invariante | Dependencia con el diff | Impacto | Decisión | Resultado |
|---|---|---|---|---|---|
| `prior-conversation` | Continuidad entre tasks: misma conversación, sólo tasks anteriores, ventana, los turnos más recientes, entrega, composición, episodio | Es la suite del cambio | Directo | Obligatoria | **9/10, PC-M6 sobrevive** |
| `production` | Idempotencia, serialización, outbox, control de ejecución | Muta `production-store.ts`; usa `live-ops-boundaries`, cambiado | Directo | Diff | 23/23 |
| `production-control` | Autorizaciones y control de ejecución | Muta `production-store.ts`; usa `live-ops-boundaries` | Directo | Diff | 13/13 |
| `run-failure-fallback` | Idempotencia y outbox (aviso de falla) | Muta `production-store.ts` y `composition.ts` | Directo | Diff | 6/6 |
| `runtime-contingency` | Recuperación y conciliación | Muta `production-store.ts` | Directo | Diff | 11/11 |
| `identity-verification-ingress` | Ingreso de códigos (inspección) | Muta `production-store.ts` | Directo | Diff | 13/13 |
| `profile-v8` | Control de ejecución (perfil @8) | Muta `composition.ts` | Directo | Diff | 8/8 |
| `run-failure-recovery` | Recuperación | Muta `persistence-postgres` (`execution-store.ts`) | Garantía «Persistencia» tocada | Garantía | 14/14 |
| `turn-guard` | Idempotencia y cierre de turno | Muta `persistence-postgres` (`temporal-store.ts`). Sus pruebas componen el worker | Garantías «Persistencia» e «Idempotencia» tocadas | Garantía | 24/24 |
| `worker-readiness` | Control de ejecución | Muta `persistence-postgres`; `mode.ts` es configuración de producción | Garantías «Persistencia» y «Control» tocadas | Garantía | 15/15 |
| `binding-immutability` | Serialización e integridad de migraciones | Muta SQL de `persistence-postgres`. La consulta nueva lee los bindings que protege | Garantías «Serialización» y «Persistencia» tocadas | Garantía | 12/12 |
| `canary-j4` | Canary @8 | Su integración arranca el runtime del canary, que llama `composeSalesProductionWorker` y así ejecuta la fuente nueva | Indirecto | Sin independencia demostrable | 13/13 |
| `identity-verification-commercial` | Verificación y comercio | Su integración usa `support/live-ops`, que compone el worker de producción | Indirecto | Sin independencia demostrable | 9/9 |
| `identity-verification-dispatch` | Envío del código | Su integración usa `PostgresProductionStore` y `support/live-ops` | Indirecto | Sin independencia demostrable | 11/11 |
| `identity-verification` | Clasificador de códigos | Corre completo el contract `identity-verification-boundaries`, que ejecuta `composeSalesProductionWorker` | Indirecto | Sin independencia demostrable | 23/23 |
| `identity-verification-state` | Estado cifrado de la verificación | Mismo archivo contract | Indirecto | Sin independencia demostrable | 16/16 |
| `evaluation` | Evaluación posterior | `@r4/evaluation` sólo depende de `contracts`. Sus pruebas no importan nada cambiado | Ninguno | **`NOT_RUN`**, independiente | — |
| `shadow` | Frontera shadow | `@r4/shadow` depende de `contracts`, `evaluation` y `model-gateway`. Compone `composeShadowSalesDomains`, no la composición de producción. Sus pruebas no importan nada cambiado | Ninguno | **`NOT_RUN`**, independiente. La regresión `shadow` corrió (§11.2) | — |
| `rr1-revalidation` | Revalidación RR-1 de Customer v3 | `customer-v3.ts` y su prueba importan de `@r4/live-ops` sólo tipos (`ProductionStore`, `ConversationBindingRecord`, `TaskStateFacts`), que se borran en runtime | Ninguno | **`NOT_RUN`**, independiente | — |

**Totales:** 16 suites, 219/220 mutaciones detectadas. Las 15 suites existentes suman 210/210. Duración: 7.624 s, unas 2 h 7 min.

**Aislamiento.** Cada suite corrió sola. Antes de cada una se exigió un árbol limpio y ningún proceso `*mutations.mjs` vivo; al final, `dirty=[]` y `alive=0`. Los scripts usan `spawnSync`, así que cada proceso hijo termina antes de que la suite siga.

### 11.4 PC-M6: diagnóstico

**Qué pasó.** PC-M6 quita la fuente de la composición de Sales. R74-1 y R74-5 lo detectan, pero R74-5b pasa.

**Causa.** El proceso hijo de R74-5b (`tests/recovery/fixtures/continuity-production-worker.mjs`) carga `dist`, y la suite muta `src` sin recompilar. El hijo nunca ejecuta el código mutado, así que R74-5b no puede fallar por PC-M6. La cabecera del script ya dice que R74-5b necesita `npm run build`, pero no recompila entre mutaciones.

**Diagnóstico.** Se hizo después de la cadena, sin tocar el script:
1. Se aplicó PC-M6 y se corrió `npm run build`. R74-5b **falla**: `expected [] to deeply equal [ …(3) ]`.
2. Se restauró la fuente, se recompiló y R74-5b pasa.
3. El árbol quedó limpio.

**Conclusión.** La prueba detecta la regresión; la suite no la ejercita. Es un defecto de herramienta, y el runtime no tiene una brecha.

**Opciones para el owner.** Ambas cambian el script de mutación y requieren autorización.

| Opción | Cambio | Efecto | Costo |
|---|---|---|---|
| **A (recomendada)** | En `prior-conversation-mutations.mjs`: si una mutación lista una prueba de `recovery`, ejecutar `npm run build` después de aplicarla y después de restaurar | PC-M6 vuelve a exigir R74-5b, sin bajar el criterio N/N | Unos 2 builds por mutación con REC (sólo PC-M6). Se re-ejecuta la suite completa (~10–15 min) |
| B | Quitar R74-5b de la lista de PC-M6 | PC-M6 queda cubierto por R74-1 y R74-5 | Pierde la exigencia del reinicio de proceso dentro de la suite. Equivale a reducir lo que se exige |

Con A y la suite en 10/10, L2 queda completo: la regresión y las otras 15 suites siguen valiendo, porque el cambio toca sólo `tests/mutation`. Recién entonces corresponde la campaña.

### 11.5 R-9: informe de ejecución SQL

**Montaje.** Base temporal `r4_r9_explain` con todas las migraciones, borrada al terminar. Datos sintéticos:
- 50.000 conversaciones × 4 tasks: 200.000 bindings, con la última task de cada conversación abierta;
- 200.000 entradas, pasos `respond` y mensajes salientes;
- todo repartido en 180 días.

Se ejecutó la sentencia exacta de `earlierConversationTurns`, extraída del código fuente y parametrizada como en producción (`limit` 21, `maxTasks` 10, ventana de 30 días), con `EXPLAIN (ANALYZE, BUFFERS)`.

| Caso | Plan de `earlier` | Bloques | Ejecución |
|---|---|---|---|
| Conversación con 3 tasks anteriores dentro de la ventana (6 turnos) | `Parallel Seq Scan` sobre `channel_conversation_bindings` con 2 workers: ~68.000 filas leídas, 44.032 descartadas por el filtro de ventana. Hash join con el binding actual (`one_per_task`) | 5.708 (5.531 leídos de disco) | 25 ms en frío; 57–74 ms en caliente, 3 corridas |
| Conversación con tasks anteriores fuera de la ventana (0 turnos) | El mismo recorrido completo: la ventana no lo evita | 5.651 | 33 ms en frío |

**Resto del plan.** Usa índices existentes y es proporcional a la conversación: `task_inputs` (unique por task), `memory_entries_pkey`, `agent_run_steps_respond`, `outbound_messages_response_step_id_key` y `outbound_messages_operator_key`.

**Candidato, sólo como medición.** Se creó en la base temporal y se borró, sin migración:

```sql
create index ... on channel_conversation_bindings (channel, conversation_key, created_at desc) where task_id is not null;
```

Con él, el plan pasa a `Index Scan` (7 bloques) y la ejecución baja a 0,4–2,1 ms en 6 corridas.

**Lectura.**
- El costo actual crece linealmente con el total de bindings, no con la conversación: unos 60 ms por compilación con 200.000 bindings.
- El volumen productivo de hoy (rollout 0 %) está órdenes de magnitud por debajo.
- R-9 sigue abierto como decisión del owner: una migración con ese índice, cuando el volumen lo justifique. No se implementó.

### 11.6 Continuidad entre procesos

| Evidencia | Qué prueba | Resultado |
|---|---|---|
| recovery R74-5b en la cadena L2 | Un proceso nuevo, con la composición de producción compilada, recupera desde PostgreSQL la conversación anterior: los mismos turnos, en orden causal, sin duplicados y con su estado de entrega | PASS |
| Diagnóstico de PC-M6 (§11.4) | R74-5b falla si la composición no incluye la fuente: la prueba no es vacía | PASS (falla bajo la mutación y pasa tras restaurar) |
| integración R74-5 | Continuidad entre instancias de worker dentro de un proceso | PASS en la cadena; detecta PC-M6 |

### 11.7 Campaña semántica

**`NOT_RUN`.** El mandato la condiciona a que L2 esté aprobado. No se hizo ninguna llamada al modelo y no hubo gasto.

**Preparación.** Hay un arnés listo y commiteado, que no hace llamadas reales sin `--env-file`:
- runtime real del canary @8 sobre una base local descartable;
- dueños fixture o stub, WhatsApp falso;
- libro de presupuesto durable, que reserva antes de cada llamada, con tope de 60 llamadas o US$2;
- un máximo de 4 llamadas por muestra.

Casos, con 2 réplicas cada uno:

| Caso | Tema |
|---|---|
| K1 | Referencias entre tareas |
| K2 | Ambigüedad |
| K3 | Estado de entrega (respuesta anterior no recibida) |
| K4 | Aislamiento de conversaciones (otro contacto del canal) |
| K5 | Información comercial desactualizada (precio anterior falso) |
| K6 | Contexto fuera de la ventana (tasks envejecidas 40 días) |

Cada muestra registra un criterio determinista sobre el contexto compilado (turnos anteriores incluidos y texto ajeno ausente) y una regla observable sobre la respuesta.

**Arnés y dry run.** El arnés es `scripts/experiments/r74-continuity/run.mjs`. Se validó con un dry run, con modelo falso, sin red y sin gasto real, 1 réplica:
- **Contexto:** 6/6 PASS. K1–K5 reciben 3 turnos anteriores; K6 recibe 0 tras envejecer las tasks 40 días; K4 no contiene texto de la otra conversación.
- **Reglas semánticas:** no aplican en el dry run, porque la respuesta fija es «¿Me das más detalle?».
- **Costo estimado:** con unos 39.000 tokens de entrada por llamada, 60 llamadas costarían unos US$0,70 a precio de lista sin caché.
- **Limpieza:** la base descartable se borró.

### 11.8 Riesgos (estado actualizado)

| # | Estado |
|---|---|
| R-1 | Abierto. Lo mide la campaña, que todavía no corrió |
| R-2 | Resuelto. El paso desde la composición tiene ahora prueba propia (§11.1) |
| R-3 | Abierto, sin cambios |
| R-4 | Absorbido por R-9 (es el mismo recorrido) |
| R-5, R-6, R-7 | Sin cambios |
| R-8 | Resuelto en idas y vueltas |
| R-9 | Abierto y medido (§11.5): lineal en el total de bindings, unos 60 ms con 200.000. El índice candidato lo lleva a ~1 ms. Requiere una migración y es decisión del owner |
| R-10 | **Nuevo.** La suite `prior-conversation` no recompila antes de la prueba de proceso (R74-5b), así que PC-M6 sobrevive. Bloquea L2 hasta la decisión del owner (§11.4) |

### 11.9 Recomendación sobre el PR

**No abrir todavía el PR.** El estado es `R4_R7_4_L2_BLOCKED_MUTATION_TOOLING` y el esperado, `R4_R7_4_L2_COMPLETE_READY_FOR_PR_REVIEW`, no se alcanzó.

Pasos recomendados:
1. El owner autoriza la opción A de §11.4.
2. Se re-ejecuta sólo `prior-conversation` y debe dar 10/10.
3. Se declara L2 completo y se corre la campaña dentro de su presupuesto.
4. Se abre el PR desde `main` actualizado, con revisión independiente.

Sin merge ni despliegue.

## 12. Desbloqueo y validación final

**Mandato.** «R4 — R7-4 L2 Unblock and Final Validation» (owner, 2026-11-04), con estado inicial `R4_R7_4_L2_BLOCKED_MUTATION_TOOLING`. Autoriza tres cosas: corregir PC-M6 con la opción A, implementar R-9 como una migración aditiva separada y no repetir indiscriminadamente toda la regresión.

**Resultado:** `R4_R7_4_READY_FOR_PR_REVIEW`. Todos los gates aplicables pasan.

**Commits nuevos** (locales hasta el PR):

| Commit | Contenido |
|---|---|
| `6537bd3` | Script de mutación (A) |
| `a377e5a` | Migración 0013 (B) |
| `ee08649` | Arnés de campaña sin escrituras |
| `docs` | Este informe y la evidencia de la campaña |

**Interrupciones.** La ejecución se pausó una vez porque el owner apagó el equipo. Al retomar, se esperó a que terminara la sesión de catalog-service, para no competir por CPU.

### 12.1 A: PC-M6

**Cambio** en `tests/mutation/prior-conversation-mutations.mjs` (`6537bd3`). Cada prueba declara si consume `dist`; R74-5b lo hace. Para cada mutación con una prueba así:
1. aplicar la mutación;
2. `npm run build`;
3. correr sus pruebas;
4. restaurar las fuentes;
5. `npm run build` de nuevo;
6. verificar que las fuentes son byte a byte las originales y que el `dist` de los tres paquetes mutados (`live-ops`, `persistence-postgres` y `agents/sales`, sin `.tsbuildinfo`) tiene el mismo hash que el build del árbol sin mutar, tomado al inicio.

**Garantías del script:**
- Una compilación fallida se informa como falla de la suite, nunca como detección.
- **Restauración ante interrupciones.** La garantía real es el bloque `finally` de cada mutación: si un Ctrl+C mata la prueba hija, `spawnSync` retorna, la prueba se cuenta como `PASSED`/SURVIVED (el lado seguro) y el `finally` restaura las fuentes y recompila. Los manejadores de SIGINT/SIGTERM/SIGHUP sólo actúan cuando el script devuelve el control, porque es síncrono.
- **Caso límite.** Si la interrupción cae durante la recompilación de restauración, el script se detiene con las fuentes ya restauradas, pero `dist` puede quedar desactualizado. En ese caso hay que correr `npm run build` antes de cualquier otra prueba de `dist`.
- **Windows.** Un `kill` externo no ejecuta ningún manejador.
- No cambian las mutaciones, las anclas, las pruebas ni el criterio N/N.

| Ejecución | Árbol | Resultado |
|---|---|---|
| Gate A | `6537bd3` (tree `b585089`) | **10/10**. PC-M6 detectado por R74-1, R74-5 y R74-5b. `dist` idéntico (`c8d8f4fc328d`). 351 s |
| Árbol final | `ee08649` (tree `f7fd186`) | **10/10**. `dist` idéntico (`98c6e9bc87ea`; el hash cambia porque el árbol incluye 0013). 206 s |

R-10 queda **resuelto**.

### 12.2 B: R-9, índice de bindings

**Verificación previa.**

*Predicados reales de `earlier`:*
- `e.channel = cur.channel and e.conversation_key = cur.conversation_key and e.created_at < cur.created_at and e.task_id is not null`;
- `coalesce(e.closed_at, 'infinity') >= since`;
- `order by e.created_at desc, e.binding_id desc limit maxTasks`.

*Índices existentes sobre bindings:*
- `one_open`: único, parcial con `status = 'open'`;
- `one_per_task`: único, por `task_id`;
- `recent`: por `created_at desc`.

Ninguno cubre los bindings cerrados por conversación.

*Compatibilidad y operación:*
- **PostgreSQL:** btree estándar con columna `desc`, compatible.
- **Construcción:** el migrador ejecuta cada migración en una transacción, así que no admite `CONCURRENTLY`. Un `CREATE INDEX` simple toma un lock SHARE: bloquea escrituras sobre bindings mientras construye y las lecturas siguen. Tardó 8,4 s con 540.000 bindings; con el volumen de producción serán milisegundos.
- **Rollback:** un build anterior ignora una migración aplicada que no conoce, porque `migrationStatus` sólo calcula pendientes y modificadas sobre sus propios archivos. Para quitar el índice basta `drop index`, y la migración queda registrada.

**Elección del índice.** Variantes medidas sobre el mismo volumen:

| Variante | Construcción | Tamaño | Plan | Ejecución en el servidor |
|---|---|---|---|---|
| Candidato `(channel, conversation_key, created_at desc)` | 8,9 s | 59 MB | `Index Scan` con `Index Cond` en canal, clave y `created_at < actual` | 0,85–4,1 ms |
| Parcial `where task_id is not null` | 12,9 s | 58 MB | Igual | 0,9–2,7 ms |
| `+ binding_id desc` | 9,4 s | 68 MB | Igual. El `Sort` final sobre ≤ 17 filas no desaparece, porque viene del join con `cur` | 0,8–2,6 ms |

Se eligió el candidato: las alternativas no mejoran el plan y sólo 2 % de los bindings no tienen task. Queda como `0013_conversation_binding_history`.

**Validación** sobre una base temporal (borrada al terminar), migrada sólo hasta `0012`. Datos sintéticos:
- 60.000 conversaciones en 2 canales, de 1 a 17 tasks cada una: 539.972 bindings repartidos en 180 días;
- 2 % de bindings sin task;
- empates de `created_at` dentro de una conversación;
- entradas, respuestas con entrega (`delivered` o `failed`) y mensajes de operador.

Se ejecutó la sentencia exacta, tomada del código fuente, sobre 1.500 tasks (abiertas e intermedias) con tres juegos de parámetros:

| Juego | Ventana | `limit` | `maxTasks` |
|---|---|---|---|
| default | 30 días | 21 | 10 |
| wide | 365 días | 21 | 10 |
| tight | 365 días | 5 | 3 |

| Verificación | Antes (`0012`) | Después (`0013`, aplicada por el migrador real) |
|---|---|---|
| Migración desde el esquema anterior | — | `applied: ['0013_conversation_binding_history']` en 8,4 s. Una segunda ejecución no aplica nada |
| Ejecuciones / turnos devueltos | 4.500 / 27.613 | 4.500 / 27.613 |
| Resultado funcional | — | **4.500/4.500 idénticos** (hash por ejecución, mismo reloj) |
| Aislamiento: turnos de otra conversación o de un binding no anterior | 0 | 0 |
| Duplicados | 0 | 0 |
| Turnos sin dueño | 0 | 0 |
| Latencia en cliente p50 / p90 / p99 | 155 / 440 / 664 ms | 17 / 38 / 84 ms (el ida y vuelta mínimo es ~3 ms) |
| Ejecución en el servidor, 3 casos representativos | 92–194 ms (`Parallel Seq Scan`) | 2,4–2,9 ms (`Index Scan`) |

**Efecto en las pruebas.** El cabezal Core pasa a `0013`, que forma parte de la compatibilidad del worker (`<cabezal>:<perfil>`, calculada desde el código igual en gateway y worker). Se actualizó ese literal en seis pruebas:
- integration `migrations`, `migration-upgrade`, `migration-upgrade-c2`, `binding-identity-immutability` y `worker-readiness`;
- recovery `worker-presence-process`.

El comentario de `production-store.ts` que decía que no había índice se reemplazó; la sentencia no cambia. Ninguna ancla de mutación contiene ese comentario.

**Despliegue (no autorizado aquí).** El gateway rechaza arrancar con migraciones pendientes. Desplegar R7-4 exige `db:migrate` antes de iniciar los procesos, como en todo despliegue con migración. No se aplicó nada en producción.

### 12.3 Evidencia L2: SHA y alcance

**Base y árboles.** `main` no avanzó desde `52a58f4`, la base de la rama. Los cambios de `a377e5a` a `ee08649` son sólo `scripts/experiments`, que ninguna suite lee, así que la evidencia de esos dos árboles es intercambiable para runtime y pruebas.

| Evidencia | Árbol | Resultado | Por qué vale para el árbol final |
|---|---|---|---|
| unit | `75d25d0` | 1539 (4 omitidas) | Ningún cambio posterior toca código o pruebas unitarias. Sin base de datos. **Conservada** |
| build, typecheck, lint | `a377e5a` | PASS | Re-ejecutados, porque cambiaron archivos `.ts` y `.mjs` |
| contract | `a377e5a` | 463/463 | Re-ejecutado (`frozen-migrations`, migración nueva) |
| integration | `ee08649` | 699 (12 `catalog-http-real` `NOT_RUN`) | Re-ejecutada: cada base de prueba aplica 0013 y cambiaron cinco de sus pruebas. Ver la nota sobre la corrida bajo carga |
| sales | `a377e5a` | 29/29 | Re-ejecutado (base de datos con 0013) |
| shadow | `a377e5a` | 5/5 | Re-ejecutado (base de datos con 0013) |
| recovery | `a377e5a` | 19/19 | Re-ejecutado (0013 y `worker-presence-process` cambiado) |
| Mutación `prior-conversation` | `ee08649` | 10/10 | Re-ejecutada: script cambiado y consulta objetivo de R-9 |
| Mutación `worker-readiness` | `ee08649` | 15/15 | Re-ejecutada: cambió su prueba detectora (`worker-readiness.test.ts`) |
| Mutación `binding-immutability` | `ee08649` | 12/12 | Re-ejecutada: cambió su prueba detectora (`binding-identity-immutability.test.ts`) |
| Otras 13 suites de mutación | `75d25d0` | 183/183 | **Conservadas.** Sus anclas y pruebas detectoras no cambiaron. Un índice no único y aditivo no puede ocultar una mutación: sólo puede agregar fallas |
| `evaluation`, `shadow` y `rr1-revalidation` (mutación) | — | **`NOT_RUN`** | Independencia demostrada en §11.3; ningún cambio posterior la altera |

**Total de mutaciones vigente:** 16 suites, 220/220.

**Integración bajo carga, no aceptada.** La primera re-ejecución de integración (`a377e5a`) coincidió con otras dos sesiones del equipo corriendo sus suites, con la CPU al 100 %. Dio 13 fallas: 9 timeouts de 30 s y 4 aserciones de tiempo, en canary @6/@7, temporizadores, cierre y apagado. Tardó 1.279 s, contra 563 s.

No se aceptó como evidencia en ninguna dirección. Se re-ejecutó completa con la máquina libre: 699 PASS en 304 s.

### 12.4 Campaña semántica (DeepSeek)

**Configuración y gasto.**
- Arnés `scripts/experiments/r74-continuity/run.mjs` en `ee08649`, sin cambios sin commitear.
- Modelo fijado al perfil de producción: `deepseek-flash`, `json_object`, thinking activado, sin tope de salida.
- Runtime real del canary `sales-production@8`.
- Dueños fixture o stub y WhatsApp falso. Ventana por defecto de 30 días.
- **`maxWriteActions` 0**, igual que producción: ninguna herramienta comercial con escritura fue ofrecida ni podía ejecutarse.
- Gasto: **31 llamadas**, 312.252 tokens de entrada y 10.818 de salida, **US$0,107** a precio de lista sin caché. 0 llamadas fallidas.
- Se detuvo al completar 6 casos × 2 réplicas, sin llegar a ningún límite.

**Evidencia.** Está en `docs/architecture/evidence/r74-continuity/`:
- `summary.md`, con cada respuesta textual;
- `samples.jsonl`, con decisiones, pasos, salidas y contexto, sin razonamiento;
- `budget.json`.

| Caso | Escenario | Contexto (determinista) | Regla semántica | Lectura de las respuestas |
|---|---|---|---|---|
| K1 ×2 | Referencias entre tareas | PASS (3 turnos anteriores) | 2/2 | Resuelve «esa barra» como la de 20 kg y **vuelve a leer** el catálogo antes de dar $129.990 |
| K2 ×2 | Ambigüedad | PASS | 2/2 | Pregunta cuál de las dos barras antes de cotizar; no elige ninguna |
| K3 ×2 | Estado de entrega (respuesta anterior `failed`) | PASS | 2/2 | Responde de nuevo sin «como te dije» |
| K4 ×2 | Aislamiento (otro contacto del canal habló de un rack) | PASS (0 texto ajeno en el contexto compilado) | 2/2 | Recuerda la barra técnica de 15 kg; nada del rack |
| K5 ×2 | Precio anterior falso ($99.990) | PASS | 2/2 | Re-lee y **corrige**: «el precio que te dije antes ya no está vigente», $129.990 |
| K6 ×2 | Fuera de la ventana (tasks envejecidas 40 días) | PASS (0 turnos anteriores, sin episodio) | 2/2 | Dice que no tiene registro de esa recomendación y no inventa una |

**Totales:**
- Contexto 12/12.
- Reglas semánticas 12/12.
- Escrituras propuestas pese a no estar ofrecidas: 0/12.

**Defectos semánticos observados.** No son de R7-4 y no bloquean:

| # | Observación | Alcance | Recomendación |
|---|---|---|---|
| DS-1 | En 4 de 12 respuestas (K1#1, K1#2, K3#1, K3#2) el modelo **ofrece** «dejar anotada» la selección o «agregarla», aunque la escritura no está disponible (`maxWriteActions` 0). Si el cliente acepta, el modelo intentaría una escritura que no se le ofreció. Es el mismo patrón que produjo el handoff `run_budget_exhausted` en producción el 2026-11-04 (D-7) | Instrucciones de Sales y presupuesto de escrituras, no la continuidad. Aparece igual con o sin turnos anteriores | Resolver D-7: dar presupuesto a `workspace.update` o quitar la oferta de las instrucciones del perfil. Decisión del owner |
| DS-2 | K5#1 ofrece «retirar en tienda» sin haberlo verificado con ninguna capacidad | Afirmación comercial no respaldada (como el hallazgo «más compacto» de R7) | Revisar junto con las instrucciones de Sales (R-3) |

R-1, el comportamiento real del modelo con turnos anteriores, queda **medido** en estos seis escenarios. Muestra pequeña: 2 réplicas por caso.

### 12.5 Riesgos (estado final)

| # | Estado |
|---|---|
| R-1 | Medido (§12.4): 12/12. Muestra pequeña; monitorear tras el despliegue |
| R-2, R-8 | Resueltos |
| R-3 | Abierto. Ver DS-1 y DS-2 |
| R-4, R-9 | **Resueltos** con `0013` (§12.2) |
| R-5, R-6, R-7 | Sin cambios |
| R-10 | **Resuelto** (§12.1) |
| DS-1, DS-2 | Nuevos, fuera del alcance de R7-4 (§12.4) |

### 12.6 Revisión independiente de invariantes

**Cómo se hizo.** La hizo un agente con contexto nuevo, al que se le entregó el código y no las conclusiones de este informe. Leyó el código, rastreó cada camino y corrió sólo unit `prior-conversation` (7/7) y contract `live-ops-boundaries` (19/19). No modificó nada.

**Resultado.** Sin bloqueantes ni hallazgos mayores. Se mantienen la aislación, sólo tasks anteriores y sin duplicados, la autoridad, la migración y el arnés.

| # | Hallazgo | Severidad | Disposición |
|---|---|---|---|
| IR-1 | El prefiltro `coalesce(e.closed_at, 'infinity') >= since` (`production-store.ts`) puede descartar un binding que todavía tiene un turno dentro de la ventana. Ver el escenario debajo de la tabla | Menor | **Abierto, decisión del owner.** La corrección es quitar el prefiltro, que `0013` ya vuelve innecesario para el costo. Cambia la sentencia validada: integración, las 6 suites que mutan `production-store.ts` y la equivalencia de R-9. Se propone como seguimiento con su validación focalizada |
| IR-2 | Los avisos de plataforma (`origin = 'platform'`, ADR-041) de una task anterior no aparecen como turnos anteriores, aunque el contacto los haya recibido | Menor | Abierto. Seguimiento: agregar la rama `platform` con su entrega |
| IR-3 | `earlierTurnsOmitted` es verdadero cuando hay exactamente `maxTasks` tasks anteriores, aunque no se haya omitido nada | Detalle | Abierto. Se corrige pidiendo `maxTasks + 1` |
| IR-4 | `0013` no usa `if not exists`: un índice homónimo creado a mano la haría fallar | Detalle | Consistente con las demás migraciones. Queda como nota de despliegue: no crear el índice a mano |
| IR-5 | Con `0013`, gateway y worker deben desplegarse con el mismo SHA. Si no, `/ready/r4` responde 503 `no_worker` por compatibilidad distinta | Nota | Ya es la regla de despliegue. Se agrega a las notas del PR |
| IR-6 | Los manejadores de señal del script de mutación no corren durante el bucle síncrono. La restauración depende del `finally` | Menor | **Corregido en el texto** (§12.1). El comportamiento seguro se mantiene: una prueba interrumpida cuenta como SURVIVED |
| IR-7 | La verificación de `dist` no confirma que el build mutado cambie `dist` | Detalle | Sólo puede producir falsos SURVIVED, nunca falsas detecciones. Sin cambio |
| IR-8 | El tope en US$ del arnés puede excederse por una llamada, porque la reserva de US$0,02 puede ser menor que el costo real con thinking. El tope de 60 llamadas es estricto | Detalle | Sin efecto en esta campaña (US$0,107). Anotado |

**Escenario de IR-1.**
1. Una task T1 con una acción incierta queda con intención terminal, sin estar todavía terminal.
2. Entra un mensaje: el binding B1 se cierra en t0 y se abre T2.
3. Un operador responde a mano en T1 en t1.
4. Si t0 < `since` ≤ t1, ese turno se pierde.

Con desfase entre el reloj de la aplicación y el de la base de datos, también puede perderse un turno justo en el borde de la ventana.

### 12.7 PR

**Preparación:** rama actualizada desde `main` (sin cambios: `main` = `52a58f4`), sin conflictos, historial auditado y revisión independiente de los invariantes críticos (§12.6).

**Restricciones:** sin merge y sin cambios en producción. El despliegue requiere una decisión aparte y `db:migrate`.
