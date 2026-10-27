---
title: R4-J4-R6 EV-2 — Una task nunca se ejecuta con un perfil incompatible con su fijación
status: for-independent-review
mandate: R4-J4-R6 Final Blocker Closure (owner, 2026-10-27), Workstream B
date: 2026-10-27
base: main dfe7275
---

# EV-2: ejecución fijada al perfil de la task

## 1. Qué pasó

En el canary J4-R5, tras el rollback `@8 → @7`:
- la task `01a17994`, creada con la definición Sales **v8**, siguió ejecutándose en el worker `@7` (runs 9 y 10, 19:58);
- usó las instrucciones v8 con el registro de capacidades de `@7`;
- su lectura de Customer falló cerrada (`unknown_capability`).

No hubo acceso a datos, pero la task corrió con un perfil que no era el suyo. Evidencia:
`R4_J4_R5_EVIDENCE_VERIFICATION.md` §4.

## 2. Frontera exacta

| Paso | Dónde | Qué hacía |
|---|---|---|
| Fijación | `salesConversationTaskFactory` (`agents/sales/src/production/composition.ts`) | La task nace con `agentId`/`agentVersion` = la definición del perfil del gateway |
| Selección | `claimRunnableTask` (`packages/persistence-postgres/src/execution-store.ts`), vía `ExecutionRuntime.claimNext` | Tomaba **cualquier** task ejecutable, sin mirar su versión |
| Reanudación | `ExecutionRuntime.#newRun` / takeover | La run hereda `task.agentVersion` |
| Definición | `DurableKernelSession.#agentOf` (`apps/worker/src/session.ts`) | Resuelve `agentId@agentVersion` en el registro compartido, donde están `@3`–`@8` |
| Capacidades | `bindings.capabilities` del worker | Las del perfil del **worker** (`@7`) |
| Reconciliación | `claimReconciliation` (`temporal-store.ts`), vía `Reconciler` | Reconciliaba efectos de cualquier task con el registro del worker |

El cruce ocurre en la **selección**: definición de la task y capacidades del worker de otro perfil.

## 3. Invariante y corrección

**Una task nunca se ejecuta (ni se reconcilia) con un perfil de runtime incompatible con su definición fijada.**
Compatibilidad: el worker declara las definiciones que sirve (`servedAgents`) y solo toma tasks fijadas a una de
ellas. Cada perfil Sales sirve exactamente su definición (`salesProductionAgentVersion`). Los perfiles que comparten
definición (`@1`/`@2` → v3, `@3`/`@4` → v4) son compatibles por construcción.

| Cambio | Archivo |
|---|---|
| Tipo `ServedAgents` y parámetro opcional `served` en `claimRunnableTask` y `claimReconciliation` | `packages/task-runtime/src/ports.ts`, `temporal-ports.ts` |
| `ClaimCommand.served`; `ActionRuntime.claimReconciliation({ served })` | `execution-runtime.ts`, `action-runtime.ts` |
| Filtro SQL `(agent_id, agent_version) ∈ served` en ambas selecciones (SKIP LOCKED intacto) | `persistence-postgres/src/execution-store.ts`, `temporal-store.ts` |
| `WorkerBindings.servedAgents` → `Worker` y `Reconciler` | `apps/worker/src/platform.ts`, `worker.ts`, `reconciliation.ts` |
| La composición Sales (producción y canary) declara `[{ sales, versión del perfil }]` | `agents/sales/src/production/composition.ts` |
| `status` del canary: `openTasksByDefinition` | `agents/sales/src/cli/canary/runtime.ts` |

- **Sin cambios en el kernel** (`packages/agent-kernel`), en el parser, en el protocolo v5 ni en la autorización de
  acciones. Los puntos de extensión existentes no alcanzaban: `admission` decide por worker, no por task, y la
  sesión se construye después de que el claim ya creó la run.
- **Sin migración.** Sin `servedAgents`, el worker sirve toda definición, como antes (runtimes sin perfil, tests).

**Qué pasa con una task incompatible:**
- **Durable:** su estado, inputs y runs quedan intactos (`pending`, `running` sin run activa, `waiting` o `blocked`).
- **Observable:** `sales:canary status` → `openTasksByDefinition` (p. ej. `{"sales@8": 2, "sales@7": 1}`).
- **Recuperable:** un worker compatible la toma; si el lease venció, la toma por takeover de la misma run. Si no,
  la toma un operador (handoff o cancelación).
- **Rollback de emergencia:** sigue siendo posible. Las tasks `@8` simplemente esperan; nunca se degradan en
  silencio a `@7`.

## 4. Pruebas

`tests/integration/profile-pinned-claims.test.ts` (PostgreSQL, workers reales):

| Escenario | Prueba |
|---|---|
| Selección | Un worker incompatible no toma la task (sigue `pending`, 0 llamadas al modelo); uno compatible la ejecuta |
| Lista vacía / sin perfil | `[]` no toma nada; sin lista, comportamiento previo |
| Rollback + suspensión + reinicio | Task en `waiting` con el perfil original; rollback; llega un input; el worker del otro perfil queda `idle` (×3) y no crea runs; el worker compatible reiniciado la completa. Todas las runs con la versión fijada |
| Recuperación (takeover) | Lease vencido: el incompatible no lo toma (el dueño no cambia); el compatible reanuda la **misma** run |
| Reconciliación | Efecto incierto: el worker incompatible no reconcilia (0 llamadas, schedule `dispatched`); el compatible lo resuelve |

Además, `tests/contract/sales-profile-v8.test.ts`: `@8` sirve `sales@8` y `@7` sirve `sales@7`.

**Mutación:** con el filtro SQL anulado (`true or …`) en ambas selecciones, fallan las 5 pruebas de integración.
Fuentes restauradas.

## 5. Lo que no cambia

- El rollback de producción sigue siendo J7.
- La respuesta al cliente de una conversación `@8` durante un rollback depende del operador (handoff). El aviso
  determinista es otro asunto (PR #27) y no cuenta como evidencia de confiabilidad.
