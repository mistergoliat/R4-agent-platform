---
title: R4-J5 — D-7, autonomía de las operaciones comerciales (propuesta de decisión)
status: PROPUESTA — pendiente de decisión del owner. No autoriza cambios
mandate: «R4 — J5 Transition and R7-4 Documentation Closure» (owner, 2026-11-05), §C
date: 2026-11-05
base: main 3e2d1ea
depends-on: R4_R7_4_FOLLOWUPS_AND_SALES_BACKLOG.md §B–§C, R4_J5_COMMERCIAL_INTEGRATION_READINESS.md §4 y §7, R4_J5_F0_PLAN.md, ADR-016, ADR-017, ADR-018, ADR-034, ADR-035, ADR-043, R4_J4_R7_3_SCOPE_PROPOSAL.md
---

# R4-J5 — D-7: autonomía de las operaciones comerciales

## 0. Qué se decide y qué no cambia

D-7 nació como una revisión técnica: `maxWriteActions` es de alcance task y crece con tasks más largas
([R4_J4_R7_DESIGN](R4_J4_R7_DESIGN.md) §5.3 y §15). El owner lo amplió el 2026-11-05: hace falta una decisión
separada que defina **qué escrituras puede hacer el agente, con qué presupuesto y con qué aprobación**
([backlog §C](R4_R7_4_FOLLOWUPS_AND_SALES_BACKLOG.md)).

Este documento reúne los hechos (§1–§9) y propone ocho decisiones (§10). **Nada cambia con este documento:**

- `maxWriteActions` sigue en 0 en producción.
- No cambia ninguna política productiva ni el perfil `sales-production@3`.
- Quote y Checkout siguen inactivos.
- G0 sigue `NOT_APPROVED`. F1 y F2 no están autorizados.

**Tesis de la propuesta.** La autonomía se decide **por operación**, con el Policy Engine y los gates de cada
capacidad. `maxWriteActions` es un techo de seguridad por task y no sirve como instrumento de política. Hoy es 0 y
cumple las dos funciones a la vez. Por eso el primer síntoma (DS-1) fue un handoff y no una denegación explicada.

## 1. Presupuestos de escritura existentes

| Hecho | Fuente |
|---|---|
| `R4_EXEC_MAX_WRITE_ACTIONS` vale 0 por defecto: el worker no escribe salvo que el operador lo habilite | `apps/worker/src/config.ts:32`; `R4_ARCHITECTURE.md` §13.8 |
| El límite efectivo es el menor entre el del worker y el de la definición del agente. La definición Sales declara `maxWrites` 200 (v4 y v8); con el worker en 0 el límite es 0 | `packages/agent-kernel/src/budget.ts:94`; `agents/sales/sales.v4.agent.json:19-25` |
| El consumo es **de alcance task**: cuenta las ejecuciones de la task en el ledger. Los demás presupuestos (iteraciones, llamadas al modelo, lecturas, duración) son de alcance run | `persistence-postgres/src/execution-store.ts:210-213`; `agent-kernel/src/context.ts:103-111` |
| Sólo una propuesta autorizada (ALLOW) crea una ejecución. DENY y REQUIRE_APPROVAL no consumen | `task-runtime/src/action-runtime.ts:351-372`; `budget.ts:119-123` |
| Si no queda presupuesto, al modelo sólo se le ofrecen las lecturas | `agent-kernel/src/context.ts:150-153` |
| El parser acepta cualquier capacidad **registrada**, ofrecida o no | `agent-kernel/src/kernel.ts:94-97` |
| `checkBeforeWrite` se evalúa **antes** del Policy Engine. Con el límite agotado, cualquier propuesta de escritura termina el run con `budget_exhausted` / `max_write_actions`, aunque la política la hubiera denegado | `budget.ts:124-129`; `kernel.ts:211-216, 318-329` |
| `budget_exhausted` se trata como contingencia: aviso fijo y handoff `run_budget_exhausted` | `contracts/src/run.ts:195-201, 235-236`; `task-runtime/src/execution-runtime.ts:686-700` |
| No hay presupuesto de costo ni financiero en el contrato `Budget` (diferido) | `contracts/src/budget.ts:9-19` |

**Consecuencias.**

- Hoy, en `@3`, `sales.workspace.update` está registrada pero nunca se ofrece. Es el mecanismo de DS-1.
- Si el límite pasa a N > 0, la escritura N + 1 de una task produce el mismo handoff. El techo sigue fallando de
  forma segura, porque pasa a una persona, pero sigue sin explicarse al modelo.
- Tras R7-4 una conversación abarca varias tasks, y cada task tiene su propio contador. El techo limita las
  escrituras **por task**, no por conversación ni por cliente.

## 2. Clasificación actual de capacidades

Clases de riesgo: `READ`, `REVERSIBLE_WRITE`, `IRREVERSIBLE_WRITE`, `FINANCIAL`, `EXTERNAL_COMMUNICATION` y
`PRIVILEGED` (`contracts/src/capability.ts:20-27`). En el perfil, cada escritura lleva una decisión `ALLOW`,
`REQUIRE_APPROVAL` o `DENY` (`live-ops/src/profile.ts:29-37`).

| Capacidad | Clase | Perfil `@3` (producción) | Perfil `@8` (sintético, no desplegado) |
|---|---|---|---|
| `catalog.search`, `catalog.get_product_context`, `shipping.quote` | READ | Registradas | Registradas |
| `sales.workspace.update` | REVERSIBLE_WRITE, `idempotent_replay` | `@1` registrada (ALLOW), **nunca ofrecida** (límite 0) | `@2` registrada |
| `quote.preview` | READ | No | `@3` |
| `quote.create` | IRREVERSIBLE_WRITE | No registrada: el dominio Quote es UNAVAILABLE | `@5`, aprobación `none`, gates propios (§3) |
| `customer.get_context`, `customer.get_purchase_history`, `identity.verification_status` | READ | No | Registradas |
| `identity.start_verification` | EXTERNAL_COMMUNICATION, `idempotent_replay` | No | Registrada (ALLOW) |
| Inicio de compra (F6) | FINANCIAL (previsto) | No existe | No existe |

Fuentes: `agents/sales/src/capabilities/workspace.ts:37-47`; `quote-v5.ts:69-74`; `identity-verification.ts:243-254`;
`production/composition.ts:137-176, 238-241`; `production/profile.ts:38-45`; `production/profile-v8.ts:19, 33-58`.
Ninguna capacidad Sales es FINANCIAL hoy. El handoff no es una capacidad, es la decisión `request_handoff`.

## 3. Condiciones para cotizaciones autónomas

- **Política (ADR-043):** crear y emitir una cotización ordinaria no requiere aprobación humana. Quote Service es dueño
  de la cotización y el Policy Engine autoriza. El gate de confirmación de J3 sólo puede denegar.
- **Límites (ADR-034 §6, ADR-035 §1):** son siete variables obligatorias **sin valor por defecto**: monto bruto,
  líneas, unidades por línea, unidades totales, cotizaciones por conversación, cotizaciones por hora y ventana de
  confirmación. Si falta alguna, la composición no arranca (`capabilities/autonomy-limits.ts:9-47`;
  `composition.ts:166-171`). Si se excede alguna, la cotización se rechaza y **no hay fallback a una aprobación
  humana** (ADR-034 §5).
- **Controles de `quote.create@5`:** la oferta debe ser idéntica byte a byte a la que renderiza Sales. El kill switch
  se lee antes de decidir y otra vez antes de enviar (`quote-v5.ts:48-120, 176-197`).
- **Identidad:** basta `provisional`. No se exige cliente verificado (`profile-v5.ts:56`).
- **Estado de aceptación:**
  - J3 cerró con `J3_AUTONOMOUS_ISSUANCE=PASS` y `J3_PRODUCTION_ROLLOUT=NOT_AUTHORIZED`
    ([registro de cierre](../acceptance/R4_J3_CLOSURE_RECORD.md) §11).
  - ADR-034 y ADR-035 están aceptados sólo para experimentación y canary.
  - Gates abiertos para J7: GAP-12 (los límites no están aprobados), GAP-13 (gates de `@7` no exigidos en código),
    GAP-11 (observabilidad de las decisiones autónomas) y GAP-14 (ningún perfil que cotiza pasó por WhatsApp real).
- **Relación con el presupuesto:** cada cotización autónoma consume al menos una escritura (`quote.create`). Si antes
  registra la solicitud en el workspace (`record_quote_request`, ADR-034 §4), consume dos. **F1 no es compatible con
  `maxWriteActions=0`.** El techo debe dimensionarse contra los límites por conversación de ADR-034, y no al revés.

## 4. Confirmación de intención comercial

- **Lo único implementado es el gate de cotizaciones** (ADR-035 §3-4; `quote-v4.ts:188-251`). El último mensaje del
  cliente debe:
  - cumplir la gramática cerrada `r4-sales-confirmation-es-v1`;
  - seguir inmediatamente a la oferta del agente con la referencia y el total;
  - referirse a una oferta aceptada por el proveedor;
  - llegar dentro de la ventana de confirmación.

  Cada confirmación se usa una sola vez. Un mensaje ambiguo se rechaza.
- **Compra (F6, prevista):** el consentimiento se captura con el mismo gate. G6 incluye pruebas negativas
  (readiness §7).
- **No existe confirmación** para las escrituras de workspace, que registran lo que el modelo informa, ni para el
  carrito, que crea Quote al iniciar Checkout (C-2).
- **El Core no comprueba la intención; lo hace el dominio** (R7 design F10). Es coherente con la regla de pureza del
  Core.

## 5. Política FINANCIAL

- **Default de la plataforma:** FINANCIAL exige aprobación y identidad `verified` (ADR-017;
  `policy-engine/src/configuration.ts:61-71`).
- **Hoy ningún principal es `verified`.** `identityAssuranceOf` devuelve como máximo `provisional`
  (`contracts/src/capability.ts:136-146`), así que cualquier FINANCIAL termina denegada por `insufficient_identity`.
- **Una regla de política no tiene monto.** Sólo tiene `autonomy`, `minimumIdentity` y `requireEvidence`
  (`configuration.ts:25-31`). Un límite de monto tendría que vivir en la capacidad, como en las cotizaciones
  (`autonomy-limits.ts`).
- **Pendiente:**
  - D-06 (readiness §4): una ADR de autonomía FINANCIAL al estilo de ADR-043, o aprobación humana. Se necesita para
    F6.
  - D-13: autorización explícita del primer pago real.
  - No hay ninguna ADR de política FINANCIAL, pagos ni órdenes.
- **Gate:** el financiero F-1..F-7 de [R4_TEST_STRATEGY_02](R4_TEST_STRATEGY_02.md) §6.1 se exige en L3 sobre el SHA
  desplegado. Sus pruebas todavía no existen (RR-6).

## 6. Operaciones que requieren aprobación

- **Default de la plataforma:** IRREVERSIBLE_WRITE, FINANCIAL y EXTERNAL_COMMUNICATION requieren aprobación;
  PRIVILEGED se deniega (ADR-017).
- **Perfiles:**
  - `@1`–`@4` (`sales-production-policy@1`): `quote.create` con REQUIRE_APPROVAL (`production/profile.ts:55-63`).
  - `@5`–`@8`: sin aprobaciones. `@8` agrega `identity.start_verification: allow` (`profile-v8.ts:65-85`).
- **Cómo se aprueba:** la aprobación queda ligada a la propuesta, a la versión de la capacidad y a `argumentsHash`.
  Sólo se respeta si coinciden (`action-runtime.ts:299-303, 396-415`).
- **Regla operativa vigente (BLK-AP1, R7 design §5.4):** ningún perfil con REQUIRE_APPROVAL se usa en un canal
  autónomo con clientes reales hasta que exista el Approval Horizon Hold. Mientras tanto, una acción aprobada se
  ejecuta aunque el cliente haya cambiado su pedido en el intervalo.
- **Hoy `@3` no ejerce ninguna aprobación**, porque `quote.create` no está registrada.

## 7. Dependencias con R7-3

[R4_J4_R7_3_SCOPE_PROPOSAL](R4_J4_R7_3_SCOPE_PROPOSAL.md) es una **propuesta; nada implementado**. Contiene:

- R7-3a: TTL por defecto de consultas (30 min) y aprobaciones (60 min), con avisos deterministas.
- R7-3b: Approval Horizon Hold (AH-1..AH-5), que cierra BLK-AP1. Requiere una ADR nueva.
- La aprobación es evidencia y nunca un ALLOW por sí sola (§2.2).

En el código no hay nada del Approval Horizon Hold (ADR-042:53).

**Lo que depende de R7-3 en esta decisión:**

- Cualquier opción que someta una escritura comercial a **aprobación humana** dentro de una conversación con
  clientes reales: `quote.create` en `@4`, FINANCIAL por aprobación (D-06) y J5-B (ADR-042).
- **No dependen de R7-3** las opciones autónomas por política: cotización (ADR-043) y workspace. Por eso la
  propuesta prefiere autonomía acotada a aprobación humana en el camino conversacional.

C-5 (`disposition` veraz) no está en R7-3. Quedó registrada para R7-3 o R7-4b
(informe R7-4, R-7) y no bloquea esta decisión.

## 8. Autorización, idempotencia y conciliación

La cadena gobernada es `propose_action` → Policy → comando → ejecución → ActionReceipt (ADR-016). Cada eslabón
condiciona al siguiente:

1. **Autorización antes que efecto.** Sin ALLOW no hay comando ni consumo (§1). El Policy Engine deniega cualquier
   escritura que no declare una estrategia segura de replay o de conciliación (`unsafe_write_semantics`,
   `policy-engine/src/engine.ts:49-51`). **Una operación sólo puede ser autónoma si su recuperación está definida.**
2. **Idempotencia de plataforma.** La clave de ejecución (`r4x_…`) se deriva del id durable antes de cualquier
   llamada externa y es única en la base (ADR-018; `action-runtime.ts:843-846`). En Quote es la `Idempotency-Key`.
3. **Resultado incierto: conciliar, no reintentar.**
   - Con `reconcile_before_retry` se concilia antes de cualquier reintento y nunca se emite una clave nueva.
   - Agotados los intentos, la ejecución pasa a `needs_reconciliation` y la task a `WAIT_FOR_RECONCILIATION`
     (`task-runtime/src/action-lifecycle.ts:56-87`; `action-runtime.ts:709-737`).
   - Quote nunca reenvía: busca por la clave y sólo acepta «no existe» tras el plazo del owner (`quote-v2.ts:186-206`).
4. **Recibo como única prueba de efecto.** El recibo, la observación y el paso se escriben en una sola transacción
   (`action-runtime.ts:636-705`). El Turn Completion Guard no deja cerrar un turno con ejecuciones inciertas
   (`temporal-runtime.ts:382-411`).
5. **Presupuesto.** La conciliación reutiliza la misma ejecución, así que no consume otra escritura. El techo
   cuenta efectos autorizados, no intentos.
6. **Pagos (F5/F6):** el mismo principio con el dueño del pago. Idempotencia en Checkout, conciliación con el
   proveedor y orden sólo tras pago confirmado por el proveedor. Corresponde a F-3, F-5 y F-6 del gate financiero.

**Relación con DS-1.** El requisito DS-1 es el reverso de esta cadena: el agente sólo puede afirmar un efecto si
existe un recibo. Hoy:

- la única verificación de afirmaciones contra recibos es offline: `ReceiptBackedClaimEvaluator`
  (`packages/evaluation/src/evaluators/governance.ts:83-124`);
- Sales sólo la conecta para cotizaciones (`quote_claim_without_receipt`,
  `agents/sales/src/evaluations/evaluators.ts:25-36`);
- no cubre afirmaciones de registro, reserva, modificación o programación;
- el resto es una instrucción del perfil (`sales.v4.agent.json:7`).

Ampliar el detector de Sales cumple DS-1 **fuera del kernel**: el evaluador genérico ya existe.

## 9. Compatibilidad con F0–F8

| Fase | Escrituras del agente | Qué exige de D-7 |
|---|---|---|
| F0: decisiones y contratos | Ninguna | Esta decisión. No cambia producción |
| F1: cotización productiva | `quote.create` (IRREVERSIBLE, autónoma, ADR-043); el workspace si se usa `record_quote_request` | **Techo > 0** en el perfil que lleve F1; límites ADR-034 aprobados (GAP-12); DS-1 implementado antes |
| F2: catálogo vigente | Ninguna | Nada |
| F3: identidad real | `identity.start_verification` (EXTERNAL_COMMUNICATION) | La decisión ya está en `@8` (ALLOW); el techo debe contarla |
| F4: carrito técnico en Quote | Ninguna del agente: el carrito lo crea Quote (C-2) | Nada |
| F5: Checkout y Mercado Pago (R4-L) | Ninguna del agente: el enlace lo crea Checkout | Gate F-1..F-7 |
| F6: capacidades de compra | Inicio de compra (FINANCIAL, idempotente) | D-06 (autonomía o aprobación), identidad `verified` (F3) y límite de monto en la capacidad |
| F7: primera compra controlada | La de F6, una vez | D-13 |
| F8: expansión | Cada ítem con su mandato | Revisar techos y límites |

La propuesta es compatible con F0–F8: no adelanta ninguna fase y fija, para cada una, la condición de escritura que
deberá cumplir cuando el owner la autorice.

## 10. Decisiones propuestas

Cada una necesita la decisión del owner. Ninguna se implementa sin mandato propio, y cada implementación trae su
prueba, su mutación y, si toca el comportamiento comercial, una campaña acotada con el modelo real.

| ID | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D7-1** | Modelo de autonomía | (a) Un número global (`maxWriteActions`) decide qué puede hacer el agente. (b) La autonomía se decide por operación (perfil, Policy Engine y gates de la capacidad), y `maxWriteActions` es sólo un techo de seguridad por task | **(b)** |
| **D7-2** | `@3` en producción | (a) Se mantiene en 0. (b) Se habilita `workspace.update` con un techo bajo | **(a)** hasta F1. `@3` no cotiza: habilitar el workspace sólo agregaría anotaciones sin efecto comercial, y antes exige DS-1 |
| **D7-3** | Requisito previo a cualquier techo > 0 en producción | — | **DS-1 implementado en Sales:** instrucciones en una versión nueva del perfil y el detector de afirmaciones ampliado a registrar, reservar, modificar y programar (§8). Sin cambios en el kernel |
| **D7-4** | Cotización autónoma (F1) | (a) Autónoma dentro de límites (ADR-043). (b) Con aprobación humana (`@4`) | **(a).** No depende de R7-3. Condiciones: límites ADR-034/035 aprobados (GAP-12), GAP-13 cerrado, gate de confirmación activo, kill switch probado y techo dimensionado contra `maxQuotesPerConversation` |
| **D7-5** | Dimensionamiento del techo | (a) Un valor fijo. (b) Un valor derivado de los límites de la fase, revisado en cada fase | **(b).** El owner fija el valor junto con la autorización de F1. Debe cubrir las escrituras esperadas de una task y fallar con handoff si se excede |
| **D7-6** | FINANCIAL (F6, D-06) | (a) ADR de autonomía FINANCIAL con identidad `verified` y límite de monto en la capacidad. (b) Aprobación humana | **Decidir antes de F6**, no ahora. Si se elige (b), depende de R7-3b (Approval Horizon Hold). Si se elige (a), depende de F3 (`verified`) |
| **D7-7** | Aprobaciones en canales autónomos | — | Se mantiene la regla BLK-AP1: ningún perfil con REQUIRE_APPROVAL en un canal autónomo con clientes reales hasta que exista el Approval Horizon Hold. REQUIRE_APPROVAL queda para operaciones excepcionales (ADR-043) |
| **D7-8** | Propuestas de escritura no ofrecidas | (a) Se mantiene el handoff `run_budget_exhausted`. (b) El runtime devuelve un rechazo al modelo (opción (c) de DS-1) | **(a).** El owner excluyó (b) del kernel. Con DS-1 y un techo dimensionado, el caso debería ser raro. Medirlo en la observación de cada fase |

## 11. Qué no hace este documento

- No aumenta `maxWriteActions` ni cambia ninguna variable o política productiva.
- No registra capacidades ni crea perfiles.
- No activa Quote ni Checkout.
- No autoriza F1, F2, F6 ni despliegues.
- No modifica el kernel.
