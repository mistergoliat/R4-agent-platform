# ADR-031 — Frontera de autoridad previa a `respond` (enmienda acotada de ADR-025)

- **Estado:** **SUPERSEDED por R4-J1E-R2.2 (2026-10-01)**: la frontera ya no existe en el camino de `respond`. Las secciones 1–11 se conservan como historia de la decisión.
- **Fecha:** 2026-09-30
- **Autoridad superior:** Constitución ("model output is untrusted"; la verdad durable pertenece a su owner); PRD §7; ADR-002, ADR-005, ADR-008, ADR-009, ADR-030
- **Enmienda:** ADR-025 §1, sólo en lo que aquí se define
- **Relacionado:** `docs/architecture/R4-J1D_PRODUCTION_CATALOG_CLOSURE.md` (primer E2E de WhatsApp)

## Decisión vigente — R4-J1E-R2.2: Restore Pure Agent Execution (2026-10-01)

**Response Authority deja de ser un enforcement obligatorio previo al envío.** Un `respond`
válido por protocolo se persiste y se envía tal como el agente lo decidió, y cierra el turno.
La evaluación de calidad y grounding de las respuestas conversacionales es **post-hoc**. La
autoridad sobre **acciones** (side effects) sigue siendo síncrona y determinista.

### Por qué se introdujo

El primer E2E de WhatsApp (ver Contexto, abajo) mostró respuestas incompatibles con la evidencia
del owner que llegaban al cliente, y ADR-025 sólo permitía detectarlas después. Se decidió impedirlas
antes del envío con un validador determinista del pack, y R4-J1E-R2 / R2.1 lo endurecieron.

### Evidencia de Oxford

Catalog respondió correctamente:

- `P2340`: Colchoneta Oxford Negro/Rojo 100x50x5cm - 2da Selección, `finalGross = 6296`, `price.kind = exact`,
  `price.basis = not_offerable`, `sellability = not_sellable`, `reason = out_of_stock`.
- `P872`: la versión nueva, `finalGross = 13990`, `offerable`, `sellable`, `in_stock`.

El agente respondió correctamente: P2340 cuesta $6.296, está sin stock y no se puede pedir, y la
versión nueva está disponible a $13.990. El validador rechazó la respuesta como si presentara P2340
como disponible (`response_authority_contradiction`). Eso disparó corrección, otro rechazo, la
degradación segura enviada al cliente, nuevas llamadas al modelo y nuevas búsquedas de Catalog, hasta
≈ 170 k tokens de entrada. **El harness introdujo el error; el agente no.**

**Diagnóstico confirmado.** El borrador exacto de producción, reproducido contra el código R4-J1E-R2.1
con los mismos datos de Catalog, se rechaza con `response_authority_contradiction`: "$6.296 refers to
P2340 … never present it as available". La negación ("hoy aparece sin stock") está en la misma oración,
pero después del siguiente monto ($13.990), fuera de la "ventana" del $6.296. Ese monto coincide con el
precio de P872, así que el "bloque de producto" trató la oración como si hablara de otro producto y no
buscó la negación. El borrador exacto es ahora una regresión permanente
(`tests/integration/pure-agent-execution.test.ts`).

### Por qué produjo un falso positivo

El validador infería significado comercial desde la superficie del texto: montos anclados, nombres de
producto por solapamiento de palabras, una lista cerrada de frases de (no) disponibilidad y "bloques"
de oraciones. Cualquier redacción honesta que cayera fuera de esas reglas se leía mal, y cada
enmienda (R2 §9, R2.1) agregaba reglas sin poder cerrar el espacio del lenguaje. Un juez semántico
síncrono convierte cada falso positivo en un fallo de la conversación en curso.

### Por qué mezclar evaluación semántica con control del runtime viola la separación de R4

**PLATFORM CORRECTNESS ≠ AGENT QUALITY ≠ BUSINESS OUTCOME.** Execution ejecuta, Governance gobierna
acciones, Evaluation observa post-hoc y el Reviewer propone cambios después. La frontera de ADR-031
fusionaba Evaluation con Execution: un juicio de calidad decidía el control flow (corrección,
degradación, espera, reintentos). Eso es exactamente el guard en el loop que ADR-025 prohíbe, aun
siendo determinista, y además ocultaba el error real del agente detrás de la reacción del harness.

### Decisión

1. **Sin juez síncrono en el camino de `respond`.** `AgentDecision.respond` válido → persistido
   (`recorded`) → outbound → el turno se asienta. No hay validador, veredictos, corrección semántica,
   degradación segura, supresión ni WAIT_UNTIL por autoridad de respuesta. No se reemplaza por reglas
   equivalentes: ni regex, heurística, clasificador, juez LLM, templates ni guards de redacción.
2. **`respond` es terminal para el turno** (ADR-008, enmienda R4-J1E-R2.2): tras el `respond`
   registrado, la plataforma registra un `WAIT_FOR_INPUT` de `origin = 'platform'` (sin tokens) por
   el Temporal Runtime. No hay otra llamada al modelo, READ ni segundo outbound para ese input.
3. **Sigue igual:** la autoridad sobre acciones (ActionProposal, Policy Engine ALLOW/DENY/REQUIRE_APPROVAL,
   execution keys, idempotencia, receipts, reconciliación, TrustedHumanContext, kill switch) y la
   seguridad del runtime (schema del output estructurado, budgets, leases, fencing, cancelación,
   recuperación de runs ADR-028, scheduler, protección de outbound duplicado).
4. **Observabilidad, no bloqueo.** La trayectoria durable (Task, Runs, ContextSnapshots, decisiones,
   READs y observations, outbound, tokens, latencias, fallos) es la entrada futura de
   Evaluation/Reviewer. R2.2 no construye el Reviewer, ni scoring, ni juez LLM, ni auto-optimización.

### Qué se eliminó y qué se conserva

| Pieza | Clasificación |
|---|---|
| `ResponseAuthorityValidator`, veredictos y constantes (`@r4/contracts`), `responseAuthorityState` y las ramas del kernel (revalidación, diferimiento, corrección, degradación, supresión), `WorkerBindings.responseAuthority`, telemetría `response.authority.*`, episodio `response.not_sent`, aceptación de `respond` `refused` en `recordStep` | **A. eliminado** |
| `SalesCommercialEvidenceValidator` y `availability-wording.ts` (Sales) | **A. eliminado** del código. **C.** La idea (reconstruir claims anclados a observations) pasa al backlog de Quality/Learning como posible insumo de una evaluación post-hoc. Sus reglas produjeron el falso positivo de Oxford: no se conservan como base. Historia en git, commit `3b3cd8d`. |
| Migraciones `0009_run_step_origin` y `0010_platform_step_decisions` | **Se conservan** (congeladas). `origin = 'platform'` es ahora sólo el `wait` que cierra el turno. Los steps históricos de R2 (`response_authority_*`) siguen siendo legibles y nada los produce. |
| Scheduler en producción (R2.1, ADR-029 §16) | **Se conserva**: lo necesitan los WAIT_UNTIL del agente, las expiraciones, los reintentos y la reconciliación. |

### Nota de despliegue

R4-J1E-R2.2 publica la definición **sales@3** (sólo la viñeta de protocolo de "Interaction"; el registry
rechaza cambiar el contenido de sales@2). Antes de los procesos, `production:sales:bootstrap` debe
registrar `sales@3`. Las conversaciones nuevas resuelven sales@3; las tareas abiertas siguen fijadas a
la versión con la que se crearon (su texto anterior es inocuo, porque la plataforma cierra el turno igual).

### Diferido (sin implementar; `respond` sigue siendo terminal)

- **Avisar/acusar recibo antes de `request_consultation` o `request_handoff`.** Hoy un `respond` cierra
  el turno, así que el agente no puede decir "déjame confirmarlo" y luego consultar o derivar en el
  mismo turno: consulta o deriva sin aviso. Cualquier solución futura (p. ej. un aviso de plataforma o
  un campo en la decisión humana) es una decisión de producto aparte. No se reintroduce un `respond`
  intermedio.
- **`respond` + `complete`.** Cerrar la tarea en el mismo turno que la última respuesta no existe: hoy
  se completa en un turno sin respuesta o la tarea queda esperando input. También es una decisión
  aparte, sin `respond` intermedio.

### Consecuencias

- Una respuesta factualmente incorrecta del agente llega al cliente si es válida por protocolo. Queda
  auditable (observation del owner + decisión + snapshot + outbound) y su detección es de Evaluation/Reviewer.
- El runaway de Oxford (corrección → degradación → nuevos turnos del modelo) desaparece porque desaparece el loop.
- Las instrucciones de Sales se actualizaron al protocolo (sales@3): un `respond` termina el turno y la
  plataforma espera el próximo mensaje; sin cambios comerciales, de tono ni de estrategia.

---

## Historia de la decisión (SUPERSEDED por R4-J1E-R2.2)

## Contexto

El primer E2E real de WhatsApp (R4-J1, 2026-09-30) mostró respuestas comerciales incompatibles con la
evidencia del owner: el modelo presentó como disponible una kettlebell que Catalog informaba
`not_sellable/out_of_stock`, y varios precios salieron después del `validUntil` de su evidencia
(+8 s … +110 s), porque la ventana del owner (15 s) es menor que la latencia de un turno del modelo.
ADR-025 §1 prohíbe guards en el loop del agente; una evaluación post-hoc detecta el error, pero no
impide que llegue al cliente. Subir la ventana de Catalog está descartado: Catalog es dueño de
`validUntil` (ADR-030).

## Decisión

1. **Una sola frontera determinista, inmediatamente antes de que un `respond` sea durable.** Como
   el outbound materializa un mensaje por cada step `respond` `recorded` (ADR-029), el último punto
   donde todavía se puede refrescar evidencia o pedir una corrección al modelo es el kernel, al recibir
   la decisión. No se mueve al dispatcher de outbound: ahí ya no hay modelo ni evidencia.
2. **Seam genérico en Core** (`@r4/contracts`: `ResponseAuthorityValidator`; kernel: aplicación de
   veredictos). El kernel no conoce Catalog, precios ni stock. Veredictos:
   - `allow` → se registra el borrador tal cual.
   - `revalidation_required` → el kernel emite los READ pedidos como steps durables de
     `origin = 'platform'` (sin llamada al modelo, sin tokens; migración `0009_run_step_origin`) y
     valida **el mismo borrador** otra vez: si la verdad no cambió, se conserva y se envía.
   Tras los READ la iteración avanzó: el kernel compila y persiste el ContextSnapshot de la nueva
     iteración (mismos inputs más la evidencia refrescada contra la que se validó el borrador) y registra
     el step `respond` contra él (FK `(snapshot, run, iteration)`); el snapshot de la llamada al modelo que
     redactó el borrador queda en `response.authority.revalidated.draftSnapshotId`.
   - `reject` → el borrador se registra `refused` (no terminal, código `response_authority_*`), nunca
     se envía y el modelo recibe el feedback estructurado (episodio `response.not_sent` en el contexto).
3. **Límites (sin loops).** Hasta 6 READ de revalidación por borrador, dentro del budget de READ.
   Un ciclo de corrección del modelo por candidato de outbound; si el borrador corregido tampoco es
   válido, se registra la degradación segura del pack (sin afirmaciones comerciales). Evidencia que no
   se pudo revalidar ⇒ `reject` (`response_authority_unverifiable`).
4. **El pack es dueño de la semántica** (Sales: `SalesCommercialEvidenceValidator`): reconstrucción
   determinista de claims anclados (montos `$`, nombres de producto observados), vinculación a la
   última observation de Catalog de la task, sellability/disponibilidad, variante ("desde"),
   frescura hasta el envío (+3 s) y clasificación de totales derivados (suma de precios de Catalog
   del mismo borrador, rotulada referencial/aproximada; nunca impuestos, descuentos, despacho ni
   reglas de negocio). Catalog sigue siendo dueño de producto, precio, promoción, sellability,
   disponibilidad y `validUntil`.
5. **Contabilidad honesta.** Los steps `platform` no cuentan como llamadas al modelo (budgets, métrica
   `model_calls`); los borradores rechazados no aparecen como respuestas dichas.

## Enmienda R4-J1E-R2 (2026-09-30)

El segundo E2E (sales@2) mostró tres defectos de esta frontera, no de Catalog: refresco dentro de la
ventana de caché del owner, consistencia de disponibilidad demasiado literal y más de una degradación
por run. Se corrigen así:

6. **Near-expiry ⇒ `notBefore`, nunca refresco inútil.** Evidencia vencida (`validUntil ≤ now`) se
   revalida de inmediato (la ventana del owner terminó). Evidencia aún vigente pero con menos margen
   que el de envío (3 s) NO se refresca ahora: Catalog devolvería la misma respuesta cacheada (mismo
   `asOf`/`validUntil`). El validador devuelve `REVALIDATION_REQUIRED { reads, notBefore }` con
   `notBefore = validUntil + ε` (ε técnico = 250 ms, sólo contra skew de reloj; no es presupuesto de
   latencia). Si otra evidencia del mismo borrador quedaría a su vez dentro del margen al despertar,
   se incluye en los READ y `notBefore` cubre también su ventana (un solo wake revalida el borrador).
   El TTL de Catalog no cambia (ADR-030).
7. **Espera durable, no sleep.** Con `notBefore`, el kernel registra el borrador `refused`
   (`response_authority_deferred`: nunca enviado, no consume corrección) y un step `wait`
   `WAIT_UNTIL notBefore` de `origin = 'platform'` por el Temporal Runtime (ADR-021): la run se
   suspende, se libera el lease y el scheduler la despierta. Sin `setTimeout`, polling ni recursión.
   La run nueva resuelve primero el borrador diferido, antes de cualquier llamada al modelo (como
   `carriedAction` en R4-E): READ de plataforma → validar el MISMO borrador → si la verdad no cambió se
   registra tal cual (`respond` de plataforma, sin tokens, contra el snapshot de su propia iteración);
   si cambió materialmente se rechaza y entra al presupuesto de recuperación. Un borrador se difiere a
   lo sumo una vez (si se despertó antes por input, se refresca de inmediato). Crash entre el borrador
   diferido y su wait: al reanudar se registra sólo el wait. Un takeover humano o cancelación descarta
   el borrador (nunca se envía después). Migración `0010_platform_step_decisions`: `origin = 'platform'`
   admite `read_capability`, `respond` y `wait`, siempre sin tokens.
8. **Presupuesto de recuperación por RUN, no por borrador.** Derivado sólo de steps durables
   (`responseAuthorityState`): `corrections` (rechazos devueltos al modelo) y `degraded`. Una corrección
   por run; luego UNA degradación segura (borrador inválido `refused`
   `response_authority_degraded` + `respond` de plataforma con el texto del pack); cualquier borrador
   inválido posterior de la misma run se registra `refused` sin ningún outbound adicional. Una respuesta
   válida intermedia no reinicia el presupuesto. Una run despertada desde un wait de revalidación
   continúa el presupuesto de la run que difirió; cualquier otra run nueva (p. ej. input del cliente)
   empieza con presupuesto nuevo.
9. **Consistencia por bloque de producto (Sales).** Un precio de un producto no vendible debe estar
   calificado como no disponible dentro de su bloque local: la oración del monto o hasta dos oraciones
   adyacentes del mismo párrafo que no identifiquen otro producto, sin cruzar salto de línea/viñeta ni
   un cambio de sujeto ("otros/demás/resto", o una medida que el nombre del producto no tiene). La
   oración del monto nunca puede afirmar disponibilidad. Para un producto vendible, la negación se sigue
   evaluando sólo junto al monto. Nombres: si un nombre observado contiene a otro, cuenta sólo el más
   específico; palabras enunciadas como ausentes ("sin segunda selección") no desambiguan.
   "Desde" (precio de producto) sigue sin poder asignarse a una variante; totales derivados sin cambios.

## Enmienda R4-J1E-R2.1 (2026-10-01) — corrección de composición productiva

El E2E productivo de J1E-R2 (sales@2, `80f63ff`) mostró dos defectos; ninguno cambia las reglas de
evidencia de Sales:

10. **El scheduler es parte de la producción.** El WAIT_UNTIL de §7 sólo lo despierta un schedule
    disparado por `apps/scheduler`, que producción no corría (ADR-029 §16 listaba gateway + worker):
    la task quedaba en `waiting` sin wake. Producción corre ahora tres procesos (ADR-029 §16, enmienda
    R4-J1E-R2.1). No cambia ADR-021/022.
11. **Una run degradada no abre otra recuperación.** §8 se aplicaba sólo a `reject`: tras la degradación,
    un borrador nuevo con evidencia casi vencida o vencida devolvía `REVALIDATION_REQUIRED` y el kernel lo
    difería (WAIT_UNTIL) o lo revalidaba con READs de plataforma antes de mirar el presupuesto. Ahora el
    presupuesto precede: con `degraded` (estado durable de la run, sin estado nuevo), `REVALIDATION_REQUIRED`
    no difiere, no espera ni emite READs; el borrador se registra `refused`
    (`response_authority_unverifiable`) por el mismo camino que cualquier borrador inválido posterior
    (`response.authority.suppressed`), sin outbound. Un borrador diferido antes de la degradación sigue su
    ciclo normal. Un borrador diferido después de una degradación (sólo posible con datos durables
    escritos por `80f63ff`) se rechaza al despertar, sin READ ni outbound.

    **Safe degradation exhausts response-authority recovery for authoritative claims for the remainder
    of that Run.** Tras la degradación, todo borrador cuyo veredicto trae uno o más claims de autoridad
    se registra `refused` (`response_authority_suppressed`) aunque el validador devuelva `ALLOW`: sin
    outbound, sin corrección, sin READ, sin `REVALIDATION_REQUIRED` efectivo y sin WAIT_UNTIL. Un
    borrador sin claims de autoridad conserva la semántica normal (continuidad conversacional, cierre o
    espera de la run). El kernel sólo cuenta los claims que el pack declara en el veredicto: no conoce
    Catalog ni reglas Sales, y no hay estado durable nuevo (`degraded` ya es derivado de los steps).

### Límites explícitos del parsing

La negación de disponibilidad es una lista cerrada y acotada (`availability-wording.ts`: "sin stock",
"no hay/haya stock", "no está disponible", "no es comprable", "agotado", …). No es un parser de lenguaje
ni una ontología: lo no listado no se reconoce y el borrador se corrige una vez (dirección segura).
Extenderla es agregar una frase con su test.

ADR-031 sigue sin ser: quality guard genérico, verificador LLM, framework de reintentos arbitrarios ni
workflow engine.

## Qué sigue prohibiendo ADR-025

Guards genéricos de calidad, reintentos arbitrarios, workflows ocultos y cualquier juez LLM dentro
del loop. Esta frontera no evalúa calidad ni estilo: sólo impide afirmar como verdad actual lo que
contradice o no puede respaldar la evidencia del owner.

## Límites conocidos

- No es un parser de lenguaje natural: afirmaciones comerciales sin ancla (sin monto ni nombre de
  producto observado) no se validan; el agente sigue siendo responsable de ellas y la evaluación
  post-hoc (ADR-025) las mide.
- La ambigüedad (mismo monto en varios productos) se resuelve con tolerancia: basta un producto
  coincidente consistente.
- Los claims permitidos se registran en telemetría (`response.authority.*`); los rechazados, en el
  step `refused`. El validador es determinista sobre estado durable, por lo que el veredicto es
  reproducible post-hoc.

## Consecuencias

- Una respuesta comercial ya no puede contradecir la sellability/variante/precio vigentes ni salir
  con evidencia vencida sin revalidar; el costo es un READ por producto vencido (≈ decenas de ms) y,
  sólo ante una contradicción real, una llamada adicional al modelo.
- Sin validador configurado (profile v1, tests, otros packs) el comportamiento es el anterior.
