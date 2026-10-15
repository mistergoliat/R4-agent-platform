# R4-J4-R0 — Preflight de integración de Customer Profile

| Campo | Valor |
|---|---|
| Fecha | 2026-10-15 |
| Hito | J4 — Customer Profile Integration |
| Tipo | Auditoría de solo lectura. **No inicia J4-R1.** |
| Repositorio | R4-agent-platform, rama `r4-j3-closure-record`, HEAD `99ea7ee` |
| Baseline pedido | `b5fd2882903851e5f11aa65a2ff76452c3130edf` (= `main`) |
| Cambios realizados | Solo este documento (sin commit). Sin cambios de código, harness, migraciones, EC2 ni producción |
| Dictamen | **READY_WITH_BLOCKERS** (§10) |

## 0. Convenciones de evidencia

| Etiqueta | Significado |
|---|---|
| **R4** | Verificado en este repositorio durante la auditoría, con `archivo:línea` |
| **EXT-CP** | Verificado leyendo el checkout local `../MS-pesaschile-customer-profile` en `45b28a3` (rama `feat/cp-j4-security-01-resilience-01`). **No es necesariamente lo desplegado en EC2** |
| **EXT-CRM** | Verificado leyendo el checkout local `../CRM-Customer-360` en `8298723` (rama `develop`). Misma salvedad |
| **DOC** | Afirmación de un documento, sin verificación en código |
| **PROPUESTA** | Diseño de esta auditoría. No aprobado |
| **PENDIENTE** | Dependencia o decisión no resuelta |

**Checkout CP en movimiento.** Durante la auditoría, el árbol de trabajo de CP pasó de 3 archivos sin seguimiento (docs) a tener además modificados `src/infrastructure/prestashop/{commercial-summary-reader-utils,mysql-customer-product-behavior-reader,mysql-purchased-products-reader}.ts` y dos tests nuevos `tests/integration/historical-product-reference-*.test.ts`. Esos cambios no los hizo esta auditoría. Las afirmaciones EXT-CP se refieren a `45b28a3` más el árbol inicial. El trabajo en curso parece tocar la referencia de producto del historial (D6), por lo que §3.1 y X8 deben revisarse contra el freeze de J4-R1.

No se accedió a EC2, a servicios desplegados, a bases de datos ni a la red. Los repositorios externos se leyeron sin modificarlos. No hay checkout local de **Customer Service** (el servicio externo de creación y vinculación que CRM invoca), así que nada sobre él está verificado.

---

## 1. Estado Git y baseline

| Verificación | Resultado (R4) |
|---|---|
| HEAD | `99ea7ee8db7048ac4c07bcd972ff86e52d88e768`, rama `r4-j3-closure-record`, árbol limpio |
| Relación con el baseline | `b5fd288` es ancestro de HEAD. HEAD = baseline + 1 commit documental (`99ea7ee`: registro de cierre J3, gap register, roadmap; 3 archivos en `docs/`, 0 en código) |
| `main` local | `b5fd288` |
| Cierre efectivo de J3 | `docs/acceptance/R4_J3_CLOSURE_RECORD.md` §11: `J3_FINAL_STATUS=CLOSED_WITH_RESCOPED_ACCEPTANCE`, `J3_PRODUCTION_ROLLOUT=NOT_AUTHORIZED`, identidad del cliente asignada a J4. Roadmap: `J4 — Customer Profile` = **NEXT (no iniciado)** (`docs/roadmap/R4_DELIVERY_ROADMAP.md:44`) |
| Ramas no fusionadas relevantes | `r4-j3f-document-delivery-design` (ADR-038, diferida a R4 Media). Ninguna rama de J4 |
| Regresión ejecutada en esta auditoría (sin BD) | `test:contract` **329/329 PASS**; `test:unit` **1 025 PASS, 1 skip**. No se ejecutaron `integration`, `sales`, `shadow` ni `recovery` (requieren Postgres; `recovery` mantiene el fallo histórico GAP-15) |

Pendiente administrativo: `99ea7ee` no está en `main`. J4-R1 debería partir de `main` una vez fusionado ese commit documental, o declarar `99ea7ee` como base.

---

## 2. Inventario de capacidades y componentes reutilizables

### 2.1 Customer en R4 (R4)

| Componente | Estado | Evidencia |
|---|---|---|
| Puerto `CustomerDirectory.getContext(customerRef)` | Existe. Solo lectura, `null` = desconocido. Declara que el adaptador vivo "is pending: no contract … documented" | `adapters/domains/src/customer/port.ts:3-23` |
| `FixtureCustomerDirectory` | Dos clientes ficticios (`cust-demo-001/002`) | `adapters/domains/src/customer/fixture.ts:6-37` |
| Adaptador HTTP de Customer | **No existe** | `adapters/domains/` solo tiene `catalog/http`, `quote/http`, `shipping/http` |
| Capacidad `customer.get_context` v1 | Existe en el pack Sales; registrada **solo** en la composición de referencia con el fixture | `agents/sales/src/capabilities/customer.ts:29-51`; `agents/sales/src/composition.ts:50` |
| Registro en producción | **No registrada** en `@1`–`@7`: dominio Customer `UNAVAILABLE` | `agents/sales/src/production/profile.ts:31`; `profile-v7.ts:29`; `production/composition.ts:179` |
| Binding conversación → cliente | `sales.conversations.customer_ref` (nullable). En producción siempre `null` | `agents/sales/migrations/0006_sales_reference_application.sql:14-17`; `production/composition.ts:214-216` |
| Proyección de contexto | Solo expone `identity: provisional | unavailable` según haya `customerRef` | `agents/sales/src/workspace/context-source.ts:83` |
| `customer.get_purchase_history` | **No existe** | grep sin resultados |
| Scope `customer.read` | Declarado en las definiciones Sales | `agents/sales/src/ids.ts:25`; `sales.v7.agent.json:12` |
| Instrucción del modelo | `sales.v7.agent.json:7` menciona `customer.get_context`, que producción no ofrece (GAP-15, P3) | gap register GAP-15 |

### 2.2 Patrones reutilizables de Catalog, Shipping y Quote (R4)

| Patrón | Dónde | Reutilización en J4 |
|---|---|---|
| Configuración explícita, fail-closed, sin defaults de host; https obligatorio fuera de loopback; `R4_PROD_ALLOW_NETWORK`; timeout acotado | `adapters/domains/catalog/http/src/config.ts:30-49` | Copiar para `R4_CUSTOMER_*` |
| Descripción segura de config ("declared, not verified") | `catalog/http/src/config.ts:55-63` | Igual |
| Credencial Bearer por principal, ≥ 32 caracteres imprimibles | `adapters/domains/quote/http/src/config.ts:7,57-58` | Customer Profile implementa Bearer por principal (EXT-CP, §6) |
| Transporte puro: deadline `AbortSignal.any`, `x-correlation-id`, tope de respuesta (1 000 000 chars), `schemaVersion` fijado, validación zod, mapeo de estados a `DomainError`, telemetría sin cuerpos ni claves | `catalog/http/src/adapter.ts:46,57-67,106-147,168-176` | Plantilla directa del adaptador |
| Taxonomía de errores tipados (8 categorías; `unauthorized` y `contract_violation` nunca se reintentan) | `adapters/domains/src/shared/errors.ts:1-41` | Sin cambios |
| `domainRead`: `DomainError` → observación fallida estructurada | `agents/sales/src/capabilities/common.ts:38-47` | Sin cambios |
| `readDefinition`: READ, `maxAttempts: 1`, `timeoutMs` 10 000, `identityRequirement: none` | `common.ts:14-31` | Igual; el control de identidad vive en el handler (§4) |
| Perfil versionado e inmutable; dominio `REAL` exige `contractRef` documentado | `packages/live-ops/src/profile.ts:44,66-81`; huellas fijadas en `tests/contract/` | Nuevo `@8`; `@1`–`@7` intactos |
| Composición que rechaza arrancar con binding faltante | `production/composition.ts:118-122,137-142,147-151` | Mismo criterio para Customer `REAL` |
| Pin de versión de definición por perfil | `profile-v7.ts:80-93` | `sales-production@8 → definición 8` |
| Telemetría por llamada (`onCall`) cableada en CLI de producción | `agents/sales/src/cli/production.ts:96-99` | Igual |

### 2.3 Fronteras del harness que J4 **no** debe tocar (R4)

- `tests/contract/core-purity.test.ts:25` prohíbe el término `customer` en R4 Core.
- `packages/` y `apps/` quedan fuera de alcance: todo lo necesario cabe en `adapters/domains/customer/http` (nuevo) y `agents/sales` (§5.3).
- `ProductionStore.bindingByTask(taskId)` ya existe (`packages/live-ops/src/ports.ts:311`) y devuelve el `recipientRef` autenticado. Ya se inyecta en la composición Sales como `options.store` (`production/composition.ts:68,164`). No requiere cambio de harness.

---

## 3. Contratos Customer existentes y brechas

### 3.1 `customer.get_context` v1 (R4)

| Aspecto | Actual | ¿Compatible con Customer Profile? |
|---|---|---|
| Input | `z.strictObject({})`: el modelo no aporta identificador | **Sí.** Es la frontera correcta y se conserva |
| Origen del cliente | `sales.conversations.customer_ref` por `taskId` | **Parcial.** El dato es correcto, pero producción nunca lo llena y `bindConversation` es insert-once (`workspace/store.ts:140-147`): no admite una vinculación posterior durante la conversación |
| Output `identity` | `'unavailable'` (`anonymous`, `not_on_file`) o `'provisional'` (literal fijo) | **No.** No puede expresar `verified`, `not_linked`, `not_authorized` ni `owner_unavailable` |
| PII | `displayName`, `contact.email`, `contact.phone` | **No deseable.** Sin uso legítimo: la entrega por email está diferida a R4 Media y la cotización es `guest`. El email solo lo da el scope `customer.pii.read` de CP (EXT-CP) |
| `previousPurchases` | Arreglo **sin límite**, embebido en el contexto | **No.** Debe salir hacia `customer.get_purchase_history`, paginado y acotado |
| `productId` | Cadena libre | **No.** CP entrega `productId`/`productAttributeId` numéricos de PrestaShop (EXT-CP `src/domain/customer-purchased-products/contracts.ts:3-13`); R4 usa claves de Catalog (`P20`, `P20-V7`; `adapters/domains/src/catalog/port.ts:28`). R4 no debe derivar una clave de la otra (§7, D6) |
| `freshnessTtlMs` | 60 min | Demasiado largo si la vinculación o el grant pueden revocarse (D5) |
| `customerRef` del puerto | Cadena opaca | CP propone refs con namespace `prestashop_customer:<id>` (DOC, EXT-CP `docs/architecture/CP_R4_J4_MINIMUM_READINESS_PRD.md:44`) |

**Conclusión:** la forma de invocación de v1 es compatible y debe conservarse. Su salida no lo es. Como las definiciones son inmutables, la integración requiere `customer.get_context@2` y no un cambio de v1. v1 y el fixture siguen sirviendo a la composición de referencia, la evaluación y el shadow.

### 3.2 Contratos externos (EXT-CP, EXT-CRM, DOC)

| Contrato | Estado |
|---|---|
| CP `GET /v1/customers/:customerId/{profile,commercial-summary,purchased-products,purchase-behavior,orders/:ref/status}` | **IMPLEMENTADO** (EXT-CP `src/http/routes/index.ts:710-1449`). Indexado por `id_customer` numérico, sin namespace, sin control por cliente |
| CP `GET /v1/capabilities/customer/sales-context` y `/purchase-history` | **PROPUESTO**, "Nada … está implementado" (EXT-CP `docs/audits/CP_R4_J4_TARGET_CONTRACT_PROPOSAL.md:6`) |
| CP plan de proyección `sales-context` | **NO APROBADO**, sin versionar (EXT-CP `docs/reviews/CP_J4_CONTEXT_FIX_PLAN.md`) |
| CP PRD de readiness R4-J4 | **DRAFT v0.1**, no aprobado (EXT-CP `docs/architecture/CP_R4_J4_MINIMUM_READINESS_PRD.md:5`) |
| `customer.resolve` (canal → cliente) | **PROPUESTO** para CRM/Customer Service (EXT-CP proposal §2). **No existe** endpoint en CRM (EXT-CRM, §4.2) |
| Grant por cliente | **NO DISPONIBLE** en ningún componente (EXT-CP `docs/reviews/CP_J4_SECURITY_01_VALIDATION_REPORT.md:278`) |
| OpenAPI / JSON Schema publicado de CP | **NO DISPONIBLE** (EXT-CP: solo tipos TypeScript) |

---

## 4. Identidad, autorización individual y trust boundaries

### 4.1 Qué identidad tiene R4 hoy (R4)

1. **Identidad de canal autenticada.** El webhook de WhatsApp se autentica por firma HMAC del proveedor (`adapters/channels/whatsapp-cloud/src/inbound.ts:1,57`). El `wa_id` normalizado pasa a `conversationRef`/`senderRef` (`inbound.ts:105-112`). La ingress guarda `recipient_ref` (el `wa_id`) y un `conversation_key` HMAC (`packages/live-ops/src/ingress.ts:192-197`; `rollout.ts:14-16`; `packages/persistence-postgres/migrations/0007_governed_production.sql:50-52`). Solo la ingress abre bindings.
2. **Ninguna resolución de cliente.** R4 no traduce `wa_id` a cliente en ningún punto. `afterOpen` escribe `customerRef: null` (`production/composition.ts:214-216`). El nombre del perfil de WhatsApp no se lee (GAP-05).
3. **`identityAssurance` no describe al cliente en producción.** La tarea la pide `SALES_CHANNEL_INGRESS = { kind: 'service' }` (`production/composition.ts:45,212`). El contexto de acción se construye con `actor: task.requestedBy` e `identityAssurance: identityAssuranceOf(task.requestedBy)` (`packages/task-runtime/src/action-runtime.ts:288-298`). `identityAssuranceOf` devuelve `provisional` para todo principal no anónimo (`packages/contracts/src/capability.ts:139-145`). Por eso, en producción, toda acción Sales se evalúa con `provisional` aunque el cliente sea anónimo. Esto satisface trivialmente `minimumIdentity: 'provisional'` de `quote.create` (`production/profile.ts:61`). **Consecuencia para J4:** ni `identityAssurance` ni el principal de la tarea pueden usarse como evidencia de identidad del cliente. Corregirlo requiere el harness y queda fuera de J4 (riesgo R7).
4. **El input del actor es provisional.** La ingress usa como actor `user:<channel>:<conversationKey[0..32]>`, "a provisional participant reference" (`ingress.ts:210-211`).

### 4.2 Quién tiene autoridad para resolver canal → cliente verificado (EXT-CRM, EXT-CP, DOC)

**Ningún componente expone hoy esa resolución a un consumidor como R4.** No se inventa owner. Lo que existe:

| Componente | Rol real | Evidencia |
|---|---|---|
| **Customer Service** (externo, no auditado) | Autoridad **documentada** de creación y vinculación. CRM lo invoca (`POST /v1/customers/resolve`, `/v1/customers/{id}/external-identities`) | DOC: EXT-CRM `docs/data/customer-creation-linking-authority-contract.md:124`; EXT-CRM `lib/integrations/customer-service/http-adapter.ts:196,221-280` |
| **CRM** | Mantiene la proyección `customer_external_identity` y decide los niveles L0–L3 en su runtime, solo para su propio agente. No tiene endpoint de resolución consumible por R4 | EXT-CRM `lib/domains/customer-identity-verification/{evaluate,service}.ts`. El único endpoint de contexto (`/api/brain/context/resolve`) es de operador o token de orquestación y usa el resolver antiguo |
| **Customer Profile** | **No** resuelve identidad: consulta por `id_customer` | EXT-CP; su propia propuesta: "Customer Profile nunca resuelve teléfono, email ni wa_id" (proposal :13) |
| **R4** | No resuelve identidad | §4.1 |

Debilidades del mecanismo CRM que un contrato de resolución debería corregir antes de que R4 lo consuma (EXT-CRM, verificadas):

- **Vínculo automático no verificado.** Un `wa_id` nuevo con el mismo teléfono normalizado que otra fila se vincula automáticamente al cliente con `isVerified: false` (`lib/brain/native-whatsapp/service.ts:325-336`).
- **El nivel L2 no comprueba `is_verified`.** Se otorga ante cualquier vínculo de canal o evidencia de teléfono (`evaluate.ts:45-70`, `EXISTING_CHANNEL_LINK`, `PHONE_EVIDENCE_MASTER_CONVERGED`).
- **El recheck L3 tampoco comprueba `is_verified`.** Valida `customer_id` y no `is_verified` (`service.ts:80-95`), aunque las filas `prestashop` solo se escriben con `isVerified: true` tras `link_prestashop_identity`.
- **La prueba más fuerte es débil.** Basta con que el email y la referencia de pedido declarados apunten al mismo `ps_customer`, más un consentimiento por regex. No hay OTP ni confirmación de email (EXT-CRM `lib/domains/customer-identity/evidence.ts:49-53`; `consentEvidence.ts:17-45`).
- **CRM está en proceso de retiro.** Ver `docs/architecture/R4_CRM_LEGACY_DEPENDENCY_DECOMMISSION_AUDIT.md`. AGENTS.md prohíbe que R4 acceda a tablas internas de CRM.

### 4.3 Autorización individual (EXT-CP)

- **Autenticación.** CP tiene registro de principales con Bearer por consumidor, hashes SHA-256 y comparación `timingSafeEqual` (`src/http/auth/principal-registry.ts:20-43,136-143`), y scopes por familia de rutas (`route-families.ts:60-92`). El modo por defecto es `off`. `enforce` está marcado como BLOQUEADO en su informe de seguridad. El modo desplegado es **desconocido**.
- **Sin autorización por cliente.** Cualquier principal con `customer.facts.read` lee cualquier `customerId` (informe de seguridad CP :278). **Un token de servicio de R4 autorizaría hoy el acceso a cualquier cliente.** Es exactamente lo que el mandato prohíbe asumir.
- **Fuga de datos predictivos.** `commercial-profile` está bajo `customer.facts.read` pero devuelve RFM, cluster y CLV (`route-families.ts:66`; `customer-commercial-profile/contracts.ts:17-41`). R4 no debe consumirla.
- **Superficie expuesta.** CP escucha en todas las interfaces (`src/index.ts:136`). DOC: `*:3010` en EC2.

### 4.4 Trust boundaries propuestos (PROPUESTA)

```text
 Meta (firma HMAC) ──► ChannelIngress ──► binding(recipientRef = wa_id autenticado)   [confiable, solo ingress]
                                                │ bindingByTask(taskId)
 modelo ─► customer.get_context@2 {}  ──► handler Sales ──► resolver de identidad (owner externo) ──► {customerRef, assurance, grant}
 modelo ─► customer.get_purchase_history@1 {offset?,limit?}      │ solo assurance = verified
                                                                └─► Customer Profile (Bearer r4-sales + grant por cliente)
```

Reglas:

1. Ninguna capacidad Customer acepta identificadores de cliente, teléfono, email, `customerRef` ni cursores que codifiquen identidad. Los argumentos del modelo se validan con esquemas estrictos.
2. El sujeto proviene **solo** de `bindingByTask(taskId).recipientRef`. No proviene de inputs, transcript, workspace ni memoria. Esto no depende de ADR-036: un input inyectado por API no altera el binding.
3. **Solo `assurance = verified`** habilita datos privados (historial). `provisional` (p. ej., coincidencia por teléfono) se trata como `unavailable` para datos privados.
4. CP debe exigir **evidencia de acceso individual** (grant u otro mecanismo aprobado por los owners). El token R4 por sí solo no basta. R4 transporta esa evidencia, no la fabrica.
5. Fallo de resolución, de CP o de configuración → `identity: unavailable`. Nunca bloquea catálogo, despacho ni cotización `guest`.
6. 401/403 nunca se presentan como `not_found` (CP PRD :65): son `unauthorized`, se registran y no se reintentan.
7. Sin datos predictivos: R4 no consume rutas RFM/cluster/CLV/affinity/intelligence/commercial-profile/copilot/audiences.

---

## 5. Diseño propuesto del adaptador HTTP (PROPUESTA)

Condicionado a contratos externos congelados (§6). No se implementa contra contratos no publicados.

### 5.1 Paquete y puerto

- **Paquete:** `adapters/domains/customer/http` (`@r4-adapters/customer-http`), fuera de Core, con la estructura de `catalog/http`: `config.ts`, `schemas.ts`, `adapter.ts` y `fixtures/` con `MANIFEST.json` y `SOURCE.json` que fijen el SHA del contrato del owner.
- **Puerto:** puerto nuevo y aditivo en `adapters/domains/src/customer/`. `CustomerDirectory` v1 y su fixture no se tocan.

```ts
// PROPUESTA — forma, no código aprobado
interface CustomerIdentityResolver {          // owner: el que decidan D1/D2
  resolve(subject: { channel: string; accountRef: string; subjectRef: string }, o?: CallOptions):
    Promise<{ status: 'resolved' | 'unresolved' | 'ambiguous' | 'conflicted';
              assurance: 'none' | 'provisional' | 'verified';
              customerRef: string | null;       // solo con verified
              accessGrant: string | null;       // opaco, emitido por el owner; R4 no lo interpreta
              validUntil: string }>;
}
interface CustomerProfilePort {               // owner: Customer Profile
  getSalesContext(ref: string, grant: string, o?: CallOptions): Promise<CustomerSalesContext | { status: 'not_found' }>;
  getPurchaseHistory(ref: string, grant: string, page: { offset: number; limit: number }, o?: CallOptions): Promise<CustomerPurchasePage>;
}
```

### 5.2 Configuración, transporte y errores

| Elemento | Propuesta |
|---|---|
| Variables | `R4_CUSTOMER_MODE` (`real` o sin definir), `R4_CUSTOMER_BASE_URL`, `R4_CUSTOMER_BEARER_TOKEN` (≥ 43 caracteres según el registro de CP), `R4_CUSTOMER_TIMEOUT_MS` (100–5 000; sugerido 3 000, por debajo del `timeoutMs` 10 000 de la capacidad y del presupuesto de 2 500 ms de CP). Variables análogas para el resolver si su owner es otro servicio |
| Red | Mismas reglas que Catalog: sin credenciales en la URL, https fuera de loopback, `R4_PROD_ALLOW_NETWORK` |
| Headers | `authorization: Bearer`, `x-correlation-id` (CP aún no lo implementa: PENDIENTE), `accept: application/json`. Grant según el contrato |
| Mapeo | 400 → `validation`; 401/403 → `unauthorized` (fail closed, sin reintento; la capacidad responde `unavailable/not_authorized`); 404 de ruta y otros estados → `contract_violation`; 429/503/504/5xx → `temporarily_unavailable`; deadline → `timeout`; cuerpo inválido o `schemaVersion` ≠ fijado → `contract_violation`. "Cliente desconocido" llega como dato (200 + `status`), igual que en la propuesta de CP |
| Reintentos | `maxAttempts: 1` (lecturas, como Catalog). Sin reintentos dentro del adaptador. La siguiente llamada del modelo es el reintento |
| Tamaño | Tope de respuesta (sugerido 64 KB; Catalog usa 1 MB) y validación estricta de longitudes |
| Telemetría | `onCall` con operación, estado HTTP, duración, categoría/código, `correlationId`. **Nunca** `customerRef`, `wa_id`, grant ni cuerpo. Las rutas registradas usan plantillas, no ids. Las claves `token`/`accessToken` ya se redactan en el logger (`packages/observability/src/logger.ts:30-40`); `grant` debe agregarse por nombre de campo del adaptador, no en el harness |

### 5.3 Capacidades Sales (pack, no harness)

**`customer.get_context@2`** (READ, owner `customer`, scope `customer.read`)

- Input: `{}` estricto.
- Output:
  - `{ identity: 'unavailable', reason: 'anonymous' | 'not_linked' | 'not_verified' | 'not_authorized' | 'owner_unavailable' }`, o
  - `{ identity: 'verified', customer: { displayName: string | null, customerSince: string, hasPurchaseHistory: boolean } }`.
- **Sin email, teléfono, RUT ni dirección** (D4). Sin compras embebidas.
- `freshnessTtlMs` corto (sugerido 10 min, alineado con `validUntil` del resolver; D5).

**`customer.get_purchase_history@1`** (READ, mismo owner y scope)

- Input: `{ offset?: int 0–40, limit?: int 1–10 (default 5) }` estricto. Offset, no cursor: CP ya pagina por offset (EXT-CP `routes/index.ts:2343-2370`), y un cursor opaco podría transportar identidad.
- Output: `{ identity: 'verified', items: [{ productName (≤ 120), productRef (D6), lastPurchasedAt, totalQuantity, orderCount }], hasMore, nextOffset | null }`, o el mismo `unavailable` de `get_context@2`.
- **Sin montos gastados** (D4) ni datos derivados.
- **Tope de contexto:** como máximo 10 ítems por página y 50 en total por conversación. La observación debe caber en un límite fijo de caracteres (sugerido ≤ 3 000), que se verifica con tests.
- Semántica explícita "comprado históricamente ≠ posee hoy", siguiendo el `meaning` de la propuesta CP.

**Resolución de identidad (D3):** perezosa, dentro del handler, en cada llamada y a partir de `bindingByTask`.

- **Sin llamadas externas en `afterOpen`:** la ingress no queda acoplada a la disponibilidad de CRM, Customer Service o CP, y un fallo no deja inbound sin liquidar.
- **Sin migración:** no hace falta, porque `sales.conversations.customer_ref` sigue `null` y es insert-once. La alternativa de la propuesta CP (resolver en `afterOpen` y escribir `customer_ref`) congela la identidad al inicio e impide que una vinculación posterior surta efecto.
- **Registro del resultado:** si hay que registrar la resolución como evidencia, se requiere una migración Sales nueva (`0010`), a decidir en J4-R1.

**Versiones**

- Definición Sales v8: igual a v7 más las dos capacidades y la instrucción "solo datos de cliente verificados; no usar la historia para inferir posesión". Resuelve GAP-15.
- Perfil `sales-production@8`: igual a `@7` con Customer `REAL`, `contractRef` hacia el contrato congelado de CP, y las dos capacidades.
- Pin `@8 → 8`.
- La composición rechaza arrancar `@8` sin configuración Customer completa, igual que Catalog. En ejecución, cualquier fallo Customer degrada a `unavailable`.
- `@1`–`@7` y sus huellas no cambian.

---

## 6. Dependencias entre Customer Profile y R4

| # | Dependencia | Owner | Estado | Bloquea |
|---|---|---|---|---|
| X1 | Contrato de resolución canal → cliente con `assurance` (endpoint, esquema, auth) | CRM o Customer Service (D1) | **NO DISPONIBLE** (solo PROPUESTO en el repo CP) | J4-R3 en adelante |
| X2 | Corrección de las debilidades de verificación de §4.2 (`is_verified` ignorado, vínculo automático por teléfono) o declaración formal de qué nivel cuenta como `verified` | Owner de identidad | **NO RESUELTO** | X1 |
| X3 | Autorización individual en CP (grant o mecanismo equivalente) | CP + owner de identidad | **NO DISPONIBLE** | Historial y contexto privado |
| X4 | Endpoints `sales-context` y `purchase-history` (o rutas existentes aprobadas para R4) con `schemaVersion`, esquema publicado y fixtures | CP | **PROPUESTO / plan no aprobado** | J4-R2 |
| X5 | CP en modo `enforce` en el despliegue objetivo, con principal `r4-sales` limitado al scope mínimo (sin `pii.read` ni `analytics.read`) | CP / operación | **BLOQUEADO** según su informe | J4-R5 |
| X6 | Correlation id entrante, 503/504 tipados y rate limit en CP | CP | **NO IMPLEMENTADO** (informe de seguridad CP §8.4) | Observabilidad J4-R5 (no bloqueante para R2) |
| X7 | Restricción de red de CP (`*:3010`) | Operación | **PENDIENTE** | J4-R5 |
| X8 | Mapeo de producto PrestaShop → clave Catalog | Catalog o CP (D6) | **NO DEFINIDO** | Historial enlazable a Catalog |
| X9 | Repositorio y contrato de Customer Service | Customer Service | **No auditado** (sin checkout local) | D1 |

Lo que R4 aporta a los owners: el `wa_id` autenticado, `accountRef`, el canal, un correlation id y la garantía de que el sujeto viene de la ingress y nunca del modelo.

---

## 7. Matriz de riesgos, bloqueos y decisiones pendientes

### 7.1 Bloqueos

| ID | Bloqueo | Resuelve |
|---|---|---|
| B1 | No hay owner que exponga resolución canal → cliente verificado (X1, X9) | Decisión D1 + contrato publicado |
| B2 | Un token de servicio de CP lee cualquier cliente (X3) | Mecanismo de grant aprobado e implementado por CP |
| B3 | No hay contrato CP congelado para R4 (X4) | Freeze de CP con SHA, esquemas y fixtures |
| B4 | CP sin `enforce` confirmado en el despliegue objetivo (X5, X7) | Operación CP |

### 7.2 Riesgos

| ID | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | Revelar historial al titular de un número reciclado o compartido (verificación por teléfono) | Media | Alto (privacidad) | Solo `verified` (§4.4.3); X2 |
| R2 | El modelo induce la consulta de otro cliente | Baja con el diseño | Alto | Inputs sin identidad; tests negativos (§9.1) |
| R3 | PII o historial persistidos indefinidamente en observaciones R4: no hay retención ni purga (grep sin resultados en `packages/`, `apps/`, `agents/sales/src`) | Alta | Medio | Minimización (D4); política de retención (D7) |
| R4 | `displayName` visible para jueces de evaluación: `redactKeys` = email, phone, rut, address (`agents/sales/src/evaluations/definition.ts:54`; `tests/unit/evaluation/privacy-regression.test.ts:33`) | Alta | Bajo-medio | Decidir redacción de `displayName` en v8 (D4) |
| R5 | Uso de rutas CP con datos predictivos (`commercial-profile` bajo `facts.read`) | Media | Medio | Allowlist de rutas en el adaptador y test |
| R6 | Desbordamiento de contexto o tokens por el historial | Media | Medio | Topes §5.3 y presupuesto del run (J4.5 reevalúa eficiencia) |
| R7 | `identityAssurance = provisional` en toda acción de producción (§4.1.3) da una falsa sensación de identidad | Ya presente | Medio | No usarlo en J4; registrar para J7/harness (no se corrige en J4) |
| R8 | Dependencia de CRM para identidad mientras CRM se retira; AGENTS.md prohíbe acceso a tablas CRM | Media | Alto | D1: preferir Customer Service u owner sobreviviente; R4 nunca lee MariaDB |
| R9 | Latencia adicional (resolver + CP) en cada lectura Customer | Media | Bajo | Timeouts cortos; una sola llamada a CP por capacidad; resolución cacheable por `validUntil` solo si se decide (D5) |
| R10 | Contrato CP cambia sin aviso (`schemaVersion` ausente hoy en rutas v1) | Media | Medio | Fijar `schemaVersion`; `contract_violation` sin reparación |

### 7.3 Decisiones pendientes (owner o arquitectura)

| ID | Decisión | Recomendación |
|---|---|---|
| D1 | Owner del resolver de identidad para R4: Customer Service, CRM o CP como fachada | El owner documentado de vinculación (Customer Service), sin depender de CRM en retiro. **No decide R4** |
| D2 | Forma de la autorización individual: grant opaco emitido por el resolver y verificado por CP, o verificación de CP contra el owner de identidad | Grant opaco de vida corta, ligado a `customerRef`, sujeto de canal y propósito; R4 solo lo transporta |
| D3 | Resolución perezosa en el handler o en `afterOpen` | Perezosa (§5.3) |
| D4 | Minimización: qué campos ve el modelo (email, teléfono, montos, `displayName`) | Solo `displayName` (redactado ante jueces), `customerSince` y la historia del §5.3 |
| D5 | Frescura y revocación del grant y de la resolución | TTL ≤ 10 min; resolver de nuevo en cada llamada salvo decisión explícita |
| D6 | Identificador de producto del historial | Que CP devuelva la clave Catalog o que Catalog publique el mapeo. R4 no lo deriva |
| D7 | Retención de observaciones con datos de cliente | Definir antes de J4-R5; si exige harness, pasa a J7 |
| D8 | Si un dato declarado por el cliente (GAP-05) entra en J4 | No: J4 = solo datos verificados; GAP-05 sigue aparte |

---

## 8. Plan J4-R1 a J4-R6 (PROPUESTA)

Cada fase requiere autorización explícita. Ninguna toca `packages/`, `apps/`, `adapters/channels` ni `adapters/models`; las huellas `@1`–`@7` deben seguir intactas.

| Fase | Alcance | Puerta de entrada | Criterios de aceptación verificables |
|---|---|---|---|
| **J4-R1 — Diseño y freeze** | ADR-039 "Customer identity and profile consumption" (trust boundaries §4.4, D1–D8 resueltas o explícitamente diferidas); especificación del consumidor R4 enviada a los owners; acta de los contratos externos congelados | Autorización de J4-R1 | ADR aceptado por el owner; cada contrato externo referenciado por repo + SHA + versión de esquema; tabla de D1–D8 con decisión; `git diff` sin cambios fuera de `docs/` |
| **J4-R2 — Adaptador CP** | `adapters/domains/customer/http`: config, esquemas, adaptador, fixtures copiados del owner con `SOURCE.json`; puerto `CustomerProfilePort`; sin binding productivo | B3 resuelto | Contract tests de config (fail-closed), mapeo de los 8 tipos de error, `schemaVersion` y tope de tamaño; allowlist de rutas (rechaza RFM/analytics); test de que la telemetría no contiene ref, grant ni cuerpo; mutaciones que fallan al quitar cada guarda; `core-purity` verde |
| **J4-R3 — Resolver de identidad** | Adaptador del resolver (owner D1); resolución perezosa desde `bindingByTask` | B1, B2 resueltos | Solo `verified` produce `customerRef`; `provisional`/`ambiguous`/`conflicted`/fallo → `unavailable`; el sujeto proviene solo del binding (test con input de API inyectado y transcript manipulado); sin llamada externa en ingress |
| **J4-R4 — Capacidades y perfil** | `customer.get_context@2`, `customer.get_purchase_history@1`, definición v8, `sales-production@8` (no desplegado), composición fail-closed, evaluación de privacidad | R2 + R3 | Esquemas estrictos sin identificadores; topes de tamaño probados; `@8` compone solo con config completa; fallos Customer no impiden catalog/shipping/quote `guest` (integración); huellas `@1`–`@7` sin cambios; evaluación con redacción decidida en D4 |
| **J4-R5 — Integración y canary aislado** | E2E local contra el despliegue de **integración** de CP y del resolver; canary aislado en EC2 con autorización explícita (sin canal real, sin producción) | B4 + autorización EC2 | Cliente verificado ve su historial; no verificado, anónimo o con grant ajeno → `unavailable`; 401/403 reales → `unauthorized`; CP caído → la cotización `guest` se emite igual; evidencia etiquetada (no fixtures como evidencia productiva) |
| **J4-R6 — Aceptación y rollback** | Ensayo de rollback `@8 → @7`; registro de aceptación; gap register actualizado | R5 PASS | Rollback sin ejecuciones huérfanas de capacidades Customer; `@7` intacto; regresión completa con resultados reales (incluido el estado de GAP-15); **sin rollout productivo** (sigue en J7) |

---

## 9. Pruebas requeridas

### 9.1 Seguridad

- Las capacidades Customer rechazan cualquier argumento con identificador (`customerRef`, `customerId`, `phone`, `email`, `waId`, cursor libre): `strictObject` más un test negativo por campo.
- El sujeto se toma solo de `bindingByTask`. Un input por `POST /v1/tasks/:id/inputs` o un texto del cliente con otro número o email no cambia el cliente consultado.
- `assurance ≠ verified` nunca llega a CP para datos privados (test con un CP espía: 0 llamadas).
- Ausencia de grant → no se llama a CP. 401/403 → `unauthorized`, no `not_found`, sin reintento.
- Allowlist de rutas: ninguna ruta RFM/cluster/CLV/affinity/intelligence/commercial-profile/copilot/audiences es alcanzable desde el adaptador.
- Logs y telemetría sin token, grant, `wa_id`, `customerRef` ni cuerpo (con un patrón como el de `production.ts:277`).
- Proyección de evaluación: email, teléfono y RUT redactados; `displayName` según D4.
- Mutaciones: quitar la verificación de `assurance`, el uso de `bindingByTask` o el tope de tamaño debe romper al menos un test.

### 9.2 Integración

- Adaptador contra fixtures del owner (todas las ramas de estado y error).
- Composición `@8`: config incompleta → rechazo; config completa → registra exactamente las capacidades del perfil.
- Runtime real (Postgres): conversación con cliente verificado, anónimo, `provisional` y owner caído.
- E2E contra el despliegue de integración de CP y del resolver (J4-R5), con evidencia etiquetada.

### 9.3 Regresión (J1–J3 sin Customer Profile)

- Huellas `@1`–`@7` y hashes de política sin cambios (`tests/contract/sales-*`).
- `@7` sigue sin registrar capacidades Customer y compone sin `R4_CUSTOMER_*`.
- Con `@8` y CP no configurado, caído, lento o devolviendo 403: `catalog.search`, `shipping.quote`, `quote.preview@3` y `quote.create@5` (`guest`) siguen funcionando. La cotización nunca depende de Customer.
- Suites `build`, `lint`, `typecheck`, `unit`, `contract`, `integration`, `sales`, `shadow` y `recovery`, sin ejecutar `recovery` en paralelo con otras pruebas. Reportar el fallo GAP-15 tal como está.

**Evidencia de continuidad actual (R4):** `@1`–`@7` no registran Customer y la composición no lo exige (`production/composition.ts:179-189`). La cotización se emite con `customer: { kind: 'guest' }` (`agents/sales/src/capabilities/commercial-snapshot.ts:218,233`; PC-000006 en el canary J3, DOC). Contract y unit pasan en esta auditoría (§1). Por lo tanto, hoy J1–J3 operan sin Customer Profile por construcción. El riesgo nace con `@8`, y lo cubren las pruebas anteriores.

---

## 10. Dictamen

```text
J4_R0_STATUS=READY_WITH_BLOCKERS
J4_R1_STARTABLE=YES (solo diseño, ADR y freeze; no requiere contratos externos)
J4_R2_TO_R6=BLOCKED_BY B1 B2 B3 B4
CUSTOMER_IDENTITY_OWNER_FOR_R4=NONE_EXPOSED (autoridad documentada de vinculación: Customer Service; no auditado)
CP_PER_CUSTOMER_AUTHORIZATION=NOT_AVAILABLE
CP_R4_CONTRACT=PROPOSED_NOT_IMPLEMENTED
CUSTOMER_GET_CONTEXT_V1=INPUT_COMPATIBLE / OUTPUT_INCOMPATIBLE → requiere @2
J1_J3_WITHOUT_CUSTOMER_PROFILE=OPERATIONAL (por construcción; verificado en código y en contract/unit)
PRODUCTION_CHANGES=NONE
```

**Justificación.** El lado R4 está listo: tiene la frontera correcta (capacidad sin argumentos, sujeto desde un binding autenticado), patrones de adaptador probados y versionado inmutable. Además, `bindingByTask` permite resolver sin tocar el harness. Lo que falta está fuera de R4 y es bloqueante para la integración real:

- un owner que exponga la resolución verificada de identidad;
- autorización individual en Customer Profile;
- un contrato CP congelado;
- `enforce` en el despliegue.

Implementar el adaptador o las capacidades antes de que existan esos contratos sería implementar contra contratos supuestos, lo que el mandato prohíbe. J4-R1 puede comenzar con autorización explícita; las fases R2–R6 solo cuando se levante su bloqueo correspondiente.
