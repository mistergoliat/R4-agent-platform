# R4 Agentic Platform

## Product Requirements Document & Delivery Roadmap

**Status:** Architecture candidate for freeze
**Version:** 0.1.0
**Parent:** `R4_AGENTIC_PLATFORM_MOTIVATION_AND_CONSTRAINTS.md`
**Constitution baseline:** `686874c74ff99c157c12841bb40b26b321441085`
**Initial reference application:** PesasChile Sales Agent
**Primary objective:** construir una plataforma agéntica reusable, independiente del CRM, capaz de soportar agentes customer-facing e internos con autonomía operacional gobernada.

---

# 1. Product definition

R4 es una plataforma para ejecutar agentes de IA que pueden:

* perseguir goals;
* razonar y modificar estrategia;
* consultar información;
* utilizar capabilities;
* delegar;
* esperar y reanudarse;
* generar artifacts;
* solicitar ayuda humana;
* producir side effects gobernados;
* recuperarse de fallos;
* ser evaluados continuamente.

Su principio fundamental es:

```text
Dynamic Agency
+
Deterministic Authority
+
Durable State
+
Verifiable Execution
+
Continuous Evaluation
```

R4 no es el Sales Agent.

El Sales Agent es la primera aplicación construida sobre R4.

---

# 2. Product thesis

El modelo debe tener libertad para decidir:

```text
qué entiende
qué intenta conseguir
qué necesita investigar
qué capability utilizar
qué estrategia seguir
si debe replantear
si necesita delegar
si necesita ayuda humana
cómo sintetizar una respuesta
```

La plataforma conserva autoridad sobre:

```text
identidad
permisos
estado canónico
idempotencia
concurrencia
políticas
acciones ya ejecutadas
side effects
aprobaciones
cancelación
recovery
auditoría
evidencia
```

El modelo propone.

La plataforma gobierna.

El dominio determina la verdad.

La ejecución produce evidencia.

---

# 3. Architectural boundary

R4 será un sistema independiente de `CRM-Customer-360`.

Arquitectura objetivo:

```text
                   EXPERIENCE PLANE
┌─────────────────────────────────────────────────────┐
│ CRM-Customer-360                                    │
│                                                     │
│ Hub                                                 │
│ Customers                                           │
│ Opportunities                                       │
│ Agents                                              │
│ Tasks                                               │
│ Attention                                           │
│ Approvals                                           │
│ Handoffs                                            │
│ Quality                                             │
│ Analytics                                           │
└─────────────────────────┬───────────────────────────┘
                          │
                     R4 Public API
                          │
                          ▼
                  AGENT PLATFORM PLANE
┌─────────────────────────────────────────────────────┐
│ R4                                                  │
│                                                     │
│ Gateway                                             │
│ Agent Registry                                      │
│ Agent Kernel                                        │
│ Task Runtime                                        │
│ Context Compiler                                    │
│ Memory Runtime                                      │
│ Artifact Runtime                                    │
│ Capability Runtime                                  │
│ Policy Engine                                       │
│ Model Gateway                                       │
│ Scheduler                                           │
│ Human Collaboration                                 │
│ Evaluation / Quality                                │
│ Learning Pipeline                                   │
│ Observability                                       │
└───────────────┬─────────────────┬───────────────────┘
                │                 │
        CHANNEL PLANE        DOMAIN PLANE
                │                 │
        WhatsApp              Customer
        Instagram             Catalog
        Web                   Shipping
        Voice                 Quote
        Email                 Payment
                              Order
```

R4 no importa código desde CRM.

CRM no importa código interno desde R4.

No comparten tablas como contrato.

La integración ocurre exclusivamente mediante APIs y eventos públicos.

---

# 4. Independence invariant

R4 debe poder ejecutar tasks aunque el CRM esté apagado, salvo cuando una task requiera explícitamente intervención o información propiedad del CRM.

CRM debe poder continuar sus funciones humanas fundamentales cuando R4 esté degradado.

Esta propiedad será un criterio de arquitectura y testing.

---

# 5. Public interfaces

La interfaz canónica de R4 será una API propia, versionada.

MCP no será el contrato primario.

## 5.1 HTTP API

Superficie conceptual:

```text
POST /v1/tasks
GET  /v1/tasks/:id
POST /v1/tasks/:id/cancel
POST /v1/tasks/:id/resume

POST /v1/turns

GET  /v1/runs/:id
GET  /v1/agents
GET  /v1/agents/:id

GET  /v1/artifacts/:id

GET  /v1/attention

POST /v1/consultations/:id/respond

POST /v1/approvals/:id/approve
POST /v1/approvals/:id/reject

POST /v1/handoffs/:id/take
POST /v1/handoffs/:id/release

GET /v1/evaluations
GET /v1/findings

GET /health
GET /ready
```

## 5.2 Events

Eventos mínimos:

```text
task.created
task.started
task.waiting
task.blocked
task.completed
task.failed
task.cancelled

agent.run.started
agent.run.completed

action.proposed
action.executed
action.failed

consultation.requested
consultation.resolved

approval.requested
approval.resolved

handoff.requested
handoff.taken
handoff.released

artifact.created

evaluation.completed
finding.created
failure.clustered
```

## 5.3 MCP

MCP será un adapter de interoperabilidad.

Ejemplo futuro:

```text
r4.list_agents
r4.create_task
r4.get_task
r4.get_artifact
r4.delegate_task
```

MCP no reemplaza la API ni modifica el modelo de autoridad.

---

# 6. Core primitives

## AgentDefinition

Configuración versionada de un agente.

```text
agentId
version
instructions
skills
capabilityScopes
contextPolicy
modelRequirements
budgets
delegationPolicy
evaluationProfile
```

---

## AgentTask

Unidad durable de trabajo.

```text
taskId
type
goal
requestedBy
assignedAgent
parentTask?
status
constraints
budget
deadline?
inputs
artifacts
result
createdAt
updatedAt
```

Estados:

```text
pending
running
waiting
blocked
requires_approval
completed
failed
cancelled
```

---

## AgentRun

Ejecución cognitiva acotada.

```text
runId
taskId
agentId
contextSnapshot
status
startedAt
finishedAt
modelUsage
budgetUsage
result
```

---

## Goal

Representación explícita de intención.

```text
rootGoal
currentGoal
subGoals
```

Goal pertenece al estado cognitivo.

No constituye verdad de negocio.

---

## Observation

Información obtenida del mundo externo.

```text
observationId
source
timestamp
freshness
provenance
payload
```

---

## Artifact

Resultado durable del trabajo.

```text
artifactId
type
version
owner
taskId
status
contentRef
provenance
evidenceRefs
```

Ejemplos:

```text
quote
product_comparison
campaign_brief
analysis_report
product_proposal
research_report
```

---

## ActionProposal

Solicitud semántica de producir un efecto.

```text
proposalId
taskId
agentId
actionType
arguments
evidenceRefs
```

No significa que la acción ocurrió.

---

## ActionReceipt

Evidencia de que ocurrió.

```text
actionId
capabilityId
resourceRef
status
previousVersion?
newVersion?
executedAt
result
evidence
```

---

# 7. Agent Kernel

El Agent Kernel será deliberadamente pequeño.

Su ciclo conceptual:

```text
OBSERVE
  ↓
REASON
  ↓
DECIDE
  ↓
ACT / DELEGATE / WAIT / RESPOND
  ↓
OBSERVE
  ↓
REPLAN
```

Decisiones válidas:

```text
Respond
Read
ProposeAction
Delegate
Wait
ConsultHuman
RequestApproval
RequestHandoff
Complete
```

El kernel no conoce:

```text
Quote
Cart
Campaign
Product
Opportunity
Payment
WhatsApp
CRM
```

---

# 8. Context Compiler

El Context Compiler será una primitive central.

Construye el contexto efectivo de cada run desde:

```text
AgentDefinition
Task
Goals
Identity
Policies
Structured State
Relevant Conversation
Working Memory
Episodic Memory
Artifacts
Observations
Capability Results
Budget
```

Salida:

```text
AgentRunContext
```

El modelo no recibe indiscriminadamente todo el transcript ni todo el Customer 360.

La selección de contexto debe ser observable.

Compaction será sólo una estrategia de reducción de contexto.

No reemplaza structured state ni domain truth.

---

# 9. Memory model

R4 separará:

```text
Working Memory
Conversational Memory
Episodic Memory
Agent Scratch State
Structured State
Customer Memory
Artifacts
```

Regla:

```text
Domain structured state
        >
Generated memory
```

Un summary generado por el modelo nunca puede sobreescribir silenciosamente current truth.

---

# 10. Capability Runtime

Capabilities y agents son conceptos distintos.

Una capability ejecuta una operación acotada.

Un agente decide cómo perseguir una meta.

Flujo:

```text
Agent
  ↓
Capability Discovery
  ↓
Read Invocation
      OR
ActionProposal
  ↓
Policy
  ↓
Validation
  ↓
Execution
  ↓
Domain Owner
  ↓
Observation / ActionReceipt
```

Ningún agente accede directamente a DB productiva.

---

# 11. Capability classes

Cada capability declara su clase de riesgo.

```text
READ
REVERSIBLE_WRITE
IRREVERSIBLE_WRITE
FINANCIAL
EXTERNAL_COMMUNICATION
PRIVILEGED
```

Metadata asociada:

```text
requiredScopes
identityRequirements
confirmationPolicy
approvalPolicy
idempotency
retryPolicy
timeout
auditLevel
```

---

# 12. Reads vs writes

Reads pueden utilizar provider-native tool/function calling detrás del adapter correspondiente.

Writes requieren obligatoriamente:

```text
ActionProposal
→ Policy
→ Command
→ Execution
→ ActionReceipt
```

Function calling nunca constituye evidencia de ejecución.

---

# 13. Model Gateway

R4 será provider-neutral desde el primer diseño.

Contrato conceptual:

```text
ModelGateway.generate()

input:
  context
  tools
  outputContract
  modelRequirements

output:
  content
  toolCalls
  structuredData
  usage
  finishReason
  latency
  providerMetadata
```

R4.0 no requiere routing inteligente entre múltiples modelos.

Sí requiere que Agent Kernel no conozca APIs particulares del proveedor.

---

# 14. Task Runtime

R4 debe soportar tanto:

```text
interactive tasks
```

como:

```text
long-running tasks
```

La task puede:

```text
run
wait
resume
block
delegate
request approval
request consultation
handoff
complete
cancel
```

Una muerte de proceso no elimina la task.

---

# 15. Scheduler

El Scheduler despierta trabajo.

No decide cognitivamente qué hacer.

Ejemplo:

```text
FollowUpTask due
      ↓
Scheduler wakes task
      ↓
Context refresh
      ↓
Agent reasons
      ↓
Agent decides what to do
```

---

# 16. Follow-up

Follow-up comercial será una aplicación del Task Runtime.

Ejemplo:

```text
quote enviada
    ↓
no respuesta
    ↓
FollowUpTask
    ↓
wait
    ↓
resume
    ↓
refresh facts
    ↓
Sales Agent decide:
    ├─ contactar
    ├─ esperar
    ├─ cancelar
    ├─ rehacer quote
    └─ solicitar humano
```

La política puede limitar frecuencia, horarios, intentos y stop conditions.

El agente no inventa esas restricciones.

---

# 17. Human Collaboration

R4 distinguirá tres operaciones.

## Consultation

El agente necesita conocimiento humano.

Ownership permanece en el agente.

```text
Agent
  ↓
HumanConsultation
  ↓
Task waits
  ↓
Human answer
  ↓
Observation
  ↓
Agent resumes
```

## Approval

El agente sabe qué desea hacer pero no posee autoridad.

```text
ActionProposal
  ↓
ApprovalRequest
  ↓
Approve / Reject
  ↓
continue
```

## Handoff

La conversación o task requiere ownership humano.

```text
agent-owned
   ↓
handoff
   ↓
human-owned
```

Durante human ownership el agente puede funcionar como copiloto, pero no actuar como owner del canal salvo autorización explícita.

---

# 18. CRM operator experience

CRM mostrará una sección de agentes consumiendo exclusivamente R4 API.

Ruta sugerida:

```text
/agents
```

Superficies del MVP:

```text
Overview
Attention
Tasks
Agents
Conversation Inspector
Artifacts
Quality
Runtime Health
```

Attention agrupa:

```text
Consultations
Approvals
Handoffs
Blocked Tasks
```

CRM nunca será la fuente autoritativa de AgentTask o AgentRun.

---

# 19. Channel architecture

Canales traducen transporte hacia:

```text
AgentTurn {
  channel
  conversationRef
  actorRef
  message
  attachments
  metadata
  timestamp
}
```

WhatsApp será el primer adapter.

El Agent Kernel no conoce WhatsApp.

---

# 20. Sales reference application

Sales es un Agent Pack construido encima de R4.

Debe contener sus propias:

```text
AgentDefinitions
Skills
Policies
Context extensions
Capabilities
Evaluation rubrics
```

Sales Agent debe poder:

```text
discover needs
search products
compare
recommend
configure
modify selection
answer incidental questions
quote shipping
create quote
resume conversations
follow up
consult humans
request approvals
handoff
```

El circuito comercial pertenece a Sales.

No al R4 Core.

---

# 21. Quality and Evaluation Runtime

Evaluation será una capability first-class de plataforma.

La arquitectura debe poder evaluar:

```text
Task
Run
Conversation
Artifact
Action
```

y generar:

```text
Evaluation
Finding
FailureCluster
KnowledgeCandidate
ImprovementProposal
```

---

# 22. Quality Auditor

Quality Auditor será el primer agente interno.

No será específico del Sales Agent a nivel de runtime.

Su configuración inicial sí utilizará una rúbrica Sales.

Entrada:

```text
conversation
goals
tasks
actions
receipts
domain state
outcome
```

Debe detectar como mínimo:

```text
goal loss
false success
repeated questions
unnecessary confirmations
wrong capability
missing capability
bad arguments
failed recovery
state inconsistency
wrong recommendation
avoidable consultation
avoidable handoff
follow-up failure
model failure
domain-data failure
```

---

# 23. Conversation / Task outcome

Los outcomes combinan evidencia determinística con evaluación semántica.

Ejemplo:

```text
SUCCESS
PARTIAL_SUCCESS
FAILED
ABANDONED
HUMAN_RESOLVED
UNKNOWN
```

Los outcomes no pueden depender sólo del juicio de un LLM.

---

# 24. Learning pipeline

R4 no se auto-modifica directamente en producción.

Pipeline:

```text
Production
   ↓
Outcomes
   ↓
Quality Evaluation
   ↓
Failure Findings
   ↓
Failure Clustering
   ↓
Improvement Proposal
   ↓
Regression Dataset
   ↓
Benchmark
   ↓
Human Review
   ↓
Release
```

No se permite inicialmente:

```text
automatic prompt mutation in production
automatic code merge
automatic deploy
automatic capability permission changes
```

---

# 25. Knowledge learning

HumanConsultation puede generar conocimiento reusable.

Pipeline:

```text
Agent asks human
      ↓
Human answers
      ↓
Customer issue resolved
      ↓
Knowledge Candidate
      ↓
Review
      ↓
Approved knowledge
      ↓
Available to future agents
```

Una respuesta humana no se convierte automáticamente en verdad global.

---

# 26. Persistence

PostgreSQL será la fuente durable inicial recomendada.

Entidades conceptuales mínimas:

```text
agent_definitions
agent_tasks
agent_runs
goals
turns
context_snapshots
observations
artifacts

capability_calls
action_proposals
action_executions
action_receipts

consultations
approvals
handoffs

checkpoints
scheduled_wakeups

evaluations
findings
failure_clusters
knowledge_candidates
```

No se requiere event sourcing puro.

Sí se requiere historial suficiente para reconstruir transiciones relevantes.

Redis/Kafka no serán dependencias obligatorias del MVP.

---

# 27. Concurrency and idempotency

Toda mutación debe soportar al menos una estrategia explícita de:

```text
idempotency
expected version / optimistic concurrency
or equivalent domain protection
```

Retries ciegos de writes quedan prohibidos.

---

# 28. Recovery

Todo componente ejecutable debe declarar:

```text
timeout
retry semantics
idempotency semantics
cancellation
resume behavior
failure classification
```

El runtime debe soportar:

```text
process crash
provider timeout
tool timeout
duplicate inbound
duplicate webhook
worker restart
partial execution
```

sin producir efectos duplicados.

---

# 29. Budget Controller

Budgets se definen por task/run.

```text
time
tokens
cost
model calls
tool calls
writes
delegations
```

No existirán límites globales arbitrarios del tipo:

```text
2 tool calls
3 decisions
```

Stop conditions:

```text
goal completed
blocked
human required
policy blocked
cancelled
budget exhausted
unrecoverable failure
```

---

# 30. Observability

Toda ejecución relevante debe permitir reconstruir:

```text
request
→ task
→ agent
→ goal
→ context snapshot
→ observations
→ decisions
→ capabilities
→ proposals
→ execution
→ receipts
→ state transitions
→ artifact
→ response
→ outcome
```

No se requiere ni se debe depender de almacenar chain-of-thought.

---

# 31. Security boundaries

R4 debe asumir que:

```text
model output is untrusted
external content is untrusted
tool output may be stale
channel input is untrusted
```

TrustedExecutionContext debe construirse fuera del modelo.

Secrets no ingresan al prompt salvo necesidad explícita y segura.

Capabilities se exponen según scopes.

---

# 32. MVP definition

El MVP no es un bot capaz de cotizar.

El MVP es:

```text
R4 Core
+
Sales Reference Application
+
Quality / Evaluation loop
```

Debe incluir:

```text
Agent Registry
Agent Kernel
Task Runtime
Goal
Context Compiler
Memory boundaries
Model Gateway
Capability Runtime
Action Proposal / Receipt
Policy Engine
Scheduler
Follow-up
Consultation
Approval
Handoff
Artifacts
Recovery
Evaluation
Quality Auditor
Observability
```

---

# 33. MVP customer experience

Un cliente debe poder:

```text
explicar una necesidad abierta
recibir asesoría
cambiar de opinión
hacer preguntas incidentales
volver al objetivo principal
construir una selección
cotizar despacho
obtener quote
desaparecer
ser contactado posteriormente
retomar sin empezar de cero
ser derivado correctamente cuando corresponda
```

---

# 34. MVP operator experience

El operador debe recibir principalmente excepciones.

Debe poder:

```text
answer consultation
approve / reject
take conversation
release conversation
inspect task
inspect evidence
inspect artifacts
cancel / resume task
review suspected failures
classify corrections
```

---

# 35. MVP exclusions

No son requisitos de R4.0:

```text
Payment production integration
Voice
Instagram/Facebook production channels
complex multi-agent hierarchies
peer-to-peer agent networks
dynamic model routing
automatic self-modification
automatic deployment
general browser/computer use
Kafka
vector DB as mandatory dependency
microservice per agent
MCP as primary transport
```

---

# 36. Reusable-platform acceptance test

Antes de declarar estable R4 Core se debe construir un segundo vertical pequeño no relacionado con Sales.

Candidate:

```text
Marketing Analyst
```

Task de validación:

```text
analizar audiencia
+
consultar customer/catalog data
+
producir campaign_brief
```

Debe implementarse sin modificar Agent Kernel, Task Runtime o core persistence.

Sólo deberían agregarse:

```text
AgentDefinition
Skills
Capabilities
Policies
Context adapters
Evaluation rubric
```

Si Marketing exige modificar el kernel porque éste presupone quote, customer conversation o cart, la abstracción de R4 habrá fallado.

---

# 37. Repository topology

Crear un repositorio independiente:

```text
R4-agent-platform/
```

Estructura inicial recomendada:

```text
apps/
  api/
  worker/

packages/
  contracts/
  agent-kernel/
  task-runtime/
  context-compiler/
  memory/
  artifacts/
  model-gateway/
  capability-runtime/
  policy-engine/
  scheduler/
  human-collaboration/
  evaluation/
  observability/

agents/
  sales/
  quality-auditor/
  marketing-analyst/

adapters/
  channels/
    whatsapp/
  domains/
    customer/
    catalog/
    shipping/
    quote/
  protocols/
    http/
    mcp/

tests/
  unit/
  integration/
  contract/
  recovery/
  evals/

docs/
  architecture/
  adr/
  roadmap/
```

Monorepo modular para R4.

Domain services continúan siendo repositorios separados.

CRM continúa siendo repositorio separado.

---

# 38. Technology principles

Para minimizar riesgo:

```text
TypeScript / Node ecosystem compatible with current stack
PostgreSQL for durable runtime state
schema validation at every public boundary
structured logging
OpenTelemetry-compatible correlation
contract tests
Dockerized local integration environment
```

No adoptar infraestructura distribuida adicional antes de demostrar necesidad.

---

# 39. Migration policy

R3 no se reemplaza mediante big bang.

Flujo:

```text
R3 production
       │
       ├───────── current customer traffic
       │
       └───────── mirror
                       ↓
                   R4 shadow
```

R4 avanza por scopes controlados.

No comparte cognition con R3.

---

# 40. Delivery roadmap

## R4-A — Architecture Freeze

Objetivo:

convertir este PRD en contratos congelados antes de escribir runtime.

Entregables:

```text
PRD
architecture diagram
ownership matrix
ADR set
core interfaces
API contract
event catalog
state model
eval specification
migration inventory
```

No product code.

---

## R4-B — Platform Skeleton

Implementar:

```text
repository
contracts
API
Postgres persistence
AgentDefinition
AgentTask
AgentRun
Goal
ModelGateway
Capability Registry
structured telemetry
```

Modelo fake/deterministic para tests.

Exit:

runtime independiente del CRM completamente ejecutable.

---

## R4-C — Agent Kernel + Context

Implementar:

```text
Agent Kernel
Context Compiler
Working Memory
Conversation projection
Observation handling
budgets
termination
```

Capabilities sólo read-only.

Exit:

agente puede ejecutar tareas multi-step read-only y reanudarse.

---

## R4-D — Durable Execution

Implementar:

```text
ActionProposal
Policy Engine
ActionExecutor
ActionReceipt
idempotency
optimistic concurrency contracts
checkpoints
recovery
cancellation
```

Exit:

kill/restart no duplica side effects ni corrompe task state.

---

## R4-E — Human Collaboration + Scheduler

Implementar:

```text
Consultation
Approval
Handoff
Scheduler
Wait/Resume
FollowUpTask
Attention API
```

Exit:

task puede quedar suspendida durante horas/días y reanudarse correctamente.

---

## R4-F — Sales Reference Application

Integrar adaptadores reales:

```text
Customer
Catalog
Shipping
Quote
WhatsApp contract
```

Construir Sales Agent.

No producción todavía.

Ejecutar corpus R3 y escenarios nuevos.

---

## R4-G — Quality & Learning

Implementar:

```text
Outcome Engine
Quality Auditor
Evaluation
Finding
FailureCluster
KnowledgeCandidate
Regression dataset generation
```

Exit:

cada fallo relevante puede convertirse en evidencia estructurada y caso de regresión.

---

## R4-H — Shadow Production

R4 consume espejo del tráfico real.

No puede:

```text
send customer messages
write production state
```

Comparar R3 vs R4.

Exit:

gates de calidad y reliability alcanzados.

---

## R4-I — Governed Production

Primer write real recomendado:

```text
create_quote
```

Inicialmente requiere:

```text
trusted identity
policy pass
idempotency
receipt
human approval
```

Aumentar autonomía sólo mediante evidencia.

---

## R4-J — Sales Autonomy

Habilitar progresivamente:

```text
customer response
follow-up
quote creation
selected low-risk writes
```

Mantener rollback inmediato.

---

## R4-K — Platform Generalization Test

Construir Marketing Analyst.

No modificar Core salvo defecto demostrado.

Exit:

segundo vertical funciona únicamente agregando configuración, adapters y capabilities.

---

## R4-L — Extended Platform

Después de validar R4 Core:

```text
MCP adapter
Payment
additional channels
agent-as-tool
specialist agents
long-running internal agents
model routing
skills registry
parallel delegation
voice
```

---

# 41. Evaluation gates

Invariantes absolutas:

```text
wrong-customer write          = 0
unauthorized write            = 0
duplicate irreversible effect = 0
material false-success        = 0
untraceable state transition  = 0
```

Métricas obligatorias:

```text
task success
goal completion
pass^N
recovery rate
human rescue rate
avoidable consultation rate
avoidable handoff rate
capability selection
argument correctness
state integrity
repeated question rate
unnecessary clarification rate
follow-up recovery
latency
token usage
cost
```

Thresholds cuantitativos se congelan antes de cada benchmark.

Nunca después de ver el resultado.

---

# 42. Learning governance

Quality puede:

```text
detect
classify
cluster
propose
create eval case
generate improvement artifact
```

No puede:

```text
merge
deploy
change production permissions
rewrite production prompts automatically
change domain truth
```

Toda mejora pasa por:

```text
candidate
→ evaluation
→ review
→ release
```

---

# 43. Anti-drift rule

Toda nueva funcionalidad debe responder:

```text
What observed problem does it solve?

Who owns the state?

Is it cognition, authority, platform infrastructure or domain logic?

Why is it R4 Core?

Could it instead be a capability?

Could it instead be an Agent Pack feature?

Does it need an agent?

What happens on crash?

How is it evaluated?

How is it audited?

How can it be removed?
```

Si estas preguntas no tienen respuestas claras, la funcionalidad no entra al Core.

---

# 44. Core purity rule

No pueden aparecer en R4 Core como primitives:

```text
Quote
Campaign
Cart
Opportunity
Product
Payment
CommercialFollowUp
```

Sí pueden aparecer:

```text
Agent
Task
Goal
Run
Observation
Artifact
Capability
Action
Receipt
Policy
Schedule
Consultation
Approval
Handoff
Evaluation
```

---

# 45. Definition of R4 MVP Done

R4 MVP se considera terminado cuando:

```text
1. Sales Agent funciona sobre R4 sin cognition dentro del CRM.

2. El modelo puede cambiar sin reconstruir el runtime.

3. El canal puede cambiar sin reconstruir el runtime.

4. Las conversations soportan interrupción, corrección y reanudación.

5. Tasks sobreviven reinicios del proceso.

6. Side effects están gobernados y producen receipts.

7. Ningún éxito operacional depende del texto generado por el modelo.

8. Follow-up funciona como task durable.

9. Consultation, Approval y Handoff están diferenciados.

10. El operador puede supervisar excepciones desde APIs consumibles por CRM.

11. Quality Auditor puede reconstruir y evaluar ejecuciones.

12. Fallos producen findings y regression cases.

13. El Sales Agent completa repetidamente el vertical definido.

14. Un segundo vertical no-Sales puede implementarse sin modificar R4 Core.
```

---

# 46. Product North Star

R4 no busca maximizar la cantidad de autonomía del modelo.

Busca maximizar:

```text
useful autonomous work
──────────────────────
operational risk
```

El resultado esperado es una plataforma donde:

```text
agents do the work
humans govern exceptions
domains preserve truth
evaluation drives improvement
```
