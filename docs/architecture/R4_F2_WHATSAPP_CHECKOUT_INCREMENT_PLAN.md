---
title: R4 — Plan del siguiente incremento de integración desde WhatsApp (identidad, consentimiento, carrito, Checkout, C1, E2E)
status: R4_F2_WHATSAPP_CHECKOUT_INCREMENT_PLAN_READY_FOR_REVIEW — plan documental; no autoriza fases, perfiles, despliegues, compras ni pagos
mandate: «R4 — F1 CANARY CONTINUATION AND QUOTE DELIVERY», sección E (owner)
date: 2026-11-10
base: main a704319
---

# R4 — Plan del siguiente incremento desde WhatsApp

## 0. Alcance y estado

El mandato pide, en este orden: 1. identidad CIA; 2. consentimiento de compra; 3. carrito técnico de Quote;
4. Checkout; 5. cierre de C1; 6. validación E2E controlada. **No se activan compras ni pagos productivos.**

**Punto de partida (contexto del mandato, 2026-11-10):** R4 `a704319` desplegado; el carril `sales-production@17`
atiende a una allowlist de 2 conversaciones; F1 = sólo emisión autónoma de Quote V2 (sin despacho, promociones,
carrito, Checkout ni pagos; Customer no disponible). Checkout **no** está desplegado en producción.

**Nomenclatura.** «F2» en el nombre de este archivo designa el incremento siguiente a F1 del carril WhatsApp. **No es**
la F2 del plan transversal J5 (catálogo veraz, [readiness §7](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md)). En ese
plan, las prioridades de este mandato corresponden a F3 (identidad), F4 (carrito), F5 (Checkout), F6 (capacidades R4)
y F7 (primera compra controlada). Conviene que el owner fije un nombre para evitar la colisión (§8, decisión O-1).

**Fase del roadmap.** Checkout y pagos pertenecen a **R4-L, «no iniciado»** (decisión C-3,
[registro F0](R4_J5_F0_OWNER_DECISION_RECORD.md) §1; [roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §1). AGENTS.md
prohíbe avanzar fases sin autorización explícita. Este plan no la da (§8, decisión O-2).

## 1. Qué significa «C1»

En la documentación hay varios «C1». Por la posición en la lista (después de Checkout y antes del E2E), el candidato
más probable es el (a), **pero es una inferencia**: el owner debe confirmarlo (§8, decisión O-3).

| # | Candidato | Fuente | Estado | ¿Encaja? |
|---|---|---|---|---|
| a | **Observación C1 (media) de la revisión de AD-5 de Checkout:** la evidencia de inicio del pago es la primera vista de la *orden* en proceso, sin tope de tiempo; un reintento (`waiting_retry`) o un pago offline pueden acreditarse días después del vencimiento y aun así crear la orden | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §1, §6.2, §7 («AD-5 con C1 resuelto») | **Abierta.** «No bloquea el E3-A. Sí debe resolverse antes de producción» | Sí: es la única abierta y está en el camino de Checkout |
| b | R4-C1, Execution Kernel | [roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §3 | Completado y publicado | No: no hay nada que cerrar |
| c | R4-J3E-C1, oferta determinista y seguridad de escritura | [informe C1](R4-J3E_C1_IMPLEMENTATION_REPORT.md); [cierre J3](../acceptance/R4_J3_CLOSURE_RECORD.md) | Fusionado (`b5fd288`) | No: cerrado, y es la base de F1 |
| d | C-1 con guion: descuentos (readiness §4) o el servidor de comandos de Checkout ([integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §6.3) | — | Descuentos: decidido (sin descuentos). Servidor: hecho en sandbox | Poco probable |

El resto del plan trata C1 como (a).

## 2. Inventario por prioridad

### 2.1 Identidad CIA

| | Detalle |
|---|---|
| **Existe en R4** | Verificación por OTP sólo sintética: `identity.start_verification@1` e `identity.verification_status@1` (`agents/sales/src/capabilities/identity-verification.ts`); adaptadores `adapters/domains/identity/http` y `adapters/domains/identity/verification`; punto de inspección de ingreso (ADR-040). La única composición es `customer-synthetic.ts`, que **rechaza `R4_CUSTOMER_MODE=real`**. Sólo `@8` la compone. Decisiones de diseño en [SEC-OTP](R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md) §13 y [SEC-S5](R4_J4_SEC_S5_COMMERCIAL_VERIFICATION_REPORT.md); ADR-039 (aceptado, interno de R4) |
| **Existe en la CIA (según los docs de R4)** | Autoridad designada (CIA-D1-01; [ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md) sigue en PROPUESTA). Sólo modo sintético. Grants para `sales_context` y `purchase_history` (`identity/http/src/start.ts:77`). **El propósito `purchase` no existe**: sólo está diseñado en H3 (candidato, CIA `39342b2`) |
| **Falta para el carril WhatsApp** | CIA: modo productivo, C-CIA-1..8 (audiencia por propósito, `purchase` para R4, claves KMS), proveedor de cuentas de la tienda (DEP-3), credencial (DEP-2), correo real (DEP-5), retención (DEP-10), lista de revocación (OD-CIA-4). R4: propósito `purchase`; `identity.resolve(['purchase'])` determinista dentro de `checkout.start_purchase`; grant en su propia cabecera; composición real (hoy rechazada); identidad compuesta en un perfil de carril (`@15`, `@17` no la tienen); cierre de RR-1, OA-10 (custodia de claves) y BA-*. Correos reales: decisión D7 (OA-04 sólo permite sintético). Datos reales: J7 |
| **Dueños** | Owner CIA (H3, C-CIA-*, modo productivo); owner e-commerce (DEP-2/3); owner R4 (composición); owner de datos (OA-04) |
| **Evaluación** | L1: `identity-http-contract` contra el contrato `purchase` publicado; L2: suites `identity-verification*`, `binding-identity-immutability`, `rr1` y sus mutaciones (`test:mutation:identity-verification*`, `rr1`, `binding-immutability`); interop R4→CIA en modo productivo; prueba de que `customerRef` y el grant no llegan al modelo; gate G3 de readiness §7 |

### 2.2 Consentimiento de compra

| | Detalle |
|---|---|
| **Existe en R4** | Gramática cerrada del pedido de pago `r4-sales-purchase-es-v1` (`isExplicitPurchaseRequest`, `capabilities/checkout.ts`); puerto `CheckoutConsentSource` (`adapters/domains/src/checkout/port.ts`); fuente **sólo sandbox** `SandboxConsentDirectory` (`checkout/http/src/sandbox-consent.ts`), que entrega sin modificar un artefacto firmado por la herramienta de prueba de Checkout. Validado en E3-A ([E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §8, punto 5). Regla R-3: **R4 nunca firma consentimientos** |
| **Existe en Checkout (según los docs)** | Artefacto JWS ligado a la cotización (`quoteId`, versión, `semanticSnapshotHash`); verificador sólo de prueba; `realConsentApproved=false`. El comprador sale del sujeto del consentimiento: **mezcla identidad y consentimiento** (E2E integrado §4) |
| **Falta** | Decisión sobre **quién firma** el consentimiento productivo (Checkout, CIA u otro emisor autorizado; los docs sólo dicen «un emisor de prueba autorizado o el grant CIA `purchase`»). Captura determinista del acto de compra desde el inbound registrado por la plataforma (patrón ADR-035), en lugar del directorio sandbox. En Checkout: verificador real, comprador = `grant.sub` y consentimiento sólo como prueba del acto (C-3 de Checkout). Audiencia y revocación del artefacto (ausentes en el de prueba) |
| **Dueños** | Owner R4 (captura); owner Checkout (verificador, separación); owner CIA (si el grant participa); owner comercial (texto que el cliente acepta) |
| **Evaluación** | L1 unit de la gramática y de la captura; suite `checkout` y su mutación R-3 («consentimiento de su cotización»); negativos de G6: inicio sin pedido explícito, sin consentimiento, con cotización ajena o vencida, sin identidad verificada → rechazo sin envío |

### 2.3 Carrito técnico de Quote

| | Detalle |
|---|---|
| **Existe** | Decisión C-2: **Quote V2 crea el carrito**; Checkout no crea carritos (registro F0 §1). En Quote `a79d33f` el carrito está implementado y **apagado** (`QUOTE_CART_PREPARATION_ENABLED=false`, `QUOTE_CART_H3_MODE=closed`, `verify` rechazado en producción); la migración `000010` está aplicada en producción ([gates F1](R4_F1_WHATSAPP_QUOTE_RELEASE_GATES.md) G5). Probado sólo en tienda aislada (SBX-2 y E3-A: un único `POST /api/carts`). En R4 no hay código de carrito: `checkout.start_purchase@1` sólo dispara `prepare` en Checkout |
| **Falta** | A7 aceptado (hoy candidato, [F0](R4_J5_F0_PLAN.md) §2) y X-1..X-7 resueltos; cambios de Quote para el grant productivo (`azp=r4-sales`, exigir exactamente `["purchase"]`, claims `bv` y `amount`, consumo del `jti`, no exponer `details.code`); owner e-commerce: totales `ps-cart-totals/v1` LIVE (E-3), transportista de retiro (E-5/O-10), llaves dedicadas (E-6), direcciones existentes (E-7), clon de la tienda (E-9); Fase C en el clon (gate G4). **Topología:** Catalog V2 entrega ids de la tienda productiva y la tienda aislada usa otros (E2E integrado §5) |
| **Contradicción a resolver** | El primer escenario de compra prevé **retiro en tienda** (readiness §9.1; D-02), pero la política F1 prohíbe presentar retiro y exige «Despacho: no incluido» ([política F1](R4_F1_COMMERCIAL_POLICY.md) §2). Un carrito necesita un transportista. Decisión O-6 |
| **Dueños** | Owner Quote (A7, verificador H3, Fase C); owner e-commerce (E-3..E-9); owner CIA (H3) |
| **Evaluación** | En Quote: CART-02B con totales reales en el clon, 7 simulacros de resultado incierto, mutaciones M1–M6, `BUYER_NOT_ELIGIBLE` para invitados. En R4: contrato del puerto Checkout y prueba de frontera de que R4 no crea carritos |

### 2.4 Checkout

| | Detalle |
|---|---|
| **Existe en R4 (PR #55, `96f6075`)** | Adaptador `@r4-adapters/checkout-http` (`R4_CHECKOUT_MODE=sandbox` únicamente; **no existe modo productivo**) con prueba de aislamiento sandbox antes de cada comando; capacidades `checkout.start_purchase@1`, `checkout.request_payment_link@1` (FINANCIAL) y `checkout.purchase_status@1` (READ); migraciones Sales `0010` y Core `0014` (aviso de plataforma: el modelo nunca ve la URL); perfil `@15` y definición candidata v15 (`production/profile-v15.ts`, `candidates/sales.v15.candidate.json`), inactivos; política `sales-production-checkout-sandbox-policy` (D7-6 sólo sandbox, ≤ 2 operaciones financieras por task); suite de mutación `checkout` (15/15 tras F-E3A-1). **E3-A validado** contra Mercado Pago de prueba (E2E integrado §8) |
| **Existe en Checkout (según los docs)** | AD-5 en `3d7b23d`, revisado (`CHECKOUT_AD5_REVIEW_PASS`); API de comandos sólo en el perfil `sandbox-purchase`; `live` prohibido en ese perfil; **repositorio sin remoto** |
| **Falta** | **Linaje:** `@15` es `@14` + Checkout, y `@14` quedó superado por `@16`/`@17` (F-WA-1, F-ADV-1) y sin F-ADV-2 ni la política F1; hace falta un perfil de carril nuevo sobre `@17` con número y definición según D-10. Evaluación de la definición con el modelo real (sin URL, montos ni acreditación escritos por el modelo; R4-CK-05/11) y extensión del evaluador de afirmaciones de pago (R-6). En Checkout: merge y remoto con CI (D-11), `/v1` aceptado (`1.0.4-proposed`), token de servicio (C-2), consentimiento y comprador reales (C-3), verificador del grant como `BuyerAuthorization`, firmante productivo del binding, direcciones (H2), OD-06/D-07. Política FINANCIAL no sandbox: D7-6/D-06 abierto (ADR de autonomía con identidad verificada, o aprobación humana, imposible hoy por BLK-AP1) |
| **Dueños** | Owner R4 (perfil, definición, política); owner Checkout (todo lo anterior en Checkout); owner comercial (D-08 reembolsos, D-09 cuenta Mercado Pago) |
| **Evaluación** | L2 completo (el cambio es transversal: perfil, composición, política), con todas las suites de mutación; `sales-checkout` y `platform-notice`; contrato del perfil nuevo; F-1..F-7 sólo en L3 antes de un despliegue con pagos ([estrategia 02](R4_TEST_STRATEGY_02.md) §6.1) |

### 2.5 Cierre de C1 (candidato a)

| | Detalle |
|---|---|
| **Existe** | AD-5 guarda una sola vez la hora del proveedor en la primera vista en proceso (`payment_started_at`), rechaza inicios posteriores al vencimiento y trata el inicio desconocido como `ACTION_REQUIRED`. Mitigación R4: no ofrecer un enlace a menos de 60 s de su vencimiento; `lateCapture` o anomalía → `HUMAN_INTERVENTION_REQUIRED` |
| **Falta** | Decisión del owner y del owner de Checkout: ¿un reintento o un pago offline cuentan como «iniciado»? Opciones documentadas: ligar la evidencia al pago acreditado (`date_created` del pago, o id e intento) o un tope de demora. Implementación y revisión independiente en Checkout. Junto a C1: OD-06/D-07 (vencimiento efectivo del enlace en el proveedor, abierto por decisión del owner) y las observaciones C2 y C3 |
| **Dueños** | Owner R4 + owner Checkout (decisión); owner Checkout (código) |
| **Evaluación** | Regresión en Checkout con la sonda de C1 (en proceso al minuto 10, captura 3 días después) y LATE-A/B/C ([sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §6); F-4, F-5 y F-7 del gate financiero |

### 2.6 Validación E2E controlada

| | Detalle |
|---|---|
| **Existe** | E3-A (`R4_QUOTE_CHECKOUT_SANDBOX_E2E_VALIDATED`): Quote → carrito → consentimiento de prueba → sesión → enlace → pago de prueba → webhook → conciliación → una orden, con recuperación e idempotencia. **No cubrió** WhatsApp, el modelo, Task Runtime, Policy Engine, Catalog V2, pagos rechazados o pendientes, OD-06 ni AD-5 con pago tardío real |
| **Falta** | E3-B desde WhatsApp, **bloqueado por topología** (opciones (a) tienda aislada con los mismos ids y precios, (b) E3-B sólo hasta la emisión, (c) esperar el camino productivo; E2E integrado §5). Inferencia no verificada en este repositorio: el owner mencionó un entorno de pruebas de la tienda con ids productivos, que podría ser la opción (a); requiere confirmación y su propia generación de Catalog. Identidad en el perfil de carril; E2E R4-CK-01..12 contra el runtime real; L3 sobre los SHAs fijos |
| **Evaluación** | E2E sandbox completo con los negativos de readiness §9.3 A (enlace vencido, webhook duplicado, pago tardío, diferencia de monto, doble inicio); criterios §9.4 (1 cotización, 1 carrito, 1 intento capturado, 1 cobro, 1 orden; montos idénticos; el agente nunca escribe la URL ni afirma un pago sin lectura); L3 con las 18 suites + F-1..F-7. Un `NOT_RUN` obligatorio bloquea |

## 3. Qué queda apagado en este incremento

- `R4_CHECKOUT_MODE` sólo admite `sandbox`; no se agrega un modo productivo.
- El carrito de Quote sigue apagado en producción (`QUOTE_CART_PREPARATION_ENABLED=false`).
- Checkout no se despliega en producción; Mercado Pago `live` sigue prohibido.
- Sin compras, cobros, órdenes ni reembolsos reales; D-13 (pago real) no se solicita.
- Sin política FINANCIAL productiva; D7-6 sigue sólo sandbox.
- Sin consentimiento real, correos u OTP reales ni datos reales de clientes (J7, OA-04).
- `@17`, su allowlist, sus límites y `@13` (rollback) no cambian. Ningún perfil nuevo se activa ni se registra en producción.

## 4. Secuencia propuesta

Cada paso requiere autorización propia. Los pasos externos (E) los ejecutan sus dueños; R4 sólo los solicita.

| # | Paso | Tipo | Entrada | Salida |
|---|---|---|---|---|
| S0 | Este plan + decisiones O-1..O-8 (§8) | Doc R4 | — | Decisiones registradas; R4-L autorizado o no, y con qué alcance |
| S1 | Aceptación cruzada de A7, H3 y Checkout `/v1`; X-1..X-7 resueltos (parte de G0) | E: CIA, Quote, Checkout | S0 | Contratos ACEPTADOS y publicados |
| S2 | **Identidad:** propósito `purchase` en el cliente CIA, `resolve` determinista en `start_purchase`, grant en su cabecera; composición real detrás de su gate, aún rechazada sin J7 | PR R4 | S1 (H3 y contrato CIA `purchase` publicados) | L2 de identidad + interop contra la CIA sintética con `purchase` |
| S2-E | CIA modo productivo, C-CIA-1..8, DEP-2/3/5/6/10 | E: CIA, e-commerce | S1 | Gate G3 en entorno no productivo |
| S3 | **Consentimiento:** captura determinista del acto desde el inbound registrado; adaptador a la fuente que decida O-5; R4 no firma | PR R4 | O-5 decidido; verificador real especificado por Checkout | Negativos G6 en L2; suite `checkout` N/N |
| S4 | **Perfil de carril Checkout sandbox** sobre `@17` (número y definición por D-10), con identidad y consentimiento de S2–S3; inactivo | PR R4 | D-10; S2, S3 | Contrato del perfil; L2 completo (transversal); evaluación de la definición con el modelo real (presupuesto aprobado) |
| S5 | **Carrito:** A7 en Quote, verificador H3, E-3..E-9, Fase C en el clon | E: Quote, e-commerce | S1 | G4 en el clon; carrito apagado en producción |
| S6 | **Checkout:** remoto y CI, merge de `pay-*`, verificador de grant, comprador = `grant.sub`, consentimiento real, firmante del binding | E: Checkout | S1, O-5 | Regresión completa de Checkout |
| S7 | **C1** (+ OD-06, C2, C3): decisión y corrección en Checkout | Decisión + E: Checkout | O-3, O-7 | Revisión independiente; LATE-A/B/C y sonda C1 en regresión |
| S8 | **E2E controlado sandbox desde WhatsApp** con el perfil de S4, comprador de prueba en allowlist propia, topología de O-4 | Ejecución | S2–S7; autorización por SHA; E-S1 nueva | R4-CK-01..12 real; L3 + F-1..F-7 en PASS; estado `R4_WHATSAPP_QUOTE_CHECKOUT_CANARY_READY_FOR_REVIEW` |

S2, S3 y S4 pueden avanzar en paralelo a S5–S7 con dobles contractuales. La primera compra real (readiness §9.3 B,
gate G7) **queda fuera** de este mandato.

## 5. Dependencias y dueños (resumen)

| Dueño | Entregables en el camino crítico |
|---|---|
| Owner R4 | S0, S2, S3, S4, S8; D-10; propuesta D7-6/D-06; L2/L3 |
| Owner CIA | H3, C-CIA-1..8, modo productivo, OD-CIA-4, CIA-CLAR-01 |
| Owner Quote | A7, verificador H3, cambios de grant (§2.3), Fase C |
| Owner Checkout | `/v1`, D-11, C-2/C-3, verificador real, C1, OD-06 |
| Owner e-commerce | E-1..E-9 (cuentas, totales, retiro, llaves, direcciones, clon) |
| Owner comercial | Texto del consentimiento, retiro vs política F1, D-08, D-09; límites de compra |

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Reutilizar `@15` traería de vuelta defectos corregidos en `@16`/`@17` (cantidad, variante, avisos, política F1) | Perfil nuevo sobre `@17` (S4) |
| Identidad y consentimiento mezclados en Checkout | Separación en S3/S6; comprador sólo desde `grant.sub` |
| Orden creada con un pago tardío (C1, OD-06) | S7 antes de cualquier pago; mitigación R4 de 60 s vigente |
| Topología: ids de Catalog productivo ≠ tienda aislada | O-4 antes de S8; sin remapeo artificial |
| Checkout sin remoto: pérdida de historial | D-11 al inicio de S6 |
| La cotización vence (60 min) mientras el cliente verifica su identidad (inferencia) | Orden del flujo y textos en S4; Checkout ya acota el enlace a la vigencia |
| Perturbar el canary F1 (`@17`) | Worker y perfil de carril propios (ADR-045); migraciones con todos los procesos a la vez |
| Fuga de identificadores en un repositorio público | Evidencia de campañas fuera del repositorio, como en E3-A |

## 7. Qué no hace este plan

No activa ni registra perfiles, no despliega, no cambia EC2, Quote, Checkout, CIA ni Catalog, no habilita el carrito,
no emite consentimientos, no inicia compras ni pagos y no avanza R4-L. **Nada se activa por este documento.**

## 8. Decisiones solicitadas al owner

| Id | Decisión | Dueño |
|---|---|---|
| O-1 | Nombre del incremento (evitar la colisión con F2 de J5) | Owner R4 |
| O-2 | Autorizar R4-L (o la parte sandbox de Checkout) para este incremento | Owner |
| O-3 | Confirmar que «C1» es la observación C1 de AD-5 (§1) | Owner |
| O-4 | Topología de E3-B: (a), (b) o (c) | Owner + e-commerce |
| O-5 | Emisor del consentimiento productivo (Checkout, CIA u otro); R4 sólo captura | Owner + Checkout + CIA |
| O-6 | Entrega del primer escenario: retiro (contradice la política F1) u otra | Owner comercial |
| O-7 | C1: ¿un reintento o un pago offline cuentan como «iniciado»? | Owner + Checkout |
| O-8 | D-10 (número de perfil y definición) y D7-6/D-06 para uso no sandbox | Owner R4 |
