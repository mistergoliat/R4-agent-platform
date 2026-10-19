# R4-J4-R2-OWNER-REVIEW-01 — Auditoría arquitectónica, de seguridad y de preparación de merge

| Campo | Valor |
|---|---|
| Fecha | 2026-10-19 |
| Alcance | Revisión independiente del código de R4-J4-R2 (adaptador Customer Profile + frontera C). Sin cambios de código, sin merge, push ni despliegue |
| Método | Lectura completa del diff, verificación de hashes contra el owner, re-ejecución de gates locales y pruebas focalizadas aisladas (fetch inyectado, sin red ni base de datos) |
| Estado | **Borrador sin publicar** (no commiteado) hasta revisar el dictamen |

Etiquetas: **GIT** = verificado con git en esta sesión (tras `git fetch origin --prune`) · **CODE** = lectura de código · **TEST** = ejecutado en esta sesión · **REPORT** = solo según el informe previo, no re-verificado.

---

## 1. Referencias Git auditadas

### R4 (`R4-agent-platform`)

| Referencia | Valor | Fuente |
|---|---|---|
| Rama | `feat/r4-j4-customer-adapter-r2` → upstream `origin/feat/r4-j4-customer-adapter-r2`, sin divergencia, worktree limpio | GIT |
| HEAD | `3f2b21601975cf2eb53ad11afc99dbd74ee5f5d5` (= esperado `3f2b216`) | GIT |
| Base original | `e6105b0d68457ebf860bbe41489819f0424824db` | GIT |
| `origin/main` | `3e7b4eec6772ffd4f192a3c78fe89dbe39d4f05a` = *Merge pull request #11 from mistergoliat/feat/r4-j4-customer-adapter-r2* (2026-10-18 23:10 -0300), padres `e6105b0` + `3f2b216` | GIT |
| merge-base(HEAD, origin/main) | `3f2b216` (HEAD ya está contenido en `main`) | GIT |
| Árbol de `3e7b4ee` vs `3f2b216` | Idénticos (`4480971f…`) | GIT |
| Diff real `origin/main...HEAD` | **Vacío**. El diff efectivo es `e6105b0..3f2b216` (61 archivos, +5 285 / −1) | GIT |
| Cambios en `main` posteriores a la base | Solo el merge del PR #11. Ningún otro cambio que pueda afectar la integración | GIT |

> **Hallazgo de preflight (G-1, gobernanza):** el código **ya fue fusionado a `main`** (PR #11) antes de esta revisión. El dictamen de §10 es por lo tanto **retrospectivo**: decide si el código puede **permanecer** en `main` como inactivo o si debe revertirse, no si puede fusionarse.

Commits del slice (`e6105b0..3f2b216`):

```
b858fe2 feat(customer): Customer Profile port and HTTP adapter for sales-context v1-rc1 (R4-J4-R2)
15af63e test(customer): contract, unit, mutation-backed and opt-in interop tests (R4-J4-R2)
76fda0f docs(r4): R4-J4-R2 Customer Profile adapter validation report
3f2b216 docs(r4): R4-J4-R2 report with the full PostgreSQL regression
```

### Customer Profile (`MS-pesaschile-customer-profile`)

| Referencia | Valor | Fuente |
|---|---|---|
| Rama | `feat/cp-j4-context-02c-synthetic` = `6801a90` (= esperado) | GIT |
| Contrato F2 | `47db415e1ebf67b5e6770dbdcfc697880b6e5f76` (tag `cp-sales-context-v1-rc1`) | GIT |
| `origin/main` | `de6c04a` | GIT |

## 2. Comparación CP `3c1b776..de6c04a`

| Pregunta | Resultado | Fuente |
|---|---|---|
| ¿Qué incorporó `de6c04a`? | Merge del **PR #25** (`feat/cp-j4-context-02c-synthetic`). Padres `3c1b776` + `6801a90`; árbol idéntico al de `6801a90`. Commits: `02dc571` (F3: G-14 MET, G-16 PENDING, override provisional), `d84c9ea` (productor sintético), `6801a90` (informe 02C) | GIT |
| ¿Modifica el contrato? | **No.** Desde `47db415` solo cambió `docs/contracts/.../PROVENANCE.md` (texto, fuera de los hashes). Schemas, fixtures, `MANIFEST.json` y `SOURCE.json` intactos | GIT |
| ¿Modifica autenticación? | Agrega el scope `customer.sales_context.read` y clasifica la ruta `/v1/capabilities/customer/sales-context` (familia `customer_sales_context`). El test de contrato de CP mueve la sonda "ruta no clasificada" a `/v1/capabilities/customer/unclassified-probe`; el fixture `error-forbidden-unclassified-route.json` sigue vigente. Un principal sin scope recibe ahora `error-forbidden.json` | GIT |
| ¿Productor? | Nuevo, **apagado por defecto** (`CUSTOMER_PROFILE_SALES_CONTEXT_ENABLED=false`). Habilitarlo exige `API_AUTH_MODE=enforce` y `SOURCE=synthetic`, la única fuente que existe (`SALES_CONTEXT_SOURCE_KINDS = ['synthetic']`). Emite siempre `contractStatus: candidate` y `authorizationBasis: service_scope_only`. Dataset sintético `900000201`–`900000313` | GIT/CODE |
| ¿Dependencias? | `ajv 8.17.1` y `ajv-formats 3.0.1` pasan de devDependencies a dependencies (R4 usa `ajv 8.20.0`; sin efecto cruzado, repos independientes) | GIT |
| ¿La rama sintética sigue compatible? | **Sí.** `47db415` es ancestro de `6801a90` y de `de6c04a`; los 38 artefactos que copia R4 no cambiaron en `de6c04a` (§6.1) | GIT |
| ¿Conflictos para R4-J4-R2? | **Ninguno técnico.** 401/403 → `unauthorized` sigue siendo correcto para el nuevo 403 con `requiredScope`. Ruta deshabilitada → 404 → R4 `contract_violation/unexpected_status` (ver P2-7) | CODE/TEST |

> **Hallazgo G-2 (gobernanza CP, fuera del código R4):** `CP_J4_F3_GATE_REGULARIZATION.md` §3 declara *"Fuera de alcance: … merge a `main`"* y *"La aceptación formal sigue siendo condición para `approved`, para datos reales y **para cualquier merge del productor**"*. Con **G-16 = PENDING**, el productor 02C fue fusionado a `main` de CP (`de6c04a`). El productor está apagado y solo tiene fuente sintética, por lo que no habilita datos reales, pero el merge contradice la condición registrada por el propio CP. Debe regularizarse documentalmente en CP (o revertirse) por el owner de CP. No afecta la compatibilidad de R4.

No se fusionó `main` en ninguna rama de trabajo para esta comparación.

## 3. Inventario completo del diff R4 (`e6105b0..3f2b216`)

| Grupo | Archivos | Evaluación |
|---|---|---|
| Puerto de dominio | `adapters/domains/src/customer/profile-port.ts` (+101), `adapters/domains/src/index.ts` (+1 export) | Fuera de Core (`@r4-adapters/domains`). Tipos genéricos de lectura; propósito fijado por operación |
| Adaptador HTTP (nuevo paquete `@r4-adapters/customer-http`) | `src/config.ts` (106), `src/client.ts` (314), `src/wire.ts` (430), `src/index.ts`, `package.json`, `tsconfig.json` | Transporte, validación y mapeo. Deps: `@r4-adapters/domains`, `ajv 8.20.0`, `ajv-formats 3.0.1` (fijadas exactas) |
| Contrato copiado | `contract/SOURCE.json` (registro R4), `contract/owner-SOURCE.json`, 2 schemas | Byte-idénticos al owner (§6.1) |
| Fixtures copiados | `fixtures/MANIFEST.json` + 34 fixtures (22 respuesta, 10 error, 2 request) | Byte-idénticos al owner (§6.1) |
| Frontera C (Sales) | `agents/sales/src/capabilities/customer-profile-outputs.ts` (186) | **No registrado** por ningún perfil, registry ni definición |
| Tests | `tests/contract/customer-http-contract.test.ts`, `tests/unit/customer-profile/{config,http-client,outputs,cp-synthetic-interop}.test.ts`, `support.ts`; `tests/contract/sales-boundaries.test.ts` (+3: manifiesto del nuevo paquete) | §7 |
| Workspace/build | `package.json` (+workspace), `package-lock.json` (+52: paquete local, `ajv 8.20.0`, `fast-uri 3.1.8`, `json-schema-traverse 1.0.0`), `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` (+alias) | Solo registro del paquete. Sin cambios de comportamiento para otros paquetes |
| Documentación | `docs/architecture/R4_J4_R2_CUSTOMER_ADAPTER_VALIDATION_REPORT.md` | §8 |

**No hay cambios** en `packages/`, `apps/`, ni en los adaptadores Catalog, Shipping o Quote, ni en perfiles de producción Sales (GIT: `git diff --name-only e6105b0 3f2b216 -- packages apps agents` → solo `customer-profile-outputs.ts`).

## 4. Invariante arquitectónico: harness agnóstico de Customer Profile

| Verificación | Resultado | Fuente |
|---|---|---|
| Dependencias Customer en el kernel / Core | **Cero.** Ningún archivo de `packages/*` o `apps/*` cambia; `core-purity` y `sales-boundaries` PASS | GIT/TEST |
| Cambios en mecanismos generales de ejecución | **Cero** | GIT |
| Lógica PrestaShop en el runtime | **Cero.** El namespace `prestashop_customer:` vive solo en el puerto de dominio y el adaptador | CODE |
| Encapsulamiento | Adaptador en `adapters/domains/customer/http`; frontera C en `agents/sales/src/capabilities` | CODE |
| Registro automático de capacidades Customer | **Ninguno.** Fuera de `tests/`, nada importa `@r4-adapters/customer-http`, `CustomerProfileHttpClient`, `loadCustomerProfileHttpConfig` ni `readCustomer*` (grep). Ninguna raíz de composición lee `R4_CUSTOMER_MODE`. El test de contrato lo fija ("no Sales profile, registry or definition binds the adapter") | GIT/CODE/TEST |
| Catalog / Shipping / Quote | Sin modificaciones; sus suites unit/contract PASS | GIT/TEST |

No se detectó ningún cambio de harness introducido para satisfacer a Customer Profile. **Invariante: CUMPLIDO.**

## 5. Auditoría de seguridad

### A. Aislamiento sintético

**Pregunta:** ¿`R4_CUSTOMER_MODE=synthetic` garantiza que R4 solo hable con un Customer Profile sintético?

**Respuesta: no por sí mismo.** "Synthetic" en R4 es una **etiqueta de ciclo de vida** (acepta `candidate` + `service_scope_only`), no un **vínculo verificado** con un servicio o un dataset sintético. Pruebas aisladas (TEST, fetch inyectado, sin red):

| # | Ruta | Resultado |
|---|---|---|
| A1 | `R4_CUSTOMER_MODE=synthetic` + `allowNetwork: true` + `https://customer-profile.example-real-host.cl` | **Aceptado** (`lifecycle=synthetic`). Ningún criterio distingue un host sintético de uno real (`config.ts:73-76`) |
| A2 | `http://localhost:18443` sin `R4_PROD_ALLOW_NETWORK` | **Aceptado.** El loopback no requiere el flag ni https: un túnel (`ssh -L`) hacia un CP remoto lo esquiva (`config.ts:73,104-106`) |
| A3 | Inyección directa de `CustomerProfileHttpConfig` en el constructor | **Aceptado** con `http://10.0.0.5`, token de 5 caracteres y timeout 999 999 ms: el constructor no revalida (`client.ts:82-92`). `R4_PROD_ALLOW_NETWORK`, https, token y timeout solo los aplica el *loader*. Mismo patrón que Quote/Shipping (`quote/http/src/client.ts:69-70`) |
| A4 | `customerRef` fuera del dataset sintético (`prestashop_customer:12345`) con respuesta `candidate`/`service_scope_only` | **Aceptado** como `available` |
| A5 | `lifecycle: 'real'` inyectado por DI | **Inalcanzable**: `customer_grant_verified` → `authorization_basis_incoherent` (`grantSent` fijo en `false`, `client.ts:180`, `wire.ts:316-318`); `service_scope_only` → `authorization_basis_insufficient` (`wire.ts:320-323`) |

**Por qué el modo sintético no se distingue de uno real:** el productor de CP emite `candidate` + `service_scope_only` de forma fija (`compose-sales-context.ts:138-140`), que es exactamente lo que emitiría una fuente real antes de D2. El contrato v1-rc1 no trae ningún marcador de dataset sintético, y R4 no restringe el rango de `customerRef` en modo sintético.

**Ruta precisa de una lectura real bajo `synthetic`:**
1. Existe una raíz de composición que construye `CustomerProfileHttpClient` (**hoy no existe**; J4-R4 no está autorizado);
2. el operador configura `R4_CUSTOMER_MODE=synthetic`, una URL de un CP real (https + `R4_PROD_ALLOW_NETWORK=true`, o loopback/túnel) y un bearer `r4-sales` válido emitido por ese CP;
3. ese CP sirve la ruta con una **fuente real** (**hoy no existe**: `SALES_CONTEXT_SOURCE_KINDS = ['synthetic']`, y F3 lo prohíbe hasta D2/AP-03/AP-09/G-16) respondiendo `service_scope_only` (el propio schema lo prohíbe para datos reales);
4. algo provee una `IdentityResolution` verificada (J4-R3, **bloqueado por D1**).

**Clasificación:** **configuración potencialmente peligrosa, no vulnerabilidad explotable hoy.** Las precondiciones 1, 3 y 4 no existen en ningún repositorio. La protección efectiva contra datos reales es hoy **del lado de CP** (fuente única sintética) más la **ausencia de composición en R4**, no el modo sintético de R4. → **P2-1** y **P2-2** (§5.E), condición previa a cualquier activación.

### B. Identidad y autorización

| Verificación | Resultado | Fuente |
|---|---|---|
| El modelo no elige `customerRef` | **Cumple.** Inputs `z.strictObject({})` y `{offset, limit}`; rechazan `customerRef`, `purpose`, etc. El ref sale solo de `IdentityResolution.verified` (`outputs.ts:32,39-42,134-136,155-157`) | CODE/TEST |
| Propósito fijado por la capacidad | **Cumple.** Cada lector llama una sola operación del puerto; el puerto no acepta propósito (`profile-port.ts:98-101`, `client.ts:94-108`) | CODE/TEST |
| Grants sintéticos vs reales | **Indistinguibles estructuralmente** (`profile-port.ts:34-39`). El cliente solo verifica `purposes` y `expiresAt` (`client.ts:131-133`); un grant fabricado (`token: 'forged-by-anyone'`) pasa (probe A3/A4). Aceptable porque **no se envía** y el modo real es inalcanzable; debe resolverse en J4-R3 → **P2-3** | CODE/TEST |
| `authorizationBasis` no es prueba suficiente | **Cumple.** `customer_grant_verified` sin grant enviado = violación; en `real` además se exige `approved` (`wire.ts:314-323`) | CODE/TEST |
| 401/403 nunca → `not_found` | **Cumple.** `unauthorized/profile_unauthorized` por status, aunque el cuerpo diga `customer_not_found` (probe B1; `client.ts:239-242`). 404 → `contract_violation` | CODE/TEST |
| Fallos de identidad sin divulgación | **Cumple.** `null`/`not_*`/`ambiguous`/`conflicted` terminan sin llamar al puerto (`outputs.ts:90-103`); grant incoherente → `incoherent_grant` antes de la llamada | CODE/TEST |
| Modo real inhabilitado | **Cumple, doble barrera.** `R4_CUSTOMER_MODE=real` → `customer_real_data_blocked` (`config.ts:51-53`); y `lifecycle: 'real'` por DI no puede aceptar ninguna respuesta (A5) | CODE/TEST |

### C. Minimización y privacidad

| Verificación | Resultado | Fuente |
|---|---|---|
| Campos prohibidos conocidos, incluso `null` | **Cumple** sobre la respuesta original, a cualquier profundidad (≤ 32), normalizando mayúsculas y separadores (`wire.ts:118-161`) | CODE/TEST |
| Proyección por allowlist | **Cumple** (`wire.ts:188-232`); el schema cerrado del owner valida la proyección | CODE/TEST |
| Extensiones desconocidas | **Descartadas** antes del schema; nunca llegan al puerto ni a la telemetría | TEST |
| PII y tokens en logs | **Cumple.** Telemetría con códigos, status, duración, `correlationId` validado y diagnósticos enumerados; sin token, ref, grant ni hechos. Mensajes de error con rutas de claves saneadas (`safePath`) | CODE/TEST |
| Respuestas completas en observaciones persistentes | **No aplica hoy** (nada registrado ni persistido). La frontera C es el único payload hacia el modelo; D7 (retención/purga) sigue pendiente | CODE |
| Tope 64 KiB HTTP | **Cumple**, en bytes sobre el stream, con corte (`client.ts:51,273-304`) | CODE/TEST |
| Tope 8 KiB salida al modelo (300 B contexto) | **Cumple**, falla sin payload parcial (`outputs.ts:70-85`) | CODE/TEST |
| Respuestas parciales | `purchasedProducts.status != available` → `history_unavailable` (nunca lista parcial); `partial` exige `partial_context` (`wire.ts:333`, `wire.ts:398-401`) | CODE/TEST |
| Deadlines | `AbortSignal.timeout` + señal del llamador; cubre cuerpos que no terminan (`client.ts:139-165,280`) | CODE/TEST |

### D. Detector de campos sensibles: falsos positivos / negativos

- **Falsos positivos sobre v1-rc1: ninguno.** Se enumeraron todas las propiedades del schema de respuesta; ninguna coincide con `SENSITIVE_KEYS` ni `MINIMIZATION_KEYS` (`state` solo se prohíbe bajo `account`). Los 22 fixtures de respuesta pasan. (CODE/TEST)
- **Falsos negativos por coincidencia exacta:** `customerEmail`, `phoneNumber`, `unitPriceTaxIncl`, `customer_email` **no** disparan el detector, pero **la proyección los descarta** y no llegan al puerto (probe C1: `leakedToPort=false`). El control primario es la allowlist; el detector es defensa en profundidad → **P2-5** (documental).
- **Valores no inspeccionados:** el texto histórico `nameAtLastPurchase` se reenvía literal (probe C2: PII o instrucciones dentro del nombre pasan, truncadas a 120 code points). Es dato del owner y la salida del modelo es no confiable por constitución; conviene declararlo explícitamente en J4-R4 → parte de **P2-5**.

### E. Hallazgos

**P0:** ninguno. **P1 (código):** ninguno.

| ID | Sev. | Archivo:línea | Evidencia | Consecuencia | Acción |
|---|---|---|---|---|---|
| G-1 | Gobernanza | `origin/main` `3e7b4ee` | PR #11 fusionado el 2026-10-18 antes de esta revisión | El dictamen es retrospectivo | Registrar en el decision register que el merge precedió a la revisión del owner; este informe lo regulariza |
| G-2 | Gobernanza (CP) | CP `de6c04a`; `CP_J4_F3_GATE_REGULARIZATION.md` §3 | Productor 02C fusionado a `main` de CP con G-16 PENDING, contra la condición de F3 | Incumplimiento de gobernanza del lado CP; sin efecto técnico en R4 | Owner de CP: regularizar (aceptación o revert) |
| P2-1 | P2 | `config.ts:57-88`, `config.ts:73-76,104-106` | Probes A1, A2, A4 | El modo `synthetic` no garantiza dataset sintético; depende de que CP no tenga fuente real | **Antes de activar (J4-R4/R5):** en modo sintético restringir `customerRef` a la lista de identidades sintéticas aprobada por el owner (ya prevista en la especificación §11, fila D7) y/o allowlist de hosts; proponer a CP un marcador aditivo de dataset sintético en `provenance` |
| P2-2 | P2 | `client.ts:82-92` | Probe A3 | Una raíz de composición futura que construya la config a mano esquiva `R4_PROD_ALLOW_NETWORK`, https, token y timeout | Al componer (J4-R4): construir solo vía `loadCustomerProfileHttpConfig`, o revalidar en el constructor. Mismo patrón preexistente en Quote/Shipping: registrar como propuesta transversal independiente, no corregir silenciosamente |
| P2-3 | P2 | `profile-port.ts:34-39`; `client.ts:131-133` | Grant fabricado aceptado (A3/A4) | En J4-R3 un grant sintético podría circular como real | J4-R3: tipo de grant con marca/emisor y procedencia verificable; no usar el tipo actual para datos reales |
| P2-4 | P2 | `outputs.ts:175-180` | Probe D1: `{offset:0, returned:1, hasMore:true, nextOffset:2}` tras filtrar AP-10 | Correcto para paginar, pero `offset+returned ≠ nextOffset` puede confundir al modelo | Documentar: `returned` = ítems mostrados; `nextOffset` = cursor del owner. Evaluar en J4-R4 la descripción de la capacidad |
| P2-5 | P2 (doc) | `wire.ts:118-161` | Probes C1/C2 | Riesgo de sobreestimar el detector | Documentar que la allowlist es el control primario y que los textos históricos son datos no confiables |
| P2-6 | Info | `client.ts:130`; `wire.ts:354-366` | `now` se toma antes del fetch | Desfase ≤ timeout (5 s) en la verificación de vigencia | Ninguna; R4 ya usa `min(validUntil, grant.expiresAt)` |
| P2-7 | Info | `client.ts:246` | Ruta CP deshabilitada → 404 → `contract_violation/unexpected_status` | Diagnóstico operativo confuso (alarma de contrato vs ruta apagada) | Opcional al componer: anotar el caso en el runbook |

## 6. Revisión contractual

### 6.1 Integridad de los 38 artefactos

Para cada entrada de `contract/SOURCE.json`: sha256 de la copia R4 (LF) = sha256 de `git show 47db415:<ownerPath>` = sha256 registrado, y blob git del owner = `gitBlob` registrado. **38/38 coinciden, 0 discrepancias** (GIT). Ninguno cambió en CP `de6c04a`. El directorio de fixtures del owner en `47db415` tiene 35 entradas (34 fixtures + `MANIFEST.json`): la copia está **completa**. En runtime, `pinnedContract()` rechaza cualquier byte distinto (`wire.ts:71-93`).

### 6.2 Reglas contractuales

| Aspecto | Verificación | Fuente |
|---|---|---|
| Propósito | Eco exacto exigido; componente del otro propósito rechazado aunque sea `null` | CODE/TEST |
| Identificador y namespace | Patrón `^prestashop_customer:[1-9][0-9]{0,9}$` antes de la red y en la respuesta; eco exacto (`customer_ref_mismatch`) | CODE/TEST |
| Estados | `available` / `not_found` / `withheld` (`not_applicable` y estados no `active`) sin plegarse; `degraded` = 503 | CODE/TEST |
| Versiones | `schemaVersion: 1`, `contract`, `policyVersion` = `provenance.policyVersions.facts` (SR-01); `deprecated` rechazado | CODE/TEST |
| Vigencia | TTL ≤ 15 min, no expirada, `asOf` ≤ ahora + 5 min; `degraded` sin `validUntil` | CODE/TEST |
| Paginación | Página = la pedida; `returned` = ítems; página corta sin `hasMore`; orden descendente; ventana 50 (offset ≤ 40) | CODE/TEST |
| 429 y otros errores | 429 → `temporarily_unavailable/rate_limited`, sin reintento; 400/413/415 → `validation`; 5xx → `temporarily_unavailable`; códigos del owner solo si tienen forma de código | CODE/TEST |
| Fechas sin zona verificada | `timezoneStatus: unverified` → `datePrecision: day_timezone_unverified`, expuesto al modelo | CODE/TEST |
| Cantidades brutas | `quantityPurchasedGross` → `totalQuantity`; salida declara `gross_units_not_net_of_returns`; 0 es un hecho | CODE/TEST |
| `catalogKey: null` | Schema del owner `type: null` (D6); salida acepta clave futura con `CATALOG_KEY_PATTERN` | CODE |
| Filtro AP-10 | Solo `standard` y `zero_price_line` llegan al modelo; `administrative_service` excluido, también contra el productor sintético vivo (REPORT para la interop) | CODE/TEST |

Tensión ya registrada y vigente: schema productor cerrado (`additionalProperties: false`) vs promesa aditiva del README de CP. La solución de R4 (validar la proyección) es correcta; la aclaración corresponde a CP.

## 7. Evidencia de pruebas y limitaciones

| Suite | Informe previo | Esta sesión |
|---|---|---|
| `npm run build` | PASS | **PASS** (TEST) |
| `npm run typecheck` | PASS | **PASS** (TEST) |
| `npm run lint` (`--max-warnings=0`) | PASS | **PASS** (TEST) |
| Unit + contract | 1 516 PASS, 6 skip | **1 516 PASS** (unit 1 146 + contract 370), 6 skip, 0 fallos (TEST) |
| PostgreSQL integration | 471 PASS | **No re-ejecutado**: Docker no disponible en este equipo (REPORT) |
| Sales | 29 PASS | No re-ejecutado (PostgreSQL) (REPORT) |
| Shadow | 5 PASS | No re-ejecutado (PostgreSQL) (REPORT) |
| HTTP sintético CP | 5 PASS | Skip (requiere CP local 02C) (REPORT) |
| Probes de esta revisión | — | 14 casos aislados (A1–A5, B1, C1–C2, D1–D2), fetch inyectado (TEST) |

**Riesgo de no re-ejecutar integración/sales/shadow:** bajo. El diff no toca ningún archivo que esas suites carguen salvo el registro de workspace/alias; build y typecheck sobre el monorepo completo pasan.

**Cobertura de invariantes:** las invariantes críticas (sin identificador en inputs, propósito por operación, 401/403 ≠ `not_found`, campos prohibidos con `null`, allowlist, topes 64 KiB / 8 KiB, sin lista parcial, modo real rechazado, no registro) están cubiertas por tests y en parte por mutación. **Huecos:** ningún test fija el comportamiento de P2-1 (host/ref no sintéticos aceptados), P2-2 (bypass por DI), P2-4 (metadatos de página tras AP-10) ni los falsos negativos del detector. No bloquean código inactivo; deben agregarse junto con las correcciones de activación.

No se ejecutó `test:recovery`, ni se consultaron bases de datos productivas, ni se hicieron peticiones reales. Los probes están en el scratchpad de la sesión (fuera del repositorio).

## 8. Divergencias documentales

| # | Desvío | Evaluación | Enmienda propuesta |
|---|---|---|---|
| 1 | `lineKind` desconocido = `contract_violation` (spec: excluir el ítem) | **Mejora legítima, más estricta.** v1-rc1 declara el enum cerrado (`purchasedProduct.lineKind`) y la decisión del owner exige validar estrictamente los campos conocidos; un kind nuevo es una revisión de contrato. Costo: un kind desconocido invalida toda la página (disponibilidad, no privacidad) | Spec R4-J4-R1 §5, fila "Tipo de línea": *"Un `lineKind` fuera del enum de la revisión vigente es `contract_violation` (frontera B, respuesta completa rechazada, se registra el código). La frontera C excluye además, de forma defensiva, todo `lineKind` distinto de `standard` y `zero_price_line`."* Ajustar igual §6.2 (filtro AP-10) y §11 (fila AP-10) |
| 2 | Uniones discriminadas por `status` en el puerto (spec: tipos planos) | **Mejora legítima.** Mismo contenido semántico, sin cambio de wire; impide leer `items` de `withheld`/`not_found` | Spec §5: reemplazar el bloque de tipos por las uniones de `profile-port.ts:48-89`, con la nota *"los estados no `available` no llevan hechos"* |
| 3 | Claves sensibles ampliadas (`name`, `birthday`, `birthdate`, `gender`, `prediction`, `propensity`, `churn`) | **Mejora legítima (defensa en profundidad).** Sin colisiones con v1-rc1 (§5.D). Riesgo: un campo aditivo futuro con esos nombres sería rechazado → debe acordarse con CP | Spec §10.3: incorporar la lista completa de `wire.ts:121-138` como *"lista de rechazo del consumidor (no exhaustiva; el control primario es la allowlist)"*, y registrarla en el alineamiento de CP como restricción de nombres para revisiones aditivas |

Enmiendas adicionales derivadas de esta revisión (documentales, no bloqueantes):
- **Spec §8 (Variables):** aclarar que `R4_CUSTOMER_MODE=synthetic` es un ciclo de vida, no un aislamiento; el aislamiento exige la lista de identidades sintéticas (P2-1) y composición solo vía loader (P2-2).
- **Spec §6.2:** semántica de `page.returned` vs `nextOffset` tras AP-10 (P2-4).
- **Decision register:** registrar G-1 (merge previo a la revisión) y referenciar G-2.

No se modificó código ni contratos.

## 9. Estado de gates y decisiones

| Gate / decisión | Estado | Efecto |
|---|---|---|
| **G-16** (aceptación formal del owner CP de AP-01…AP-08, AP-11) | **PENDING** (GIT: F3 §2; register R1C) | Bloquea `approved`, datos reales y activación. No bloquea código inactivo |
| **D1** (autoridad de identidad / CIA) | **BLOCKED** (register) | Sin `customerRef` real; J4-R3 no autorizable |
| **D2** (grant por cliente) | **PROPOSED** (register) | El grant no se envía; modo real inalcanzable |
| **D6** (mapeo a Catalog) | **DEFERRED_WITH_NULL** | `catalogKey: null` |
| **D7** (persistencia y purga de datos privados) | **PROPOSED_PRODUCTION_BLOCKER** | Bloquea producción; sin efecto en código no registrado |

## 10. Dictamen

```text
R4_J4_R2_OWNER_REVIEW_VERDICT=MERGE_READY_WITH_DOCUMENTARY_CHANGES
```

**Fundamento:** sin hallazgos P0/P1 de código; harness sin cambios; integración inactiva (sin composición, sin registro, modo real doblemente bloqueado); artefactos contractuales íntegros; 1 516 tests re-ejecutados en verde, más typecheck, lint y build. Los P2 no son explotables con el código existente y se resuelven antes de activar. Lo pendiente para el merge es documental (§8, G-1).

Como el merge **ya ocurrió** (PR #11, `3e7b4ee`), el dictamen significa: **el código puede permanecer en `main` como inactivo; no se requiere revert.** Las enmiendas de §8 deben cerrarse en un commit documental posterior.

| Nivel | Estado | Condiciones |
|---|---|---|
| **Merge de código inactivo** | **Aceptable** (ya realizado) | Enmiendas documentales §8; registrar G-1 |
| **Activación de capacidades Customer** (registro en `sales-production@8`, J4-R4) | **NO autorizada** | Autorización explícita de fase; corregir P2-1 (identidades sintéticas aprobadas), P2-2 (composición solo vía loader), P2-3 (grant con procedencia); tests que fijen esas invariantes; definir P2-4 en la descripción de la capacidad |
| **Acceso a datos comerciales reales** | **BLOQUEADO** | G-16, D1, D2 implementado y verificado, contrato `approved`, fuente real autorizada en CP, D7, AP-09/AP-10 de negocio |
| **Despliegue productivo** | **BLOQUEADO** | Todo lo anterior más D7 (retención/purga) y J4-R5 con 0 clientes reales verificados |

```text
R4_J4_R2_OWNER_REVIEW_COMPLETE
R4_J4_R2_HARNESS_INVARIANT=HELD
R4_J4_R2_CONTRACT_ARTIFACTS=38/38_MATCH_47db415
R4_J4_R2_SYNTHETIC_ISOLATION=LABEL_ONLY_NOT_EXPLOITABLE_TODAY (P2-1, P2-2)
R4_J4_R2_REAL_MODE=UNREACHABLE
R4_J4_R2_ALREADY_MERGED=3e7b4ee (G-1)
CP_02C_MERGED_WITH_G16_PENDING=de6c04a (G-2, owner CP)
CUSTOMER_ACTIVATION=NOT_AUTHORIZED
```
