---
title: R4 - Agentic Platform Motivation and Constraints
doc_id: r4-agentic-platform-motivation-and-constraints
status: research_pending
version: "0.1.0"
owner: architecture
last_reviewed: 2026-09-22
source_of_truth_for:
  - why R4 exists
  - R4 architectural constraints before implementation
  - reusable and questioned R3 components
  - open R4 research questions
depends_on:
  - ../../AGENTS.md
  - ../PRODUCT_NORTH_STAR.md
  - ../ACTIVE_RELEASE.md
  - ../audits/r3-p7-10-mutation-semantics-confirmation-boundary.md
  - ../audits/r3-p7-11-confirmation-boundary-replication.md
  - ../audits/r3-p7-12-conversational-soak-stress.md
  - ../audits/r3-p7-13-continuity-vulnerability-degradation.md
supersedes: []
tags:
  - architecture
  - r4
  - agentic-platform
  - research
---

# R4 — Agentic Platform Redesign

## Estado y alcance de este documento

R4 todavía no tiene una arquitectura final decidida. Este documento fija la
motivación, las restricciones, los activos reutilizables y las preguntas que
deben guiar una investigación arquitectónica posterior. No es una especificación
de implementación, no abre una release y no autoriza cambios de producción.

La primera aplicación prevista sigue siendo el Sales Agent de PesasChile, pero
la unidad de diseño de R4 es una plataforma agéntica reutilizable para agentes
externos e internos. Cualquier decisión que convierta R4 en un bot determinístico,
en un único agente gigante o en infraestructura específica de DeepSeek/WhatsApp
queda fuera de esta constitución.

Baseline documental de esta intervención: `686874c74ff99c157c12841bb40b26b321441085`.
El directorio no rastreado `artifacts/benchmarks/r3-stable-agent-v1/` existía antes
de esta tarea y no forma parte del cambio.

## 1. Resumen ejecutivo

R4 existe porque R1/R2 y R3 hicieron visibles dos límites opuestos:

- R1/R2 protegían demasiado la secuencia en código. Eran predecibles y
  gobernables, pero obligaban a la conversación a seguir el workflow.
- R3 trasladó más inteligencia al modelo y habilitó conversación abierta,
  continuidad, selección de capabilities y replanteamiento. A cambio, el LLM
  terminó acumulando interpretación, memoria, planificación, routing,
  ejecución conversacional, recuperación y redacción en una sola superficie.

La dirección de R4 es, por tanto:

```text
agencia dinámica
+
gobernanza determinística
```

El agente debe poder perseguir objetivos, explorar, comparar, delegar y adaptar
su estrategia. La plataforma debe conservar la autoridad sobre la verdad durable,
identidad, permisos, idempotencia, efectos y recuperación. R4 no decide todavía
si esa separación se implementará con un lead agent único, agentes especializados,
handoffs, agent-as-tool, un task runtime separado o una combinación de ellos.

## 2. Evolución R1 → R2 → R3 → R4

### R1: control conversacional y capacidades acotadas

R1 tendió a la forma:

```text
intent -> reglas -> workflow -> pedir dato -> capability -> respuesta
```

Su fortaleza fue la previsibilidad: era fácil observar, testear y bloquear
efectos. Su límite fue tratar la trayectoria de la conversación como una decisión
de la aplicación. Los cambios de tema, objetivos mezclados, comparaciones,
información fuera de orden y necesidades exploratorias degradaban rápidamente.

### R2: estado comercial durable y ejecución gobernada

R2 introdujo o consolidó `CommercialWork`, objetivos, pasos, proyección,
settlement, reintentos, concurrencia optimista y una ejecución más durable. Esto
fortaleció la continuidad y la trazabilidad del negocio, pero mantuvo una
semántica de planificación demasiado acotada para necesidades abiertas. La
plataforma podía representar mejor el trabajo; todavía podía decidir demasiado
la forma del trabajo.

### R3: cognición iterativa y sesión persistente

R3 movió deliberadamente la selección de la siguiente acción al modelo. Entre sus
activos están `SalesAgentRuntime`, el Agent Tool Loop, `AgentSession`, compaction,
`CommercialWork`, `CommercialProposal`, reconciliación de objetivos, Domain Read
Model, `AgentTurnInput`, capability eligibility, Capability Gateway, mutaciones
gobernadas, facts durables, evidence/freshness, outbox, telemetría, settlement y
harnesses de benchmark.

R3 demostró que un agente puede manejar conversaciones menos rígidas y utilizar
herramientas dentro de un ciclo iterativo. También mostró que la robustez no
aparece automáticamente al agregar más autonomía al LLM.

### R4: plataforma agéntica con autoridad explícita

R4 investiga una plataforma que permita múltiples agentes y tareas abiertas sin
delegar al modelo la verdad transaccional. La hipótesis de trabajo es:

```text
turno / tarea
  -> agente líder: objetivo, razonamiento, exploración y propuesta
  -> kernel de estado y gobernanza: verdad, política y precondiciones
  -> capability runtime: ejecución de dominio
  -> observación durable
  -> agente continúa, delega, espera, se detiene o hace handoff
```

Este diagrama es una hipótesis de investigación, no un diseño congelado. En
particular, el kernel no debe transformarse silenciosamente en el planner de R1/R2.

## 3. Evidencia que motiva R4

La evidencia histórica se conserva en sus documentos originales. R4 la referencia;
no la reescribe ni convierte un experimento en una afirmación universal sobre
DeepSeek, R3 o la futura arquitectura.

### P7.10 — `CONSEQUENCE_STATEMENT_SUFFICIENT`

P7.10 mostró que un cambio semántico en el contrato model-facing de
`select_products` podía reducir confirmaciones redundantes y mejorar la ejecución
en un banco acotado. La señal también mostró que el comportamiento dependía mucho
del wording y de cómo se describía la consecuencia de una capability.

Fuente: [P7.10](../audits/r3-p7-10-mutation-semantics-confirmation-boundary.md).

Lectura para R4: la semántica del contrato importa, pero una invariante comercial
importante no debe quedar sostenida principalmente por una frase de prompt.

### P7.11 — `S1_REPLICATED_AND_GENERALIZES`

P7.11 replicó y generalizó la mejora en conversaciones cortas y multi-turno.
También expuso un residuo en correcciones y reemplazos: el modelo podía intentar
mutar sin la evidencia que el Gateway exigía, generando rechazos. La mejora local
no equivalía a una solución completa de continuidad o gobernanza.

Fuente: [P7.11](../audits/r3-p7-11-confirmation-boundary-replication.md).

### P7.12 — `ROBUSTNESS_FAIL`

El soak largo ejecutó 732 turnos, sin corrupción estructural ni fuga entre
conversaciones, pero observó un colapso progresivo del uso de tools: solo 24
turnos invocaron alguna herramienta y hubo 408 turnos consecutivos sin tool call.
En múltiples casos la respuesta narró una actualización sin haber ejecutado la
mutación correspondiente. La prueba no demuestra que todo modelo o proveedor
fallará igual, pero sí demuestra que un native agent loop y una conversación larga
no garantizan continuidad operacional.

Fuente: [P7.12](../audits/r3-p7-12-conversational-soak-stress.md).

### P7.13 y P7.13-A — runtime real y observabilidad

P7.13 corrigió el benchmark para observar el runtime R3 pretendido: sesión
persistente, compaction, CommercialWork, P4/P5/P6, live assimilation, mensajes
alineados y Capability Gateway.

P7.13-A cerró el gap de observabilidad, pero mantuvo `MAIN_RUN_BLOCKED`. En el
smoke full-intended se observaron 100 fallos `invalid_model_json` de 233 llamadas,
todos en gathering y no explicados por truncamiento. También se reprodujo que un
mensaje explícito como “Dale, 1 de la Classic entonces” no ejecutaba
`select_products`, sino que hacía grounding adicional o respondía sin mutar.
Compaction no llegó a ejercitarse porque muchos turnos terminaron antes en
failure o handoff.

Fuente: [P7.13/P7.13-A](../audits/r3-p7-13-continuity-vulnerability-degradation.md).

### Conclusión acotada de la evidencia

La evidencia motiva una nueva investigación de separación de responsabilidades.
No justifica eliminar el razonamiento del agente, volver a un workflow rígido,
declarar que DeepSeek es inviable en general ni congelar una arquitectura R4.

## 4. Qué funcionó en R3

R4 preserva por defecto las siguientes ideas de R3, sujetas a verificación y
mejora de contratos:

- inteligencia iterativa en vez de un único JSON monolítico por turno;
- continuidad de objetivos y contexto más allá del mensaje actual;
- `CommercialWork` y sus conceptos de durable work como posibles primitivas,
  sin asumir que su modelo actual sea el task runtime final;
- sesiones persistentes, compaction y recuperación como problemas explícitos;
- Domain Read Model y `AgentTurnInput` como intentos de entregar estado estructurado
  y provenance al modelo;
- `Capability Gateway` como frontera de ejecución gobernada;
- capability eligibility y evidence/freshness como señales para el razonamiento,
  no como permiso otorgado por el LLM;
- mutaciones durables, idempotencia, concurrencia optimista y outbox;
- settlement, live-turn assimilation y trazabilidad causal;
- instrumentación y benchmarks que miden comportamiento real, no sólo respuestas
  textuales;
- separación entre propuesta de IA y decisión comercial aceptada, alineada con
  [ADR-001](adr/ADR-001-commercial-vs-ai-decisions.md) y [ADR-006](adr/ADR-006-autonomous-planning-and-capability-governance.md).

Estos activos prueban seams valiosos. No prueban que las abstracciones actuales
deban sobrevivir literalmente en R4.

## 5. Qué falló o quedó bajo sospecha en R3

La debilidad observada no es simplemente “el modelo es malo”. El runtime pidió al
LLM resolver demasiadas responsabilidades al mismo tiempo:

- interpretar lenguaje y contexto;
- mantener memoria y estado comercial;
- identificar objetivo y datos faltantes;
- escoger y argumentar una capability;
- formar argumentos válidos;
- interpretar resultados y detectar si una acción ocurrió;
- no repetir preguntas ni efectos;
- reconciliar contradicciones y freshness;
- producir JSON estructurado y, finalmente, responder naturalmente.

Los síntomas observados fueron:

- fragilidad ante cambios pequeños de wording;
- `invalid_model_json` en gathering;
- selección incorrecta de capability incluso a baja profundidad;
- pérdida de continuidad operacional en long-runs;
- narración de efectos no ejecutados;
- compaction no ejercitada cuando los fallos impedían completar turnos;
- concentración de contexto, memoria, plan y policy en superficies de prompt y
  loop difíciles de aislar causalmente.

R4 debe separar estas responsabilidades sin convertir cada decisión humana en un
`if/else` ni hacer que el backend decida la estrategia comercial por adelantado.

## 6. Por qué un raw native agent loop tampoco basta

No se puede resolver R3 simplemente eliminando sus capas y conectando un modelo a
tools nativas. P7.12 observó precisamente en un native harness una deriva a
respuestas text-only y claims de acciones no realizadas. Function calling reduce
ambigüedad de transporte, pero no garantiza:

- que el modelo siga escogiendo tools después de cientos de turnos;
- que sepa si una mutación durable ocurrió;
- que distinga evidence de current truth;
- que respete permisos, idempotencia y confirmaciones;
- que recupere un turno interrumpido;
- que no confunda un resultado narrado con una ejecución auditada.

La futura plataforma necesita una frontera de ejecución explícita y observaciones
durables, aunque el mecanismo de interacción con el proveedor siga abierto entre
function calling, semantic actions u otra representación.

## 7. Por qué los workflows determinísticos tampoco bastan

La secuencia fija `intent -> pregunta A -> pregunta B -> acción C` no representa
bien objetivos abiertos. Obliga al usuario a adaptarse al workflow cuando puede:

- mezclar objetivos;
- cambiar de producto o volver atrás;
- entregar datos en orden diferente;
- pedir una comparación incidental;
- expresar una necesidad implícita;
- necesitar asesoría y exploración.

El determinismo es deseable para invariantes, permisos, persistencia,
idempotencia, recuperación y efectos. No debe reemplazar la decisión del agente
sobre qué entender, investigar o intentar después.

## 8. Definición operativa de sistema agéntico

Hasta que la investigación refine la definición, un agente R4 es una entidad de
runtime capaz de:

1. perseguir un objetivo;
2. interpretar contexto y restricciones;
3. escoger y adaptar una estrategia;
4. seleccionar información o acciones útiles;
5. delegar trabajo acotado;
6. observar resultados;
7. revisar su estrategia;
8. continuar hasta completar, bloquearse, hacer handoff o alcanzar una condición
   de detención.

Un workflow difiere porque la secuencia de decisiones está principalmente
predeterminada por el código de aplicación. Un agente puede operar dentro de
límites estrictos y seguir siendo agéntico: las restricciones protegen la
autoridad del sistema, no sustituyen el razonamiento.

## 9. Frontera entre inteligencia y autoridad

### El agente/LLM puede ser responsable de

- razonamiento, estrategia y exploración;
- interpretación conversacional;
- formación de goals y subgoals;
- generación de hipótesis;
- planificación adaptable;
- elección de qué información necesita;
- propuesta de una acción semántica;
- decisión de pedir ayuda a un especialista;
- síntesis de resultados y recomendaciones.

### La plataforma/kernel debe ser autoridad de

- estado canónico actual;
- identidad y nivel de verificación;
- permisos y scopes;
- idempotencia y concurrencia;
- hechos durables y freshness;
- acciones ya ejecutadas y sus resultados;
- existencia de quote, pago u orden;
- compromisos y estado de tareas;
- límites de confirmación y side effects;
- seguridad, auditoría, cancelación y recuperación.

El modelo puede proponer “comparar dos configuraciones antes de cotizar”. No puede
declarar por sí solo “ya actualicé el carrito”. Esa afirmación requiere una
observación durable de la capability y una transición aceptada por la plataforma.

## 10. Ownership de estado

La siguiente división es un marco de investigación, no un contrato final:

| Área | Owner candidato | Regla de autoridad |
|---|---|---|
| Goals, estrategia, hipótesis, siguiente pregunta | agente | razonamiento dinámico; no se convierte automáticamente en estado comercial |
| Estado comercial durable | dominio/servicio dueño | current truth, versionado y transiciones válidas |
| Identidad | servicio de identidad y política | la identidad provisional sigue separada de Customer Master definitivo |
| Permisos y autonomía | policy/execution gate | nunca se delegan al LLM |
| Capabilities | Capability Runtime/Gateway + dominio | valida, normaliza, autoriza, ejecuta, audita y devuelve observación |
| Task lifecycle | futuro task runtime, aún no decidido | debe soportar estado, checkpoints, cancelación y recuperación |
| Memoria cognitiva | runtime de agentes | nunca reemplaza los hechos canónicos |
| Artifacts | owner del artifact/runtime, aún no decidido | el resultado debe tener identidad, estado, provenance y accesibilidad |
| Transporte | channel adapter | traduce al contrato canónico sin fijar la estrategia |
| Operación humana y CRM | CRM/control plane | observa, aprueba, toma control y opera; no contiene la cognición central |

`CommercialWork` puede seguir siendo una representación importante de trabajo
comercial, pero R4 no debe asumir que sea simultáneamente case, task runtime,
memoria, planner y artifact store.

## 11. Capability governance

El Capability Gateway actual es un activo estratégico y debe preservarse salvo
evidencia fuerte en contrario. La frontera conceptual es:

```text
agent proposal
  -> Capability Runtime / Gateway
  -> validate
  -> normalize
  -> authorize
  -> execute in domain
  -> audit
  -> return observation
```

La plataforma debe resolver qué capability corresponde, qué argumentos canónicos
necesita, qué evidencia es suficiente, si la acción está autorizada, si requiere
confirmación y si ya ocurrió. Ningún agente obtiene acceso arbitrario a la base de
datos ni a APIs productivas.

Las capabilities y los agents no son equivalentes:

- una capability es una acción concreta y acotada, como leer un producto,
  calcular despacho o crear un quote;
- un agent es una entidad cognitiva con goal, contexto limitado, skills,
  capabilities y posiblemente memoria, capaz de realizar trabajo de varios pasos.

Una propuesta semántica como `COMPARE_PRODUCTS`, `REQUEST_QUOTE`,
`CHECK_STOCK` o `DELEGATE_PRODUCT_RESEARCH` no obliga a que exista una capability
con el mismo nombre. El runtime debe resolverla o rechazarla de manera observable,
para que el agente replantee sin convertir ese mapping en un workflow rígido.

## 12. Visión multiagente

R4 debe soportar un runtime común con agentes especializados configurables:

```text
Agent Runtime
├── Sales Agent
├── Product Specialist
├── Quote Specialist
├── Shipping Specialist
├── After-Sales Agent
├── Product Manager Agent
├── Marketing Expert Agent
├── Commercial Analyst
└── futuros agentes
```

No se asume un microservicio por agente. La primera hipótesis es un runtime
compartido, con aislamiento de contexto, políticas, skills, capabilities y
memoria según la definición del agente.

Un agente líder puede delegar a un especialista, recibir un resultado estructurado
y sintetizarlo. La delegación no debe compartir automáticamente toda la
conversación: debe transferir el mínimo contexto necesario, permisos explícitos,
presupuesto y output esperado.

Agregar un subagente sólo está justificado si aporta al menos una de estas
propiedades: aislamiento de contexto, razonamiento especialista, paralelismo,
expertise reusable, scope de tools acotado o ownership claro. Si una capability
simple basta, no se crea un agente.

## 13. Requisitos futuros del Sales Agent

El Sales Agent de R4 deberá poder:

- comprender necesidades abiertas y objetivos comerciales;
- explorar antes de fijar una solución;
- asesorar, comparar y recomendar;
- construir y modificar configuraciones;
- conservar el estado comercial durable sin convertir el chat en su autoridad;
- calcular despacho, preparar cotizaciones y avanzar hacia pago/orden cuando las
  capabilities y políticas lo permitan;
- manejar interrupciones, cambios de tema y reanudación;
- evitar preguntas repetidas y explicar bloqueos reales;
- delegar investigación de producto, envío o cotización;
- adaptar la estrategia de venta al contexto y a la evidencia;
- entregar o solicitar handoff cuando corresponda.

No debe reducirse a un workflow de cotización ni a una colección de respuestas
por intent.

## 14. Requisitos futuros de agentes internos

Los agentes internos deben soportar tareas abiertas, de mayor duración y con
artifacts verificables. Deben poder:

- recibir una meta ambigua pero legítima;
- descomponerla en subtareas sin que la descomposición sea un grafo fijo;
- investigar datos, catálogo, clientes y campañas mediante fuentes gobernadas;
- pedir ayuda a otros agentes;
- comparar hipótesis y evidencia;
- crear un artifact como informe, brief, propuesta o recomendación;
- reanudar una tarea con checkpoints;
- exponer fuentes, límites, incertidumbre y próximos pasos.

Autonomía interna no significa acceso irrestricto. Un agente puede analizar
campañas y proponer cambios, pero publicar una campaña, cambiar precios o gastar
presupuesto debe pasar por políticas y aprobaciones apropiadas.

## 15. Ejemplo: Product Manager Agent

Entrada conceptual:

> Analiza qué deberíamos lanzar para Hyrox Q1 2027.

Conducta objetivo, todavía no implementada:

1. entender objetivo, horizonte, restricciones y definición de éxito;
2. consultar ventas, catálogo, margen, feedback y señales de clientes;
3. pedir a un Commercial Analyst análisis de cohortes o demanda;
4. delegar investigación de competencia a un especialista si aporta valor;
5. pedir a Marketing Expert una lectura de audiencia y campaña;
6. comparar oportunidades y explicitar evidencia faltante;
7. construir un `product_proposal` o `analysis_report` como artifact;
8. entregar una recomendación con evidencia, trade-offs, incertidumbre y próximos
   pasos.

El sistema debe gobernar permisos, fuentes y costo. El agente debe conservar la
capacidad de decidir qué investigación es útil, en vez de recibir una secuencia
de análisis completamente prescrita.

## 16. Ejemplo: Marketing Expert Agent

Entrada conceptual:

> Diseña una campaña para clientes interesados en entrenamiento funcional.

El agente podría analizar comportamiento, segmentación, campañas anteriores,
creativos y catálogo; pedir datos a un Commercial Analyst; proponer un brief y
variantes de audiencia; y devolver un `campaign_brief` con evidencia y supuestos.

Crear el brief no equivale a publicar la campaña. Modificar un draft, enviar
mensajes o comprometer presupuesto pertenece a clases de efecto distintas y debe
seguir governance, confirmación y audit. Las políticas no se infieren de la
intuición del modelo.

## 17. Taxonomía de memoria

R4 debe investigar memoria separada por función y autoridad:

| Tipo | Contenido | Autoridad |
|---|---|---|
| Working memory | contexto inmediato necesario para razonar | efímera; no es verdad durable |
| Structured state | facts actuales, IDs, versiones, status y policy efectiva | autoridad del dominio/kernel |
| Episodic memory | eventos relevantes, decisiones, correcciones y resultados | evidencia durable, no sustituto de current truth |
| Customer memory | preferencias y señales persistentes permitidas | sólo facts con owner, provenance y policy |
| Agent plan/scratch state | hipótesis, subtareas y trabajo en curso | estado del agente/task, nunca autoridad comercial por sí solo |
| Artifacts | quotes, informes, comparaciones, briefs y recomendaciones | objetos versionados con owner y provenance |
| Conversational memory | transcript, tono, referencias y continuidad | útil para interpretar; no debe ganar a structured state |

Una única summary generada por LLM no puede tener autoridad sobre todos estos
niveles. La compaction puede ser una técnica de contexto, pero no una migración
silenciosa de facts ni un reemplazo de retrieval o estado estructurado.

## 18. Goals, tasks y artifacts

### Goals

R4 debe investigar una representación explícita de `customerGoal`,
`commercialGoal`, `currentGoal` y `subGoal`. Un mensaje incidental, como “¿cuánto
pesa esa barra?”, no debería destruir el objetivo superior de equipar un gimnasio.
El goal debe orientar al agente sin convertirse en una lista cerrada de próximos
pasos.

### Tasks

Se debe investigar una primitive `AgentTask` para trabajo interactivo y de larga
duración. Campos posibles, no congelados:

```text
taskId, goal, requestedBy, assignedAgent, parentTask,
status, inputs, artifacts, constraints, budget, deadline, result
```

### Artifacts

Un artifact debe ser una primitive del runtime, no texto perdido en chat. Debe
considerar identidad, tipo, versión, estado, owner, provenance, evidencia,
permisos, referencias y ciclo de vida. No se debe crear todavía un paquete o
esquema definitivo hasta resolver el modelo de tareas y ownership.

## 19. Patrones de delegación a investigar

R4 mantiene abiertos al menos dos patrones:

### Agent-as-tool

El lead conserva el control, invoca un especialista con goal y contexto mínimo,
recibe un resultado estructurado y continúa.

### Handoff

El control pasa temporalmente a otro agente, que puede gestionar varios turnos o
una fase completa y luego devolver control o finalizar.

No se decide todavía cuál dominará. La elección puede depender de duración,
continuidad, riesgo, ownership, canales y necesidad de síntesis. También deben
investigarse jerarquías de agentes, pares colaborativos y ejecución paralela, sin
asumir que multi-agent produce mejores resultados por sí mismo.

## 20. Provider y model abstraction

R4 no debe depender de DeepSeek. El runtime debe poder escoger modelos según tarea,
por ejemplo:

- modelo rápido/económico para extracción o clasificación;
- modelo fuerte para planning, investigación o síntesis;
- modelo especializado para razonamiento de producto;
- modelo local/pequeño para tareas triviales;
- modelo económico para renderizar una respuesta final.

Un agente podría declarar requisitos como `reasoningLevel`, `latencySensitivity`,
`costSensitivity`, `toolUseRequirements` y `contextRequirements`; el mecanismo de
model routing queda abierto. La interfaz debe abstraer provider/model, errores,
capacidad de tool use, structured output, tokens, latencia y observabilidad.

No se implementa model routing en esta fase.

## 21. Arquitectura de canales

El Agent Runtime debe ser channel-neutral. Se debe investigar un contrato canónico
equivalente a:

```text
AgentTurn {
  channel
  conversation
  actor
  message
  attachments
  metadata
  timestamp
}
```

WhatsApp, Instagram, Facebook, web chat, voz, email y la UI interna deben ser
adapters que traduzcan transporte, identidad y attachments hacia ese contrato.
El canal no debe decidir la estrategia del agente ni crear una memoria paralela.

La identidad sigue siendo provisional según `AGENTS.md`: `wa_id` es la referencia
principal mientras no exista resolución canónica; no se debe inventar un
Customer Master ni convertir un Customer Candidate en uno.

## 22. Hipótesis de separación CRM / Agent Runtime

Si la investigación confirma que R4 es viable, la separación física objetivo
podría ser:

```text
CRM-Customer-360
  control plane + UI + operaciones humanas + analytics

agent-runtime
  cognition + orchestration + agents + memory + policy +
  channel interfaces + evaluation

domain services
  catalog + quote + payments + customer + shipping + orders
```

Esto es una hipótesis de repositorios y ownership, no una decisión de extracción.
No se migrará código, se crearán microservicios por agente ni se moverán tablas en
esta etapa. Todo código experimental R4, si se autoriza en el futuro, debe
depender de ports, contracts, domain APIs, state APIs y capabilities; no de
Next.js, `/hub`, React, browser state o internals arbitrarios del CRM.

## 23. Componentes R3 reutilizables por defecto

Salvo evidencia fuerte en contra, se preservan conceptualmente:

- Capability Gateway;
- Trusted Execution Context;
- servicios de dominio y sus owners;
- Catalog Service;
- Quote Service;
- dirección de Payment Service;
- identidad y sus gates, manteniendo identidad provisional;
- facts de negocio durables;
- outbox canónico;
- idempotencia y concurrencia optimista;
- auditoría y evidence/freshness;
- telemetría y correlation;
- benchmark/evaluation harnesses y cultura de evidencia;
- conceptos de `CommercialWork` que prueben ser reutilizables;
- separación entre estado comercial y transcript;
- handoff y control humano como estado compartido, no una segunda realidad.

Preservar significa conservar la invariante o el seam validado, no copiar sin
revisión las APIs, tablas o semánticas actuales.

## 24. Componentes bajo pregunta

No se asume que sobrevivan sin cambios:

- `runAgentToolLoop` y su división gathering/finalization;
- el giant system prompt actual;
- la semántica actual de `AgentSession`;
- compaction como única respuesta al crecimiento de contexto;
- el patrón actual de `CommercialProposal` companion;
- el modelo actual de objetivos P5;
- la arquitectura shadow DRM/`AgentTurnInput` si duplica owners;
- capability eligibility como exposición actual al modelo;
- el native DeepSeek structured tool loop;
- confirmación basada principalmente en prompt;
- el mapping actual de R2/R3 hacia `CommercialWork`;
- la frontera exacta entre `Conversation`, `Case`, `Opportunity` y futuro
  `AgentTask`;
- los eventos y tablas actuales como contrato multiagente definitivo.

Ser “bajo pregunta” no significa borrar ni degradar estos componentes. Significa
que cualquier evolución debe demostrar qué problema resuelve, qué autoridad
preserva y qué evidencia aporta.

## 25. Restricciones arquitectónicas duras

1. La inteligencia puede proponer; la plataforma mantiene la autoridad.
2. Ningún LLM decide identidad, permisos, idempotencia, transactional truth o si
   un efecto ocurrió.
3. Todo side effect pasa por decisión/propuesta, validación, comando, ejecución y
   auditoría.
4. Ningún agente accede directamente a DB o APIs no registradas.
5. No hay falsa confirmación: el texto nunca sustituye una observación durable.
6. Los datos actuales de negocio deben provenir de sus owners, con provenance y
   freshness explícita.
7. La identidad sigue siendo provisional mientras no exista `customer_master`
   validado; no se inventa `customer_key` definitivo.
8. Customer, Opportunity, Case y Conversation no se colapsan en una sola entidad.
9. El kernel de estado no puede convertirse por accidente en un planner
   determinístico que decida la conversación por el agente.
10. Los agentes internos quedan sujetos a scopes, budgets, aprobación,
    cancelación, audit y side-effect classes.
11. R4 no se acopla a DeepSeek, WhatsApp, Next.js ni al frontend CRM.
12. El runtime debe contemplar turnos interactivos y tareas largas resumibles.
13. Se deben observar decisiones estructuradas y evidencias sin almacenar
    chain-of-thought como requisito.
14. Toda nueva primitive debe tener owner, lifecycle, recovery semantics y
    evaluación definida.

## 26. Anti-goals

R4 no debe convertirse en:

- un chatbot guionado;
- un workflow gigante disfrazado de planner;
- un mega-agente con todas las tools y todo el contexto;
- una colección de `if/else` para cada decisión humana;
- un microservicio por agente sin necesidad demostrada;
- un LLM con acceso irrestricto a DB o side effects;
- infraestructura específica de DeepSeek;
- arquitectura específica de WhatsApp;
- lógica cognitiva mezclada con componentes del CRM;
- un sistema cuya verdad comercial viva en summaries de chat;
- multi-agent usado como sinónimo de mayor inteligencia;
- determinismo usado como sinónimo de confiabilidad;
- autonomía textual sin autonomía operacional verificable.

## 27. Preguntas de investigación abiertas

No resolver sin investigación y evidencia comparativa:

1. ¿Lead agent único, separación planner/executor o una forma híbrida?
2. ¿Cuándo conviene agent-as-tool y cuándo handoff?
3. ¿Arquitectura jerárquica, peer-to-peer o ambas según tarea?
4. ¿Memoria centralizada, distribuida o federada por owner?
5. ¿Cuál será el rol futuro de `CommercialWork`?
6. ¿Debe existir un objeto `Goal` explícito y cuál es su autoridad?
7. ¿Se necesita un task runtime separado de la sesión conversacional?
8. ¿Cuál es el contrato de `Artifact` y quién lo posee?
9. ¿`AgentSession` evoluciona, se reemplaza o sólo se limita a working memory?
10. ¿Cómo se combinan compaction, retrieval y structured state?
11. ¿Native function calling, semantic action protocol o combinación?
12. ¿Cómo se expone dinámicamente sólo la capability necesaria?
13. ¿El agente genera planes explícitos o sólo acciones incrementales?
14. ¿El plan debe persistirse y versionarse?
15. ¿Cómo se enrutan providers/models por requisitos y presupuesto?
16. ¿Cuándo se permite concurrencia entre subagentes?
17. ¿Cómo se asignan budgets de tokens, costo, tiempo y side effects?
18. ¿Qué timeout, cancelación, retry y recovery semantics necesita cada task?
19. ¿Qué acciones requieren aprobación humana y cómo se representa el approval?
20. ¿Qué límites de repositorio y contratos permiten extraer `agent-runtime`?
21. ¿Qué es un skill, cómo se versiona y cómo se relaciona con capabilities?
22. ¿Cómo se define y gobierna un Agent Registry?
23. ¿Qué contexto mínimo necesita cada agent y qué debe quedar fuera?
24. ¿Cómo se evalúa delegación, síntesis y calidad de artifacts sin premiar texto
    convincente pero falso?

## 28. Criterios de evaluación de la arquitectura futura

Una propuesta R4 deberá mejorar conjuntamente:

### Agenticidad

- planning dinámico;
- adaptación a cambios e interrupciones;
- exploración y comparación;
- delegación útil;
- especialización con contexto acotado;
- tareas abiertas y long-running.

### Robustez y verdad

- cero false-success material;
- cero side effects duplicados;
- estado durable consistente;
- facts stale identificables;
- recuperación y reanudación;
- separación comprobable entre propuesta y ejecución.

### Escala

- múltiples agentes y canales;
- múltiples providers/models;
- tasks interactivas y background;
- artifacts y subtareas concurrentes cuando corresponda.

### Observabilidad

Para decisiones relevantes debe poder reconstruirse, sin chain-of-thought:

```text
agent -> goal -> state snapshot -> inputs/evidence -> proposed action
      -> delegation -> capability -> result -> state transition
      -> artifact -> response
```

### Economía y mantenimiento

- contextos más pequeños y seleccionados;
- routing de modelo según costo/latencia/razonamiento;
- menos llamadas redundantes;
- contratos estables;
- CRM, runtime y dominios extraíbles sin reescritura masiva.

### Evaluation first-class

Los harnesses deben medir decision quality, choice de capability, continuidad de
goal, consistencia de estado, delegación, completion, clarificaciones
innecesarias, false success, costo, latencia, tokens y degradación en long-runs.
La evaluación debe cubrir también recovery, approval y cancellation.

## 29. Restricciones de migración

Mientras R4 esté en investigación:

- no se implementa un runtime R4 final;
- no se cablea producción ni se crean feature flags productivos;
- no se crean tablas o migraciones nuevas;
- no se extrae un repositorio `agent-runtime`;
- no se modifica el Capability Gateway para anticipar una hipótesis;
- no se modifican CRM, auth, routing, chats, dashboard o APIs por esta
  constitución;
- no se reescriben workflows n8n masivamente;
- no se cambia ni se borra evidencia P7.10, P7.11, P7.12, P7.13 o P7.13-A;
- no se presenta un mock, fixture o benchmark como dato real;
- no se abre una release paralela ni se crea un roadmap alternativo;
- experimentos futuros deben aislarse, tener baseline/freeze, criterios de salida
  y no cambiar la semántica productiva sin autorización explícita.

Si la investigación produce una decisión, la migración debe ser incremental:
preservar la autoridad de dominio, introducir contracts/ports, verificar parity,
medir con harnesses, activar con scope limitado, mantener rollback y retirar
duplicados sólo después de demostrar equivalencia.

## 30. Decisiones intencionalmente diferidas

Este documento no decide:

- la arquitectura final de R4;
- la forma exacta del Agent Kernel o State Kernel;
- el protocolo de acciones semánticas;
- el planner, task runtime o persistencia de planes;
- el modelo de goals y artifacts;
- el patrón dominante de delegación;
- el número o topología de agentes;
- la política de memoria y compaction;
- el Agent Registry y el sistema de skills;
- el provider/model router;
- el modelo de concurrencia y budgets;
- el diseño final de approvals y autonomy levels;
- los límites de repositorio ni la extracción física;
- el paquete `@pesaschile/contracts`;
- cualquier migración de base de datos o reemplazo de componentes R3.

La decisión correcta por ahora es mantener abiertas estas alternativas y comparar
arquitecturas con la evidencia de R3, los requisitos del Sales Agent y los casos
de agentes internos. La siguiente etapa autorizada es investigación y, sólo si se
solicita explícitamente, experimentos mínimos y aislados.

## Referencias normativas y evidencia

- [AGENTS.md](../../AGENTS.md): jerarquía, límites de implementación, identidad
  provisional y reglas de trabajo.
- [PRODUCT_NORTH_STAR](../PRODUCT_NORTH_STAR.md): agente que decide la siguiente
  acción dentro de límites gobernados; plataforma como autoridad de ejecución.
- [ACTIVE_RELEASE](../ACTIVE_RELEASE.md): release activa y estado operativo; R4
  no modifica su secuencia.
- [ADR-001](adr/ADR-001-commercial-vs-ai-decisions.md): propuesta de IA frente a
  decisión comercial aceptada.
- [ADR-006](adr/ADR-006-autonomous-planning-and-capability-governance.md):
  planning autónomo y Capability Gateway.
- [R3 target architecture](SALES-AGENT-R3-A00-target-architecture.md): inventario
  de seams y componentes observados en el runtime actual.
- [R3 durable platform audit](../audits/durable-commercial-agent-platform-architecture-audit.md):
  auditoría forense de componentes durables, memoria, capabilities y fragmentación;
  no es autoridad para decidir R4.
- [R3 domain boundary audit](../audits/r3-domain-microservice-boundary-audit.md):
  owners, freshness, read model y fronteras de servicios.
