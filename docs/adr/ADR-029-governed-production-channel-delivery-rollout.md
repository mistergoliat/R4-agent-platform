# ADR-029 — Producción gobernada: frontera de canal, entrega durable e idempotente, rollout y kill switch (R4-I)

- **Estado:** Propuesto (R4-I en progreso; pendiente de auditoría)
- **Fecha:** 2026-09-24
- **Baseline:** R4 POST-H RECOVERY BASELINE `dd06a68ff078a18a81e3dd12f5fd0ca5ef177ec9`
- **Autoridad superior:** Constitución; PRD §19 (canales), §40 (R4-I); ADR-002, 005, 008, 016–018, 021, 023, 025, 027, 028
- **Prerrequisito:** [Auditoría del WhatsApp de CRM-Customer-360](../architecture/R4-I_CRM_WHATSAPP_AUDIT.md) (decisiones D-1…D-4)

## Contexto

Hasta H, `respond` era una decisión durable que nadie entregaba (H la
registraba en un sink shadow). ADR-028 dejó abierto: *si un `respond` se
entrega por un canal real y la run falla después, la recuperación podría
responder otra vez*. R4-I debe operar contra usuarios e integraciones reales
sin perder idempotencia, ownership humano, privacidad ni control de efectos,
y sin que Core conozca canales ni dominios. La auditoría del CRM mostró la
semántica probada a conservar (dedupe por id del proveedor, take over que
cancela envíos pendientes, ventana de 24 h, estados monótonos, respuesta
manual) y sus límites (timeouts y 5xx se reintentan ⇒ duplicados posibles;
adjuntos se vacían; inbound no elegible se descarta; payload crudo guardado).

## Decisión

1. **Modo de producción explícito, fail-closed.** `R4_EXECUTION_MODE`
   distingue `test` (nada declarado), `shadow` (R4-H) y `production`. Una
   composición de producción exige el modo, el perfil de política declarado
   (`R4_PROD_POLICY_PROFILE`, igual al compuesto), el rollout explícito
   (`R4_PROD_ROLLOUT_PERCENT`, aun 0), la llave de hash de identidades y el
   opt-in de red booleano. Sin cualquiera de ellos, nada se compone. Los
   secretos nunca entran en la configuración ni en su fingerprint.

2. **Frontera de canal neutral.** `@r4/live-ops` define `CanonicalInbound`,
   `ProviderStatusEvent`, `InboundChannelAdapter` y `OutboundChannelAdapter`;
   un adapter concreto (fuera de Core: `adapters/channels/whatsapp-cloud`)
   traduce transporte y no es dueño de task, goal, decisión ni estado de pack.
   Core de ejecución no cambia su cognición: el kernel, el protocolo v4, el
   parser y el gateway de modelo quedan intactos.

3. **Ingress canónico.** Webhook → autenticación (firma, fail-closed) →
   canonicalización → dedupe durable por identidad del evento del proveedor
   (`UNIQUE(channel, provider_event_id)`; re-entregas sólo incrementan un
   contador) → binding de conversación → input canónico. Sin modelo, dominio
   ni entrega dentro del request. Un item auténtico pero no canonicalizable
   se registra `rejected` y se acusa (sin loop de reintentos).

4. **Task creada con su primer input, atómicamente (cambio mínimo de Core).**
   `TaskRuntime.createTask` se separa en `prepareCreate` + `createWithin` y
   `TemporalRuntime.createTaskWithInput` crea la task y registra su primer
   input en UNA transacción: ningún worker puede reclamar una conversación
   vacía. Es genérico (sin canal ni dominio) y cierra una carrera real que en
   producción habría generado respuestas no solicitadas.

5. **Hold de plataforma (cambio mínimo de Core).** `holdForHumansWithin`
   generaliza el handoff de plataforma de ADR-028: la plataforma entrega una
   task a humanos con un código de razón (`autonomy_disabled`,
   `autonomy_denied`, `rollout_excluded`, `unsupported_inbound_content`),
   visible en `/v1/attention`, suspendiendo una run activa. `submitInput`
   acepta `hold`, aplicado ANTES de registrar el input en la misma
   transacción: el input nunca despierta trabajo autónomo y nunca se pierde.

6. **`ConversationBinding`** (integración, no Core): a lo sumo UNA binding
   abierta por conversación (índice único parcial). Trabajo recuperable
   (ADR-028) ⇒ misma task. Trabajo terminal (completed/cancelled/failed o
   intención terminal) + contacto nuevo ⇒ binding y task nuevas; sin
   resurrección ni memoria cruzada. La elegibilidad de rollout se decide una
   vez al abrir la binding (cohorte estable).

7. **`respond` ≠ entregado. Un único dueño de la entrega.**
   `OutboundDeliveryRuntime` materializa un `OutboundMessage` por cada
   `respond` aceptado (`UNIQUE(response_step_id)`; clave de idempotencia
   `r4-out:<stepId>`). Reprocesar el mismo step recupera esa fila durable;
   la unicidad no depende del contenido. `OutboundDeliveryRuntime` es dueño
   de todo su ciclo:
   `pending → dispatching → accepted → delivered → read`, `failed`,
   `unknown`, `cancelled`. Claim con `FOR UPDATE SKIP LOCKED` + lease +
   generación (fencing); gate evaluado en la transacción del claim; intento
   durable ANTES de la llamada al proveedor; resultado registrado con
   fencing. El kernel, el pack, el webhook y el worker nunca envían.

8. **Honestidad del resultado.** Sólo "definitivamente no enviado" (conexión
   rechazada, DNS, 429) se reintenta, con presupuesto acotado e independiente
   de `maxRunFailureRecoveries`. Timeout, reset tras conectar, 5xx, 2xx sin
   id o un proceso muerto durante la llamada (lease vencida) ⇒ `unknown`,
   nunca reintentado a ciegas; sólo evidencia del proveedor o un operador lo
   resuelven. Meta no documenta clave de idempotencia: no se afirma
   exactly-once; se garantiza un intent durable, sin despacho duplicado
   silencioso y `unknown` honesto.

9. **Reconciliación monótona.** Callbacks idempotentes por clave de evento
   (append-only); `statusAfterEvidence` nunca retrocede (delivered → accepted
   imposible; failed no pisa delivered; delivered sí supera failed); la
   evidencia que llega antes de conocer el id del proveedor se aplica cuando
   se registra.

10. **ADR-028 sin duplicados.** Una run de recuperación produce steps nuevos:
    nunca re-despacha un outbound existente. Una respuesta del agente sólo
    nace `cancelled/duplicate_content` si coinciden exactamente el texto, el
    Task y el último input inbound incluido en ambos ContextSnapshots, y el
    snapshot nuevo incluye todos los inputs durables al materializar. La
    comparación usa `context_snapshot_id` del step y los IDs inmutables de
    `context_snapshot_items`, enlazados con `task_inputs`; no usa una ventana
    temporal. Los outbounds de origen agente en estado pending, dispatching,
    accepted, delivered, read, unknown o failed con `provider_message_id`
    representan el episodio; cancelled y failed sin ese ID no. Un input
    posterior, otro Task u origen operator permite el mismo texto. El bloqueo
    de la fila Task serializa la comprobación con
    escrituras de inputs y otros materializadores.
    La cognición siguiente recibe un episodio OBSERVED con el estado de
    entrega de respuestas no confirmadas (`production.delivery`).

11. **Gate de entrega (precedencia).** Salida del agente: kill switch > deny
    > rollout > ownership humano (cancela `superseded_by_operator`, semántica
    del CRM) > task terminal / binding cerrada > respuesta obsoleta
    (`superseded_by_newer_input`: un input que el snapshot que produjo la
    respuesta nunca evaluó; causal, no por reloj; D-3) > antigüedad > ventana
    del canal. Salida del operador: sólo la ventana. Nunca se cancela
    retroactivamente algo `dispatching/accepted/delivered/read/unknown`.

12. **Kill switch durable.** `autonomy_controls` (scope `global` y opcional
    `channel:<id>`), creado DESHABILITADO por la migración; lectura fallida =
    deshabilitado. Detiene: nuevos claims (admisión del worker, antes de cada
    claim), despacho automático (retiene, no cancela), trabajo autónomo por
    inbound (hold). No borra ni pierde nada; cambios auditados (append-only).

13. **Rollout estable.** Identidad = HMAC(llave, canal, cuenta, conversación);
    allowlist/denylist sólo como hashes; porcentaje por bucket estable.
    Default: 0 % y allowlist vacía. Deny > allowlist > porcentaje.

14. **Perfil de producción versionado.** Declara estado de cada dominio
    (`REAL | SANDBOX | INTERNAL | UNAVAILABLE`; `FIXTURE/SHADOW` rechazados),
    decisiones de escritura (ALLOW / REQUIRE_APPROVAL / DENY, aplicadas por
    R4-D) y política de contenido no soportado. Sólo se registran capabilities
    disponibles; perfil y rollout quedan fingerprinted en cada binding y
    outbound. Sales v1: Customer/Catalog/Shipping/Quote UNAVAILABLE (sin
    contrato verificable en R4), workspace INTERNAL, `quote.create`
    REQUIRE_APPROVAL, WhatsApp REAL (canary), contenido no soportado ⇒ humano.

15. **Operador (sólo API).** Hilo con cursor incremental (el "streaming" del
    CRM es polling del estado durable), conversaciones, atención, inspección
    de outbound (intentos, evidencia), respuesta manual (take over + cancela
    envíos pendientes del agente + outbound de origen operador), resolver
    `unknown` con evidencia, cancelar pendiente, kill switch. Identidad sólo
    vía `TrustedHumanContext`; scope nuevo `autonomy.control`.

16. **Procesos.** `apps/channel-gateway` es el único proceso que habla con el
    proveedor (webhooks + dispatcher, apagado ordenado). El worker de
    producción es el worker de siempre con bindings de producción. Ninguno
    arranca sin perfil, adapters del tipo declarado, esquema al día y
    controles legibles.

17. **Autoridad del canal.** El número productivo existente permanece bajo
    CRM-Customer-360. Para el número canary que recibe directamente R4, R4
    conserva el estado operacional requerido para ejecutar su Task: inbound
    canónico, binding, Task inputs/hilo, outbounds y estados de entrega. La
    identidad maestra y el historial CRM permanecen externos; R4-I no
    sincroniza el hilo con CRM.

18. **Persistencia: 0007** (`autonomy_controls`, `autonomy_control_events`,
    `channel_conversation_bindings`, `inbound_events`, `outbound_messages`,
    `outbound_delivery_attempts`, `outbound_delivery_events`), owner
    `@r4/live-ops` vía su port; SQL en `persistence-postgres`. Sin payload
    crudo; texto y dirección del inbound se borran al quedar durables en la
    task/binding. 0001–0006 intactas.

## Alternativas descartadas

- *`propose_action(send_message)` para responder*: rompe ADR-008 y mezcla
  cognición con transporte; la gobernanza de la entrega vive en su frontera.
- *Enviar desde el kernel o el worker*: dos owners, sin fencing propio.
- *Reintentar timeouts/5xx (comportamiento del CRM)*: duplica mensajes reales.
- *Puente CRM→R4→CRM*: dos dueños de la entrega (D-1: descartado).
- *Crear la task y luego enviar el input*: el worker puede correr sobre una
  conversación vacía (carrera real); se crea con su input en una transacción.
- *Juez LLM antes de enviar*: nueva responsabilidad de runtime; Quality sigue
  post-hoc (ADR-025).

## Consecuencias

- Un timeout real puede dejar al cliente sin respuesta hasta un callback o un
  operador (preferible a un duplicado). Visible en atención.
- Tras soltar el kill switch, las tasks retenidas siguen con humanos hasta que
  un operador las libera (no hay liberación masiva en R4-I).
- La paridad de UI con el CRM es bloqueante antes de migrar el número
  productivo (D-1); R4-I opera un número canary propio.

## Verificación

`tests/unit/live-ops/*`, `tests/contract/live-ops-boundaries.test.ts`,
`tests/integration/live-ops-{reference,hardening}.test.ts`,
`tests/recovery/live-ops-process-crash.test.ts` (SIGKILL real),
`npm run test:mutation:production`, `npm run production:sales:validate`.
