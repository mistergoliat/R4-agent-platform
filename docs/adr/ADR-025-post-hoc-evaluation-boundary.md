# ADR-025 — Evaluación post-hoc, determinista antes que semántica (R4-G)

- **Estado:** Aceptado (R4-G, completado)
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §28 ("Evaluation first-class"), §25; PRD §21–§24, §41–§44; ADR-002, 004, 008, 016, 020
- **Relacionado:** ADR-026, ADR-023, ADR-024
- **Enmendado por:** ADR-031 (§1: una única frontera determinista de autoridad previa a `respond`; lo demás de §1 sigue vigente)

## Contexto

R4-F cerró con un gate live (`deepseek-flash`) que mostró fenómenos que las
invariantes mecánicas del harness no clasifican: fallos de protocolo
(evidencia citando una id de conversación, un write pedido como read, dos
decisiones en una respuesta, texto después del JSON), afirmaciones sin
evidencia (compatibilidad rack–barra, categorías de cardio inexistentes),
correcciones de presupuesto y un quote gobernado exitoso. R4-G debe poder
decir sistemáticamente si un agente hizo un buen trabajo, por qué falló y si
una versión nueva mejora — sin convertir Quality en parte del loop del agente.

## Decisión

1. **Evaluación post-hoc.** `Agent Execution → trayectoria durable e inmutable → Evaluation`.
   Ningún evaluador interviene mientras el agente ejecuta: no hay guard de
   calidad en `AgentKernel`, evaluador semántico en `ContextCompiler`,
   reintentos por evaluador ni bloqueo de acciones. ADR-008 se mantiene (una
   decisión inválida termina la run; R4-G la mide, no la repara).
2. **Frontera de paquetes.**
   - `packages/evaluation` (`@r4/evaluation`): framework puro y genérico
     (`@r4/contracts` + `zod`; `node:crypto` para hashes). EvaluationSubject,
     constructor de trayectoria, taxonomía, Finding, TaskOutcome, métricas,
     evaluadores deterministas, frontera semántica, RegressionCase,
     BenchmarkRun, Experiment, artifacts, reportes.
   - `apps/evaluator` (`@r4/evaluator`): composition root de evaluación —
     lector de trayectorias sobre las APIs de lectura existentes de
     `persistence-postgres`, escritura de artifacts, `ModelGatewayJudge` sobre
     el `ModelGateway` existente. Es una app porque sólo apps pueden alcanzar
     la persistencia (regla ESLint de Core).
   - `agents/sales/src/evaluations` (entrada `@r4-sales/agent/evaluations`):
     evaluadores, taxonomía, rúbricas, fixtures y corpus de Sales. El runtime
     desplegado del pack no los importa.
   Core no depende de Quality (`dependency-boundaries`, `quality-boundaries`).
3. **EvaluationSubject** (`r4.evaluation_subject.v1`) es la única entrada de
   un evaluador: una proyección de lectura de la trayectoria (task, runs,
   steps, metadata de ContextSnapshot, turnos, respuestas con la evidencia que
   cada una podía ver, observations, ledger de acciones, goals y
   transiciones, esperas, proyecciones de dominio del pack y — opcional,
   rotulado — metadata de llamadas grabada por un harness). Nunca texto de
   logs, nunca chain-of-thought. La autoridad es el estado durable; un
   snapshot en artifacts es una copia de evaluación, no la fuente.
4. **Determinista antes que semántico.** El pipeline ejecuta primero los
   evaluadores deterministas (protocolo, resultados de ejecución, invariantes
   de gobierno, continuidad de goal, uso de capabilities, eficiencia,
   composición de contexto y los del pack), luego los semánticos sobre una
   proyección de privacidad. Lo que R4 puede probar no se le pregunta a un
   juez: un evaluador determinista declara `authoritativeFor` y un finding
   semántico con ese código se suprime (`deterministic_authority`); un juez
   nunca anula un receipt.
5. **Frontera semántica.** `SemanticJudge` es un puerto; su respuesta pasa
   por schema estricto, lista de códigos permitidos de la rúbrica y
   verificación de que cita registros existentes. Timeout, salida inválida,
   error o veredicto contradictorio ⇒ el evaluador queda **inconclusive** y
   la cobertura semántica `partial`; nunca es un fallo del agente evaluado.
   El juez puede ser otro modelo que el evaluado (se registran ambos
   perfiles). No hay cliente de proveedor en Quality.
6. **Grounding = extracción + verificación.** Un extractor (juez o
   determinista) dice qué se afirmó; un verificador del pack decide contra la
   evidencia disponible para esa respuesta: `GROUNDED_FACT`,
   `DERIVED_RECOMMENDATION`, `UNSUPPORTED_CLAIM`, `UNSUPPORTED_RELATIONSHIP`,
   `NONEXISTENT_ENTITY`. El conocimiento general del juez no fundamenta nada.
7. **Resultado estructurado sin score.** `TaskOutcome` separa technical /
   goal / business / quality / governance. Una task esperando input es
   técnicamente válida. El negocio lo reporta el pack desde receipts. La
   calidad es un vector de métricas (tasas con numerador y denominador) y
   findings (categoría ≠ severidad), nunca un número ponderado.
8. **Versionado.** Evaluadores con `id@version` obligatorio; rúbricas con
   `id@version` + hash y un lock por pack; taxonomía versionada y extensible
   sólo por adición; perfil de modelo con fingerprint de configuración
   (mismo nombre de modelo con otro modo de razonamiento u otro límite de
   salida ⇒ otro fingerprint). Cada EvaluationRun registra git SHA (y si el
   árbol estaba sucio), agente, protocolo, perfiles, escenario, evaluadores y
   rúbricas.
9. **Privacidad.** El juez recibe sólo la proyección (turnos, respuestas,
   observations visibles, goals, desenlace de acciones, vista de dominio del
   pack) con campos personales redactados y claves con forma de razonamiento
   eliminadas; sin ids de correlación, principals ni contexto confiable.
   Todo artifact pasa `assertArtifactSafe` (secretos configurados, headers de
   autorización, bearer tokens, `R4_MODEL_API_KEY`, texto de razonamiento).
10. **Denominadores.** Adherencia de protocolo = decisiones válidas /
    intentos de decisión (llamadas al modelo que respondieron); fallos de
    proveedor aparte. Completitud técnica = trayectorias en una parada
    legítima / evaluadas. p95 sólo con ≥ 20 valores; valores faltantes se
    cuentan, no se promedian como cero.

## Alternativas descartadas

- *Quality dentro del kernel / guard en línea*: mezcla autoridad y juicio,
  y convierte evaluación en workflow.
- *Score único ponderado*: los pesos serían inventados sin evidencia.
- *Juez para todo*: lo verificable (receipts, ledger, protocolo) sería
  opinable.
- *Nuevo cliente de proveedor en Quality*: duplica el gateway (ADR-004).

## Consecuencias

- Dos pruebas de fases previas se acotan explícitamente a runtime
  (`temporal-boundaries`, `governed-execution-boundaries`): Quality inspecciona
  texto terminado por diseño y usa un deadline de llamada al juez;
  `quality-boundaries` re-verifica esas reglas sobre el runtime.
- `ModelUsage` no expone tokens de razonamiento: el campo existe en la
  metadata de llamada del harness y queda `null` ("not exposed"). Extender
  `ModelUsage` en Core se difiere hasta que un proveedor lo exponga y se
  necesite (evita tocar C1).
