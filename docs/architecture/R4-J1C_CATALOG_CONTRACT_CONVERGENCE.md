# R4-J1C — Catalog Contract Convergence and Integration Readiness

Estado: **convergencia implementada y verificada localmente contra el servicio real**. **R4-J1 NO
está CLOSED.** Catalog sigue **UNAVAILABLE** en el perfil productivo desplegado (v1, sin cambios);
el perfil v2 está preparado y **no habilitado**. Nada se desplegó ni se commiteó.
Fecha: 2026-09-29. Bases: R4 `60651b8` (J1B), catalog-service `4fd891f` (J1A).
Antecedentes: `R4-J1_CATALOG_CONTRACT_AND_SERVICE_AUDIT.md`, `R4-J1B_CATALOG_CONSUMER_IMPLEMENTATION.md`,
catalog-service `docs/architecture/R4-J1A_CATALOG_REMEDIATION.md`.

> Nota de estado: el encargo describía J1A y J1B "sin commit". No era así: J1A estaba en
> `7097db2`+`4fd891f` y J1B en `60651b8`, ambos pusheados. Los cambios de J1C están en el working
> tree de ambos repos, sin commit.

---

## 1. Veredicto de compatibilidad

**Antes de J1C: INCOMPATIBLE.** Las dos implementaciones pasaban sus propios tests y no podían
hablar entre sí:

- **Contrato:** 26 de 34 puntos comparados divergían (§2). R4 rechazaba toda respuesta de Catalog
  (`search.results[].product` ausente, `derived.priceSummary` ausente, `facts.lifecycle` ausente…).
- **Servicio:** contra una base con el esquema real de PrestaShop, **los tres endpoints v2 de J1A
  respondían 500 siempre** (columna inexistente `fv.custom_value`; `ESCAPE '\'` es un error de
  sintaxis con el `sql_mode` por defecto). Las pruebas de J1A usaban lectores falsos y no podían
  verlo.
- **Precio:** las promociones sin fecha límite (en PrestaShop, `0000-00-00 00:00:00`) se
  ignoraban: precio final = precio regular.

**Después de J1C: COMPATIBLE para `schemaVersion: 1`**, con evidencia ejecutable:

- un único contrato: el esquema Zod del owner; los esquemas de R4 lo reflejan campo a campo;
- fixtures únicas: generadas por el servicio real del owner, fijadas por hash y copiadas sin cambios
  a R4 (§4);
- 12/12 pruebas de integración HTTP reales R4 ↔ catalog-service (4 instancias vivas, base
  sintética), sin mocks entre ambos (§7);
- AG-J1B-01 cerrado por ADR-030 (§5).

Regla aplicada para decidir quién corrige: **Catalog es owner del formato.** Se corrigió Catalog
sólo donde su semántica era incorrecta (identidad, hechos que R4 habría tenido que calcular o
inferir, SQL roto, precio). En todo lo demás R4 adoptó los nombres del owner, para que el adapter
no renombre ni reinterprete nada: su única transformación es quitar `schemaVersion`.

---

## 2. Divergencias J1A ↔ J1B (esquemas ejecutables)

Comparación de `catalog-service/src/domain/catalog/v2/contracts.ts` (J1A) contra
`R4/adapters/domains/catalog/http/src/schemas.ts` (J1B), confirmada con la salida real del servicio.
"Compatible" se refiere al estado pre-J1C.

| # | Path | Catalog (J1A) | R4 (J1B) | Compatible | Owner del fix | Cambio aplicado |
|---|---|---|---|---|---|---|
| 1 | `search.results[].itemKey` | `itemKey = P{id}` **también con variantes** | `product.productKey` | **No** | Catalog | `productKey` (identidad de producto) |
| 2 | `search.results[].ref` | `{productId, variantId:null}` | `product.productId` | **No** | Catalog | `ref: {productId}` (sin `variantId` a nivel producto) |
| 3 | `search.results[].name/sku/category.name` | sin cotas | 200 / 64 / 120 | Parcial (PS permite 128 > 120) | Ambos | owner declara 128/64/128; R4 las adopta |
| 4 | `search.results[].match.type` | enum 4 valores | texto ≤40 | Sí | — | — |
| 5 | `search.results[].availabilitySummary.sellableVariants` | `null` sin variantes | nullable | Sí | R4 | invariante nueva: `null ⇔ count = 0` |
| 6 | `search` request | estricto `{query 2–120, filters{categoryId ^\d+$, maxUnitPrice int>0, sellableOnly}, limit 1–10}` | mismas claves | Sí | — | — |
| 7 | `productContext.found.itemKey` | `P{id}` | `product.productKey` | **No** | Catalog | `productKey` |
| 8 | `productContext.found.ref` | `{productId, variantId:null}` | `product.productId` | **No** | Catalog | `ref: {productId}` |
| 9 | `productContext.not_found.itemKey` | `itemKey` | `productKey` | **No** | Catalog | `productKey` |
| 10 | `facts.status` / `facts.lifecycle` | `status {active, listed, orderable}` | `lifecycle {status: active\|inactive, …}` | **No** | R4 | R4 adopta `status` del owner |
| 11 | `facts.sellableItem` | **ausente** | `ItemRef \| null` requerido | **No** | Catalog | `{itemKey, ref{productId, variantId:null}} \| null` |
| 12 | `facts.variantOptions[]` | `{itemKey, sku, attributes, isDefault}` | `{item{productId, variantId, itemKey}, …}` | **No** | Ambos | Catalog agrega `ref{productId, variantId}`; R4 adopta `itemKey` + `ref` |
| 13 | `facts.variantOptions` cota | `.max(20)` declarado, no aplicado | `.max(50)` | **No** | Ambos | 100 declarado por el owner y validado en salida; R4 100; máximo real = UNKNOWN B8 |
| 14 | `facts.weightKg`, `facts.stock` | presentes | no declarados | Sí (aditivo) | — | R4 los descarta (no los usa) |
| 15 | `facts.specifications[]` | sin cotas | name ≤120, value ≤300 | Parcial | Ambos | owner 128/255 (columnas PS); R4 las adopta |
| 16 | `derived.pricing` / `derived.priceSummary` | `pricing` del variante más barato, **sin `exact`/`from`** | `priceSummary {kind, …}` | **No** | Catalog | `derived.priceSummary`; R4 habría tenido que inferir "desde" contando variantes |
| 17 | `derived.availability` | `{sellability, reason, leadTime}` | `{sellability, reason, sellableVariants}` | **No** | Catalog | agrega `sellableVariants`; R4 tolera `leadTime` |
| 18 | `inferred.frequentlyBoughtTogether.items[]` | `itemKey` | `product{productId, productKey}` | **No** | Catalog | `productKey`; `confidence ∈ [0,1]` declarado |
| 19 | `sourceUpdatedAt` | en `provenance` (requerido, nullable) | en `freshness`, **`.default(null)`** | **No** | R4 | R4 lo lee de `provenance`, requerido (el default lo perdía en silencio) |
| 20 | `freshness` | `{asOf, cache{hit, ageMs}, validUntil}` | igual | Sí | — | — |
| 21 | `item.found` identidad | `itemKey` + `ref{productId, variantId}` | `item{productId, variantId, itemKey}` | **No** (forma) | R4 | R4 adopta la forma del owner |
| 22 | `item.found.parentProduct` | `{productKey, name, sku}` | `product{ref, name, sku, lifecycle}` | **No** | R4 | R4 adopta; `lifecycle` sobraba (lo expresa `availability.reason`) |
| 23 | `item.found.variant` | objeto siempre, `variantId` null si no hay variantes | `null ⇔ sin variante` | **No** | R4 | invariante: `variant.variantId = ref.variantId` |
| 24 | `item.pricing.tax` | `tax{included, rate, basis}` | `taxBasis{taxIncluded, …}` | **No** | R4 | R4 adopta |
| 25 | `item.pricing.promotion` | `{discountType, discountValue (fracción), validUntil}` | `{kind, value (fixture R4: 10 = %)}` | **No** (nombres **y unidades**) | R4 + owner | R4 adopta nombres; unidad documentada; base del monto = OD-2 |
| 26 | `item.pricing.lineFinalGross` | ausente | requerido | **No** | R4 | R4 lo elimina: totales de línea son de Quote (J3); R4 no multiplica |
| 27 | `item.pricing.unavailable.reason` | incluía `variant_required` (inalcanzable) | texto | Sí | Catalog | valor muerto eliminado |
| 28 | `item` con `P{id}` de producto con variantes | `not_found` (rama `requireVariant` muerta) | `variant_required` | **No** | Catalog | `{status: 'variant_required', itemKey, productKey}` |
| 29 | `schemaVersion` | literal 1 | literal 1, rechazo previo | Sí | — | — |
| 30 | 401 | `UNAUTHORIZED` en mayúsculas, sin `retryable` | fallback `unauthorized` | Sí (R4 robusto) | Catalog | v2: códigos en minúsculas + `retryable` |
| 31 | salida inválida del owner | se enviaba sin validar | rechazo en R4 | Parcial | Catalog | el owner valida su salida: `500 contract_output_invalid` |
| 32 | SQL del lector v2 | `fv.custom_value`, `ESCAPE '\'` | — | **No (500 siempre)** | Catalog | columna eliminada (sólo `feature_value_lang`); escape `!` |
| 33 | promociones con fecha cero | ignoradas | — | **No (precio)** | Catalog | `NULLIF(… '0000-00-00 00:00:00')` → ventana abierta |
| 34 | política aditiva | objetos estrictos (salida propia) | no estrictos + un `default` | Parcial | R4 | sin defaults: campo conocido ausente ⇒ rechazo |

Otros hallazgos del owner, sin cambio en J1C (registrados en §12): FBT no está cableado en el
bootstrap productivo (siempre `unavailable`); `publicUrl` usa el patrón `/categories/{id}-{slug}.html`
(verificar, D8); el precio "desde" incluye variantes sin stock (OD-1).

---

## 3. Semántica final `productKey` / `itemKey` (congelada, schemaVersion 1)

```
productKey = identidad de PRODUCTO   (P{id})
itemKey    = identidad de UNIDAD VENDIBLE (P{id} sólo sin variantes; P{id}-V{variantId})
```

| Superficie | Emite | Nunca emite |
|---|---|---|
| `POST /v2/catalog/search` (nivel producto) | `results[].productKey`, `ref{productId}` | `itemKey` |
| `GET …/products/{productKey}/context` | `productKey`, `ref{productId}`; `facts.sellableItem.itemKey` (sólo sin variantes); `facts.variantOptions[].itemKey` + `ref{productId, variantId}`; FBT `items[].productKey` | `itemKey` a nivel producto |
| `GET …/items/{itemKey}/context` | `found`: `itemKey`, `ref`, `parentProduct.productKey`, `variant.variantId`; `variant_required`: `itemKey` + `productKey`; `not_found`: `itemKey` | una variante elegida por el owner |

- `P{id}` de un producto con variantes **no es** un itemKey: el item context responde
  `variant_required`. `P{id}-V{x}` de un producto sin variantes, o de otro producto, es `not_found`.
- R4 trata ambas claves como opacas (sólo exige forma segura de transporte). No las parsea, no
  deriva una de otra: sólo usa como itemKey lo que el owner nombró como `sellableItem` o variante.
- Tests contra regresión: owner `tests/contract/catalogV2Fixtures.contract.test.ts` (6 tests de
  identidad: ningún `itemKey` en búsqueda ni a nivel producto, `variant_required`, `not_found` para
  claves cruzadas); R4 `tests/contract/catalog-http-contract.test.ts` (la forma pre-J1C con `itemKey`
  a nivel producto y FBT se **rechaza**, no se reinterpreta); integración real (§7).

---

## 4. Convergencia de fixtures (una sola fuente)

- **Owner:** `catalog-service/contracts/catalog/v2/fixtures/`. Cada fixture wire (24: 20 respuestas
  200 + 400/401/429/503) es la salida exacta del `CatalogContractService` o de la app HTTP reales
  para un escenario declarado en `tests/support/catalogV2FixtureScenarios.ts`. El test de contrato
  del owner falla si una fixture difiere del servicio y las regenera con `CATALOG_V2_WRITE_FIXTURES=1`.
- **Manifest:** `MANIFEST.json` — contrato `catalog-commercial-v2`, `schemaVersion: 1`, por fixture
  endpoint + status + `sha256(JSON.stringify(JSON.parse(file)))` (independiente de CRLF/LF).
- **R4:** se borraron las 20 fixtures temporales de J1B. `scripts/sync-catalog-fixtures.mjs` copia
  byte a byte los archivos del manifest, verifica cada hash, borra cualquier otra fixture y escribe
  `SOURCE.json`:

  | Campo | Valor |
  |---|---|
  | owner | `MS-pesaschile-catalog-service` |
  | ownerCommit | `4fd891f40eea9c13f3438ba489ea13642123129e` |
  | ownerContractFilesUncommitted | **`true`** (los cambios J1C del owner no están commiteados) |
  | schemaVersion | 1 |
  | manifestSha256 | `a5e04913946d47434bdc8d185a63704aab8a21520f44164d9081cf3180bfb7aa` |
  | fixtures | 24 |

- El test de contrato de R4 verifica los hashes contra el manifest del owner y que no exista ningún
  archivo fuera de él. **Pendiente:** tras commitear el owner, re-sincronizar para que `SOURCE.json`
  apunte a ese commit con `ownerContractFilesUncommitted: false` (blocker §12).

### Evolución aditiva (verificada)

| Caso | Resultado | Evidencia |
|---|---|---|
| `schemaVersion` ∉ {1} (2, 0, `"1"`, ausente, null) | `contract_violation/unsupported_schema_version`, antes de parsear | contract test |
| campo conocido **ausente** o **mal tipado** | rechazo, sin default ni coerción — probado para **cada path** de 6 fixtures | contract test (barrido de paths) |
| campo desconocido en **cada objeto** de cada fixture | tolerado y descartado | contract test (20 fixtures) |
| invariante violada (identidad, completitud, precios, sellability/reason, frescura, cotas) | rechazo | 30+ mutaciones |

---

## 5. AG-J1B-01 — resultado y ADR-030

**Pregunta:** ¿puede una observation quedar clasificada como fresh después del `owner.validUntil`?

**Sí (pre-J1C).** Recorrido exacto:

1. `packages/capability-runtime/src/invoker.ts`: `validUntil = observedAt + definition.freshnessTtlMs`
   (Sales: 5 min), sin mirar el payload.
2. `packages/context-compiler/src/sources/platform.ts` (`observationSource`): pasa
   `o.validUntil` como `validUntil` del ítem.
3. `packages/context-compiler/src/freshness.ts` (`classifyFreshness`): `fresh` mientras
   `now < validUntil`.
4. catalog-service declara `validUntil = asOf + 15 s`.
5. Sales (`workspace/context-source.ts`, `evaluations/claims.ts`) usaba el mínimo — pero el
   contexto compilado (lo que ve el agente) presentaba la evidencia como `fresh` ~4 min 45 s después
   del vencimiento declarado por el owner. Una observación reutilizada en runs posteriores heredaba
   el mismo `validUntil` inflado.

**ADR-030 — Owner-bounded capability freshness** (`docs/adr/ADR-030-owner-bounded-capability-freshness.md`),
aceptado dentro de J1C por autorización del encargo §5:

```
effectiveValidUntil = min(runtimeValidUntil, ownerValidUntil)   (sobre los no nulos)
```

Mecanismo genérico: `CapabilityRegistration.ownerValidUntil?(output)`; el invoker valida el valor
(`timestampSchema`), sólo puede acortar, lo persiste en `Observation.validUntil` y lo audita en
`provenance.freshness {runtimeValidUntil, ownerValidUntil, bound}`. Sin cambios en `Observation`,
`CapabilityDefinition` (huellas intactas), ContextCompiler, Kernel, Policy, writes ni migraciones
(C2/D intactos). Sales declara `catalogOwnerValidUntil` en `catalog.search` y
`catalog.get_product_context`. El TTL de 5 min queda como cota propia de R4, no como frescura.

| Caso | Resultado | Test |
|---|---|---|
| owner antes | `validUntil = owner`, `bound: owner` | `owner-freshness.test.ts`; `catalog-capabilities.test.ts` (fixture real del owner) |
| runtime antes | se mantiene el de R4 (el owner nunca extiende) | ídem |
| owner `null` (p. ej. `not_found`) | rige R4 | ídem |
| runtime `null` | rige el owner; ambos null ⇒ sin cota | `owner-freshness.test.ts` |
| payload del owner ya vencido | se registra vencido ⇒ `expired` (histórico) desde el primer compile | ídem |
| observación reutilizada (mismo `invocationId`) | devuelve la registrada; no recalcula ni extiende | ídem |
| cota inválida / extractor lanza | `failed/invalid_capability_output`, nada inventado | ídem |
| contra el servicio real | `validUntil ≤ observedAt + 15 s`, `bound: owner` | integración real |

**Consecuencia a decidir (OD-3):** con 15 s, la evidencia de catálogo pasa a histórica entre turnos
de conversación y el agente debe releer para afirmar precio/stock vigentes. Es lo que el owner
declara hoy; si se quiere una ventana conversacional mayor, la decide el owner — no un TTL de R4.

---

## 6. Auditoría R4 business-repair

Método: seguir cada ruta de ejecución que toca datos de Catalog, no sólo el test estático.

| Ruta (alcanzable en producción v2) | Qué hace con datos del owner |
|---|---|
| `HttpCatalogAdapter` | transporte, validación, clasificación; única transformación: quitar `schemaVersion` (test: la salida es exactamente la respuesta del owner menos campos no usados) |
| `catalogSearchView` / `productContextView` (Sales) | selección de campos en el orden del owner; `catalogOwnerValidUntil` sólo lee `freshness.validUntil` |
| `sales.workspace.update` | `getItemContext(key, 1)` → sólo mira `status` (`not_found` ⇒ desconocido; `variant_required` ⇒ rechazo sin escritura) |
| `workspace/context-source.ts` | indexa qué observación respalda cada clave nombrada por el owner; vigencia = mínimo de cotas |
| `CapabilityInvoker` | cota temporal (ADR-030); no toca el payload |
| instrucciones del agente (`sales.agent.json`) | "Quote prices and stock only from current observations"; claves del owner, nunca SKU; "desde"; FBT ≠ compatibilidad |

| Prohibido | Resultado |
|---|---|
| price math / tax math | **PASS** — ninguna aritmética sobre montos; `lineFinalGross` eliminado del contrato R4 |
| stock math | **PASS** — `availableQuantity` no llega al modelo; no se suma ni compara |
| dedupe | **PASS** — duplicados ⇒ `contract_violation` |
| ranking | **PASS** — orden del owner (test explícito sobre `search-zero-stock-visible`) |
| visibility / backorder interpretation | **PASS** — sellability/reason verbatim |
| variant inference | **PASS** — `variant_required` ⇒ rechazo; nunca `isDefault` |
| SKU identity conversion | **PASS** — un SKU como clave ⇒ `unknown_product` |
| same_order → compatibility | **PASS** — FBT sólo co-compra; el verificador nunca funda compatibilidad |
| fabricated Catalog freshness | **PASS** — el adapter no tiene reloj; la cota de R4 ya no puede extender la del owner (ADR-030) |

Cálculos que sí existen, fuera de la ruta productiva: `FixtureCatalog` (stand-in del owner:
deriva sellability/precio como el owner, alineado en J1C a sus reglas reales: búsqueda sin
inactivos/no listados, "desde" sobre todas las variantes con precio, vocabulario de `match`) y los
fixtures de Quote (precio × cantidad es del owner Quote). La producción no los importa
(`live-ops-boundaries.test.ts`).

**Resultado: PASS.**

---

## 7. Integración HTTP real (local, sin producción)

Montaje: catalog-service J1A+J1C compilado, 4 procesos reales (`node dist/src/server.js`) contra un
MariaDB 11.4 desechable con un subconjunto sintético del esquema PrestaShop (nombres de columnas
reales; sin datos productivos; usuario sólo `SELECT`). Kit: catalog-service
`scripts/local-contract-db/`. Test: R4 `tests/integration/catalog-http-real.test.ts` (opt-in por
variables `R4_CATALOG_IT_*`; sin ellas se omite).

| Instancia | Variante | Cubre |
|---|---|---|
| :4011 | normal | respuestas |
| :4012 | `RATE_LIMIT_MAX=3` | 429 |
| :4013 | puerto de DB cerrado | 503 |
| :4014 | DB que acepta TCP y nunca responde | timeout |

**Resultado: 12/12 PASS** (verbose: `search` 42 ms … `timeout` 513 ms).

| Aspecto | Verificado contra el servicio real |
|---|---|
| auth | `x-api-key` enviado; clave incorrecta ⇒ `unauthorized` (no reintentable) |
| correlation ID | enviado y devuelto por el owner en `x-correlation-id` |
| URL encoding | path exacto `/v2/catalog/items/P20-V7/context?quantity=2`; clave admitida por R4 pero no por el owner ⇒ 400 del owner ⇒ `validation` |
| timeout | DB colgada ⇒ `timeout/deadline_exceeded` a los ~500 ms |
| esquemas de éxito | cada respuesta real (search, 8 product, 8 item) valida contra el esquema R4 |
| not_found / variant_required | `P999`, `P444` (excluido por política), `P10-V7`, `P20-V99` ⇒ `not_found`; `P20` ⇒ `variant_required` |
| 400 / 401 / 429 / 503 | `invalid_request` / `unauthorized` / `rate_limited` (reintentable) / `catalog_source_unavailable` (reintentable) |
| ruta inesperada | 404 ⇒ `contract_violation/unexpected_status` |
| respuesta malformada | inyector de fallas explícito delante del servicio real (trunca el cuerpo) ⇒ `unparseable_response` |
| semántica | stock neto de reservas (4, no físico 6); cero stock visible; backorder; `stock_unknown`; promoción ilimitada aplicada (119 000 → 107 100); LIKE `%`/`_` literales; inactivos/no listados/excluidos fuera de búsqueda |
| ADR-030 | observación de `catalog.get_product_context` acotada por el owner (`bound: owner`) |

Sonda "antes" (J1A sin cambios, misma base): search, product context e item context ⇒ **500
`CATALOG_QUERY_FAILED`** (`Unknown column 'fv.custom_value'`; error de sintaxis en `ESCAPE '\'`).

---

## 8. Tests — ambos repos

Ejecutado desde `E:` (mayúscula). Baseline = antes de J1C en el mismo equipo.

### R4-agent-platform

| Gate | Baseline | J1C | Nuevos fallos |
|---|---|---|---|
| build | PASS | PASS | — |
| typecheck | PASS | PASS | — |
| lint (`--max-warnings=0`) | PASS | PASS | — (4 hallazgos propios de J1C corregidos) |
| unit | 836/836 | **854/854** | — |
| contract | 213/213 | **229/229** | — |
| integration | 324/324 | 323/324 + 12 skipped (catalog real, opt-in) | 0 — ver nota |
| integration catalog real (opt-in, 4 instancias vivas) | n/a | **12/12** | — |
| sales | 29/29 | 29/29 | — |
| shadow | 5/5 | 5/5 | — |
| recovery | 16/16 | 16/16 | — |

Nota: el único fallo de la corrida completa fue `tests/integration/run-failure-recovery.test.ts`
("a governed write before the invalid output…", timeout de 20,7 s bajo carga). Es un test
conocido por ser sensible a tiempos en este equipo; **re-ejecutado aislado: 17/17 PASS**. No toca
Catalog. Clasificado como flaky pre-existente, no como fallo nuevo.

### MS-pesaschile-catalog-service

| Gate | Baseline | J1C | Nuevos fallos |
|---|---|---|---|
| build / typecheck | PASS | PASS | — |
| lint (archivos afectados) | — | PASS | — |
| lint (repo) | 7 errores | 7 errores | 0 — los mismos 7, en archivos no tocados (semantic/training classification) |
| tests J1A/J1C v2 + contract | — | 181/181 (incl. 8 nuevos de fixtures/identidad, 3 de SQL) | — |
| suite completa (`--no-file-parallelism`) | 2296 pass / 12 fail | **2304 pass / 12 fail** | 0 — los mismos 12: training-semantics HTTP, requieren el snapshot ignorado por git `data/training-semantic-snapshots/v2` |


---

## 9. UNKNOWN productivos — consultas READ-ONLY preparadas

Archivo: catalog-service `docs/audits/r4-j1c-production-unknowns.sql`. Sólo `SELECT`/`SHOW`,
dentro de `START TRANSACTION READ ONLY`; agregados, sin datos personales. Validado sintácticamente
contra la base local (los únicos errores son tablas/columnas que el subconjunto sintético no tiene).
**No ejecutado:** requiere autorización y acceso productivo.

| ID | Bloqueante | Pregunta |
|---|---|---|
| B1 | **Sí** | ¿existen en producción todas las columnas que usa el lector v2? (J1C encontró una inexistente) + versión PS |
| B2 | **Sí** | distribución de `id_tax_rules_group` en productos vendibles |
| B3 | **Sí** | tasa efectiva por grupo (país del contexto público), `PS_TAX`, redondeo |
| B4 | **Sí** | `reduction_type`/`reduction_tax`, overrides de precio, alcance (cliente/grupo/país/combinación/tramo), fechas cero |
| B5 | **Sí** | empates potenciales de specific prices en contexto público + `PS_SPECIFIC_PRICE_PRIORITIES` |
| B6 | **Sí** | `PS_ORDER_OUT_OF_STOCK`, `PS_STOCK_MANAGEMENT`, distribución de `out_of_stock` con stock ≤ 0, vendibles sin fila de stock |
| B7 | **Sí** (nuevo) | zona horaria: PS guarda hora local; el pool lee como UTC ⇒ bordes de promoción y `validUntil` |
| B8 | **Sí** (nuevo) | cotas del contrato vs datos reales: combinaciones por producto (≤100), atributos (≤10), features (≤40), nombres vacíos/largos |
| D1 | No | collation de columnas buscadas; `sql_mode` |
| D2 | No | `ps_accessory` |
| D3 | No | `ps_pack` / packs activos |
| D4 | No | multi-shop, `depends_on_stock`, `ps_warehouse` |
| D5 | No | evidencia de regeneración de combinaciones (líneas de pedido con combinación inexistente) |
| D6 | No | exclusiones (444, 505) y otros productos internos candidatos |
| D7 | No | OD-1: productos cuya variante más barata no tiene stock |
| D8 | No | patrón de URL pública |
| D9 | No | topología de rate limit (config de despliegue, no SQL) |

---

## 10. Perfil v2

`agents/sales/src/production/profile-v2.ts` — **candidato, no habilitado.**

- `SALES_PRODUCTION_PROFILE_V2_CANDIDATE` (`sales-production@2`): idéntico a v1 salvo Catalog
  `REAL` con `contractRef` al contrato convergido. Pasa `assertProductionProfile`.
- `SALES_PRODUCTION_V2_CATALOG_BINDING`: binding HTTP (`HttpCatalogAdapter`), endpoints, env
  requerido (`R4_CATALOG_BASE_URL`, `R4_CATALOG_API_KEY`, `R4_CATALOG_TIMEOUT_MS`), autoridad
  read-only (capabilities al modelo: `catalog.search`, `catalog.get_product_context`; interna:
  `getItemContext`; writes: ninguna), timeouts (adapter configurable, capability 10 s), semántica de
  frescura (owner 15 s, cota R4 5 min, ADR-030) y fallas.
- `SALES_PRODUCTION_PROFILE_V2_GATE`: 5 condiciones bloqueantes, todas abiertas (§12).
- **v1 intacto:** huella `bd30523f…d313` fijada por test; composición, bootstrap y control sólo
  aceptan `sales-production@1` (test: componer con `@2` falla; ningún archivo de composición
  referencia v2).

---

## 11. Archivos modificados

### R4-agent-platform

| Archivo | Cambio |
|---|---|
| `adapters/domains/src/catalog/port.ts` | puerto con la forma del owner (claves + `ref`, `status`, `tax`, `promotion`, `sourceUpdatedAt` en provenance, sin `lineFinalGross`) |
| `adapters/domains/catalog/http/src/schemas.ts` | esquemas wire = contrato del owner (nombres, cotas), sin defaults, invariantes |
| `adapters/domains/catalog/http/src/adapter.ts` | eco de clave sobre `productKey`/`itemKey`; cantidad 1–99 |
| `adapters/domains/catalog/http/fixtures/*` | 20 fixtures R4 **eliminadas**; 24 copias del owner + `MANIFEST.json` + `SOURCE.json`; README |
| `adapters/domains/src/catalog/fixture.ts`, `fixture-data.ts` | stand-in del owner alineado a la forma y reglas reales |
| `agents/sales/src/capabilities/catalog.ts` | vistas sobre el puerto nuevo; `facts.status`; `ownerValidUntil` (ADR-030) |
| `agents/sales/src/evaluations/catalog.ts`, `claims.ts` | vocabulario del owner (`status`, `exact_reference`) |
| `agents/sales/src/production/profile-v2.ts` (nuevo), `index.ts` | perfil v2 candidato |
| `packages/capability-runtime/src/registry.ts`, `invoker.ts` | ADR-030 |
| `docs/adr/ADR-030-owner-bounded-capability-freshness.md` (nuevo) | ADR |
| `scripts/sync-catalog-fixtures.mjs` (nuevo) | sincronización verificable de fixtures del owner |
| `tests/contract/catalog-http-contract.test.ts`, `tests/support/catalog-contract.ts` | contrato contra fixtures del owner |
| `tests/contract/sales-profile-v2.test.ts` (nuevo) | perfil v2 / v1 intacto |
| `tests/unit/capability-runtime/owner-freshness.test.ts` (nuevo) | ADR-030 |
| `tests/integration/catalog-http-real.test.ts` (nuevo) | integración HTTP real (opt-in) |
| `tests/unit/catalog-http/adapter.test.ts`, `tests/unit/sales/catalog-capabilities.test.ts`, `tests/unit/sales/domain-fixtures.test.ts` | a fixtures del owner / forma convergida |
| `docs/architecture/R4-J1C_CATALOG_CONTRACT_CONVERGENCE.md` (nuevo) | este documento |

### MS-pesaschile-catalog-service

| Archivo | Cambio |
|---|---|
| `src/domain/catalog/v2/contracts.ts` | identidad congelada, `sellableItem`, `ref` en variantes, `priceSummary`/`sellableVariants` de producto, `variant_required`, cotas |
| `src/application/catalog/v2/catalogContractService.ts` | implementación de lo anterior; rama muerta eliminada |
| `src/infrastructure/catalog/mysqlCatalogV2DataReader.ts` | sin `fv.custom_value`; escape LIKE `!`; fechas cero ⇒ NULL; nombres de feature recortados |
| `src/interfaces/http/routes/catalogV2Routes.ts` | validación de salida (`contract_output_invalid`) |
| `src/interfaces/http/app.ts` | errores v2 en minúsculas con `retryable` |
| `contracts/catalog/v2/fixtures/*` | 24 fixtures generadas + `MANIFEST.json`; `upstream-unavailable.json` reemplazada |
| `contracts/catalog/v2/schemas/catalog-v2.schema.json`, `README.md` | referencia actualizada |
| `tests/contract/catalogV2Fixtures.contract.test.ts`, `tests/support/catalogV2FixtureScenarios.ts` (nuevos) | fixtures generadas/verificadas + identidad |
| `tests/unit/mysqlCatalogV2DataReader.test.ts` (nuevo) | regresiones SQL |
| `tests/unit/catalogV2ContractService.test.ts`, `tests/http/catalogV2Endpoint.test.ts` | forma convergida |
| `tests/contract/catalogV2.contract.test.ts` | eliminado (subsumido) |
| `scripts/local-contract-db/` (nuevo) | base local sintética + instrucciones |
| `docs/audits/r4-j1c-production-unknowns.sql` (nuevo) | consultas read-only |
| `docs/architecture/R4-J1A_CATALOG_REMEDIATION.md` | sección "J1C outcome" |

---

## 12. Blockers restantes para live read-only

1. **Commit/deploy del owner** de los cambios J1C y re-sincronización de fixtures en R4 desde ese
   commit (`SOURCE.json`: `ownerContractFilesUncommitted: false`).
2. **UNKNOWN bloqueantes B1–B8** respondidos con las consultas preparadas (autorización requerida).
   B1, B7 y B8 son nuevos de J1C; B1 existe porque J1A ya traía una columna inexistente.
3. **Decisiones del owner:**
   - **OD-1** precio "desde": hoy es el mínimo sobre todas las variantes con precio, incluidas sin
     stock (en la base local: "desde $119.000" cuando la única variante vendible cuesta $130.900).
   - **OD-2** `promotion.discountValue` de tipo `amount` es el `reduction` crudo de PrestaShop, cuya
     base (neta/bruta) depende de `reduction_tax`: no es mostrable tal cual. No lo expone R4 en J1;
     debe resolverse antes de J3.
   - **OD-3** ventana de frescura: 15 s (caché) hace histórica la evidencia entre turnos (§5).
4. **Smoke read-only autorizado** de los tres endpoints contra el catalog-service desplegado con la
   clave de R4 (conectividad, TLS, auth, latencia real, rate limit compartido).
5. **Autorización explícita** para componer el perfil v2 (y, por separado, para declarar J1 CLOSED).

No bloqueantes registrados: FBT no cableado en el bootstrap productivo del owner (siempre
`unavailable`); `publicUrl` a verificar (D8); diagnósticos D1–D9.

---

## 13. Confirmación

**R4 consumes Catalog commercial truth without repairing Catalog semantics.**

R4-J1 **no** se declara CLOSED. No hubo despliegue, conexión productiva, mutación de datos, commit
ni push.
