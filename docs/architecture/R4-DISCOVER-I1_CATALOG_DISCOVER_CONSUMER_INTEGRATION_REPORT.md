# R4-DISCOVER-I1 — Catalog Discover Consumer Integration

Integración **no productiva** de `catalog.discover` (owner: catalog-service) en el Sales Agent de R4.

- Fecha: 2026-10-10.
- Repositorio principal: R4 (`r4-j3d-ec2-acceptance-evidence` @ `d94b122`).
- Dependencia: `MS-pesaschile-catalog-service` @ `6dd4b5d` (`feat/catalog-discover-c2`), solo lectura.
- Sin commits, push ni deploy. Catalog no fue modificado: `git status` limpio antes y después.

## A. Resumen

R4 obtiene una capacidad model-visible `catalog.discover`, de solo lectura y no productiva. Descubre productos por necesidad conceptual y restricciones usando exclusivamente la evidencia de Catalog.

**Qué hace R4:**

- Transporta el request.
- Protege los datos que no deben salir.
- Exige que el presupuesto enviado sea el vigente del workspace.
- Lee los estados del owner con una política de consumo explícita.

**Qué no hace R4:** interpretar la necesidad, verificar restricciones, rankear, calcular precios ni elegir variantes.

**Otros cambios:**

- Se corrigió el fixture comercial divergente (`fixture.ts:93`).
- El claims checker distingue información de oferta comercial.
- La capacidad no está en ningún perfil de producción.

**Pruebas:**

- 159 tests nuevos en 8 suites, incluido el caso de cinco turnos sobre el proceso real de R4 con PostgreSQL.
- Un test entre procesos contra la app HTTP real del owner con catálogo sintético.
- La regresión completa de R4 se resume en §N: 1.834 PASS; los 2 fallos intermitentes no tocan Discover y pasan aislados.

`REAL_CATALOG_E2E=NOT_RUN`: no hay Catalog desplegado autorizado. Todas las respuestas usadas son del owner, pero sobre su catálogo **sintético**.

## B. Preflight

**R4.**

- HEAD `d94b122` («J3D EC2 deployment evidence…»), una revisión posterior a `ef5a354`.
- Árbol limpio. Un stash previo (`stash@{0}`, settings locales) se dejó intacto.
- No había documentos modificados por terceros en este checkout; no se sobrescribió ningún archivo ajeno.

**Componentes identificados:**

| Componente | Ubicación |
|---|---|
| Tool registry (capabilities) | `agents/sales/src/ids.ts`; `capabilities/*.ts`; `packages/capability-runtime/src/registry.ts` (zod → JSON Schema con `z.toJSONSchema`) |
| Harness de ejecución | `packages/agent-kernel/src/kernel.ts`; `packages/capability-runtime/src/invoker.ts`. Las lecturas no se reintentan (`maxAttempts: 1`) y siempre registran una Observation |
| Cliente HTTP de Catalog | `adapters/domains/catalog/http/src/adapter.ts`, escrito a mano con mirrors zod no estrictos. No hay generación de cliente |
| Secretos | `R4_CATALOG_BASE_URL` / `R4_CATALOG_API_KEY` / `R4_CATALOG_TIMEOUT_MS` (`config.ts`). Fuera de loopback se exige `R4_PROD_ALLOW_NETWORK` y https |
| Claims checker | `agents/sales/src/evaluations/claims.ts`: evaluación post-hoc, no runtime |
| Estado multi-turn | Sales workspace (`workspace/model.ts`, Postgres): hechos `record_fact` / `retract_fact` que reemplazan por clave, más la conversación en contexto |
| Errores | `DomainError` (categorías), mapeado a `CapabilityFailure` por `domainRead` |
| Cotización | `quote.create@2` verifica cada unidad con item context (`sellable`, stock, precio) |
| Item context | Solo interno: `add_item` del workspace y quote. No es model-visible |
| Fixtures comerciales | `FixtureCatalog` (`adapters/domains/src/catalog/fixture.ts`) y fixtures v2 vendorizados (`fea0dc55`) |

**Catalog (lectura).** Contrato `catalog.discover`:

- `schemaVersion` 1.
- `contractVersion` actual `catalog-discover-v1b1`; revisiones `[v1a, v1b2, v1b1]`.
- Ruta `POST /v2/catalog/discover`.
- Flag `CATALOG_DISCOVER_ENABLED`, apagado por defecto.
- Allowlist `CATALOG_DISCOVER_API_KEYS` ⊆ `CATALOG_API_KEYS`.

Hashes LF de las fuentes del contrato en `6dd4b5d`:

| Archivo | sha256 (LF) |
|---|---|
| `discover-v1a/agentContract.ts` | `c58a0426b65af824…` |
| `discover-v1a/contracts.ts` | `797e5f87bf77041…` |
| `routes/catalogDiscoverRoute.ts` | `18e0dd7b5d96d3e8…` |
| `domain/catalog/v2/contracts.ts` | `992b83102f0fdd68…` |
| `domain/catalog/v2/unitPriceBudget.ts` | `44a10a7a76f95d9d…` |

Los hashes completos están en `adapters/domains/catalog/http/fixtures/discover/MANIFEST.json`.

## C. Compatibilidad v1b2 ↔ v1b1 (resuelta antes de consumir)

**Diff del contrato ejecutable** (`git diff aac3f8a HEAD -- agentContract.ts`, B2 → B1):

- **Request:** sin cambios.
- **Respuesta, tres campos nuevos:** `candidate.requirements`, `completeness.counts.rejectedByCommercialConstraints` y `commercialFreshness.observations`.
- **Vocabularios abiertos, valores nuevos:** `SATURATED`/`CANCELLED` y `COMMERCIAL_TRUTH_SATURATED`/`COMMERCIAL_REQUEST_CANCELLED`.
- **Lo que no cambia:** ningún campo se quitó ni cambió de tipo, y ningún enum cerrado cambió.
- **Cambio semántico:** solo en advertencias (vocabulario abierto).

**Decisión R4:**

- Acepta `catalog-discover-v1b2` y `catalog-discover-v1b1` (`CATALOG_DISCOVER_KNOWN_REVISIONS`). Los tres campos B1 son **opcionales** en R4.
- Sin `requirements` (productor v1b2), un `VERIFIED_MATCH` deriva sus requisitos como SATISFIED, porque es la definición contractual de VERIFIED. Cualquier otra disposición es `UNKNOWN`/`NOT_EVALUATED`, nunca satisfecha.
- Una etiqueta desconocida con `schemaVersion` 1 se parsea, pero se marca `contract.recognized=false`.
- `schemaVersion` ≠ 1 se rechaza.

**Pruebas:**

- Las 24 respuestas del owner se reducen a forma v1b2 y se comparan. La lectura v1b2 **nunca** es más permisiva que la v1b1, y las afirmaciones a nivel respuesta coinciden.

`CATALOG_CONTRACT_VERSION_VERIFIED=YES`: contra el productor real en `6dd4b5d`, con fixtures exportados por R4 desde el owner y verificados entre procesos (§I).

## D. Arquitectura antes / después

| | Antes | Después |
|---|---|---|
| Herramientas del modelo (catálogo) | `catalog.search`, `catalog.get_product_context` | Las mismas, más `catalog.discover` **solo** si la composición recibe un binding Discover |
| Ids | `CAPABILITY_IDS` | + `NON_PRODUCTION_CAPABILITY_IDS.catalogDiscover`, fuera de `CAPABILITY_IDS` a propósito |
| Producción | `production/composition.ts` registra catálogo según el perfil | Sin cambios. Ningún perfil (v1–v4) lista `catalog.discover` (test) |
| Transporte | `HttpCatalogAdapter` (`/v2/catalog/{search,products,items}`) | + `HttpCatalogDiscoverAdapter` (`POST /v2/catalog/discover`), con la misma clave base o una dedicada |
| Port | `CatalogPort` | + `CatalogDiscoverPort` (`adapters/domains/src/catalog/discover.ts`): tipos del contrato y `CatalogDiscoverError` |
| Claims checker | Precio = número observado vigente | + reglas de **oferta** y evidencia Discover; `sales.grounding` v3, rúbrica de extracción v2 |
| FixtureCatalog | `maxUnitPrice` ignoraba `basis` | `maxUnitPrice` solo lo satisface un precio `offerable` (predicado del owner) |
| Estado multi-turn | Workspace (hechos por clave) | El mismo. Discover lo lee para coherencia del presupuesto; no hay memoria nueva |

**Flujo:**

1. El modelo produce `read_capability catalog.discover`.
2. El invoker valida el input zod estricto.
3. Guardas de texto.
4. Coherencia del presupuesto con el workspace.
5. `HttpCatalogDiscoverAdapter`.
6. Catalog.
7. Parseo tolerante con invariantes.
8. Vista y lectura de consumo.
9. Observation con `validUntil` = mín(TTL R4 5 min, `earliestValidUntil` del owner).

## E. Contrato Catalog utilizado

**Fuente de verdad:**

- El contrato ejecutable del owner (`agentContract.ts`).
- Sus 24 escenarios agente (`tests/contract/discover-agent/scenarios.ts`).
- Su matriz HTTP (`catalogDiscoverRoute.ts`).

**Generación de cliente:** no existe para este contrato, ni en Catalog ni en R4.

- R4 mantiene un mirror escrito a mano (`discover-schemas.ts`), según la convención existente de R4 para v2. No duplica tipos sin control.
- Un chequeo en compilación exige que la salida del esquema sea asignable al tipo del port.
- Un test compara cada enum cerrado de R4 con el JSON Schema publicado por el owner.

**Fixtures vendorizados** (`adapters/domains/catalog/http/fixtures/discover/`, 32 archivos):

- Los exporta `scripts/catalog-discover/export-fixtures.mts`, ejecutado desde el checkout de Catalog. Importa el código del owner por ruta y no escribe allí.
- Contenido: 24 escenarios, 5 turnos R4, matriz de errores, JSON Schemas del request y de la respuesta tolerante, y `MANIFEST.json` (commit, revisión, hashes LF de las fuentes, hash de cada archivo).
- **Reproducible:** re-exportar da 32/32 archivos idénticos.
- **Naturaleza:** respuestas reales del servicio del owner sobre catálogo **sintético**. No son gold ni producción.

## F. Herramienta implementada

**`catalog.discover`** (`agents/sales/src/capabilities/discover.ts`):

- READ, `catalog.read`.
- `maxAttempts: 1`.
- Timeout de capacidad 6 s; adaptador 4,5 s por defecto.

**Input (estricto):**

| Campo | Regla |
|---|---|
| `need` | 2..200 caracteres |
| `useContext` | Opcional, 2..80 |
| `constraints` | `maxUnitPriceClp`, `sellableOnly`, `minUserCapacityKg`, `minLoadKg`, `max{Length,Width,Height}Cm`: los del owner, con la unidad en el nombre |
| `referenceProductKeys` | Hasta 8 |
| `selectedItemKeys` | Hasta 8 |
| `limit` | 1..8, por defecto 5 |

- `need` + `useContext` suman como máximo 300 caracteres.
- **No hay campo de identidad**, transcripción ni acción (test sobre las propiedades del JSON Schema).

**Guardas previas al envío** (nunca se envía; el owner sigue siendo la autoridad):

- **Transcripción:** saltos de línea o turnos con hablante.
- **Datos detectables:** email, teléfono chileno, RUT, tarjeta, dirección con número.
- **Sin falsos positivos** en necesidades normales: «20 kg», «2,2 m», «depto pequeño de 40 m2», precios, etc. (tests).
- Los errores no repiten valores.

**Coherencia con el workspace** (estado conversacional existente):

- `maxUnitPriceClp` debe ser igual a un hecho de presupuesto **vigente** (`^(budget|presupuesto)(_|$)`, monto CLP).
- Si no hay hecho: `budget_not_recorded`.
- Si el valor no es el vigente (reemplazado o retractado): `budget_not_current`.
- Omitir un presupuesto registrado está permitido y queda reportado (`unappliedWorkspaceBudgets`).

**Salida (vista):**

- `request` enviado.
- `contract` (revisión, `recognized`).
- `status`.
- `interpretation`: `required`, `preferred`, `notVerifiable`, `unrecognized`, `structuredApplied`, ambigüedades con lecturas y candidatos, `selection`.
- `candidates`: hechos comerciales del owner, más `reading` por candidato.
- `completeness`, `absence`, `degradation`, `freshness`, `reading` de la respuesta, `warnings`.
- Sin scores ni evidencia cruda.

**Search sigue vigente.** `catalog.search` se mantiene para búsquedas nominales; la descripción de Discover enruta explícitamente. Discover no reemplaza nada (test de composición).

## G. Semántica de consumo (`discover-reading.ts`)

Lee estados, nunca texto. Todo lo no establecido positivamente por el owner es inafirmable.

| Hecho del owner | Lectura R4 |
|---|---|
| `VERIFIED_MATCH` / `POSSIBLE_MATCH` | `PURCHASABLE` o `WITH_COMMERCIAL_CAVEAT` / `POSSIBILITY_WITH_CAVEATS`. Un POSSIBLE nunca se presenta como verificado |
| Requisito SATISFIED / UNKNOWN / UNSUPPORTED / VIOLATED / NOT_EVALUATED | Solo SATISFIED habilita `MEETS:<code>`. El resto queda en `forbiddenClaims`, igual que las preferencias (p. ej. `USE_CONTEXT:SMALL_SPACE`) |
| `COMPLETE` ≠ exhaustivo | `COMPLETE_LIST` y `NONE_EXIST` solo con `COMPLETE` + `exhaustive` y las condiciones B2. `PARTIAL`/`DEGRADED` nunca habilitan «no existen» |
| `DEGRADED` | Respuesta con reservas: `COMMERCIAL_TRUTH_DEGRADED`, `RETRY_LATER` si `degradation[].retryable` |
| Frescura | `CURRENT` solo si el owner observó y su `validUntil` (y el de la unidad) no pasó según el reloj de R4; `EXPIRED`/`UNKNOWN` no habilitan ninguna afirmación comercial |
| `basis: not_offerable` | Solo `PRICE_REFERENCE_ONLY`. Nunca `PRICE_CURRENT`, `ORDERABLE_NOW` ni `WITHIN_BUDGET` |
| `kind: from` | `PRICE_FROM` y acción `SELECT_ITEM`. Nunca `PRICE_CURRENT` ni `VARIANT_FIXED` sin selección |
| Unidad (`itemKey`) | `SELECTED` (elegida), `ONLY_UNIT` (exacto), `WITNESS` (certificó una restricción; no es elección del cliente) o `UNDETERMINED` |
| Presupuesto | `WITHIN_BUDGET` solo con `price<=X` SATISFIED por `COMMERCIAL_TRUTH`, precio offerable y unidad ordenable |
| Variante inexistente | `selection.notFound`: pregunta `SELECTED_VARIANT_NOT_FOUND`, nunca se presenta con precio |
| Siempre prohibidas | `PURCHASE_CONFIRMED`, `BEST_FOR_CUSTOMER`, `BEST_IN_CATALOG` |

**Aclaraciones:** `askCustomer` con `AMBIGUOUS_NEED`, `VARIANT_CHOICE`, `SELECTED_VARIANT_NOT_FOUND`, `UNSUPPORTED_REQUIREMENT` o `UNRECOGNIZED_TERMS`.

**Acciones siguientes:**

- `CONFIRM_ITEM` (item context) solo para una unidad determinada.
- `SELECT_ITEM` (product context) cuando hay que elegir variante.

## H. Mapeo de errores

`CatalogDiscoverError` extiende `DomainError` y queda en la Observation como `details.discoverFailure`. Para que la retryabilidad declarada por el owner prevalezca sobre la categoría, `DomainError` ganó un override opcional `retryable`, compatible hacia atrás.

| HTTP del owner | Fallo R4 | Categoría | Reintentable |
|---|---|---|---|
| 400 `invalid_request` / `unsupported_schema_version` / `contradictory_constraints`; 413; 415; guardas locales | `INVALID_REQUEST` (issues `CODE@path`, sin valores) | validation | no |
| 401 `unauthorized` / 403 `forbidden` (allowlist) | `AUTH_FAILED` | unauthorized | no |
| 503 `capability_disabled` | `DISABLED` | temporarily_unavailable | **no** |
| 503 `capability_not_ready` / `index_incompatible` / `capability_shutting_down` / `request_cancelled` | `NOT_READY` | temporarily_unavailable | según el owner |
| 503 `capability_saturated` | `SATURATED` (+ `retryAfterSeconds`) | temporarily_unavailable | sí, pero **nunca automático** |
| 429 | `RATE_LIMITED` | temporarily_unavailable | sí |
| 500 `internal_error` / `contract_output_invalid`; otros 5xx | `SERVICE_ERROR` | temporarily_unavailable | según el owner (500: no) |
| Plazo local / señal del llamador | `TIMEOUT` | timeout | sí |
| Red | `UNREACHABLE` | temporarily_unavailable | sí |
| 200 no JSON, `schemaVersion` ≠ 1, `FAILED` con 200, violación de invariantes | `CONTRACT_VIOLATION` | contract_violation | no |
| **200 `COMPLETE` / `PARTIAL` / `DEGRADED`** | **respuesta**, no error | — | `degradation[].retryable` |

**Reglas:**

- Ningún 503 se lee como «no hay productos».
- Ningún 200 se lee automáticamente como resultado completo.
- El adaptador no reintenta (test: saturación da una sola llamada). La política del harness para lecturas sigue siendo `maxAttempts: 1`.

**Invariantes verificados en cada 200** (violación = rechazo, nunca reparación):

- `verified` solo contiene VERIFIED y `possible` solo POSSIBLE; REJECTED no llega.
- `unit.itemKey` = `candidate.itemKey`: precio y stock de la misma unidad.
- Un `itemKey` en `selection.notFound` nunca se repite como unidad.
- `requirements` sigue a `required`, uno por código y en el mismo orden.
- `exhaustive` solo si no hubo corte ni degradación.

**Telemetría:** resultado, estado HTTP y **longitud** de la necesidad. Sin texto ni claves (test).

## I. Pruebas

Se separan cuatro niveles. Ninguna prueba simulada se declara end-to-end.

| Nivel | Suite | Tests | Qué cubre |
|---|---|---|---|
| 1. Unitarios con fixtures | `tests/unit/catalog-http/discover-adapter.test.ts` | 19 | Forma del request; sin campos ajenos; validación local; 401/403 sin filtrar la clave; saturación + `Retry-After` sin reintento; 503 distintos; 500/502; timeout propio y abort del llamador; red; telemetría sin texto; configuración (OFF por defecto, plazo, clave dedicada, red) |
| | `tests/unit/sales/catalog-discover-capability.test.ts` | 46 | Input (8 rechazos: identidad, contacto, conversación, acción, límite…); guardas y no falsos positivos; coherencia del presupuesto; lecturas de los escenarios 4, 8–21 y 23; ventana del owner en la Observation; fallos tipados como Observations; registro y frontera de producción |
| | `tests/unit/sales/catalog-discover-variants.test.ts` | 4 | Resolución de variantes (§K) |
| | `tests/unit/sales/evaluation/claims-offerability.test.ts` | 15 | Claims checker (§L), con negativos explícitos |
| | `tests/unit/sales/fixture-commercial-budget.test.ts` | 5 | Fixture comercial (§M) |
| 2. Contrato Catalog/R4 | `tests/contract/catalog-discover-contract.test.ts` | 63 | Manifest (hashes, procedencia, revisión); enums cerrados = owner; **24 escenarios** leídos por el adaptador y la política reales de R4 contra las expectativas del consumidor de referencia; tamaño < 16 KB; compatibilidad v1b2/v1b1; 12 cambios incompatibles rechazados; aditivos aceptados; matriz de errores completa |
| 3. Integración con el proceso real de R4 | `tests/sales/catalog-discover-multiturn.test.ts` | 1 | Cinco turnos con API, worker, kernel, compilador de contexto, invoker, escrituras gobernadas del workspace y PostgreSQL (§J) |
| 3b. Entre procesos (owner real, catálogo sintético) | `tests/integration/catalog-discover-owner-process.test.ts` | 6 | App Fastify real del owner (auth, allowlist, flag, runtime, servicio, owner J1 v2) por TCP. Ejecutada con `R4_DISCOVER_OWNER_REPO`; sin esa variable se reporta skipped |
| 4. E2E con Catalog real | — | — | `NOT_RUN`: no hay Catalog desplegado autorizado con Discover habilitado |

**Detalle del nivel 3b:**

- Los 5 turnos R4 y 16 escenarios servidos por el catálogo sintético por defecto dan, por HTTP, exactamente lo registrado en los fixtures.
- 401 (clave desconocida), 403 (clave autenticada fuera de la allowlist) y 503 `capability_disabled` (proceso con flag apagado).
- 400 `PERSONAL_DATA` del owner para un email enviado directamente por el adaptador, sin la guarda de la capacidad: es defensa en profundidad del owner.
- Cadena completa invoker → guardas → workspace → adaptador → owner → vista.

**Comprobación de mutación:** permitir `PRICE_CURRENT` y `WITHIN_BUDGET` con `basis: not_offerable` hace fallar los escenarios 8 y 11 del contrato. El código se restauró.

**Escenarios específicos del harness:**

| Escenario | Dónde se prueba |
|---|---|
| Selección de herramienta | Descripción y composición; Search intacto |
| Interpretación del resultado | §G |
| Continuidad multi-turn | §J |
| Restricciones comerciales | §G, §L, §M |
| Aclaraciones | Escenarios 9, 10, 15 y 21; turno 3 |
| Errores HTTP, timeout, saturación | §H |
| Degradación | Escenarios 13 y 20 |
| Variantes | §K |
| Claims checker | §L |
| No filtración de datos personales | Guardas, 400 del owner y telemetría |

## J. Pruebas multi-turn (caso obligatorio)

**Proceso real de R4** (worker, kernel y Postgres). El modelo es el stand-in determinista de CI: prueba la semántica de plataforma y pack, no lo que decidiría un modelo real. Catalog son respuestas del owner reproducidas por el adaptador HTTP real de R4, **emparejadas por el body exacto** que R4 envió. Una request distinta de la esperada hace fallar el test.

El stand-in deriva cada request **solo del workspace que ve en contexto**:

| Turno | Cliente | Workspace (hechos) | Request enviado a Catalog | Resultado del owner |
|---|---|---|---|---|
| 1 | «Necesito una máquina para entrenar espalda» | `need` | `need: "máquina para entrenar espalda"` | P6, P7, P14 (`required: [ANATOMY:BACK]`) |
| 2 | «Tengo poco espacio» | + `use_context` | `need: "… poco espacio"` | P7, P6, P14; `preferred: [USE_CONTEXT:SMALL_SPACE]` (nunca afirmado) |
| 3 | «Mi presupuesto es de $300.000» | + `budget` = 300.000 | + `constraints.maxUnitPriceClp: 300000` (`budgetFromWorkspace: budget`) | P7, P6; sale P14 (1.071.000). P7 calza vía unidad testigo: `PRICE_FROM`, `WITHIN_BUDGET`, prohibido `VARIANT_FIXED`; **aclaración**: ¿qué color? |
| 4 | «Prefiero una polea» | `need` **reemplazado** por «polea para entrenar espalda»; + `preference` | `need: "polea para entrenar espalda poco espacio"`, 300.000 | `[PRODUCT_TYPE:CABLE_MACHINE, ANATOMY:BACK, price<=300000CLP]`: vacío, exhaustivo, `NO_VERIFIED_CANDIDATES`. «No hay… hasta $300.000» y pregunta |
| 5 | «Puede costar hasta $400.000» | `budget` **reemplazado** (300.000 → 400.000) | El stand-in envía primero 400.000 sin registrarlo: **rechazado antes de Catalog** (`budget_not_current`). Registra la corrección y reenvía con 400.000 | Vacío, exhaustivo. «No hay… hasta $400.000» y pregunta por alternativas |

**Verificado:**

- Las 5 requests son idénticas a las del owner.
- Restricciones vigentes conservadas (`use_context`).
- Sustitución explícita del presupuesto: las transiciones del workspace muestran `null → 300.000 → 400.000`, nunca dos valores.
- La necesidad se reemplaza, no se acumula.
- Nuevas preferencias interpretadas: el término de producto pasa a «polea».
- Aclaraciones: color de variante; ampliar presupuesto o ver alternativas.
- Sin contradicciones: el valor rancio nunca llega a Catalog.
- Requests acotadas, sin conversación, sin datos del cliente ni identidad.
- Catalog no recibe ni guarda estado conversacional.
- Restricción descartada: la retracción de un presupuesto bloquea su envío (`budget_not_recorded`, test unitario). En el caso obligatorio, el término «máquina» se reemplaza.

## K. Validación de variantes

| Necesidad | Capacidad |
|---|---|
| Necesidad conceptual, objetivo, uso, combinación de specs | `catalog.discover` |
| Nombre, SKU, referencia, búsqueda nominal exacta | `catalog.search` (sin cambios) |
| productKey conocido: hechos y opciones de variante | `catalog.get_product_context` |
| Una unidad vendible: precio y stock exactos para una cantidad | Item context **interno** (`add_item` del workspace, quote). No es model-visible |

**Pruebas** (`catalog-discover-variants.test.ts`):

- **Candidato «desde».** Sin `itemKey`, con `next = SELECT_ITEM` vía product context. El workspace rechaza el productKey (`variant_required`) consultando al owner antes de escribir.
- **Variante inexistente.** `selection.notFound` termina en `unknown_product`.
- **Unidad testigo.** No queda fijada; la unidad elegida se confirma con el owner antes de entrar a la selección.
- **Variante seleccionada.** Precio de **su** unidad (273.700, no el «desde» 261.800) y `CONFIRM_ITEM` sobre ese `itemKey`.

Quote@2 sigue re-verificando la unidad (`sellable`, stock, precio) antes de emitir. No se agregaron acciones mutantes.

## L. Reglas del claims checker

**Ubicación y versiones:** `agents/sales/src/evaluations/claims.ts`; `sales.grounding` v3; `sales.claim_extractor` v2 con rúbrica v2. El lock de la rúbrica registra el hash v2 y conserva el v1.

**Información vs oferta:**

- **Precio informativo** («cuesta X»): regla previa sin cambios.
- **Oferta:** atributos `offer`, `purchasable`, `orderable`, `withinBudget` o `budget`, o redacción de oferta («puedes comprarlo», «dentro de tu presupuesto»…).
- Una recomendación sigue siendo informativa salvo que presente una oferta.

**Una oferta exige, para cada producto nombrado:**

1. Observación comercial del owner vigente al observarla. Valen Search, product context o Discover `OBSERVED`; `EXPIRED`/`UNKNOWN` no fundamentan.
2. Unidad identificada: precio exacto sin variantes, o el `itemKey` que nombra la afirmación. El «desde» nunca certifica una variante; la unidad testigo no es elegida.
3. Unidad vendible según el owner: `offerable` + ordenable. El precio referencial nunca es oferta.
4. Presupuesto satisfecho por ese precio offerable.
5. Sin conflicto de variante: precio, stock y vendibilidad del **mismo** `itemKey`.

«Hay uno dentro de tu presupuesto», sin variante ni monto, se apoya en el «desde» offerable o en la certificación `price<=X@COMMERCIAL_TRUTH` del owner.

**Ausencia por Discover:** solo con respuesta `COMPLETE`, exhaustiva, vacía, sin `contributing`, `unrecognized`, ambigüedad ni degradación. Si fue vacía **bajo un presupuesto**, solo fundamenta una afirmación que declara ese mismo presupuesto. Sin calificar, no fundamenta: la polea existe sobre el monto (test).

**Negativos explícitos (15 tests):**

- Referencial (PR-300, 459.990) como oferta o presupuesto.
- Oferta a otro monto o sobre presupuesto.
- «Desde» como precio de la variante de 24 kg.
- Producto con variantes sin unidad.
- Observación ya vencida.
- Variante seleccionada al precio «desde» o a otra variante.
- Testigo como oferta.
- Referencial, sin stock, `EXPIRED` y `UNKNOWN` de Discover.
- «En stock» en backorder.
- Lectura posterior a la ventana.
- Recomendación con oferta.
- Ausencia desde `PARTIAL`, `DEGRADED` o truncado.

## M. Corrección del fixture comercial

**Antes.** `fixture.ts:93` dejaba pasar `maxUnitPrice` con `priceSummary.finalGross ≤ max` sin mirar `basis`: un referencial no ordenable cumplía el presupuesto. Ejemplo: RACK-PR300, sin stock y sin backorder, 459.990.

**Ahora.** Exige `basis === 'offerable'`, igual que `evaluatePriceSummaryBudget` del owner; Search conserva solo SATISFIED. También se corrigió el docblock: «from = mínimo sobre variantes **offerable**».

**Pruebas** (`fixture-commercial-budget.test.ts`):

- El referencial no satisface el presupuesto, aunque sigue visible en la búsqueda.
- Un «desde» `not_offerable` (todas las variantes sin stock) nunca satisface.
- El «desde» prueba que *alguna* unidad cabe, no la variante fijada (KB-COMP-24 cuesta 74.990).
- Una unidad no vendible (KB-COMP-16) es `not_sellable`.
- Precio y stock pertenecen al mismo `itemKey`, y cambiar una unidad no altera otra.

**Contra el código anterior:** fallan los 2 tests que apuntan a la divergencia (referencial y «desde» `not_offerable` bajo presupuesto), así que la divergencia era real. Los otros 3 caracterizan conducta que ya era correcta y quedan como regresión. No se ajustó ninguna expectativa previa: ningún test existente dependía del comportamiento divergente.

## N. Resultados

| Ejecución | Resultado |
|---|---|
| Baseline R4 antes de cambios (unit + contract + integration + sales + shadow) | 129 archivos, 1.677 PASS, 13 skipped, 0 FAIL |
| `npx tsc -p tsconfig.json --noEmit` | PASS |
| `npx eslint . --max-warnings=0` | PASS |
| `npx tsc -b tsconfig.build.json` | PASS |
| Suites nuevas (8) | 159/159 PASS |
| Regresión completa después (con `R4_DISCOVER_OWNER_REPO`), corrida limpia | 138 archivos: **1.834 PASS, 2 FAIL, 13 skipped** (1.849) |
| Los 2 FAIL re-ejecutados aislados (`run-failure-recovery`, `worker-readiness`) | 35/35 PASS |
| Corrida anterior bajo carga (build y servidores concurrentes) | 19 timeouts de 30 s en suites live-ops/production; aislados, 108/109 y luego 27/27 del archivo restante |
| Re-export de fixtures | 32/32 idénticos |
| Catalog `git status` | limpio |

## O. Limitaciones

1. **Sin Catalog desplegado.** Todo usa el catálogo **sintético** del owner. Latencias, plazos (4,5 s) y saturación no están medidos con MariaDB (`REAL_MARIADB_VALIDATION=NOT_RUN` también en Catalog).
2. **Modelo scripted.** El caso multi-turn usa el stand-in de CI. Que un modelo real consolide bien la necesidad, registre el presupuesto antes de enviarlo y lea `reading` no está probado (`sales:live` no ejecutado). La guarda de coherencia lo obliga a registrarlo, pero no lo obliga a enviarlo (omitirlo queda reportado).
3. **Política de consumo en R4.** `discover-reading.ts` replica la política del consumidor de referencia B2. Si Catalog cambia el significado de un estado sin cambiar `schemaVersion`, R4 no lo detecta. El test de enums cubre solo valores cerrados.
4. **Instrucciones del agente sin cambios.** `sales.agent.json` / `sales.v4` no mencionan Discover para no alterar producción. La guía vive en la descripción de la capacidad.
5. **Guardas best-effort.** No detectan nombres ni direcciones libres; el owner tampoco. No enviarlos es obligación del modelo.
6. **Claims checker post-hoc.** No bloquea respuestas en runtime (diseño existente). La detección de oferta depende del extractor (rúbrica v2) o de redacción reconocible. Una `recommendation` con oferta se clasifica `DERIVED_RECOMMENDATION` por diseño de `classifyClaim`, aunque `supported=false`.
7. **Ausencia por `catalog.search` con filtros.** El checker previo no ve los filtros de Search (la vista no los repite). Es una brecha existente, no corregida aquí: para Discover sí se aplicó la regla de presupuesto.
8. **`maxUnitPriceClp` = presupuesto vigente exacto.** Un tope por unidad derivado (p. ej. repartir un presupuesto total) debe registrarse antes como hecho (`statedBy: agent`).
9. **Ambigüedad** que conserva el término ambiguo sigue sin resolverse en el léxico V0.2 (limitación del owner, B2 §I).
10. **Suites de integración sensibles a temporización.** Ninguna suite que falló toca Discover, el fixture ni el checker (`run-failure-recovery`, `worker-readiness`, `live-ops-*`, `production-*`); todas pasan aisladas. Aun así, en las corridas completas posteriores a I1 aparecieron fallos intermitentes (timeouts, carreras de recuperación y readiness), mientras que el baseline previo pasó completo en una sola corrida. No se pudo descartar del todo una interacción de carga, por ejemplo los 159 tests nuevos alargando la corrida.

## P. Dependencias de Catalog

- Transporte V1-B1: flag `CATALOG_DISCOVER_ENABLED`, `CATALOG_DISCOVER_API_KEYS` con la clave de R4 (o `R4_CATALOG_DISCOVER_API_KEY`), y la fuente desplegada junto al bundle activo. Sin la fuente, `NOT_READY`.
- Fixtures y `MANIFEST.json` de Discover publicados por el owner desde su servicio real (B2 §O.2). Hoy R4 los exporta con su script desde el código del owner.
- Medición con MariaDB para fijar `R4_CATALOG_DISCOVER_TIMEOUT_MS` y los límites de admisión.
- Replay V0.2 congelado y bundles reales (insumos ausentes en esta máquina).

## Q. Gates pendientes para producción

1. Catalog Discover habilitado en un entorno autorizado, y `REAL_CATALOG_E2E` ejecutado (auth, allowlist, saturación real).
2. MariaDB representativa: p50/p95/p99 y timeouts definitivos.
3. Evaluación con modelo real (`sales:live` / shadow) de selección de herramienta, consolidación multi-turn y lectura de `reading`, con claims checker v3.
4. Perfil de producción nuevo que liste `catalog.discover` con decisión explícita, y su ADR. Instrucciones del agente.
5. Gold independiente de relevancia (`INDEPENDENT_RELEVANCE_GOLD=NOT_AVAILABLE`).
6. Revisión de dominio de la unidad testigo y de la selección de lectura (B2 §O.6).

## R. Gates

```text
R4_DISCOVER_TOOL_IMPLEMENTED=YES
CATALOG_CONTRACT_VERSION_VERIFIED=YES
HTTP_CLIENT_IMPLEMENTED=YES
AUTH_INTEGRATION_TESTED=YES
COMMERCIAL_FIXTURE_CORRECTED=YES
CLAIMS_CHECKER_OFFERABILITY=PASS
MULTITURN_CONSTRAINTS=PASS
DISCOVER_STATE_INTERPRETATION=PASS
VARIANT_RESOLUTION=PASS
CONTRACT_TESTS=PASS
REAL_CATALOG_E2E=NOT_RUN
REAL_MARIADB_VALIDATION=NOT_RUN
INDEPENDENT_RELEVANCE_GOLD=NOT_AVAILABLE
FEATURE_ENABLED_IN_PRODUCTION=NO
PUSH_PERFORMED=NO
DEPLOY_PERFORMED=NO
```

`AUTH_INTEGRATION_TESTED=YES` se refiere a la frontera real del owner (401/403/503) entre procesos con catálogo sintético, no a un despliegue.

**Disposición: `R4_DISCOVER_I1_ACCEPTED_WITH_LIMITATIONS`.** Es aceptación de integración no productiva; las limitaciones están en §O y los gates pendientes en §Q.

## Reproducción

```sh
# R4 (Postgres local: npm run db:up)
npx tsc -p tsconfig.json --noEmit && npx eslint . --max-warnings=0
npx vitest run --project unit --project contract --project integration --project sales --project shadow
# Entre procesos (owner real, catálogo sintético)
R4_DISCOVER_OWNER_REPO=<MS-pesaschile-catalog-service> npx vitest run --project integration tests/integration/catalog-discover-owner-process.test.ts
# Regenerar fixtures (desde el checkout de Catalog)
cd <MS-pesaschile-catalog-service> && npx tsx <R4>/scripts/catalog-discover/export-fixtures.mts <R4>/adapters/domains/catalog/http/fixtures/discover
```
