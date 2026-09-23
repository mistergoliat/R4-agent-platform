# ADR-023 — Sales Reference Application como Agent Pack (R4-F)

- **Estado:** Aceptado; publicado en el R4-F BASELINE `1927499`
- **Fecha:** 2026-09-23
- **Baseline R4-E:** `74ed8e728a7043db82ab672810faf1805787497d`
- **Autoridad superior:** Constitución §9–13, §25; PRD §20, §40 (R4-F), §43–44; ADR-002, 005, 011, 013, 016–018, 021
- **Relacionado:** ADR-024 (primer adapter real de `ModelProvider`)

## Contexto

R4-F es el primer workload real: un Sales Agent que sostiene una conversación
comercial natural, conserva el objetivo del cliente, consulta sistemas reales
mediante capabilities, construye una solución y produce una cotización
gobernada — sin codificar el flujo comercial como workflow y sin que Sales
entre en Core. La pregunta es si las primitivas genéricas de A–E bastan.

## Decisión

1. **Sales es un Agent Pack fuera de Core** (`agents/sales`, paquete
   `@r4-sales/agent`): definición (`sales.agent.json`), instrucciones,
   capabilities, estado Sales, fuente de contexto, política de acciones y
   composición. Core (`packages/*`, `apps/*`) no importa nada de Sales ni de
   `adapters/*` (contract test + ESLint). Un solo agente, sin subagentes, sin
   router de intents.
2. **Composición por los seams existentes, sin tocar el runtime:**
   `WorkerBindings.capabilities` (READ + `registerWrite`),
   `WorkerBindings.contextSources` (estado de dominio fuera de Core, C2) y
   `WorkerBindings.actionPolicy` (D). El kernel, el compilador, el scheduler y
   los runtimes se usan sin cambios.
3. **SalesWorkspace = estado de aplicación Sales, no `AgentTask`.** Tablas en
   el esquema propio `sales` (migración `agents/sales/migrations/0006_…`,
   aplicada con el migrador genérico `migrate(pool, {directory})`; 0001–0005
   intactas; desde el commit R4-F BASELINE (`1927499`), 0001–0006 congeladas y fijadas
   por `tests/contract/frozen-migrations.test.ts`): `conversations` (binding task → customer ref, escrito por el
   ingress), `workspaces` (versionado), `workspace_transitions` (append-only,
   una fila por execution key: auditoría + idempotencia), `quote_requests` y
   `quote_references` (append-only). Ninguna FK a tablas de R4; el task id es
   una referencia opaca del contexto confiable.
4. **El workspace no puede ser verdad de dominio.** Guarda hechos declarados
   (presupuesto, espacio, preferencias; corrección = reemplazo con historia),
   destino y selección (product id + cantidad). Ninguna clave/columna de
   precio, stock, costo, total o quote es representable (esquema + contract
   test). Precio y stock viven en observations del Catalog owner (con
   `freshnessTtlMs`, C2); totales, número, validez e identidad del quote en el
   receipt del Quote owner.
5. **Mutación sólo gobernada.** `sales.workspace.update` es un
   `REVERSIBLE_WRITE` (propose_action → policy → comando → receipt) con
   operaciones explícitas (`add_item`, `remove_item`, `set_item_quantity`,
   `replace_item`, `record_fact`, `retract_fact`, destino). Agregar lo ya
   seleccionado o cambiar lo no seleccionado se rechaza; no existe
   `select_products(array)`; los lotes son atómicos; ids nuevos se verifican
   con el Catalog owner. Idempotente por execution key (`idempotent_replay`).
6. **Proyección, no workflow.** `SalesWorkspaceContextSource` aporta un ítem
   `state` AUTHORITATIVE (owner: el pack) por conversación, requerido, y anota
   de forma determinista qué evidencia aplica al estado actual (envío para
   otro destino/selección = no aplica; evidencia de catálogo vigente o
   expirada; quote desactualizado por cambios). No decide nada: el agente
   decide si vuelve a leer.
7. **`quote.create` gobernado** (IRREVERSIBLE_WRITE, `reconcile_before_retry`):
   el modelo sólo da `workspaceVersion` y el cliente (nombre + email o
   teléfono); la selección y el destino salen del workspace y se registran con
   la execution key antes de la primera llamada; **la execution key es la
   idempotency key del Quote owner**. Rechazo del owner → `rejected`; owner
   inalcanzable antes de enviar → `failed`; timeout/conexión perdida tras
   enviar → `unknown` → reconciliación por clave (D/E). Cambiar la solución =
   una cotización nueva (no se editan cotizaciones emitidas en F).
8. **Política del pack** (`SALES_ACTION_POLICY`): la default de la
   plataforma más una sola decisión explícita — `quote.create` autónomo con
   identidad ≥ provisional y evidencia citada. Todo lo demás, igual al default.
9. **Dominio detrás de ports** (`adapters/domains`, sin dependencia de R4):
   Customer, Catalog (sólo lectura por construcción), Shipping, Quote, con
   fixtures deterministas. Ningún servicio real está documentado en este
   repositorio: los adapters live quedan **pendientes**, no se inventan
   endpoints. Errores clasificados (`not_found`, `validation`, `conflict`,
   `temporarily_unavailable`, `timeout`, `unknown_outcome`).
10. **Identidad desde el binding, nunca del modelo.** `customer.get_context`
    no recibe referencia de cliente; un cliente anónimo es una respuesta
    (`identity: unavailable`) y no bloquea explorar productos.
11. **Canal y entrega fuera.** El harness entrega input canónico
    (`submitInput`); `respond` es observable por el harness/API, nunca
    "entregado al cliente".
12. **Evaluación con la implementación:** 17 escenarios + el caso central con
    invariantes mecánicas sobre estado durable (`tests/sales`), un harness E2E
    (`sales:e2e`) y uno de comportamiento con modelo real (`sales:live`, fuera
    de CI). No es el framework de R4-G.

## Cambios en Core (mínimos, genéricos)

| Cambio | Por qué la abstracción no bastaba | Evidencia |
|---|---|---|
| `CapabilityFailure` (capability-runtime): el invoker conserva `details` JSON de un fallo clasificado por el owner en `observation.error.details` | `handler_error` sólo guardaba el mensaje: un owner no podía distinguir estructuralmente "no disponible" de "argumentos inválidos" sin mentir `outcome = succeeded` | `unit/capability-runtime/invoker` (2 tests), `unit/sales/domain-fixtures` |
| `ModelProviderError` acepta `timeout` e `invalid_provider_response` | un adapter con deadline de transporte propio sólo podía reportarlo como `provider_error` | `unit/model-gateway/gateway`, `unit/sales/openai-compatible-provider` |

Ambos son neutrales de dominio y de proveedor; ningún contrato, esquema ni
migración de Core cambió.

## Alternativas descartadas

- `packages/sales-core` o "CommercialWork v2" en Core (Constitución §10, PRD §44).
- Nueva decisión de kernel para escribir estado Sales (el protocolo sigue
  `r4.agent_decision.v3`; un write gobernado ya existe).
- Guardar selección/constraints sólo en conversación o memoria WORKING (no son
  autoridad para ids, cantidades ni destino).
- Hardcodear taxonomías de goals o etapas comerciales; subagentes especialistas
  sin evidencia.
- Adapters HTTP inventados para servicios no documentados.

## Consecuencias

- Otro Agent Pack puede usar R4 sin importar Sales: los mismos seams.
- El workspace crece con cada decisión del agente de registrar un hecho
  (writes por task: `R4_EXEC_MAX_WRITE_ACTIONS`/`maxWrites`).
- Una decisión inválida del modelo sigue terminando la run (C1; reintentos
  diferidos): el harness live lo registra, no lo corrige.

## Verificación

`tests/contract/sales-boundaries.test.ts`, `tests/unit/sales/*`,
`tests/integration/sales-reference.test.ts`, `tests/sales/*` (S01–S17 +
CENTRAL, invariantes negativas), ESLint (fronteras de `adapters/*` y
`agents/sales`), `tests/contract/core-purity.test.ts` (sin cambios).
