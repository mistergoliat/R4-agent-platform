# R4-J4-R2 — Adaptador HTTP de Customer Profile: informe de validación

| Campo | Valor |
|---|---|
| Fecha | 2026-10-16 |
| Autorización | OD-14: implementación provisional sintética de R4-J4-R2 (owner de R4) |
| Rama | `feat/r4-j4-customer-adapter-r2`, creada desde `origin/main` `e6105b0`. Sin merge a `main` |
| Contrato | `customer-profile.sales-context` v1, revisión v1-rc1, en CP `47db415` (tag `cp-sales-context-v1-rc1`). `contractStatus: candidate` |
| Alcance | Puerto, adaptador HTTP y bloques de la frontera C sin registrar. Sin harness, perfiles, definiciones, migraciones ni despliegue |
| **Dictamen** | **`R4_J4_R2_ADAPTER_IMPLEMENTED`** · **`R4_J4_R2_CONTRACT_VALIDATED`** (§5). Interoperabilidad HTTP **sintética y local** verificada (§8). **No** es E2E productiva |

Etiquetas: **GIT** = verificado en el repositorio · **TEST** = ejecutado en esta sesión · **DOC** = documentado, sin verificación propia.

## 1. Baseline Git

| Repositorio | Ref | SHA (GIT, tras `git fetch`) |
|---|---|---|
| R4 | `origin/main` (base) | `e6105b0d68457ebf860bbe41489819f0424824db` |
| R4 | Commit 1: implementación | `b858fe2dfa5ec96975c2422c13984f94240d203a` |
| R4 | Commit 2: pruebas | `15af63e` |
| R4 | Commit 3: este informe | Posterior a `15af63e`; se cita desde fuera |
| CP | Contrato v1-rc1 | `47db415e1ebf67b5e6770dbdcfc697880b6e5f76`, alcanzable desde `origin/main` (`3c1b776`) y `origin/feat/cp-j4-security-01-resilience-01` |
| CP | Tag `cp-sales-context-v1-rc1` | Objeto `0a5ac6718d3df4900afe86b732c00bf1e1421440` → `47db415`, local = remoto |
| CP | Productor sintético | `d84c9ea`, en `origin/feat/cp-j4-context-02c-synthetic` = `6801a90` (sin merge) |

- En R4 no se reutilizó ninguna rama J4 ya fusionada ni se reescribió historia.
- La entrada preexistente del stash de R4 (`local settings.json`) no se tocó.
- En CP no se modificó nada.

## 2. SHA del contrato y artefactos fijados

Los artefactos se copiaron con `git show 47db415:<ownerPath>`, desde el objeto Git del owner y no desde su working tree:

| Destino en R4 | Contenido |
|---|---|
| `adapters/domains/customer/http/contract/` | Los 2 JSON Schemas (respuesta y petición) y el `SOURCE.json` del owner (`owner-SOURCE.json`) |
| `adapters/domains/customer/http/fixtures/` | Los 34 fixtures y el `MANIFEST.json` |
| `adapters/domains/customer/http/contract/SOURCE.json` | Procedencia R4: `ownerCommit`, tag, refs remotas y, por cada uno de los 38 archivos, `ownerPath`, `gitBlob`, `sha256` (bytes LF) y `contentSha256` (regla del MANIFEST) |

Verificación (TEST, contrato):
- cada archivo recalcula su blob Git, su SHA-256 y su hash de contenido;
- el MANIFEST y el `SOURCE.json` del owner coinciden con las copias;
- en runtime, el adaptador rechaza cargar un schema cuyo hash difiera del fijado.

Los originales de CP no se modificaron.

## 3. Arquitectura implementada

```text
pack Sales (frontera C, sin registrar)          adapters/domains (puerto)        adapters/domains/customer/http
readCustomerContextV2 ─────► getSalesContext ───┐
                                                ├─► CustomerProfilePort ─► CustomerProfileHttpClient
readCustomerPurchaseHistoryV1 ► getPurchaseHistory ┘                         │
                                                                               ├─ antes de la red: namespace, grant (propósito, vigencia), página, 1 KiB
                                                                               ├─ POST /v1/capabilities/customer/sales-context (Bearer, sin grant: D2)
                                                                               ├─ deadline 3000–5000 ms, stream ≤ 64 KiB (cortado en el abort)
                                                                               └─ wire.ts: invariantes → proyección → schema fijado → semántica → puerto
```

**Puerto `CustomerProfilePort`** (`adapters/domains/src/customer/profile-port.ts`, nuevo; `port.ts` y `CustomerDirectory` no cambian):
- Una operación por propósito y ningún parámetro `purpose`: el propósito siempre lo fija la capacidad.
- Estados en uniones discriminadas, que no se pueden confundir:

| Estado del mandato | Representación |
|---|---|
| Contexto comercial | `getSalesContext` → `available` con `purchaseHistory` |
| Historial de compras | `getPurchaseHistory` → `available` con `items` |
| Ausencia de historial | `purchaseHistory: 'none'` / `items: []` |
| Información no divulgable | `withheld` (CP `not_applicable`; eliminada, guest e inactiva provisionalmente, AP-09) |
| Cliente no encontrado | `not_found` |
| Fallo temporal | `DomainError('temporarily_unavailable')` (429, 503, 504, 5xx, red, `history_unavailable`) o `timeout` |
| Error contractual | `DomainError('contract_violation')` |
| Acceso no autorizado | `DomainError('unauthorized')` (401/403) |

No se agregó ningún estado ni categoría (`DomainErrorCategory` sin cambios).

**Lector tolerante** (decisión del owner, §6):
1. **Invariantes sobre la respuesta original:**
   - campos prohibidos conocidos en cualquier nivel, aunque valgan `null`: montos, derivados, ids de PrestaShop, SKU, datos crudos de cuenta (`purpose_minimization_violated`), PII y predictivos (`sensitive_field_present`);
   - el componente del otro propósito;
   - `schemaVersion`, `contract`, namespace y eco de `customerRef`, y `purpose`.
2. **Proyección por allowlist:** solo sobreviven los campos que define v1-rc1. Los desconocidos se descartan y no se reenvían, persisten, registran ni usan en ninguna decisión.
3. **Schema fijado sobre la proyección** (Ajv 2020, con los mismos ajustes que el test del owner): tipos, enums, patrones y requeridos de los campos conocidos, estrictos.
4. **Semántica:**
   - coherencia entre HTTP y `status` (503 ⇔ `degraded`);
   - ciclo de vida: un `customer_grant_verified` que R4 nunca envió es `authorization_basis_incoherent`; `deprecated` se rechaza; el modo real exige `approved` y `customer_grant_verified`;
   - SR-01 y SR-09;
   - vigencia: TTL ≤ 15 min, `asOf` no futuro (margen de 5 min), hechos no vencidos al llegar;
   - página pedida, `returned` y orden.
5. **Mapeo al puerto:**
   - `lastPurchasedSourceDate` → `lastPurchasedOn`, con `datePrecision: day_timezone_unverified` mientras la zona no esté verificada;
   - unidades brutas; nombre `null` conservado; `catalogKey: null`; `lineKind` conservado para el filtro AP-10;
   - un historial no disponible es un fallo, nunca una lista parcial.

**Configuración** (`config.ts`):
- `R4_CUSTOMER_MODE=synthetic` es el único modo; `real` se **rechaza** (`customer_real_data_blocked`).
- URL https fuera de loopback y con `R4_PROD_ALLOW_NETWORK`; sin credenciales, query ni fragmento.
- Token de 43–512 caracteres.
- Timeout 3000–5000 ms. El presupuesto de CP (2500 ms) queda ≤ timeout − 500 ms.

**Frontera C** (`agents/sales/src/capabilities/customer-profile-outputs.ts`, **sin registrar**):
- entradas estrictas sin identificadores;
- salidas de `get_context@2` y `get_purchase_history@1` según la especificación §6;
- puerta de identidad: sin `verified`, 0 llamadas;
- filtro AP-10 (excluye `administrative_service` y kinds desconocidos; conserva `zero_price_line`);
- nombres de 120 code points como máximo, sin partir pares sustitutos;
- `validUntil = min(CP, grant)`;
- topes de 300 B y 8 KiB: si se exceden, la invocación falla, sin payload parcial.

## 4. Archivos

| Archivo | Cambio |
|---|---|
| `adapters/domains/src/customer/profile-port.ts` | **Nuevo.** Puerto, estados, grant y tipo de resolución de identidad (el resolver es J4-R3) |
| `adapters/domains/src/index.ts` | Exporta el puerto nuevo |
| `adapters/domains/customer/http/{package.json,tsconfig.json}` | **Nuevo** paquete `@r4-adapters/customer-http` |
| `adapters/domains/customer/http/src/{config,wire,client,index}.ts` | **Nuevos.** Configuración, reglas de cable y cliente |
| `adapters/domains/customer/http/contract/*`, `fixtures/*` | **Nuevos.** Artefactos del owner fijados y `SOURCE.json` de R4 |
| `agents/sales/src/capabilities/customer-profile-outputs.ts` | **Nuevo.** Frontera C, sin registrar |
| `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` | Workspace, referencias, paths y alias del paquete nuevo. Lockfile: +52 líneas (`ajv@8.20.0` con su integridad; ya estaba en el árbol vía fastify) |
| `tests/contract/customer-http-contract.test.ts` | **Nuevo.** Pruebas de contrato |
| `tests/contract/sales-boundaries.test.ts` | Allowlist de dependencias del paquete nuevo |
| `tests/unit/customer-profile/*` | **Nuevos.** Cliente, configuración, frontera C, interop opcional y soporte |

## 5. Validaciones y regresión (TEST)

| Suite | Tipo | Resultado |
|---|---|---|
| `tests/contract/customer-http-contract.test.ts` | **A. Contrato** (fixtures fijados en `47db415`) | **41/41**: procedencia, los 22 fixtures de respuesta → puerto y los 10 de error → categoría, fronteras del paquete |
| `tests/unit/customer-profile/http-client.test.ts` | **B, C, D.** Negativos, mapeo, auth, timeout y tamaño | **82/82** (tras las correcciones de lint, sin cambios de comportamiento) |
| `tests/unit/customer-profile/config.test.ts` | D. Configuración (fail-closed, modo real rechazado) | **10/10** |
| `tests/unit/customer-profile/outputs.test.ts` | C. Frontera C (puerta de identidad, propósito, AP-10, topes) | **29/29** |
| `tests/unit/customer-profile/cp-synthetic-interop.test.ts` | **F.** Integración HTTP opcional | 5/5 contra CP local (§8); se omite sin variables de entorno |
| Slice completo (unit + contract del slice, boundaries, core-purity) | — | **178 PASS**, 5 skip (interop) |
| **`npx vitest run --project unit --project contract`** | **G.** Regresión | **103 archivos, 1 516 PASS, 6 skip, 0 fallos** |
| `npm run typecheck`, `npm run lint`, `npm run build` | G | OK |
| `integration`, `sales`, `shadow` (PostgreSQL) | G | **NO EJECUTADAS:** Docker no respondía en esta máquina (`docker info` exit 255). Este slice no toca ningún código que esas suites ejerzan (§7), pero la regresión es parcial |

**Cobertura del §6 del mandato** (cada caso con test):
- 200 `available`, `not_found` y `not_applicable`; respuesta parcial (`unknown`); historial incompleto (`history_unavailable`); cuenta retenida (`withheld`);
- 400, 401, 403 (con scope y con `null`), 429, 503 (envelope válido, inválido y con PII), 504;
- error de transporte; timeout del adaptador (sin respuesta y con cuerpo colgado) y abort del llamador;
- respuesta fuera del schema (9 mutaciones);
- `customerRef` distinto, ajeno (CRM) o entero desnudo; `schemaVersion` 2, otro contrato u otro propósito;
- campos monetarios, predictivos, de PII e ids (14 mutaciones, también con `null` y con otra capitalización);
- extensiones desconocidas toleradas en todos los niveles, con resultado idéntico al de la respuesta sin ellas;
- datos de autorización incoherentes.

**Mutaciones del adaptador** (TEST; cada una aplicada sola y revertida byte por byte):

| Mutación | Resultado |
|---|---|
| Sin el escaneo de campos prohibidos | 14 tests fallan |
| Proyección omitida (schema sobre el original) | 1 falla |
| Sin el eco de `customerRef` | 1 falla |
| 429 → `contract_violation` | 2 fallan |
| 403 → `validation` | 6 fallan |
| Sin el chequeo de propósito del grant | 1 falla |
| Sin la puerta del ciclo de vida real | 1 falla |
| Sin el tope de 64 KiB | La corrida no termina (el cuerpo infinito nunca se corta): exit 1 |
| Historial parcial devuelto como lista | 3 fallan |
| Sin el filtro AP-10 | 2 fallan |
| Cuentas guest, inactiva y eliminada divulgadas | 4 fallan |
| Sin la guarda de bytes de salida | 1 falla |

**Defecto real detectado y corregido durante la validación:** un cuerpo que dejaba de enviar bytes después de las cabeceras retenía la lectura más allá del deadline. Ahora el abort cancela el lector en curso, y un test lo cubre.

## 6. Decisión sobre campos desconocidos y criterio del mandato enmendado

**Decisión del owner de R4 (2026-10-16):** lector **tolerante**. La especificación R4-J4-R1 §5 y el README de CP v1-rc1 ("los consumidores deben tolerar campos nuevos dentro de `schemaVersion` 1") prevalecen sobre la frase genérica del mandato.

**Criterio 4.12 del mandato R4-J4-R2, enmendado:**
> Rechazo de respuestas malformadas, de los campos prohibidos conocidos (aunque tengan valor `null`), de estructura inválida y de datos de autorización inconsistentes. Tolerancia hacia campos desconocidos compatibles con `schemaVersion` 1: se descartan en la proyección por allowlist, sin llegar al modelo, a la persistencia, a los logs ni a decisiones de autorización. Los invariantes se validan sobre la respuesta original y el schema fijado sobre la proyección.

**Tensión registrada (sin resolver en el contrato, sin efecto en la interoperabilidad actual):**
- El schema productor de CP es cerrado (`additionalProperties: false`) y CP valida su propia salida con él: hoy un campo nuevo exige una revisión nueva del contrato.
- El README de CP promete compatibilidad prospectiva aditiva.
- R4 soporta ambos casos. Validar el original con el schema cerrado anularía esa tolerancia, por eso se aplica a la proyección.
- No se modificó el contrato productor. Conviene que CP aclare en una revisión futura si `additionalProperties: false` es solo del productor.

**Desvíos documentales respecto de la especificación R4-J4-R1** (internos de R4, no del contrato de CP):

| Especificación | Implementación | Motivo |
|---|---|---|
| §5: "un `lineKind` desconocido excluye el ítem de la salida" | En la frontera B, un `lineKind` fuera del enum es `contract_violation`. La frontera C excluye todo lo que no sea `standard` o `zero_price_line` | v1-rc1 declara el enum cerrado y la decisión del owner exige validación estricta de los campos conocidos. Un kind nuevo es una revisión nueva del contrato |
| §5: tipos del puerto planos | Uniones discriminadas por `status` | Impiden leer `items` de un `withheld` o de un `not_found` |
| Lista de PII §10.3 | Se agregan `name`, `birthday`, `birthdate`, `gender`, `prediction`, `propensity`, `churn` | Defensa en profundidad. Un campo aditivo futuro con esos nombres se rechazaría; la lista final se acuerda con CP |

La especificación debe enmendarse en un commit documental posterior. Este slice no la modifica.

## 7. Tratamiento del 429

| Verificación | Resultado |
|---|---|
| Contrato CP v1-rc1 | El enum de errores incluye `rate_limited`, y el alineamiento §4.4 lo mapea a `temporarily_unavailable`. v1-rc1 **no** trae un fixture de 429 |
| Productor sintético de CP | Responde `429 {"error":"rate_limited"}` cuando el tope de slots está lleno (informe CP 02C §6) |
| R4 | `DomainError('temporarily_unavailable', 'rate_limited')`: `retryable` derivado de la categoría y **una sola llamada** (sin reintentos; `maxAttempts: 1` en la capacidad futura) |
| Prueba | Unit (una llamada, telemetría con el código del owner) y mutación (2 tests fallan si cambia la categoría). No se provocó un 429 real en la interop local |

```text
R4_J4_R2_429=COMPATIBLE   (sin divergencia contractual)
```

## 8. Evidencia de que el harness no cambió

| Verificación | Resultado (GIT/TEST) |
|---|---|
| `git diff --stat origin/main -- packages apps` | Vacío: 0 archivos |
| Perfiles, definiciones, producción y migraciones de Sales | 0 archivos cambiados (`agents/sales/src/production`, `agents/sales/*.json`, `agents/sales/migrations`, `packages/persistence-postgres/migrations`) |
| `customer.get_context@1`, `CustomerDirectory` y su fixture | Sin cambios |
| `tests/contract/core-purity.test.ts` | PASS: Core sigue sin términos de dominio |
| Dependencias del adaptador | Solo `@r4-adapters/domains`, `ajv` y `ajv-formats` (test de contrato y `sales-boundaries`) |
| Registro | Ningún perfil, registro ni definición referencia el adaptador ni los lectores de la frontera C (test de contrato) |

```text
R4_HARNESS_UNCHANGED
```

## 9. Integración HTTP sintética (F, ejecutada)

**Montaje:**
- CP local en `feat/cp-j4-context-02c-synthetic` @ `6801a90`, compilado y servido en `127.0.0.1:4310`.
- Auth `enforce`, con un registry de 2 principals **sintéticos** generados para la prueba: `r4-sales` con `customer.sales_context.read` y otro con `customer.facts.read` y `dashboard.read`.
- `CUSTOMER_PROFILE_SALES_CONTEXT_SOURCE=synthetic`.

**Aislamiento de datos reales:**
- CP tiene un `.env` local; no se leyó ni se cargó.
- El proceso corrió con el directorio de trabajo en una carpeta vacía, `env -i` y `DOTENV_CONFIG_PATH` inexistente.
- Todas las bases apuntaban a `127.0.0.1:1`.

| Resultado | Evidencia |
|---|---|
| `tests/unit/customer-profile/cp-synthetic-interop.test.ts` | **5/5** |
| Cobertura | `sales_context`: present, none, unknown, not_found, 4 withheld, degraded. `purchase_history`: 3 ítems brutos, vacío, nombre `null`, `zero_price_line` y 0 unidades, `administrative_service`, fecha de medianoche, paginación con `hasMore`, `history_unavailable`, not_found, 2 withheld, degraded. Frontera C sobre el productor vivo (la línea de servicio no llega al modelo). 401 con token desconocido y 403 con `requiredScope`. Un cliente fuera del dataset da `not_found` |
| Log de CP | 23 peticiones `customer_sales_context_request`; **0** intentos de conexión a una base y **0** apariciones de `customerRef` o ids |

Es una prueba de **interoperabilidad HTTP sintética y local**, no una E2E productiva: no hay resolver de identidad, grant (D2) ni despliegue.

## 10. Riesgos pendientes

| # | Riesgo o condición | Efecto |
|---|---|---|
| 1 | **G-16:** falta la aceptación formal del owner de CP de AP-01 a AP-08 y AP-11 | Contrato y adaptador provisionales; una AP rechazada reabre la parte afectada |
| 2 | **D1:** no existe autoridad de identidad (ID-AUTHORITY-DECISION-01) | Sin `customerRef` real; J4-R3 bloqueado |
| 3 | **D2:** no hay grant por cliente | El grant no se envía; el modo real está rechazado por configuración y por el ciclo de vida |
| 4 | **D6:** `catalogKey: null` | Sin clave de Catalog en el historial |
| 5 | **D7:** persistencia y purga de datos privados | La frontera C limita lo observable, pero no hay retención ni purga de las observaciones futuras |
| 6 | AP-09 (cuentas guest e inactivas) y AP-10 (clasificación `lineKind`) pendientes de negocio | `withheld` provisional; filtro AP-10 según el criterio vigente |
| 7 | Tensión `additionalProperties: false` / README de CP (§6) | Solo de evolución; ninguna en la interoperabilidad actual |
| 8 | Enmienda documental de la especificación R4-J4-R1 (§6) | Pendiente |
| 9 | Regresión con PostgreSQL no ejecutada (Docker no disponible) | Ejecutar `integration`, `sales` y `shadow` antes de cualquier merge |
| 10 | La frontera C no tiene `CapabilityRegistration` ni evaluación de privacidad | Es J4-R4 |
| 11 | El RESILIENCE gate de CP sigue abierto para un proveedor real | Bloquea datos reales del lado de CP |

```text
CUSTOMER_REAL_DATA_ACCESS_BLOCKED   (R4_CUSTOMER_MODE=real rechazado; ciclo de vida real inalcanzable sin D2)
G16_PENDING
PRODUCTION_UNCHANGED                (sales-production@3; sin despliegue)
```

## 11. Recomendación para J4-R3

- **J4-R3 (resolver de identidad) no es autorizable todavía:** depende de D1, y no hay owner ni contrato de la autoridad de identidad. Implementarlo sería hacerlo contra un contrato supuesto.
- Pasos recomendados, en orden:
  1. designación del owner de la autoridad de identidad y contrato v1 (CS-01 a CS-12; ID-AUTHORITY-DECISION-01);
  2. aceptación formal del owner de CP (G-16);
  3. regresión completa de esta rama con PostgreSQL y revisión del owner antes de cualquier merge;
  4. enmienda documental de la especificación (§6).
- Mientras tanto, J4-R4 tampoco debe empezar: necesita R3 para obtener el `customerRef` y el grant. Los bloques de la frontera C de este slice quedan listos para que R4 los registre cuando se autorice.

## 12. Estado

```text
R4_J4_R2_ADAPTER_IMPLEMENTED
R4_J4_R2_CONTRACT_VALIDATED            (fixtures v1-rc1 @ 47db415; sin divergencia contractual sin resolver)
R4_J4_R2_SYNTHETIC_HTTP_INTEROP=PASS   (local, CP 6801a90, enforce; NO es E2E productiva)
R4_J4_R2_429=COMPATIBLE
R4_J4_R2_POSTGRES_REGRESSION=NOT_RUN   (Docker no disponible)
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
G16_PENDING
PRODUCTION_UNCHANGED
J4_R3_NOT_AUTHORIZABLE                 (D1)
```
