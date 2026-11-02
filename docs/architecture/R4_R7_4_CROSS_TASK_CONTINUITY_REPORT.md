---
title: R4-J4-R7-4 — continuidad conversacional entre tasks
status: R4_R7_4_READY_FOR_REVIEW
mandate: «R4 — R7-4 Cross-Task Continuity» (owner), base main@52a58f4
date: 2026-11-02
---

# R4-J4-R7-4: continuidad conversacional entre tasks

## 1. Conclusión

**Antes de este cambio**, cuando una task terminaba, el siguiente mensaje del cliente abría una task nueva que no veía nada de la conversación anterior: ni el producto que se mencionó ni la respuesta que se dio. Dentro de una misma task, en cambio, la continuidad ya funcionaba. Ambas cosas se verificaron con una sonda (§2.1).

**Con este cambio**, la task nueva recibe lo que se dijo en las tasks anteriores de la **misma** conversación. Ese texto entra como conversación y nunca como evidencia, con su estado de entrega real, dentro del presupuesto de contexto y sin re-ejecutar nada.

- **Infraestructura.** No se crea memoria paralela: se reutilizan los bindings de canal y el hilo del operador (`ProductionStore.thread`).
- **Cambios evitados.** No cambian los contratos de Core, el kernel, el compilador de contexto, las migraciones ni las definiciones o perfiles de Sales.
- **Implementación.** Commits `32e8173` y `beddf58`, con un método de puerto aditivo, una fuente de contexto en live-ops y su registro en la composición productiva de Sales.

**Pruebas:** unit 6/6, integración 7/7 (un escenario por criterio de aceptación) y una suite de mutación nueva con 7/7 detectadas. L1 sobre `beddf58` queda en verde, con los timeouts bajo carga repetidos y registrados (§6). **Pendiente**, como `NOT_RUN`: seis suites de mutación existentes, la cadena L2 y la validación con modelo real. **R7-4 no queda aprobado con L1**: el PR debe pasar su gate L2.

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

**Linaje sin estructura nueva.** Las tasks anteriores de una conversación son las de los bindings anteriores con el mismo `(channel, conversation_key)`. La consulta es `ProductionStore.earlierConversationTasks(taskId, limit)`.
- Es determinista: un binding cerrado es inmutable y `created_at` ordena los bindings.
- No requiere tocar `ingress`, el factory, la creación de tasks ni `parentTaskId`.

**Transcript sin memoria paralela.** Para cada task anterior se usa `thread(taskId)`, la vista del hilo que ya usan el operador y Quote. Incluye las entradas del cliente, las respuestas del agente con su estado de entrega y los mensajes del operador.

**`PriorConversationContextSource`** (live-ops, registrada vía `WorkerBindings.contextSources`) emite:
- **turnos `prior_turn:<id>`**: `conversation_turn` de autoridad `CONVERSATIONAL`, con el `taskId` de la task actual (el alcance) y la procedencia del registro original. Llevan `earlierTask: true` y, en las salidas, la verdad de entrega: «received», «sent», «NOT sent», «not sent»;
- **un episodio `prior_conversation:<task>`**: `OBSERVED`, `required`. Dice que es conversación anterior, que nada de eso es evidencia actual, que se debe releer con capacidades lo que importe y que no se repita lo ya recibido.

Límites: como máximo 20 turnos de como máximo 10 tasks, conservando los más recientes, y deja de leer tasks una vez que tiene suficientes. Si faltan turnos, el episodio lo indica.

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
| `ProductionStore` (`@r4/live-ops`) | `+earlierConversationTasks(taskId, limit)` | Aditivo. Única implementación: `PostgresProductionStore` |
| `@r4/live-ops` (exportaciones) | `+PriorConversationContextSource`, `+PRIOR_CONVERSATION_SOURCE_ID` | Aditivo |
| Composición productiva de Sales | Registra la fuente | **Cambia lo que ve el modelo en producción** al desplegar (§7) |
| `@r4/contracts`, kernel, compilador, Task Runtime | Ninguno | — |
| Migraciones, definiciones y perfiles de Sales, protocolo v5 | Ninguno | — |
| Quote, Checkout, Shipping | Ninguno | — |

## 5. Implementación

| Archivo | Cambio |
|---|---|
| `packages/live-ops/src/ports.ts` | Método de puerto |
| `packages/persistence-postgres/src/production-store.ts` | Consulta de las tasks de bindings anteriores. Recorre los bindings, porque no hay índice por `(channel, conversation_key)` para los cerrados (§8, R-4) |
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
| Un reinicio no destruye la continuidad | R74-5: otro worker compila los mismos turnos | PASS |
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
| R-2 | **Sin límite de antigüedad.** Una conversación de hace meses entra igual (hasta 20 turnos) | Decisión del owner: ¿agregar una edad máxima? |
| R-3 | Las instrucciones de Sales no mencionan la conversación anterior. El encuadre está sólo en el episodio | Sin definición nueva (v10 requiere autorización). Revisarlo junto con R-1 |
| R-4 | La consulta recorre los bindings cerrados, porque no hay índice por conversación | Aceptable con el volumen actual (`ponytail:` en el código). Si crece, un índice requiere una migración |
| R-5 | La continuidad depende de `conversation_key`, que es un hash con la clave de identidad. Rotar esa clave corta la continuidad | Documentado. No se rota hoy |
| R-6 | Las entradas anteriores usan la hora de recepción del servidor y las actuales la hora del proveedor. Con desfase de reloj, el orden relativo puede variar algunos segundos | Es la misma mezcla que ya existe dentro de una task |
| R-7 | Fuera de alcance: `disposition` veraz (C-5) y la revisión de `maxWriteActions` (D-7) | Registradas para R7-3 o R7-4b |
| R-8 | **El costo crece con el historial.** La fuente llama a `thread()` por cada task anterior, con 5 consultas cada vez: hasta 51 consultas por llamada al modelo con 10 tasks (unos 80 ms con 7, medido bajo carga). Es pequeño frente a la latencia del modelo, pero se paga en cada iteración | Propuesta: una sola consulta que devuelva los turnos de las tasks anteriores, con costo constante. Requiere repetir L1 focalizado. Decisión del owner antes de L2 |

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
