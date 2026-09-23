---
title: R4 — Ownership Matrix
status: implemented (R4-B, R4-C1) + planned rows
owner: architecture
last_reviewed: 2026-09-22
---

# R4 — Ownership Matrix

Cada primitiva tiene un único owner, una clase de autoridad, un ciclo de vida
definido y una semántica ante reinicio. Si una abstracción nueva no puede llenar
una fila de esta tabla, no entra en Core (PRD §43, Constitución §25.14).

Clases de autoridad:

- **Cognición** — lo decide el agente (modelo); nunca es verdad de negocio.
- **Autoridad de plataforma** — lo decide R4 de forma determinista.
- **Configuración** — declarado por humanos/packs; inmutable una vez registrado.
- **Evidencia** — registro inmutable de lo que ocurrió.
- **Dominio** — verdad de negocio; vive fuera de R4, detrás de capabilities.

## 1. Implementado en R4-B

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| AgentDefinition | `agent-registry` | Configuración | `agent_definitions` | Inmutable por `(agentId, version)`; `contentHash` | registrada → (nueva versión) | Re-sync verifica hash; tasks fijan versión | `unit/agent-registry`, `integration/agent-registry` |
| AgentTask | `task-runtime` | Autoridad de plataforma | `agent_tasks` | Sólo campos de lifecycle; `version` optimista | 8 estados, 3 terminales (ver arquitectura §4.2) | Durable; invariantes en esquema | `unit/task-runtime/lifecycle`, `integration/task-runtime` |
| Transición de task | `task-runtime` | Evidencia | `agent_task_transitions` | Append-only | — | Durable | `integration/task-runtime` |
| Idempotencia de creación | `task-runtime` (+ índice único) | Autoridad de plataforma | `agent_tasks.idempotency_*` | Write-once | — | Persiste entre reinicios | `integration/task-runtime`, `integration/restart-persistence` |
| Budget efectivo | `task-runtime` | Autoridad de plataforma | `agent_tasks.budget` | Write-once | — | Durable | `unit/task-runtime/budget` |
| AgentRun | `task-runtime` | Autoridad de plataforma (estado); cognición (contenido de `result`) | `agent_runs` | `running` → terminal una vez; `termination` estructurada | `running → completed/failed/cancelled/abandoned` (C1) | Run huérfano reanudado por el siguiente dueño (C1) | `integration/task-runtime`, `integration/execution-leases` |
| Goal | `task-runtime` (persistencia) | **Cognición** (contenido); plataforma (integridad) | `goals` | Estado una vez; texto inmutable | `active → achieved/abandoned/superseded` | Durable | `integration/task-runtime` |
| Current goal | `task-runtime` | Cognición (qué foco); plataforma (que sea un goal activo de la misma task) | `agent_tasks.current_goal_id` | Explícito | — | Durable | `integration/task-runtime` |
| CapabilityDefinition | Owner declarado (`owner`), gobernada por `capability-runtime` | Configuración | En memoria (desde código) | Inmutable por `(id, version)` | registrada en boot | Reconstruida deterministamente | `unit/capability-runtime/registry` |
| Autorización por scopes | `capability-runtime` | Autoridad de plataforma | — | — | — | Sin estado | `unit/capability-runtime/invoker` |
| TrustedExecutionContext | Plataforma (quien invoca) | Autoridad de plataforma | Derivado de task/run/definición durables | — | Por invocación | Reconstruible | `integration/capability-observations` |
| Observation | `capability-runtime` (crea), `persistence-postgres` (guarda) | Evidencia | `observations` | Inmutable; única por `invocationId` | — | Durable; replay idempotente | `unit/.../invoker`, `integration/capability-observations` |
| Salida de modelo | Modelo, vía `model-gateway` | **Cognición no confiable** | Nunca en crudo; sólo la `AgentDecision` validada (C1, `agent_run_steps.decision`) | — | — | — | `unit/model-gateway`, `unit/agent-kernel/decision-parser` |
| Selección de proveedor | `model-gateway` | Autoridad de plataforma | Configuración de proceso | — | — | Sin estado | `unit/model-gateway` |
| Correlación | `observability` | Autoridad de plataforma | Columnas `correlation_id` + logs | Write-once | Por request | En filas durables | `unit/observability`, `integration/api` |
| Principal / identidad | `apps/api` (`PrincipalResolver`) | Autoridad de plataforma | `requested_by_*`, `actor_*` | Write-once | Por request | Durable | `integration/api` |
| Esquema de BD | `persistence-postgres` | Autoridad de plataforma | `r4_schema_migrations` | Forward-only; checksums | — | Verificado en boot y `/ready` | `integration/migrations` |

## 1b. Implementado en R4-C1

| Concepto | Owner (paquete) | Autoridad | Almacenamiento | Mutabilidad | Ciclo de vida | Ante reinicio | Evaluación |
|---|---|---|---|---|---|---|---|
| TaskLease (ownership de ejecución) | `task-runtime` (`ExecutionRuntime`) | Autoridad de plataforma | `agent_tasks.lease_*` | Owner/expiración mutables; `generation` sólo crece | claim → renew* → release \| expira | Expira en reloj de BD; otro worker toma el relevo | `unit/task-runtime/execution-lifecycle`, `integration/execution-leases` |
| Fencing token | `task-runtime` | Autoridad de plataforma | `agent_tasks.lease_generation` | Monótono | +1 por claim | Durable | `integration/execution-leases` |
| RunStep (iteración del loop) | `task-runtime` (escribe), `agent-kernel` (propone) | Evidencia (qué se decidió y qué hizo la plataforma) | `agent_run_steps` | Append-only salvo `pending → observed` | `pending → observed`; resto terminal | Base de la reconstrucción del loop | `unit/contracts/...`, `integration/worker-*` |
| AgentDecision | Modelo (propone), `agent-kernel` (valida) | Cognición validada por plataforma | En su step | Inmutable | — | Durable | `unit/agent-kernel/decision-parser` |
| RunTermination | `task-runtime` | Autoridad de plataforma | `agent_runs.termination_*` | Write-once | al terminar el run | Durable | `unit/.../execution-lifecycle`, `integration/worker-kernel` |
| ExecutionContext (contexto mínimo) | `agent-kernel` (`buildExecutionState`) | Autoridad de plataforma (qué se muestra) | Derivado; no se persiste | — | Por iteración | Reconstruido desde estado durable | `unit/agent-kernel/context-and-request` |
| ExecutionPolicy (límites) | `apps/worker` (config) + budget de la task | Configuración | Entorno (`R4_EXEC_*`) | Por proceso | — | Recargada al arrancar; consumo en el step log | `unit/agent-kernel/budget`, `unit/worker/config` |
| Worker | `apps/worker` | Ejecutor (sin autoridad) | Ninguno propio (lease en BD) | — | start → poll/claim/execute → stop (libera lease) | Reemplazable; otro worker reanuda | `integration/worker-*`, `recovery/worker-process-crash` |

## 2. Planificado (sin implementar; owner candidato)

| Concepto | Fase | Owner candidato | Autoridad |
|---|---|---|---|
| Context Compiler / AgentRunContext / snapshot | R4-C2 | `context-compiler` | Plataforma (selección observable) |
| Working memory / proyección de conversación | R4-C2 | `memory` | Cognición efímera; nunca verdad |
| Decisiones Delegate / Wait / ProposeAction / Consult / Approval / Handoff | R4-D/E | `agent-kernel` + contracts | Cognición (propuesta) |
| ActionProposal | R4-D | kernel → `capability-runtime` | Cognición (propuesta) |
| Policy decision | R4-D | `policy-engine` | Plataforma |
| ActionReceipt | R4-D | `capability-runtime` | Evidencia |
| Checkpoints de efectos, cancelación cooperativa de efectos | R4-D | `task-runtime` | Plataforma |
| Consultation / Approval / Handoff | R4-E | `human-collaboration` | Humano (decisión) + plataforma (estado) |
| Scheduler / wake-ups | R4-E | `scheduler` | Plataforma (despierta; no decide) |
| Artifact | R4-C/E (a decidir) | `artifacts` | Evidencia versionada |
| Outbox / eventos públicos | con primer consumidor | `persistence-postgres` + `observability` | Plataforma |
| Evaluation / Finding / FailureCluster | R4-G | `evaluation` | Plataforma + rúbricas de packs |
| Conceptos Sales (quote, cart, …) | R4-F | `agents/sales` + domain adapters | **Dominio**, nunca Core |
