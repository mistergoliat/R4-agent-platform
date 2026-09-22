# ADR-001 — R4 separado del CRM

- **Estado:** Aceptado (R4-B)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §22, §25.11; PRD §3–§4

## Contexto

R3 acopló cognición, runtime y CRM en un mismo código (Next.js, `/hub`, tablas
internas). Eso impidió aislar fallos causalmente, cambiar de proveedor o canal
sin tocar el CRM, y reutilizar el runtime para agentes internos.

## Decisión

R4 es un repositorio independiente (`R4-agent-platform`) y un sistema
desplegable propio.

- R4 no importa código de `CRM-Customer-360` ni lee sus tablas.
- R4 no depende de Next.js, React, `/hub` ni estado de navegador.
- La integración futura será sólo por la API versionada de R4 (`/v1`) y eventos
  públicos (diferidos). El CRM es un consumidor, nunca la fuente autoritativa de
  AgentTask o AgentRun.
- R4 debe poder ejecutar tasks con el CRM apagado (PRD §4).

## Consecuencias

- Duplicación mínima aceptada: conceptos equivalentes se re-modelan con
  contratos propios en vez de compartir tipos (`@pesaschile/contracts` no se usa).
- El CRM necesitará un cliente HTTP de R4 (fuera de este repositorio).
- La autenticación entre sistemas queda pendiente (seam `PrincipalResolver`).

## Verificación

- `eslint.config.js`: imports de `next`, `react`, `@pesaschile/*`, rutas CRM y
  `/hub` prohibidos.
- `tests/contract/dependency-boundaries.test.ts`: allow-list de dependencias y
  prohibición de frameworks/infraestructura.
- `tests/contract/core-purity.test.ts`: cero términos `crm`, `whatsapp`, etc. en Core.
