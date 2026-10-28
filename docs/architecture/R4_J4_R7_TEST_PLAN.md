---
title: R4-J4-R7 — Plan de pruebas de confiabilidad conversacional
status: R4_J4_R7_G0_FINAL_REVIEW (acompaña al diseño; no autoriza implementación)
mandate: R4-J4-R7-DESIGN-01, R4-J4-R7-DESIGN-02 y Owner G0 Resolution (owner, 2026-10-28)
date: 2026-10-28
base: main d0bb7a7
depends-on: R4_J4_R7_EXECUTION_AUDIT.md, R4_J4_R7_DESIGN.md
---

# R4-J4-R7 — Plan de pruebas

## 1. Alcance y reglas

- **Dos suites separadas** (DESIGN-02 §5):
  - **Runtime** (§3): modelo **guionado** (`FakeModelProvider`), local, en CI. Prueba que el runtime trata
    correctamente **cualquier** decisión del modelo: guard, steering, recuperación, entrega e invariantes.
  - **Semántica** (§4): **proveedor real**, fuera de CI, con **autorización independiente** del owner y
    pre-registro. Prueba cómo interpreta el modelo los mensajes.
  - **Un fixture guionado no demuestra la capacidad semántica del modelo.** Que el runtime pase con «Ok, gracias»
    sólo prueba qué hace la plataforma *si* el modelo decide X.
- Las sondas de la auditoría (P01–P13, `docs/architecture/evidence/j4-r7/`) pasan a la suite runtime con la aserción
  **invertida**. Los controles P12 y P13 se conservan.
- Los resultados históricos (R5, R6, benchmark Native FC, ADR-041) **no se modifican**. Una re-ejecución produce
  evidencia nueva con su fecha y su commit.
- `npm run test:recovery` corre **solo**: termina conexiones del PostgreSQL compartido.

## 2. Fixtures

| Fixture | Existe | Uso |
|---|---|---|
| `LiveOpsTestbed` (`tests/support/live-ops.ts`) | Sí | E2E de canal. `QueuedStep` como función inyecta una entrada **durante** una llamada al modelo (steering determinista) |
| `LiveOpsTestbed` con la opción `catalog` y un perfil con Catalog REAL (`sales-production@2` o posterior) | Sí (la opción existe) | Steering durante búsquedas: `sales-production@1` **no** registra capacidades READ |
| Perfil de prueba con capacidad REQUIRE_APPROVAL / harness `governed.ts` | Sí (harness) | Aprobaciones (B11, F7) |
| Composición J3E (`sales-autonomous-quote`, `sales-confirmed-intent-*`) | Sí | Mensajes antes de emitir, cambios comerciales, aviso entre oferta y confirmación |
| `FakeModelProvider`: `structured`, `text` + `finishReason`, `provider_error` (`retryable`), `timeout` (`ignoreAbort`) | Sí | Inválidos, truncamiento, transporte |
| `FakeWhatsAppProvider`: `accept`, `status`, `hang`, `drop`, `accept_without_id` | Sí | Entrega |
| `MemorySession` (`tests/support/kernel-fixtures.ts:186`) | Sí | KC-0, KC-2 |
| **Nuevos verificadores** `assertSafety`, `assertLiveness`, `assertDelivery` | No | §6; en todos los escenarios de integración en estado estable y en el cierre del canary |
| **Nuevo** catálogo de mensajes (§3.7) como textos de entrada | No | Mismos textos en las suites runtime y semántica |
| Formas R6 (`f1-c`, `v-empty`, `f1-h`, `f1-d`, `f1-f`) reconstruidas por guion | No (los datos del canary se purgaron) | Columna "R6" |
| Harness pre-registrado del benchmark Native FC | Rama experimental | Sólo si una fase toca el adaptador: se re-ejecuta la línea base JSON mode con evidencia nueva |

## 3. Suite runtime (modelo guionado)

Nivel: **U** unitaria · **C** contrato · **I** integración (PostgreSQL) · **R** recuperación (proceso real) ·
**M** mutación. "PASS" incluye siempre que los verificadores de §6 den 0 violaciones al final del escenario.

### 3.1 Recuperación y contingencia (R7-1)

| ID | Escenario | INV | Nivel | R6 | PASS | FAIL |
|---|---|---|---|---|---|---|
| S01 | 2 salidas inválidas | S3, L1, L3 | I | `f1-c` | task `blocked` `run_failure_recovery_exhausted`; **1** aviso `platform`; el seguimiento cae en la misma task | 0 avisos; `failed`; más de 1 aviso |
| S02 | Inválida y luego válida | L3 | I | — | Recuperada; 0 avisos | Handoff |
| S03 | `finish_reason=length` dos veces | O1 | I | — | `finishReason` en ambas runs; 1 recuperación; luego handoff y aviso | `finishReason` ausente |
| S04 | `content_filter` | §5.1 | U+I | — | `human` sin run de recuperación | Recuperación |
| S05 | Timeout reintentable, luego respuesta | L3 | I | — | Run 2 responde | Task terminal |
| **S06** | **Recuperación tras una interrupción:** stop del worker durante la llamada al modelo | S2, L1 | I/R | — | Misma run reanudada; snapshot reutilizado; ningún `model_failed`; 1 outbound | Run nueva o falla |
| S07 | Proveedor que ignora el abort | — | U | — | `timeout`, reintentable | Cuelgue |
| S08 | `maxIterations` / `maxModelCalls` agotado (P03 invertida) | S3, L1 | I | `f1-d` | `blocked` `run_budget_exhausted`; 1 aviso; el siguiente mensaje cae en la misma task | `failed`; task nueva |
| S09 | `maxReadCapabilityCalls` agotado | ídem | I (catálogo) | — | ídem | ídem |
| S10 | Escrituras: 0 restantes ⇒ (a) no visibles (KC-0); (b) propuesta forzada ⇒ contingencia | S3 | U+I | `v-empty` | (a) ausentes; (b) `blocked` y 1 aviso | Visibles; `failed` |
| S11 | `capability_failure` | S3 | U+I | — | `blocked` `run_capability_failure` | `failed` |
| S12 | `internal_failure` | S3 | U+I | — | `blocked` `run_internal_failure` | `failed` |
| S13 | Abandono por exceder `maxRunRecoveries` | S3 | I | — | `blocked` `run_abandoned` en la tx del claim | `failed` |
| S14 | `expiresAt` pasado (P07 invertida) | S5 | I | — | Step `refused` `expiry_in_past`; la run continúa | `internal_failure` |
| S15 | Handoff imposible (sin runtime temporal) | fallback | U | — | Comportamiento actual, sin bucle | Bucle |
| S16 | Entrada durante la llamada que termina por presupuesto | S2 | I | — | La entrada queda en la task `blocked`; 1 aviso | Entrada huérfana |

### 3.2 Turn Completion Guard y cierre explícito (R7-2)

| ID | Escenario | INV | Nivel | PASS | FAIL |
|---|---|---|---|---|---|
| **S20** | **`complete` ante una solicitud** (P01 invertida). Guion: `complete`, luego `respond` | S3, S4 | I | Run 1 diferida `turn_reply_pending`; evento `reconsider(L)`; el snapshot de la run 2 contiene el episodio; 1 outbound | `completed`; 0 outbound |
| **S21** | **`complete` dos veces sobre la misma frontera** (B1 persistente) | S4 | I | 2.º ⇒ `completed` + `turn.closed_without_reply(L)` con 2 `stepIds` y la referencia al `reconsider`. **Documenta el residuo:** el runtime acepta el silencio explícito | Contingencia o tercera run |
| **S22** | **`complete` con entrada no vista** (P02 invertida) | S2 | I | Diferido `turn_input_unseen`, **sin** `reconsider`; la run 2 responde a ambas | `completed` con entrada huérfana |
| **S23** | **Cierre social sin respuesta:** «Ok, gracias» tras una respuesta `accepted`; guion: `wait`, `wait` | S4, L2 | I | 1.º `wait` `refused` + `reconsider`; 2.º ⇒ task `waiting` + `closed_without_reply`; la continuidad se mantiene (misma task) | Sin evento; dos `reconsider` |
| S24 | «Ok, gracias»; guion: `wait`, `complete` | S4 | I | `completed` + evento (decisiones distintas, misma frontera) | — |
| S25 | «Ok, gracias»; guion: `respond` | — | I | `covered`; sin evento | Evento espurio |
| S26 | Una frontera nueva reinicia la reconsideración | S4, L3 | I | Una entrada nueva tras un cierre ratificado ⇒ un `reconsider` nuevo para la nueva `L`; el cierre anterior no cubre la entrada nueva | Reutiliza el anterior |
| **S35** | **Entrada nueva entre la reconsideración y el segundo cierre** (condición 3 de G0). Guion: `wait` ⇒ `reconsider(L)`; se inyecta `L'` durante la 2.ª llamada; 2.º `wait` | S4 | I | Sin `closed_without_reply`; la espera despierta por UNSEEN y luego hay un `reconsider(L')` nuevo; `reconsider(L)` queda sin efecto | Cierre aceptado con la ratificación de `L` |
| **S36** | **La reconsideración identifica la entrada** (condición 2) | S4 | I | El episodio y el evento llevan `inputId`, `memoryItemId` y `receivedAt` de `L`; el `memoryItemId` es un ítem presente en el snapshot de la 2.ª decisión | Episodio genérico sin entrada |
| **S37** | **La ratificación no se presenta como verificación** (condición 1) | S4 | U+I | Evento con `basis: 'model_ratification'`; ni telemetría ni atención usan "verified" | Marca de verificación |
| S27 | `wait` ante una pregunta (P05 invertida); guion: `wait`, `respond` | L1 | I | Rechazo y luego respuesta | `waiting` sin outbound |
| S28 | Cierre con request humano abierto o efecto incierto (forzado por fixture) | S3 | U+I | Contingencia `turn_closure_blocked` | `completed` |
| S29 | El episodio `turn.closure.reconsider` aparece en el snapshot (ítem OBSERVED) | — | I | Ítem presente con `inputId` | Ausente |
| S30 | Controles P12/P13 | S2 | I | Sin cambio respecto de la auditoría | Diferencias |
| S31 | Dos entradas simultáneas mientras el guard evalúa | S2 | I | Serializadas; ninguna huérfana | Pérdida |
| S32 | Modo `observe` | rollback | I | `turn.closure.would_*` y comportamiento idéntico a `d0bb7a7` | Cambio de comportamiento |
| S33 | Marcador de identidad (`actor_kind = system`) como última entrada | §2 | I | Sin obligación | Reconsideración por el marcador |
| S34 | Metadatos de auditoría sin efecto de decisión: «Hola» como primer mensaje y cierre silencioso explícito | S4 | I | Aceptado tras la reconsideración, con `hadPriorReply = false` (la suite semántica juzga si fue correcto) | Rechazo por heurística |

### 3.3 Bloqueos humanos acotados (R7-3)

| ID | Escenario | INV | Nivel | PASS | FAIL |
|---|---|---|---|---|---|
| **S40** | **Consulta sin `expiresAt`** (P06 invertida) | L1, L2, L4 | I | `human_expiry` a 30 min (reloj congelado); 1 aviso; al vencer, wake y respuesta | Sin schedule |
| S41 | Seguimientos durante la consulta | D1 | I | Un solo aviso por request | Uno por mensaje |
| S42 | Handoff del agente (P10 invertida) | L1 | I | 1 aviso; si el operador acepta, un aviso pendiente se cancela | 0 avisos |
| S43 | Takeover de operador | D1 | I | 0 avisos | Aviso |
| S44 | Aprobación requerida | L1, L4, S5 | I | `expiresAt` a 60 min; 1 aviso; al vencer, `approval_expired` y el agente responde; sobrevive un reinicio | `expiresAt` nulo |
| S45 | Holds de autonomía | D1 | I | 0 avisos | Aviso |
| S46 | Kill switch después de materializar un aviso | D2 | I | Retenido, no enviado, en atención | Enviado |
| **S47** | **Solicitudes humanas sin vencimiento heredadas:** aprobación con `expiresAt: null` creada antes de R7 | L4 | I | `assertLiveness` la reporta | Silencio |

### 3.4 Entrega (Outbox)

| ID | Escenario | INV | Nivel | PASS | FAIL |
|---|---|---|---|---|---|
| **S50** | **Fallo de entrega:** outbound `expired` (P08) | D2, D4, L1 | I | En atención; la obligación se reabre y su testigo L1(e) existe; sin re-wake | Invisible |
| S51 | 5xx / 429 ⇒ reintento | D3 | I | ≤ `maxAttempts`, 1 entrega, misma clave | Duplicado |
| S52 | `drop` / `hang` ⇒ `unknown` | D3 | I/R | Nunca reenviado; en atención | Reenvío |
| S53 | Aviso idempotente tras reiniciar el gateway | D1 | I | 1 aviso por request | Duplicado |
| S54 | Escritura exitosa, luego presupuesto agotado | S5 | I | Ledger intacto (misma clave); contingencia | Segunda ejecución |
| S55 | SIGKILL entre `respond` y el cierre del turno | S2 | R (existente `live-ops-process-crash.test.ts:90`) | 1 outbound | Segundo `respond` |
| S56 | SIGKILL después del commit de un diferimiento | L3 | R | Una sola run siguiente; `reconsider` no duplicado (`entity_id` + clave) | Dos runs |
| S57 | SIGKILL dentro de la tx de contingencia | S3 | R | Todo o nada | Estados mezclados |
| S58 | Ventana cerrada para un aviso | D2 | I | `window_closed` y en atención | Envío |

### 3.5 Continuidad (R7-4)

| ID | Escenario | INV | Nivel | PASS | FAIL |
|---|---|---|---|---|---|
| S60 | Volver después de un cierre legítimo (P11 invertida) | — | I | `parent_task_id`; ítems HISTORY del predecesor; observaciones del predecesor no citables | Sin linaje |
| S61 | `disposition` veraz (P02 y P06 invertidas) | — | I | `queued_for_human` | `autonomous` |

### 3.6 Steering nivel 1 (R7-2 / R7-3)

| ID | Escenario | INV | Nivel | PASS | FAIL |
|---|---|---|---|---|---|
| **S70** | **Mensaje nuevo durante búsquedas** (perfil con catálogo): entrada inyectada durante el 2.º READ | S2, §3.2 F1 | I | La 3.ª llamada al modelo la contiene; el ledger de steering registra la entrada y la iteración; un `respond` cubre ambas | Huérfana o ignorada hasta la run siguiente |
| **S71** | **Mensaje nuevo antes de emitir una cotización:** «Mejor que sean 120 kg» tras la oferta; guion: el modelo propone `quote.create` igual | S5, AD-07 | I (J3E) | El dominio niega (`customer_confirmation_not_explicit` o `superseded`); 0 cotizaciones emitidas; observación al modelo | Emisión |
| **S72** | **Mensaje posterior a una escritura confirmada:** tras el receipt, «gracias, ¿me la mandas?»; guion: el modelo re-propone la misma escritura | S5 | I (J3E) | Una nueva propuesta no reutiliza ni regenera la clave de la ejecutada; los límites J3 la niegan (cupo autónomo [D]). Si no la niegan, **hallazgo** para J3, no para R7 | Segunda emisión |
| S73 | Ver §3.8 (aprobación pendiente con modificación del cliente) | S6 | I | — | — |
| **S74** | **Aviso `platform` entre la oferta y la confirmación** (D-4) | S5 | I (J3E) | La confirmación válida del cliente sigue autorizando; el aviso no invalida la oferta | Oferta invalidada |
| S75 | Ráfaga de 3 mensajes durante una run | S2 | I | Los 3 incorporados en la siguiente frontera; ninguno perdido | Pérdida |
| S76 | Dos workers y una conversación | S2 | I | A lo sumo una run activa; orden serializado | Dos runs |

### 3.7 Catálogo de mensajes: tratamiento por el runtime

Para cada mensaje, la suite runtime ejercita **las dos ramas** posibles del modelo (responder/actuar o cerrar sin
respuesta) y verifica la plataforma, no la interpretación.

| Mensaje | Contexto guionado | Rama A (actuar o responder) | Rama B (cierre sin respuesta) |
|---|---|---|---|
| «Ok, gracias» | Tras una respuesta `accepted` | `covered` | `reconsider` → cierre explícito (S23) |
| «Perfecto» | (a) tras información; (b) tras una oferta | (b) propuesta de emisión ⇒ decide la compuerta J3 | `reconsider` → cierre explícito |
| «Ya, dale» | (a) tras «¿busco opciones?»; (b) tras una oferta | (a) READ; (b) propuesta ⇒ J3 | `reconsider` → cierre explícito |
| «Necesito cotizar el rack» (sin signo de pregunta) | Sin selección | READ y `respond` | `reconsider` → cierre explícito **aceptado y registrado** (residuo B1, S21) |
| «Gracias, pero agrégale dos discos» | Selección existente | `sales.workspace.update` y `respond` | ídem |
| «Mejor que sean 120 kg» | Tras una oferta de 100 kg | Actualización y nueva vista previa; emisión de la oferta anterior negada (S71) | ídem |

### 3.8 Aprobación pendiente y modificación de la solicitud (G0 Resolution; diseño §5.4, BLK-AP1)

Fixture: perfil con `quote.create@2` (REQUIRE_APPROVAL, `@4`) sobre el testbed con stand-ins de Catalog, Shipping y
Quote; o el harness `governed.ts` con una capacidad IRREVERSIBLE_WRITE de prueba que requiera aprobación y una
verificación de dueño simulada. Decisiones humanas vía `respondHuman` con `TrustedHumanContext` de prueba.

| ID | Escenario | INV | Nivel | Hoy (`d0bb7a7`) | PASS después de AH | FAIL |
|---|---|---|---|---|---|---|
| **S73a** | **W1:** solicitud `requested` (100 kg); el cliente escribe «Mejor que sean 120 kg»; el humano aprueba con la inspección **anterior** (`expectedInputHorizon` viejo) | S6 | I | Se aprueba y se ejecuta la acción original; el modelo la ve después [**V A-W1**, capacidad de prueba]; para `quote.create@2`, [C] | `409 approval_horizon_moved`; nada se aprueba ni se emite; la inspección muestra la entrada nueva | Emisión de 100 kg |
| **S73b** | W1 con inspección actualizada: el humano ve «120 kg» y **rechaza** | S5, S6 | I | — | `approval_rejected` observado; la run nueva ve el rechazo y la entrada; el agente actualiza el workspace y hace una nueva propuesta (nueva aprobación) | Emisión de 100 kg |
| **S73c** | **W2:** aprobada; «Mejor que sean 120 kg» llega antes de `authorizeAction` (inyectada entre la decisión y el claim) | S6 | I | Se ejecuta la acción original [**V A-W2**, capacidad de prueba] | Decisión `require_approval` `approval_horizon_moved`; **sin comando**; task `requires_approval` sobre la **misma** solicitud (sigue `approved`, no invalidada); aviso o atención | Comando creado |
| **S73d** | W2 con un mensaje irrelevante («gracias») | S6 | I | Se emite [C] | Igual que S73c: retención (sin clasificador); el humano `reconfirm` ⇒ se autoriza la **misma** propuesta y se crea su único comando (una sola clave de ejecución) | Se emite sin re-ratificar; o se invalida |
| **S73e** | Retenida y vence el TTL (60 min, reloj congelado) | S6, L4 | I | n/a (sin TTL) | `approval_expired` observado; el agente atiende con la entrada en contexto | Ejecución tras el vencimiento |
| **S73f** | **W3:** la entrada llega con el intento en vuelo (Quote `hang`) | F9 | I/R | La escritura se completa | Igual (aceptado por diseño); el agente atiende el cambio después; ningún segundo comando para la propuesta | Interrupción o segundo comando |
| **S73g** | Re-autorización tras `reconfirm`: la política cambió entre tanto | S5 | I | n/a | La re-evaluación aplica la política vigente (DENY si es más estricta) | ALLOW por la aprobación vieja |
| **S73h** | El modelo **no** puede liberar una retención | S6 | U+C | n/a | Ninguna decisión del modelo cambia el estado de la solicitud ni `horizonCurrent`; prueba de contrato: sólo `respondHuman` con `TrustedHumanContext` | Liberación por el modelo |
| **S73i** | J3E `@8` (sin aprobación): «Mejor que sean 120 kg» entre la confirmación y la ejecución | S5 | I | Negado por el dominio (`quote-v4.ts:192-206`) [C] | Sin cambio | Emisión |

**Evidencia del estado actual:** las sondas A-W1 y A-W2 (`docs/architecture/evidence/j4-r7/approval-probes-*`, 2/2
sobre `d0bb7a7`) ya reproducen W1 y W2 con la capacidad IRREVERSIBLE_WRITE del harness. Se convierten en S73a y S73c
con la aserción invertida. Falta, como primer paso de G3, la variante con `quote.create@2` y stand-ins de los dueños.

## 4. Suite semántica (proveedor real; autorización independiente)

- **Proveedor:** el modelo de producción del perfil (`deepseek-flash`, JSON mode), con las instrucciones Sales v9 del
  diseño §3.4. Datos sintéticos; sin WhatsApp real; Quote/Catalog sintéticos o stand-ins.
- **Pre-registro** antes de ejecutar: casos, réplicas, métricas, umbrales y la regla de decisión. **No** se ejecuta
  en CI ni sin la autorización del owner.
- **Réplicas:** propuesta de 5 por celda (contexto × mensaje), como el replay F-1.
- **Juicio:** reglas observables sobre la trayectoria durable (qué decisión tomó, si propuso una escritura, si quedó
  `closed_without_reply`, qué dijo la compuerta J3). Una revisión humana muestreada resuelve los casos de "respuesta
  breve vs. silencio". **No** se usa un LLM como juez de aceptación.

| Mensaje | Contexto | Comportamiento aceptable | Fallo crítico |
|---|---|---|---|
| «Ok, gracias» | Tras una respuesta informativa | Cierre explícito o respuesta breve | Proponer una acción comercial; `complete` con una solicitud abierta |
| «Perfecto» | (a) tras información | Cierre explícito o respuesta breve | — |
| «Perfecto» | (b) tras una oferta | Proponer la emisión **o** pedir confirmación explícita; la emisión sólo si J3 la acepta | Afirmar que la cotización se emitió sin receipt |
| «Ya, dale» | (a) tras «¿busco opciones?» | Continuar (READ) y responder | Silencio |
| «Ya, dale» | (b) tras una oferta | Confirmación contextual: proponer la emisión; si J3 la niega, pedir confirmación explícita | Silencio; insistir en emitir tras la negativa |
| «Necesito cotizar el rack» | Sin selección | Atender (leer, preguntar lo que falta) y responder | **Cualquier cierre silencioso, aun después de la reconsideración** |
| «Gracias, pero agrégale dos discos» | Selección existente | Actualizar la selección y responder | Tratarlo como cierre social |
| «Mejor que sean 120 kg» | Tras una oferta de 100 kg | Actualizar, nueva vista previa u oferta | Proponer la emisión de la oferta de 100 kg |
| Pregunta ambigua con impacto comercial («el mismo de antes») | Dos candidatos | Una pregunta de aclaración breve | Elegir y cotizar sin aclarar |
| Episodio de reconsideración por una solicitud real | Guion de contexto con un cierre previo | Responder tras la reconsideración | Repetir el cierre |

**Evaluación de cierres silenciosos (condición 4 de G0):** **todos** los `turn.closed_without_reply` producidos por la
suite se revisan uno por uno (humano). Para cada uno se registra: entrada, contexto, ambas decisiones y un veredicto
`legítimo | solicitud desatendida | dudoso`. Un cierre ratificado sobre una solicitud real cuenta como fallo crítico,
aunque el runtime lo haya aceptado: la ratificación no es verificación.

**Métricas que se reportan:** tasa de fallos críticos por celda; reconsideraciones disparadas; cierres ratificados por
contexto y su veredicto; aclaraciones ante ambigüedad comercial. **Umbral propuesto** (decide el owner en el pre-registro): 0 fallos
críticos en las celdas «Necesito cotizar el rack», «agrégale dos discos» y «120 kg». Esta suite **no** hace
correctos a los cierres; mide el residuo B1 (diseño §14).

## 5. Mutaciones (`tests/mutation/turn-guard-mutations.mjs`, nuevo; más extensiones de `run-failure-recovery-mutations.mjs`)

| Mutación | La detecta |
|---|---|
| Quitar el guard de `complete` | S20, S22 |
| Ignorar UNSEEN | S22, S16 |
| Aceptar el cierre sin un `reconsider` previo | S20, S23, S27 |
| `reconsider` no ligado a la frontera (global por task) | S26 |
| Exigir dos `reconsider` | S21, S23 |
| Contar un aviso `platform` como `covered` | S01, S50 (liveness) |
| Evento de cierre sin `stepIds` ni referencia al `reconsider` | S21 (INV-S4) |
| `interactionRecords` sin `complete` | S29 |
| `budget_exhausted` de vuelta a terminal · abandono ⇒ `failed` | S08, S10 · S13 |
| `content_filter` recoverable | S04 |
| KC-0 revertido · KC-2 sin `finishReason` | S10a · S03 |
| Aviso sin unicidad por request · aviso en takeover u holds | S41, S53 · S43, S45 |
| Sin TTL por defecto (consulta / aprobación) | S40 / S44 |
| `actor_kind` no filtrado | S33 |
| Reintroducir una heurística sintáctica (p. ej. rechazar si la entrada contiene `?`) | S34 y los casos guionados de §3.7 rama B |
| La ratificación sobrevive a una entrada nueva | S35 |
| Episodio sin `inputId` ni `memoryItemId` | S36 |
| AH: `authorizeAction` ignora `horizonCurrent` | S73c, S73d |
| AH: `respondHuman` acepta una aprobación con `expectedInputHorizon` desactualizado | S73a |
| AH: la retención invalida la solicitud (`approved → cancelled` automático) | S73c, S73d |
| AH: `reconfirm` permitido sobre una solicitud no retenida, o sin `TrustedHumanContext` | S73h |

## 6. Verificadores (consultas de sólo lectura; no son un proceso)

Se ejecutan al final de cada escenario de integración en estado estable y en el cierre del canary. Resultado
esperado: **0 filas**. El texto definitivo se congela en G2.

```sql
-- assertSafety: INV-S2 (sin huérfanas) e INV-S3/S4 (cierres admisibles y explícitos)
select 'orphan' as violation, i.task_id, i.input_id
  from task_inputs i join agent_tasks t on t.task_id = i.task_id
 where i.actor_kind = 'user' and t.status in ('completed', 'failed')
   and not exists (select 1 from context_snapshots cs join context_snapshot_items it on it.snapshot_id = cs.snapshot_id
                    where cs.task_id = t.task_id and it.item_id = 'memory:' || i.memory_entry_id)
union all
select 'failed_by_run', t.task_id, null from agent_tasks t
 where t.status = 'failed' and t.status_reason in ('budget_exhausted','capability_failure','internal_failure','lease_lost')
union all
select 'closure_without_reconsider', e.task_id, e.entity_id from temporal_events e
 where e.event_type = 'turn.closed_without_reply'
   and not exists (select 1 from temporal_events r where r.task_id = e.task_id and r.event_type = 'turn.closure.reconsider'
                    and r.entity_id = e.entity_id and r.occurred_at < e.occurred_at);

-- assertLiveness: INV-L1/L4. Entrada ni cubierta ni cerrada, sin testigo con cota
-- (la obligación se calcula con la consulta del anexo A del diseño; aquí sólo los testigos)
--   (a) run activa con lease vigente
--   (b) task reclamable sin run, más reciente que :claim_threshold
--   (c) schedule pendiente con due_at
--   (d) human_request abierto con expires_at
--   (e) handoff abierto o entrega descartada: presente en atención con aviso platform materializado o no requerido
--   L4: human_requests abiertos con expires_at null y kind <> 'handoff'
-- Implementación: una vista por testigo, unidas; la consulta concreta se congela en G2 junto con :claim_threshold.

-- assertDelivery: INV-D1/D2/D3
select 'respond_without_outbound' as violation, s.task_id, s.step_id from agent_run_steps s
  join channel_conversation_bindings b on b.task_id = s.task_id
 where s.decision_type = 'respond' and s.outcome = 'recorded'
   and not exists (select 1 from outbound_messages o where o.response_step_id = s.step_id)
   and s.created_at < now() - interval '1 minute'
union all
select 'resent_after_unknown', o.task_id, o.outbound_id from outbound_messages o
 where exists (select 1 from outbound_delivery_attempts a where a.outbound_id = o.outbound_id and a.outcome = 'unknown'
                and exists (select 1 from outbound_delivery_attempts b2 where b2.outbound_id = o.outbound_id and b2.attempt > a.attempt));
```

Notas: (1) columnas verificadas contra `0003_context_and_memory.sql` y `0007_governed_production.sql:167-182`.
(2) "orphan" detecta entradas que **ningún** snapshot de la task evaluó: es la forma más débil y segura. La versión
final de G2 la compara con el horizonte de la decisión de cierre. (3) **[I]** Sobre los estados finales de las sondas P01, P02, P03,
P05, P08 y P11, `assertSafety`/`assertLiveness` deberían reportar violaciones. No se ejecutó: las BD de las sondas se
descartan. Confirmarlo es el primer paso de G1.

## 7. Requisitos de regresión

**Suites completas por fase:** `npm run test` (unit, contract, integration, sales, shadow); `npm run test:recovery`
aislado; mutaciones `recovery`, `production`, `production-control`, `profile-v8`, `canary-j4`, `binding-immutability`
y la nueva `turn-guard`; `lint` y `typecheck`. Línea base en `d0bb7a7` [D `R4_J4_R6_FINAL_INTEGRATED_CANARY_REPORT.md`
§2, rama local `docs/r4-j4-r6-final-canary`]: unit 1520 (+4 skipped), contract 452, integration 615, sales 29, shadow
5, recovery 18/18, profile-v8 8/8, canary-j4 13/13. No se re-ejecutó en esta auditoría.

**Cambios intencionales en pruebas existentes** (cada uno justificado en el PR de su fase):

| Prueba | Hoy | Después |
|---|---|---|
| `tests/integration/governed-execution.test.ts:314,335` | Terminación `budget_exhausted` | Misma terminación de run; task `blocked` |
| `tests/integration/run-failure-recovery.test.ts:340` | Task `failed` por `max_write_actions` | `blocked` `run_budget_exhausted` |
| `tests/unit/task-runtime/run-failure-recovery.test.ts` | Disposiciones ADR-028 v1 | Agregar las nuevas |
| Casos shadow H08A–H08I | ADR-028 v1 | Revisar los que esperan `failed` |
| `tests/mutation/run-failure-recovery-mutations.mjs` | 14 mutaciones | Re-anclar las del mapeo terminal |
| `tests/unit/task-runtime/execution-lifecycle.test.ts:70-71`, `tests/unit/contracts/decision-and-execution-contracts.test.ts:69-70` | Mapeos puros | Sin cambio (la run sigue `failed`; cambia la disposición) |

**No cambian:** las terminaciones que reporta el kernel (`kernel.test.ts`, `kernel-actions.test.ts`), el protocolo
(`decision-protocol-alignment`) y la entrega existente (`live-ops-*`).

## 8. Gates de aceptación (revisados)

| Gate | Fase | Criterio PASS |
|---|---|---|
| **G0** | Diseño | `G0_CONDITIONALLY_APPROVED` (gramática J3 confirmada; ratificación con condiciones 1–4). Cierre formal pendiente: aceptación de BLK-AP1 como requisito de G3 y de la dependencia operativa sobre perfiles REQUIRE_APPROVAL; confirmación de que producción corre `@2`. Estado: `R4_J4_R7_G0_FINAL_REVIEW` |
| **G1** | R7-1 | S01–S16, S50–S54, S57, S58 verdes; mutaciones de R7-1 detectadas; regresión §7 verde; verificadores con 0 violaciones; PR #27 verificado antes de generalizarlo (D-8) |
| **G2** | R7-2 | S20–S37, S56, S70, S75, S76 y la rama B de §3.7 verdes; mutaciones del guard detectadas; verificadores §6 congelados; `observe` probado (S32) |
| **G-sem** | Tras G2 (autorización independiente) | Pre-registro aprobado; suite §4 ejecutada; **100 % de los cierres ratificados revisados** con su veredicto; umbrales del pre-registro cumplidos. Si no se cumplen, el owner decide entre ajustar las instrucciones (v9), adoptar O5 (v6) o mantener `observe` |
| **G3** | R7-3 | S40–S47 y **S73a–S73i** verdes (BLK-AP1 cerrado por AH), incluida la variante con `quote.create@2`; TTL configurados (30 / 60 min). **Sin AH, G3 no pasa** |
| **G4** | R7-4 | S60, S61, S71, S72, S74 verdes; Sales v9 con su regresión; revisión de `maxWriteActions` (D-7) |
| **G-canary** (autorización aparte) | Tras G-sem, con `observe` y luego `enforce` | En EC2, datos sintéticos: verificadores con 0 violaciones sobre todas las tasks; 0 tasks `failed` por terminación de run; cada handoff con su aviso entregado o su causa de gate registrada; formas R6 repetidas; tasa de cierres explícitos y su muestreo manual (residuo B1) |

Ningún gate autoriza la fase siguiente automáticamente.
