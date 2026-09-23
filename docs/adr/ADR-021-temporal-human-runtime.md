# ADR-021 — Runtime temporal y humano (R4-E)

- **Estado:** Aceptado en el working tree de R4-E (pendiente de auditoría y commit)
- **Fecha:** 2026-09-23
- **Baseline R4-D:** `39906521eb85d5eeeb4fbf71b6f619605864c80c`
- **Autoridad superior:** Constitución; PRD §14–17, §40; ADR-002, 003, 007, 011, 012, 013, 016–020
- **Relacionado:** ADR-022 (scheduler, reconciliación y autoridad del tiempo)

## Contexto

Hasta R4-D una task vivía mientras corría su run: no podía esperar input,
tiempo ni a un humano, `REQUIRE_APPROVAL` dejaba la task sin salida y un
efecto incierto la bloqueaba para siempre. R4-E debe permitir esperar,
reanudar tras crashes, consultar, aprobar y transferir ownership a humanos
sin convertir el runtime en un workflow determinístico ni debilitar C1/C2/D.

## Decisión

1. **El modelo sólo pide.** `AgentDecision` (protocolo `r4.agent_decision.v3`)
   agrega `wait` (`WAIT_FOR_INPUT`, `WAIT_UNTIL`), `request_consultation`,
   `request_handoff` y `manage_goal`. Esquemas estrictos: ningún campo de
   identidad, owner, generación, timestamp confiable, versión o estado.
2. **`TemporalRuntime` en `task-runtime`**, no paquetes `scheduler` /
   `human-collaboration` separados: esperas, input, decisiones humanas,
   takeover, cancelación y goals comparten el lock de la fila de la task y las
   transiciones atómicas de task/run/lease. Separarlos agregaría fronteras sin
   ownership de estado independiente.
3. **Esperas durables.** Una espera suspende la run (`waiting` /
   `human_handoff`), libera el lease y abre un único `TaskWait`. Reanudar =
   run nueva (la recuperación same-run de C1 sigue igual para runs caídas).
   `WAIT_UNTIL` es interrumpible por input relevante: el input despierta,
   cierra la espera (`resolution = input`) y cancela el timer.
4. **Input canónico** (`task_inputs`), neutral de canal e idempotente por
   (task, source, externalKey); su texto es memoria CONVERSATIONAL (el seam de
   ingestión de C2). Un input que llegó durante la decisión de esperar y que el
   snapshot de esa decisión no evaluó satisface la espera de inmediato.
5. **Colaboración humana.** `human_requests` (consultation, approval,
   handoff) con decisiones append-only en `temporal_events` (idempotentes por
   request + responseKey; una sola decisión terminal por request). Identidad
   humana = `TrustedHumanContext` del adapter de autenticación; sin adapter la
   API refusa (no hay IAM productivo, y no se simula). Consultation y approval
   conservan la ownership semántica del agente; el handoff la transfiere.
6. **Approval = evidencia, no ALLOW.** La aprobación, ligada a propuesta,
   versión de capability y hash de argumentos validados, alimenta una **nueva**
   evaluación de la Policy Engine sobre la misma propuesta; la decisión
   `REQUIRE_APPROVAL` original permanece. Rechazo/expiración/retiro producen
   una Observation de acción (`approval_rejected|expired|cancelled`) con
   `proposalId` y `approvalRequestId`, antes de que el agente vuelva a razonar.
   `load()` de la sesión es observacional: la propuesta de una run anterior se
   entrega al kernel como acción pendiente y se resuelve por `executeAction`.
7. **Handoff del agente o del operador.** El takeover de un operador suspende
   la run activa en la misma transacción y reemplaza la espera abierta. Con un
   handoff pedido o activo, un trigger impide `running` y claims autónomos y el
   runtime rechaza wakes. La ownership se proyecta (`owner`, `humanRef`,
   `blockedBy`, `terminalIntent`), así `blocked` nunca es ambiguo.
8. **Nunca terminal con un efecto incierto.** Cancelar (o fallar una run
   abandonada) con un efecto en vuelo o `needs_reconciliation` registra una
   intención terminal durable y deja la task `blocked`; se aplica cuando la
   reconciliación establece el resultado. Impuesto también por trigger.
9. **Goals mínimos.** Sobre raíz / foco / padre existentes: `create`,
   `focus`, `complete`, `abandon`, validados por el runtime (existe, es de
   esta task, está activo; el foco nunca se mueve implícitamente). Una
   referencia inválida del modelo es un rechazo recuperable (step `refused` +
   episodio en el contexto siguiente), nunca la falla de la task. Historia en
   `goal_transitions` (append-only, con backfill). `manage_goal` no pasa por la
   Policy Engine: es estado cognitivo, no un efecto.
10. **Continuidad por el Context Compiler.** `platform.interaction` proyecta
    registros durables existentes (steps de todas las runs, requests humanas,
    decisiones humanas, esperas) — no duplica en memoria —, y compite por
    budget/compaction como cualquier conversación. `platform.goal` expone raíz
    y foco vivos; los goals cerrados son episodios de historia.

## Consecuencias

- Una task puede esperar días, recibir input o humanos, y reanudar en otro
  proceso sin perder objetivo, foco ni la conversación previa.
- La colaboración humana no tiene ningún camino a comandos, intentos ni
  receipts: sólo `ActionRuntime` (tests de contrato).
- El texto humano nunca es AUTHORITATIVE ni estado de dominio.
- Cambios a tests de fases previas (todos por extensión de contrato) listados
  en el roadmap §3.6.

## Diferido (R4-F+)

Jerarquía óptima de goals, planning automático, memoria semántica de largo
plazo, IAM productivo, Operator UI, adapters de canal, política productiva de
follow-up, delegación multi-agente, Quality Auditor.
