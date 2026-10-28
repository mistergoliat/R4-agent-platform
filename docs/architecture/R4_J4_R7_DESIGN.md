---
title: R4-J4-R7 — Diseño de confiabilidad y recuperación conversacional
status: R4_J4_R7_G0_REVIEW_READY (no autoriza implementación; detenerse antes de R7-1)
mandate: R4-J4-R7-DESIGN-01 (2026-10-28) y R4-J4-R7-DESIGN-02 «Owner Architecture Decisions — Steering & Semantic Interpretation» (2026-10-28)
date: 2026-10-28
base: main d0bb7a7
depends-on: R4_J4_R7_EXECUTION_AUDIT.md (B1–B12, X1–X5, L-1..L-13, §10 steering), R4_J4_R7_TEST_PLAN.md
---

# R4-J4-R7 — Diseño

```text
DIRECTION            ARCHITECTURE_DIRECTION_APPROVED (DESIGN-02): el modelo interpreta, el runtime garantiza estructura
MECHANISMS           Turn Completion Guard · cierre explícito por reconsideración · Durable Steering (nivel 1) ·
                     Runtime Recovery (ADR-028 + contingencia) · Durable Conversation Continuity
SEMANTIC_GUARANTEE   ninguna determinista: el cierre sin respuesta es explícito, informado y registrado, no "correcto"
KERNEL               sin cambio de puerto (KernelSession) ni de protocolo (r4.agent_decision.v5);
                     2 cambios de código no contractuales propuestos (KC-0, KC-2), no implementados
MIGRATIONS           0 propias; reutiliza la 0012 de ADR-041 (PR #27) con `human_request_id` (D-8, pendiente de verificar)
NEW_PROCESSES        ninguno: sin supervisor, sin verificador LLM, sin segunda cola, sin segundo outbox
J5-A                 steering interactivo (nivel 2) no implementado; compatibilidad en §3.6; un bloqueo de v5 (§3.7)
```

## 0. Cambios respecto de la versión anterior (DESIGN-01 → DESIGN-02)

| # | Cambio | Origen |
|---|---|---|
| 1 | **Se retira la política SC como autoridad de cierre.** SC-4 (signos de pregunta) se elimina. SC-2 (conversación atendida) y SC-3 (entradas trailing) dejan de decidir y pasan a ser **metadatos de auditoría** del evento de cierre | AD-01, AD-05, D-1 |
| 2 | **El cierre explícito por reconsideración** reemplaza a SC: el primer cierre sin respuesta sobre una frontera se rechaza o difiere con un episodio concreto; un segundo cierre sobre la **misma** frontera se acepta y queda registrado | AD-02, AD-05 |
| 3 | El segundo `complete` sobre la misma frontera ya **no** va a contingencia (`turn_obligation_unresolved` se retira): se acepta como cierre explícito | AD-01 |
| 4 | **Durable Steering (nivel 1)** formalizado: fronteras seguras F1–F10, ledger de entradas incorporadas y serialización | AD-03 |
| 5 | Instrucciones Sales v9 (borrador) | AD-04 |
| 6 | INV-01 se separa en invariantes de **Safety**, **Liveness** y **Delivery**. "running", "pending" o "request abierto" dejan de bastar: hace falta un testigo de progreso con cota | AD-08 |
| 7 | **D-4 invertida:** un aviso `platform` es informativo y **no** invalida ofertas; sólo los cambios comerciales (mensajes del cliente) lo hacen, a través del contrato J3 | AD-07, D-4 |
| 8 | Valores de D-1..D-8 fijados por el owner (§15) | §4 del mandato |
| 9 | Contraste con el manual tahan-tech (capítulos 7, 9 y 14 leídos) | §3 del mandato |

## 1. Principio

> **El modelo decide qué significa un mensaje y si merece respuesta. El runtime decide si una transición es
> estructuralmente admisible.** Toda transición que saca a una task de `running` se evalúa en la misma transacción y
> bajo el mismo lock de fila que la aplica (`agent_tasks … for update`, `execution-store.ts:103`,
> `task-store.ts:83`; `submitInput` toma el mismo lock). Hay tres resultados posibles: la transición procede; se
> rechaza o difiere para que el modelo **reconsidere** con un hecho concreto delante; o se convierte en una
> **contingencia determinista** (handoff de plataforma no terminal y aviso fijo del pack).

**Lo que el runtime no hace:** clasificar mensajes por palabras clave, expresiones regulares o signos de puntuación.
Tampoco usa un segundo modelo para verificar, ni corre un proceso supervisor (AD-01, AD-06, AD-08).

## 2. Obligación conversacional (definición derivada, sin cambios de esquema)

Sobre una task `T` y un horizonte `H` (el `ContextSnapshot` de la llamada que produjo la decisión, o el último
snapshot de la run si la termina la plataforma):

| Término | Definición (SQL sobre tablas existentes; consultas en el anexo A) |
|---|---|
| Entrada conversacional | fila de `task_inputs` con `actor_kind = 'user'`. Las de plataforma (el marcador de identidad, `actor.kind = 'system'`, `adapters/domains/identity/verification/src/dispatcher.ts:42`) no generan obligación |
| `seen(i, s)` | `∃ context_snapshot_items(snapshot_id = s, item_id = 'memory:' ∥ i.memory_entry_id)`. Es la misma regla que `hasUnseenInput` (`temporal-store.ts:191-199`) |
| Frontera `L(T)` | última entrada conversacional, por `(received_at, input_id)` |
| `covered(i)` | `∃` step `respond recorded` de `T` con `seen(i, step.context_snapshot_id)` cuyo outbound **aún no existe** o no está `failed` ni `cancelled` (salvo `duplicate_content`); **o** `∃` evento `turn.closed_without_reply` con `entity_id = i.input_id`. Un aviso `platform` **no** cubre (el mismo criterio que `enviarDirecto` en tahan-tech 9.10) |
| **UNSEEN(T,H)** | `∃` entrada conversacional `i` con `¬seen(i, H)` |
| **UNANSWERED(T)** | `L(T)` existe y `¬covered(L(T))` |
| **Obligación** | `UNSEEN` si aplica; si no, `UNANSWERED`; si no, `NONE` |

Implementación: `TemporalPersistence.turnObligation(taskId, horizonSnapshotId)` (puerto de task-runtime) y su SQL en
`persistence-postgres`. No es kernel.

---

## 3. Steering & Semantic Interpretation — Architecture Decision

### 3.1 División de autoridad (AD-01, AD-07)

| Cuestión | Decide | Verifica el runtime | Nota |
|---|---|---|---|
| Qué significa un mensaje (solicitud, modificación, pregunta, agradecimiento, despedida, confirmación contextual, ambigüedad, intención de continuar o terminar) | **Modelo** | — | AD-01. Sin clasificadores deterministas |
| Si un mensaje merece respuesta | **Modelo** | Que la decisión sea **explícita** (reconsideración) y quede **registrada** | AD-02, AD-05 |
| Si hay entradas que el modelo no vio | **Runtime** | Sí (`context_snapshot_items`) | El modelo no puede saltarlo |
| Si la transición es admisible (ciclo de vida, requests humanos abiertos, efectos inciertos, intención terminal) | **Runtime** | Sí | §4 |
| Si un efecto comercial se autoriza | **Policy Engine**, aprobaciones humanas y contratos de dominio (Quote, Checkout, J3) | Sí | El modelo sólo propone (ADR-016/017) |
| Precios, productos, servicios, despacho, vigencia | **Quote** | — | AD-07 |
| Responsabilidades de Checkout | **Checkout** (ADR-0002 del servicio) | — | AD-07; R7 no las toca |
| Entrega del mensaje | **Dueño de la entrega** | Sí | Outbox existente |

**Nota interpretativa para confirmación del owner.** La gramática cerrada de confirmación J3
(`r4-sales-confirmation-es-v1`, `agents/sales/src/capabilities/quote-v4.ts:185-215`) es determinista, pero no es una
autoridad semántica sobre la conversación. Es una **compuerta comercial fail-closed** del contrato J3 (ADR-035): sólo
puede negar un efecto; nunca cierra una conversación ni decide si hace falta respuesta. Se mantiene por AD-07 y por
la última línea de AD-01. Cuando la compuerta rechaza «Ya, dale», el modelo pide una confirmación explícita (AD-04
puntos 4 y 5).

### 3.2 Durable Steering — nivel 1 (J4-R7)

Definición operativa: **toda entrada se persiste antes de cualquier efecto. Las que llegan durante una ejecución se
identifican de forma derivable y se incorporan en la siguiente frontera segura. Ninguna transición puede dejarlas
huérfanas, y la conversación se serializa por task.**

| F | Frontera segura | Hoy (`d0bb7a7`) | R7 nivel 1 | Evidencia |
|---|---|---|---|---|
| F1 | Antes de cada llamada al modelo, en la misma run | Recompila e incorpora todo lo no visto | Sin cambio | [C `kernel.ts:142`][T `temporal-waits.test.ts:169`] |
| F2 | Cierre de turno tras `respond` | Horizonte ⇒ wake; el borrador queda `superseded_by_newer_input` | Sin cambio | [V P13] |
| F3 | `wait` del agente | Horizonte ⇒ wake | + reconsideración si UNANSWERED | [V P12, P05] |
| F4 | `complete` | **Sin control:** entrada huérfana | UNSEEN ⇒ diferir; UNANSWERED ⇒ reconsideración | [V P02] |
| F5 | Finales de plataforma (presupuesto, fallas) | Task `failed`: entrada huérfana | No terminal: la entrada queda en una task viva, con aviso | [V P03][I] |
| F6 | Suspensiones humanas (consulta, handoff, aprobación) | Registrada sin wake y sin aviso | Registrada; aviso N una vez; TTL ⇒ wake | [V P06, P10] |
| F7 | Resolución de una aprobación | La acción aprobada se ejecuta **antes** de que el modelo vea las entradas posteriores a la solicitud | **Sin invalidación automática** (la autoridad es humana, AD-07). La vista del operador marca las entradas posteriores a la solicitud (derivado) | [C `apps/worker/src/session.ts:110`, `kernel.ts:127-131`] |
| F8 | Llamada al modelo en vuelo | No se interrumpe | Sin cambio (lo evalúa J5-A) | [C] |
| F9 | Escritura en vuelo | Nunca se interrumpe | Nunca, en ningún nivel | [C ADR-016/018] |
| F10 | Antes de autorizar una escritura consecuente | Core no lo verifica; el dominio J3 exige que la última entrada del cliente sea una confirmación explícita posterior a la oferta | Sin cambio en Core (lo evalúa J5-A) | [C `quote-v4.ts:192-206`] |

**Serialización por conversación** (existente): lock de fila de la task, a lo sumo una run activa, una espera activa
(BD), deduplicación del inbound por id de proveedor y entrada idempotente por `(task, source, externalKey)` [C][T].

**Ledger de steering** (derivado, anexo A): para cada run, las entradas recibidas entre `startedAt` y `finishedAt`
que no estaban en su primer snapshot ("entradas incorporadas por steering"), y en qué snapshot entraron. Es el
equivalente durable del `en-turno → hecha` de tahan-tech (7.4, 9.8), sin tabla nueva.

### 3.3 Cierre semántico explícito (AD-05)

**Pregunta del owner:** ¿se puede expresar una decisión semántica de cierre sin protocolo v6?

| Opción | Mecanismo | ¿Qué verifica? | ¿v5? | Veredicto |
|---|---|---|---|---|
| O1 | Decisión existente sin más (`wait` o `complete` = cierre) | Registro del step | Sí | **Insuficiente:** no distingue un cierre deliberado de uno accidental (B1) |
| **O2** | **Reconsideración:** el primer cierre con UNANSWERED se rechaza (`wait`) o difiere (`complete`) y genera un evento `turn.closure.reconsider` más un episodio que nombra la entrada pendiente. Un segundo cierre sobre la **misma frontera** se acepta y se registra `turn.closed_without_reply`, con referencia a ambos steps | Que el cierre fue **explícito** (dos decisiones), **informado** (el episodio estaba en el snapshot de la segunda) y **auditable** (eventos y steps durables) | Sí | **Elegida** |
| O3 | Centinela en texto libre (`wait.reason` o `result.summary` con «SIN NOVEDAD», como tahan-tech 9.8) | Parseo de prosa del modelo | Sí | Rechazada como autoridad: es una heurística sintáctica (AD-05). El texto se conserva en el step como evidencia |
| O4 | Clave reservada en `complete.result.data` | Convención sobre un objeto libre | Formalmente sí | Rechazada: es un cambio de protocolo encubierto |
| O5 | Campo tipado de cierre en `wait` y `complete` (protocolo v6) | Declaración explícita en un solo paso | No | **Opción futura.** Ahorra la llamada de reconsideración; tampoco verifica la corrección |
| O6 | Juez LLM post-hoc (evaluación, ADR-025) | Estadística, offline | n/a | Sólo medición; nunca autoridad de runtime (AD-06) |

**Limitación documentada (no se inventa una garantía).** Ni v5 ni v6 permiten distinguir de forma **verificable** un
cierre social de una solicitud comercial. Esa distinción es semántica y AD-01 la asigna al modelo. R7 garantiza que
todo silencio frente a una entrada pendiente es:
1. explícito: dos decisiones sobre la misma frontera;
2. informado: el modelo vio el episodio con la entrada concreta;
3. estructuralmente admisible: nada sin ver, sin requests humanos abiertos ni efectos inciertos;
4. durable y auditable.

**No** garantiza que el silencio sea correcto. Ese residuo (B1 persistente) se mide con la suite semántica con
proveedor real (plan de pruebas §4) y con la evaluación post-hoc. Es el mismo compromiso de tahan-tech: un aviso y
luego se acepta el segundo silencio (9.8), pero aquí es transaccional y durable.

**Costo de O2:** una llamada al modelo adicional por cierre silencioso legítimo, y una run nueva cuando el cierre
fue `complete`. Si el canary muestra que el costo importa, O5 es la evolución natural (decisión futura, no R7).

### 3.4 Instrucciones del agente Sales (AD-04) — borrador para la definición v9

Reemplaza la línea de v8 «Complete the task (complete, in a turn without a reply) only when the conversation has
clearly ended» (`agents/sales/sales.v8.agent.json:7`). Va en inglés, como el resto de las instrucciones del pack. No
habilita nada que eluda Policy Engine, aprobaciones ni contratos de dominio.

```text
Conversation handling
1. Read every customer message against the conversation state: the workspace, your last offer, open requests
   and what you already said. A short message ("ok", "perfecto", "ya, dale") means different things in
   different states.
2. If a message asks for something, changes something or leaves a commercial request open, handle it (read,
   update the workspace, propose) and reply before your turn ends. Never complete the task while a customer
   request is unattended.
3. A purely social message (thanks, goodbye, an acknowledgement of your last reply) may need no reply. In that
   case wait for input without replying. The platform may ask you once to reconsider a specific message: reply
   if it needs anything; repeat your decision only if no reply is really needed. Use complete only when nothing
   is left to answer or do.
4. Agreement words are not, by themselves, an authorization of a quote, order or payment. The platform verifies
   every confirmation against the offer it refers to; if it does not accept one, ask the customer to confirm
   the specific offer explicitly.
5. If an ambiguity changes what would be quoted, ordered or charged (product, quantity, weight, destination,
   price, shipping), ask one short clarifying question before acting.
6. New messages can arrive while you work. Before each decision consider every message in the context, not
   only the first; one reply may answer several. If a newer message changes the request, follow the newest.
7. An action whose observation shows it succeeded (a receipt) must not be proposed again: refer to its result.
   If an outcome is unknown, say it is being verified; never retry it yourself.
8. Never state that a quote, order, payment, shipment or verification happened unless an observation backed by
   a receipt shows it.
9. Quote, Checkout and approvals decide prices, availability, shipping, validity and authorization. When they
   refuse, explain it and offer the next step; never work around them.
10. If the platform reports that your turn or your completion was not applied because a message has no reply,
    reread the pending messages and reply, or confirm that no reply is needed.
Messages marked as platform notices were sent by the platform, not by you; do not repeat them.
```

Correspondencia con AD-04: puntos 1→1, 2→2, 3→3, 4→4, 5→5, 6→6, 7→7, 8→8, 9→9, 10→10. Cómo cumple el modelo estas
instrucciones sólo lo demuestra la suite semántica con proveedor real, no el runtime con modelo guionado.

### 3.5 Contraste con tahan-tech

Fuente: manual Ed. 1, secciones 7.4, 7.6, 7.7, 7.11, 9.8–9.10 y 14.5–14.6, leídas para este mandato [M]. El
capítulo 8 sólo se consultó a través del resumen de 7.7.

| tahan-tech | Qué hace | R7 | Motivo |
|---|---|---|---|
| Guardia del turno mudo con **un** aviso, más `SIN NOVEDAD` (9.8, D2) | Después del turno, un aviso **no durable** a la sesión; el segundo silencio se acepta | **Concepto adoptado** (O2: una reconsideración; el segundo cierre se acepta), implementado **en la transición y de forma durable** (eventos) | En R4 la guardia no puede correr después, ni perderse en un reinicio (7.4: "un reinicio los pierde") |
| `SIN NOVEDAD` como marca en el texto | Centinela | Rechazado como autoridad (O3) | AD-05 |
| Steering al turno vivo, "nunca se mata un turno" (7.7) | Inyecta el mensaje en la frontera de herramienta del turno en curso | Nivel 1: frontera F1 (la siguiente llamada al modelo de la misma run). Nunca se interrumpen escrituras (F9). La inyección en la llamada en vuelo queda para J5-A | Mismo principio de no matar; v5 |
| `ruteada → en-turno → hecha` en la tx de cierre (7.4, 9.8) | Ledger durable de consumo | Derivado de `context_snapshot_items` (§3.2) | Sin migración |
| Reentrega única con `NOTA_REENTREGA`; `incierta-tras-reinicio` cerrada en silencio (7.11) | Un reintento y luego silencio aceptado | R4 reanuda **la misma** run (sin reentrega) y no acepta el cierre silencioso: contingencia | Aquí R4 ya es más fuerte; se conserva |
| Aviso de salida fallida al agente, con freno (9.9) | Re-prompt | Atención del operador, sin re-wake (C-6) | Riesgo de bucle; ventana de WhatsApp |
| Mensajes del núcleo sin modelo (9.10) | No cuentan para la guardia | Los avisos `platform` no cuentan como `covered` | Mismo criterio |
| Base del prompt: «solo lo que envías llega… la persona queda esperando» (14.6) | Instrucción | Incorporado en §3.4 (puntos 2, 3, 10) | — |

### 3.6 Matriz de compatibilidad con J5-A (steering interactivo, nivel 2; **no se implementa**)

| Capacidad J5-A | Qué requiere | Elemento R7 que la preserva | ¿Evolución contractual? |
|---|---|---|---|
| Incorporar un mensaje durante la llamada al modelo en vuelo | Abortar y recompilar (nuevo `attempt` del snapshot de la iteración) | Los snapshots ya versionan intentos (`execution-runtime.ts:536-557`); el guard actúa sólo en transiciones | No necesariamente: `KernelInterrupt` y el reintento del snapshot existen. Política de costo nueva |
| Continuar ejecutando después de responder (acuse y luego trabajo, varios mensajes por turno) | Que `respond` no termine el turno | `covered` se define por entrada y por `respond`, no por run | **Sí: bloqueo de v5 (§3.7)** |
| Adaptar objetivos y herramientas a mitad del turno | `manage_goal` y visibilidad de capacidades por iteración | Existentes (F1); KC-0 hace la visibilidad más precisa | No |
| Continuar la misma run tras un `complete` diferido | `KernelSession.finish` → `continued` (KC-1) | El diferimiento deja `termination.details.turnGuard`; cambiar a KC-1 no exige migrar datos | Sí, versión del puerto (D-5: no ahora) |
| Steering antes de autorizar una escritura consecuente (F10) | Refusal `context_advanced` en `ActionRuntime.authorizeAction` | El ledger de steering da el horizonte de la propuesta | No (task-runtime); exige un ADR |
| Aprobación marcada como desactualizada por entradas posteriores (F7) | Vista o marca durable | Derivado en R7 (sólo informativo) | No |
| Ledger por entrada (consumida / respondida / cerrada) | Relación entrada ↔ snapshot | Derivado (anexo A) | No |
| Acuse automático de plataforma durante trabajo largo | Avisos `platform` | Mecanismo ADR-041 generalizado (§5.2) | No (catálogo del pack) |
| Ráfagas y coalescencia | Incorporar varias entradas juntas | F1 incorpora todas las no vistas en la siguiente llamada | No |

### 3.7 Bloqueos con el protocolo v5

| Dirección aprobada | ¿Ejecutable en v5? | Bloqueo |
|---|---|---|
| Nivel 1 completo (AD-03) | **Sí** | — |
| Interpretación semántica por el modelo (AD-01) | **Sí** | — |
| Cierre explícito y auditable (AD-02, AD-05) | **Sí**, con O2 (una llamada extra) | En un solo paso requiere v6 (O5): opcional |
| Distinguir de forma verificable un cierre social de una solicitud | **No**, ni en v5 ni en v6 | Límite semántico, no de protocolo (§3.3) |
| Nivel 2: varios mensajes por turno o continuar tras `respond` | **No** | `respond` termina el turno (`kernel.ts:221-226, 245-257`; `request.ts:28`). Requiere un protocolo v6 o una variante "respond y continuar". J5-A |

---

## 4. Turn Completion Guard (AD-02)

### 4.1 Precondiciones estructurales de cualquier cierre

Un `complete`, o un `wait` del agente sin respuesta frente a una entrada pendiente:

| P | Comprobación | Si falla |
|---|---|---|
| P-1 | `¬UNSEEN(T,H)` | Diferir (`complete`) o despertar (`wait`, ya existente). El modelo nunca puede saltarlo |
| P-2 | Ningún `human_request` abierto (consulta, aprobación o handoff) | Contingencia `turn_closure_blocked` [I: hoy no es alcanzable, porque la task no corre con un request abierto] |
| P-3 | Ningún efecto incierto ni intención terminal | Contingencia (`mutations.ts:77-82` sólo protege `cancelled`/`failed`, no `completed`) [C][I: hoy no es alcanzable porque el claim excluye esas tasks] |
| P-4 | Transición permitida por el ciclo de vida | Error de plataforma (existente) |

### 4.2 Matriz

"Rechazar" = step `refused`; la run continúa (patrón `manage_goal`, `temporal-runtime.ts:243-254`). "Diferir" = la
run termina tal como decidió el modelo, pero la task **no** sigue la transición: queda `running` sin run activa y el
siguiente claim inicia una run nueva (patrón ADR-028).

| Transición | NONE | UNSEEN | UNANSWERED, 1.ª vez sobre la frontera `L` | UNANSWERED, con `turn.closure.reconsider(L)` previo |
|---|---|---|---|---|
| `respond` y cierre de turno | Sin cambio | Sin cambio (wake existente) | n/a | n/a |
| **`complete`** | `completed` | Diferir `turn_input_unseen` | Diferir `turn_reply_pending` + evento `reconsider(L)` | `completed` + `turn.closed_without_reply(L)` |
| **`wait` del agente** | Sin cambio | Sin cambio (wake existente) | Rechazar `turn_reply_pending` + evento `reconsider(L)` | Espera + `turn.closed_without_reply(L)` |
| `request_consultation` | + TTL (D-2) | + TTL | + TTL + aviso N | + TTL + aviso N |
| `request_handoff` (agente) | Sin cambio | — | + aviso N | + aviso N |
| `approval_required` | + TTL | + TTL | + TTL + aviso N | + TTL + aviso N |
| Finales de plataforma | Contingencia (§5.1) | Ídem | Ídem + aviso N | Ídem + aviso N |

**Cotas.** Una reconsideración por frontera (el evento se identifica por `entity_id = L.input_id`). Un diferimiento
por UNSEEN sólo se repite si llega otra entrada, y eso es progreso del cliente. Todo esto queda dentro de los
presupuestos de la run, que son el techo duro y llevan a contingencia, no a `failed`.

**Registro durable** (`temporal_events`, tipo libre, sin migración):
- `turn.closure.reconsider`: `{ entity: L.input_id, decision, stepId }`.
- `turn.closed_without_reply`: `{ entity: L.input_id, decision, stepIds: [primero, segundo], reconsiderEventId,
  hadPriorReply, trailingCount, policy: 'closure.v1' }`.

Son sólo metadatos: ningún texto del modelo se copia (el `reason` de `wait` ya vive en el step). En la run diferida,
`termination.details.turnGuard = { outcome: 'deferred', code, inputId }`.

**Visibilidad para el modelo.** `interactionRecords` (`temporal-store.ts:240`) incluye `complete`.
`interactionSource` (`context-compiler/src/sources/platform.ts:149-236`) proyecta un episodio OBSERVED
`turn.closure.reconsider` `{ inputId, code, decision }`, con texto de plataforma fijo, igual que `goal_rejection`
(`:171-183`). No es una "pista de reparación" en el sentido de ADR-028: la decisión era válida y la plataforma pide
reconsiderarla por política.

**Modo observe.** `R4_TURN_GUARD=observe` registra `turn.closure.would_*` sin aplicar: es el primer gate de canary y
también el rollback.

## 5. Runtime Recovery (AD-06)

### 5.1 Disposiciones (enmienda ADR-028, `contracts/src/run.ts:189-199`) — sin cambio respecto de DESIGN-01, salvo la fila retirada

| Terminación | Hoy | Propuesta |
|---|---|---|
| `invalid_decision` (`finishReason` stop / other / length) | recoverable | Sin cambio (1 run nueva) |
| `invalid_decision` con `content_filter` | recoverable | **human** |
| `model_failure` reintentable / no reintentable | recoverable / human | Sin cambio |
| `budget_exhausted` (todas las dimensiones) | terminal | **human** `run_budget_exhausted` (D-6) |
| `capability_failure` | terminal | **human** `run_capability_failure` |
| `internal_failure` | terminal | **human** `run_internal_failure` |
| `lease_lost` (abandono en `claimNext`) | task failed | **human** `run_abandoned`, en la tx del claim |
| Precondición P-2 o P-3 violada | — | **human** `turn_closure_blocked` |

"human" = `handOffAfterRunFailureWithin` (`temporal-runtime.ts:855-874`). Fallback sin runtime temporal: el
comportamiento actual, sin bucle (`execution-runtime.ts:639-641`, `kernel.ts:336-339`). Ninguna run termina en
`failed`.

### 5.2 Contingencia determinista: avisos de plataforma (ADR-041 generalizado; D-3)

- **Mecanismo:** un outbound de origen `platform`, materializado por el dueño de la entrega desde el estado durable
  del `human_request`. Único por request (`human_request_id`, D-8). Gate `decidePlatformDispatch`. Texto fijo del pack
  por `(kind, reason)`, sin afirmar efectos comerciales.
- **Tipos:** consultas, aprobaciones, handoffs iniciados por el agente o por la plataforma.
- **Exclusiones:** el takeover del operador (habla un humano) y los holds de autonomía (kill switch, deny, rollout,
  contenido no soportado).
- **Condición:** `UNANSWERED(T)` al materializar.
- **Restricciones del canal:** el gate existente aplica la ventana de servicio. Fuera de ella el aviso se cancela
  `window_closed` y queda en atención (C-6). Las plantillas fuera de ventana no son parte de R7.
- **Carácter informativo (D-4, AD-07):** el aviso no cambia estado comercial ni invalida ofertas. Hoy
  `locateConfirmation` ya considera sólo entradas `agent`/`operator` (`quote-v4.ts:198, 205`): **comportamiento
  conforme a D-4 sin cambios**. Lo fija una prueba.
- **PR #27:** abierto, head `93fe35a` (sobre `387b720`), sin revisión, `mergeable: UNKNOWN`, actualizado el
  2026-10-26 (consulta de sólo lectura, 2026-10-28). El renombre a `human_request_id` (D-8) se hace sólo después de
  verificar ese PR; este mandato no lo modifica.

### 5.3 Fallas inducidas por valores del modelo (X1), TTL (D-2), `finish_reason` (X2), escrituras agotadas (B4)

- `TemporalRuntime.decide`: los `PlatformError('validation')` que dependen de valores del modelo (`expiry_in_past`,
  `unknown_evidence`) pasan a ser un step `refused` y la run continúa (INV-S5).
- TTL por defecto: consulta **30 min**, aprobación **60 min** (D-2). Reutilizan `human_expiry` y `fireSchedule`
  (`temporal-runtime.ts:766-773`). Son configuración explícita del operador
  (`R4_TEMPORAL_DEFAULT_CONSULTATION_TTL_MS`, `R4_TEMPORAL_DEFAULT_APPROVAL_TTL_MS`). Sin backfill: las aprobaciones
  existentes con `expiresAt: null` las señala el verificador de liveness.
- **KC-2** (kernel, no contractual, **propuesto**): `finishReason` en `termination.details` de `invalid_decision`.
- **KC-0** (kernel, no contractual, **propuesto**): `visibleCapabilities` usa las escrituras **restantes**
  (`agent-kernel/src/context.ts:148-150`). D-7: `maxWriteActions` sigue siendo de alcance task y se revisa antes de
  R7-4.

| Clase | Recuperación | Presupuesto |
|---|---|---|
| Abort / cancelación | Misma run, mismo snapshot (existente) | `maxRunRecoveries` |
| Transporte, timeout, 429, 5xx | Run nueva (existente); reintento en el mismo step diferido | `maxRunFailureRecoveries` |
| `length` | Run nueva una vez; nunca en el mismo step | ídem |
| `content_filter` | Contingencia | — |
| JSON inválido (`stop`) | Run nueva una vez y luego contingencia | ídem |
| Presupuesto agotado | Contingencia (D-6); la run de solo-respuesta queda en R7-5 | — |

## 6. Durable Conversation Continuity

| Mecanismo | Resuelve | Estructura nueva |
|---|---|---|
| **C-1** Las fallas dejan la task viva (§5.1) | B4–B6, B8: el siguiente mensaje cae en la misma task | Ninguna |
| **C-2** Sin huérfanas (P-1 y §5.1). Una entrada que llega después del commit de un cierre legítimo encuentra la task terminal, y el reintento de ingress (`ingress.ts:253-258`) abre una task nueva **con** esa entrada | B9 | Ninguna |
| **C-3** Linaje: ingress pasa la task anterior al factory (`parentTaskId`, columna existente). `PredecessorConversationSource` (live-ops, registrada vía `WorkerBindings.contextSources`) proyecta las últimas N intervenciones del predecesor y su resumen como HISTORY CONVERSATIONAL, **nunca** observaciones citables | B1, B2, P11 al volver | Ninguna (`R4_CONTEXT_PREDECESSOR_TURNS`, propuesta 10) |
| **C-4** Ledger de consumo y de steering (anexo A) | Auditoría, hilo del operador, evaluación | Ninguna |
| **C-5** `disposition` veraz (`queued_for_human`, …) | X3 | Ninguna |
| **C-6** Entregas descartadas (`expired`, `window_closed`) en `attention()`, sin re-wake | B12 | Ninguna |

## 7. Invariantes definitivos (AD-08)

Todas se verifican desde el estado durable, sin el modelo. Los verificadores son **consultas de sólo lectura** (en
pruebas, el endpoint de atención y el cierre del canary), **no** un proceso que actúe.

### 7.1 Safety — ninguna entrada desaparece ni se cierra incorrectamente

| ID | Invariante |
|---|---|
| **INV-S1** Durabilidad | Todo inbound de texto autenticado da exactamente una `task_input` (deduplicada), o queda `failed`/`rejected` visible en atención |
| **INV-S2** Sin huérfanas | Ninguna task terminal tiene una entrada conversacional ausente del snapshot de la decisión que la cerró |
| **INV-S3** Cierre admisible | Una task llega a `completed` sólo con `Obligación = NONE` o con un `turn.closed_without_reply(L)` válido. Ninguna terminación de run produce `failed`; `failed`/`cancelled` sólo por actos humanos o de administración |
| **INV-S4** Cierre explícito | Todo `turn.closed_without_reply(L)` referencia un `turn.closure.reconsider(L)` previo y dos steps de decisión; en ambos, P-1..P-3 se cumplían |
| **INV-S5** Autoridad preservada | Guard, steering e interpretación nunca crean, alteran ni re-ejecutan escrituras comerciales (misma propuesta ⇒ misma clave); un `human_request` abierto sólo cambia por respuesta humana, vencimiento programado o cancelación de la task; ningún valor del modelo produce una transición terminal; un aviso `platform` no invalida ofertas |

### 7.2 Liveness — existe una vía durable y verificable de progreso, recuperación o intervención

| ID | Invariante |
|---|---|
| **INV-L1** Testigo con cota | Toda entrada conversacional que no está `covered` ni cerrada explícitamente tiene al menos un testigo **con cota verificable**: (a) una run activa con lease vigente (cota: lease + `maxRunDurationMs`); (b) una task reclamable sin run, sin reconciliación ni `action_retry` pendientes (cota: umbral de antigüedad de claim, alerta); (c) un schedule pendiente con `dueAt` (`wake`, `human_expiry`, `action_retry`, reconciliación con plazo de política); (d) un `human_request` abierto con `expiresAt`; (e) para handoffs (sin vencimiento) o entregas descartadas: presencia en `attention()` **y** aviso N materializado o no requerido (cota: SLA operativo, alerta). **No basta** con `running`, `pending`, `waiting` ni con un request abierto sin cota |
| **INV-L2** Toda espera se resuelve | INPUT: el cliente. UNTIL: schedule. HUMAN: request con TTL, o handoff en atención. APPROVAL: TTL. RECONCILIATION: schedule con plazo; `exhausted` ⇒ atención |
| **INV-L3** Recuperación acotada | Runs ADR-028 consecutivas ≤ `maxRunFailureRecoveries`; una reconsideración por frontera; todo dentro de los presupuestos de la run; el final de cada cota es una contingencia visible, nunca silencio |
| **INV-L4** Sin requests eternos | Ningún request creado después de R7 tiene `expiresAt` nulo, salvo los handoffs (cubiertos por L1-e). Los anteriores se reportan |

### 7.3 Delivery — lo generado y persistido llega a un resultado observable

| ID | Invariante |
|---|---|
| **INV-D1** Materialización | Cada `respond recorded` de una task con binding produce exactamente un outbound `agent`; cada request elegible, a lo sumo un aviso `platform` |
| **INV-D2** Resultado observable | Todo outbound alcanza `accepted`/`delivered`/`read`, `failed`, `unknown`, `cancelled(reason)` o `pending` retenido con razón. `failed`, `unknown`, retenidos y `cancelled` por `expired`/`window_closed` aparecen en atención |
| **INV-D3** Sin reenvío incierto | `unknown` nunca se reenvía; sólo se reintenta lo definitivamente no enviado, hasta `maxAttempts` y con la misma clave |
| **INV-D4** Outbox ≠ entrega | `accepted` nunca cuenta como `delivered`. `covered` depende de que la respuesta no se haya **descartado**, no de la confirmación. Una respuesta descartada reabre la obligación de su entrada, que entonces necesita un testigo L1 (e) |

### 7.4 Transversales

| ID | Invariante |
|---|---|
| **INV-A1** Sin supervisor | Guard, disposiciones, avisos y verificadores son funciones del estado durable. Ningún módulo nuevo importa `@r4/model-gateway`. No hay proceso, cola ni agente nuevo |
| **INV-O1** Trazabilidad | Toda run terminada por `invalid_decision` registra su `finishReason` (KC-2) |

**Correspondencia con DESIGN-01:** INV-01 → S1, S2, L1, D1, D2 · INV-02 → S3 · INV-03 → S5, D1, D3 · INV-04 → S5 ·
INV-05 → S2 y §3.2 · INV-06 → S3, L3 · INV-07 → S4 · INV-08 → D4 · INV-09 → L3 · INV-10 → A1 · INV-11 → S5 ·
INV-12 → O1.

## 8. Contratos afectados

| Contrato | Paquete | Cambio | ¿Kernel? | Versionado |
|---|---|---|---|---|
| `runFailureDisposition` y constantes de razón | `contracts/src/run.ts` | §5.1 | No | Enmienda ADR-028 |
| `termination.details` | `contracts` | `finishReason`, `turnGuard` (metadata) | No | Sin cambio de esquema |
| `TemporalPersistence` | `task-runtime` | `+turnObligation` | No | Puerto interno de Core |
| `finishExecution`, `claimNext` | `task-runtime` | Diferimiento, reconsideración, disposiciones | No | ADR nuevo (TCG) + ADR-028 |
| `TemporalRuntime.decide` | `task-runtime` | Guard de `wait`, validaciones ⇒ `refused`, TTL | No | ADR nuevo (TCG) |
| `ActionRuntime` | `task-runtime` | TTL de aprobación | No | ídem |
| `visibleCapabilities` (KC-0) | `agent-kernel` | Restantes | **Sí, no contractual** | Nota en ADR-016 |
| `AgentKernel.decide`/`#finish` (KC-2) | `agent-kernel` | `finishReason` en details | **Sí, no contractual** | Nota en ADR-008 |
| `KernelSession`, protocolo v5 | `agent-kernel` | **Ninguno** | — | — |
| `outbound_messages` | `persistence-postgres` | Origen `platform` (0012 de ADR-041, `human_request_id`) | No | ADR-041 enmendado |
| `ConversationTaskFactory.request` | `live-ops` | `+predecessorTaskId?` | No | Compatible |
| `ProductionAttention` | `live-ops` | `+cancelledAgentOutbound`, `+liveness` | No | Aditivo |
| `TELEMETRY_EVENTS` | `observability` | `turn.closure.reconsider`, `turn.closed_without_reply`, `turn.closure.would_*`, `task.run_failure.handed_off` | No | Aditivo |
| Pack Sales | `agents/sales` | v9: §3.4, catálogo de avisos, linaje | No (fuera de Core) | Nueva definición |

## 9. Kernel

Ninguna garantía de R7 exige cambiar `KernelSession` ni el protocolo. KC-1 (`finish` → `continued`) queda
documentada como evolución opcional para J5-A (D-5: no ahora). KC-0 y KC-2 son cambios de código no contractuales,
propuestos para R7-1 y **no implementados** en este mandato. La alternativa K-0 (`KernelInterrupt('stopped')` para
forzar la reanudación) sigue rechazada: abusa de la semántica de apagado.

## 10. Cambios mínimos (por archivo, para fases futuras)

| Archivo | Cambio | Fase |
|---|---|---|
| `packages/contracts/src/run.ts` | Disposiciones y razones | R7-1 |
| `packages/task-runtime/src/execution-runtime.ts` | Disposiciones; abandono ⇒ handoff; diferimiento y reconsideración de `complete` | R7-1 / R7-2 |
| `packages/agent-kernel/src/{kernel,context}.ts` | KC-2, KC-0 | R7-1 |
| `packages/task-runtime/src/temporal-runtime.ts` | Validaciones ⇒ `refused`; guard de `wait`; TTL de consulta | R7-1 / R7-2 / R7-3 |
| `packages/task-runtime/src/action-runtime.ts` | TTL de aprobación | R7-3 |
| `packages/task-runtime/src/temporal-ports.ts`, `persistence-postgres/src/temporal-store.ts` | `turnObligation`; `interactionRecords` + `complete` | R7-2 |
| `packages/context-compiler/src/sources/platform.ts` | Episodio `turn.closure.reconsider` | R7-2 |
| `packages/live-ops/*`, `persistence-postgres/src/production-store.ts` | Avisos generalizados; atención (+cancelados, +liveness); fuente de predecesor; `disposition` | R7-1 / R7-3 / R7-4 |
| `packages/observability/src/telemetry.ts` | Eventos | Todas |
| `agents/sales/*` | v9 (§3.4), catálogo de avisos, linaje | R7-4 (instrucciones: podrían adelantarse a R7-2 por decisión del owner) |

## 11. Compatibilidad con J3 y J4 (AD-07)

| Área | Impacto | Garantía |
|---|---|---|
| Quote (precios, productos, servicios, despacho, vigencia) | Ninguno | El guard y el steering no llaman a Quote ni alteran cotizaciones emitidas |
| J3E emisión autónoma (ADR-034/035) | Ninguno en Core. La gramática J3 sigue siendo la compuerta de confirmación (§3.1, nota) | Una confirmación ambigua se niega (fail-closed) y el modelo pide confirmación explícita |
| Aviso `platform` entre oferta y confirmación | No invalida la oferta (D-4); conforme hoy (`quote-v4.ts:198, 205`) | Prueba S74 |
| Cambio comercial del cliente después de la oferta («Mejor que sean 120 kg») | La última entrada del cliente no es una confirmación válida, así que J3 niega la emisión | Prueba S71 |
| Repetición de escrituras | Recuperación y steering nunca generan una clave nueva para una propuesta existente. Una **nueva** propuesta del modelo depende de los límites J3 (cupo autónomo [D memoria R6: 1 por hora y 1 por conversación]) | Prueba S72; si el dominio no la niega, es un hallazgo |
| Checkout (ADR-0002 del servicio) | Ninguno | R7 no introduce capacidades ni estados de Checkout |
| Aprobaciones (ADR-033) | TTL de 60 min (D-2); las existentes no cambian | S44 |
| J4 Customer Profile / CIA / SEC-OTP | Sin cambio; el marcador de identidad no genera obligación | Regresión `profile-v8`, `canary-j4` |
| EV-2 | Las tasks `blocked` siguen pinneadas | `profile-pinned-claims` |

## 12. Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Política SC con heurísticas (signos de pregunta, conteo de trailing, "conversación atendida") como autoridad | AD-01, AD-05, D-1: heurística sintáctica o proxy semántico |
| Centinela de texto («SIN NOVEDAD») como autoridad | O3 |
| Clave reservada en `result.data` | O4 |
| Supervisor, segundo agente o verificador LLM | AD-06, AD-08, restricciones del mandato 01 |
| `ContinuityRuntime` asíncrono + tabla de liquidaciones | Carreras, llega tarde, y la tabla es derivable |
| Invalidar ofertas por cualquier mensaje `platform` | D-4 |
| Interrumpir llamadas o escrituras en vuelo ante un mensaje nuevo | F8/F9; tahan-tech 7.7 llega a la misma conclusión para escrituras |
| Reentrega con nota y cierre silencioso tras reinicio (tahan-tech 7.11) | R4 reanuda la misma run: es más fuerte |
| Re-wake automático ante una entrega fallida | Bucle y ventana de canal |
| Reintento en el mismo step, run de solo-respuesta, detector de no-progreso (ahora) | Sin evidencia suficiente; R7-5 |
| KC-1 y protocolo v6 (ahora) | D-5; O5 queda como evolución futura |
| Native Function Calling | Benchmark INCONCLUSIVE; las rutas silenciosas son posteriores al parseo |

## 13. Plan de implementación (no autorizado; detenerse antes de R7-1)

| Fase | Contenido | Cierra | Gate |
|---|---|---|---|
| **R7-1** | Enmienda ADR-028; ADR-041 verificado, fusionado y generalizado (D-8); abandono ⇒ handoff; validaciones ⇒ `refused`; KC-0; KC-2; atención (+cancelados) | B4–B8 (exceso), X1, X2, X5, parte de B12 | G1 |
| **R7-2** | `turnObligation`; diferimiento y reconsideración de `complete` y `wait`; eventos; episodio; modo `observe`; ledger de steering; instrucciones Sales §3.4 si el owner las adelanta | B1, B2 (explícito), B3a, B9 | G2 (runtime) + G-sem (semántica, con autorización aparte) |
| **R7-3** | TTL (D-2); avisos N para consulta, handoff del agente y aprobación (D-3); marca de entradas posteriores en aprobaciones (F7) | B3c, B3d, B10, B11 | G3 |
| **R7-4** | Linaje y predecesor; `disposition`; pack Sales v9 completo; revisión de `maxWriteActions` (D-7) | B1/B2 al volver, X3 | G4 |
| **R7-5** (opcional, con datos) | Run de solo-respuesta; detector de no-progreso; contadores por clase; reintento de transporte en el mismo step; evaluar O5 | X4, costo | Decisión del owner |

## 14. Riesgos residuales y rollback

| Riesgo residual | Por qué persiste | Mitigación / medición | Rollback |
|---|---|---|---|
| **B1 persistente:** el modelo cierra en silencio dos veces una solicitud real | La semántica es del modelo (AD-01); no existe distinción verificable (§3.3) | Episodio concreto en la reconsideración; instrucciones §3.4; suite semántica G-sem; evaluación post-hoc; métrica de canary sobre `turn.closed_without_reply` | `R4_TURN_GUARD=observe` |
| Costo: una llamada extra por cierre silencioso legítimo, y una run extra si fue `complete` | O2 | Medir en canary; O5 si importa | — |
| Más handoffs (presupuestos y fallas llegan a humanos) | D-6 | Avisos y atención | Redeploy (las tasks `blocked` son válidas para el código anterior) |
| Aprobación ejecutada con entradas posteriores que el modelo no vio (F7) | La autoridad es humana (AD-07) | Marca en la vista del operador; J5-A | — |
| Avisos fuera de ventana | Restricción del canal | `window_closed` ⇒ atención | Sin la opción del pack no se materializa nada |
| Handoffs sin vencimiento | Decisión de producto | L1-e: atención + aviso + SLA operativo | — |
| `maxWriteActions` de alcance task en conversaciones longevas | D-7 | Revisión antes de R7-4 | — |
| La interpretación de la gramática J3 como compuerta comercial (§3.1) no es confirmada | Interpretación | Confirmación del owner en G0 | — |
| Migración 0012 | Aditiva | — | El gate antiguo cancela los `platform` por `humanOwned` (`delivery.ts:87-91`) |
| Pruebas existentes que esperan `failed` | Cambio intencional | Plan de pruebas §7 | — |

## 15. Decisiones D-1 a D-8 (fijadas por el owner, DESIGN-02 §4)

| ID | Decisión | Efecto en este diseño |
|---|---|---|
| **D-1** | Interpretación semántica a cargo del modelo; SC-4 retirada como autoridad; mecanismo explícito y auditable | §3.3 (O2) y §4. SC-2/SC-3 pasan a metadatos |
| **D-2** | TTL de consulta 30 min; TTL de aprobación 60 min (inicial, sujeto a validación operacional) | §5.3; configuración explícita del operador |
| **D-3** | Avisos deterministas para consultas, aprobaciones y handoffs, respetando el canal | §5.2 |
| **D-4** | No invalidar cotizaciones por mensajes `platform`; distinguir lo informativo de los cambios comerciales | §5.2, §11; ya conforme en `quote-v4.ts`; pruebas S71 y S74 |
| **D-5** | KC-1 no ahora | §9; compatibilidad en §3.6 |
| **D-6** | Presupuesto agotado ⇒ handoff de plataforma y contingencia | §5.1 |
| **D-7** | `maxWriteActions` sigue siendo de alcance task; revisar antes de R7-4 | §5.3, §13 |
| **D-8** | `human_request_id` aprobado conceptualmente; verificar el PR #27 antes de modificarlo o fusionarlo | §5.2 (estado leído); sin cambios al PR |

**Pendiente de confirmación en G0:** la nota interpretativa sobre la gramática J3 (§3.1).

---

## Anexo A — Consultas derivadas (sin estructuras nuevas)

```sql
-- Obligación de una task respecto del horizonte :h (snapshot de la decisión)
with conv as (
  select i.input_id, i.memory_entry_id, i.received_at
    from task_inputs i where i.task_id = :task and i.actor_kind = 'user'
), seen as (
  select c.input_id from conv c
   where exists (select 1 from context_snapshot_items s where s.snapshot_id = :h and s.item_id = 'memory:' || c.memory_entry_id)
), covered as (
  select c.input_id from conv c
   where exists (
           select 1 from agent_run_steps r
             left join outbound_messages o on o.response_step_id = r.step_id
            where r.task_id = :task and r.decision_type = 'respond' and r.outcome = 'recorded'
              and exists (select 1 from context_snapshot_items s where s.snapshot_id = r.context_snapshot_id and s.item_id = 'memory:' || c.memory_entry_id)
              and (o.outbound_id is null or o.status not in ('failed', 'cancelled') or o.cancel_reason = 'duplicate_content'))
      or exists (select 1 from temporal_events e where e.task_id = :task and e.event_type = 'turn.closed_without_reply' and e.entity_id = c.input_id)
), frontier as (
  select input_id from conv order by received_at desc, input_id desc limit 1
)
select
  (select count(*) from conv where input_id not in (select input_id from seen))      as unseen,
  (select input_id from frontier)                                                    as frontier,
  (select input_id from frontier) not in (select input_id from covered)              as unanswered,
  exists (select 1 from temporal_events e where e.task_id = :task
           and e.event_type = 'turn.closure.reconsider'
           and e.entity_id = (select input_id from frontier))                        as reconsidered;

-- Ledger de steering (C-4): entradas que una run incorporó después de empezar
select r.sequence, r.run_id, i.input_id, min(cs.iteration) as incorporated_at_iteration
  from agent_runs r
  join task_inputs i on i.task_id = r.task_id and i.actor_kind = 'user'
                    and i.received_at >= r.started_at and (r.finished_at is null or i.received_at <= r.finished_at)
  join context_snapshots cs on cs.run_id = r.run_id
  join context_snapshot_items it on it.snapshot_id = cs.snapshot_id and it.item_id = 'memory:' || i.memory_entry_id
 where r.task_id = :task
 group by r.sequence, r.run_id, i.input_id
 order by r.sequence;
```
