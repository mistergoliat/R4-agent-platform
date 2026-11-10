---
title: R4 — Plan del siguiente incremento de integración desde WhatsApp (identidad, consentimiento, carrito, Checkout, C1, E2E)
status: R4_CHECKOUT_IDENTITY_INTEGRATION_READY_FOR_REVIEW — el owner autorizó el 2026-11-10 R4-L como trabajo de integración («Se autoriza comenzar R4-L como trabajo de integración.»). Nada se activa: sin Checkout productivo, perfiles, despliegues, compras ni pagos
mandate: «R4 — F1 CANARY CONTINUATION AND QUOTE DELIVERY», sección E (owner); «R4 — PDF DELIVERY, UX AND CHECKOUT NEXT INCREMENT», sección D (owner, 2026-11-10)
date: 2026-11-10
base: main a704319
audit: R4_L_CHECKOUT_IDENTITY_INTEGRATION_AUDIT.md
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

**Autorización del owner (2026-11-10).** El mandato «R4 — PDF DELIVERY, UX AND CHECKOUT NEXT INCREMENT», sección D,
dice: «Se autoriza comenzar R4-L como trabajo de integración. Auditar: Identidad CIA. Referencia del comprador
PrestaShop. Consentimiento `purchase`. Preparación del carrito por Quote. Contrato Checkout. Modalidad autorizada de
entrega. Riesgo C1 de AD-5. No crear nuevas autoridades de identidad ni consentimiento. No activar Checkout productivo.
El PR #64 debe identificar explícitamente las decisiones O-1 a O-8 con sus definiciones originales. No inferir su
significado.» La auditoría está en [R4_L_CHECKOUT_IDENTITY_INTEGRATION_AUDIT.md](R4_L_CHECKOUT_IDENTITY_INTEGRATION_AUDIT.md).
Esta revisión del plan reemplaza toda inferencia por citas de su fuente o por la constancia «not defined in this
repository» (§8, §9). **Nada se activa.**

## 1. Qué significa «C1»

En este repositorio el identificador «C1» tiene varias definiciones. Se citan todas, sin elegir entre ellas:

| # | Fuente (archivo, sección) | Texto original |
|---|---|---|
| a | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §1, «Observaciones (deciden el owner y el owner de Checkout)» | «**C1 (media).** La evidencia de inicio es la primera vista de la *orden* en proceso, sin tope de tiempo.» |
| b | [Roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §1 (tabla de fases) y §3 | Fase «R4-C1», «Execution Kernel», «Completado y publicado (baseline `834a5f1`)». §3: «R4-C se dividió en C1 (ejecución: worker, leases, kernel, decisiones, READ, observations, budgets, terminación, recuperación) y C2 (contexto: Context Compiler, memoria, proyección de conversación).» ADR-007 a ADR-028 usan «C1» en este sentido |
| c | [Informe J3E-C1](R4-J3E_C1_IMPLEMENTATION_REPORT.md), título; [cierre J3](../acceptance/R4_J3_CLOSURE_RECORD.md) | «R4-J3E-C1 — Deterministic Offer & Write Safety: informe de implementación». Cierre: «Merge de J3E-C1 en `main`»: «`b5fd288`, `--no-ff`, padres `092715e` y `b9fac24`» |
| d | [Corrección DS-1 de retiro](R4_J5_F1_DS1_PICKUP_CORRECTION_REPORT.md) §3 | Prueba `C1 ausencia de despacho`, que fija: `«Sin despacho» no es retiro` |
| e | [Aceptación final J3](../acceptance/R4_J3_FINAL_ACCEPTANCE.md) §4, escenario S4 | Etiqueta «DOQ C1». Su definición: **not defined in this repository** (búsqueda: `docs/**/*.md`) |

No son «C1»: C-1 de descuentos ([registro F0](R4_J5_F0_OWNER_DECISION_RECORD.md) §1) ni C-1 «servidor de comandos»
de Checkout ([integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §6.3).

**Cuál nombró el owner.** El mandato del 2026-11-10 nombra «Riesgo C1 de AD-5». La única definición de un C1 de AD-5
en este repositorio es la (a), que se cita completa:

> - **C1 (media).** La evidencia de inicio es la primera vista de la *orden* en proceso, sin tope de tiempo.
>   - Con `waiting_retry` (cobro fallido y reintento) o pagos offline (`waiting_payment`/`waiting_transfer`), la transacción acreditada puede iniciarse mucho después del vencimiento y aun así crear la orden. Sonda: en proceso en el minuto 10, capturado 3 días después → orden.
>   - Cumple la letra de AD-5 («iniciado antes»), pero el owner debe decidir si un reintento o un pago offline cuentan como «iniciado».
>   - Mitigación posible: ligar la evidencia al pago acreditado (`date_created` de `/v1/payments`, o id e intento), o poner un tope de demora.
>   - **No bloquea el E3-A** con tarjeta de prueba. **Sí debe resolverse antes de producción.**

En el resto de este plan, «C1» significa exclusivamente ese texto.

## 2. Inventario por prioridad

### 2.1 Identidad CIA

| | Detalle |
|---|---|
| **Existe en R4** | Verificación por OTP sólo sintética: `identity.start_verification@1` e `identity.verification_status@1` (`agents/sales/src/capabilities/identity-verification.ts`); adaptadores `adapters/domains/identity/http` y `adapters/domains/identity/verification`; punto de inspección de ingreso (ADR-040). La única composición es `customer-synthetic.ts`, que **rechaza `R4_CUSTOMER_MODE=real`**. Sólo `@8` la compone. Decisiones de diseño en [SEC-OTP](R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md) §13 y [SEC-S5](R4_J4_SEC_S5_COMMERCIAL_VERIFICATION_REPORT.md); ADR-039 (aceptado, interno de R4) |
| **Existe en la CIA (según los docs de R4)** | Autoridad designada (CIA-D1-01; [ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md) sigue en PROPUESTA). Sólo modo sintético. El adaptador R4 pide sólo los propósitos `sales_context` y `purchase_history` (`adapters/domains/identity/http/src/start.ts:77`; `CUSTOMER_PURPOSES` en `adapters/domains/src/customer/profile-port.ts:27`). **El propósito `purchase` no existe**: sólo está diseñado en H3 (candidato, CIA `39342b2`) |
| **Falta para el carril WhatsApp** | CIA: modo productivo, C-CIA-1..8 (audiencia por propósito, `purchase` para R4, claves KMS), proveedor de cuentas de la tienda (DEP-3), credencial (DEP-2), correo real (DEP-5), retención (DEP-10), lista de revocación (OD-CIA-4). R4: propósito `purchase`; `identity.resolve(['purchase'])` determinista dentro de `checkout.start_purchase`; grant en su propia cabecera; composición real (hoy rechazada); identidad compuesta en un perfil de carril (`@15`, `@17` no la tienen); cierre de RR-1, OA-10 (custodia de claves) y BA-*. Correos reales: decisión D7 (OA-04 sólo permite sintético). Datos reales: J7 |
| **Dueños** | Owner CIA (H3, C-CIA-*, modo productivo); owner e-commerce (DEP-2/3); owner R4 (composición); owner de datos (OA-04) |
| **Evaluación** | L1: `identity-http-contract` contra el contrato `purchase` publicado; L2: suites `identity-verification*`, `binding-identity-immutability`, `rr1` y sus mutaciones (`test:mutation:identity-verification*`, `rr1`, `binding-immutability`); interop R4→CIA en modo productivo; prueba de que `customerRef` y el grant no llegan al modelo; gate G3 de readiness §7 |

### 2.2 Consentimiento de compra

| | Detalle |
|---|---|
| **Existe en R4** | Gramática cerrada del pedido de pago `r4-sales-purchase-es-v1` (`isExplicitPurchaseRequest`, `capabilities/checkout.ts`); puerto `CheckoutConsentSource` (`adapters/domains/src/checkout/port.ts`); fuente **sólo sandbox** `SandboxConsentDirectory` (`checkout/http/src/sandbox-consent.ts`), que entrega sin modificar un artefacto firmado por la herramienta de prueba de Checkout. Validado en E3-A ([E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §8, punto 5). Regla R-3: **R4 nunca firma consentimientos** |
| **Existe en Checkout (según los docs)** | Artefacto JWS ligado a la cotización (`quoteId`, versión, `semanticSnapshotHash`); verificador sólo de prueba; `realConsentApproved=false`. El comprador sale del sujeto del consentimiento: **mezcla identidad y consentimiento** (E2E integrado §4) |
| **Falta** | Decisión sobre **quién firma** el consentimiento productivo (Checkout, CIA u otro emisor autorizado; [integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §7.2: «Se requiere un servicio emisor de prueba autorizado, o el grant CIA `purchase`.»; ver O-5 en §8). Captura determinista del acto de compra desde el inbound registrado por la plataforma (patrón ADR-035), en lugar del directorio sandbox. En Checkout: verificador real, comprador = `grant.sub` y consentimiento sólo como prueba del acto (C-3 del contrato Checkout, §9). Audiencia y revocación del artefacto (ausentes en el de prueba) |
| **Dueños** | Owner R4 (captura); owner Checkout (verificador, separación); owner CIA (si el grant participa); owner comercial (texto que el cliente acepta) |
| **Evaluación** | L1 unit de la gramática y de la captura; suite `checkout` y su mutación R-3 («consentimiento de su cotización»); negativos de G6: inicio sin pedido explícito, sin consentimiento, con cotización ajena o vencida, sin identidad verificada → rechazo sin envío |

### 2.3 Carrito técnico de Quote

| | Detalle |
|---|---|
| **Existe** | Decisión C-2: **Quote V2 crea el carrito**; Checkout no crea carritos (registro F0 §1). En Quote `a79d33f` el carrito está implementado y **apagado** (`QUOTE_CART_PREPARATION_ENABLED=false`, `QUOTE_CART_H3_MODE=closed`, `verify` rechazado en producción); para la migración `000010`, la matriz de [gates F1](R4_F1_WHATSAPP_QUOTE_RELEASE_GATES.md) §1.1 («actualizada 2026-11-09») dice en G5 «**Hecho**: aplicada (aditiva, 890 ms ensayada)», y §2 del mismo documento dice «**No aplicada en ningún entorno.**»: no concuerdan. Probado sólo en tienda aislada (SBX-2 y E3-A: un único `POST /api/carts`). En R4 no hay código de carrito: `checkout.start_purchase@1` sólo dispara `prepare` en Checkout |
| **Falta** | A7 aceptado (hoy candidato, [F0](R4_J5_F0_PLAN.md) §2) y X-1..X-7 resueltos; cambios de Quote para el grant productivo (`azp=r4-sales`, exigir exactamente `["purchase"]`, claims `bv` y `amount`, consumo del `jti`, no exponer `details.code`); owner e-commerce: totales `ps-cart-totals/v1` LIVE (E-3), transportista de retiro (E-5/O-10), llaves dedicadas (E-6), direcciones existentes (E-7), clon de la tienda (E-9); Fase C en el clon (gate G4). **Topología:** Catalog V2 entrega ids de la tienda productiva y la tienda aislada usa otros (E2E integrado §5) |
| **Contradicción a resolver** | El primer escenario de compra prevé «**Retiro en tienda**, costo 0 (`pickup-zero-v1`, S3)» (readiness §9.1; D-02). La [política F1](R4_F1_COMMERCIAL_POLICY.md) §2 dice: «Una cotización sin despacho dice «Despacho: no incluido». **Nunca** se presenta como entrega gratuita ni como retiro disponible.» El flujo de readiness §9.2 (paso 5) dice: «Quote crea el carrito con el `id_customer` del grant, la dirección del cliente, el transportista de retiro y un `specific_price` por línea». Decisión O-6 (§8.6) |
| **Dueños** | Owner Quote (A7, verificador H3, Fase C); owner e-commerce (E-3..E-9); owner CIA (H3) |
| **Evaluación** | En Quote: CART-02B con totales reales en el clon, 7 simulacros de resultado incierto, mutaciones M1–M6, `BUYER_NOT_ELIGIBLE` para invitados. En R4: contrato del puerto Checkout y prueba de frontera de que R4 no crea carritos |

### 2.4 Checkout

| | Detalle |
|---|---|
| **Existe en R4 (PR #55, `96f6075`)** | Adaptador `@r4-adapters/checkout-http` (`R4_CHECKOUT_MODE=sandbox` únicamente; **no existe modo productivo**) con prueba de aislamiento sandbox antes de cada comando; capacidades `checkout.start_purchase@1`, `checkout.request_payment_link@1` (FINANCIAL) y `checkout.purchase_status@1` (READ); migraciones Sales `0010` y Core `0014` (aviso de plataforma: el modelo nunca ve la URL); perfil `@15` y definición candidata v15 (`production/profile-v15.ts`, `candidates/sales.v15.candidate.json`), inactivos; política `sales-production-checkout-sandbox-policy` (D7-6 sólo sandbox, ≤ 2 operaciones financieras por task); suite de mutación `checkout` (15/15 tras F-E3A-1). **E3-A validado** contra Mercado Pago de prueba (E2E integrado §8) |
| **Existe en Checkout (según los docs)** | AD-5 en `3d7b23d`, revisado (`CHECKOUT_AD5_REVIEW_PASS`); API de comandos sólo en el perfil `sandbox-purchase`; `live` prohibido en ese perfil; **repositorio sin remoto** |
| **Falta** | **Linaje:** `@15` es `@14` + Checkout, y `@14` quedó superado por `@16`/`@17` (F-WA-1, F-ADV-1) y sin F-ADV-2 ni la política F1; hace falta un perfil de carril nuevo sobre `@17` con número y definición según D-10. Evaluación de la definición con el modelo real («sin URL, montos ni acreditación escritos por el modelo», [sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §8.2 punto 8) y extensión del evaluador de afirmaciones de pago (R-6). En Checkout: merge y remoto con CI (D-11), `/v1` aceptado (`1.0.4-proposed`), token de servicio (C-2 del contrato Checkout), consentimiento y comprador reales (C-3 del contrato Checkout), verificador del grant como `BuyerAuthorization`, firmante productivo del binding, direcciones (H2), OD-06/D-07. Política FINANCIAL no sandbox: D7-6/D-06 abierto (ADR de autonomía con identidad verificada, o aprobación humana, imposible hoy por BLK-AP1) |
| **Dueños** | Owner R4 (perfil, definición, política); owner Checkout (todo lo anterior en Checkout); owner comercial (D-08 reembolsos, D-09 cuenta Mercado Pago) |
| **Evaluación** | L2 completo (el cambio es transversal: perfil, composición, política), con todas las suites de mutación; `sales-checkout` y `platform-notice`; contrato del perfil nuevo; F-1..F-7 sólo en L3 antes de un despliegue con pagos ([estrategia 02](R4_TEST_STRATEGY_02.md) §6.1) |

### 2.5 Riesgo C1 de AD-5

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
| **Falta** | E3-B desde WhatsApp, **bloqueado por topología** (opciones (a) tienda aislada con los mismos ids y precios, (b) E3-B sólo hasta la emisión, (c) esperar el camino productivo; E2E integrado §5). Un entorno de pruebas de la tienda con los identificadores productivos **no está documentado en este repositorio** (búsqueda en `docs/**/*.md`: «clon», «staging», «QA»; sólo aparecen el «clon de staging de la tienda productiva» pedido como E-9 y la «Fase C sobre un clon»); si existe, su registro es entrada de O-4. Identidad en el perfil de carril; E2E R4-CK-01..12 contra el runtime real; L3 sobre los SHAs fijos |
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
| Owner Checkout | `/v1`, D-11, C-2/C-3 del contrato Checkout, verificador real, C1, OD-06 |
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
| Vigencia de la cotización frente a la verificación de identidad. Hechos: «Vigencia de 60 minutos, fijada por Quote» ([política F1](R4_F1_COMMERCIAL_POLICY.md) §1, regla 8); en el flujo de [readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §9.2 la verificación (paso 3) va después de la emisión (paso 2). La duración de una verificación OTP real **no está medida en este repositorio** | Orden del flujo y textos en S4. Checkout acota el enlace: «`expiresAt = min(creación + 900 s, vigencia de la cotización)`» ([integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §6.1) |
| Perturbar el canary F1 (`@17`) | Worker y perfil de carril propios (ADR-045); migraciones con todos los procesos a la vez |
| Fuga de identificadores en un repositorio público | Evidencia de campañas fuera del repositorio, como en E3-A |

## 7. Qué no hace este plan

No activa ni registra perfiles, no despliega, no cambia EC2, Quote, Checkout, CIA ni Catalog, no habilita el carrito,
no emite consentimientos, no inicia compras ni pagos, no crea autoridades de identidad ni de consentimiento y no lleva
R4-L más allá de lo que el owner autorizó el 2026-11-10 («trabajo de integración»; «No activar Checkout productivo»).
**Nada se activa por este documento.**

## 8. Decisiones O-1 a O-8

**Origen.** O-1 a O-8 son las decisiones que este plan pidió en su primera versión (commit `7b696f6`, §8). La tabla
reproduce su texto original sin cambios. Las subsecciones citan, para cada ítem que mencionan, su definición de
origen. **Colisión:** otros documentos usan O-1 a O-11 y O-18 con otros significados (§10). Los O-n de esta sección
son sólo los de este plan.

| Id | Decisión (texto original, `7b696f6` §8) | Dueño (original) | Estado al 2026-11-10 |
|---|---|---|---|
| O-1 | Nombre del incremento (evitar la colisión con F2 de J5) | Owner R4 | Abierta |
| O-2 | Autorizar R4-L (o la parte sandbox de Checkout) para este incremento | Owner | **Resuelta** (mandato «R4 — ACTIVACIÓN @18, CIERRE @19 Y DECISIONES R4-L» (2026-11-10)): «Iniciar R4-L exclusivamente como integración sandbox.» (§11) |
| O-3 | Confirmar que «C1» es la observación C1 de AD-5 (§1) | Owner | **Resuelta** (mandato «R4 — ACTIVACIÓN @18, CIERRE @19 Y DECISIONES R4-L» (2026-11-10)): «5. Corrección de AD-5/C1.» (§11) |
| O-4 | Topología de E3-B: (a), (b) o (c) | Owner + e-commerce | Abierta |
| O-5 | Emisor del consentimiento productivo (Checkout, CIA u otro); R4 sólo captura | Owner + Checkout + CIA | **Abierta en cuanto al emisor.** El mandato «R4 — ACTIVACIÓN @18, CIERRE @19 Y DECISIONES R4-L» (2026-11-10) fija la dirección («2. Separación de identidad y consentimiento en Checkout.», «3. Captura determinista de aceptación.») sin nombrar el emisor (§11) |
| O-6 | Entrega del primer escenario: retiro (contradice la política F1) u otra | Owner comercial | Abierta |
| O-7 | C1: ¿un reintento o un pago offline cuentan como «iniciado»? | Owner + Checkout | Abierta |
| O-8 | D-10 (número de perfil y definición) y D7-6/D-06 para uso no sandbox | Owner R4 | Abierta |

### 8.1 O-1 — «F2 de J5»

| Ítem | Fuente | Texto original |
|---|---|---|
| F2 (plan J5 F0–F8) | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §7 | «F2 — Catálogo veraz (paralela a F1)»; «Ejecutar D-01: cutover V2 con re-enlace R4 y G-1..G-4, o un conjunto interino de SKUs.» |
| F2 | [Registro F0](R4_J5_F0_OWNER_DECISION_RECORD.md) §8 | «F2: Catalog con fuente comercial vigente.» |
| J5 | [Roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §1.1 | Hito «J5 — Sales Autonomy»: «Comportamiento del agente con Customer: estrategia, personalización, objetivos, prompts» |

Las dos definiciones de F2 concuerdan (catálogo). El mandato del 2026-11-10 no fija un nombre para este incremento.

### 8.2 O-2 — «R4-L»

| Ítem | Fuente | Texto original |
|---|---|---|
| R4-L | [Roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §1 (tabla de fases) | Fase «R4-L», nombre «Extended Platform», estado «No iniciado» |
| C-3 | [Registro F0](R4_J5_F0_OWNER_DECISION_RECORD.md) §1 | «J5 conserva Sales Autonomy. R4-L conserva Checkout y pagos. F0–F8 es el plan transversal de integración y **no reemplaza** la estructura vigente del roadmap» |
| C-3 | [Roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §1.1 | «J5 conserva Sales Autonomy y R4-L conserva Checkout y pagos (C-3).» |
| F5 | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §7 | «F5 — Checkout y Mercado Pago (R4-L)» |
| Regla de fases | `AGENTS.md`, «Engineering» | «Do not advance roadmap phases without explicit authorization.» |
| Autorización | Mandato del owner, 2026-11-10, §D | «Se autoriza comenzar R4-L como trabajo de integración.» … «No activar Checkout productivo.» |

Las fuentes concuerdan. La fila R4-L del roadmap sigue diciendo «No iniciado»: este PR no la cambia (decisión
R4L-D4 de la [auditoría](R4_L_CHECKOUT_IDENTITY_INTEGRATION_AUDIT.md) §9).

### 8.3 O-3 — «C1» y «AD-5»

| Ítem | Fuente | Texto original |
|---|---|---|
| C1 | §1 de este plan | Todas las definiciones de «C1» del repositorio, citadas |
| C1 de AD-5 (la que nombra el owner) | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §1 | «**C1 (media).** La evidencia de inicio es la primera vista de la *orden* en proceso, sin tope de tiempo.» (completo en §1) |
| Revisión de AD-5 | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §0 | «Revisión independiente de AD-5»: «**`CHECKOUT_AD5_REVIEW_PASS`**, con tres observaciones para el owner (§1)» |
| AD-5 (implementación) | [Sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §10.3 | «Corrección implementada en el repositorio Checkout: rama local `pay-02c-ad5-late-capture`, commit `3d7b23d`, **sin revisión independiente todavía**.» |
| AD-5 (texto de la decisión) | — | **not defined in this repository.** Búsqueda: `docs/**/*.md` («AD-5»). Sólo hay descripciones de su regla (sandbox E2E §10.3) y la cita «iniciado antes» (E2E integrado §1). Es una decisión del repositorio de Checkout |

### 8.4 O-4 — «E3-B» y sus opciones

| Ítem | Fuente | Texto original |
|---|---|---|
| E3-B | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §0 | «Preparación de E3-B desde WhatsApp»: «**BLOQUEADA por topología** (§5): Catalog V2 productivo y la PrestaShop aislada no comparten identificadores» |
| (a) | Ídem §5 | «Una PrestaShop aislada clonada de la productiva (mismos ids y precios) con su propia generación de Catalog V2. Infraestructura nueva.» |
| (b) | Ídem §5 | «Ejecutar E3-B sólo hasta la emisión de Quote (Catalog real, Discover, Shipping, oferta y confirmación) y dejar el carrito y el pago en E3-A.» |
| (c) | Ídem §5 | «Esperar al camino productivo (CIA `purchase`, H3, AD-5 con C1 resuelto, F-1..F-7).» |
| E3-A | Ídem §8 | «`R4_QUOTE_CHECKOUT_SANDBOX_E2E_VALIDATED`, para el alcance de E3-A.» |

### 8.5 O-5 — emisor del consentimiento productivo

| Ítem | Fuente | Texto original |
|---|---|---|
| R-3 / C-3 | [Integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §7.2, punto 1 | «R4 no lo firma: sería convertirse en autoridad de consentimiento.» «Se requiere un servicio emisor de prueba autorizado, o el grant CIA `purchase`.» |
| R-3 | Ídem §6.3 | «R-3: R4 no firmará consentimientos;» |
| R-3 (código) | `adapters/domains/src/checkout/port.ts`, JSDoc de `CheckoutConsentSource` | «Where the purchase-consent artifact comes from (contract R-3: a CIA `purpose: purchase` grant obtained at call time).» |
| Gate de `@15` | `agents/sales/src/production/profile-v15.ts`, requisito `consent-source` | «R4 never signs consent. Production: the CIA purpose purchase grant» |
| Producción | [Sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §8.2, punto 5 | «Producción necesita el grant CIA `purchase` (H3, C-CIA-1..8).» |
| H3 | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §4 | «H3 los separa: el grant prueba *quién*, el consentimiento prueba *la aceptación*, y el grant va en su propia cabecera.» |
| Checkout hoy | Ídem §4 | «**El contrato y el código actuales de Checkout los mezclan**: el comprador sale del sujeto del consentimiento. Para producción hay que separarlos: comprador = `sub` del grant; el consentimiento prueba sólo el acto.» |
| F6 | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §7 | «El consentimiento se captura con la compuerta de confirmación J3 (ADR-035) sobre un mensaje determinista.» |
| Contrato R-3 (texto original) | — | **not defined in this repository.** Está en Checkout, `docs/reviews/R4_CHECKOUT_INTEGRATION_CONTRACT.md` @ `d11e3c7` (frontmatter de la integración Checkout). Búsqueda: `docs/**/*.md`, `adapters/**/*.ts`, `agents/**/*.ts` |

**No concuerdan.** El código de R4 (port, gate de `@15`) y el sandbox E2E dicen que en producción el artefacto de
consentimiento es el grant CIA `purchase`. El E2E integrado (H3) separa el grant (quién) del consentimiento (la
aceptación). Readiness F6 dice que el consentimiento se captura con la compuerta J3 de R4. Este plan no elige.

### 8.6 O-6 — modalidad de entrega

| Ítem | Fuente | Texto original |
|---|---|---|
| Primer escenario | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §9.1, «Entrega» | «**Retiro en tienda**, costo 0 (`pickup-zero-v1`, S3). Sin despacho, sin promoción de $1 y sin mapa de transportistas» |
| D-02 | Ídem §4 | «Alcance de entrega del primer escenario: retiro (S3) y designación del transportista de retiro (O-10)», dueño «Owner e-commerce», «F4» |
| D-02 | [Plan F0](R4_J5_F0_PLAN.md) §6 | «D-02 Retiro en tienda y transportista», «Abierta», «Depende de E-5» |
| E-5 | Ídem §3 | «Transportista de retiro con costo 0 y su referencia (O-10)», consumidor «Quote», fase «F4», documento «CART-00 §4.1» |
| O-10 | — | **not defined in this repository.** Sólo aparece como etiqueta de «transportista de retiro» (readiness §1, §3.3, §4, §5, §7; plan F0 §3; integración Checkout §5; readiness E1 §1 y §6). Búsqueda: `docs/**/*.md` («O-10»). El plan F0 remite a «CART-00 §4.1», de Quote |
| Política F1, regla 7 | [Política F1](R4_F1_COMMERCIAL_POLICY.md) §1 | «Cotizaciones **sin despacho**», control «`shipping_not_in_f1`» |
| Política F1, regla 9 | Ídem §1 | «Sin carrito ni Checkout» |
| Política F1, presentación | Ídem §2 | «Una cotización sin despacho dice «Despacho: no incluido». **Nunca** se presenta como entrega gratuita ni como retiro disponible.» |

**Conflicto, sin resolver aquí:** el primer escenario de compra (readiness §9.1, D-02) es retiro en tienda; la política
F1 vigente en `@17` prohíbe presentar una cotización sin despacho como retiro disponible y excluye carrito y Checkout.
Ningún documento de este repositorio dice si la política F1 rige el incremento de compra.

### 8.7 O-7 — «iniciado» en C1

| Ítem | Fuente | Texto original |
|---|---|---|
| Pregunta | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §1, C1 | «Cumple la letra de AD-5 («iniciado antes»), pero el owner debe decidir si un reintento o un pago offline cuentan como «iniciado».» |
| Opciones | Ídem | «Mitigación posible: ligar la evidencia al pago acreditado (`date_created` de `/v1/payments`, o id e intento), o poner un tope de demora.» |
| Plazo | Ídem | «**No bloquea el E3-A** con tarjeta de prueba. **Sí debe resolverse antes de producción.**» |

### 8.8 O-8 — D-10, D7-6 y D-06

| Ítem | Fuente | Texto original |
|---|---|---|
| D-10 | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §4 | «Linaje de perfil y número de definición para la compra. Debe respetar el retiro de v9/`@9` y la reserva de v10/v11», dueño «Owner R4», «F6» |
| D-10 | [Plan F0](R4_J5_F0_PLAN.md) §6 | «D-10 Linaje de perfil para la compra», «Abierta», «Respeta el retiro de v9/`@9`» |
| D-06 | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §4 | «Política para la capacidad FINANCIAL de R4: ADR de autonomía análogo a ADR-043, o aprobación humana (requiere R7-3, BLK-AP1)», dueño «Owner R4», «F6» |
| D7-6 | [Decisión D-7](R4_J5_D7_COMMERCIAL_AUTONOMY_DECISION.md) §10 | «FINANCIAL (F6, D-06)», «**PENDIENTE DE F6**», «Opciones: (a) una ADR de autonomía FINANCIAL con identidad `verified` y límite de monto en la capacidad, que depende de F3; (b) aprobación humana, que depende de R7-3b (Approval Horizon Hold)» |
| D7-6 sandbox | [Sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §3 | «Decisión del owner (2026-11-06): política financiera exclusivamente sandbox para `@15`, alcance `checkout.start_purchase`, `checkout.request_payment_link` y `checkout.purchase_status`, máximo inicial de dos escrituras financieras autónomas por task.» |
| D7-6 (código) | `agents/sales/src/production/profile-v15.ts`, requisito `financial-policy` | «any non-sandbox use needs a new decision» |
| BLK-AP1 | [ADR-043](../adr/ADR-043-ordinary-quotes-without-human-approval.md), «Consecuencias» | «BLK-AP1: ningún perfil con `REQUIRE_APPROVAL` en un canal autónomo con clientes reales hasta *Approval Horizon Hold*» |

Las fuentes concuerdan: D-10 es la misma en readiness y en F0; D-06 y D7-6 tienen las mismas dos opciones; la decisión
del 2026-11-06 cubre sólo sandbox.

## 9. Definiciones de origen de los demás identificadores

Texto copiado de su fuente. «not defined in this repository» significa que se buscó en `docs/**/*.md` (y en el
código cuando se indica) sin encontrar una definición; nunca se completa por inferencia.

| Id | Fuente | Texto original o constancia |
|---|---|---|
| A7 | [Plan F0](R4_J5_F0_PLAN.md) §2 | «**A7**: preparación de carrito Quote/Checkout»; estado «CANDIDATO `a7-candidate-2.1/cart-02b-r1` (sin cambio de wire, sin cambio de id)». Su texto contractual (Quote, `docs/cart/QUOTE_V2_CART_CONTRACT_CANDIDATE.md` §12): not defined in this repository |
| H3 | Ídem §2 | «**H3**: autorización de compra CIA/Quote/Checkout»; «**Grant CIA:** formato `cv=1`, propósito `purchase`, audiencia `quote-cart-preparer`, `azp=r4-sales`, TTL ≤ 300 s, `jti`.»; «**Binding JWS de Checkout:** vincula cotización, versión, hash, tienda, sesión, consentimiento, comprador, direcciones y monto. Lleva `exp` ≤ al del grant y `jti` de uso único en Quote.» Su texto contractual (CIA, `contract/h3/PURCHASE_AUTHORIZATION_V1_CANDIDATE.md`): not defined in this repository |
| X-1 | Ídem §2.1 | «CART-00 §4.3 y A7 §4 fijan `azp=checkout`. La CIA (REV-08) define `azp` como el consumidor que llamó a `resolve`, y ése sólo puede ser R4. H3 propone `azp=r4-sales` (OQ-H3-1)». X-2..X-7: misma tabla, texto completo allí |
| E-3 | Ídem §3 | «Endpoint gobernado de totales del carrito `ps-cart-totals/v1` (D3)» |
| E-5 | Ídem §3 | «Transportista de retiro con costo 0 y su referencia (O-10)» |
| E-6 | Ídem §3 | «Llaves Webservice dedicadas de mínimo privilegio: Quote (carts, specific_prices, lecturas) y Checkout (orders, lecturas)» |
| E-7 | Ídem §3 | «Lectura de direcciones existentes del cliente para el binding H3 (G-ADDR mínimo). **Sin esto no hay binding real**, aunque el cliente ya tenga dirección» |
| E-9 | Ídem §3 | «Clon de staging de la tienda productiva (Fase C de Quote, PAY-00 de Checkout)» |
| C-CIA-1, -3, -8 | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §4 | «C-CIA-1 (audiencia por propósito), -2, -3 (`purchase` para `r4-sales`), -5, -6, -7 y -8 (claves KMS)» |
| C-CIA-2, -4, -5, -6, -7 | — | **not defined in this repository** (la lista anterior las nombra sin definirlas y omite -4; el plan F0 §2 dice «Los cambios de la CIA (C-CIA-1..8) están listados y no implementados.») |
| DEP-2, -3, -5, -6, -10 | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §3.4 | «El endpoint de lectura del proveedor es CANDIDATO y no está construido (DEP-3).» «Sin credencial (DEP-2), correo real (DEP-5), KMS (DEP-6) ni retención o aspectos legales (DEP-10).» Texto original (CIA, contrato `v1-d2` §11, según [auditoría cruzada](R4_J4_CROSS_REPO_ROADMAP_REBASE_REPORT.md) §5): not defined in this repository |
| OD-CIA-4 | Readiness §3.4 | «Una sola instancia, con rate limit en memoria. Sin lista de revocación (OD-CIA-4).» Texto original: not defined in this repository |
| CIA-D1-01 | [Registro compartido](R4-J4-R1C_SHARED_DECISION_REGISTER.md) §9 | «**D1**: owner productor de la CIA»: «**Designado.** La CIA es un servicio independiente (`MS-pesaschile-customer-identity-authority`)» |
| CIA-CLAR-01 | [SEC-OTP](R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md) §11 | «**Solicitud CIA-CLAR-01 al owner de la CIA** (no se modifica la CIA ni sus artefactos normativos)»; «Se pide aclarar en el texto normativo que se trata de **un consumidor con dos credenciales de distinto `kind`**.» |
| RR-1 | [Análisis RR-1](R4_J4_RR1_BINDING_RACE_ANALYSIS.md), «Origen» | «"Clausura concurrente de un binding durante una invocación ya iniciada. La invocación puede completar con el binding leído al inicio"». Concuerda con [cierre R3](R4_J4_R3_OWNER_MERGE_REPORT.md) §6 |
| OA-10 | [SEC-OTP](R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md) §13 | «Custodia productiva de claves, roles de base de datos, revisión de nginx y PM2», «Pendiente (datos reales)» |
| BA-01…BA-06 | Ídem §13 | «Bloqueos de activación de las entradas alternativas (§10)», «Pendientes (gate de activación real)» |
| OA-04 | Ídem §13 | «Política de datos personales del email (E1 frente a E2) y qué recibe la landing»: «**Decidido** (`R4-J4-SEC-OTP-OWNER-ACCEPTANCE-03`): E1 permitido **solo sintético**. Los correos reales requieren la decisión D7» |
| D7 (sin guion) | [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md), «Estado» | «D7 sigue como gate de datos reales y de producción.» |
| J7 | [Roadmap](../roadmap/R4_DELIVERY_ROADMAP.md) §1.1 | «J7 — Production Readiness»: «Activación productiva, datos y clientes reales, rollout de `@8` desde `@3` con rollback propio» |
| C-2 (registro F0) | [Registro F0](R4_J5_F0_OWNER_DECISION_RECORD.md) §1 | «**Quote V2 crea idempotentemente el carrito técnico PrestaShop.** Checkout no crea carritos ni recalcula cotizaciones» |
| C-2 / C-3 (contrato Checkout) | [Integración Checkout](R4_CHECKOUT_INTEGRATION_REPORT.md) §6.3 | «C-2 token de servicio CIA», «Abierto (bearer estático sandbox)»; «C-3 consentimiento y comprador reales», «Checkout/CIA», «**Abierto, bloqueante**». Texto del contrato: not defined in this repository |
| R-6 | Ídem §6.3 | «R-6 perfil y definición», «Hecho: `@15` / v15. La extensión del evaluador de afirmaciones de pago queda pendiente» |
| D-07 / OD-06 | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §4 | D-07: «TTL estricto del enlace (OD-06). **Owner, 2026-11-02:** sigue abierto. El cancel de Checkout por sí solo no basta; hace falta evidencia de expiración efectiva del enlace». Concuerda con el registro F0 §2. Texto original de OD-06 (Checkout): not defined in this repository |
| D-08 | Ídem §4 | «Política de reembolsos (OD-09)» |
| D-09 | Ídem §4 | «Cuenta Mercado Pago productiva y su titular» |
| D-11 | Ídem §4 | «Publicar el repositorio de Checkout en un remoto privado y activar CI» |
| D-13 | Ídem §4 | «Autorización explícita del pago real del primer escenario (monto máximo, tarjeta, reembolso)» |
| G3 | Ídem §7 | «el comprador interno vincula su `wa_id` con su cuenta PrestaShop por OTP real.» |
| G4 | Ídem §7 | «en el clon de staging, un carrito llega a `READY` con paridad exacta contra los totales de PrestaShop.» |
| G6 | Ídem §7 | «L2 con unit, contract y escenarios `sales` del flujo de compra contra un doble contractual de Checkout, `governed-execution` y `reconciliation`.» |
| G7 | Ídem §7 | «se cumplen todos los criterios de aceptación de §9.4, y el informe de conciliación muestra exactamente un cobro, un carrito y una orden.» |
| F-1..F-7 | [Estrategia 02](R4_TEST_STRATEGY_02.md) §6.1 | Tabla «El gate financiero» (F-1 «**Contratos**» … F-7 «**Mutaciones**»). Readiness §7 (G5) la resume y concuerda |
| LATE-A/B/C | [Sandbox E2E](R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md) §6 | «LATE-A: link aún `LINK_AVAILABLE`, pagado 1 min después de `expiresAt` (antes de que corra `EXPIRE_ATTEMPT`)»; «LATE-B (= CT-11 de Checkout): pago iniciado en el minuto 14, capturado en el 17»; «LATE-C (control): pagado después de que el intento quedó `EXPIRED`» |
| C2, C3 (AD-5) | [E2E integrado](R4_QUOTE_CIA_CHECKOUT_INTEGRATED_E2E_REPORT.md) §1 | «**C2 (baja, dirección segura).** Una captura hecha a tiempo pero vista después de otra actualización posterior queda retenida.» «**C3 (baja).** Se compara el reloj de Mercado Pago con el `expiresAt` de Checkout. Un desfase mayor que la tolerancia de 5 s podría aceptar un inicio levemente posterior.» |
| F-E3A-1 | Ídem §8 | «**F-E3A-1 (alta).** El contador D7-6 no contaba un intento que Checkout creó pero que R4 no alcanzó a registrar» |
| F-WA-1 | [Preparación canary Quote V2](R4_WHATSAPP_QUOTE_V2_CANARY_PREPARATION.md) §5.3 | «el modelo afirmó al comprador que había stock para la cantidad pedida, apoyándose en la vendibilidad agregada del producto, sin verificar la cantidad a nivel de ítem.» |
| F-ADV-1 | [Evaluación adversarial](R4_FWA_ADVERSARIAL_V16_V17_EVALUATION.md), tabla de hallazgos | «Afirmó una variante agotada como «la única disponible», infiriendo desde «1 de 4 variantes vendibles» y dos previews» |
| F-ADV-2 | [Gates F1](R4_F1_WHATSAPP_QUOTE_RELEASE_GATES.md) §5 | «F-ADV-2: aviso ante una consulta o derivación del agente» |
| CART-02B | [Readiness](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §3.6 | «**Carrito técnico (CART-02B, en main pero inactivo: sin ruta, scope ni migración).**» |
| M1–M6 (CART-02B) | — | **not defined in this repository** (readiness §3.6 y §8 sólo dicen «mutaciones M1–M6») |
| SBX-2 | — | **not defined in this repository** (campaña sandbox de Checkout; sólo se la menciona en la integración Checkout §2, §5 y en el sandbox E2E §10) |
| E-S1 | — | Procedimiento de autorización: **not defined in this repository**. La instancia de esta campaña se describe en el E2E integrado §2 («Nueva E-S1 `R4_QUOTE_CHECKOUT_E2E_SANDBOX` …») |
| R4-CK-01..12 | — | **not defined in this repository.** Sólo se citan como conjunto (integración Checkout §7.2; sandbox E2E §5 y §8.2) y R4-CK-04 en el sandbox E2E §3 («un link nuevo después de que el primero venció»). La versión anterior de este plan citaba «R4-CK-05/11» sin fuente; se retiró |
| H1, H2 (carrito) | — | **not defined in this repository** como ítems de carrito: readiness §1 usa «despacho no representable en el carrito (H1)»; E2E integrado §4 «Direcciones FALTAN (H2)». No confundir con H1–H3 del [plan J3E](R4_J3E_PRODUCTION_GAP_CLOSURE_PLAN.md) |

## 10. Colisiones de identificadores

| Identificador | Significados en este repositorio |
|---|---|
| O-n | Este plan (O-1..O-8). [Estrategia 02](R4_TEST_STRATEGY_02.md) §10 (O-1..O-9, optimizaciones de pruebas). [FWA-1](R4_FWA1_QUANTITY_AVAILABILITY_EVALUATION.md) y [adversarial](R4_FWA_ADVERSARIAL_V16_V17_EVALUATION.md) (O-1..O-4, observaciones). [Revisión G1](R4_J4_R7_G1_INDEPENDENT_REVIEW.md) (O-1..O-3). [Gates F1](R4_F1_WHATSAPP_QUOTE_RELEASE_GATES.md) §3 («condición O-1 de Quote», promociones). Readiness y F0: O-9, O-10, O-11, O-18 (servicios externos) |
| C1 | §1 (cinco usos) |
| C-2, C-3 | Registro F0 §1 (carrito, roadmap) frente a contrato Checkout (token de servicio, consentimiento y comprador) |
| H1, H2, H3 | Plan J3E (procedencia del input) frente a carrito/direcciones (H1, H2) y autorización de compra CIA (H3) |
| D7, D-7, D-07, D7-n | ADR-039 (datos reales), registro F0 §8 (techo de escrituras), readiness §4 (TTL del enlace), decisión D-7 (D7-1..D7-8) |

Las decisiones nuevas de la auditoría usan el prefijo **R4L-D**, que no aparece en ningún otro documento.

## 11. Decisiones del owner registradas (mandato «R4 — ACTIVACIÓN @18, CIERRE @19 Y DECISIONES R4-L» (2026-11-10))

**Texto del mandato (sección C), verbatim:**

> «Registrar como decisiones del owner las resoluciones O-1 a O-8 y R4L-D1 a D4 indicadas en este mandato.
> Iniciar R4-L exclusivamente como integración sandbox.
> Priorizar: 1. CIA `purchase` y su contrato real. 2. Separación de identidad y consentimiento en Checkout. 3. Captura determinista de aceptación. 4. Compatibilidad de carrito Quote y comprador identificado. 5. Corrección de AD-5/C1. 6. E2E sandbox desde WhatsApp cuando la topología lo permita.
> No habilitar pagos, órdenes ni carritos productivos.
> No sustituir las pruebas productivas de identidad por identidades sintéticas.»

**Registro.** Solo se anota como resuelto lo que el texto resuelve explícitamente; lo demás sigue abierto. Nada se infiere.

| Id | Estado | Fundamento (texto del mandato) |
|---|---|---|
| O-1 | Abierta | El mandato no nombra el incremento |
| O-2 | **Resuelta: R4-L iniciado, solo como integración sandbox** | «Iniciar R4-L exclusivamente como integración sandbox.» |
| O-3 | **Resuelta: «C1» es la observación C1 de AD-5, y debe corregirse** | «5. Corrección de AD-5/C1.» |
| O-4 | Abierta | «6. E2E sandbox desde WhatsApp cuando la topología lo permita.» condiciona el E2E sin elegir (a), (b) o (c) |
| O-5 | Abierta en cuanto al emisor | Dirección fijada: «2. Separación de identidad y consentimiento en Checkout.» y «3. Captura determinista de aceptación.» No se nombra quién emite el consentimiento |
| O-6 | Abierta | El mandato no se pronuncia sobre retiro frente a la política F1 |
| O-7 | Abierta | «Corrección de AD-5/C1» ordena corregir, pero no decide si un reintento o un pago offline cuentan como «iniciado» |
| O-8 | Abierta | El mandato no fija D-10 ni D7-6/D-06 |
| R4L-D1 | Abierta | El mandato no fija el tope de operaciones financieras en sandbox |
| R4L-D2 | Abierta | El mandato no decide entre consentimiento por sesión o por intento |
| R4L-D3 | **Resuelta: identidad y consentimiento separados en Checkout; el comprador sale de la identidad, el consentimiento prueba solo la aceptación** | «2. Separación de identidad y consentimiento en Checkout.» y «4. … comprador identificado.» Coincide con la opción de la fuente citada en la auditoría §9 («comprador = `sub` del grant; el consentimiento prueba sólo el acto») |
| R4L-D4 | **Resuelta: la fila R4-L del roadmap pasa a «Iniciado: solo integración sandbox (2026-11-10)»** | «Iniciar R4-L exclusivamente como integración sandbox.» |

**Restricciones registradas:**

- «No habilitar pagos, órdenes ni carritos productivos.»
- «No sustituir las pruebas productivas de identidad por identidades sintéticas.» Las pruebas sintéticas pueden servir en desarrollo, pero no cuentan como evidencia de identidad productiva.

### 11.1 Inicio de R4-L (solo sandbox): orden y dependencias externas

| # | Prioridad del mandato | Primer paso de R4 | Dependencia externa concreta (dueño) |
|---|---|---|---|
| 1 | CIA `purchase` y su contrato real | Cliente CIA con el propósito `purchase` y `resolve` determinista dentro de `checkout.start_purchase`, contra el contrato **publicado** | CIA publica el contrato `purchase` (H3) y lo pone en un entorno no productivo (owner CIA). Sin ese contrato, R4 no implementa contra supuestos |
| 2 | Separación de identidad y consentimiento en Checkout (R4L-D3) | El puerto de Checkout de R4 envía el grant de identidad aparte del artefacto de consentimiento | Checkout toma el comprador del grant y no del sujeto del consentimiento (owner Checkout; C-3 de Checkout) |
| 3 | Captura determinista de aceptación | Capturar el acto de compra desde el inbound registrado por la plataforma (patrón ADR-035), sin directorio sandbox de consentimientos; R4 no firma | Formato y verificador del artefacto que aceptará Checkout (owner Checkout; O-5 para el emisor) |
| 4 | Carrito Quote y comprador identificado | Contrato de puerto y prueba de frontera: R4 no crea carritos | Quote acepta A7 y verifica el grant H3; la tienda aislada entrega E-3..E-9 (owner Quote, owner e-commerce) |
| 5 | Corrección de AD-5/C1 | Mitigación vigente en R4: no ofrecer un enlace a menos de 60 s de su vencimiento | Checkout corrige C1. Para elegir la corrección se necesita O-7 (owner + owner Checkout) |
| 6 | E2E sandbox desde WhatsApp | Perfil de carril sandbox nuevo sobre el carril vigente (D-10, O-8) | Topología (O-4) y los pasos 1–5 |

Nada de esto activa pagos, órdenes ni carritos productivos.
