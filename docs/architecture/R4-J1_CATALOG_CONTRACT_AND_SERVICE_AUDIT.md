# R4-J1 Catalog Contract & Service Audit

Estado: **auditoría — no autoriza implementación**. Fecha: 2026-09-29.

Alcance: `MS-pesaschile-catalog-service` como owner del read model de Catálogo, evaluado
contra lo que un Sales Agent productivo de R4 necesita. Payment queda fuera de alcance.
Shipping, Quote y Customer Profile se mencionan sólo cuando condicionan el contrato de Catálogo.

## 0. Convenciones de evidencia

| Prefijo | Significado |
|---|---|
| `CS/` | `E:\dev\codex\MS\MS-pesaschile-catalog-service` @ `7a214f4` (HEAD `main`, working tree limpio) |
| `R4/` | este repositorio @ `4b99271` |
| `CRM/` | `E:\dev\codex\CRM-Customer-360` (sólo para identificar consumidores) |
| `CP/` | `E:\dev\codex\MS\MS-pesaschile-customer-profile` (sólo consumidores) |
| `EXPORT` | `CS/docs/audits/product-intelligence-exploration/inputs/product_catalog_exploration(2).csv` — export real del catálogo PrestaShop, 2011 registros, commit `d379a7d` (2026-08-29); `dateUpdated` máx. 2026-08-26 |
| `SIM-SEARCH` | réplica offline (§9.2) que ejecuta el código real de ranking de `CS` sobre `EXPORT` |
| `SIM-PRICE` | réplica offline (§6.3) que ejecuta los dos motores de precio reales de `CS` con filas idénticas |

Toda afirmación sobre comportamiento se basa en código ejecutable. Donde la documentación de
`CS` diverge del código, se registra la divergencia. Lo no determinable se marca **UNKNOWN**
con la evidencia faltante.

No se pudo ejecutar el servicio contra la base real: no hay `.env` local de `CS` y el servicio
no corre en `127.0.0.1:4010`; abrir un túnel a producción no estaba autorizado. Por eso las
pruebas de búsqueda se hicieron con `SIM-SEARCH` (datos reales, código real, SQL replicado).

---

## 1. Executive Findings

1. **No existe una unidad vendible canónica.** "Producto" mezcla registro `ps_product`,
   combinación (`id_product_attribute`) y un pseudo-ítem `<base>` para productos con variantes
   cuyo precio omite el impacto de variante y cuyo stock es el agregado de producto. Un agente no
   puede referenciar "lo que se vende" de forma inequívoca entre turnos.
2. **Hay dos motores de precio que divergen.** `GET /v1/products/:id`, `batch` y `explore` usan
   `priceResolver`; `resolve-product-intent` y `search-products v2` usan `CommercialPriceCalculator`.
   Con filas idénticas producen 107.100 vs 109.000 CLP y 107.100 vs 95.200 CLP (`SIM-PRICE`).
   La documentación afirma lo contrario.
3. **La frescura publicada no es verdadera.** `priceCalculatedAt`/`stockCheckedAt` se fijan a
   `now()` aunque precio y stock vengan de caché, y la respuesta completa de producto (con stock y
   precio embebidos) se cachea 900 s, anulando los TTL de 15 s (stock) y 60 s (precio).
4. **"Disponible" significa `physical_quantity > 0`.** Ignora stock reservado, y la ruta v1
   (search/GET/batch) ignora `available_for_order` y `visibility`. En el catálogo real hay 10
   productos activos no pedibles y 6 activos ocultos (servicios internos incluidos).
5. **La búsqueda trunca por ID antes de rankear.** El SQL ordena por `id_product ASC` y corta en
   `max(limit·10, 50)` filas *antes* de aplicar relevancia. En `SIM-SEARCH`, `barra` tiene 359
   candidatos pero se rankean sólo los 50 IDs más bajos; `bancos` devuelve balones medicinales
   aunque existen 63 bancos.
6. **"Sin resultados" se confunde con "sin stock".** Por defecto se excluye stock ≤ 0: la
   búsqueda exacta por SKU `BORE20` devuelve vacío porque el producto tiene stock 0.
7. **No hay relaciones de compatibilidad, accesorios, sustitutos ni bundles.** La única relación
   real es co-ocurrencia `same_order` a nivel producto, etiquetada honestamente como
   "comprado frecuentemente junto". El vocabulario `TECHNICALLY_COMPATIBLE`,
   `OUT_OF_STOCK_SUBSTITUTE`, `alternative`, `complement`, `backorder` está declarado pero nunca se emite.
8. **El puerto R4 actual promete datos que el owner no tiene.** `brand` obligatorio,
   `recordVersion`, `updatedAt`, `footprintCm`, `compatibleWith`, `alternatives`, `low_stock`,
   `discontinued`: ninguno existe en `CS` (dimensiones: 0/889 productos activos las tienen).
9. **Especificaciones existen en PrestaShop pero no se exponen.** 880/889 productos activos
   tienen features (peso máximo de usuario, dimensiones armado…), sólo usadas como texto
   concatenado para matching en `explore`.
10. **Inactivo, eliminado e inexistente son indistinguibles** (`404 PRODUCT_NOT_FOUND`), lo que
    impide al agente decir "ese producto fue descontinuado" frente a "ese ID no existe".
11. **Para una respuesta comercial coherente hacen falta 3–4 lecturas con relojes y cachés
    distintos** (producto, semántica, relaciones, features). No existe un `ProductContext`.
12. **R4 perdería la edad del dato.** El invoker estampa `observedAt = now()` y `validUntil =
    now + 15 min` al invocar (`R4/packages/capability-runtime/src/invoker.ts:92-110`); un precio
    cacheado 15 min en `CS` sería tratado como fresco otros 15 min.
13. **Lo reutilizable es sólido:** IDs PrestaShop estables (no generados por snapshot), superficie
    100 % read-only, SQL parametrizado, auth timing-safe, snapshots semánticos con lineage y
    checksum, modelo de disponibilidad de commercial-truth (`status`/`purchasable`/`stockKnown`).
14. **Decisión:** `CS` debe seguir siendo owner del read model de Catálogo, pero **ninguna API
    actual debe consumirse directamente por R4**. Se requieren dos endpoints nuevos construidos
    sobre un único motor comercial corregido, y un adapter R4 delgado.

---

## 2. Current Architecture

```text
PrestaShop MariaDB (source of truth, lectura directa, SHOP_ID=1 forzado, LANG_ID configurable)
  │  ps_product, ps_product_shop, ps_product_lang, ps_product_attribute(_shop|_combination),
  │  ps_attribute(_lang), ps_attribute_group(_lang), ps_stock_available, ps_specific_price,
  │  ps_category(_lang), ps_category_product, ps_feature_product, ps_feature_lang,
  │  ps_feature_value_lang, ps_orders/ps_order_detail (sólo build de relaciones)
  │
  ├─► [ruta v1 live]  MySqlCatalogRepository ─► MySqlSearchProvider / SqlPricingProvider(priceResolver)
  │                    / PrestaShopPhysicalStockProvider ─► CatalogApplicationService
  │                    └─ caché memory|redis: search 300s · product 900s · price 60s · stock 15s
  │
  ├─► [ruta commercial-truth live] MySqlCatalogCommercialDataReader ─► CatalogCommercialTruthService
  │                    (CommercialAvailabilityResolver + SpecificPriceSelector + CommercialPriceCalculator)
  │                    └─ sin caché
  │
  ├─► [ruta explore live] MySqlCatalogExploreDataReader (full scan) ─► DefaultExploreProductsService
  │                    (priceResolver v1 + CommercialAvailabilityResolver) └─ sin caché
  │
  └─► [builds offline, CLI + restart]
        relationship:snapshot:build  ─► data/relationship-snapshots (same_order)  ─► reader en memoria
        product:semantic:snapshot    ─► data/product-semantic-snapshots           ─► reader en memoria
        training-semantics v2        ─► data/training-semantic-snapshots/v2        ─► reader en memoria

Endpoints (Fastify, x-api-key)                         Consumidores
  GET  /v1/products/search                ──────────► CRM httpCatalogAdapter, CRM benchmark
  GET  /v1/products/:productId            ──────────► CRM httpCatalogAdapter, CRM benchmark
  POST /v1/products/batch                 ──────────► CRM httpCatalogAdapter, CRM grounded message
  POST /v1/products/explore               ──────────► CRM httpCatalogAdapter
  POST /api/v2/catalog/resolve-product-intent ──────► CRM httpCatalogAdapter, CRM benchmark
  POST /api/v2/recommendations/search-products ─────► CRM search-products-v2 client
  GET  /v1/products/:id/semantics, POST …/semantics/batch, GET …/semantics/registry ─► CRM, Customer Profile
  GET/POST …/training-semantics/{:id,batch,registry,query} ─► CRM capability gateway
  POST /v1/products/semantic-discovery/query ───────► CRM capability gateway
R4: ningún consumo live; sólo puerto + fixture en memoria (R4/adapters/domains/src/catalog/port.ts:8-9).
```

Evidencia: composición `CS/src/bootstrap.ts:77-203`, `CS/src/server.ts:7-25`,
`CS/src/recommendationRuntime.ts:61-127`; rutas `CS/src/interfaces/http/app.ts:164-359`;
TTL `CS/src/shared/config.ts:45-48`; refresh de snapshots sólo al arranque
`CS/src/bootstrap.ts:158,176`, `CS/src/recommendationRuntime.ts:75`,
`CS/docs/operations/catalog-service-ec2-deployment.md:54-75`.

Origen de cada dato:

| Dato | Origen | Tipo |
|---|---|---|
| nombre, descripciones, reference, link_rewrite, peso, active, available_for_order, category default | PrestaShop | authoritative (copiado) |
| atributos de variante, impacto de precio/peso | PrestaShop | authoritative |
| stock (`physical_quantity`) | PrestaShop | authoritative, **columna equivocada** (§7) |
| precio final, descuento, IVA | calculado por `CS` | derivado (reimplementación de reglas PS) |
| `available`, `status`, `purchasable` | calculado por `CS` | derivado |
| URL pública | construida por `CS` (`/categories/{id}-{slug}.html`) | derivado |
| familias/disciplinas/usos, capacidades de entrenamiento | clasificador de `CS` | inferido (snapshot) |
| relaciones `same_order` | estadística de `CS` sobre pedidos | derivado/estadístico (snapshot) |
| exclusión de no-productos | lista hardcodeada (2 IDs) + clasificador (13 IDs) | política de `CS` |

Información que existe en PrestaShop y **se pierde o no se expone**: `visibility`,
`out_of_stock`, `stock_available.quantity`/`reserved_quantity`, `available_date`, marca
(`id_manufacturer`, 836/889 activos la tienen), features estructuradas (880/889), imágenes,
`date_upd`, `id_tax_rules_group`, `minimal_quantity`, packs, `ps_accessory`, prioridad de specific
price (verificado por `grep` sobre `CS/src`: ninguna de esas columnas se lee; features sólo en
`CS/src/infrastructure/catalog/mysqlCatalogExploreDataReader.ts:256-273` como texto concatenado).

Información interna no expuesta por API: `impactPrice` sí, pero `weightImpactKg` se elimina
(`CS/src/application/catalogService.ts:205-210`); `category` sólo en commercial-truth; features
sólo para matching de explore; `linkRewrite` sólo como URL.

---

## 3. Domain Model

"Producto" en `CS` no es una entidad única. Entidades reales encontradas:

| Entidad | ID canónico | IDs externos | Owner | Cardinalidad / relaciones | Authoritative | Derivado | Lifecycle | Freshness |
|---|---|---|---|---|---|---|---|---|
| **CatalogProductRecord** (`ps_product`) | `id_product` numérico (string en APIs v2, number en v1) | `reference` (SKU), `link_rewrite` | PrestaShop; `CS` es read model | 1 → 0..n variantes; 1 → 1 categoría default, n categorías | name, descripciones, reference, weight, active, available_for_order | publicLink | active/inactive; borrado físico ⇒ desaparece; re-creación con ID nuevo es práctica real (11 nombres duplicados activo/inactivo en `EXPORT`) | live por request (+caché v1) |
| **Variant** (`ps_product_attribute`) | `id_product_attribute` (`combinationId`; `0` = sin variante en v1, ausente = `<base>` en v2) | `reference` de combinación | PrestaShop | n → 1 producto; 66 productos activos con variantes, 225 combinaciones, máx. 6 | attributes (grupo: valor), impacto precio/peso, default_on | label concatenado | IDs pueden recrearse al regenerar combinaciones en PS (**UNKNOWN** frecuencia) | live |
| **`<base>` pseudo-ítem** | `productId::<base>` (`CS/src/domain/catalog/commercial-truth/productIdentity.ts:14`) | — | `CS` | producto con variantes pedido sin variante | — | precio sin impacto de variante (`CS/src/infrastructure/catalog/mysqlCatalogCommercialDataReader.ts:169-171`), stock de fila `id_product_attribute=0` | — | — |
| **Category** | `id_category` | `link_rewrite` (slug) | PrestaShop | producto n↔n (mediana 6 por producto) | nombre (default) | — | — | live |
| **Price** | no identificable; `specificPriceId` referencia la regla | `id_specific_price` | `CS` (cálculo) sobre datos PS | por (ítem, cantidad, cliente, grupo, moneda, país) | base neto PS | final bruto, descuento, IVA plano | por request | `evaluatedAt`/`priceCalculatedAt` (ver §10) |
| **Availability** | — | — | `CS` (cálculo) | por ítem | active, available_for_order, physical_quantity | status/purchasable/available | por request | `evaluatedAt`/`stockCheckedAt` |
| **PublicLink** | URL | `link_rewrite` | `CS` | por producto (scope `parent_product` si hay variantes) | — | URL | — | — |
| **ProductRelationship** (`same_order`) | (source, target, type) | — | `CS` (estadística) | producto→producto, dirigido, ≤50 por source | — | support/confidence/lift/reliability | snapshot inmutable por `snapshotId`; reemplazo por build+restart | edad = build; no expuesta en APIs de producto |
| **ProductSemanticFacts** | productId en snapshot `sha256:…` | — | `CS` (clasificador) | 1 por producto (2011 incl. históricos) | — | familias, disciplinas, usos con confianza y regla | snapshot | `builtAt` en archivo; snapshot local 2026-08-29 |
| **TrainingSemanticFacts** | productId en snapshot v2 | — | `CS` | 1 por producto | — | capacidades, funciones, anatomía derivada | snapshot | lineage expuesto |
| **NonProduct policy** | productId | — | `CS` | 2 IDs hardcodeados (444, 505) vs 13 `EXCLUDED_NON_PRODUCT` | — | — | código/snapshot | — |

Entidades **ausentes** (no inventadas): Brand (dato existe en PS, no se lee), CommercialProduct vs
FinalProduct (no existe ninguna distinción en código; la única noción cercana es la exclusión de
no-productos y el slug de categoría `maquinas-comerciales` en
`CS/src/application/catalog/explore-products/defaultExploreProductsService.ts:44` — el significado
esperado de "Commercial/Final" es **UNKNOWN**: falta definición de negocio), Accessory, Bundle/Pack,
CompatibilityRelationship (sólo en schema: `CS/src/domain/recommendation/contracts.ts:90-97`),
Alternative/Substitute (sólo vocabulario), Specification (existe en PS, no en API), Media
(`imageUrl` declarado en `CS/src/domain/catalog/commercial-truth/contracts.ts:90`, nunca asignado en
`CS/src/domain/catalog/commercial-truth/catalogCommercialTruthService.ts:167-180`).

**Gap semántico central:** según el endpoint, "producto" es (a) una fila por combinación
(v1 search, `CS/src/infrastructure/repositories/mysqlCatalogRepository.ts:342-397`), (b) un
producto con variante default seleccionada implícitamente (v1 GET,
`CS/src/application/catalogService.ts:170-203`), (c) un producto con stock agregado y precio de la
variante default (explore, `CS/src/infrastructure/catalog/mysqlCatalogExploreDataReader.ts:274-298`,
`CS/src/application/catalog/explore-products/defaultExploreProductsService.ts:150-168`), o (d) un
pseudo-ítem `<base>` (commercial-truth). Clasificación: **FIX** (CAT-ID-02).

Servicios internos vendibles (armado A-10…A-40, A-PC: IDs 554–558) están activos con
`visibility=none` (`EXPORT`); v1 los expondría con `includeOutOfStock=true` porque no lee
`visibility`.

---

## 4. Existing API Surface

| Endpoint | Request | Response | Semántica real | Consumidor | Evaluación |
|---|---|---|---|---|---|
| `GET /v1/products/search` (`CS/src/interfaces/http/app.ts:213-245`) | `q` 2–120, `limit` 1–10 (def. 5), `includeOutOfStock` (def. false) | `items[]` por combinación: ids, sku, name, variantLabel, shortDescription, physicalQuantity, available, matchType; `freshness{cached,generatedAt}` | LIKE léxico, truncado por ID antes de rankear, oculta sin stock, sin precio/categoría | CRM adapter/benchmark | **FIX/REMOVE para R4** (CAT-SR-01..04) |
| `GET /v1/products/:productId` (`app.ts:247-300`) | `combinationId`, `quantity`; contexto de precio por headers `x-customer-id`, `x-customer-group-id`, `x-currency-id`, `x-country-id` (`CS/src/shared/requestContext.ts:11-24`) | product core (incl. longDescription), publicLink, selectedVariant, variants[], pricing (motor v1), stock, weightKg, freshness | variante default implícita; 404 para inactivo; respuesta completa cacheada 900 s | CRM | **FIX** (freshness, pricing, lifecycle); base útil para ProductContext |
| `POST /v1/products/batch` (`app.ts:302-347`) | ≤20 ítems | 200 siempre; `items[].ok` con error embebido | `Promise.allSettled` de GET; código fallback `CATALOG_QUERY_FAILED` | CRM grounded message | **FIX** (CAT-FL-02) |
| `POST /v1/products/explore` (`CS/src/interfaces/http/routes/exploreProductsRoute.ts:134`) | query, categoryId/Slug, productType, price min/max, availability, sort (price/stock/name), limit ≤10 | products (id, name, price, stock, stockScope, availability), totalMatched, exhaustiveForScope | full scan del catálogo por request; `productType` con reglas hardcodeadas | CRM | **FIX** (performance) / no usar en R4 |
| `POST /api/v2/catalog/resolve-product-intent` (`CS/src/interfaces/http/routes/resolveProductIntentRoute.ts:123`) | query ≤240, context (preferredAttributes `additionalProperties:true`), filters, limit ≤20 | resolution{status resolved/clarification_required/no_match, confidence}, candidates con score/reasons, clarification | decide por el agente usando v1 search + commercial-truth; heurística `barra` hardcodeada | CRM adapter/benchmark | **REMOVE como dependencia R4** (CAT-SR-09) |
| `POST /api/v2/recommendations/search-products` (`CS/src/interfaces/http/routes/searchProductsV2Route.ts:98`) | sourceProduct requerido, query, customer/context (`additionalProperties:true`), filters | recommendations por `same_order` + afinidad de cliente (llama Customer Profile) | recomendación, no búsqueda | CRM client | **REMOVE como dependencia R4 J1** (CAT-SE-02) |
| `GET /v1/products/:id/semantics` (`CS/src/interfaces/http/routes/getProductSemanticsRoute.ts:106`) | — | tags con axis/code/confidence/ruleId, evidencia, lineage | snapshot inferido | CRM | **KEEP** (derivado, fuera de J1) |
| `POST /v1/products/semantics/batch` (`…/getProductSemanticsBatchRoute.ts:150`) | ≤500 ids, `expectedSnapshotId` | facts públicos + `missingProductIds` + lineage | snapshot pinneable | Customer Profile (`CP/src/infrastructure/catalog-product-semantics/http-product-semantic-facts-source.ts:110`) | **KEEP** |
| `GET /v1/products/semantics/registry` (`…/getProductSemanticsRegistryRoute.ts:67`) | — | vocabulario ontológico | estático | CRM | KEEP |
| `GET/POST /v1/products/training-semantics/{:id,batch,registry}` (`…/getTrainingSemantic*Route.ts`) | — | facts v2 + lineage | snapshot | CRM | KEEP (fuera de J1) |
| `POST /v1/products/training-semantics/query` (`…/queryTrainingSemanticsRoute.ts:87`) | requirements | resultados + `truncated` | snapshot | CRM | KEEP (fuera de J1) |
| `POST /v1/products/semantic-discovery/query` (`…/semanticDiscoveryQueryRoute.ts:44`) | requirements ≤10, limit ≤100, `expectedSnapshots` | productIds + matchedRequirements + lineage, `totalMatches`, `truncated` | ranking determinista (`CS/src/application/catalog/semantic-discovery/defaultSemanticDiscoveryService.ts:406`) pero sin nombre/precio/stock | CRM capability gateway | KEEP como fuente derivada; EXTEND para uso agente (CAT-SM, post-J1) |
| `GET /health/live`, `/health/ready` (`app.ts:164-190`) | — | checks database/redis/relationshipSnapshot | ready=503 si falta el snapshot de relaciones | ops | FIX (CAT-RL-05) |
| `GET /metrics` (`app.ts:206-211`) | — | Prometheus | requiere key por defecto | ops | KEEP |
| `/docs`, `/openapi.json` (`app.ts:93-122`) | — | Swagger | deshabilitado si `NODE_ENV=production` | dev | KEEP |

Consumidores verificados por `grep`: `CRM/lib/catalog/httpCatalogAdapter.ts:89,213,225,240,1191-1249`,
`CRM/lib/catalog/search-products-v2/httpCatalogSearchProductsV2Client.ts:61`,
`CRM/lib/brain/commercial/capability-gateway/registry.ts:516`,
`CRM/lib/brain/commercial/native-cycle/buildCatalogGroundedMessage.ts:8`,
`CRM/lib/brain/commercial/agent-loop/benchmark/environment.ts:101-192`, `CP/…:110`, cliente
propio `CS/client/catalogClient.ts:187-307`. Quote-service no consume Catálogo (recibe `unitPrice`
del llamador: `…/MS-pesaschile-quote-service/src/domain/quote-line.ts:27-37`). No hay mutaciones:
todas las rutas son GET o POST de consulta.

---

## 5. Identity Audit

| ID | Estabilidad temporal | Unicidad | Ante rebuild de snapshot | Ante desactivación/borrado | ¿Canónico? |
|---|---|---|---|---|---|
| `id_product` | estable (autoincrement PS, no generado por `CS`) | única | no cambia (snapshots usan el ID PS) | inactivo ⇒ `404` en v1 (`CS/src/infrastructure/repositories/mysqlCatalogRepository.ts:115`); `status:'inactive'` en commercial-truth; borrado ⇒ ausente | **Sí, como identidad de registro** (no de "línea comercial": re-creación con ID nuevo ocurre) |
| `id_product_attribute` | estable salvo regeneración de combinaciones en PS (**UNKNOWN**; falta historial de `ps_product_attribute`) | única global | no cambia | ausente ⇒ `404 COMBINATION_NOT_FOUND` (`CS/src/application/catalogService.ts:177-179`) | Sí, calificado por `id_product` |
| `combinationId = 0` / `<base>` | — | ambiguo: significa "sin variantes" **o** "producto con variantes sin elegir" | — | — | **No** |
| `reference` (SKU) | editable por staff | presente en 889/889 activos, sin duplicados entre productos, **4 colisiones combinación↔producto** (`EXPORT`) | — | — | **No** (lookup secundario) |
| `snapshotId` (`sha256:…`) | cambia en cada build (content hash) | — | — | — | versión, no identidad de producto |
| identidad de relación (source,target,type) | por snapshot | única por snapshot (`CS/src/domain/recommendation/relationship-engine/contracts.ts:372`) | puede desaparecer | — | No (derivado) |
| identidad en caché (`product:1:{id}:{comb}:{qty}:{cust}:{grp}:{cur}:{cty}`) | TTL | — | — | — | No |

- Resolución external→canonical: sólo `reference` exacta dentro de search (`mysqlCatalogRepository.ts:290-291`), sujeta a filtro de stock y truncado; no hay endpoint de lookup por SKU.
- Formatos inconsistentes: number en v1 (`CS/src/shared/contracts.ts:22-23`), string en v2
  (`CS/src/domain/catalog/commercial-truth/contracts.ts:3-6`), string `"productId::combinationId|<base>"` interno.
- R4 hoy asume SKU como `productId` (`R4/adapters/domains/src/catalog/fixture-data.ts`: `'RACK-PR200'`, `'BAR-OLY20'`) y
  valida `productId` con `^[A-Z0-9][A-Z0-9-]{1,47}$` (`R4/agents/sales/src/capabilities/common.ts:7`).

**Requerido:** una referencia de ítem vendible `{productId, variantId|null}` con clave opaca
estable (`P{productId}` o `P{productId}-V{variantId}`, compatible con el regex R4), donde
`variantId=null` sólo significa "producto sin variantes"; y un estado de lifecycle
(`active`, `inactive`, `not_found`) en vez de 404 indiferenciado.

---

## 6. Pricing Audit

### 6.1 Representación actual

| Aspecto | Motor v1 `priceResolver` (GET, batch, explore) | Motor commercial-truth (intent, search v2) |
|---|---|---|
| Base neta | `COALESCE(ps.price, p.price) + impacto combinación` (`CS/src/infrastructure/repositories/mysqlCatalogRepository.ts:431-465`) | igual (`CS/src/infrastructure/catalog/mysqlCatalogCommercialDataReader.ts:219,287`) |
| IVA | tasa plana `TAX_RATE` (def. 0.19, `CS/src/shared/config.ts:54`); `taxMode:'configured_rate'` (`CS/src/infrastructure/pricing/priceResolver.ts:136`) | tasa plana del contexto |
| Reglas de impuesto PS (`id_tax_rules_group`) | no leídas | no leídas |
| Specific price: ventana | SQL `NOW()` del reloj DB (`mysqlCatalogRepository.ts:506-507`) + filtro en app | reloj de app (`CS/src/domain/catalog/commercial-truth/specificPriceSelector.ts:70-80`) |
| Specific price: desempate | `…, from_quantity, priority(siempre 0), -id` ⇒ **gana el ID menor** (`priceResolver.ts:20-32`) | `…, fromQuantity, contextSpecificity, fromTime, id` ⇒ **gana el ID mayor** + warning `SPECIFIC_PRICE_SELECTION_AMBIGUOUS` (`specificPriceSelector.ts:44-50,100-116`) |
| Reducción `amount` con `reduction_tax=0` (monto neto) | resta en neto (correcto según semántica PS) (`priceResolver.ts:111-119`) | resta el monto como si fuera bruto (`CS/src/domain/catalog/commercial-truth/priceCalculator.ts:60-77`) |
| Prioridad `ps_specific_price_priority` | ignorada (`priority` nunca se selecciona en SQL) | ignorada |
| Moneda | `PRESTASHOP_CURRENCY_CODE` (def. CLP); sin conversión | igual |
| Quantity pricing | `from_quantity ≤ quantity` por request; tramos no expuestos | igual |
| Vigencia expuesta | no | no (`evaluatedAt` sí) |
| Regular vs final | `baseUnitPrice`/`effectiveUnitPrice` | `baseGrossAmount`/`finalGrossAmount` |
| Freshness | `priceCalculatedAt` = `now()` aunque venga de caché (`CS/src/application/catalogService.ts:270-289`) | `evaluatedAt` real (sin caché) |

Divergencia doc↔código: `CS/docs/catalog-commercial-truth.md:19` afirma que commercial truth
"evita reglas divergentes de precio"; `explore` y v1 GET siguen usando `priceResolver`
(`CS/src/application/catalog/explore-products/defaultExploreProductsService.ts:2,210-225`).

### 6.2 ¿Autoritativo para una venta?

No. Ambos motores son reimplementaciones parciales de las reglas de PrestaShop, sin reglas de
impuesto, sin prioridad de specific price, sin cart rules, y con la única validación de paridad
dependiendo de un archivo de casos manual inexistente en el repo
(`CS/scripts/validate-price-parity.ts:1-40`; **UNKNOWN** si alguna vez se ejecutó). Se desconoce
si producción contiene specific prices con `reduction_tax=0` o empates de especificidad
(**UNKNOWN**: requiere `SELECT reduction_type, reduction_tax, COUNT(*) FROM ps_specific_price …`).

### 6.3 Evidencia `SIM-PRICE` (base neta 100.000 CLP, IVA 0.19, mismas filas a ambos motores)

| Escenario | v1 (GET/explore) | commercial-truth (intent/search v2) |
|---|---|---|
| amount 10.000, `reduction_tax=1` | 109.000 | 109.000 |
| amount 10.000, `reduction_tax=0` | **107.100** | **109.000** |
| dos reglas igual de específicas (10 % id 5, 20 % id 9) | **107.100** (id 5) | **95.200** (id 9) + warning |

### 6.4 Respuestas

- **A. Precio que debe mostrar el agente:** precio final bruto (IVA incluido, CLP) de la unidad
  vendible concreta (variante resuelta), cantidad 1, contexto público (sin cliente), junto con el
  precio regular si hay promoción y la vigencia de la promoción si existe. Si el producto tiene
  variantes y no hay selección: "desde $X" (mínimo entre variantes vendibles), nunca el precio `<base>`.
  Siempre como precio referencial con `asOf`.
- **B. Precio que debe usar Quote (J3):** nunca el observado en la conversación. Quote debe
  re-leer el precio a Catálogo en el momento de cotizar, para el ítem vendible y la cantidad real,
  y persistir `priceEvaluatedAt` + `specificPriceId` + versión del motor como evidencia. La autoridad
  transaccional última (cart rules, redondeo PS) queda fuera de J1 — **decisión de J3**.
- **C. Catalog: source of truth o read model:** read model. PrestaShop es la fuente de verdad;
  `CS` es owner del *contrato de lectura* y del *cálculo* de precio de lista, que es derivado y debe
  declararse como tal (`authority: derived`, `basis`).
- **D. Detección de precio stale en R4:** hoy imposible (timestamps fabricados + caché compuesta
  900 s). Requerido: `asOf` real por bloque (momento de lectura DB), `cache.ageMs`, y `validUntil`
  = min(`asOf`+TTL de precio, fin de vigencia de la specific price). El adapter R4 transporta esos
  campos en el payload; el TTL de la capability no debe superar la vigencia del owner.

---

## 7. Availability Audit

### 7.1 Qué significa hoy "disponible"

| Concepto PS | v1 (search/GET/batch) | commercial-truth | explore |
|---|---|---|---|
| `active` | filtro SQL `p.active=1` (`mysqlCatalogRepository.ts:115,177,380`) ⇒ inactivo = 404/ausente | `status:'inactive'` (`CS/src/domain/catalog/commercial-truth/availabilityResolver.ts:5-15`) | leído, no filtrado en SQL (`mysqlCatalogExploreDataReader.ts:299-301`) |
| `available_for_order` | **ignorado** | `unavailable_for_order` (`availabilityResolver.ts:29-39`) | igual que commercial-truth |
| `visibility` | **ignorado** | **ignorado** | **ignorado** |
| stock | `physical_quantity` (`mysqlCatalogRepository.ts:153,355,550`) | `physical_quantity` (`mysqlCatalogCommercialDataReader.ts:311`) | suma de `physical_quantity` de variantes (`mysqlCatalogExploreDataReader.ts:286-298`) |
| reservado (`reserved_quantity`) / disponible (`quantity`) | **no leído** | **no leído** | **no leído** |
| `out_of_stock` (backorder) | **no leído** | **no leído** | **no leído** |
| `available_date`, textos "disponible después" | **no leídos** | **no leídos** | **no leídos** |
| fila de stock ausente | `503 STOCK_UNAVAILABLE` para todo el producto (`CS/src/infrastructure/stock/prestashopPhysicalStockProvider.ts:10`); variantes sin fila desaparecen por `INNER JOIN` (`mysqlCatalogRepository.ts:162-165`) | `status:'unknown'`, `stockKnown:false` | `null` |
| multi-bodega | **UNKNOWN** (no se leen tablas de warehouse; `SHOP_ID=1` forzado, `CS/src/shared/config.ts:90-92`) | igual | igual |
| lead time | no existe | no existe | no existe |

Distribución real (`EXPORT`, 889 activos): `available_for_order=0`: 10; `visibility=none`: 6
(incl. servicios 554–558); stock ≤ 0: 236; stock > 0: 653.

### 7.2 Contrato R4 requerido

Catálogo entrega *hechos* y una *derivación* explícita; la política comercial (qué ofrecer) queda en R4:

```text
sellability = sellable          active ∧ listed ∧ orderable ∧ availableQty > 0
            | backorder         active ∧ listed ∧ orderable ∧ availableQty ≤ 0 ∧ out_of_stock permite pedido
            | not_sellable      reason ∈ {inactive, not_listed, not_orderable, out_of_stock}
            | check_with_staff  reason ∈ {stock_unknown, variant_required, backorder_policy_unknown}
```

- "Se puede vender" = `sellable`. "No se puede vender" = `not_sellable` + razón. "Consultar" =
  `check_with_staff`. "Disponible con espera" = `backorder` **sólo** si `out_of_stock` se lee; el
  plazo queda `leadTime: null` (no se inventa).
- Mientras `out_of_stock` no se lea, stock ≤ 0 debe mapear a `check_with_staff`
  (`backorder_policy_unknown`), no a `not_sellable`, para no rechazar ventas válidas.
- `availableQuantity` debe provenir de `stock_available.quantity` (neto de reservas).
- El modelo de commercial-truth (`status`, `purchasable`, `stockKnown`, `evaluatedAt`,
  `CS/src/domain/catalog/commercial-truth/contracts.ts:43-58`) es la base correcta (**KEEP**) a
  extender con `listed` y política de backorder.

---

## 8. Relationship Audit

| Relación | Existe | Dirección | Significado comercial | Origen | Confianza | Cardinalidad | Tipo | ¿Recomendación? | ¿Compatibilidad real? | ¿Evidencia comercial? |
|---|---|---|---|---|---|---|---|---|---|---|
| `same_order` | **Sí** (única producida: `CS/src/application/recommendation/relationship-snapshot-build/defaultRelationshipSnapshotBuildService.ts:73`) | dirigida A→B (`confidence = joint/count(A)`, `CS/src/domain/recommendation/relationship-engine/calculators/sameOrderCalculator.ts:279-292`) | "comprado frecuentemente junto" (`CS/src/application/recommendation/search-products-v2/defaultSearchProductsV2Service.ts:361-366`) | `ps_order_detail.product_id` agregado por pedido, a nivel producto (variante descartada: `CS/src/infrastructure/recommendation/prestashopOrderTransactionReader.ts:195-199`) | support/confidence/lift + reliability ≥ 0.3, jointCount ≥ 2 (`CS/src/cli/buildRelationshipSnapshot.ts:57-62`) | ≤50 por source | **statistical/derived** | sí, como "otros también compraron" | **no** | sólo como evidencia de comportamiento, nunca de compatibilidad |
| `same_cart`, `next_purchase`, `customer_history` | schema sí, producción no | — | — | — | — | — | — | — | — | — |
| `technical_compatibility`, `manual` | schema/validator (`CS/src/domain/recommendation/relationship-engine/validation/defaultRelationshipValidator.ts:81-98`); ningún productor | — | — | — | — | — | curated (previsto) | — | — | — |
| Accesorios PS (`ps_accessory`) | **no leído** (si PS tiene datos: **UNKNOWN**) | — | — | — | — | — | — | — | — | — |
| Packs/bundles (`ps_pack`) | **no leído** (**UNKNOWN**) | — | — | — | — | — | — | — | — | — |
| Sustitutos | no existe (vocabulario `OUT_OF_STOCK_SUBSTITUTE` nunca emitido) | — | — | — | — | — | — | — | — | — |
| Afinidad semántica (misma familia/uso) | implícita en snapshots semánticos | — | similitud inferida | clasificador | `EXPLICIT`/`STRONGLY_INFERRED` | — | inferred | posible | no | no |

Vocabulario declarado nunca emitido (verificado por `grep` fuera de `contracts.ts`):
`TECHNICALLY_COMPATIBLE`, `OUT_OF_STOCK_SUBSTITUTE`, `LOWER_PRICE_ALTERNATIVE`,
`COMPATIBILITY_UNVERIFIED`, `BACKORDER_ONLY`, candidateType `alternative`/`complement`,
availability `backorder` (`CS/src/domain/recommendation/contracts.ts:86-131`). **REMOVE** del
contrato futuro: publicarlo invita a consumidores a asumir semántica inexistente.

Distinciones exigidas: hoy **no hay mezcla** en el código productivo (sólo existe `same_order` y
se etiqueta como tal); la mezcla está en el **puerto R4** (`compatibleWith`, `alternatives`:
`R4/adapters/domains/src/catalog/port.ts:32-35`), que promete relaciones curadas que el owner no
tiene. Riesgo adicional: la exclusión de no-productos en relaciones depende de la env
`RELATIONSHIP_SOURCE_EXCLUDED_PRODUCT_IDS` (`CS/src/shared/config.ts:60`); la política de
descubrimiento (444, 505) no se aplica a relaciones (`grep isDiscoveryExcludedProductId`), por lo que
"Costo logístico" podría aparecer como "comprado junto" (**UNKNOWN** la config de producción).

---

## 9. Search Audit

### 9.1 Semántica implementada (`GET /v1/products/search`)

- Variantes de query: original + normalizada (sin diacríticos, minúsculas, unidades canónicas
  `20 kg→20kg`) (`CS/src/domain/catalog/searchTextNormalization.ts:26-41`).
- Ruta de frase: `p.reference = q OR pa.reference = q OR pl.name = q OR name LIKE %q% OR
  description_short LIKE %q% OR description LIKE %q%` (`mysqlCatalogRepository.ts:288-307`).
- Fallback por tokens (AND de `name LIKE %token%`, sin stopwords) sólo si ≥2 tokens y la frase no
  cubre todos los tokens (`mysqlCatalogRepository.ts:59-80,309-323`).
- **Orden SQL `p.id_product ASC` + `LIMIT max(limit·10,50)`** (`mysqlCatalogRepository.ts:397-408`)
  **antes** del ranking en memoria (`CS/src/infrastructure/search/mysqlSearchProvider.ts:30-63`).
- Ranking: matchType (exact_sku > exact_name > partial_name > description), frase exacta, cobertura
  de tokens en nombre, orden de tokens, cobertura en descripción, default, `localeCompare(name)`, id
  (`CS/src/domain/catalog/searchTextRelevance.ts:142-157`). Determinista.
- Match de token: igualdad o prefijo si el token de query tiene >3 caracteres y no es unidad
  (`searchTextRelevance.ts:33-41`). Sin typo-tolerance, sin stemming, sin sinónimos (salvo en intent).
- Filtros: sólo stock (`includeOutOfStock`). Sin categoría, marca, precio. Sin paginación, sin
  `totalMatches`, sin `truncated`. Resultado: una fila por combinación.
- Caché 300 s por query normalizada (`CS/src/shared/cacheKeys.ts:1-7`).
- Explicabilidad: `matchType` sólo.

### 9.2 Pruebas (`SIM-SEARCH`)

Método: se cargan las 2011 filas de `EXPORT` (expandiendo combinaciones), se replica el predicado
SQL y el `ORDER BY/LIMIT` de `mysqlCatalogRepository.ts:280-412` (collation `*_ci`
insensible a acentos/mayúsculas — **supuesto**, collation de producción **UNKNOWN**) y se invoca el
`MySqlSearchProvider` real con un repositorio que devuelve esas filas; se compara contra el mismo
ranking sin `LIMIT`. Limitación: `EXPORT` no trae stock por combinación (se usa el total del producto).

| Caso | Query | Candidatos tras LIMIT / sin LIMIT | Top-5 servicio == ideal | Observación |
|---|---|---|---|---|
| nombre exacto | `Rack de Almacenamiento Barras Fijas \| Obelix` | 1 / 1 | sí | `exact_name` |
| SKU | `BORE20` | 0 / 0 (default) · 1 / 1 con `includeOutOfStock` | sí | **vacío por stock 0**, con OOS: `exact_sku` id 545 |
| término parcial | `olimp` | 50 / 193 | **no** | pierde id 981, 1277, 1279 |
| typo | `mancuena` | 0 / 0 | sí | sin tolerancia a typos |
| categoría | `bancos` | 50 / 81 | **no** | devuelve 5 balones medicinales (match en descripción); los bancos reales (898, 1867, 1338…) quedan fuera del corte por ID; además "bancos" no hace prefijo de "banco" |
| atributo | `disco 10 kg` | 0 / 0 (default) · 2 con OOS | sí | los 2 discos de 10 kg tienen stock 0 |
| genérica | `barra` | 50 / 359 | **no** | 309 candidatos nunca rankeados |
| muchos resultados | `disco` | 50 / 209 | **no** | |
| muy genérica | `kg` | 50 / 459 | **no** | |
| no comercial | `Servicio vendedor` (444) | 0 / 0 | sí | excluido por lista hardcodeada |
| desactivado | nombre de un producto inactivo | 1 / 1 | sí | devuelve un duplicado **activo** con el mismo nombre (id 2274): el nombre no identifica |

### 9.3 Conclusión

El ranking es determinista y explicable a nivel de `matchType`, pero **no es suficientemente
confiable** para que un agente seleccione candidatos sin inventar relevancia: para cualquier
consulta genérica el conjunto rankeado es "los productos de ID más bajo que contienen la palabra".
`resolve-product-intent` hereda el defecto (usa `catalogService.searchProducts` por término,
`CS/src/infrastructure/catalog/catalogProductIntentProvider.ts:91-120`) y agrega heurísticas
hardcodeadas (`'barra'`, líneas 70 y 103). Rendimiento: `LIKE '%…%'` sobre descripciones no usa
índice; aceptable con ~2k productos. **UNKNOWN** latencia real (falta ejecución live).

---

## 10. Freshness & Provenance

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| ¿Cuándo se construye el snapshot? | Relaciones/semántica: por CLI manual; sin scheduler | `CS/docs/operations/catalog-service-ec2-deployment.md:52-75` |
| ¿Cuándo se actualiza en runtime? | sólo al reiniciar el proceso | `CS/src/bootstrap.ts:158,176`, `CS/src/recommendationRuntime.ts:75` |
| Datos live (precio/stock/nombre) | por request, con caché | `CS/src/application/catalogService.ts:97-305` |
| ¿Cómo conoce el consumidor la edad? | v1: `freshness.cached` + timestamps **fabricados** en miss parcial; commercial-truth: `evaluatedAt` real; snapshots: `snapshotId`/lineage, `builtAt` no expuesto en todas las rutas | `catalogService.ts:219-224,288-289` |
| ¿Qué pasa durante rebuild? | el build publica atómicamente (`rename`) y preserva el puntero previo si es inválido; el proceso sigue con el snapshot viejo hasta reiniciar | `CS/src/infrastructure/recommendation/fileProductRelationshipSnapshotStore.ts:164-170` |
| ¿Snapshot version? | sí (`sha256:` content hash + `expectedSnapshotId` pinneable) en semántica | `CS/src/shared/contracts.ts:248-266` |
| ¿Source timestamps? | no: `date_upd` no se lee; sin `recordVersion` | grep |
| ¿Se detecta staleness? | no para datos live; para snapshots sólo comparando IDs | — |
| ¿Provenance? | semántica: `ruleId`, `sourceType`, evidencia; live: no | `CS/src/interfaces/http/routes/getProductSemanticsRoute.ts:23-48` |
| `catalogPresence` semántico | congelado al build (reconciliado contra commercial-truth en build) | `CS/scripts/product-semantic-classification/lib/catalog-presence.ts:17-36,53-62` |

Defectos concretos:
1. En miss de producto con hit de precio/stock, `priceCalculatedAt`/`stockCheckedAt = now()` (`catalogService.ts:258-289`).
2. El `ProductDetail` entero (con stock/precio) se cachea `PRODUCT_CACHE_TTL_SECONDS=900`
   (`catalogService.ts:145-152,302`; `config.ts:46`): stock visible hasta 15 min viejo pese a TTL 15 s.
3. R4 estampa `observedAt` al invocar y `validUntil = observedAt + 15 min`
   (`R4/packages/capability-runtime/src/invoker.ts:92-110`, `R4/agents/sales/src/capabilities/catalog.ts:8`):
   el peor caso actual es un precio de ~30 min tratado como vigente.

Requerido: cada bloque de ProductContext con `asOf` = instante real de lectura DB (o
`builtAt` para derivados de snapshot), `cache: {hit, ageMs}`, y `validUntil` del owner; el adapter
R4 no inventa ninguno de esos valores.

---

## 11. Failure Semantics

| Situación | Comportamiento actual | Evidencia | ¿Mezcla ausencia/falla? |
|---|---|---|---|
| input inválido | 400 `INVALID_INPUT` (v1) / `invalid_request` (explore) / `INVALID_REQUEST` (intent) / `INVALID_TRAINING_SEMANTIC_REQUEST` … | `CS/src/interfaces/http/app.ts:139-151`, `CS/src/shared/errors.ts:1-21` | no |
| producto inexistente | 404 `PRODUCT_NOT_FOUND` | `catalogService.ts:156-159` | **sí**: inactivo e inexistente idénticos |
| sin resultados | 200 `items:[]` | `app.ts:238-244` | **sí**: ocultado por stock ⇒ vacío |
| stock sin fila | 503 `STOCK_UNAVAILABLE` para todo el producto (v1) | `prestashopPhysicalStockProvider.ts:10` | falla parcial ⇒ falla total |
| DB caída/timeout | 503 `DATABASE_UNAVAILABLE` (retryable implícito) | `CS/src/infrastructure/database/errors.ts:39-62`, `CS/src/infrastructure/database/queries.ts:5-24` | no |
| error SQL | 500 `CATALOG_QUERY_FAILED` | `errors.ts:59-61` | — |
| Redis caído (driver redis) | excepción no capturada ⇒ 500 `INTERNAL_ERROR`; caché no degrada | `CS/src/infrastructure/cache/redis.ts:14-17`, `catalogService.ts:104` | pierde causalidad |
| snapshot semántico ausente | 503 `PRODUCT_SEMANTICS_UNAVAILABLE` / `TRAINING_SEMANTICS_UNAVAILABLE` | `CS/src/shared/errors.ts:89-123` | no |
| snapshot desalineado con pin | 409 `*_SNAPSHOT_MISMATCH` | idem | no (bueno) |
| snapshot de relaciones ausente | `/health/ready` 503 para todo el servicio | `CS/src/shared/readiness.ts:19-37`, `app.ts:183-189` | acopla núcleo a rama opcional |
| batch | siempre 200 con `ok:false` embebido; código fallback `CATALOG_QUERY_FAILED` | `catalogService.ts:307-339` | **sí** (200 con error embebido) |
| pool agotado | `waitForConnections:true, queueLimit:0` ⇒ espera sin cota; timeout sólo por query (3 s) | `CS/src/infrastructure/database/pool.ts:12-13`, `config.ts:42` | latencia no acotada |
| rate limit | 429 `RATE_LIMITED`, 120/min por IP (sin `keyGenerator`) | `app.ts:87-91,153-157` | — |
| correlación | `x-correlation-id` aceptado y devuelto; en todos los cuerpos de error | `app.ts:81-84,124-127,67-75` | KEEP |

Divergencia resuelta: la auditoría CAT-R1 (`CS/docs/audits/CAT-R1-runtime-endpoints-and-ec2-deployment-audit.md:599-610`)
reportaba readiness mal atribuida, errores DB nunca lanzados, `ENABLE_METRICS` ignorado y
`DB_PASSWORD` vacío aceptado; el código actual corrige los cuatro (`readiness.ts:25-36`,
`queries.ts:18-19`, `app.ts:206`, `config.ts:39`). El documento quedó histórico.

### Contrato de fallas propuesto (R4 ⇄ Catalog)

| Código R4 | Condición | Transporte catalog-service (nuevos endpoints) | `DomainError` R4 (`R4/adapters/domains/src/shared/errors.ts:13`) | Retry |
|---|---|---|---|---|
| `invalid_request` | request rechazado | 400 `invalid_request` | `validation` | no |
| `product_not_found` | ítem inexistente | **200** `{status:'not_found'}` (no error) | — (lectura responde found=false) | — |
| `product_inactive` | existe, no vendible | 200 `found` con `commercialStatus` | — | — |
| `no_results` | búsqueda sin matches | 200 `results:[]`, `totalMatches:0` | — | — |
| `stale_snapshot` | bloque derivado con snapshot ausente/viejo | 200 con bloque `{status:'unavailable', reason}` | — | — |
| `catalog_unavailable` | proceso catalog inalcanzable / 5xx sin cuerpo válido | conexión rechazada / 502-504 | `temporarily_unavailable` | sí |
| `upstream_unavailable` | PrestaShop DB caída | 503 `catalog_source_unavailable`, `retryable:true` | `temporarily_unavailable` | sí |
| `timeout` | deadline R4 (AbortSignal) | — | `timeout` | sí |
| `contract_violation` | respuesta no valida contra schema | — | error no clasificado ⇒ observation `failed` (`R4/agents/sales/src/capabilities/common.ts:37-46`) | no |
| `unauthorized` / `rate_limited` | 401 / 429 | idem | `temporarily_unavailable` (429) / error no clasificado (401: config) | 429 sí |

---

## 12. Performance / Scalability

| Métrica | Valor | Evidencia |
|---|---|---|
| registros de producto | 2011 (1550 en catálogo, 889 activos, 461 sólo históricos) | `EXPORT` |
| combinaciones activas | 225 en 66 productos, máx. 6 | `EXPORT` |
| productos activos con relaciones | 693 | `EXPORT.relationshipCount` |
| snapshot semántico | 2.17 MB, 2011 registros, en memoria | `CS/data/product-semantic-snapshots/snapshots/79ce…json` |
| snapshot de relaciones | **UNKNOWN** (no existe localmente) | — |
| tiempo de rebuild | **UNKNOWN** | — |
| latencia search / product | **UNKNOWN** (sin ejecución live) | — |
| round trips DB `GET /v1/products/:id` (miss) | 7 secuenciales (core, variants, attributes map, default combination, stock, base price, specific prices) | `catalogService.ts:156-283`, `CS/src/infrastructure/pricing/sqlPricingProvider.ts:14-44` |
| round trips DB search | hasta 4 secuenciales (2 variantes × frase+fallback) | `mysqlSearchProvider.ts:18-28` |
| round trips DB intent | hasta 8 términos × 4 + 5 paralelos | `catalogProductIntentProvider.ts:69-120` |
| explore | 1 full scan con 5 agregados sobre tablas completas por request, sin caché | `mysqlCatalogExploreDataReader.ts:166-323` |
| peor caso de latencia GET | 7 × 3 s de timeout + espera de pool no acotada | `config.ts:42`, `pool.ts:12-13` |
| tamaño de payload para el modelo | descripción larga mediana 2420 / p95 4792 / máx 11382 chars; corta mediana 892; features mediana 431 | `EXPORT` |
| concurrencia | coalescer por clave; pool 10 conexiones | `CS/src/shared/coalescer.ts`, `config.ts:41` |

Límites reales para un agente productivo (no optimización prematura):
1. Truncado por ID en search (correctitud, no rendimiento).
2. Descripciones largas completas en el contexto del modelo: coste de tokens y superficie de
   inyección (texto editable por staff).
3. Rate limit 120/min por IP compartido si R4 y CRM salen por la misma IP/túnel (**UNKNOWN** topología).
4. Explore full-scan crecería linealmente; con ~2k productos no es límite hoy.
No se identifican otros problemas de escala a este tamaño.

---

## 13. Agent-readiness Analysis

Pregunta comercial típica: *"¿Tienen banca ajustable que aguante 150 kg, cuánto sale y la tienen?"*

Con la API actual el agente necesitaría: `search` (truncado, oculta sin stock) → `GET product` por
candidato (precio v1, stock hasta 15 min, sin specs) → `explore` o features inexistentes para "150 kg"
→ opcional `semantics` y `search-products v2` para "qué más llevar". Es decir **N+2 a N+4 llamadas**,
con dos motores de precio, tres nociones de disponibilidad y relojes distintos (`generatedAt`,
`productCheckedAt`, `evaluatedAt`, `snapshotId`). Riesgo de stale join: sí (búsqueda cacheada 300 s
con stock de ese momento vs detalle cacheado 900 s).

| Criterio | Estado |
|---|---|
| round trips para responder | 1 + N (+2) — objetivo: 1 search + 1 context por producto discutido |
| coherencia de snapshot | ninguna entre llamadas |
| atomicidad del contexto | no |
| información innecesaria para el modelo | descripción larga, `specificPriceId`, `taxMode`, `pricingMode`, `physicalQuantity` exacta, evidencia de clasificador |
| información crítica ausente | specs estructuradas, marca, estado de listado/pedible, vigencia de promoción, precio en resultados de búsqueda, completitud de resultados, lifecycle |

Conclusión: se necesita un **ProductContext read model coherente** (una lectura, un `asOf`,
bloques con autoridad explícita) y un **search** que devuelva candidatos a nivel producto con
resumen de precio y disponibilidad. Ambos en `CS`.

---

## 14. Canonical R4 Contracts

Diseñados desde la necesidad del agente (§6.4, §7.2, §13), no desde el JSON actual. Esquemas
conceptuales Zod (no implementados). Todos los montos en CLP enteros, IVA incluido.

```ts
import { z } from 'zod';

// ---- Identidad ------------------------------------------------------------
/** Unidad vendible. variantId === null ⇔ el producto NO tiene variantes. */
export const CatalogItemRef = z.strictObject({
  productId: z.string().regex(/^\d+$/),          // PrestaShop id_product (identidad de registro)
  variantId: z.string().regex(/^\d+$/).nullable(), // id_product_attribute
});
/** Clave opaca estable emitida por Catalog; R4 no la parsea. Compatible con el regex de ítems R4. */
export const CatalogItemKey = z.string().regex(/^P\d+(-V\d+)?$/);

const Money = z.strictObject({ amount: z.int().nonnegative(), currency: z.literal('CLP') });
const Freshness = z.strictObject({
  asOf: z.iso.datetime(),                        // instante real de lectura en el owner
  cache: z.strictObject({ hit: z.boolean(), ageMs: z.int().nonnegative() }),
  validUntil: z.iso.datetime().nullable(),       // vigencia declarada por el owner
});

// ---- Disponibilidad (derivada por Catalog, con razón) ----------------------
export const Sellability = z.enum(['sellable', 'backorder', 'not_sellable', 'check_with_staff']);
export const SellabilityReason = z.enum([
  'in_stock', 'backorder_allowed',
  'inactive', 'not_listed', 'not_orderable', 'out_of_stock',
  'stock_unknown', 'variant_required', 'backorder_policy_unknown',
]);

// ---- A. catalog.search -----------------------------------------------------
export const CatalogSearchRequest = z.strictObject({
  query: z.string().trim().min(2).max(120),      // texto libre; Catalog escapa comodines LIKE
  filters: z.strictObject({
    categoryId: z.string().regex(/^\d+$/).optional(),
    maxUnitPrice: z.int().positive().optional(), // sobre precio final bruto (mín. de variantes)
    sellableOnly: z.boolean().default(false),    // filtro explícito; por defecto NO oculta sin stock
  }).default({}),
  limit: z.int().min(1).max(10).default(5),
});

export const CatalogSearchResult = z.strictObject({
  itemKey: CatalogItemKey,                       // nivel producto: P{id}
  ref: CatalogItemRef,                           // variantId null a nivel producto
  name: z.string(),
  sku: z.string().nullable(),                    // display / lookup, no identidad
  category: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  variants: z.strictObject({ count: z.int().nonnegative(), requiresSelection: z.boolean() }),
  priceSummary: z.strictObject({
    kind: z.enum(['exact', 'from']),             // 'from' = mínimo entre variantes vendibles
    finalGross: Money,
    regularGross: Money,
    discounted: z.boolean(),
  }).nullable(),
  availabilitySummary: z.strictObject({
    sellability: Sellability,                    // agregado: mejor estado entre variantes
    reason: SellabilityReason,
    sellableVariants: z.int().nonnegative().nullable(),
  }),
  match: z.strictObject({
    type: z.enum(['exact_reference', 'exact_name', 'name', 'description']),
    matchedTokens: z.int().nonnegative(),
    totalTokens: z.int().positive(),
  }),
});

export const CatalogSearchResponse = z.strictObject({
  schemaVersion: z.literal(1),
  results: z.array(CatalogSearchResult).max(10),
  completeness: z.strictObject({
    totalMatches: z.int().nonnegative(),         // tras filtros, antes de limit
    truncated: z.boolean(),
  }),
  searchMode: z.literal('lexical'),              // declara: sin typos/sinónimos; vacío ≠ "no existe"
  freshness: Freshness,
});

// ---- B. catalog.get_product_context -----------------------------------------
export const ProductContextRequest = z.strictObject({
  itemKey: CatalogItemKey,                       // P{id} o P{id}-V{variant}
  quantity: z.int().min(1).max(99).default(1),   // afecta sólo pricing (from_quantity)
});

const Authoritative = z.strictObject({           // hechos copiados de PrestaShop
  name: z.string(),
  sku: z.string().nullable(),
  shortDescription: z.string().max(600).nullable(), // truncada por Catalog; texto no confiable
  category: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  brand: z.string().nullable(),
  weightKg: z.number().nonnegative().nullable(),
  specifications: z.array(z.strictObject({       // features PS verbatim, sin parseo
    name: z.string(), value: z.string(),
  })).max(40),
  status: z.strictObject({ active: z.boolean(), listed: z.boolean(), orderable: z.boolean() }),
  variantOptions: z.array(z.strictObject({
    itemKey: CatalogItemKey,
    sku: z.string().nullable(),
    attributes: z.array(z.strictObject({ group: z.string(), value: z.string() })),
    isDefault: z.boolean(),
  })).max(20),
  stock: z.strictObject({
    availableQuantity: z.int().nullable(),       // stock_available.quantity (neto de reservas)
    scope: z.enum(['variant', 'product_total']),
  }),
});

const Derived = z.strictObject({                 // calculado por Catalog con reglas declaradas
  pricing: z.union([
    z.strictObject({
      status: z.literal('available'),
      basis: z.strictObject({ taxIncluded: z.literal(true), taxRate: z.number(), taxBasis: z.enum(['configured_flat_rate', 'prestashop_tax_rules']) }),
      quantity: z.int().positive(),
      regularGross: Money,
      finalGross: Money,
      promotion: z.strictObject({
        discountType: z.enum(['amount', 'percentage']),
        discountValue: z.number(),
        validUntil: z.iso.datetime().nullable(),
      }).nullable(),
      engineVersion: z.string(),                 // evidencia para Quote (J3)
    }),
    z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['invalid_base_price', 'variant_required']) }),
  ]),
  availability: z.strictObject({ sellability: Sellability, reason: SellabilityReason, leadTime: z.null() }),
  publicUrl: z.url().nullable(),
});

const Inferred = z.strictObject({                // recomendación / clasificación; nunca "verdad"
  frequentlyBoughtTogether: z.union([
    z.strictObject({
      status: z.literal('available'),
      snapshotId: z.string(), builtAt: z.iso.datetime(),
      items: z.array(z.strictObject({ itemKey: CatalogItemKey, name: z.string(), confidence: z.number(), jointCount: z.int() })).max(5),
    }),
    z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['snapshot_unavailable', 'not_supported']) }),
  ]),
  // compatibleWith / substitutes / bundles: ausentes hasta que exista una fuente curada (CAT-RL-02)
});

export const ProductContextResponse = z.discriminatedUnion('status', [
  z.strictObject({ schemaVersion: z.literal(1), status: z.literal('not_found'), itemKey: CatalogItemKey }),
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('found'),
    itemKey: CatalogItemKey,
    ref: CatalogItemRef,
    facts: Authoritative,
    derived: Derived,
    inferred: Inferred,
    provenance: z.strictObject({
      source: z.literal('prestashop'),
      service: z.literal('catalog-service'),
      serviceBuildRef: z.string(),
      sourceUpdatedAt: z.iso.datetime().nullable(), // ps_product.date_upd (post-J1)
    }),
    freshness: Freshness,                         // UNA lectura coherente para facts + derived
  }),
]);
```

Justificación de campos (sólo los que cambian decisiones comerciales):

| Campo | Decisión que habilita |
|---|---|
| `itemKey` / `ref` | referenciar lo mismo entre turnos y hacia Quote sin ambigüedad variante/base |
| `sku` | el cliente dicta códigos; el agente confirma |
| `priceSummary.kind` | decir "desde $X" vs precio exacto |
| `regularGross` + `promotion.validUntil` | comunicar oferta sin prometer vigencia inexistente |
| `sellability` + `reason` | vender / no vender / derivar a humano / ofrecer espera |
| `variants.requiresSelection` + `variantOptions` | preguntar talla/peso antes de cotizar |
| `specifications` | responder "¿aguanta 150 kg?", "¿mide cuánto armado?" con texto del owner |
| `completeness` + `searchMode` | no afirmar "no lo tenemos" desde un resultado vacío/truncado |
| `freshness` | alimentar freshness del ContextCompiler con edad real del owner |
| `status.listed/orderable` | no ofrecer servicios internos ni productos no pedibles |
| `inferred.*` separado | impedir que co-ocurrencia se presente como compatibilidad |

Excluido deliberadamente del contrato hacia el modelo: descripción larga, `specificPriceId`
(queda en evidencia de Quote vía `engineVersion`, no para el modelo), cantidades de stock exactas
más allá de `availableQuantity` (política R4 decide si se revelan), evidencia del clasificador,
IDs de reglas, contexto de precio por cliente.

---

## 15. Gap Register

| ID | Area | Current | Required | Risk | Class. | Target | Blocking J1? | Evidence |
|---|---|---|---|---|---|---|---|---|
| CAT-ID-01 | Identity | IDs PS numéricos, no generados por snapshot | usar como base de `CatalogItemRef` | bajo | KEEP | catalog-service | no | `mysqlCatalogRepository.ts:343-344`; snapshots usan ID PS |
| CAT-ID-02 | Identity | "producto" = fila combinación / default implícito / agregado / `<base>` | unidad vendible `{productId, variantId\|null}` + `itemKey`; `<base>` sólo si no hay variantes | precio/stock de un ítem inexistente | FIX | catalog-service | **sí** | `productIdentity.ts:14`; `mysqlCatalogCommercialDataReader.ts:169-172`; `catalogService.ts:170-203`; `defaultExploreProductsService.ts:150-168` |
| CAT-ID-03 | Identity | inactivo, borrado e inexistente ⇒ 404 | `found` con status vs `not_found` | agente no distingue descontinuado de error | FIX | catalog-service | **sí** | `mysqlCatalogRepository.ts:115`; `catalogService.ts:156-159` |
| CAT-ID-04 | Identity | R4 usa SKU como productId; regex fixture | tratar `itemKey` como opaco; SKU sólo display | colisión SKU (4 casos) | ADAPT | R4 adapter | **sí** | `R4/…/fixture-data.ts`; `R4/agents/sales/src/capabilities/common.ts:7`; `EXPORT` |
| CAT-PR-01 | Pricing | dos motores divergentes | un único motor, validado por paridad contra storefront | precio distinto por endpoint (`SIM-PRICE`) | FIX | catalog-service | **sí** | `priceResolver.ts:20-32,111-119`; `priceCalculator.ts:60-77`; `specificPriceSelector.ts:100-116`; `defaultExploreProductsService.ts:210-225`; divergencia doc `catalog-commercial-truth.md:19` |
| CAT-PR-02 | Pricing/Freshness | timestamps `now()` en hit de sub-caché | `asOf` real + `cache.ageMs` | stale presentado como fresco | FIX | catalog-service | **sí** | `catalogService.ts:258-289` |
| CAT-PR-03 | Pricing/Freshness | ProductDetail completo cacheado 900 s | no cachear hechos volátiles dentro de agregados; TTL por bloque | stock/precio hasta 15 min viejos | FIX | catalog-service | **sí** | `catalogService.ts:145-152,302`; `config.ts:45-48` |
| CAT-PR-04 | Pricing | vigencia de specific price no expuesta | `promotion.validUntil`, `freshness.validUntil` | prometer oferta vencida | EXTEND | catalog-service | **sí** | `specificPriceSelector.ts:70-80`; contratos sin `to` |
| CAT-PR-05 | Pricing | IVA plano configurado; reglas de impuesto PS ignoradas | validar `id_tax_rules_group` o declarar `taxBasis` y fallar cerrado ante excepciones | precio errado en productos exentos (**UNKNOWN** si existen) | FIX | catalog-service | no (sí para J3) | `config.ts:54`; `priceResolver.ts:136` |
| CAT-PR-06 | Pricing | `ps_specific_price_priority` ignorado | aplicar prioridad PS | selección de regla distinta a PS | FIX | catalog-service | no | `priceResolver.ts:29`; SQL `mysqlCatalogRepository.ts:480-495` |
| CAT-PR-07 | Pricing/Security | contexto de precio por headers controlables por el llamador | adapter fija contexto público; nunca desde el modelo | fuga de precio por cliente / manipulación | ADAPT | R4 adapter | **sí** | `requestContext.ts:11-24`; `app.ts:288-297` |
| CAT-PR-08 | Pricing | base/final bruto + descuento + `specificPriceId` + warnings | conservar semántica | — | KEEP | catalog-service | no | `commercial-truth/contracts.ts:60-71` |
| CAT-PR-09 | Pricing | tramos por cantidad no expuestos | tramos `from_quantity` en context | cotizar volumen sin aviso | EXTEND | catalog-service | no | `mysqlCatalogRepository.ts:505` |
| CAT-AV-01 | Availability | `physical_quantity` | `stock_available.quantity` (neto de reservas) | vender stock ya reservado | FIX | catalog-service | **sí** | `mysqlCatalogRepository.ts:153,355,550`; `mysqlCatalogCommercialDataReader.ts:311`; `mysqlCatalogExploreDataReader.ts:291-292` |
| CAT-AV-02 | Availability | v1 ignora `available_for_order` y `visibility`; todos ignoran `visibility` | `listed` y `orderable` en todas las rutas | ofrecer 10 no pedibles y 6 ocultos (servicios internos) | FIX | catalog-service | **sí** | `mysqlCatalogRepository.ts:380`; `EXPORT` |
| CAT-AV-03 | Availability | `out_of_stock`/backorder, `available_date` no leídos | política de backorder ⇒ `backorder` o `backorder_policy_unknown` | rechazar ventas válidas o prometer plazos | EXTEND | catalog-service | **sí** | grep sin coincidencias |
| CAT-AV-04 | Availability | modelo status/purchasable/stockKnown/evaluatedAt | base del contrato | — | KEEP | catalog-service | no | `availabilityResolver.ts:3-75` |
| CAT-AV-05 | Availability | fila de stock ausente ⇒ 503 total; variantes desaparecen por INNER JOIN | `stock_unknown` por ítem | falla total por dato parcial | FIX | catalog-service | no | `prestashopPhysicalStockProvider.ts:10`; `mysqlCatalogRepository.ts:162-165` |
| CAT-RL-01 | Relationships | `same_order` dirigido, con reliability, etiquetado FBT | exponer sólo como `inferred.frequentlyBoughtTogether` | — | KEEP | catalog-service | no | `sameOrderCalculator.ts:279-292`; `defaultSearchProductsV2Service.ts:361-366` |
| CAT-RL-02 | Relationships | sin compatibilidad/accesorios/sustitutos/bundles | fuente curada (p. ej. `ps_accessory` si está poblada) con tipo explícito | el agente inventa compatibilidad | EXTEND | catalog-service | no | `contracts.ts:90-97`; grep `accessory`/`pack` sin lectura SQL |
| CAT-RL-03 | Relationships | vocabulario declarado nunca emitido | retirar del contrato público | consumidores asumen semántica | REMOVE | catalog-service | no | `CS/src/domain/recommendation/contracts.ts:86-131`; grep |
| CAT-RL-04 | Relationships | no-productos excluidos de relaciones sólo por env; 2 políticas (2 vs 13 IDs) | una política `itemKind` aplicada a search, context y relaciones | "Costo logístico" como FBT | FIX | catalog-service | no | `discoveryExclusionPolicy.ts:7-10`; `config.ts:60`; snapshot semántico |
| CAT-RL-05 | Relationships/Ops | snapshots sólo al reiniciar; readiness 503 si falta snapshot de relaciones | refresh sin restart o edad expuesta; readiness núcleo independiente | núcleo "no listo" por rama opcional | FIX | catalog-service | no | `bootstrap.ts:158,176`; `recommendationRuntime.ts:75`; `readiness.ts:35`; `app.ts:185-186` |
| CAT-SR-01 | Search | `ORDER BY id LIMIT 50` antes de rankear | rankear sobre todo el conjunto (o límite por relevancia en SQL) | candidatos relevantes nunca vistos (`SIM-SEARCH`) | FIX | catalog-service | **sí** | `mysqlCatalogRepository.ts:397-408` |
| CAT-SR-02 | Search | oculta stock ≤ 0 por defecto | devolver con `sellability`; filtro explícito | SKU exacto "no existe" | FIX | catalog-service | **sí** | `app.ts:221`; `contracts.ts:191-194`; `SIM-SEARCH` BORE20 |
| CAT-SR-03 | Search | una fila por combinación | una fila por producto con resumen de variantes | un producto consume los slots | FIX | catalog-service | **sí** | `mysqlCatalogRepository.ts:342-397` |
| CAT-SR-04 | Search | sin precio, categoría, completitud, filtros de categoría/precio | `priceSummary`, `category`, `completeness`, filtros | N+1 lecturas; afirmar ausencia | EXTEND | catalog-service | **sí** | `CS/src/shared/contracts.ts:20-45` |
| CAT-SR-05 | Search | léxico sin typos/stemming | declarar `searchMode`; mejora futura | "bancos" ≠ "banco" | EXTEND | catalog-service | no | `searchTextRelevance.ts:33-41`; `SIM-SEARCH` |
| CAT-SR-06 | Search | ranking determinista y desempates estables | conservar señales como `match` | — | KEEP | catalog-service | no | `searchTextRelevance.ts:142-157` |
| CAT-SR-07 | Search | heurísticas de dominio en código (`barra`, productTypes, IDs 444/505) | datos/políticas versionadas | comportamiento opaco no evaluable | FIX | catalog-service | no | `catalogProductIntentProvider.ts:70,103`; `defaultExploreProductsService.ts:42-64`; `discoveryExclusionPolicy.ts:7-10` |
| CAT-SR-08 | Search/Security | `%`/`_` del query no escapados en LIKE | escapar comodines | query del modelo `%%` ⇒ scan total | FIX | catalog-service | no | `mysqlCatalogRepository.ts:286,320` |
| CAT-SR-09 | Search | `resolve-product-intent` decide `resolved/clarification` por el agente | R4 no lo consume; decisión en R4 | doble autoridad de decisión | REMOVE | R4 surface | no | `defaultProductIntentResolutionService.ts:218-277` |
| CAT-SM-01 | Semantics | snapshots con lineage, checksum, pin, ranking determinista | fuente derivada futura | — | KEEP | catalog-service | no | `contracts.ts:248-283`; `defaultSemanticDiscoveryService.ts:406` |
| CAT-SM-02 | Semantics | `catalogPresence` congelado al build | reconciliar contra estado live al servir | productos desactivados "presentes" | FIX | catalog-service | no | `catalog-presence.ts:17-36` |
| CAT-CX-01 | Context | sin read model coherente | `get_product_context` en una lectura, un `asOf` | stale joins, N llamadas | EXTEND | catalog-service | **sí** | §13 |
| CAT-CX-02 | Context | features no expuestas (880/889 las tienen) | `specifications` verbatim | agente sin datos técnicos | EXTEND | catalog-service | **sí** | `mysqlCatalogExploreDataReader.ts:256-273`; `EXPORT` |
| CAT-CX-03 | Context | marca no leída (836/889) | `brand` nullable | menor (nombre suele incluir marca) | EXTEND | catalog-service | no | grep `manufacturer`; `EXPORT` |
| CAT-CX-04 | Context | imágenes no expuestas (`imageUrl` nunca asignado) | media opcional | menor | EXTEND | catalog-service | no | `catalogCommercialTruthService.ts:167-180` |
| CAT-CX-05 | Context | `weightKg`, `publicLink` con scope | conservar | — | KEEP | catalog-service | no | `catalogService.ts:42-73,212-217`; `productPublicUrl.ts:30-61` |
| CAT-CX-06 | Context/Security | descripciones de hasta 11k chars, texto editable por staff | adapter trunca, marca como texto no confiable | tokens + inyección | ADAPT | R4 adapter | **sí** | `EXPORT`; `CS/src/shared/html.ts:1-16` |
| CAT-FP-01 | Freshness | sin `date_upd` ni `recordVersion` | `sourceUpdatedAt` | sin detección de cambios entre turnos | EXTEND | catalog-service | no | grep `date_upd` |
| CAT-FP-02 | Freshness | R4 `observedAt` = invocación, TTL 15 min | adapter transporta `freshness`; TTL ≤ vigencia del owner | precio viejo tratado como vigente | ADAPT | R4 adapter / capability def. | **sí** | `R4/…/invoker.ts:92-110`; `R4/agents/sales/src/capabilities/catalog.ts:8` |
| CAT-FL-01 | Failure | vocabularios de error heterogéneos | mapeo a `DomainError` (§11) | reintentos/decisiones erróneas | ADAPT | R4 adapter | **sí** | `CS/src/shared/errors.ts:1-21`; `exploreProductsRoute.ts:17-25` |
| CAT-FL-02 | Failure | batch 200 con error embebido, fallback `CATALOG_QUERY_FAILED` | estado por ítem tipado, sin fallback ciego | causalidad perdida | FIX | catalog-service | no | `catalogService.ts:307-339` |
| CAT-FL-03 | Failure | error de Redis ⇒ 500 | caché degrada a miss | caída de caché tumba lecturas | FIX | catalog-service | no | `redis.ts:14-17`; `catalogService.ts:104` |
| CAT-FL-04 | Failure | espera de pool sin cota, 7 queries secuenciales | cota de adquisición / paralelizar | latencia de cola | FIX | catalog-service | no | `pool.ts:12-13`; `catalogService.ts:156-283` |
| CAT-FL-05 | Failure | correlation id, normalización DB 503/500 | conservar | — | KEEP | catalog-service | no | `app.ts:81-84,124-127`; `database/errors.ts:39-62` |
| CAT-SE-01 | Security | 100 % read-only, API key timing-safe, schemas estrictos, SQL parametrizado, docs off en prod | conservar | — | KEEP | catalog-service | no | `crypto.ts`; `app.ts:93,192-204`; `queries.ts:16` |
| CAT-SE-02 | Security | inputs `additionalProperties:true` y llamada a Customer Profile con cliente del llamador (search v2) | fuera de la superficie R4 J1 | acoplamiento cross-domain | REMOVE | R4 surface | no | `searchProductsV2Route.ts:51-58`; `resolveProductIntentRoute.ts:46-49`; `bootstrap.ts:112-121` |
| CAT-PF-01 | Performance | explore full scan + 5 agregados por request, sin caché | read model indexado o caché | crecimiento lineal | FIX | catalog-service | no | `mysqlCatalogExploreDataReader.ts:166-323` |
| CAT-R4-01 | R4 contract | puerto/fixture promete `brand` obligatorio, `recordVersion`, `updatedAt`, `footprintCm`, `compatibleWith`, `alternatives`, `low_stock`, `discontinued` | reemplazar por contrato §14 | agente cita datos que no existen en el owner (dimensiones 0/889) | REMOVE | R4 port + fixture | **sí** | `R4/adapters/domains/src/catalog/port.ts:11-50`; `R4/agents/sales/src/capabilities/catalog.ts:10-49`; `EXPORT` |

**Conteo:** KEEP 9 · ADAPT 5 · EXTEND 11 · FIX 22 · REMOVE 4 (total 51).
Bloqueantes J1: 21 (15 en catalog-service, 6 en R4).

---

## 16. Proposed Target Architecture

```text
PrestaShop MariaDB (source of truth; sin cambios)
        │  lectura
        ▼
catalog-service (owner del Catalog read model)
  ├─ CommercialTruth (ÚNICO motor): identidad vendible · precio (paridad validada) ·
  │   disponibilidad (quantity, listed, orderable, backorder) · freshness honesta
  ├─ Search read path: relevancia antes de truncar · agrupado por producto · filtros explícitos
  ├─ ProductContext assembler: una lectura coherente → facts | derived | inferred + freshness
  ├─ Derived snapshots (semantics, same_order) como bloques `inferred` con snapshotId/builtAt
  └─ HTTP
      NEW  POST /v2/catalog/search                ← contrato §14 A
      NEW  GET  /v2/catalog/items/{itemKey}/context ← contrato §14 B
      KEEP (CRM) v1/*, explore, intent, search-products v2, semantics/*  (no consumidos por R4)
        │  x-api-key dedicada a R4, deadline por AbortSignal
        ▼
R4 adapters/domains/catalog (HTTP adapter, sin lógica comercial)
  valida schema · mapea errores a DomainError · fija contexto público de precio ·
  trunca/rotula texto no confiable · transporta freshness del owner
        ▼
Sales capabilities (READ): catalog.search · catalog.get_product_context
        ▼
Observation → ContextCompiler (sin cambios de kernel)
```

No se introduce datastore nuevo: el volumen (~2k productos) no lo justifica. La coherencia de
ProductContext se obtiene con una lectura DB acotada por request (las consultas batch de
`MySqlCatalogCommercialDataReader` ya son el patrón), no con un snapshot materializado.

---

## 17. Required catalog-service Remediation

### Blocking (antes de conectar R4)

| # | Paquete | Gaps | Contenido |
|---|---|---|---|
| B1 | Unidad vendible y lifecycle | CAT-ID-02, CAT-ID-03 | `itemKey`/`CatalogItemRef`; prohibir `<base>` para productos con variantes; `found`/`not_found` + status |
| B2 | Motor de precio único | CAT-PR-01, CAT-PR-04 | un motor (estructura/warnings de commercial-truth + tratamiento neto de `reduction_tax=0` de v1), prueba de paridad con casos reales del storefront versionados en repo, exponer vigencia |
| B3 | Hechos de disponibilidad | CAT-AV-01, CAT-AV-02, CAT-AV-03 | `quantity` en vez de `physical_quantity`; `visibility`, `available_for_order`, `out_of_stock` (+ configuración global de pedidos sin stock) en toda ruta usada por R4 |
| B4 | Freshness honesta | CAT-PR-02, CAT-PR-03 | `asOf` real, `cache.ageMs`, sin caché compuesta de hechos volátiles |
| B5 | Endpoint de búsqueda | CAT-SR-01..04 | `POST /v2/catalog/search` según §14 A |
| B6 | Endpoint de contexto | CAT-CX-01, CAT-CX-02 | `GET /v2/catalog/items/{itemKey}/context` según §14 B, con `specifications` |

### Non-blocking (diferibles)

CAT-PR-05 (bloqueante para J3), CAT-PR-06, CAT-PR-09, CAT-AV-05, CAT-RL-02, CAT-RL-03, CAT-RL-04,
CAT-RL-05, CAT-SR-05, CAT-SR-07, CAT-SR-08, CAT-SM-02, CAT-CX-03, CAT-CX-04, CAT-FP-01,
CAT-FL-02, CAT-FL-03, CAT-FL-04, CAT-PF-01.

---

## 18. Required R4 Adapter Work

(Posterior a la aprobación; nada de esto se implementa en esta tarea.)

1. **Reemplazar el puerto** `R4/adapters/domains/src/catalog/port.ts` y la fixture por el contrato
   §14 (CAT-R4-01); actualizar `catalogSearchOutput`/`productContextOutput`
   (`R4/agents/sales/src/capabilities/catalog.ts:10-49`).
2. **HTTP adapter** `adapters/domains/catalog/http`: parseo Zod de la respuesta (falla ⇒
   `contract_violation`, error no clasificado); `schemaVersion` mayor debe coincidir.
3. **Mapeo de errores** según §11 a `DomainError` (CAT-FL-01).
4. **Contexto de precio fijo** (público, sin headers de cliente) (CAT-PR-07).
5. **Deadline** por `AbortSignal` ≤ `timeoutMs` de la capability (hoy 10 s, `common.ts:22`).
6. **Texto no confiable:** truncar `shortDescription`, nunca pasar descripción larga, marcar el
   bloque como contenido del catálogo, no instrucción (CAT-CX-06).
7. **Freshness:** transportar `freshness` del owner dentro del payload; ajustar
   `CATALOG_FRESHNESS_TTL_MS` (hoy 15 min) a un valor ≤ la vigencia declarada por Catalog
   (propuesta: 5 min para conversación; Quote siempre re-lee) (CAT-FP-02). Sin cambios de kernel.
8. **`itemKey` opaco** en R4; SKU sólo como dato (CAT-ID-04).
9. **Presentación de `inferred`** en el ContextCompiler como `DERIVED`, nunca como hecho
   (respeta ADR-011; sin cambios de compilador).

---

## 19. Contract Test Plan

**En catalog-service (el owner publica fixtures de contrato):**
- Schema: respuestas de ambos endpoints validan contra §14 (tests HTTP con `app.inject`).
- Identidad: producto sin variantes ⇒ `P{id}`; con variantes ⇒ resultados a nivel producto con
  `requiresSelection`; `<base>` rechazado para contexto de producto con variantes (`variant_required`).
- Lifecycle: activo / inactivo / inexistente ⇒ `found+active` / `found+inactive` / `not_found`.
- Precio: casos golden de storefront (versionados) para ambos casos de `reduction_tax`, empate de
  especificidad, `from_quantity`, ventana de fechas con reloj fijo; un único motor en todas las rutas.
- Disponibilidad: `quantity` vs `physical_quantity` con reservas; `visibility=none`,
  `available_for_order=0`, `out_of_stock` permite/deniega, fila de stock ausente.
- Search: regresión de truncado con los casos de `SIM-SEARCH` (`barra`, `bancos`, `disco`, `olimp`,
  `kg`): el ideal sin límite debe coincidir con el servicio; SKU exacto sin stock aparece con
  `sellability`; `completeness.truncated` correcto; `%` escapado.
- Freshness: reloj falso; `asOf` = instante de lectura; en hit de caché `ageMs` > 0 y `asOf` no avanza.
- Fallas: DB caída ⇒ 503 `catalog_source_unavailable retryable:true`; snapshot FBT ausente ⇒
  200 con bloque `unavailable`.
- Los tests de training semantics dependen hoy de un snapshot local no versionado (ver §21):
  el contrato nuevo no debe depender de artefactos fuera de Git.

**En R4 (consumidor):**
- El adapter se prueba contra las fixtures JSON publicadas por catalog-service (copiadas con su
  `schemaVersion`), no contra mocks escritos a mano.
- Mapeo de cada código §11 a `DomainError` y a observation `failed`.
- Payload inválido ⇒ `contract_violation`; campo extra aditivo ⇒ tolerado.
- Evaluación (ship with implementation): escenarios Sales para precio exacto vs "desde", sin stock,
  no listado, variante requerida, pregunta técnica respondida sólo con `specifications`,
  prohibición de afirmar compatibilidad a partir de `frequentlyBoughtTogether`, y "no lo encontré"
  sólo con `completeness` no truncada.
- Smoke read-only contra el entorno real, sólo con autorización explícita.

---

## 20. Recommendation for J1 Implementation

1. **Aprobar este contrato** y registrarlo como ADR (p. ej. "Catalog canonical read contract").
2. **catalog-service B3 + B2** (hechos correctos primero: disponibilidad y precio único con paridad).
3. **catalog-service B1 + B4** (unidad vendible, lifecycle, freshness honesta).
4. **catalog-service B5 + B6** (endpoints nuevos) con los contract tests de §19 y fixtures publicadas.
5. **Marcar para R4 como no-contrato** v1 search/product/batch, explore, resolve-product-intent,
   search-products v2 (se mantienen para CRM; no se eliminan).
6. **R4:** reemplazar puerto + fixture (CAT-R4-01) → HTTP adapter (§18) → actualizar schemas de
   capabilities y TTL → escenarios de evaluación.
7. **Ejecución live-read en staging/shadow**, luego habilitación productiva sólo con autorización
   explícita de fase.

---

## 21. Decisiones arquitectónicas (respuestas explícitas)

1. **¿catalog-service merece seguir siendo owner del read model?** Sí. Tiene el acceso, el
   aislamiento read-only y piezas correctas (commercial-truth, snapshots con lineage). Reemplazarlo
   duplicaría la reimplementación de reglas PS.
2. **¿Su modelo interno es suficientemente correcto?** No todavía: identidad vendible ambigua, dos
   motores de precio, stock físico sin reservas, flags de listado ignorados y freshness fabricada.
   Son defectos acotados y corregibles en el servicio.
3. **¿La API actual debería consumirse directamente?** No. Ningún endpoint actual cumple el contrato.
4. **¿Necesitamos R4 Catalog Adapter?** Sí, delgado: transporte, validación, mapeo de errores,
   contexto fijo, freshness. Sin lógica comercial ni reparación de defectos del owner.
5. **¿Endpoints nuevos en catalog-service?** Sí: `POST /v2/catalog/search` y
   `GET /v2/catalog/items/{itemKey}/context`.
6. **¿Qué endpoints quedan internos/deprecated (para R4)?** `GET /v1/products/search`,
   `GET /v1/products/:id`, `POST /v1/products/batch`, `POST /v1/products/explore`,
   `POST /api/v2/catalog/resolve-product-intent`, `POST /api/v2/recommendations/search-products`.
   Semantics/training/discovery quedan como fuentes derivadas internas.
7. **¿Qué NO debe llegar al modelo?** Descripción larga, IDs de reglas de precio, contexto de
   precio por cliente, evidencia del clasificador, cantidades de stock exactas salvo política R4,
   no-productos/servicios internos, relaciones estadísticas presentadas como compatibilidad.
8. **¿Qué necesita provenance/freshness explícita?** Precio (asOf, validUntil, engineVersion),
   disponibilidad (asOf, cache age), bloques inferidos (snapshotId, builtAt), resultados de
   búsqueda (asOf, completitud).
9. **Bloqueantes J1:** B1–B6 en catalog-service y CAT-ID-04, CAT-PR-07, CAT-CX-06, CAT-FP-02,
   CAT-FL-01, CAT-R4-01 en R4.
10. **Diferibles:** lista non-blocking de §17 (IVA por reglas es bloqueante para J3, no J1);
    compatibilidad/accesorios curados, marca, media, `sourceUpdatedAt`, refresh sin restart.

---

## 22. Riesgos y UNKNOWN

| Tema | Estado | Evidencia faltante |
|---|---|---|
| Collation MySQL (accentos/mayúsculas en LIKE) | UNKNOWN; `SIM-SEARCH` asume `*_ci` | `SHOW FULL COLUMNS FROM ps_product_lang` |
| Latencias reales search/context | UNKNOWN | ejecución live autorizada |
| Existencia en prod de specific prices `reduction_tax=0` o empates | UNKNOWN | consulta a `ps_specific_price` |
| Productos con impuesto ≠ 19 % | UNKNOWN | `ps_product.id_tax_rules_group` distribución |
| `ps_accessory` / `ps_pack` poblados | UNKNOWN | conteos en DB |
| Regeneración de combinaciones (estabilidad de `id_product_attribute`) | UNKNOWN | historial PS / política de staff |
| Multi-bodega / advanced stock management | UNKNOWN | configuración PS |
| Exposición de red de catalog-service en EC2 (`HOST=0.0.0.0` por defecto) | UNKNOWN | security groups / config PM2 (no versionada: `CS/docs/audits/CAT-R1-…:607`) |
| `RELATIONSHIP_SOURCE_EXCLUDED_PRODUCT_IDS` en prod | UNKNOWN | `.env` de EC2 |
| Significado de negocio "Commercial / Final" | UNKNOWN | definición del owner comercial |
| Topología IP R4/CRM (rate limit compartido) | UNKNOWN | despliegue R4 |
| Suite de tests `CS` | 2286 tests: 12 fallan de forma determinista (3 archivos de training semantics requieren `data/training-semantic-snapshots/v2`, ignorado por Git); 9 fallas adicionales fueron timeouts de 5 s bajo carga paralela que pasan en aislamiento | ejecución §23 |

---

## 23. Comandos ejecutados

| Comando | Resultado |
|---|---|
| `npx vitest run --config vitest.config.ts` (en `E:\…\MS-pesaschile-catalog-service`) | 92 archivos; 2265 pass / 21 fail |
| mismo, sólo archivos fallidos, `--no-file-parallelism` | 3 archivos, 12 fail / 4 pass (todos: `TRAINING_SEMANTICS_UNAVAILABLE`, snapshot local ausente) |
| `curl http://127.0.0.1:4010/health/{live,ready}` | conexión rechazada (servicio no corriendo localmente) |
| `SIM-SEARCH` (tsx, scratchpad; código real `MySqlSearchProvider` + `EXPORT`) | tabla §9.2 |
| `SIM-PRICE` (tsx, scratchpad; `resolvePrice` vs `CommercialPriceCalculator`) | tabla §6.3 |
| análisis de distribución de `EXPORT` (python) | cifras de §3, §7, §12 |

Los harness `SIM-*` viven en el scratchpad de la sesión y no se versionaron; pueden incorporarse
como contract tests en B5/B2.

---

## Implementation outcome

Implementación ejecutada en `MS-pesaschile-catalog-service` después de esta auditoría:

- B1: `CatalogItemRef`, `P{id}`/`P{id}-V{variantId}`, lifecycle `found`/`not_found`, y sin pseudo-unidad base para productos con variantes.
- B2: motor comercial v2 único para las nuevas superficies y semántica alineada en los motores legacy para `reduction_tax`, precio regular/final y desempate determinista.
- B3: `stock_available.quantity`, `visibility`, `available_for_order`, `out_of_stock` y política global heredada; stock ausente produce `stock_unknown`.
- B4: `asOf`, edad de caché, `validUntil` y caché acotada por la vigencia comercial; no se generan timestamps de lectura sobre datos antiguos.
- B5: `POST /v2/catalog/search`, búsqueda lexical agrupada por producto, ranking antes de truncar, filtros de categoría/precio/sellability y comodines LIKE escapados.
- B6: `GET /v2/catalog/products/{productKey}/context`, con facts, derived, inferred, provenance y specifications estructuradas.
- B7: `GET /v2/catalog/items/{itemKey}/context?quantity=N`, con pricing y availability de una unidad vendible concreta.

El resultado versionado, schemas y fixtures están publicados bajo
`CS/contracts/catalog/v2/`. Las superficies v1 se mantienen para CRM y no son contrato de R4.
No se conectó R4 automáticamente. El live-read productivo sigue siendo `UNKNOWN` por falta de
autorización/túnel configurado; no se modificó ninguna base de datos.
