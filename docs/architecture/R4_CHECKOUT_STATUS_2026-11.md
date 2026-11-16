---
title: R4 — Estado ejecutable de las dependencias CIA + Checkout (M4 — Checkout)
status: R4_CHECKOUT_STATUS_RECORDED — auditoría documental + ejecución local de pruebas; nada activado
mandate: «M4 — Checkout» (owner)
date: 2026-11-16
base: main a932775
related: R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN.md y R4_L_CHECKOUT_IDENTITY_INTEGRATION_AUDIT.md (PR #64, abierto)
---

# R4 — Estado ejecutable de Checkout (M4)

## 0. Alcance y método

Fotografía, al 2026-11-16, de cada dependencia del camino de compra desde WhatsApp: estado, evidencia, dueño, bloqueo
y **siguiente paso ejecutable que no requiere pagos productivos**. A diferencia de la auditoría R4-L del PR #64 (que
sólo leyó los documentos de R4), aquí se leyó **el código de los repositorios hermanos** (CIA, Checkout, Quote) y se
corrieron sus suites localmente.

Reglas: sin despliegues, sin merge, sin EC2, sin órdenes, sin dinero. Sin datos productivos: este repositorio es
público, así que no aparecen hosts, identificadores de tienda, de campaña ni credenciales. Las referencias a otros
repositorios son SHAs y rutas; los repositorios CIA, Quote y Customer Profile son privados en GitHub, y **Checkout no
tiene remoto** (sólo copia local).

Estados: **Hecho** · **En curso** · **Bloqueado** · **No iniciado**.

## 1. Tabla de estado

| # | Dependencia | Estado | Evidencia | Dueño / repo | Bloqueo | Siguiente paso ejecutable (sin pagos productivos) |
|---|---|---|---|---|---|---|
| 1 | R4-L y PR #64 | **En curso** (sólo documentación) | PR #64 abierto, head `7a30eaa` (3 commits, base `a704319`, 51 commits detrás de `main`; `git merge-tree` limpio). Archivos: plan `R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN.md`, auditoría `R4_L_CHECKOUT_IDENTITY_INTEGRATION_AUDIT.md`, fila R4-L del roadmap. En `main` la fila sigue «No iniciado» (`docs/roadmap/R4_DELIVERY_ROADMAP.md:30`). Ningún código R4-L (S2/S3/S4) en ninguna rama | Owner R4 / R4-agent-platform | Revisión y merge del PR #64 (decisión del owner). Decisiones abiertas O-1, O-4..O-8, R4L-D1, R4L-D2 (resueltas: O-2, O-3, R4L-D3, R4L-D4) | Revisar y mergear #64 (sólo docs) para que la fila R4-L de `main` diga «Iniciado: solo integración sandbox» |
| 2 | CIA `purchase` | **Bloqueado** (contrato candidato sin publicar; sin código) | CIA `origin/main` = `7525395` (contrato `v1-d2` aceptado sólo para interoperabilidad sintética). `purchase` no aparece en `src/` ni en `config/` (consumidor sintético: `sales_context`, `purchase_history`, `config/synthetic.local.json:116`). Los propósitos son configurables (`src/core/policy.ts:73`), pero la **audiencia es una sola por instancia** (`src/config.ts:35`, `src/core/grant.ts:121`): H3 pide `aud = quote-cart-preparer` sólo para `purchase` → cambio de código (C-CIA-1). Modo: `config.ts:63` «mode must be "synthetic"». Candidato H3 en rama local `docs/h3-purchase-authorization-candidate` @ `39342b2` (worktree `cia-h3`), **no publicada** en el remoto. Sin PRs ni issues en el repo CIA. No desplegada en ningún entorno | Owner CIA / MS-pesaschile-customer-identity-authority | Publicar y aceptar H3 (S1/G0, cruce con Quote A7 y Checkout `/v1`); X-1 (`azp`); C-CIA-1..8; modo no sintético; DEP-2/3/5/6/10 | Empujar la rama H3 al remoto CIA y abrir PR de revisión (sólo docs). Después: soporte sintético de `purchase` con audiencia por propósito, probado contra la suite CIA existente |
| 3 | Resolución del comprador PrestaShop (WhatsApp → `prestashop_customer:<id>`) | **Bloqueado** (lado tienda inexistente) | CIA: vínculo (`whatsapp`, cuenta de canal, `wa_id`) → `customerRef = prestashop_customer:<id>` = `sub` del grant, tras OTP por correo. El proveedor de cuentas es un contrato **candidato** de la CIA (`contract/provider/v1/ACCOUNT_PROVIDER_V1_CONTRACT.md`: buscar por correo verificado + revalidar); la CIA sólo habla con un doble HTTP local (`src/adapters/remote/account-provider.ts`, informe CIA-S2). **No existe productor** en ningún repositorio local (PrestaShop, módulo `pc_r4chat`, CRM, Customer Profile: búsqueda de `find-by-email`/`account-provider` sin resultados). R4: `customerRef` nunca llega al modelo; `quote.create` envía `guest` | Owner e-commerce/PrestaShop (DEP-3) + owner CIA | DEP-3 sin implementar ni autorizar; credencial (DEP-2); correo real (DEP-5; OA-04 sólo sintético); tiendas/`shopId` reales sin asignar | Owner e-commerce acepta o corrige `ACCOUNT_PROVIDER_V1_CONTRACT.md`; luego un productor en la tienda aislada (no productiva) probado contra el cliente remoto de la CIA |
| 4 | Emisor productivo del consentimiento | **Bloqueado** (sin decisión O-5; sólo emisores de prueba) | R4: `CheckoutConsentSource` (`adapters/domains/src/checkout/port.ts`) con una única implementación `SandboxConsentDirectory` (`adapters/domains/checkout/http/src/sandbox-consent.ts`), que entrega sin cambios un artefacto firmado por `sign-test-consent` de Checkout. Regla R-3: R4 no firma. Checkout: las únicas implementaciones de `PurchaseConsentVerifier`, `BuyerAuthorization` y `PurchaseAuthorizationIssuer` son `TestOnlyConsentVerifier`, `TestServiceBuyerAuthorization`, `TestOnlyH3Issuer` (`src/sandboxPurchase/testAuthority.ts`); `realConsentApproved: false` (`src/domain/checkout/gates.ts:44`) | Owner + owner Checkout + owner CIA (decisión); owner R4 (captura) | O-5 abierta; fuentes en desacuerdo (grant CIA vs. consentimiento separado vs. compuerta J3) — plan PR #64 §8.5 | Sin esperar O-5: captura determinista del **acto** de compra en R4 (inbound registrado + gramática `r4-sales-purchase-es-v1` ligado a cotización/versión/hash), persistida como evidencia, sin firmar ni emitir nada |
| 5 | Identidad y consentimiento dentro de Checkout | **Bloqueado** (decidido R4L-D3; sin implementar) | Checkout `pay-02c-ad5-late-capture` @ `3d7b23d` (último commit, 2026-11-07). `createSession` (`src/application/checkout/checkoutService.ts:175-250`): verifica el consentimiento (`verifyConsent`), lo liga a la cotización (`assertConsentBoundToQuote`), toma **comprador = `consent.subjectRef`** (I-18), autoriza al principal con `BuyerAuthorization` (prueba: servicio configurado o el propio comprador), registra el acto (uno por compra) y rechaza otro comprador para la misma cotización. **No lee ningún grant CIA** (no hay `x-customer-access-grant` en `src/`). El contrato `/v1 1.0.4-proposed` ya prevé la cabecera y «The buyer is identified only by the verified CIA grant» (rama local `docs/f0-checkout-v1-review` @ `e6768e8`, `contracts/checkout/v1/openapi.json`, no aprobado). Las ramas `pay-*` existen sólo localmente (sin remoto, D-11) | Owner Checkout | R4L-D3 resuelta (comprador = `grant.sub`, consentimiento = sólo el acto) pero sin código; depende de H3 (grant) y de O-5 (formato del consentimiento); D-11 (remoto + CI) | D-11: crear el remoto privado de Checkout desde el respaldo verificado y activar CI. Luego un `BuyerAuthorization` que verifique un grant CIA **sintético** (JWKS de la CIA sintética) — probable con las suites existentes |
| 6 | Carrito Quote | **Hecho, apagado** (código en `main`; inactivo en todo entorno) | Quote `origin/main` = `a79d33f` (PR #28 QV2-CART-ENABLE; #27 PAY-02B; #25 CART-02B). `QUOTE_CART_PREPARATION_ENABLED` por defecto `false` (`src/infrastructure/config/env.ts:92`); `QUOTE_CART_H3_MODE` por defecto `closed` y `verify` **prohibido** con `NODE_ENV=production` (`env.ts:96`, `:148`). Verificador H3 con `azp` configurable, hoy pensado para `checkout` (`src/application/quote-v2/cart/purchase-authorization.ts:51`). Migración `000010`: según el registro operativo del owner (no verificado aquí, sin acceso a EC2) aplicada en la instancia que usa R4, con el carrito apagado y H3 `closed`; los [gates F1](R4_F1_WHATSAPP_QUOTE_RELEASE_GATES.md) §1.1 y §2 siguen sin concordar (plan PR #64 §2.3). Probado sólo en tienda aislada (E3-A: un único `POST /api/carts`). A7 §12 en rama local `docs/a7-f0-review` (no publicada) | Owner Quote (+ e-commerce para E-3..E-9) | A7/H3 sin aceptar (G0); X-1 (`azp`); totales `ps-cart-totals/v1` LIVE (E-3); transportista de retiro (E-5/O-10); llaves dedicadas (E-6); direcciones (E-7); clon (E-9) | Correr la suite del carrito de Quote en local contra la PrestaShop aislada (ya existe); publicar A7 §12 para revisión cruzada con H3 |
| 7 | Corrección AD-5 / C1 | **En curso** (AD-5 hecho y revisado; C1 sin decidir ni corregir) | AD-5 en Checkout `3d7b23d` (migración `0018 payment_started_at`), revisión independiente `CHECKOUT_AD5_REVIEW_PASS` con observaciones C1 (media), C2, C3 ([E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §1). E3-A registró `START_IN_TIME`. C1 = «La evidencia de inicio es la primera vista de la *orden* en proceso, sin tope de tiempo» (`waiting_retry`/offline). Owner: «5. Corrección de AD-5/C1» (O-3 resuelta). Ningún commit posterior a `3d7b23d` en Checkout | Owner + owner Checkout (O-7); owner Checkout (código) | O-7 abierta (¿reintento u offline cuentan como «iniciado»?); D-11; OD-06/D-07 | Escribir ya en Checkout la sonda C1 (en proceso al minuto 10, captura 3 días después) como prueba de caracterización con `checkoutFakes`; la corrección espera O-7 |
| 8 | Modalidad de entrega autorizada | **Bloqueado** (O-6 abierta; contradicción nueva con `@19`) | Quote: el carrito sólo representa **retiro a costo 0** (`shippingMethod: "pickup-zero-v1"`, `preparation-job.ts:348`); toda cotización con despacho → `SHIPPING_NOT_REPRESENTABLE` / `H1_BLOCKED_QUOTE_HAS_SHIPPING` (`line-representation.ts:74`); transportista de retiro obligatorio y sin valor por defecto (`QUOTE_CART_PICKUP_CARRIER_REFERENCE`, `cart-preparation-settings.ts:58-61`). R4: [política F1](R4_F1_COMMERCIAL_POLICY.md) v2 (`@19`, 2026-11-10) **permite despacho** cotizado por Shipping; el retiro sólo si una oferta lo confirma. v1 (`@17`/`@18`): sin despacho, nunca presentado como retiro | Owner comercial (O-6); owner e-commerce (E-5/O-10) | O-6; transportista de retiro no designado; **una cotización de `@19` con despacho no puede pasar al carrito** (H1) | Decisión O-6 (retiro sólo, o despacho → H1 en Quote). Sin decisión, el único escenario ejecutable en sandbox es retiro a costo 0 con un transportista de prueba en la tienda aislada |
| 9 | Evidencia E2E sandbox | **Hecho** para E3-A; **Bloqueado** E3-B | PR #55 mergeado (`96f6075`, 2026-11-07; sin despliegue). E3-A ejecutado 2026-11-09 contra Mercado Pago **de prueba**: 12/12 puntos PASS + vencimiento sobre intento pagado ([E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §8). No cubrió WhatsApp, modelo, Task Runtime, Policy Engine, pagos rechazados/pendientes, OD-06 ni pago tardío real. E3-B bloqueado por topología (O-4). `@15` (Checkout sandbox) inactivo y desciende de `@14`, superado | Owner R4 + owner e-commerce (O-4) | O-4; identidad ausente del perfil sandbox; D-10 (linaje sobre el carril vigente) | Las pruebas locales de §3 (sin dinero); en Checkout, `isolatedPurchase.e2e` y `mpProviderChain.e2e` contra la PrestaShop aislada local con proveedor simulado |

## 2. Grafo de dependencias

```text
                   [O-6 entrega]──────────────┐
                                              v
WhatsApp ─► R4 perfil de carril nuevo ─► (1) CIA resolve(['purchase'])
            (D-10/O-8, sobre el vigente)      │   necesita: H3 publicado+aceptado, audiencia por propósito (C-CIA-1),
                    │                         │   modo no sintético, DEP-3 productor de cuentas (tienda), DEP-2/5
                    │                         v
                    ├─► (2) acto de compra capturado por R4 (determinista, sin firmar)
                    │          └─► artefacto de consentimiento [emisor: O-5]
                    v
            Checkout POST /v1/checkout/sessions
              grant en x-customer-access-grant + consentimiento
              necesita: R4L-D3 en código (comprador = grant.sub), verificador real, D-11 (remoto+CI)
                    │
                    v
            Checkout binding JWS (H3 capa 2) ─► Quote cart-preparations (A7)
                                                 necesita: H3 verify fuera de NODE_ENV=production, X-1 (azp),
                                                 E-3 totales, E-5 transportista, E-6 llaves, E-7 direcciones
                                                 restricción: sólo retiro (H1) ◄── choca con @19 (despacho)
                    │
                    v
            Enlace MP ─► webhook ─► conciliación AD-5 (+ C1 [O-7]) ─► orden PrestaShop
                    │
                    v
            E2E sandbox desde WhatsApp [O-4 topología] ─► L3 + F-1..F-7 ─► (fuera de M4) pago real D-13
```

Camino crítico: **H3 publicado** → CIA `purchase` → Checkout comprador = `grant.sub` → E2E con identidad. Las
decisiones O-5, O-6 y O-7 bloquean ramas laterales (consentimiento, entrega, C1) y no dependen de código.

## 3. Pruebas ejecutadas (2026-11-16, local, sin credenciales reales)

| Repositorio @ SHA | Suite | Resultado |
|---|---|---|
| R4 `main` `a932775` | unit `tests/unit/checkout` + `tests/unit/customer-identity` | **141/141 PASS** (5 archivos) |
| R4 `main` `a932775` | contract `sales-profile-v15`, `sales-boundaries`, `identity-http-contract`, `identity-verification-boundaries` | **59/59 PASS** (4 archivos). Un caso estático de `identity-verification-boundaries` (recorre el árbol de fuentes) excede el timeout por defecto de 5 s en Windows bajo carga; repetido aislado con `--testTimeout=60000`: 14/14 |
| R4 `main` `a932775` | integration `sales-checkout`, `platform-notice` (PostgreSQL local de pruebas) | **21/21 PASS** (2 archivos). Una primera corrida concurrente con la suite de Checkout terminó en timeouts de hook (60 s); repetida sola: verde |
| CIA `df66f92` (código idéntico a `origin/main` `7525395`, que sólo añade documentos y una prueba) | suite completa `vitest run` | **304/304 PASS** (22 archivos) |
| CIA `origin/main` `7525395` | `tests/contract-d2.test.ts` (la prueba añadida) | **41/41 PASS** |
| Checkout `3d7b23d` (rama local `pay-02c-ad5-late-capture`) | unit + domain + contract + preflight + e2e (proveedor real y tienda omitidos por `skipIf`) | **918 PASS, 2 FAIL, 26 skipped** (41 archivos). Los 2 FAIL son guardas estáticas rotas desde `d11e3c7` (`localStack.ts` importa código de prueba): `u6SecurityClosure` C-1 y `pay04G1FinalAcceptanceUnit` SBX-1. Deuda conocida de Checkout, no regresión |
| Checkout `3d7b23d` | integration seleccionada: `ad5LateCapture`, `pay01cConsentAndConsumption`, `sessionsAndAttempts`, `adr0002CartPreparation` (PostgreSQL sintético propio) | **63/63 PASS** (4 archivos) |
| Checkout `3d7b23d` | integration completa (34 archivos) | **Interrumpida** tras ~50 min con la máquina cargada: `pay03s1SandboxFinancialTest` 6/114 en timeout de 30 s; `pay03MercadoPago` 34/34. Sin resultado concluyente: NOT_RUN para el resto |

NOT_RUN: `test:recovery` (prohibido en este mandato); `test:interop` (necesita levantar las instancias sintéticas de
CIA/CP); mutaciones (`test:mutation:checkout`, 15 mutantes); suite de Quote; E2E de Checkout con PrestaShop aislada
(`CHECKOUT_E2E_ISOLATED=1`, necesita manifiesto local). Ningún `NOT_RUN` aquí afecta un gate: esto no es L2/L3.

## 4. Bloqueos reales y quién decide

| Bloqueo | Tipo | Decide / ejecuta |
|---|---|---|
| Merge del PR #64 (plan + auditoría + fila R4-L) | Revisión | Owner R4 |
| H3 publicado y aceptado (con A7 y `/v1`, G0; X-1 `azp`) | Contrato cruzado | Owners CIA, Quote y Checkout |
| O-5 emisor del consentimiento productivo | Decisión | Owner + Checkout + CIA |
| O-6 entrega (retiro vs. despacho de `@19`; H1 en Quote) | Decisión | Owner comercial (+ e-commerce E-5/O-10) |
| O-7 qué cuenta como «iniciado» en C1 | Decisión | Owner + owner Checkout |
| O-4 topología E3-B | Decisión + infraestructura | Owner + e-commerce |
| O-8 / D-10 perfil de carril para compra; D7-6/D-06 fuera de sandbox | Decisión | Owner R4 |
| R4L-D1 tope financiero sandbox (relink = 3); R4L-D2 consentimiento por sesión o por intento | Decisión | Owner R4 (+ Checkout para D2) |
| D-11 remoto privado + CI para Checkout (historial `pay-*` sólo local) | Operación | Owner Checkout (P-1..P-8) |
| DEP-3 productor de cuentas en la tienda; DEP-2/5/6/10 | Implementación externa | Owner e-commerce / CIA |
| Modo no sintético de la CIA, OA-04/D7 correos reales, J7 datos reales | Decisión + implementación | Owner CIA; owner de datos |

## 5. Integraciones y pruebas mínimas que se pueden desarrollar ya

Todas sin pagos productivos, sin datos reales y sin activar nada. Cada una es independiente de las demás.

1. **R4 — captura determinista del acto de compra** (S3 parcial). Registro, desde el inbound persistido por la
   plataforma, del mensaje que cumple `r4-sales-purchase-es-v1`, ligado a cotización/versión/hash y a la conversación.
   No firma ni emite: es la evidencia que cualquier emisor de O-5 necesitará. Pruebas: unit de la captura,
   integration (no hay captura sin inbound registrado; un mensaje del modelo no cuenta), mutación.
2. **R4 — transporte del grant aparte del consentimiento** (R4L-D3, lado R4). Cabecera `x-customer-access-grant` en
   `adapters/domains/checkout/http` detrás del puerto, con prueba de contrato contra `/v1 1.0.4-proposed` y prueba de
   frontera de que el grant y el `customerRef` nunca llegan al modelo. Sin activar: `@15` no compone identidad.
3. **CIA — `purchase` sintético con audiencia por propósito** (C-CIA-1/-3), una vez publicado H3: cambio de código
   probado con la suite CIA (304 + 41 hoy en verde) y la interop R4→CIA sintética existente (`tests/interop`).
4. **Checkout — `BuyerAuthorization` sobre un grant CIA sintético** (R4L-D3, lado Checkout): comprador = `grant.sub`;
   el consentimiento sólo prueba el acto; rechazo si `sub` del grant y sujeto del consentimiento divergen. Requiere
   antes D-11.
5. **Checkout — sonda C1** como prueba de caracterización (hoy crea la orden); la aserción final la fija O-7.
6. **Quote — carrito en local** contra la PrestaShop aislada, con `QUOTE_CART_H3_MODE=verify` fuera de producción y
   un grant de la CIA sintética + binding del emisor de prueba de Checkout: primera prueba H3 con firmas de la CIA
   real (sintética) en lugar de las de prueba de Checkout.

## 6. Qué no hace este documento

No activa perfiles, no despliega, no toca EC2, no cambia Quote, Checkout, CIA ni PrestaShop, no habilita el carrito,
no emite consentimientos, no inicia compras ni pagos y no resuelve ninguna decisión O-n / R4L-Dn.
