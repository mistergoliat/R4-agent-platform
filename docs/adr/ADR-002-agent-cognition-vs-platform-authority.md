# ADR-002 — Cognición del agente vs. autoridad de la plataforma

- **Estado:** Aceptado (R4-B)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §9, §25.1–§25.5, §25.9; PRD §2

## Contexto

R3 concentró interpretación, memoria, planificación, routing, ejecución y
recuperación en el loop del modelo. P7.12 observó narración de efectos no
ejecutados; P7.13 observó `invalid_model_json` masivo. A la vez, R1/R2
mostraron que un workflow determinista que decide la estrategia no sirve para
objetivos abiertos.

## Decisión

Separación explícita, reflejada en la estructura de paquetes:

| El agente (cognición) puede | La plataforma (autoridad) decide |
|---|---|
| razonar, planificar, replanificar | identidad (`PrincipalResolver`) |
| formar goals/subgoals y elegir el foco | integridad de goals (misma task, activos, una raíz) |
| proponer lecturas y acciones | scopes, riesgo, validación de argumentos y salidas |
| sintetizar resultados | estado de tasks/runs, transiciones legales, versiones |
| pedir ayuda | idempotencia, concurrencia, budgets efectivos |
| | qué ocurrió realmente (Observations inmutables) |

Reglas concretas en R4-B:

1. La salida del modelo es `unknown` hasta ser validada por el esquema del
   llamador (`parseStructuredOutput`).
2. Toda invocación de capability produce una Observation — también los
   rechazos —; nada se infiere del texto.
3. `TrustedExecutionContext` lo construye la plataforma desde estado durable;
   el handler de una capability no ve nada que el modelo haya afirmado.
4. El Task Runtime aplica el ciclo de vida pero **no** decide la siguiente
   acción; por ejemplo, cerrar un goal nunca mueve el foco implícitamente.
5. Writes no ejecutables en R4-B (`execution_not_permitted`) hasta que exista
   ActionProposal → Policy → Execution → ActionReceipt (R4-D).

## Consecuencias

- El kernel de R4-C será un consumidor de estos servicios, no su dueño.
- Riesgo a vigilar: que el Task Runtime acumule reglas de "qué hacer después"
  y se convierta en el planner de R1/R2. Cualquier regla nueva debe ser una
  invariante de autoridad, no una decisión de estrategia.

## Verificación

`tests/unit/capability-runtime/invoker.test.ts`,
`tests/unit/model-gateway/gateway.test.ts`,
`tests/integration/task-runtime.test.ts`,
`tests/integration/capability-observations.test.ts` (recorrido completo offline).
