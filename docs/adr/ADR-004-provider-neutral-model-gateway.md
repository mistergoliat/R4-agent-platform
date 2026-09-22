# ADR-004 — ModelGateway provider-neutral

- **Estado:** Aceptado (R4-B)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §20, §25.11; PRD §13

## Contexto

R3 quedó acoplado a un proveedor y a su formato de tool loop. R4 debe poder
cambiar de modelo sin reconstruir el runtime (PRD §45.2) y probar sus fronteras
sin red.

## Decisión

- `ModelGateway.generate(ModelRequest) → ModelResult` es la única superficie de
  modelo del runtime. Resultado como valor discriminado (`ok`/`error`), con
  errores clasificados y `retryable`.
- Los agentes declaran **requisitos abstractos** (`modelRequirements`), nunca un
  proveedor o modelo. Elegir el modelo es responsabilidad del gateway; el
  routing entre modelos queda diferido.
- Los vendors se integran implementando la SPI `ModelProvider`; su respuesta se
  valida en el gateway antes de llegar al runtime.
- El gateway impone el timeout aunque el proveedor lo ignore, soporta
  cancelación externa y sólo emite telemetría de metadata.
- `structuredData` y `toolCalls` son **propuestas no confiables**;
  `parseStructuredOutput` es la vía sancionada de validación.
- El gateway no depende de persistencia ni de capability-runtime: no puede
  escribir estado ni ejecutar efectos (ni directa ni transitivamente).
- `FakeModelProvider` determinista (texto, decisión estructurada, tool calls,
  fallo de proveedor, timeout, respuesta malformada) para tests y evaluación offline.

## Alternativas descartadas

- SDK de un vendor en el kernel; LangChain/LangGraph como base arquitectónica.
- Excepciones como canal de error (ocultan casos no manejados).

## Consecuencias

- Ningún adapter real existe en R4-B; el primero debe venir con su propia
  suite de contrato contra la SPI.
- La forma exacta de `AgentDecision` y el protocolo de acción se deciden en R4-C.

## Verificación

`tests/unit/model-gateway/gateway.test.ts`; ESLint (restricciones de import del
paquete); `tests/contract/provider-neutrality.test.ts`;
`tests/contract/dependency-boundaries.test.ts`.
