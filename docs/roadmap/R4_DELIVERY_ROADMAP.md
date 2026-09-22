---
title: R4 — Delivery Roadmap
status: active
owner: architecture
last_reviewed: 2026-09-22
source: ../architecture/R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md §40
---

# R4 — Delivery Roadmap

Este roadmap operacionaliza el PRD §40. No autoriza avanzar de fase: cada fase
requiere autorización explícita (AGENTS.md).

## 1. Estado de fases

| Fase | Nombre | Estado |
|---|---|---|
| R4-A | Architecture Freeze | Parcial: Constitución + PRD existen; los contratos se congelaron en código en R4-B |
| **R4-B** | **Platform Skeleton** | **Completado en este repositorio (pendiente de revisión)** |
| R4-C | Agent Kernel + Context | No iniciado — requiere autorización |
| R4-D | Durable Execution | No iniciado |
| R4-E | Human Collaboration + Scheduler | No iniciado |
| R4-F | Sales Reference Application | No iniciado |
| R4-G | Quality & Learning | No iniciado |
| R4-H | Shadow Production | No iniciado |
| R4-I | Governed Production | No iniciado |
| R4-J | Sales Autonomy | No iniciado |
| R4-K | Platform Generalization Test (Marketing Analyst) | No iniciado |
| R4-L | Extended Platform | No iniciado |

## 2. R4-B — criterios de salida

| Criterio | Evidencia |
|---|---|
| Build | `npm run build` (`tsc -b`, project references) |
| Lint | `npm run lint` (typed ESLint + reglas de frontera) |
| Typecheck | `npm run typecheck` (repo completo, incluidos tests) |
| Unit | `npm run test:unit` |
| Contract / arquitectura | `npm run test:contract` |
| Integración (PostgreSQL real) | `npm run test:integration` |
| Migración desde BD vacía | `tests/integration/migrations.test.ts` |
| Restart de proceso | `tests/integration/restart-persistence.test.ts` |
| Restart del servidor PostgreSQL | `npm run test:recovery` |
| `/health`, `/ready` | tests de API + smoke documentado en README |
| Boot Docker/local y smoke de API | README |
| Documentos + ADR-001…005 | `docs/` |
| `git diff --check` | limpio |

## 3. R4-C — condiciones de entrada propuestas

No se inicia sin autorización. Antes de empezar conviene decidir:

1. Contrato `AgentDecision` (Respond, Read, ProposeAction, Delegate, Wait,
   ConsultHuman, RequestApproval, RequestHandoff, Complete) y cómo se valida con
   `parseStructuredOutput`.
2. Protocolo de acción: function calling nativo vs. acciones semánticas vs. híbrido
   (Constitución §27.11) — el gateway ya soporta ambos transportes.
3. Qué es un `AgentRunContext` y cómo se referencia desde `contextSnapshotRef`.
4. Dónde vive el loop de ejecución: `apps/worker` + reclamación de tasks
   (`FOR UPDATE SKIP LOCKED` sobre `agent_tasks_status_updated_idx`).
5. Consumo de budget: contadores de `agent_runs.usage` vs. techos de la task.

## 4. Decisiones diferidas intencionalmente

| Tema | Por qué se difiere | Seam existente |
|---|---|---|
| Autenticación / identidad del llamador | No hay consumidor todavía; no inventar un modelo de identidad | `PrincipalResolver`; `requested_by_*`, `actor_*` |
| Endpoints cancel/resume, turns, attention, artifacts, approvals | "No inventar endpoints de features no implementadas" | `TaskRuntime.transitionTask` (interno) |
| Worker / loop de ejecución | Requiere Agent Kernel (R4-C) | `startRun` / `finishRun` |
| Llamadas LLM reales y routing de modelos | R4-B prueba fronteras, no calidad | `ModelProvider` SPI |
| `AgentDecision` y protocolo de acción | Pregunta abierta de la Constitución | `parseStructuredOutput`, `ModelToolCall` |
| ActionProposal / Policy / Receipt / writes | R4-D | Invoker rechaza no-READ con `execution_not_permitted` |
| Retries de capabilities | Requieren clasificación de errores y receipts (R4-D) | `retryPolicy` en la definición; `attempts` en provenance |
| Leases/heartbeats de runs, detección de huérfanos | R4-D | `agent_runs.status`, índice `(status, updated_at)` en tasks |
| Checkpoints explícitos | R4-D | `version`, historia de transiciones, `contextSnapshotRef` |
| Outbox durable y catálogo público de eventos | Sin consumidor aún; evita infraestructura prematura | Eventos de telemetría con nombres estables |
| Artifact | Depende del modelo de tasks/ownership (Constitución §18) | — |
| Budgets de costo | Ownership de pricing/moneda sin decidir | `budgetSchema` extensible |
| Capability registry persistente / marketplace | No hay necesidad demostrada | Registry en memoria desde código |
| Deshabilitar/retirar versiones de agentes | No hay caso de uso | Nueva versión |
| Rehidratar `taskId/runId/agentId` en el contexto de logs de servicios | Llegará con el kernel | `withCorrelationFields` |
| Imagen Docker de la API / despliegue | "No hacer deployment" | `npm start` sobre `dist` |
