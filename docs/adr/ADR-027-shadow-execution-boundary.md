# ADR-027 — Frontera de ejecución shadow, bindings de dominio declarados y outbound sink (R4-H)

- **Estado:** Propuesto (R4-H en progreso; pendiente de auditoría)
- **Fecha:** 2026-09-24
- **Baseline R4-G:** `4a54b2c8dbb95b6cec8631e88d60be483d3ed64d`
- **Autoridad superior:** Constitución §25, §28; PRD §40 (R4-H), §43–44; ADR-002, 005, 008, 016–018, 021–026
- **Relacionado:** ADR-017 (Policy Engine), ADR-023 (Sales Agent Pack), ADR-025/026 (Quality)

## Contexto

R4-H debe someter la arquitectura A–G a workloads completos, repetidos y
realistas — runtime real, modelo real, límites de integración reales — sin
permitir todavía efectos de producción sobre clientes o negocio. Hacen falta
tres cosas que A–G no tenían: (1) un estado de ejecución *shadow* explícito y
verificable, (2) una frontera que decida **dónde** se materializa un efecto
que la Policy ya autorizó, y (3) un destino para `respond` que registre lo que
se habría enviado sin enviarlo. Todo sin un segundo motor de gobierno, sin
tocar Core y sin que el Sales Agent sepa que corre en shadow.

## Decisión

1. **Modo shadow explícito, fail-closed.** `R4_EXECUTION_MODE=shadow` (o la
   misma declaración pasada por el comando shadow, `--execution-mode shadow`;
   si ambas existen deben coincidir). Ausente o cualquier otro valor ⇒ la
   composición se rechaza. No existe un valor `production` en R4-H. Las
   llamadas de red son opt-in separados: `R4_SHADOW_ALLOW_LIVE_MODEL=true`
   (modelo real) y `R4_SHADOW_ALLOW_LIVE_READ=true` (binding live read-only).
   La configuración se registra (con fingerprint) en cada ShadowRun.

2. **Bindings declarados, nunca inferidos.** Un binding es una implementación
   de un port de dominio y declara `kind` (`fixture | live-read | sandbox |
   shadow | production`), cada operación con su clase de efecto
   (`read | write`, más el índice del argumento idempotency key) y, para
   `live-read`/`sandbox`, el contrato documentado que sigue. Nada se deduce de
   un verbo HTTP. La implementación declara también su propio `bindingKind`;
   descriptor e implementación deben coincidir (un fixture no puede
   presentarse como `live-read` editando sólo un descriptor).

3. **`ShadowExecutionPolicy` = dónde, no si.** Función pura de (config,
   binding, operación) → `READ_ALLOWED | SHADOW_WRITE | SANDBOX_WRITE |
   BLOCKED`. No mira quién pide ni por qué: eso sigue siendo del Policy Engine
   de R4-D. Ambos deben cumplirse: `ALLOW` de la Policy ≠ efecto de producción.
   BLOCKED: todo binding `production`, una operación no declarada, un
   `live-read` que declara alguna escritura, un `live-read` sin opt-in o sin
   contrato, un `sandbox` sin contrato. No es un segundo motor de gobierno: no
   hay reglas por capability, identidad, evidencia ni aprobación.

4. **Doble cierre.** `assertShadowComposition` rechaza al arrancar cualquier
   composición con un binding BLOCKED, dos bindings para un mismo dominio o un
   outbound que entregue. `guardPort` envuelve cada port y re-clasifica cada
   llamada en runtime (defensa en profundidad); una llamada BLOCKED nunca llega
   a la implementación y queda registrada.

5. **Side-effect manifest desde tres fuentes independientes.** Registros del
   guard (toda llamada a un owner externo, sólo metadata), ledger de R4-D en el
   estado durable (propuestas, decisiones, comandos, intentos, receipts) y
   outbound sink. Se unen por la execution key de la plataforma (que R4 pasa
   al owner como idempotency key). Chequeos deterministas por run:
   `production_effects_zero`, `real_outbound_deliveries_zero`,
   `unapproved_writes_zero`, `writes_without_receipt_zero`,
   `manifest_complete`, `one_receipt_per_execution`,
   `no_unresolved_uncertain_effect`, `binding_identity_recorded`. Los de
   severidad *blocker/integrity* detienen la suite (stop condition), igual que
   una fuga de secretos.

6. **Outbound: `ShadowOutboundSink`, única implementación.** `respond`
   conserva su semántica R4 (decisión durable en el step log). El sink lee esas
   respuestas del estado durable y registra mensaje (con datos personales
   redactados + sha256 del original), destinatario seudónimo (hash salado por
   suite), task, turno, response ref, timestamps, `wouldDeliver = true`,
   `actualDelivery = false` (literal en el esquema). La factory rechaza un
   binding `production-delivery`; no existe código de entrega.

7. **Quote en shadow: owner record-only.** No hay contrato documentado de un
   modo sandbox/preview/draft del Quote Service; por eso `quote.create` en
   shadow usa `ShadowQuoteService` detrás del mismo `QuoteService` port:
   precia desde los ports Catalog/Shipping, conserva la semántica del port
   (una cotización por idempotency key, replay, rechazo de key reutilizada,
   lookup para reconciliación, errores clasificados) y **registra** en vez de
   emitir: números en rango reservado `COT-9xxxxx`, id `shadow-qt-…`,
   `documentRef: shadow-record:…` (no existe documento). El camino completo de
   R4-D (propose → Policy → comando → handler → receipt → observation) es el
   mismo que en F.

8. **Sin integraciones inventadas.** Customer, Catalog y Shipping quedan
   `FIXTURE`: el contrato del Catalog service existe sólo de segunda mano fuera
   de este repositorio y R4 no tiene endpoint ni credencial configurados; no
   hay contratos de Customer ni Shipping configurados en R4. El framework
   soporta `live-read` (opt-in + contrato + sólo lecturas); el pack Sales no
   registra ningún binding live-read en R4-H.

9. **Ubicación.** `packages/shadow` (`@r4/shadow`): framework puro y genérico
   (contracts, evaluation, la SPI `ModelProvider`, zod, `node:crypto`) —
   WorkloadCase, modo, bindings, guard, manifest y chequeos, sink, ShadowRun,
   ShadowSuiteRun sobre el BenchmarkRun de R4-G, cost guard, agregados,
   sanitización, ArchitectureGapCandidate, artifacts. Sin I/O. Core no depende
   de él. El pack Sales aporta sus bindings, corpus, ejecutor y CLI en
   `agents/sales/src/shadow` (entrada `@r4-sales/agent/shadow`, fuera del
   runtime desplegado del agente, como `./evaluations`).

10. **Persistencia: ninguna migración.** Verdad de ejecución = tablas
    existentes (cada ShadowRun apunta a su AgentTask; no la reemplaza).
    Analítica shadow = artifacts inmutables (`artifacts/shadow/<suiteRunId>/`).
    El estado de los owners stand-in (fixture/shadow) vive en el proceso que
    los compone; el E2E multi-proceso emite los registros de efecto por stdout.
    0001–0006 intactas; no se agrega 0007.

## Alternativas descartadas

- *`ShadowPolicyEngine` / reglas de shadow en el Policy Engine*: duplicaría la
  autoridad de R4-D y mezclaría "si" con "dónde".
- *Un flag `shadow` dentro del Sales pack o de las capabilities*: el agente
  conocería el modo; el shadow se compone por los ports existentes.
- *Inferir lectura por verbo HTTP*: un GET puede tener efectos.
- *Tabla `shadow_runs`*: sin consumidor operacional; los artifacts bastan.
- *Adapter HTTP de Catalog a partir del cliente del CRM*: contrato de segunda
  mano, sin endpoint ni credencial en R4 y con un modelo de producto distinto
  (sería una integración no verificada).

## Consecuencias

- Una ejecución shadow es auditable: modo, bindings (con fingerprint),
  perfil de política, perfil de modelo, versión del caso, SHA y estado del
  árbol quedan en cada ShadowRun; `productionEffects = 0` y
  `realOutboundDeliveries = 0` son contados, no supuestos.
- Un pack futuro (Marketing) reutiliza el framework declarando sus bindings,
  su corpus y su `WorkloadExecutor`; no hay nada de Sales en `@r4/shadow`.
- Un modelo local (p. ej. 70B OpenAI-compatible) corre la misma suite como
  otro `modelProfile` (sólo configuración `R4_MODEL_*`).
- Cambios en pruebas previas (extensión, no relajación): allow-list de
  dependencias (`@r4/shadow`), exclusión explícita de `packages/shadow` de
  "Core execution" en `quality-boundaries` y de `agents/sales/src/shadow` del
  runtime del pack en `sales-boundaries`/`quality-boundaries`, y las nuevas
  dependencias del pack (`@r4/scheduler`, `@r4/shadow`). `shadow-boundaries`
  re-verifica las reglas.

## Verificación

`tests/unit/shadow/*`, `tests/contract/shadow-boundaries.test.ts`,
`tests/shadow/shadow-suite.test.ts` (suite offline completa sobre PostgreSQL),
`tests/recovery/shadow-process.test.ts` (procesos reales: worker SIGKILL,
worker nuevo, scheduler), `npm run test:mutation:shadow` (9/9).
