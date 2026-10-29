# ADR-044 — Turn Completion Guard: cierre conversacional explícito y steering durable

- **Identificador:** `R4-TURN-COMPLETION-GUARD-01`
- **Estado:** **Propuesto** (implementado en R4-J4-R7-2, rama `feat/r4-j4-r7-2-turn-completion-guard`; pendiente de
  G2 y de la revisión independiente). No desplegado.
- **Fecha:** 2026-10-29
- **Autoridad superior:** Constitución; PRD; ADR-008 (protocolo de decisión), ADR-015 (snapshots de contexto),
  ADR-028 (fallas de run recuperables, enmendado en R7-1)
- **Diseño:** `docs/architecture/R4_J4_R7_DESIGN.md` §2–§4 (aprobado en G0, condiciones 1–4)

## Contexto

Antes de R7-2, `complete` terminaba la task sin mirar las entradas (una entrada que llegó durante la run quedaba en
una task terminal). Un `wait` del agente sí despertaba ante una entrada **no vista**, pero cerraba sin registro ante
una entrada **vista y no respondida**. La semántica de un mensaje es del modelo (AD-01). El runtime no puede
clasificarlo, pero sí puede exigir que el silencio sea **explícito, informado y durable**.

## Decisión

1. **Obligación conversacional** (`TemporalPersistence.turnObligation`). Sólo hechos estructurales, sobre el snapshot
   `H` de la decisión de cierre:
   - Las entradas conversacionales son las `task_inputs` con `actor_kind = 'user'`.
   - `seen` es la regla de `hasUnseenInput`.
   - La frontera `L` es la última entrada.
   - `covered(L)` vale si un `respond` registrado vio `L` y su outbound no se descartó, o si existe
     `turn.closed_without_reply(L)`.
2. **`complete`** (`ExecutionRuntime.finishExecution` → `TemporalRuntime.completionWithin`, en la misma transacción):
   - Una entrada **no vista** difiere el cierre (`turn_input_unseen`).
   - Si `L` no está cubierta, la primera vez difiere el cierre (`turn_reply_pending`) y registra
     `turn.closure.reconsider(L)`.
   - Un segundo cierre de la **misma** `L`, con el episodio **incluido** en `H`, se acepta y registra
     `turn.closed_without_reply(L)`.
   - Diferir significa que la run termina como decidió el modelo y la task sigue `running`, sin run activa
     (`termination.details.turnGuard`). El siguiente claim inicia una run nueva, como en ADR-028.
   - Un request humano abierto, un efecto incierto o una intención terminal rechazan el cierre
     (`turn_closure_blocked`). Esa falla de plataforma lleva a la contingencia de R7-1.
3. **`WAIT_FOR_INPUT` del agente** (`TemporalRuntime.decide`). No aplica a la espera de plataforma que cierra el
   turno. Tampoco a `WAIT_UNTIL`, que no es un cierre: su timer es una reanudación verificable, no cubre nada y la
   entrada sigue pendiente para el próximo cierre.
   - UNSEEN sigue con el wake por horizonte existente.
   - Si `L` no está cubierta, la primera vez el step queda `refused` (`turn_reply_pending`), se registra el
     `reconsider` y la run continúa.
   - El segundo `wait` ratifica, igual que en `complete`.
4. **Episodio.** `interactionSource` proyecta cada `reconsider` como ítem OBSERVED `turn_closure:<eventId>`. El
   ítem nombra la entrada (`inputId`, `memoryItemId`, `receivedAt`) con texto fijo de plataforma.
5. **Ratificación, no verificación.** El evento lleva `basis: 'model_ratification'` y `policy: 'closure.v1'`.
   `hadPriorReply` y `trailingCount` son metadatos de auditoría: nunca deciden.
6. **Cotas.**
   - Una reconsideración por frontera: el evento sólo se registra si no existe.
   - Una entrada nueva es una frontera nueva e invalida la ratificación anterior.
   - Un diferimiento UNSEEN sólo se repite si llega otra entrada: `MemoryContextSource` carga todas las entradas.
   - Todo queda dentro de los presupuestos de la run. Al agotarse, aplica la contingencia de R7-1: handoff y aviso,
     nunca silencio.
7. **Modo `observe`** (`R4_TURN_GUARD=observe`, worker). Registra `turn.closure.would_defer` y
   `turn.closure.would_refuse` y se comporta como R7-1. Es la primera compuerta del canary y el rollback.

## Consecuencias

- Sin cambios en el protocolo `r4.agent_decision.v5`, en `KernelSession` ni en el kernel. Sin migración: los
  eventos usan `temporal_events`, de tipo libre. Sin procesos, colas, supervisor ni segundo modelo.
- Costo: una llamada extra por cierre silencioso legítimo, y una run extra si el cierre fue `complete`.
- Residuo (B1): el runtime acepta un silencio ratificado sobre una solicitud real. Se mide en G-sem
  (`R4_J4_R7_GSEM_PREREGISTRATION.md`), no en el runtime.
- Rollback: `observe` o redeploy. Las tasks diferidas son tasks `running` válidas para el código anterior.
