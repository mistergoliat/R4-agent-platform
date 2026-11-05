---
title: R4 — Integración de Catalog V2 (CAT-R4-1 a CAT-R4-3)
status: R4_CATALOG_V2_INTEGRATION_READY_FOR_REVIEW — integración técnica lista; sin cutover, sin despliegue, producción sin cambios
mandate: «R4 — Catalog V2 Integration» (owner, 2026-11-05), frente R4_CATALOG_V2_INTEGRATION
date: 2026-11-05
base: main 6962ae7
source: CAT_V2_R4_J45_HANDOFF.md (Catalog, CAT-V2-PROD-R3, commit 03f66e5 de la rama docs/cv2-prod-r3, sobre main 5f2c086)
---

# R4 — Integración de Catalog V2

## 0. Resultado

| # | Entregable | Resultado |
|---|---|---|
| 1 | Auditoría del adaptador actual | §2. **R4 ya habla el contrato que sirve V2.** No hace falta un adaptador nuevo |
| 2 | Diseño mínimo | §3. Un adaptador, dos fuentes de configuración, selección explícita y sólo en el canary |
| 3 | Implementación | §4. Unas 80 líneas de código de runtime; producción no cambia |
| 4 | Pruebas de contrato consumidor | §5.1. Todos los fixtures del owner pasan por la fuente V2; se fija qué se conserva y qué se descarta |
| 5 | Exactitud comercial | §5.2. Precio, promoción, variantes, cantidad, cobertura parcial, deshabilitados, inexistentes, errores, caída y frescura |
| 6 | Matriz V1/V2 | §6, con los campos que R4 descarta |
| 7 | Aislamiento y rollback | §7 |
| 8 | Gates para el cutover | §10 |
| — | Discover (CAT-R4-3) | §8. Evaluación preparada; criterios solicitados a Catalog (#55); **sin consumo** |
| — | Seguridad | §9 |

**Lo que no se hizo:**

- sin despliegue ni cambios en EC2;
- `@3` y su binding sin cambios;
- sin cutover;
- sin cambios en el kernel, Catalog, Quote ni Checkout;
- sin definiciones nuevas;
- sin llamadas a modelos;
- sin tráfico hacia V2.

## 1. Contrato de integración (confirmado contra la definición vigente)

**Fuente.**

- `CAT_V2_R4_J45_HANDOFF.md` de CAT-V2-PROD-R3 (2026-11-05, `R4_J45_HANDOFF=READY`). Actualiza a
  `discover-contract/CAT_V2_R4_J4_5_HANDOFF.md` (CLOSEOUT-R1), que sigue siendo la referencia del contrato de Discover.
- El handoff está en la rama `docs/cv2-prod-r3` del repositorio de Catalog (commit `03f66e5`) y describe `main`
  `5f2c086`, el código desplegado (`8a72c38`, mismo runtime).
- Donde el handoff y el código difieren, manda el código. Por eso se verificó contra el código y los fixtures de
  `5f2c086`, extraídos en sólo lectura.

| Aspecto | Valor vigente | Verificación de R4 |
|---|---|---|
| Endpoints | `POST /v2/catalog/search`, `GET /v2/catalog/products/{productKey}/context`, `GET /v2/catalog/items/{itemKey}/context?quantity=1..99`; Discover en `POST /v2/catalog/discover`; salud en `/health/*` | Son las mismas tres rutas que el adaptador ya llama. Una prueba fija que no llama a ninguna otra, Discover incluido |
| Base URL | `http://127.0.0.1:4011`, sólo loopback. R4 debe correr en la misma EC2 | Dentro de la regla existente: loopback sin red habilitada; cualquier otra URL exige https y red explícita |
| Autenticación | `x-api-key` estático; 401 sin clave o con clave desconocida; 403 en Discover con una clave que no está en su lista | El adaptador envía `x-api-key`. 401 y 403 → `unauthorized`, fail closed, sin reintento |
| Credenciales R4 | Clave general y clave Discover propias de R4 (huellas registradas en el handoff de Catalog), entregadas en un archivo 600 en la EC2 | R4 usa sólo la general. La de Discover no se lee (§9) |
| Esquemas | `catalogSearchResponseSchema`, `productContextResponseSchema` e `itemContextResponseSchema` en `src/domain/catalog/v2/contracts.ts`; `schemaVersion: 1` | **Sin cambios** entre `d9c63cc` (la copia de R4) y `5f2c086`: el diff de `contracts/catalog/v2` y de `contracts.ts` es vacío. Los 26 fixtures de R4 coinciden por hash con el manifiesto del owner en `5f2c086` |
| Errores | Formato `{ error: { code, message, correlationId, retryable? } }`; tabla del handoff §8; `not_found` en contextos = HTTP 200 con datos | Mapeo §5.2: 400 → `validation`; 401/403 → `unauthorized`; 429/5xx → `temporarily_unavailable`; 404 u otro estado → `contract_violation`; `not_found` → datos |
| Stock | `sellable`, `backorder`, `not_sellable`, `check_with_staff` y motivos cerrados. En el ítem: `requestedQuantity` y `stockCoverage` (`full`, `partial`, `none`, `unknown`). Los packs siguen la regla de PrestaShop | El esquema de R4 ya los admite (F2-1) y verifica su coherencia. Una cobertura parcial nunca es vendible por la cantidad completa (§5.2) |
| Precio | Para cotizar se usa el contexto del ítem: `finalGross`, `regularGross`, `promotion`, `tax`. El precio del producto es un resumen (`from`) | Sin pérdida en el ítem (§5.1) |
| Frescura | `freshness.asOf` y `validUntil` (~15 s); no se cachea más allá de `validUntil` | Se conservan tal cual. R4 no cachea respuestas de Catalog |
| Discover | Disponible (`READY`). Calidad `NOT_ACCEPTED`; contrato preparado, no publicado | **No se consume** (§8) |
| Límites | 6000 peticiones / 60 s; búsqueda falla cerrada sobre 5000 candidatos; timeout recomendado 5 s | `R4_CATALOG_V2_TIMEOUT_MS` en 100..10 000 (se acepta 5000). Timeout de la capacidad: 10 s |
| Versionado | `schemaVersion` es la compuerta de cable. `contractVersion` es linaje y no se ramifica por él | El adaptador rechaza cualquier `schemaVersion` ≠ 1 como `contract_violation` |
| Reintentos | Como máximo 2, sólo si `retryable` o hay `Retry-After` | R4 no reintenta en el adaptador: un intento por lectura. Es más conservador que el máximo del handoff (§9) |

## 2. Auditoría del adaptador actual

- **Ubicación:**
  - `adapters/domains/catalog/http`: `HttpCatalogAdapter`, configuración, esquemas Zod y fixtures copiados del
    owner;
  - puerto `CatalogPort` en `adapters/domains/src/catalog/port.ts`.
- **Contrato que habla:** `catalog-commercial-v2`, `schemaVersion 1`, sobre las tres rutas `/v2/catalog/*`. Es
  exactamente el contrato que sirve Catalog V2 en el 4011. Hoy apunta al proceso del 4010 («V1» en el handoff) porque
  `R4_CATALOG_BASE_URL` lo dice.
- **Dónde se construye:**
  - `agents/sales/src/cli/production.ts`: el worker productivo, perfiles con Catalog `REAL`, `@3` incluido;
  - `agents/sales/src/cli/canary/command.ts`: el canary aislado.

  Ambos usaban `loadCatalogHttpConfig(env)` con `R4_CATALOG_*`.
- **Propiedades que se mantienen:**
  - sólo transporta: no calcula precios ni disponibilidad, no elige variantes y no repara respuestas;
  - fail closed ante configuración incompleta;
  - telemetría sin claves ni cuerpos;
  - verificación de clave y cantidad devueltas;
  - límite de tamaño de respuesta.
- **Hallazgo:** los esquemas usan `z.object` no estricto, así que un campo que R4 no declara se descarta en silencio.
  Las pruebas del §5.1 ahora lo hacen visible: se fija la lista exacta de campos descartados.

## 3. Diseño mínimo

- **Un solo adaptador.** V2 sirve el mismo contrato, así que no se crea un segundo mecanismo de descubrimiento ni un
  adaptador paralelo.
- **Dos fuentes de configuración del mismo contrato,** con variables propias para que convivan en un entorno:
  - `v1`: `R4_CATALOG_*`. Es lo que lee producción y el valor por defecto;
  - `v2`: `R4_CATALOG_V2_BASE_URL`, `R4_CATALOG_V2_API_KEY` y `R4_CATALOG_V2_TIMEOUT_MS` (G-1 del handoff: no se
    reutiliza `R4_CATALOG_BASE_URL`).
- **Selección explícita y sólo en el canary:** `R4_CANARY_CATALOG_SOURCE = v1 | v2`.
  - Sin la variable, `v1`: los canaries existentes no cambian.
  - El canary F1 (`@12`) exige `v2`: el futuro canary comercial ya no depende técnicamente de V1.
- **Sin fallback:**
  - una fuente elegida lee sólo sus variables; si falta una de V2, se rechaza aunque V1 esté completa;
  - una caída de V2 es una falla de la lectura, nunca una respuesta de V1.
- **Producción no lee nada nuevo.** El CLI productivo sigue llamando `loadCatalogHttpConfig(env)` sin fuente. El
  cutover no se puede hacer por configuración: exige un cambio revisado (§10).

## 4. Implementación

| Archivo | Cambio |
|---|---|
| `adapters/domains/catalog/http/src/config.ts` | Tipo `CatalogSource`, `CATALOG_V2_ENV` y `catalogEnvOf`. `loadCatalogHttpConfig(env, { allowNetwork, source })` lee sólo las variables de la fuente; los mensajes nombran sus variables. En `v1` devuelve exactamente la forma anterior. `describeCatalogHttpConfig` agrega `source` sólo para `v2`: la descripción de producción queda idéntica |
| `adapters/domains/catalog/http/src/adapter.ts` | El error 401/403 nombra la variable de clave de la fuente (`R4_CATALOG_API_KEY` o `R4_CATALOG_V2_API_KEY`) |
| `agents/sales/src/cli/canary/command.ts` | `canaryCatalogSource` (`R4_CANARY_CATALOG_SOURCE`; `@12` sólo `v2`) y `canaryCatalogConfig`. Los bindings reales del canary los usan y registran la fuente (sin secretos) |

**Sin cambios:**

- `production.ts` y los perfiles;
- el puerto, los esquemas y las capacidades de Sales;
- el kernel y los fixtures.

## 5. Pruebas

### 5.1 Contrato consumidor (`tests/unit/catalog-http/catalog-v2.test.ts`, A y B)

- **Configuración (A):**
  - V2 lee sólo `R4_CATALOG_V2_*`;
  - si falta una variable de V2, se rechaza aunque V1 esté completa;
  - el valor por defecto sigue siendo V1, con su forma exacta;
  - las reglas fail-closed nombran las variables de V2;
  - las descripciones no contienen la clave;
  - las llamadas van a la URL de V2 con la clave de V2;
  - el adaptador sólo usa las tres rutas, nunca Discover.
- **Qué conserva y qué descarta (B):** cada fixture de respuesta del manifiesto del owner pasa por el adaptador con la
  fuente V2.
  - **Contextos de ítem y búsqueda:** **sin pérdida** (iguales al fixture menos `schemaVersion`).
  - **Contexto de producto:** descarta exactamente los cinco caminos documentados en el §6.2. La prueba fija esa
    lista: si el owner agrega un campo, la prueba falla y obliga a decidir.

### 5.2 Exactitud comercial (C, con los casos del owner)

| Caso | Fixture del owner | Qué se verifica |
|---|---|---|
| Precio | `item-simple` | `finalGross` y `regularGross` 119 000, IVA incluido 0,19, para la cantidad pedida |
| Promoción | `item-promotion` | Tipo, `percentOff` 0,1, `validUntil` y `finalGross` 107 100 tal como los da el owner; R4 no recalcula |
| Precio no disponible | `item-pricing-unavailable` | Queda `unavailable` con su motivo; no se inventa un precio |
| Variantes | `item-variant`, `item-variant-required` | Identidad de la variante (`P20-V7`, SKU); un producto que exige variante → `variant_required` |
| Cantidades | `item-promotion` | La cantidad viaja en la URL; una respuesta para otra cantidad → `contract_violation` |
| Cobertura parcial | `item-insufficient-stock`, `…-backorder` | Se conservan `requestedQuantity` 5 y `stockCoverage: partial`; `catalogShortStock` = 4; nunca vendible por 5 |
| Stock desconocido / cero | `item-stock-unknown`, `item-not-sellable` | `check_with_staff` con cobertura `unknown`; `not_sellable` con cobertura `none` |
| Deshabilitados | `product-inactive`, `product-not-listed` | `found`, con su estado y `not_sellable` (`inactive` o `not_listed`); no es «no encontrado» |
| Inexistentes | `item-not-found`, `product-not-found` | HTTP 200 `not_found` es un dato, no un error |
| Errores del proveedor | `error-*` (estado HTTP del manifiesto) | 503 `catalog_source_unavailable` y 429 → `temporarily_unavailable`; 401 → `unauthorized`, nombrando la clave V2; 400 → `validation`. **Nunca** se leen como «no encontrado» ni como «sin stock» |
| Caída de V2 | — | Inalcanzable → `catalog_unreachable`; plazo vencido → `timeout`; sin fallback |
| Frescura | `item-simple` | `asOf`, `validUntil` y `cache` intactos |

**Casos autorizados.** Son los fixtures que el owner genera desde su servicio real (`catalog-commercial-v2`, 26
archivos, manifiesto con hash). Los SKUs de producción para F1 se pidieron en Catalog #54.

### 5.3 Aislamiento (`tests/unit/sales/catalog-v2-isolation.test.ts`)

- **Selección del canary:** sin la variable, `v1` para `@7`; `v2` es opcional.
- **Canary F1:** `@12` rechaza la ausencia de selección y `v1`; con `v2` toma la URL y la clave de V2 aunque V1 esté
  configurada.
- **Sin fallback:** con `v2` y variables de V2 incompletas, se rechaza aunque V1 esté completa.
- **Valores:** se rechazan los valores desconocidos.
- **Producción:**
  - ningún archivo de Sales fuera del CLI del canary lee `R4_CATALOG_V2_*` ni `R4_CANARY_CATALOG_SOURCE`;
  - todas las llamadas de configuración de Catalog del CLI productivo usan la fuente por defecto.

### 5.4 Mutaciones focalizadas (8/8 detectadas)

| Mutación | Resultado |
|---|---|
| V2 recurre a las variables de V1 si falta una | Detectada |
| La fuente por defecto pasa a `v2` | Detectada |
| `@12` acepta V1 | Detectada |
| El canary pasa a `v2` por defecto | Detectada |
| El esquema del ítem pierde `stockCoverage` | Detectada |
| Un 5xx se convierte en `not_found` | Detectada |
| El CLI productivo selecciona `v2` | Detectada |
| La descripción expone la clave | Detectada |

### 5.5 L2 proporcional y lo no ejecutado

Resultados en el §11.

**`NOT_RUN`:**

- **Integración real contra V2:** sólo escucha en el loopback de la EC2, y la ejecución en EC2 no está autorizada.
  - La conectividad desde el runtime de R4 con las claves de R4 la verificó Catalog: 20/20 (handoff §10).
  - La prueba real existente (`catalog-http-real`) es opcional y apunta a una instancia sintética: no es comparable
    con producción.
- **L3.**
- **Campañas de modelo:** no autorizadas.

## 6. Matriz de diferencias V1/V2

### 6.1 Servicio

| Aspecto | V1 (`127.0.0.1:4010`) | V2 (`127.0.0.1:4011`) | Efecto en R4 |
|---|---|---|---|
| Contrato de lectura | `catalog-commercial-v2`, `schemaVersion 1` | El mismo (sin cambios en `contracts/catalog/v2` hasta `5f2c086`) | Mismo adaptador y mismos esquemas |
| Variables R4 | `R4_CATALOG_*` (producción: timeout 2500 ms) | `R4_CATALOG_V2_*` (handoff: timeout 5000 ms) | Conviven; selección explícita |
| Credencial | Clave R4 de V1 | Clave general propia de R4; clave Discover separada | La clave de Discover no se usa |
| Base de datos | No verificado en este mandato | Base productiva de la tienda, cuenta de sólo lectura compartida con V1 (excepción de permisos RDS registrada por Catalog) | Precio y stock de producción |
| Paridad con la tienda | No medida aquí | 156/156 (precio, stock y vendibilidad; packs 59/59), según Catalog | Evidencia para P-1; la evidencia por SKU es Catalog #54 |
| Cobertura parcial (`requestedQuantity`, `stockCoverage`) | Opcional en el esquema de R4. No se verificó si el 4010 la envía | Presente (motor `catalog-commercial-v2.3.0`) | Admitida y verificada por R4 |
| Enlace público (`derived.publicUrl`) | Mantiene el prefijo `/categories/` hasta su propio despliegue (CAT-V2-PROD-R2) | Enlaces productivos de `https://pesaschile.cl` (PROD-R2) | R4 lo conserva tal cual |
| Discover | No | Sí (`READY`; calidad `NOT_ACCEPTED`) | No se consume |
| Límite de tasa | No verificado | 6000 / 60 s por proceso | — |
| Rutas alcanzables con la clave R4 | — | Las claves no tienen alcance por ruta: también `/v1/products/*` y `/metrics`, todas de lectura | R4 sólo llama a las tres rutas (prueba §5.1) |

### 6.2 Campos de V2 que R4 descarta

Medido pasando todos los fixtures del owner por el adaptador, y contrastado con `contracts.ts` de `5f2c086`.

| Respuesta | Campo | Qué es | Por qué no afecta a una cotización |
|---|---|---|---|
| Contexto de producto | `facts.stock.availableQuantity`, `facts.stock.scope` (`variant` o `product_total`) | Stock resumen del producto | Se cotiza con el contexto del ítem, que conserva el stock de esa unidad y cantidad |
| Contexto de producto | `derived.availability.leadTime` | Siempre `null` en el contrato | No tiene contenido |
| Contexto de producto | `facts.variantOptions[].isDefault` | Variante por defecto de PrestaShop | R4 nunca elige una variante por el cliente |
| Contexto de ítem | — | — | **Ninguno** |
| Búsqueda | — | — | **Ninguno** |

Además, las capacidades de Sales proyectan estas respuestas en observaciones para el modelo. Esa proyección no
cambia con esta integración.

## 7. Aislamiento y rollback

**Impacto sobre `sales-production@3`: ninguno.**

- Producción construye Catalog sólo con `R4_CATALOG_*` y nunca lee la selección del canary ni las variables de V2. Lo
  verifican las pruebas de aislamiento y la mutación de selección productiva.
- No cambian los perfiles, el binding productivo, `production.ts` ni la descripción del plan productivo.

**Mecanismo de prueba aislado.** Reutiliza el canary existente, con base propia verificada por
`assertIsolatedCanaryDatabase`, canal sintético y salida capturada:

1. en el archivo de entorno **del canary** (no en el productivo), agregar `R4_CANARY_CATALOG_SOURCE=v2` y las tres
   `R4_CATALOG_V2_*`, copiadas del archivo de entrega de Catalog a un mecanismo de secretos de R4 (archivo 600, fuera
   de Git);
2. `sales:canary run` registra `canary catalog binding` con `source: v2` y `baseHost: 127.0.0.1:4011`, sin la clave;
3. `@12` no arranca sin V2;
4. **requiere autorización de EC2,** que no existe en este mandato.

**Rollback:**

- **Canary:** quitar `R4_CANARY_CATALOG_SOURCE` (vuelve a `v1`; no aplica a `@12`) o detener el canary, y quitar las
  variables V2.
- **Código:** revertir el PR. El valor por defecto nunca cambió, así que la reversión no afecta a producción.
- **Producción:** sin nada que revertir.

## 8. Discover (CAT-R4-3): evaluación preparada, no ejecutada

**Estado:**

- Discover está `READY`, pero su calidad está `NOT_ACCEPTED` y su contrato no está publicado (niveles 2 y 4 del
  handoff).
- R4 no lo consume y no declara aceptada su calidad.
- No se modifica ranking, ontología ni proyecciones.

**Dimensiones separadas de la evaluación:**

| Dimensión | Pregunta | Medición | Responsable |
|---|---|---|---|
| Relevancia del resultado | ¿Los resultados sirven a la necesidad? | Etiquetas humanas sobre necesidades autorizadas | Catalog (evaluación independiente) |
| Exactitud de identidad | ¿`productKey`/`itemKey` corresponden al producto descrito? | Contraste con el contexto de producto | R4 (determinista) |
| Exactitud de atributos | ¿Los atributos citados coinciden con el catálogo? | Contraste con `facts` del contexto | R4 (determinista) + revisión humana |
| Información comercial | ¿Precio, stock y vendibilidad coinciden con el contexto del ítem? `EXPIRED` o `UNKNOWN` nunca como vendible | Contraste con el contexto de ítem en el mismo instante | R4 (determinista) |
| Interpretación del agente | ¿El modelo usa Discover sin inferir disponibilidad de lo no verificado? | Campaña de modelo con etiquetas humanas | R4, con mandato y presupuesto propios |

**Pasos previos al consumo:**

1. criterios y evidencia de aceptación humana independiente de Catalog — **solicitado en Catalog #55**;
2. contrato publicado (nivel 2);
3. un contrato consumidor en R4 con los fixtures del owner (24 respuestas y 12 errores);
4. una decisión de diseño sobre cómo entraría Discover sin duplicar `catalog.search`.

## 9. Seguridad

| Punto | Estado |
|---|---|
| Credencial específica de R4 | Sí: clave general propia de V2, distinta de la de V1 (handoff §3). La clave de Discover no se lee: `CATALOG_V2_ENV` no la incluye |
| Sólo lectura | Las tres rutas que usa R4 son lecturas y el servicio no tiene rutas que escriban. La clave alcanza otras rutas de lectura (`/v1/products/*`, `/metrics`) porque no tiene alcance por ruta. **Riesgo residual de Catalog**, documentado por su owner |
| Gestión del secreto | La clave nunca entra al repositorio. Se recibe en un archivo 600 en la EC2 y R4 la carga desde el entorno del canary. Un archivo de secretos de R4 por proceso (canary separado de producción) es un gate del §10 |
| Exposición en logs | La telemetría (`CatalogCallTelemetry`) no tiene clave ni cuerpo. `describeCatalogHttpConfig` sólo dice `apiKeyConfigured` (mutación detectada). Los errores nombran la variable, nunca el valor |
| Métricas | R4 no exporta métricas con la clave y no llama a `/metrics` de Catalog |
| Timeouts | El plazo por llamada es configurable entre 100 y 10 000 ms (se recomiendan 5000), por debajo del timeout de 10 s de la capacidad |
| Errores | Clasificación cerrada (§5.2): un error nunca es «sin stock» ni «no encontrado» |
| Caída de V2 | `catalog_unreachable` o `timeout`; la lectura falla y la capacidad informa la falla |
| Reintentos | Ninguno en el adaptador. Un 429 o 503 informa `temporarily_unavailable`. Honrar `Retry-After` (máximo 2) es una mejora opcional, no un requisito de corrección |
| Fallback silencioso a V1 | **No existe** (pruebas §5.1/§5.3, mutación de fallback detectada) |

## 10. Gates pendientes para el cutover

| Gate | Responsable | Estado |
|---|---|---|
| Revisión y merge de este PR | Owner R4 | Pendiente |
| Verificación real desde el canary en la EC2: `R4_CANARY_CATALOG_SOURCE=v2`, lecturas de SKUs autorizados, sin tráfico comercial | Owner R4 (autorización de EC2) | No autorizado |
| Secretos de V2 en un archivo de R4 por proceso, nunca en el entorno productivo antes del cutover | Owner R4 | Pendiente |
| Evidencia de paridad por SKU (P-1) y SKUs autorizables | Catalog #54 | `PENDING` |
| Calidad de Discover (sólo si R4 va a consumirlo) | Catalog #55, PR #31 | `NOT_ACCEPTED` |
| Excepción de permisos RDS (cuenta de lectura amplia, compartida con V1) | Owner Catalog | Registrada, temporal |
| Claves con alcance por ruta (riesgo residual) | Owner Catalog | Aceptado por ahora; requiere un cambio de código de Catalog |
| Cambio de código revisado para que producción elija V2 (hoy bloqueado por diseño y por prueba) | Owner R4 | No iniciado |
| L2 completa y L3 sobre los SHA exactos antes del cutover | Owner R4 | Pendiente |
| Ventana de cutover y plan de vuelta atrás del binding productivo | Owner | No autorizado |
| Quote (R1.7, despliegue coordinado, vigencia de 60 min): **no bloquea esta integración técnica**, sí el canary F1 | Quote #32 | `PENDING` |

## 11. Validación

Ejecutada en la copia de trabajo con `npm ci` y build propios, sobre el árbol de este PR.

| Etapa | Resultado |
|---|---|
| Build (`tsc -b`) | OK |
| Typecheck | 0 errores. La primera corrida encontró 1 error de tipos en la prueba nueva; se corrigió y se repitió |
| Lint | 0 |
| Unit | **1631/1631** (4 skip), con las 22 pruebas nuevas de V2 y las 6 de aislamiento |
| Contrato | **487/487** |
| Integración seleccionada (`sales-canary`, `production-bootstrap`, `production-control`, `catalog-http-real`) | **61/61**. Se omiten 12: `catalog-http-real` es opcional y no hay instancia (§5.5) |
| Mutaciones focalizadas (§5.4) | **8/8** detectadas |
| Suite de mutación `canary-j4` (el diff toca el CLI del canary) | **13/13** detectadas, fuentes restauradas |

**`NOT_RUN` (`R4_TEST_STRATEGY_02`):**

- integración completa (fuera del alcance: sólo cambian la configuración de Catalog y el CLI del canary);
- shadow y recovery;
- las demás suites de mutación;
- integración real contra V2 (EC2 no autorizada);
- L3;
- campañas de modelo.
