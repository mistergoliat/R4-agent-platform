# R4 / Catalog V2 — Auditoría y diseño de corrección de vigencia de evidencia

- **Estado:** `DESIGN_REVISION_1_READY_FOR_REVIEW`.
- **Revisión 1 (2026-11-10):** incorpora las condiciones de la aprobación del owner, la inspección de solo lectura de Catalog (D-5) y el experimento local (D-6).
- **Aprobado:** alternativa D, condicionalmente y solo en el pack Sales de R4. Sin cambios en Catalog, R4 Core, Quote V2, Checkout ni perfiles productivos.
- **Autorizado hasta ahora:** documentación, inspección de solo lectura y experimento local. **No autorizado:** despliegue ni activación productiva. La implementación espera la aceptación de esta revisión.
- **Código auditado:** R4 `main` @ `788f1f9`; Catalog `main` @ `5f2c086`.
- **Autoridad:** Constitución > PRD > ADR-030 (vigencia acotada por el owner) > este documento.

## 0. Conclusión

1. **R4 puede resolverlo sin tocar Catalog.** La causa no es el valor 15 s. R4 lee un producto por llamada al modelo y cada respuesta de Catalog es una observación con una sola vigencia.
2. **Fase 1 (bajo el contrato actual):** `catalog.get_commercial_state@1`. Confirma precio y vendibilidad de hasta 8 ítems detrás de una sola llamada del modelo. Cada resultado conserva el `validUntil` que declaró Catalog. Nada recibe una vigencia distinta de la del owner.
3. **Fase 2 (bloqueada por D-1):** `catalog.get_product_facts@1`, datos descriptivos reutilizables. R4 no le asigna ninguna vigencia propia: la ventana y las condiciones de invalidación las define el owner de Catalog. Sin su aprobación no se implementa.
4. **Subir la ventana (alternativa A) sigue descartada:** en Catalog la caché y la vigencia comercial son el mismo número, verificado en código y en la instancia desplegada.
5. **Experimento local (sección 9):** con la capability de la fase 1 la conversación media baja de 131 s a 95 s y la mediana de 76 s a 59 s. Confirmar precios de varios productos converge siempre: 25 lecturas de set, todas vigentes. **No resuelve** el turno en que el cliente pregunta qué más se suele llevar: sigue leyendo un producto por llamada y tardó 274 s en una de tres réplicas.
6. **Dos hallazgos que condicionan la implementación:** la fase 1 sola no garantiza que el set Home Gym converja, y la tasa de respuestas del modelo rechazadas por formato subió a 5 de 170 pasos (hoy: 0 de 209). Ambos deben resolverse antes de cualquier uso en QA.

## 1. Diagnóstico contractual

### 1.1 Dónde se definen y aplican los 15 segundos

| Hecho | Evidencia (Catalog @ `5f2c086`) |
|---|---|
| El valor es un default de constructor: `freshnessTtlSeconds ?? 15` | `src/application/catalog/v2/catalogContractService.ts:123` |
| Nunca se cablea a configuración: el bootstrap no pasa `freshnessTtlSeconds` | `src/bootstrap.ts:177-181` |
| Fórmula (OD-3): `validUntil = min(asOf + TTL, primer cambio de precio programado)` | `catalogContractService.ts:617-629` |
| Prueba del owner: la vigencia nunca se alarga | `tests/unit/catalogV2J1D.test.ts:155-184` |
| Documentado como decisión del owner OD-3, «ventana de frescura (15 s)» | `docs/architecture/R4-J1A_CATALOG_REMEDIATION.md:228` |

### 1.2 Endpoints y campos que usan la ventana

Los tres endpoints del contrato comercial v2 comparten el mismo `freshness { asOf, cache { hit, ageMs }, validUntil }` (`src/interfaces/http/routes/catalogV2Routes.ts:108`, `:145`, `:189`):

- `POST /v2/catalog/search`
- `GET /v2/catalog/products/{productKey}/context`
- `GET /v2/catalog/items/{itemKey}/context`

Un único `validUntil` cubre la respuesta completa. El contrato no distingue campos descriptivos de campos comerciales.

Consumidor interno: Discover hidrata con `CatalogContractService.getProductContexts` y hereda la misma ventana (`src/application/catalog/discover-v0/commercialHydrator.ts:38-68`; estado `EXPIRED` en `discover-v1a/responseMapper.ts:117-118`).

### 1.3 Relación entre `validUntil`, TTL de caché, timestamps y datos comerciales

- **`asOf`** es el instante en que Catalog leyó PrestaShop. No es el instante de la respuesta.
- **Caché ≡ vigencia.** Cada entrada expira exactamente en su `validUntil` (`catalogContractService.ts:635-640`). No existe un TTL de caché separado. Este es el acoplamiento que hace insegura la alternativa A.
- **`provenance.sourceUpdatedAt`** es siempre `null` (`catalogContractService.ts:608-615`): Catalog no publica cuándo cambió el registro de origen. Hoy no hay base para que R4 detecte por sí mismo un cambio descriptivo.

### 1.4 Qué almacena la caché

Respuestas de lectura ya construidas (el objeto wire completo), no datos normalizados ni datos de proveedor. Es un `Map` en memoria de hasta 500 entradas por proceso (`boundedTtlCache.ts`, `CATALOG_V2_CACHE_MAX_ENTRIES`), con claves `catalog-v2:search:…`, `catalog-v2:product:{key}:{qty}` y `catalog-v2:item:{key}:{qty}`.

### 1.5 ¿Una lectura desde caché puede extender la vigencia aparente?

**No, en ninguno de los dos lados.**

- Catalog: un acierto de caché recalcula `freshness` con el `asOf` original y el `validUntil` ya almacenado; solo cambian `cache.hit` y `cache.ageMs` (`catalogContractService.ts:642-649`). Probado en `catalogV2J1D.test.ts:168-183` y observado en la instancia desplegada (sección 1.9).
- R4: la observación registra `min(observedAt + cota de R4, validUntil del owner)` una sola vez y es idempotente por `invocationId` (`packages/capability-runtime/src/invoker.ts:85-101`, ADR-030).

Una salvedad menor: una respuesta `not_found` no lleva `freshness`, por lo que R4 la conserva hasta su propia cota de 5 minutos (`agents/sales/src/capabilities/catalog.ts:188-190`).

### 1.6 Cómo recibe y valida R4 estas evidencias

| Paso | Comportamiento | Evidencia (R4 @ `788f1f9`) |
|---|---|---|
| Validación wire | Esquemas no estrictos: un campo adicional del owner se tolera y se descarta; `validUntil < asOf` se rechaza | `adapters/domains/catalog/http/src/schemas.ts:14-15`, `:48-56` |
| Cota de R4 | 5 minutos; solo puede acortarse por la del owner | `agents/sales/src/capabilities/catalog.ts:16`; `packages/capability-runtime/src/registry.ts:31-38` |
| Vigencia registrada | `min(cota R4, validUntil del owner)` → en la práctica, 15 s | `invoker.ts:94-101` |
| Clasificación | `now ≥ validUntil` ⇒ `expired` | `packages/context-compiler/src/freshness.ts:16-29` |
| Destino de lo expirado | Pasa a la sección `history` (o se excluye, según `R4_CONTEXT_EXPIRED_EVIDENCE`) | `packages/context-compiler/src/compiler.ts:326-330`; `apps/worker/src/config.ts:41` |
| Regla del kernel | «Items in the history section are expired: … never as current state» | `packages/agent-kernel/src/request.ts:38` |
| Regla de Sales | «Quote prices and stock only from current observations; if … expired …, read it again» | `agents/sales/candidates/sales.v19.candidate.json` |
| Emisión | `quote.preview` y `quote.create` releen el ítem en Catalog y bloquean con `catalog_evidence_stale` / `catalog_evidence_unbounded` | `agents/sales/src/capabilities/commercial-snapshot.ts:149`, `:168-171`, `:190-193`; `quote-v2.ts:234-241` |

**Por qué el set no converge.** Cada lectura es una llamada al modelo de varios segundos y una observación propia. Con tres o más productos leídos en secuencia, la primera lectura ya superó los 15 s cuando llega la última; pasa a `history` y la definición obliga a releerla.

**Brecha de pruebas.** El catálogo fixture declara 5 minutos de vigencia (`adapters/domains/src/catalog/fixture-data.ts:230`), sin opción para cambiarlo. Las suites locales nunca reproducen el comportamiento de 15 s.

### 1.7 ¿Existe lectura multiproducto?

- **En Catalog, sí, pero no por HTTP.** `getProductContexts` resuelve hasta 100 claves con una sola lectura SQL (`catalogContractService.ts:291-343`, `CATALOG_V2_BATCH_MAX_KEYS`). Solo lo usa Discover; ninguna ruta lo expone.
- **En R4, no para el modelo.** `CatalogPort` tiene `search`, `getProductContext` y `getItemContext` (`adapters/domains/src/catalog/port.ts:315-320`). Existe el patrón equivalente dentro de una capability: `catalog.get_product_context@2` lee el producto y cada variante en paralelo y registra la vigencia más temprana (`catalog.ts:174-185`).

### 1.8 Consumidores que dependen del contrato actual

Ver la matriz de la sección 2. Solo R4 y Discover (interno de Catalog) consumen `CatalogContractService`. Quote V2, Checkout, CRM y el módulo PrestaShop no dependen de esta ventana.

### 1.9 Verificación en la instancia desplegada (D-5, solo lectura)

Inspección autorizada, realizada el 2026-11-11 UTC. No se hizo ningún cambio operativo. No se imprimió ni se copió ninguna credencial: las seis lecturas de prueba usaron en memoria la credencial de consumidor que R4 ya tiene.

| Verificación | Resultado |
|---|---|
| Build de la instancia V2 | `8a72c38`. Sus directorios `src/` y `contracts/` son idénticos a `main` (`5f2c086`); la diferencia entre ambos commits es un script operativo y su prueba |
| Ventana efectiva | `validUntil − asOf` = 15 000 ms exactos, en contexto de producto y de ítem |
| Acierto de caché | Una relectura inmediata responde `cache.hit: true` con el mismo `asOf` y el mismo `validUntil`; solo crece `ageMs` |
| Expiración de caché | Pasada la ventana, la lectura siguiente es nueva (`hit: false`, `asOf` nuevo) |
| Clave de caché | Incluye la cantidad: el mismo ítem con otra cantidad es una lectura distinta |
| Caché | En memoria, por proceso |
| Límite de tasa, instancia V2 | Configurado explícitamente, muy por encima del default del código. Una lectura de 8 ítems consume una fracción despreciable. El contador es compartido por todos los llamadores locales |
| Límite de tasa, instancia V1 | Default del código: 120 solicitudes por 60 s (`src/shared/config.ts:78-79`) |
| Latencia de una lectura no cacheada, medida en el host | Decenas de milisegundos |
| Qué instancia usa cada proceso de R4 | El worker estándar solo conoce la instancia V1. El worker del carril conoce ambas. El worker web QA solo conoce la V2 |

Consecuencias para el diseño:

- El riesgo de límite de tasa queda cerrado para la instancia V2 y **abierto para la V1**. La capability nueva solo se habilita en perfiles cuya fuente de Catalog es V2.
- Ocho lecturas con concurrencia 4 tardan una fracción de segundo. El costo de vigencia de leer un set es despreciable frente a los 15 s.

## 2. Matriz de impacto

| Consumidor / desarrollo | Qué usa | Depende de los 15 s | Impacto de A (ventana configurable) | Impacto de D en R4 (aprobada) |
|---|---|---|---|---|
| R4 Sales WhatsApp, perfiles `@17`–`@19` | `catalog.search`, `get_product_context@1/@2`, `catalog.discover` | Sí | Cambia la vigencia de toda su evidencia sin cambio de perfil | Ninguno: perfiles fijados, no optan |
| R4, emisión de cotización | `getItemContext` por línea en preview y en create | Sí: es la relectura que garantiza vigencia | **Regresión:** recibiría datos en caché de hasta la nueva ventana | Ninguno: ruta intacta |
| R4 Sales Web QA (sin commit, fuera de `main`) | `catalog.search`, `get_product_context`, `catalog.discover` | Sí: es el caso bloqueado | Desbloquea, con vigencia comercial artificial | Ninguno hasta que un perfil QA versionado opte |
| Catalog Discover (v0 / v1a / v1b1) | `getProductContexts`, estado `EXPIRED` | Sí | Altera la vida de sus observaciones comerciales | Ninguno |
| CAT-V2 (ramas `cv2-*` abiertas) | `catalogContractService.ts`, `contracts.ts`, lectores MySQL | — | Conflicto de merge posible | Ninguno: cero archivos de Catalog |
| QA1 / QA2 (cohortes de calidad de Discover) | Artefactos congelados y sus pruebas de aceptación | No | Ninguno directo | Ninguno |
| PRG (ramas `cat-prg-*`) | Taxonomía y grafo de relaciones | No | Ninguno directo | Ninguno |
| Quote V2 | No llama a Catalog por HTTP; lleva una copia vendorizada de la primitiva de precio PrestaShop (`src/application/quote-v2/cart/prestashop-price.ts`) | No | Ninguno | Ninguno |
| Checkout | Igual: primitiva vendorizada (`src/domain/pricing/prestashopPrice.ts`); TTL de enlace de pago propio | No | Ninguno | Ninguno |
| CRM-Customer-360 | `/api/v2/catalog/resolve-product-intent` (otro servicio de aplicación, con su propia caché) | No | Ninguno | Ninguno |
| Módulo `pc_r4chat` | Tarjetas y carrito calculados por PrestaShop | No | Ninguno | Ninguno |

## 3. Alternativas

| | A. Ventana configurable | B. Evidencia reutilizable separada de vigencia comercial | C. Validación multiproducto | D. B + C |
|---|---|---|---|---|
| **Latencia** | La mayor mejora medida | Evita relecturas descriptivas; no resuelve sola el set | Medida en la sección 9 | Fase 1 = C; fase 2 sin medir |
| **Consistencia comercial** | **Empeora:** precio y stock «vigentes» hasta N s; la emisión puede usar caché vieja | Intacta: lo comercial conserva la ventana del owner | Mejora: los ítems de un set se leen con milisegundos de diferencia | Intacta o mejor |
| **Compatibilidad** | Sin cambio de esquema, pero cambia el comportamiento de todos los consumidores a la vez | Aditiva y opt-in en R4 | Aditiva y opt-in en R4 | Igual que B y C |
| **Despliegue** | Catalog en producción (compartido con el carril WhatsApp activo) | Solo el perfil que opta | Solo el perfil que opta | Solo el perfil que opta |
| **Rollback** | Variable de entorno y reinicio de Catalog | Quitar la capability del perfil | Quitar la capability del perfil | Quitar la capability del perfil |

Descartadas sin más análisis:

- **Tratar como vigente toda observación del turno en curso (cambio en Core).** Haría que R4 declare vigentes datos comerciales expirados.
- **Subir la vigencia manteniendo la caché en 15 s.** Sigue otorgando vigencia comercial artificial.

## 4. Diseño aprobado y su secuencia

**D, íntegramente en el pack Sales de R4, en dos fases independientes.**

| Fase | Entrega | Contrato de Catalog | Estado |
|---|---|---|---|
| 1 | `catalog.get_commercial_state@1` | Actual, sin cambios. Toda vigencia es la del owner | Diseño revisado; implementación pendiente de aceptar esta revisión |
| 2 | `catalog.get_product_facts@1` | Requiere la política descriptiva aprobada por el owner de Catalog | Bloqueada por D-1. No se implementa antes |

Reglas que valen para ambas fases:

- **Independencia del canal web.** La rama de implementación sale de `main` y no contiene ni depende del código del web chat. No se mezclan ramas.
- **Sin perfil en la rama de la capability.** La capability queda inerte en `main`: ningún perfil existente la declara. La integración se hace después, con un perfil QA versionado, en su propio cambio.
- **Rollback = quitar la capability del perfil.** El registro en la composición es condicional a que el perfil la declare, igual que hoy con `shipping.quote` y `quote.preview` (`agents/sales/src/production/composition.ts:186`, `:214`).
- **Solo fuente V2.** La composición rechaza habilitarla en un perfil cuya fuente de Catalog sea V1 (sección 1.9).
- **Autoridades intactas.** Quote V2 conserva la verificación final; Checkout no cambia.

## 5. Contrato propuesto

### 5.1 Fase 1: `catalog.get_commercial_state@1`

`READ`, owner `catalog`, scope `catalog.read`. Construida sobre `CatalogPort.getItemContext`, que no cambia.

Entrada: `{ "items": [{ "key": "P1651", "quantity": 1 }, { "key": "P1675-V463", "quantity": 2 }] }`. De 1 a 8 ítems. `key` es un `itemKey`; para un producto sin variantes coincide con su `productKey`.

```json
{
  "coherence": "PER_ITEM_READ",
  "set": { "status": "incomplete", "validUntil": null, "notConfirmed": ["P9", "P7-V3"] },
  "items": [
    {
      "key": "P1651", "status": "found", "name": "Banco ajustable", "quantity": 1,
      "price": { "finalGross": { "amount": 129990, "currency": "CLP" }, "regularGross": { "amount": 129990, "currency": "CLP" } },
      "availability": { "sellability": "sellable", "reason": "in_stock" },
      "freshness": { "asOf": "2026-11-10T15:00:07.120Z", "validUntil": "2026-11-10T15:00:22.120Z", "cacheAgeMs": 0 }
    },
    {
      "key": "P1675-V463", "status": "found", "name": "Mancuerna hexagonal", "quantity": 2,
      "price": { "finalGross": { "amount": 9990, "currency": "CLP" }, "regularGross": { "amount": 9990, "currency": "CLP" } },
      "availability": { "sellability": "sellable", "reason": "in_stock" },
      "freshness": { "asOf": "2026-11-10T15:00:07.164Z", "validUntil": "2026-11-10T15:00:22.164Z", "cacheAgeMs": 0 }
    },
    { "key": "P1675", "status": "variant_required", "productKey": "P1675" },
    { "key": "P9", "status": "not_found" },
    { "key": "P7-V3", "status": "unreadable" }
  ]
}
```

Cómo cumple cada requisito de la aprobación:

| Requisito | Diseño |
|---|---|
| Agrupar las lecturas detrás de una sola llamada del modelo | Una invocación, una observación, hasta 8 ítems |
| Ejecución HTTP concurrente con concurrencia acotada | Lecturas independientes con un máximo de 4 en vuelo. El experimento confirmó el tope (sección 9). Ocho ítems son dos tandas |
| Preservar el `validUntil` original de cada resultado | Cada ítem lleva el `freshness` del owner, sin modificar: `asOf`, `validUntil`, antigüedad de caché |
| No declarar atomicidad | `coherence: "PER_ITEM_READ"`. Cada ítem conserva su propio `asOf`. La descripción de la capability lo dice al modelo |
| No entregar un set como vigente si un elemento está vencido o incompleto | `set.status` es `current` solo si todos los ítems se encontraron, tienen precio y están dentro de su vigencia al terminar la lectura. En otro caso es `incomplete` o `expired`, `set.validUntil` es `null` y `notConfirmed` nombra las claves |
| Elemento vencido | La vigencia de la observación es el `validUntil` más temprano. Si un elemento ya venció, la observación se registra vencida y entra directamente a `history` (ADR-030, regla 4). No hay forma de que el set figure como actual |
| Verificación y autoridad final de Quote V2 | Sin cambios. `quote.preview` y `quote.create` siguen releyendo cada línea. Esta observación nunca sustituye esa relectura |
| Checkout | Ningún archivo ni contrato de Checkout cambia |
| Rollback | Quitar la capability del perfil |

Otras reglas:

- **No calcula nada.** No entrega totales: los totales son de `quote.preview`, con la aritmética del owner de Quote.
- **Sin cantidades de stock**, igual que hoy.
- **`variant_required`** se devuelve tal como lo declara el owner y deja el set `incomplete`. No se elige una variante ni se sustituye por un precio «desde».
- **`unreadable`** significa que el owner falló para esa clave: desconocido, nunca «no vendible». Un fallo no anula los demás ítems.
- **`incomplete`:** los ítems encontrados siguen siendo evidencia válida de sí mismos hasta su propio `validUntil`. Lo que no existe es la confirmación del conjunto.
- **Respaldo determinista.** El evaluador de Sales gana un hallazgo para un set presentado al cliente a partir de una observación con `set.status` distinto de `current`.

### 5.2 Fase 2: `catalog.get_product_facts@1` (bloqueada por D-1)

Proyección descriptiva de `getProductContext` para hasta 6 productos: nombre, SKU, marca, categoría, especificaciones, opciones de variante con sus claves, texto de catálogo, URL pública y comprados juntos. Excluye precio, disponibilidad y estado.

**R4 no asigna ninguna vigencia a estos datos.** La versión anterior de este documento proponía reutilizar la cota de 5 minutos de R4; esa propuesta queda retirada. La capability no se implementa hasta que el owner de Catalog apruebe por escrito:

| # | Lo que debe definir el owner de Catalog |
|---|---|
| 1 | Qué campos son descriptivos y cuáles permanecen comerciales |
| 2 | La ventana de reutilización de los campos descriptivos |
| 3 | Las condiciones que la invalidan antes de tiempo: producto deshabilitado o eliminado, cambio de nombre o de especificaciones, cambio en el conjunto de variantes |
| 4 | Cómo detecta R4 esas condiciones |
| 5 | Si la política se declara por documento o en el contrato (campo aditivo) |

Opciones para el punto 4, a elegir por el owner:

- **Sin cambio en Catalog.** Toda lectura comercial de 15 s revalida: un `not_found` o un producto inactivo para una clave invalida sus datos descriptivos. No detecta ediciones de texto ni de especificaciones.
- **Con campo aditivo en Catalog.** El owner publica una versión descriptiva o `sourceUpdatedAt` (hoy siempre `null`) en cada respuesta. R4 compara ese valor en cada lectura comercial y descarta los datos descriptivos si cambió. Detecta cualquier edición.

Mientras D-1 esté abierta, los datos descriptivos siguen leyéndose con `catalog.get_product_context`, que caduca con la ventana del owner.

### 5.3 Flujo esperado en fase 1 para un set de 4 productos

1. `catalog.discover` o `catalog.search`: candidatos con sus claves.
2. `catalog.get_commercial_state` con los 4 ítems: una observación.
3. `respond`: el contexto se compila milisegundos después del paso 2, con los cuatro precios vigentes.

### 5.4 Lo que no cambia

`catalog.search`, `catalog.get_product_context@1/@2`, `catalog.discover`, `quote.preview`, `quote.create`, Checkout, el TTL de 15 minutos del enlace de pago, todos los perfiles y definiciones existentes.

## 6. Archivos a modificar (fase 1)

Rama de implementación propuesta: `feat/r4-catalog-commercial-state`, desde `main` actualizado. No creada.

**Nuevos**

| Archivo | Contenido |
|---|---|
| `agents/sales/src/capabilities/catalog-commercial-state.ts` | La capability, su esquema y la ejecución con concurrencia acotada |
| `docs/adr/ADR-047-catalog-commercial-state.md` | Decisión de la fase 1 (ADR-046 está reservado por el canal web, sin commit) |
| `tests/unit/sales/catalog-commercial-state.test.ts` | Unitarias |
| `tests/integration/sales-catalog-commercial-state.test.ts` | Escenarios con vigencia de 15 s y reloj controlado |

**Modificados**

| Archivo | Cambio |
|---|---|
| `agents/sales/src/ids.ts` | Un id de capability |
| `agents/sales/src/production/composition.ts` | Registro solo si el perfil la declara y su fuente de Catalog es V2 |
| `agents/sales/src/workspace/context-source.ts` | `catalogKeysOf` reconoce la observación nueva, ítem por ítem, cada uno con su vigencia |
| `agents/sales/src/evaluations/claims.ts` | Los precios de la observación nueva cuentan como evidencia, ítem por ítem |
| `agents/sales/src/evaluations/taxonomy.ts` | Dos hallazgos: precio afirmado con evidencia ya vencida; set presentado sin estado `current` |
| `adapters/domains/src/catalog/fixture.ts` | Opción `validityMs` (default sin cambio) para reproducir 15 s |
| `tests/contract/sales-boundaries.test.ts` | Fijar que ningún perfil existente declara la capability |

**Sin cambios:** `packages/*` (Core), `adapters/domains/catalog/http/*`, las capabilities, perfiles y definiciones existentes, Quote, Checkout, migraciones, el código del canal web. Repositorio de Catalog: ningún archivo.

**Fuera de esta rama:** el perfil QA versionado que opte, y toda la fase 2.

## 7. Plan de pruebas

Niveles según la estrategia de pruebas 02 (L0 unitaria, L1 contrato, L2 integración con fixture y reloj controlado, L3 modelo real en QA). Toda omisión se informa como `NOT_RUN`.

| # | Escenario | Prueba | Nivel | Fase |
|---|---|---|---|---|
| 1 | Reutilización de datos estáticos en el turno | Datos descriptivos vigentes mientras la evidencia comercial caduca; el esquema descriptivo rechaza campos comerciales | L0, L2 | 2 |
| 2 | Expiración comercial durante razonamiento prolongado | El reloj avanza 16 s tras la lectura: la observación pasa a `history`, el workspace marca cada ítem `current: false`, y el evaluador emite el hallazgo de precio con evidencia vencida | L2 | 1 |
| 3 | Cambio de precio entre descubrimiento y cotización | El fixture cambia el precio: la relectura devuelve el nuevo; `quote.preview` lo refleja; `quote.create` rechaza la oferta anterior | L2 | 1 |
| 4 | Agotamiento de stock | Stock a 0: el ítem responde `not_sellable`; el set no es `current`; preview bloqueado | L2 | 1 |
| 5 | Producto eliminado o deshabilitado | El ítem responde `not_found` o `not_sellable`; el set queda `incomplete` y la clave aparece en `notConfirmed` | L2 | 1 |
| 6 | Conjuntos de 3 a 5 productos | Lecturas de 3, 5 y 8 ítems: una observación. Nueve ítems: rechazo de argumentos | L0, L2 | 1 |
| 6a | Concurrencia acotada | Con 8 ítems nunca hay más de 4 lecturas en vuelo; el orden de salida es el de entrada | L0 | 1 |
| 6b | Vigencia por elemento | Cada ítem conserva el `validUntil` que envió el owner; la observación registra el más temprano | L0 | 1 |
| 6c | Elemento vencido | Un ítem ya vencido al terminar la lectura: `set.status: expired` y observación vencida desde el registro | L0, L2 | 1 |
| 6d | Elemento incompleto | Un ítem `unreadable`, `not_found`, `variant_required` o sin precio: `set.status: incomplete`, `set.validUntil: null`; los demás ítems se informan | L0 | 1 |
| 6e | Sin atomicidad declarada | La salida siempre lleva `coherence: PER_ITEM_READ` y un `asOf` por ítem; ningún campo agrega un instante común | L0 | 1 |
| 7 | Compatibilidad con consumidores anteriores | Listas de capabilities y hashes de definición de los perfiles existentes sin cambio; contrato HTTP de Catalog (26 fixtures por hash) sin cambio; diff vacío en `packages/` | L1 | 1 |
| 8 | Emisión de Quote V2 sin datos expirados | Regresión de `catalog_evidence_stale` en preview y en create. Con una observación de estado comercial vigente, `quote.create` sigue releyendo cada línea | L2 | 1 |
| 9 | Web chat sin cotizaciones falsas | En el perfil QA: sin capabilities de Quote, Checkout ni workspace; toda cifra de la respuesta aparece en una observación comercial; ningún número de cotización | L1, L3 | Integración posterior |
| 10 | Rollback | Un perfil que no declara la capability no la registra; un perfil con fuente V1 que la declara es rechazado al componer | L1 | 1 |

## 8. Despliegue y rollback

Nada de esta sección está autorizado todavía.

1. **Implementación de la fase 1** en la rama propuesta, con L0–L2. Queda inerte en `main`.
2. **Integración:** perfil QA versionado que declare la capability, en su propio cambio, cuando el canal web esté en `main`.
3. **Validación L3** en QA: set de 3 y de 5 productos.
4. **WhatsApp:** fuera de este alcance. Requiere candidato propio, evaluación de Sales y activación explícita.

**Rollback.** Quitar la capability del perfil, o volver al perfil anterior. No hay migración ni cambio en otros servicios que revertir.

**Verificación del rollback.** Un turno de humo muestra en sus observaciones solo los ids de capability anteriores. La prueba 10 garantiza que un perfil sin la declaración no la registra.

## 9. Experimento local (D-6)

### 9.1 Qué se ejecutó

- **Brazo nuevo `C15`:** las lecturas de producción de hoy más `catalog.get_commercial_state` tal como la define la sección 5.1, con la vigencia de 15 s del owner. La definición del agente recibe una sola frase adicional.
- **Mismos escenarios que el baseline:** tres guiones de cliente de cuatro turnos, tres réplicas cada uno, nueve conversaciones. Modelo real con el perfil de producción; catálogo, despacho y cotización fixture; base de datos desechable; reloj real.
- **Presupuesto:** tope de US$ 1,00 persistido en disco y verificado antes de cada llamada. Gasto contabilizado: **US$ 0,93** en 170 llamadas, sin llamadas fallidas. El corte no llegó a activarse. La contabilidad usa el precio punta sin descuento de caché, igual que el baseline, así que el gasto real es menor.
- **Baseline:** los brazos `A15` (hoy), `M15` (búsqueda y contexto de producto múltiples, 15 s) y `W300` (ventana de 300 s) no se volvieron a ejecutar; son las muestras del mismo día.

El script y las muestras quedan locales, sin commit.

### 9.2 Resultados

Promedio por conversación, salvo donde dice total (suma de las nueve conversaciones).

| Métrica | `A15` hoy | `M15` | `W300` | `C15` fase 1 |
|---|---|---|---|---|
| Duración media (s) | 131,4 | 90,5 | 68,6 | **95,1** |
| Duración mediana (s) | 75,6 | 65,9 | 60,4 | **59,3** |
| Costo (US$, precio punta) | 0,132 | 0,100 | 0,066 | **0,103** |
| Llamadas al modelo | 23,1 | 16,8 | 14,8 | **18,9** |
| Tokens de entrada (miles) | 387 | 296 | 194 | **299** |
| Lecturas de Catalog decididas por el modelo | 15,2 | 8,2 | 6,8 | **10,4** |
| Solicitudes HTTP equivalentes de esas lecturas | 15,2 | 25,1 | 6,8 | **16,2** |
| Solicitudes HTTP equivalentes, todos los llamadores | no registrado | no registrado | no registrado | **25,6** |
| Máximo de solicitudes en vuelo | no registrado | no registrado | no registrado | **4** |
| Lecturas de Catalog vencidas antes de terminar el turno (total) | 54 | 24 | 0 | **38** |
| Productos releídos en el mismo turno (total) | 24 | 13 | 0 | **31** |
| Llamadas al modelo fallidas (total) | 1 | 0 | 0 | **0** |
| Pasos rechazados por formato inválido (total / pasos) | 0 / 209 | 2 / 151 | 0 / 133 | **5 / 170** |
| Turnos que no terminan esperando al cliente (total) | 1 | 0 | 0 | **0** |
| Precios unitarios afirmados con evidencia vigente (total) | 96 | 104 | 97 | **112** |
| De esos, enviados después de vencer la evidencia (total) | 21 | 18 | 0 | **13** |
| Precios unitarios afirmados con evidencia vencida o sin lectura (total) | 0 | 2 | 0 | **0** |
| Lecturas de set: vigentes / incompletas / vencidas | — | — | — | **25 / 0 / 0** |

Duración media por guion (s):

| Guion | `A15` | `M15` | `W300` | `C15` |
|---|---|---|---|---|
| Cambio de selección (precios de varios productos) | 68,5 | 64,1 | 54,7 | **49,2** |
| Comparación de racks | 62,9 | 59,1 | 54,8 | **58,8** |
| Principiante (incluye «¿qué más se suele llevar?») | 262,9 | 148,4 | 96,4 | **177,3** |

Notas de método:

- «Solicitudes HTTP equivalentes» son llamadas al puerto de Catalog; en producción cada una es una solicitud HTTP. La fila «todos los llamadores» incluye las que hacen por dentro el workspace y el despacho; el baseline no las registró.
- «Vencidas antes de terminar el turno» y «enviados después de vencer» se derivan de las marcas de tiempo de las llamadas, con el mismo cálculo para los cuatro brazos.
- La calidad comercial se mide de forma determinista: cada precio unitario del catálogo que aparece en una respuesta se busca en las lecturas previas de esa conversación. No se verifican totales ni montos de despacho, y no hay juicio sobre la calidad de la respuesta.
- Son nueve conversaciones por brazo. Diferencias de pocos segundos no son concluyentes.

### 9.3 Lectura de los resultados

1. **Lo que la fase 1 resuelve.** La capability se usó en 19 de 36 turnos, con 2 a 5 ítems por lectura. Las 25 lecturas de set resultaron vigentes. El guion de precios de varios productos queda al nivel del mejor de los otros brazos, el de 300 s. Ningún precio se afirmó con evidencia vencida al compilar el contexto.
2. **Lo que no resuelve.** El turno «¿hay algo más que se suela llevar con eso?» es el turno lento en todos los brazos. En `C15` tardó 274 s y 33 llamadas en una réplica y 93 s en otra, alternando búsquedas y contextos de producto de a uno. Por eso `C15` relee más productos que hoy. Es el caso descriptivo: fase 2 (D-1).
3. **Formato inválido.** Cinco pasos rechazados como salida estructurada inválida, cuatro de ellos dentro de los dos pasos siguientes a una lectura comercial. La causa no está determinada: el experimento no conserva el texto rechazado. La implementación debe registrar la forma del rechazo y explicarlo antes de QA.
4. **R-3 medido.** Hoy 21 de 96 precios unitarios salen después de vencer la evidencia con que se compiló el contexto. Con la fase 1 son 13 de 112. El riesgo existe hoy y baja, pero no desaparece.
5. **Carga sobre Catalog.** La fase 1 no aumenta de forma apreciable las solicitudes que decide el modelo (16,2 frente a 15,2) y nunca superó 4 en vuelo.

### 9.4 Consecuencia para el diseño

- La fase 1 se justifica por sí sola para confirmar precios de un conjunto y no debilita ninguna garantía comercial.
- **No se puede prometer que el set Home Gym de Sales Web converja solo con la fase 1.** Armar un set combina elegir productos complementarios (caso descriptivo) y confirmar sus precios (caso comercial). El criterio de aceptación en QA debe medir ambos.
- La respuesta del owner de Catalog a D-1 pesa más de lo estimado: en las mediciones, lo único que redujo el turno lento fue poder reutilizar evidencia (`W300`), y ese brazo reutiliza también precios, de modo que no aísla el efecto de los datos descriptivos.
- Una opción intermedia que no requiere D-1 es leer varios contextos de producto en una llamada con la vigencia del owner (lo que midió `M15`): redujo el turno lento, sin eliminarlo. Queda registrada como D-8.

## 10. Riesgos residuales

| # | Riesgo | Estado y mitigación |
|---|---|---|
| R-1 | Límite de tasa de Catalog | **Cerrado para la instancia V2** (sección 1.9). Abierto para la V1: la capability solo se habilita con fuente V2 |
| R-2 | Sin atomicidad entre ítems | Declarado en el payload; la emisión relee |
| R-3 | La respuesta sale después de que venció la evidencia con que se compiló el contexto | Ya ocurre hoy y está medido en la sección 9. Ningún compromiso se toma de esa evidencia. Ver D-4 |
| R-4 | Datos descriptivos de un producto deshabilitado | Solo aplica a la fase 2; depende de las condiciones de invalidación de D-1 |
| R-5 | El modelo no usa la capability nueva, o la usa mal | Medido en la sección 9. Evaluación de Sales antes de cualquier uso productivo |
| R-6 | El canal web no está en `main` | Resuelto por secuencia: la capability no depende de él |
| R-7 | Build desplegado distinto del auditado | **Cerrado:** el código de la instancia V2 es idéntico al auditado |
| R-8 | La evidencia vencida sigue incluida como `history` y consume tokens | Sin cambio de política |
| R-9 | Las preguntas descriptivas sobre varios productos siguen leyéndose de a una y pueden no converger | **Abierto y medido** (sección 9.3). Depende de D-1 o de D-8 |
| R-10 | Más respuestas del modelo rechazadas por formato inválido con la capability nueva | **Abierto** (sección 9.3). Ver D-9 |

## 11. Estado de las decisiones

| # | Decisión | Estado |
|---|---|---|
| D-1 | Separar datos descriptivos de evidencia comercial | **Aprobada en concepto.** La política (ventana y condiciones de invalidación) queda **pendiente del owner de Catalog**; R4 no asigna vigencia propia. Mientras tanto se entrega solo la fase 1 |
| D-2 | Implementar D solo en R4, sin cambios en Catalog | **Aprobada** por la aprobación condicional: exclusivamente en el pack Sales |
| D-3 | Secuencia respecto del canal web | **Resuelta:** capability independiente del código web; integración posterior con un perfil QA versionado |
| D-4 | Aceptar R-3 o exigir una verificación determinista al responder | **Pendiente.** No fue tratada en la aprobación. Recomendación: aceptar en la fase 1 y medir con el hallazgo nuevo del evaluador; decidir con esos datos. Una verificación al responder es un cambio en Core y queda fuera de este alcance |
| D-5 | Inspección de solo lectura de Catalog | **Ejecutada** (sección 1.9) |
| D-6 | Brazo experimental local, tope de US$ 1,00 | **Ejecutada** (sección 9) |
| D-7 | Descartar la alternativa A mientras caché y vigencia sean el mismo número | **Pendiente de confirmación del owner de Catalog.** Del lado de R4 no se persigue: la aprobación excluye modificar Catalog. El acoplamiento quedó verificado en la instancia desplegada |
| D-8 | Nueva. Incluir en la fase 1 una lectura múltiple de contexto de producto con la vigencia del owner, para el caso descriptivo | **Pendiente del owner de R4.** Recomendación: esperar la respuesta a D-1; si se demora o se rechaza, incluirla. No otorga ninguna vigencia y no requiere a Catalog |
| D-9 | Nueva. Explicar los pasos rechazados por formato inválido antes de habilitar la capability en QA | **Pendiente del owner de R4.** Recomendación: condición de salida de la implementación |

## Anexo. Lo que no se verificó

- La fase 2 no está medida ni diseñada en detalle: depende de D-1.
- Origen exacto del tope de 16 llamadas al modelo observado en QA web: no localizado en `main`.
- Quote V2 y Checkout se revisaron en sus checkouts locales.
- El experimento usa el catálogo fixture y conversaciones sintéticas: mide convergencia y costo relativo, no latencia de producción.
