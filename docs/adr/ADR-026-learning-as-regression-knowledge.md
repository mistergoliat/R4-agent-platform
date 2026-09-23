# ADR-026 — Learning = conocimiento de regresión, no auto-modificación; artifacts, no tablas (R4-G)

- **Estado:** Aceptado (R4-G, completado)
- **Fecha:** 2026-09-23
- **Autoridad superior:** PRD §24 (Learning pipeline), §42 (Learning governance); Constitución §26 (anti-goals)
- **Relacionado:** ADR-025

## Contexto

El PRD define un pipeline de aprendizaje que no se auto-modifica en
producción. R4-G debe dejar un ciclo operable — de un fallo observado a un
caso que ningún cambio futuro pueda reintroducir sin que se note — y decidir
si sus resultados necesitan estado durable en PostgreSQL.

## Decisión

1. **Learning en R4-G** significa: fallo observado → finding estructurado →
   revisión humana → `RegressionCase` → benchmark futuro. No significa:
   reescritura de instrucciones, mutación del registry, cambios de política
   o permisos, despliegue, RL ni mutación online.
2. **Ciclo con humano:** `npm run regression:promote` convierte un finding de
   un artifact en un caso **propuesto** (inerte) bajo
   `artifacts/regression-proposals/`. Sólo una persona lo vuelve **activo**:
   lo agrega al corpus del pack con un registro de revisión y su hash en el
   lock. El schema rechaza un caso activo sin revisión.
3. **Versionado de casos:** `id@version` + hash de lo que afirma (fixture y
   expectativas); cambiar expectativas sin nueva versión falla el lock.
4. **Quality observa y reporta, nunca modifica:** ningún código de Quality
   importa definiciones, registry, capabilities, política ni runtimes, ni
   escribe fuera de artifacts (`quality-boundaries`). Los evaluadores reciben
   una copia profundamente congelada del subject.
5. **Persistencia:** sin migración (0001–0006 congeladas; no se agrega 0007).
   La verdad de ejecución sigue en las tablas existentes; los resultados de
   evaluación son **artifacts inmutables** (`artifacts/evaluations|benchmarks|experiments`,
   ignorados por git) con manifest, serialización estable y privacidad
   verificada. No hay consumidor operacional que lea EvaluationRun,
   BenchmarkRun o Experiment desde la BD; todos son reproducibles desde la
   trayectoria durable + definiciones versionadas. Una tabla llegará cuando
   exista esa necesidad (p. ej. la UI de Quality del Experience Plane, o
   evaluación continua en R4-H).
6. **Corpus de regresión (código):** los casos, fixtures, rúbricas y locks
   viven versionados en el pack (`agents/sales/src/evaluations`); los
   artifacts generados no se commitean.

## Diferido (con seam)

- FailureCluster, KnowledgeCandidate e ImprovementProposal (PRD §21, §24):
  hoy sólo hay agregación por categoría/código y dedupe simple; el cluster
  necesita volumen real (R4-H+). Seam: `findings.jsonl`, `aggregate.json`.
- Quality Auditor como agente (PRD §22): la frontera semántica
  (`SemanticJudge` + rúbricas versionadas) es su punto de conexión; no se
  crea un Agent Pack evaluador en G.
