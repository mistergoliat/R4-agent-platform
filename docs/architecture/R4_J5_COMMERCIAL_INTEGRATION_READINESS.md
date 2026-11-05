---
title: R4-J5 — Preparación de la integración comercial (compra desde WhatsApp)
status: for-owner-review
mandate: R4-J5-COMMERCIAL-INTEGRATION-READINESS
date: 2026-11-02
---

# R4-J5 — Preparación de la integración comercial

Mandato `R4_J5_COMMERCIAL_INTEGRATION_AUDIT_AUTHORIZED`. Auditoría de **solo lectura** de los repositorios y contratos
reales. Objetivo: determinar qué falta para completar una compra desde WhatsApp con los microservicios existentes, y
proponer un roadmap ejecutable.

```text
R4_J5_COMMERCIAL_INTEGRATION_PLAN_READY_FOR_REVIEW
PURCHASE_FROM_WHATSAPP            NOT_POSSIBLE_TODAY
FIRST_BLOCKING_LINK               quote.create no está habilitado en producción (@3); Quote V2 no desplegado para clientes
LONGEST_DEPENDENCY_CHAIN          owner e-commerce / PrestaShop (DEP-3, D3, OD-02, llaves Webservice, transportista de retiro)
NO_CODE_CHANGED / NO_PROD_CHANGES / NO_PAYMENTS / NO_MODEL_CALLS / NO_TEST_SUITES_RUN
```

## Adenda — decisión del owner (2026-11-02, mandato `R4_J5_F0_AUTHORIZED`)

Prevalece sobre el texto del informe. Detalle en el [registro de decisiones](R4_J5_F0_OWNER_DECISION_RECORD.md).

| Tema | Decisión |
|---|---|
| C-1 Descuentos | La primera compra controlada no incluye descuentos. La representación de descuentos en Quote requiere una decisión posterior |
| C-2 Carrito | Quote V2 crea idempotentemente el carrito técnico PrestaShop. Checkout no crea carritos ni recalcula cotizaciones |
| C-3 Roadmap | J5 conserva Sales Autonomy y R4-L conserva Checkout y pagos. F0–F8 es transversal y no reemplaza la estructura del roadmap |
| D-07 / OD-06 | **Siguen abiertos.** La cancelación interna de Checkout no basta por sí sola para garantizar la expiración efectiva del enlace. Se mantiene el requisito estricto de 15 minutos. Se rechaza la recomendación de §4 |
| F0 | Autorizado: trabajo documental y contractual (A7, H3, OpenAPI `/v1`, dependencias e-commerce, responsables, preparación de F1/F2). G0 sin aprobar. Sin despliegues |

## 0. Alcance y método

| Repositorio | Referencia auditada | Observaciones |
|---|---|---|
| R4-agent-platform | `main` `52a58f4` | Producción: `sales-production@3` (definición v4), rollout 0 %, guard `observe` |
| MS-pesaschile-quote-service | `main` `1a56440`; PR #26 (A10) `0d216db` abierto | |
| MS-pesaschile-checkout | `main` `f6c2a11` (sólo baseline); rama `pay-02b` `36a2378` | **Sin remoto git**; todo el trabajo está en ramas locales lineales |
| MS-pesaschile-customer-identity-authority (CIA) | `main` `7525395` | Sólo modo sintético |
| MS-pesaschile-customer-profile (CP) | `main` `bbd766e` | |
| MS-pesaschile-catalog-service | `main` `a7240bf`; ramas de cutover sin fusionar | |
| Shipping (pc-carrier) | Sin repositorio fuente | Evidencia: R4-J2A, ADR-032, adaptador R4 y fixtures |
| PrestaShop 8.2.3 | POC CART-02A, validación PS-WS01 (tienda local aislada) | Sin escrituras contra la tienda productiva |
| Mercado Pago | Adaptador de Checkout y evidencia sandbox PAY-03S1 | Sin operaciones reales |
| CRM-Customer-360 | `develop` `8298723` (sólo lectura, para buscar reutilización) | No tiene integración de pagos reutilizable |

No se modificó código ni se ejecutaron suites, despliegues, pagos ni llamadas a modelos. No se hicieron llamadas de red
a servicios. Las cifras de pruebas son las registradas en los informes de cada repositorio, o un conteo estático de
archivos cuando así se indica. Lo no verificado se marca **UNKNOWN**.

### 0.1 Escala de estados

| Nivel | Significa |
|---|---|
| **Implementado** | El código existe en `main` del repositorio dueño. Si sólo está en ramas, se indica *rama* |
| **Integrado** | Está conectado con su consumidor o proveedor real, no con un doble |
| **Probado offline** | Tiene pruebas automatizadas con resultados registrados (dobles, base local, tienda local) |
| **Desplegado** | Corre en producción, no en una instancia de integración ni en un sandbox aislado |
| **Habilitado para el agente** | La capacidad está registrada en el perfil productivo de Sales (`@3`) |
| **Validado E2E** | Se ejercitó de punta a punta por WhatsApp real dentro del flujo de compra |

Que un endpoint exista no cuenta como terminado.

## 1. Conclusión

1. **Hoy no se puede completar una compra desde WhatsApp.** El agente productivo (`@3`) llega a catálogo y despacho, pero
   no cotiza: `quote.create` no está registrado en `@3`. Ninguna pieza posterior (identidad real, carrito, pago, orden)
   está desplegada.
2. **La mayor parte de la lógica difícil ya existe, inactiva o en sandbox:**
   - emisión de cotizaciones idempotente (Quote V2, contrato 2.0.0 congelado);
   - carrito técnico idempotente con precios fijados por línea (CART-02B, inactivo);
   - enlace Mercado Pago con TTL ≤ 15 min, webhook firmado, conciliación e idempotencia de pago (Checkout, ramas);
   - vinculación de identidad WhatsApp ↔ cuenta PrestaShop por OTP (CIA, sintético).

   **Lo que falta es, sobre todo, conexión, contratos aceptados, decisiones del owner y piezas en PrestaShop.**
3. **Cuello de botella:** cinco dependencias del camino crítico son del owner e-commerce / PrestaShop:
   - endpoint de proveedor de cuentas para CIA (DEP-3);
   - endpoint gobernado de totales del carrito (D3);
   - módulo y estado de entrada de la orden (OD-02);
   - llaves Webservice dedicadas;
   - transportista de retiro (O-10).
4. **Primer escenario recomendado:** retiro en tienda (costo 0), un SKU simple, comprador interno con cuenta PrestaShop
   registrada y dirección existente, en una conversación con allowlist. Así se evitan los tres bloqueos que no dependen
   de la compra:
   - despacho no representable en el carrito (H1);
   - promoción de $1 sin contrato;
   - creación de cuentas y direcciones para compradores nuevos.
5. **Hay tres contradicciones entre el mandato y el código** (§4: descuentos en Quote, dueño del carrito, nombre de
   la fase). El owner las resolvió el 2026-11-02 (ver la Adenda).
6. **Riesgo inmediato fuera del flujo de compra:** el catálogo que usa el agente productivo lee una copia desactualizada
   de la base de la tienda. El owner ya rechazó esa fuente como autoridad comercial (§3.2). Antes de cualquier compra
   real, los precios y el stock deben salir de la tienda viva.

## 2. Matriz de estados

| Servicio | Implementado | Integrado | Probado offline | Desplegado | Habilitado agente (`@3`) | Validado E2E |
|---|---|---|---|---|---|---|
| R4 Sales hasta la cotización | SÍ | PARCIAL | SÍ | PARCIAL (sin Quote) | PARCIAL (catálogo y despacho) | NO (GAP-14: ningún perfil que cotiza pasó por WhatsApp real) |
| R4 Sales: compra (carrito, pago, orden) | NO | NO | NO | NO | NO | NO |
| Catalog (proceso actual) | SÍ | SÍ | SÍ | SÍ (fuente desactualizada) | SÍ | PARCIAL |
| Catalog V2 / Discover | SÍ (main) | NO (consumidor R4 en rama) | SÍ | NO (`CUTOVER_GO=NO`) | NO | NO |
| Shipping (pc-carrier, lectura) | SÍ | PARCIAL (R4→Quote sí; →carrito no) | SÍ | SÍ | SÍ | PARCIAL (lectura real; dentro de cotización, carrito u orden: no) |
| CIA | SÍ (sintético) | PARCIAL (sintético) | SÍ | NO | NO (sólo `@8`) | PARCIAL (canary sintético; `J4_R6_BLOCKED`) |
| Customer Profile | SÍ (sintético) | PARCIAL (sintético) | SÍ | PARCIAL (versión anterior a J4, sin grants) | NO | PARCIAL (sintético) |
| Quote V2: emisión | SÍ | PARCIAL (adaptador R4; instancia de integración) | SÍ | NO (no apto para clientes reales) | NO | NO (una emisión en canary aislado `@7`) |
| Quote V2: carrito técnico | PARCIAL (inactivo, sin ruta) | NO | SÍ (+POC en tienda local) | NO | NO | NO |
| Checkout | NO en `main`; PARCIAL en ramas | NO | SÍ (920/920 en `14b96a3`; `pay-02b` sólo focal) | PARCIAL (sandbox aislado) | NO | NO |
| PrestaShop: carrito y orden por Webservice | n/a (núcleo nativo) | NO | SÍ (tienda local 8.2.3) | NO (sin llaves ni módulo de orden decidido) | NO | NO |
| Mercado Pago | SÍ (en Checkout, ramas) | PARCIAL (sandbox) | SÍ (dobles) | NO (sólo sandbox) | NO | NO (un pago sandbox fuera del flujo comercial) |
| WhatsApp (canal) | SÍ (sólo texto) | SÍ | SÍ | SÍ | SÍ | PARCIAL (conversación; sin política de enlaces de pago) |

## 3. Evaluación por servicio

### 3.1 R4 Sales

**Implementado (main `52a58f4`).**
- Definiciones Sales v3–v8 y perfiles `@1`–`@8`. La fijación perfil→definición está en `agents/sales/src/production/profile-v8.ts:124-133`.
- Lecturas:
  - `catalog.search`, `catalog.get_product_context`;
  - `shipping.quote` (`basis=reference|order`);
  - `quote.preview@2/@3` (TTL 15 min);
  - `customer.get_context@3`, `customer.get_purchase_history@2`;
  - `identity.verification_status@1`.
- Escrituras gobernadas:
  - `sales.workspace.update`: REVERSIBLE_WRITE;
  - `quote.create@1..@5`: IRREVERSIBLE_WRITE. La clave de ejecución es la `Idempotency-Key` de Quote y la conciliación usa su lookup;
  - `identity.start_verification`: EXTERNAL_COMMUNICATION.
- Límites de autonomía de cotización y kill switch (`autonomy-limits.ts`).
- Confirmación determinista de la oferta (`offerMessage`, J3E-C).
- Captura OTP en el gateway (SEC-OTP, ADR-040).

**Perfiles.**

| Perfil | Dominios REAL | Cotiza | Estado |
|---|---|---|---|
| `@3` | Catalog y Shipping | No | Producción |
| `@4` | + Quote | Con aprobación humana | — |
| `@5`–`@7` | + Quote | Autónoma, dentro de límites | — |
| `@8` | + Customer + CIA (sintéticos) | Autónoma, dentro de límites | No desplegado |

v9/`@9` están retirados. v10 y v11 están planificados, pendientes de G-sem.

**Falta para la compra.** No hay código de carrito, checkout, pago, Mercado Pago ni orden en `agents/`, `adapters/`,
`packages/` ni `apps/`. Faltan:
1. una capacidad de aceptación de compra;
2. un adaptador de Checkout y una capacidad que inicie la compra y devuelva el enlace;
3. lectura del estado de pago y de la orden;
4. un mensaje de enlace renderizado por la plataforma (una URL escrita por el modelo no es confiable);
5. la política FINANCIAL;
6. una definición y un perfil nuevos.

`quote.create` siempre envía un cliente `guest` (`commercial-snapshot.ts:218`). R4 nunca expone `customerRef` al modelo,
y así debe seguir.

**Dependencias.** Quote V2 en producción con A10 (PR #26 de Quote + PR #32 de R4, en lockstep). CIA y CP reales (J7).
Checkout.

**Bloqueos.**
- Según `configuration.ts:66-69`, FINANCIAL exige aprobación e identidad *verificada* por defecto.
- BLK-AP1: ningún perfil con `REQUIRE_APPROVAL` puede atender clientes reales hasta *Approval Horizon Hold* (R7-3, sin implementar).
- La autonomía de cotización (ADR-034/035) está aceptada sólo para canary.
- Gates J3/J7 abiertos (GAP-01…17).
- La confiabilidad conversacional de `@8` (F-1, G-sem) sigue pendiente.

**Pruebas.** Último registro post-merge (`db3fdec`):

| Suite | Resultado |
|---|---|
| unit | 1531 (4 skip) |
| contract | 462/462 |
| integration | 691 (12 skip) |
| sales | 29/29 |
| shadow | 5/5 |
| recovery | 18/18 |

Hay **0 pruebas de checkout, pago o carrito**. El gate financiero F-1..F-7 está definido (`R4_TEST_STRATEGY_02.md` §6.1),
pero sus pruebas no existen (RR-6).

**Activación productiva.** Requiere:
- autorización de fase;
- capacidades y adaptadores fuera de Core;
- un perfil nuevo;
- una ADR de política FINANCIAL;
- Quote productivo con A10;
- CIA real;
- gate F-1..F-7 en L3 sobre el SHA desplegado;
- GAP-14 cerrado;
- runbook de rollback ensayado y despliegue por SHA explícito.

### 3.2 Catalog Service

**Implementado e integrado.** El adaptador R4 (`adapters/domains/catalog/http`) usa `POST /v2/catalog/search` y los
contextos de producto e ítem, con contrato `catalog-commercial-v2`, `schemaVersion 1`. Está REAL en `@2`/`@3` desde el
2026-09-30. El peso (`facts.weightKg`) alimenta a Shipping con `basis=order`. Catalog V2 Discover está implementado en el
`main` del catálogo, y su consumidor R4 sólo existe en una rama sin fusionar.

**Faltante y bloqueos.**
- **El proceso que sirve a R4 lee una copia antigua de la base de la tienda, no la base viva.**
  - Paridad medida: 14/25 contra la copia y 23/25 contra la tienda.
  - Hay productos que el catálogo ofrece y que dan 404 en la tienda.
  - El owner decidió `V1_COMMERCIAL_AUTHORITY=REJECTED`.
- Cutover a V2: `CUTOVER_GO=NO`, `CATALOG_V2=NOT_DEPLOYED` (2026-11-02). Discover: `DISCOVER_QUALITY=NOT_ACCEPTED` y el contrato no está publicado.
- **R4 se rompe en el cutover.** El proceso actual se apaga y la llave actual no vale en el nuevo, así que R4 debe re-enlazarse antes o durante.
- Brechas R4 G-1..G-4: URL propia de Discover, rebase de la rama, manifiesto fijado, `Retry-After` en 429.
- Los fixtures vendorizados de R4 divergieron (4 fixtures y el MANIFEST).
- `CART_TOTAL_PARITY` y `CUSTOMER_SPECIFIC_PRICE_PARITY` están sin verificar.
- R4-J1 sigue formalmente abierto.

**Pruebas.**
- Repositorio del catálogo: 3984/3984 en `main` y 4082/4082 en las ramas de cutover.
- R4: unit y contract en verde. Los 12 casos `catalog-http-real` se omiten (requieren un catálogo real).

**Activación** (para la compra). Precio y stock deben salir de la base viva de la tienda. Hay dos caminos:
- **cutover V2:** cerrar B-1..B-9, obtener `CUTOVER_GO=YES` y re-enlazar R4;
- **decisión interina del owner:** acotada a un conjunto de SKUs con paridad verificada.

### 3.3 Shipping (pc-carrier)

**Implementado.**
- Cliente estructuralmente limitado a `GET /location` y `GET /carrier/v1/all`. Las rutas de escritura del mismo host son inalcanzables.
- El adaptador conserva el NETO del owner y deriva el bruto con `cl-iva-19@r4-j2b`.
- `ownerValidUntil = null`: pc-carrier no entrega id de cotización ni vigencia.
- `quote.create`/`preview` re-cotizan y rechazan `shipping_offer_changed`/`shipping_tax_changed`.
- Despliegue: REAL en `@3`. ADR-032 y `R4-J2_SHIPPING_ROLLOUT.md` todavía dicen «despliegue pendiente»: están desactualizados.

**Faltante.**
- La promoción de $1 (tramo 120.000–499.990) no tiene contrato: no hay bandera, motivo de elegibilidad ni lista de comunas.
- No está decidido si la base de la promoción es neta o bruta (R4 envía `total_boleta` bruto).
- Dimensiones fijas 1×1×1.
- Una caída del transportista se ve igual que «sin cobertura».
- **No hay mapeo de oferta pc-carrier → transportista PrestaShop (`id_reference`):** R4 no envía `carrier.code` y el mapa versionado que exige CART-00 no existe.

**Bloqueo para la compra.** Quote responde `NOT_READY SHIPPING_NOT_REPRESENTABLE` (H1) a toda cotización con despacho.
Sólo existe el alcance S3: retiro con costo 0, `pickup-zero-v1`, con el transportista de retiro aún sin designar (O-10).
S1 y S2 están sin decidir y dependen del inventario de `ps_logistics` y de los transportistas.

**Pruebas.** R4: 29 adapter + 10 capability + 7 IVA + 3 contract (sobre todos los fixtures) + 17 del perfil `@3`. No hay
pruebas vivas ni de integración contra pc-carrier.

**Activación** (despacho dentro de la compra):
- contrato semántico Shipping↔Quote resuelto;
- decisión S1/S2 y mapa de transportistas con dueño;
- Sales v10/v11 en lugar de v4. v4 puede llamar al $1 «tarifa real del transportista».

### 3.4 Identidad: Customer Identity Authority (CIA)

**Autoridad existente.** La CIA es la autoridad de identidad designada (ID-AUTHORITY-DECISION-01 §2.2; owner designado
en CIA-D1-01). **No se debe crear otra.** Tras un OTP por correo produce
`customerRef = prestashop_customer:<id_customer>`, el mismo valor que el `sub` del grant. El vínculo es por
(`whatsapp`, `channelAccountRef`, `wa_id`).

**Implementado (S1–S4).**
- Desafío OTP por correo con idempotencia y outbox.
- Proveedor de cuentas remoto, probado sólo contra un doble.
- Vínculos canal→cuenta con correo cifrado, revalidación y revocación.
- Grants ES256 con TTL ≤ 300 s y JWKS.
- Contrato `v1-d2`, aceptado sólo para interoperabilidad sintética.

**Endpoints.** Todos `POST`, con bearer por principal:
- `/v1/identity/verifications`;
- `/v1/identity/verifications/confirm` (sólo integración de canal);
- `/v1/identity/resolve`;
- `/v1/identity/links/revoke`.

Además, `GET /.well-known/jwks.json`.

**Faltante.**
- `config.ts` rechaza cualquier modo que no sea sintético.
- No existe proveedor de cuentas PrestaShop real. El endpoint de lectura del proveedor es CANDIDATO y no está construido (DEP-3).
- Sin credencial (DEP-2), correo real (DEP-5), KMS (DEP-6) ni retención o aspectos legales (DEP-10).
- Una sola instancia, con rate limit en memoria. Sin lista de revocación (OD-CIA-4).
- **No crea cuentas.** El contrato §1 asigna la creación a Checkout.
- **No tiene direcciones.**
- Sólo vincula cuentas existentes, activas y no invitado. Un comprador nuevo recibe `no_eligible_account`.
- **El grant de compra no existe:** el carrito exige propósito `purchase` y audiencia `quote-cart-preparer` (H3). Soportar una segunda audiencia requiere un cambio de código en la CIA.

**Pruebas.** 345/345 (rama D2 `35528b9`; `main` sólo agrega documentación) y 30/30 fixtures de grant. En R4:
`identity-http-contract` 23/23, campaña R4→CIA→CP 23/23 y SEC-OTP 41/41 ×3.

**Activación.**
- J7-CP-04/05 y DEP-*/OD-CIA-* cerrados.
- Modo productivo en `config.ts`.
- Despliegue con varias instancias o rate limit compartido.
- Propósito `purchase` (H3).
- Autorización explícita.

### 3.5 Customer Profile (CP)

**Implementado.**
- `POST /v1/capabilities/customer/sales-context`, contrato `customer-sales-context-v1-rc2` (CANDIDATO).
- Verificador de grant CIA, con modo `disabled` por defecto.
- Productor de hechos **sólo sintético**.

**Faltante.**
- **CP no tiene direcciones, comunas ni carritos.**
- No hay fuente real (J7-CP-01/02).
- Debt L-1: un grant que vence durante la composición devuelve 500.
- G-16 sin firmar. AP-01..11.
- La producción corre una versión anterior a J4.

**Pruebas.** 3050 PASS (10 skip), contratos 50/50 y 263/263, interop 15/15 ×5.

**Rol en la compra.** **No está en el camino crítico.** CP sólo aporta contexto comercial, no identidad ni direcciones.
Sus gates bloquean la personalización (J5 Sales Autonomy), no la compra.

### 3.6 Quote V2

**Implementado (main).**
- Contrato 2.0.0 **congelado** (A1–A6, A8): borradores, emisión, create-and-issue, lectura, cancelación, PDF, auditoría e idempotencia.
- `Idempotency-Key` obligatoria. Una clave con un cuerpo distinto devuelve 409.
- **Modelo B:** el llamador congela cada valor comercial. Quote verifica la aritmética y `expectedTotals`, persiste un snapshot inmutable, y no llama a Catalog ni a Shipping (D-1, D-2).
- Vigencia propia: `cl-retail-5-calendar-days-v1`, o `cl-retail-session-60m-v1` según el `commercialProfile` del principal.

**Carrito técnico (CART-02B, en main pero inactivo: sin ruta, scope ni migración).**
- Adaptador Webservice y ledger durable con lease y fencing.
- Un `POST carts` con el `id_customer` tomado del grant CIA (nunca del cuerpo, de R4 ni del modelo) y sus direcciones.
- Un `specific_price` por línea al neto A10.
- Gates de paridad y fingerprint `quote-cart-fp-v1`.
- Conciliación ante resultados ambiguos: `GET carts?filter[id_customer]`.
- Exige un cliente **registrado, activo, no invitado, con direcciones chilenas suyas**. Si no, responde `BUYER_NOT_ELIGIBLE`.

**Contrato de carrito.** CANDIDATO A7 (`a7-candidate-2.1/cart-02b-r1`):
- `POST /v2/quotes/{id}/cart-preparations` con `Idempotency-Key` y `X-Purchase-Authorization` (grant CIA + binding JWS de Checkout).
- Estados `PREPARING`, `READY`, `NOT_READY`, `UNCERTAIN`, `SUPERSEDED`, `EXPIRED`.

**Faltante.**
- A7 aceptado.
- Verificador de autorización de compra (sólo existe la interfaz).
- Proveedor de totales `ps-cart-totals/v1`, NO PROVISIONADO: `READY` es inalcanzable.
- Migración numerada (F13).
- Cancelación de la cotización conectada al carrito.
- Despacho en el carrito (H1).
- Limpieza de huérfanos (Q3).
- Fusión de A10.
- Fase C sobre un clon de la tienda.
- Deudas operativas G2-D01..D03: disco, backups, arranque tras reinicio.

**Despliegue.** Hay una instancia de integración en el host productivo, sólo loopback, con release del 2026-10-08,
`READY_FOR_REAL_CUSTOMERS=NO` y `R1.7_FULL_PRODUCTION_ACCEPTANCE=NO`. El proceso PM2 de Quote V1 está detenido. El estado
actual del contenedor V2 es UNKNOWN.

**Pruebas.**
- `main`: 884 passed, 1 skip.
- A10: 894/896. El fallo es de temporización y pasa en aislamiento.
- CART-02B: 139 pruebas y mutaciones M1–M6 detectadas.
- POC CART-02A: 52/52 con evidencia LIVE en la tienda local.

**Autoridades exigidas por el mandato.**

| Autoridad | Estado en Quote V2 |
|---|---|
| Productos y precios cotizados | SÍ sobre el **snapshot** (inmutable, verificado). No es fuente de precio: lo trae R4 desde Catalog (Modelo B). Coincide con ADR-043 |
| Descuentos | **NO.** No hay campo de descuento (§6.5): la rebaja va dentro del precio unitario. El carrito no crea cart rules y rechaza reglas ajenas. Ver §4, C-1 |
| Despacho incluido en la propuesta | SÍ, como snapshot. NO en el carrito (H1) |
| Vigencia | SÍ (5 días o 60 min según el principal). El perfil de vigencia del principal R4 es UNKNOWN |
| Carrito técnico idempotente | PARCIAL. Diseñado, implementado inactivo y probado LIVE sólo en la tienda local |

### 3.7 Checkout Service

**Implementado** (sólo en ramas; `main` es el baseline).
- Máquinas de estado:
  - sesión: `CREATED` … `COMPLETED`, `ACTION_REQUIRED`;
  - intento: `CREATED` … `SETTLED`, `EXPIRED`;
  - sincronización de orden.
- PostgreSQL (migraciones 0001–0012), outbox con lease y fencing, auditoría e intervenciones.

**Mercado Pago (Orders API, Checkout Pro).**
- `POST /v1/orders` con `external_reference` = id del intento.
- `X-Idempotency-Key` derivada de una clave persistida, con cuerpo congelado antes del primer envío.
- `expiration_time ≤ PT15M`.

**Webhook firmado.**
- HMAC con comparación en tiempo constante y rotación de secretos.
- Deduplicación por clave única.
- Responde 503 si la base no está disponible.

**Conciliación.**
- Job cada 120 s.
- Búsqueda por `external_reference` ante un resultado incierto.
- Cancelación ante una diferencia de monto.

**TTL.** Se calcula `expiresAt = min(now+900 s, quote.expiresAt)`. Un job cancela al vencer lo que siga en `created`. Un
intento en `PROCESSING` nunca vence por reloj.

**Idempotencia de pago.**
- Claves únicas.
- Un único intento sin resolver por cotización.
- Una segunda captura genera la intervención `DUPLICATE_PAYMENT`, sin una segunda orden.

**Pago tardío.** Se conserva, con `LATE_CAPTURE` y `ACTION_REQUIRED`, sin orden automática.

**Reembolsos.** Sólo se observan. Checkout no reembolsa.

**Orden sólo tras acreditación.**
- La transición a `PAYMENT_CONFIRMED_ORDER_PENDING` exige el monto exacto.
- `SYNC_ORDER` busca la orden por carrito antes de crear y crea como máximo una.

**Cliente Quote.** Usa el contrato candidato A7 y está gateado (`cartPreparerContractApproved=false`).

**Faltante.**
- **No se sirve ninguna API de comandos.** `/v1/checkout/sessions*` sólo existe en un OpenAPI `1.0.3-proposed`.
- **No hay adaptador real de orden PrestaShop.** El runtime usa `DisabledPrestaShop`: PAY-00 BLOCKED, 0 órdenes creadas.
- No hay emisor de autorización de compra (H3) ni identidad o direcciones del comprador.
- El perfil `live` está prohibido en código. No hay credenciales productivas ni URL productiva de webhook.
- No hay política de reembolsos (OD-09).
- **El repositorio no tiene remoto ni CI ejecutado:** existe una sola copia.

**Autoridades exigidas por el mandato.**

| Autoridad | Estado |
|---|---|
| Generación del enlace Mercado Pago | Implementada y probada en sandbox (`checkout_url`). No se alcanza por ninguna API servida |
| TTL estricto de 15 minutos | PARCIAL. Checkout pide ≤ 15 min y cancela a su vencimiento. **El proveedor venció la orden 3 min después** de la ventana en la única observación. OD-06 abierto, `providerExpiryVerified=false` |
| Conciliación | Implementada. Probada en sandbox una vez para captura y una para cancelación |
| Idempotencia de pago | Implementada y probada offline |
| Orden sólo tras acreditación | PARCIAL. La regla está implementada y probada offline. La creación real en PrestaShop **falta** |

**Pruebas.**
- 920/920 en `14b96a3`.
- `pay-02b`: 308/308 focal, sin regresión completa.
- Sandbox:
  - A-01R2: orden creada y cancelada al vencer.
  - A-01R3 (2026-10-30): pago aprobado de 1 000 CLP, webhook a los 10 s, conciliado a `CAPTURED`.
  - Recovery PASS.
  - Estado: `FINANCIAL_NO_GO`.

**Gates en código.** `PAY00_BLOCKED`, `PAY04_NO_GO`, `providerExpiryVerified=false`, `realConsentApproved=false`,
`quoteLiveReadsAuthorized=false`, `cartPreparerContractApproved=false`.

**Pendiente operativo.** Explicar `live_mode: true` en un pago de prueba (pregunta abierta a Mercado Pago).

### 3.8 PrestaShop

**Probado (tienda local aislada 8.2.3).** La configuración de producción se verificó sobre una copia: 8.2.3, modo de
redondeo y `PS_OS_WS_PAYMENT`.
- **Carrito:** `POST carts`, `specific_prices` y DELETE con relectura; paridad en 7 carritos; 7 simulacros de resultado incierto.
- **Orden:** `POST /api/orders` → 201, estado 11, pago, factura y stock −1.
  - Una segunda orden sobre el mismo carrito devuelve 500 y no crea nada.
  - Tras perder la respuesta, la orden se encuentra con `filter[id_cart]`.
  - Si se paga un peso menos, la orden queda en estado 8. Corregirla a mano duplica el pago.
  - `Order::add()` borra los precios específicos del carrito.

**Faltante.**
- Endpoint gobernado de totales (D3).
- Inventario de configuración A1–A15.
- Transportista de retiro.
- Modelo `ps_logistics` y tarifas.
- Decisión de módulo autor y estado de entrada de la orden (OD-02).
- Pruebas de los módulos productivos con efectos laterales: SMS, logística, descuentos por cantidad, correos.
- Gestión de clientes y direcciones (G-ADDR).
- Llaves Webservice dedicadas de mínimo privilegio para Quote y Checkout.
- Fase C sobre un clon de la tienda productiva.

### 3.9 Mercado Pago

**Reutilización.** El CRM no tiene integración de pagos reutilizable: su propia auditoría lo declara. La única
integración es la de Checkout.

**Estado.** Probado en sandbox con una cuenta vendedora de prueba (§3.7).

**Falta para producción.**
- Cuenta y credenciales productivas, con su titular comercial definido.
- Perfil de runtime productivo.
- URL pública productiva del webhook.
- Estudio de vencimiento (OD-06).
- Política de reembolsos (OD-09).
- Explicación de `live_mode`.

### 3.10 Canal WhatsApp

- **Entrada:** sólo texto. Cualquier otro tipo queda para un humano.
- **Salida:** sólo texto con `preview_url:false`. No hay plantillas, medios ni política de URL.
- **Para un enlace de pago hace falta:**
  - un mensaje renderizado por la plataforma con la URL que devuelve Checkout;
  - una decisión de política sobre esa salida;
  - verificar la ventana de 24 h de WhatsApp.

  La entrega de documentos (ADR-038) está diferida.

## 4. Contradicciones y decisiones del owner

**Contradicciones con el mandato.** El owner debe resolverlas antes de la F1.

| Id | Contradicción | Evidencia | Recomendación |
|---|---|---|---|
| C-1 | El mandato da a Quote autoridad sobre **descuentos**, pero Quote no tiene campo de descuento y el carrito no crea cart rules | Contrato Quote §6.5; parity CART-02B | Para el primer escenario: **sin descuentos**. Después, una enmienda de Quote que registre precio de lista y rebaja en el snapshot, sin cart rules, materializada como `specific_price` |
| C-2 | El dueño del carrito difiere según la fuente. Mandato y ADR-Q001: Quote crea el carrito. Rama sin fusionar `docs/r4-j55-roadmap-registration` (`d8a6b94`): Checkout o PrestaShop | ADR-Q001 (PROPUESTA) | Aceptar ADR-Q001 (es lo implementado) y cerrar o reescribir `d8a6b94` |
| C-3 | El mandato llama a esto J5, pero en el roadmap J5 es *Sales Autonomy* y Checkout pertenece a **R4-L** («no iniciado»). AGENTS.md prohíbe avanzar fases sin autorización | `R4_DELIVERY_ROADMAP.md` §1.1 | Registrar el identificador y autorizar R4-L (o la parte que corresponda) antes de la F5 |

**Decisiones abiertas.**

| Id | Decisión | Dueño | Necesaria para |
|---|---|---|---|
| D-01 | Fuente de catálogo para la compra: cutover V2 o conjunto interino de SKUs con paridad | Owner Catalog | F2 |
| D-02 | Alcance de entrega del primer escenario: retiro (S3) y designación del transportista de retiro (O-10) | Owner e-commerce | F4 |
| D-03 | Creación de cuentas y direcciones para compradores nuevos (OD-08, O-11/G-ADDR); el primer escenario usa sólo cuentas existentes | Owner Checkout / e-commerce | F8 |
| D-04 | Estado de entrada y módulo autor de la orden PrestaShop (OD-02, paridad OD-03) | Owner e-commerce | F5 |
| D-05 | Perfil de vigencia del principal R4 en Quote (60 min o 5 días) y su relación con el TTL de 15 min | Owner Quote / comercial | F1 |
| D-06 | Política para la capacidad FINANCIAL de R4: ADR de autonomía análogo a ADR-043, o aprobación humana (requiere R7-3, BLK-AP1) | Owner R4 | F6 |
| D-07 | TTL estricto del enlace (OD-06). **Owner, 2026-11-02:** sigue abierto. El cancel de Checkout por sí solo no basta; hace falta evidencia de expiración efectiva del enlace | Owner Checkout | F5 |
| D-08 | Política de reembolsos (OD-09) | Owner comercial / finanzas | F7 |
| D-09 | Cuenta Mercado Pago productiva y su titular | Owner comercial / finanzas | F5 |
| D-10 | Linaje de perfil y número de definición para la compra. Debe respetar el retiro de v9/`@9` y la reserva de v10/v11 | Owner R4 | F6 |
| D-11 | Publicar el repositorio de Checkout en un remoto privado y activar CI | Owner Checkout | F5 (recomendado de inmediato) |
| D-12 | Contrato semántico de la promoción de $1 y mapa de transportistas → `id_reference` | Owner Shipping / e-commerce | F8 (despacho) |
| D-13 | Autorización explícita del pago real del primer escenario (monto máximo, tarjeta, reembolso) | Owner | F7 |

## 5. Dependencias reales y camino crítico

```text
                      ┌─ F2 Catálogo veraz (D-01) ──────────────────────────────┐
F0 Decisiones ─┬─ F1 Quote productivo (A10 #26+#32, R1.7, perfil con Quote) ──┐ │
               ├─ F3 Identidad real (DEP-3 PS, DEP-2/5/6/10, CIA prod, H3) ─┐ │ │
               ├─ F4 Carrito (D3 PS, A7, F13, O-10, Fase C) ◄──── H3 ───────┤ │ │
               └─ F5 Checkout (API, orden PS, OD-02/06, MP prod, remoto) ◄──┘ │ │
                                    │                                        │ │
                         F6 Capacidades R4 de compra ◄───────────────────────┘ │
                                    │                                          │
                         F7 Primera compra controlada ◄────────────────────────┘
                                    │
                         F8 Ampliación (despacho, clientes nuevos, descuentos, rollout)
```

**Camino crítico.** F0 → F3 (proveedor de cuentas PrestaShop DEP-3 → CIA productiva → propósito `purchase`/H3) → F4
(totales D3 → A7 aceptado → `READY` en clon) → F5 (adaptador de orden PrestaShop → API servida → Mercado Pago
productivo) → F6 → F7.

**Dependencias por servicio.**

| Pieza | Depende de |
|---|---|
| R4 capacidades de compra | Checkout API servida; CIA (grant de compra); Quote productivo; D-06, D-10 |
| Checkout | Quote A7 + H3; PrestaShop (orden, llaves, OD-02); Mercado Pago productivo; CIA (`purchase`) |
| Quote carrito | PrestaShop (D3, llaves, transportista); CIA (H3); Checkout (binding JWS, direcciones) |
| CIA | PrestaShop (proveedor DEP-3, credencial DEP-2); correo DEP-5; KMS DEP-6 |
| Quote emisión | A10 (lockstep con R4 #32); R1.7 (backups, arranque); principal R4 |
| Catalog veraz | Owner Catalog (B-1..B-9) o decisión interina; re-enlace R4 |

**Paralelizable:**
- F1 y F2;
- F3, F4 y F5 en sus partes que no dependen de H3: el endpoint D3, el adaptador de orden y la API de Checkout;
- los documentos de F0.

## 6. Responsables

Las personas no están documentadas salvo en la CIA. La tabla usa roles; el owner debe asignar personas antes de la F1.

| Servicio | Responsable documentado | Responsabilidad en este plan |
|---|---|---|
| R4 Sales | Equipo R4 (owner R4) | Adaptadores y capacidades fuera de Core, perfil, política, pruebas F-gate del lado R4, operación del canary |
| Catalog | «Owner de Catalog» (persona UNKNOWN) | Cutover V2 o conjunto interino; contrato Discover |
| Shipping (pc-carrier) | Depto. Informática (sin persona) | Contrato de la promoción; mapa de transportistas (con e-commerce) |
| CIA | Owner designado (CIA-D1-01); sin owner operativo ni on-call | Modo productivo, DEP-*, propósito `purchase` |
| Customer Profile | «Owner de CP» | Fuera del camino crítico (J7-CP) |
| Quote V2 | «Owner de Quote V2» | A10, R1.7, A7, F13, carrito, Fase C |
| Checkout | Sin persona documentada | API, orden PrestaShop, Mercado Pago productivo, OD-* |
| PrestaShop | «Owner e-commerce» (sin persona) | DEP-3, D3, OD-02, llaves, transportista de retiro, clon de staging |
| Mercado Pago | Sin persona documentada | Cuenta productiva, credenciales, titular |
| Infraestructura | «Owner de la infraestructura R4» (UNKNOWN) | Webhook público, despliegues, backups |

## 7. Fases y gates

Cada fase requiere autorización explícita. Ninguna empieza por estar listada aquí.

### F0 — Decisiones y contratos (sólo documentos)
- Resolver C-1..C-3 y D-01..D-13.
- Aceptar ADR-Q001 y A7, y el diseño H3 entre CIA, Quote y Checkout (O-9).
- Aprobar el OpenAPI `/v1` de Checkout.
- Asignar responsables.

**Gate G0:** decisiones registradas, contratos A7, H3 y Checkout `/v1` en estado ACEPTADO y responsables nombrados.

### F1 — Cotización productiva (Quote + R4)
- Fusionar y desplegar en lockstep A10: Quote #26 y R4 #32.
- Gate R1.7 de Quote: backups, arranque tras reinicio y canary sintético aprobado.
- Principal R4 con scopes mínimos y perfil de vigencia (D-05).
- Perfil R4 con Quote REAL, del linaje `@8` o el que decida D-10, sin activar aún la compra.

**Gate G1:** emisión autónoma de una cotización por WhatsApp real dentro de la allowlist, con regresión J3
(`sales-autonomous-quote`, `sales-confirmed-intent-*`, `sales-deterministic-offer-*`) y cierre de GAP-14.

### F2 — Catálogo veraz (paralela a F1)
- Ejecutar D-01: cutover V2 con re-enlace R4 y G-1..G-4, o un conjunto interino de SKUs.

**Gate G2:** precio y stock de los SKUs del escenario verificados contra la base viva de la tienda, y fixtures R4
re-sincronizados.

### F3 — Identidad real
- PrestaShop: endpoint del proveedor de cuentas (DEP-3) y credencial (DEP-2).
- CIA: modo productivo, correo real (DEP-5), KMS (DEP-6), retención (DEP-10), rate limit compartido o instancia única aceptada.
- CIA: propósito `purchase` y audiencia `quote-cart-preparer` (H3).
- R4: identidad real en el perfil, con los gates J7 mínimos para identificación (no los de CP).

**Gate G3:** el comprador interno vincula su `wa_id` con su cuenta PrestaShop por OTP real. Además:
- `resolve` devuelve `verified` y el `customerRef` nunca aparece en la salida visible al modelo;
- la revocación funciona.

### F4 — Carrito técnico en Quote
- PrestaShop: endpoint gobernado de totales (D3), transportista de retiro (O-10), llave Webservice dedicada para Quote, clon de staging de la tienda productiva.
- Quote: migración numerada (F13), ruta A7 activa, verificador H3, limpieza de huérfanos (Q3), conexión de la cancelación con el carrito, Fase C sobre el clon.

**Gate G4:** en el clon de staging, un carrito llega a `READY` con paridad exacta contra los totales de PrestaShop.
Además:
- los 7 simulacros de resultado incierto pasan;
- una repetición con la misma clave no crea un segundo carrito;
- `BUYER_NOT_ELIGIBLE` se emite para un invitado.

### F5 — Checkout y Mercado Pago (R4-L)
- Publicar el repositorio con remoto privado y CI (D-11), y fusionar la cadena `pay-*` a `main` con regresión completa.
- API de comandos servida y autenticada.
- Adaptador real de orden PrestaShop (PAY-00 en el clon; OD-02).
- Emisor del binding H3.
- Estudio de vencimiento (OD-06/D-07).
- Perfil productivo y credenciales (D-09), webhook productivo, política de reembolsos (D-08).

**Gate G5 = gate financiero F-1..F-7** (`R4_TEST_STRATEGY_02.md` §6.1) en L3 sobre el SHA a desplegar, coordinado entre
repositorios:

| Punto | Exigencia |
|---|---|
| F-1 | Contratos de Checkout y Mercado Pago |
| F-2 | Flujo sesión → carrito → enlace → pago sandbox → webhook → orden en el clon |
| F-3 | Reintentos, webhook duplicado y carrera entre entregas |
| F-4 | Enlace vencido, usado o reemplazado, en el límite exacto; pago tardío sin orden |
| F-5 | Conciliación, incluidas caídas a mitad del proceso |
| F-6 | Ninguna orden con pago pendiente, rechazado, revertido o no verificado |
| F-7 | Mutaciones de F-3..F-6, N/N |

Un `NOT_RUN` en un punto obligatorio bloquea.

### F6 — Capacidades R4 de compra (fuera de Core)
- Adaptador `adapters/domains/checkout/http`, con contrato vendorizado y fixtures.
- Capacidades de Sales:
  - iniciar la compra sobre una cotización emitida y confirmada (FINANCIAL, idempotente, con clave de ejecución propia de Checkout);
  - leer el estado de la compra (READ).
- La identidad viaja por la plataforma (grant CIA), nunca por el modelo.
- El consentimiento se captura con la compuerta de confirmación J3 (ADR-035) sobre un mensaje determinista.
- El enlace se envía con un mensaje renderizado por la plataforma.
- Política según D-06. Definición y perfil nuevos según D-10.
- Core no cambia: sin primitivas nuevas de Cart, Payment ni Order.

**Gate G6:** L2 con unit, contract y escenarios `sales` del flujo de compra contra un doble contractual de Checkout,
`governed-execution` y `reconciliation`. Además:
- interop con el Checkout real en sandbox;
- pruebas negativas: el modelo intenta escribir una URL, o inicia la compra sin confirmación o sin identidad verificada, y la compra se rechaza;
- el subconjunto del gate financiero que afecta a R4: F-3 (doble inicio) y F-6 (R4 no declara pagado sin lectura del proveedor).

### F7 — Primera compra controlada
Ver §9.

**Gate G7:** se cumplen todos los criterios de aceptación de §9.4, y el informe de conciliación muestra exactamente un
cobro, un carrito y una orden.

### F8 — Ampliación (cada punto con mandato propio)
- Despacho a domicilio: H1 S1/S2, mapa de transportistas, contrato de la promoción de $1, v10/v11.
- Compradores nuevos: creación de cuenta y dirección (D-03).
- Descuentos (C-1).
- Customer Profile real (J7-CP).
- Rollout más allá de la allowlist (J7).

## 8. Pruebas necesarias

| Fase | Repositorio | Pruebas | Nivel |
|---|---|---|---|
| F1 | Quote, R4 | Regresión completa de Quote con A10; contract y unit R4 de `quote.create`; escenarios J3; canary EC2 con allowlist | L2, y L3 en el SHA desplegado |
| F2 | Catalog, R4 | Paridad de los SKUs contra la tienda viva; `catalog-http-real` habilitado; contract R4 con fixtures re-sincronizados | L2 |
| F3 | CIA, PrestaShop, R4 | Contrato del proveedor DEP-3; suite CIA en modo productivo; `identity-http-contract`; campaña interop R4→CIA; prueba de que `customerRef` no llega al modelo | L2, más interop |
| F4 | Quote, PrestaShop | CART-02B con el proveedor de totales real en el clon; 7 simulacros de resultado incierto; mutaciones M1–M6; elegibilidad del comprador | L2, más Fase C en el clon |
| F5 | Checkout | Regresión completa (hoy no existe para `pay-02b`); PAY-00 en el clon; F-1..F-7 | L3 + gate financiero |
| F6 | R4 | Adaptador, capacidades, escenarios `sales` de compra, `governed-execution`, `reconciliation`, mutaciones de las garantías nuevas | L2; L3 antes de producción |
| F7 | Todos | Primero un ensayo sandbox completo (§9.3, paso A); después la compra real | L3 sobre los SHA desplegados |

No se necesitan regresiones completas en las fases documentales (F0). Las pruebas se seleccionan por diff según la
estrategia 02.

## 9. Primer escenario de compra controlada

### 9.1 Configuración

| Elemento | Valor |
|---|---|
| Comprador | Persona interna autorizada por el owner. Cuenta PrestaShop **existente, registrada (no invitado), activa**, con una dirección chilena propia |
| Conversación | Una sola conversación WhatsApp en la allowlist; el resto sigue en el perfil vigente |
| Producto | 1 SKU físico simple, sin combinaciones, con stock y precio verificados contra la base viva de la tienda (G2), IVA 19 %, cantidad 1 |
| Descuentos | Ninguno (C-1) |
| Entrega | **Retiro en tienda**, costo 0 (`pickup-zero-v1`, S3). Sin despacho, sin promoción de $1 y sin mapa de transportistas |
| Cotización | Vigencia de sesión de 60 min (D-05) |
| Enlace | ≤ 15 min y ≤ la vigencia de la cotización. La expiración efectiva del enlace debe estar demostrada (D-07/OD-06 abiertos) |
| Pago | Monto bajo, autorizado por escrito (D-13), con tarjeta del comprador interno. Reembolso según D-08 |

### 9.2 Flujo

1. El comprador pide el producto. El agente usa `catalog.search`, `catalog.get_product_context` y `quote.preview`, y
   presenta la oferta determinista (`offerMessage`).
2. El comprador confirma. `quote.create` emite la cotización (A10, idempotente).
3. El agente inicia la verificación (`identity.start_verification`) y el comprador recibe el OTP en su correo. El gateway
   captura el código y la CIA queda `linked`. El `customerRef` no se expone al modelo.
4. El comprador acepta la compra sobre la oferta confirmada. La capacidad R4 inicia la compra en Checkout con
   consentimiento y grant `purchase`.
5. Checkout pide la preparación del carrito a Quote con H3. Quote crea el carrito con el `id_customer` del grant, la
   dirección del cliente, el transportista de retiro y un `specific_price` por línea, y lo deja `READY` con paridad.
6. Checkout crea el intento y la orden de Mercado Pago (≤ 15 min). R4 envía el enlace en un mensaje renderizado por la
   plataforma.
7. El comprador paga. El webhook firmado y la conciliación llevan el intento a `CAPTURED`. `SYNC_ORDER` crea la orden en
   PrestaShop (D-04).
8. R4 lee el estado (READ) e informa al comprador con datos del proveedor, no del modelo.

### 9.3 Secuencia de ejecución

- **A. Ensayo sandbox completo.** Mercado Pago de prueba, clon de la tienda y comprador de prueba en el clon, con el
  mismo flujo de §9.2 y los negativos de F-3/F-4/F-6:
  - enlace vencido;
  - webhook duplicado;
  - pago tardío;
  - diferencia de monto;
  - doble inicio desde R4.
- **B. Compra real**, una sola vez, con autorización explícita y rollback preparado.

### 9.4 Criterios de aceptación

**Resultado esperado:**
- exactamente 1 cotización, 1 carrito, 1 intento capturado, 1 cobro y 1 orden PrestaShop;
- montos idénticos en cotización, carrito, Mercado Pago y orden;
- la orden en el estado decidido (D-04);
- informe de conciliación sin divergencias.

**Comportamiento del agente:**
- el agente nunca escribe ni modifica la URL del enlace;
- nunca afirma un pago sin lectura del proveedor;
- el `customerRef` no aparece en la salida visible al modelo.

**Operación:**
- el enlace caduca a los 15 min si no se paga. Se prueba en A, y en B si el owner lo autoriza;
- el rollback está documentado: desactivar la capacidad de compra en el perfil y revertir el perfil a la versión anterior por SHA explícito;
- la evidencia queda registrada según la estrategia 02, §8.

**Criterios de aborto:** cualquier segundo cobro, una orden sin captura, una diferencia de monto, un `NOT_RUN` en el gate
financiero o una incoherencia en la conciliación.

## 10. Riesgos fuera del flujo, ya presentes en producción

| Riesgo | Detalle |
|---|---|
| Catálogo desactualizado | El agente productivo presenta precios y stock de una copia antigua de la base. Afecta a toda conversación actual, no sólo a la compra (§3.2) |
| Promoción de $1 | `@3`/v4 puede presentar el $1 como tarifa real del transportista (§3.3) |
| Checkout sin remoto | La cadena `pay-*` (78 commits) existe sólo en una copia local (D-11) |

Hay además hallazgos de seguridad operativa en CP y Checkout. Están registrados en los repositorios privados de cada
servicio y no se detallan en este repositorio público.

## 11. Estado

```text
R4_J5_COMMERCIAL_INTEGRATION_PLAN_READY_FOR_REVIEW
```

Pendiente del owner: C-1..C-3, D-01..D-13, asignación de responsables y autorización de F0. No se implementó nada; no
hubo cambios productivos, pagos, creación de perfiles Sales, cambios de kernel ni llamadas a modelos.
