# ADR-017 — Frontera de la Policy Engine

- **Estado:** Aceptado (R4-D)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §9, §10 (permisos y autonomía nunca se delegan al LLM), §11, §25.1–25.3; PRD §10, §11; ADR-002, ADR-016

## Contexto

La decisión de si un efecto puede ocurrir debe ser de la plataforma,
determinista, auditable y explicable después de que la política cambie. No
debe depender del modelo, de lenguaje natural ni de conceptos de dominio.

## Decisión

### Paquete y dependencias

`packages/policy-engine` depende sólo de `@r4/contracts` y `zod` (verificado
por allow-list y ESLint: sin `node:*`, sin persistencia, runtimes, kernel,
modelo ni observabilidad). Es puro: la misma entrada y configuración
producen siempre la misma evaluación.

El **puerto** `ActionAuthorizer` y los tipos `PolicyInput`/`PolicyEvaluation`
viven en `contracts`; `task-runtime` depende del puerto, nunca del motor. El
worker (composition root) inyecta `ActionPolicyEngine`.

### Quién la llama

Sólo `ActionRuntime.authorizeAction`, **dentro de la transacción fenced** que
persiste la decisión y su consecuencia (comando | observation | suspensión).
El llamador no puede aportar una decisión: el runtime la obtiene del motor.
Defensa en profundidad: un `allow` sobre un READ o sobre un write sin
semántica segura se rechaza como fallo de plataforma.

### Entrada (sólo hechos de plataforma)

`proposal {proposalId, evidenceRefs}` · `agent {agentId, version,
capabilityScopes}` · `task {taskId, status}` · `TrustedActionContext`
(construido por el runtime desde task/run/agente durables:
`actor = task.requestedBy`, `identityAssurance = identityAssuranceOf(actor)`) ·
metadata de la capability registrada + su `writeRecovery`. Los **argumentos
no entran**: la política no interpreta contenido.

### Reglas (conjunto tipado, no DSL; primera que decide gana)

1. `READ` → DENY `not_a_write`
2. task no `running` → DENY `task_not_running`
3. contexto de otra task/agente → DENY `context_mismatch`
4. scopes faltantes (en el contexto confiable **o** en la definición) → DENY `scope_denied`
5. sin estrategia de recuperación o sin `idempotency: key_required` → DENY `unsafe_write_semantics`
6. `identityRequirement` > `identityAssurance` → DENY `identity_requirement_unmet`
7. regla (override por capability, si no por clase): `minimumIdentity` → DENY `insufficient_identity`
8. `requireEvidence` sin `evidenceRefs` → DENY `evidence_required`
9. `autonomy: deny` → DENY `risk_class_not_permitted`
10. `approvalPolicy: required` → REQUIRE_APPROVAL `capability_requires_approval`
11. `confirmationPolicy: required` → REQUIRE_APPROVAL `confirmation_required`
12. `autonomy: require_approval` → REQUIRE_APPROVAL `risk_class_requires_approval`
13. ALLOW `autonomous`

Las denegaciones estructurales van primero: nunca se pide a un humano aprobar
algo que la plataforma no podría ejecutar de forma segura.

### Configuración, versión y auditoría

`ActionPolicyConfiguration {policyId, version, riskClasses (las cinco clases
de escritura, obligatorias), capabilities (overrides)}`. Identidad =
`(policyId, version, sha256 de la forma canónica con defaults, engineVersion)`,
persistida en **cada** `policy_decisions` junto con capability, versión,
clase de riesgo, agente/task, resultado, `reasonCode`, `rule` y
`identityAssurance`. Una decisión histórica sigue explicándose tras cambiar
la política. Sin chain-of-thought.

`DEFAULT_ACTION_POLICY` (conservadora, ejemplo genérico, no política
universal): REVERSIBLE_WRITE allow · IRREVERSIBLE_WRITE require_approval ·
FINANCIAL require_approval + `minimumIdentity: verified` (⇒ DENY en R4-D,
donde nada es `verified`) · EXTERNAL_COMMUNICATION require_approval ·
PRIVILEGED deny. Un deployment inyecta la suya por `WorkerBindings.actionPolicy`.

### REQUIRE_APPROVAL en R4-D

Persiste decisión + observation, **no ejecuta**, termina el run como
`suspended` (`approval_required`), pasa la task a `requires_approval` y libera
el lease, todo atómico. No hay ApprovalRequest, API ni UI: el flujo humano es
R4-E, que parte de la decisión y la propuesta durables.

## Consecuencias

- DENY produce una observation y el agente puede replantear; no termina el run.
- `confirmationPolicy: required` se trata como aprobación humana requerida
  porque R4-D no tiene mecanismo de confirmación; R4-E decide el suyo.
- No existe `tenant` en R4: no se inventó.
