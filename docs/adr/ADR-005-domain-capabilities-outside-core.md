# ADR-005 — Capabilities de dominio fuera de R4 Core

- **Estado:** Aceptado (R4-B)
- **Fecha:** 2026-09-22
- **Autoridad superior:** AGENTS.md "Core rule"; PRD §20, §36, §44

## Contexto

El criterio de éxito de R4 es que un segundo vertical (Marketing Analyst) se
construya sin modificar Core (PRD §36). Si Core conoce Quote, Cart, Product o
Payment, esa prueba falla por construcción.

## Decisión

- Core contiene sólo primitivas genéricas: Agent, Task, Run, Goal, Observation,
  Capability (metadata y ejecución gobernada), y en fases futuras Action,
  Receipt, Policy, Schedule, Consultation, Approval, Handoff, Evaluation, Artifact.
- Las capabilities de dominio las registran **agent packs** (`agents/*`) o
  **domain adapters** (`adapters/domains/*`), declarando `owner`, `riskClass`,
  scopes y esquemas. Core las gobierna; no las conoce.
- Los tipos de task se namespacean por pack (`probe.echo`), y un agente sólo
  acepta los tipos que declara.
- La capability de prueba de R4-B (`platform_test.get_test_fact`) vive en
  `tests/fixtures`, no en Core.
- El único agente del repositorio es `platform-probe`, sin propósito de negocio
  ni scopes de escritura.

## Consecuencias

- El Sales Agent (R4-F) será un pack con sus propias definiciones, skills,
  policies, context extensions, capabilities y rúbricas.
- Nombres de dominio en Core son un defecto de arquitectura, no un estilo.

## Verificación

`tests/contract/core-purity.test.ts` (escaneo de `packages/` y `apps/` —
código, SQL y JSON — contra términos de dominio, canal, CRM y vendor);
`tests/contract/provider-neutrality.test.ts` (sin campos de dominio en los
contratos públicos).
