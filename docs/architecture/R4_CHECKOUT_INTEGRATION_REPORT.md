---
title: R4 — Integración Quote V2 + Checkout (carril WhatsApp)
status: R4_QUOTE_CHECKOUT_E2E_INTEGRATION_READY_FOR_REVIEW · R4_CHECKOUT_INTEGRATION_PARTIAL
mandates: «R4 — Quote V2 + Checkout E2E Integration» y «PesasChile — R4 Quote V2 + Checkout Integration» (owner, 2026-11-06)
date: 2026-11-06
base: main 7008048
branch: feat/r4-quote-checkout-e2e (local, sin push)
checkout-contract: MS-pesaschile-checkout docs/reviews/R4_CHECKOUT_INTEGRATION_CONTRACT.md @ d11e3c7
---

# R4 — Integración Quote V2 + Checkout

## 0. Resultado

| Mandato | Estado | Motivo |
|---|---|---|
| Quote V2 + Checkout E2E | **`R4_QUOTE_CHECKOUT_E2E_INTEGRATION_READY_FOR_REVIEW`** | Código listo para revisión. E2 y E3 siguen bloqueados fuera de R4 (§7) |
| Checkout Integration | **`R4_CHECKOUT_INTEGRATION_PARTIAL`** | Lado R4 implementado y probado contra un stub determinista. El E2E sandbox no puede ejecutarse: falta una fuente de consentimiento de compra (R-3), Quote debe ser la misma instancia que lee Checkout, y el runtime sandbox-purchase está detenido (§7.2) |

**Qué se hizo (solo local, en dos commits):**

1. **`sales-production@14`, carril de cotización E2.**
   - Es `@12` (emisión autónoma de la oferta confirmada, P-1, techos F1, kill switch) más Catalog V2 y Discover de `@13`.
   - Definición v14 = v12 + la línea Discover de v13.
   - **Inactivo:** el carril del gateway sigue en `@13`.
2. **`sales-production@15`, carril sandbox de Checkout E3.**
   - Es `@14` más tres capacidades Checkout, un cliente HTTP de las seis rutas y una primitiva genérica de aviso de plataforma (R-4) para entregar el link sin que el modelo lo escriba.
   - **No compone en producción:** exige una fuente de consentimiento, y R4 no tiene ninguna.

**Qué no se hizo:**

- push, merge o despliegue;
- cambios en la EC2;
- cambios en Quote, Checkout, CIA o Catalog;
- cambios en el kernel;
- llamadas a proveedores reales;
- cobros u órdenes.

**Lectura de producción.** La lectura de la EC2 para los SHAs desplegados fue **denegada** por el clasificador de permisos. Los SHAs desplegados de §2 provienen de los informes más recientes y **no se reverificaron** hoy.

## 1. Matriz de capacidades

| # | Paso del flujo | Componente existente | En R4 | Estado |
|---|---|---|---|---|
| 1 | Solicitar cotización | `quote.preview@3` (oferta renderizada por Sales `r4-sales-offer-es-v1`) | `@12`, ahora `@14`/`@15` | Existente, reutilizado |
| 2 | Confirmar la oferta | `quote.create@5`: la confirmación se lee del hilo registrado por la plataforma y se compara byte a byte con la oferta | ídem | Existente, reutilizado |
| 3 | Emitir mediante Quote | `quote.create@5` → `POST /v2/quotes`. La `Idempotency-Key` es la clave de ejecución; hay reconciliación por clave y kill switch | ídem | Existente; A10 ya en `main` (#32) |
| 4 | Consultar su estado | Proyección del workspace (`quoteReferences`, `sales.quote_v2_issued`) y lectura `getQuote` dentro de `checkout.start_purchase` | `@14`/`@15` | Existente. No hay capacidad de lectura de cotización para el modelo (no hacía falta) |
| 5 | Identificar al comprador | CIA `resolve` (sólo sintético); `identity.*` en `@8` sintético | — | **Falta:** no hay grant `purpose: purchase` (H3 candidato, C-CIA-1..8). El consentimiento de compra llega por el puerto `CheckoutConsentSource`, **sin implementación** |
| 6 | Preparar el carrito mediante Quote | Checkout `prepare` → `QuoteCartPreparer` de Quote (`POST /v2/quotes/{id}/cart-preparations` con H3) | `checkout.start_purchase@1` llama a `prepare`; R4 nunca crea carritos | Implementado (cliente). En Quote, el carrito existe en `main` pero está apagado |
| 7 | Solicitar el enlace | Checkout `POST /payment-attempts` | `checkout.request_payment_link@1`: lee primero; el link sale como aviso de plataforma | **Nuevo** |
| 8 | Informar el resultado acreditado | Checkout `GET` de sesión, intentos y órdenes | `checkout.purchase_status@1`, con el mapeo §6 del contrato | **Nuevo** |
| — | Historial, Discover, Shipping, consultas al administrador, aislamiento | `PriorConversationContextSource`, `catalog.discover`, `shipping.quote`, `request_consultation`, carril ADR-045 | Heredados sin cambios en `@14`/`@15` | Existente |

No se construyó un orquestador comercial. Se reutilizan:

- Policy Engine (perfil de política propio en `@15`);
- Task Runtime;
- ActionExecutor (idempotencia por clave de ejecución y recuperación);
- kill switch;
- el carril ADR-045;
- el único dueño de entrega de WhatsApp.

## 2. SHAs

| Repositorio | `main` | Candidato | Desplegado (según informes; **no reverificado**) |
|---|---|---|---|
| R4 | `7008048` | `feat/r4-quote-checkout-e2e`: `29120bb` (@14) y el commit de Checkout | `7008048`: gateway, worker, scheduler y worker del carril `@13` |
| Quote V2 | `a79d33f` (A10 `ca66a2e`, carrito #27/#28) | Ninguno aprobado. `a79d33f` trae la migración `000010` (tablas de carrito) | Contenedor de integración `6735352`: 36 commits atrás, sin A10, sin la política de 60 min y sin carrito; esquema `000009` |
| CIA | `7525395` (código `929e72e`) | H3 `39342b2`: candidato local, sólo documentación | No desplegado (sólo sintético) |
| Checkout | Sin remoto. `pay-02b`: `ccf3113` (implementación), `14335cb` (pila SBX-2), `d11e3c7` (informe y contrato) | `d11e3c7` | S0 `1a8a0ca` restaurado tras SBX-2 (perfil `sandbox`, sin API de comandos). `sandbox-purchase` detenido |
| Catalog V2 | `5f2c086` | — | Generación `af9e3f63…`; Discover READY |

**Divergencia de la rama local de R4:** `fix/r4-quote-a10-arithmetic` está 0 commits adelante y 100 atrás de `origin/main`, y su único commit (`89942da`) ya está en `main`. No se fusionó nada: el trabajo se hizo en un worktree nuevo desde `origin/main` (R-7).

## 3. Gate R1.7 de Quote

**Resultado: `NOT_MET`.** R4 no puede cerrarlo: requiere operación de Quote en la EC2 (restore, reinicio del host), que este mandato no autoriza.

| Sub-gate | Evidencia en Quote `main` | Estado |
|---|---|---|
| A. Contenido e identidad | `R1.7A_CLOSED=YES` (2026-10-07) | Cumplido |
| B. Infra y despliegue de integración | G1/G2 (2026-10-08): `QUOTE_V2_EC2_INTEGRATION_READY=YES`, `QUOTE_V2_READY_FOR_REAL_CUSTOMERS=NO`, `R1.7_FULL_PRODUCTION_ACCEPTANCE=NO` | Técnico sí, productivo no |
| C. Respaldo con restore real | Sólo plan. G2-D02 abierto | **No** |
| Reinicio del host | Sólo se reinició el contenedor (2 ciclos). G2-D03 abierto | **No** |
| Disco | 90 % usado, 1 064 MB libres. La próxima imagen puede no caber. G2-D01 abierto | **No** |
| D. Canary sintético productivo (§T) | Sólo E2E sintético 39/39 en integración | **No** |
| E. 7 días estables y corte de V1 | Sin evidencia | **No** |
| F. Aceptación del owner | Sin evidencia | **No** |

**Además:**

- El contenedor desplegado (`6735352`) no tiene A10. Con el R4 actual, una cotización multilínea recibe 422.
- Tampoco tiene la política `cl-retail-session-60m-v1`.

**Quote no pasa a R4.** R4 envía la oferta confirmada y `expectedTotals`. Quote numera, calcula y valida, y decide la vigencia según el `commercialProfile` del principal.

## 4. Integración Quote en el carril WhatsApp (E2)

**`sales-production@14`** (`agents/sales/src/production/profile-v14.ts`):

- **Composición:**
  - dominios de `@12`, más el dominio Catalog de `@13`;
  - capacidades de `@12`, más `catalog.discover`.
- **Comportamiento heredado sin cambios:**
  - `quote.preview@3`, `quote.create@5` y `sales.workspace.update@2`;
  - política autónoma;
  - guardia de paridad P-1 obligatoria;
  - límites de composición no más laxos que los techos F1 aprobados (250 000 CLP, 3 líneas, 5 unidades, 1 cotización por conversación, 2 por hora, ventana de 900 s);
  - kill switch sobre `createAndIssue`.
- **Asignación del carril:**
  - Es sólo perfil de carril (ADR-045): nunca es el perfil principal de un gateway ni un perfil de producción o de canary.
  - Su worker propio sirve únicamente v14.
- **Worker CLI:**
  - lee `R4_QUOTE_PARITY_*` para los perfiles que exigen paridad;
  - rechaza un techo de escrituras fuera de 1..6.
- **Definición v14.** Es v12 + la línea `catalog.discover` de v13, colocada tras `catalog.*`. Es un archivo candidato y sólo lo registra `bootstrap --lane`.
- **Deshabilitado hasta el gate.** El carril del gateway sigue en `@13`. Activar `@14` exige `SALES_PRODUCTION_PROFILE_V14_GATE`:
  - R1.7;
  - SHA candidato de Quote con A10 y la política de 60 min, y `000010` aprobada;
  - lockstep A10;
  - principal R4;
  - P-1;
  - DS-1 sobre v14;
  - F-E1-1;
  - observabilidad;
  - kill switch;
  - L3;
  - autorización por SHA.

**La emisión no requiere carrito.** Evidencia en el código de Quote:

- `POST /v2/quotes` no toca el carrito;
- las rutas de carrito sólo se montan con `QUOTE_CART_PREPARATION_ENABLED=true`;
- `000010` no modifica tablas de cotización.

## 5. Carrito (CIA ↔ Quote ↔ PrestaShop)

| Requisito | Estado real |
|---|---|
| Identificación real del comprador | **No existe.** CIA es sólo sintético (`validateConfig` exige `synthetic`) y no tiene camino real. DEP-2, DEP-3 (búsqueda de cuentas en la tienda), DEP-5, DEP-6 y DEP-10 siguen abiertos |
| Autorización del principal (grant de compra) | **No existe.** H3 es un candidato no normativo. C-CIA-1..8 están listados y no implementados. CIA emite grants sólo para `sales_context` y `purchase_history` |
| Resolución del cliente PrestaShop | Cliente en CIA (`account-provider.ts`). Productor inexistente en la tienda |
| Carrito técnico idempotente | Implementado en Quote `main`, apagado: `QUOTE_CART_PREPARATION_ENABLED=false`, `QUOTE_CART_H3_MODE=closed`, y `verify` rechazado en producción |
| Correspondencia de cliente, productos y totales | Checkout la verifica. `ps-cart-totals/v1` LIVE no existe (sólo OFFLINE, que **no** es evidencia productiva, M2) |
| Sin carritos duplicados | Ledger por clave de preparación en Quote (probado aislado, SBX-2: carrito 336) |
| Compatibilidad con Checkout | Probada sólo en el entorno aislado de SBX-2 |

Además faltan:

- transportista de retiro (O-10);
- dirección (H2) y envío (H1);
- fase C sobre un clon de la tienda;
- aceptación de A7.

## 6. Checkout: API, adaptadores y contrato

### 6.1 Estado de Checkout (`d11e3c7`)

**API de comandos.** Seis rutas (`checkoutApi.ts`):

- sólo en el perfil `sandbox-purchase`;
- en loopback `:4031`;
- autenticación por bearer estático (SHA-256, comparación en tiempo constante);
- `Idempotency-Key` y `X-Correlation-Id`.

**Mercado Pago:**

- API de órdenes;
- `live` prohibido en `sandbox-purchase`;
- link de 900 s, con `expiresAt = min(creación + 900 s, vigencia de la cotización)`;
- margen de proveedor de 310 s (`PT9M50S`).

**Webhook:**

- `x-signature` HMAC;
- el webhook sólo dispara una relectura al proveedor.

**Trabajos de fondo y orden:**

- outbox con lease y fencing;
- expiración (`EXPIRE_ATTEMPT`);
- reconciliación;
- U6 PrestaShop: un único `POST /api/orders`, nunca repetido, y sólo en `sandbox-purchase` aislado;
- el runtime por defecto usa `DisabledPrestaShop`.

**ADR-0002 se respeta.** Checkout no crea carritos ni recalcula precios: lee el carrito de Quote para verificar paridad y cobra el monto congelado.

### 6.2 Vigencia de 15 minutos

Checkout la garantiza internamente: deja de emitir después de `expiresAt`, cancela al vencer y oculta la URL.

**Limitación del proveedor (D-07/OD-06, abiertos):**

- Mercado Pago expiró una orden unos 183 s tarde (una sola observación).
- **Gap confirmado en código:** una captura posterior a `expiresAt` con el intento todavía abierto confirma el pago y crea la orden. `lateCapture` sólo se marca cuando el intento ya estaba resuelto.

Este gate financiero **no** se da por cerrado porque Checkout cancele internamente. R4 mitiga el lado del cliente:

- no ofrece un link a menos de 60 s de su `expiresAt`;
- `lateCapture` o una anomalía llevan a `HUMAN_INTERVENTION_REQUIRED` (§6 regla 1).

### 6.3 Compatibilidad del contrato (aceptación por R4)

| Ítem | Contrato | R4 |
|---|---|---|
| 6 rutas, sin cancel ni query strings | §1, §11.1 | **Implementado** tal cual (`CheckoutHttpClient`) |
| Envelope `{error:{code,message,retryable}}`, `GET /payment-attempts` como arreglo plano, `Idempotent-Replay` | §11.2 | Implementado |
| Claves `r4.ck.<step>.<sha256(execKey\|step)[0:40]>` | §5.1 | Implementado, determinista |
| Reglas de reintento | §5.2 | Mismo clave tras timeout (`idempotent_replay`); `IDEMPOTENCY_KEY_REUSED` → handoff; `ATTEMPT_UNRESOLVED` → leer |
| Lectura antes de link | §5.3 | Implementado |
| Mapeo de estados | §6 | Implementado como función pura, desconocido → `HUMAN_INTERVENTION_REQUIRED`. La regla 6 se nombra `LINK_EXPIRED_PROVISIONAL` para distinguirla de la 8 |
| Errores | §7 | Implementado (`checkoutErrorAction`); código desconocido → handoff |
| Link por la plataforma, controles | §8 | Implementado (R-4): https, dominio Mercado Pago, sin userinfo ni puerto, `now < expiresAt − 60 s`. La ventana de 24 h y el destinatario los aplica el dueño de entrega |
| `preview_url:false` | §8 | Ya cumplido: el adaptador WhatsApp existente envía siempre `preview_url: false` (`whatsapp-cloud/src/outbound.ts`) |
| Guardia de readiness (`profile: sandbox-purchase`) | §11.4.6 | **No implementado**; está en el gate de `@15` (`checkout-runtime`) |
| C-1 servidor de comandos | Checkout | Hecho (sandbox) |
| C-2 token de servicio CIA | Checkout | Abierto (bearer estático sandbox) |
| C-3 consentimiento y comprador reales | Checkout/CIA | **Abierto, bloqueante** |
| C-4 motivo de resolución | Checkout | Abierto. R4 tolera el campo aditivo |
| C-5 margen ≥ 310 s | Checkout | Hecho |
| R-1 adaptador | R4 | Hecho (`@r4-adapters/checkout-http`, `R4_CHECKOUT_MODE=sandbox` únicamente) |
| R-2 capacidades y `sales.checkout_*` | R4 | Hecho (migración Sales `0010`) |
| R-3 consentimiento | R4/CIA | **Puerto sin implementación** (decisión del owner) |
| R-4 mensaje de plataforma | R4 | Hecho: aviso de plataforma (migración Core `0014`) |
| R-5 política FINANCIAL | R4 | Política propia de `@15`. Requiere la decisión D7-6 |
| R-6 perfil y definición | R4 | Hecho: `@15` / v15. La extensión del evaluador de afirmaciones de pago queda pendiente |
| R-7 rebase | R4 | Hecho (worktree desde `main`) |

**Decisión de aceptación del contrato (propuesta, a confirmar por el owner de R4):**

- **ACEPTAR** §1–§8 y §11 como contrato del cliente R4 para el perfil `sandbox-purchase`.
- **Excepciones:**
  - R-3: R4 no firmará consentimientos;
  - la guardia de readiness queda como gate de despliegue.

## 7. Bloqueos

### 7.1 E2 (cotización real por WhatsApp)

1. Gate R1.7 `NOT_MET` (§3).
2. Falta un SHA candidato de Quote: hay que aprobar `000010` (o un candidato sin ella) y garantizar el carrito apagado.
3. Despliegue de Quote con A10 en lockstep con este R4, más el chequeo A10 posterior.
4. Principal R4: 60 minutos (aprobado sólo para sintético) o el estándar de 5 días. Lo decide el owner.
5. P-1: evidencia de paridad del owner de Catalog (#54).
6. DS-1 y fidelidad de copia de v14 evaluados con el modelo real.
7. F-E1-1: una consulta deja la conversación sin respuesta en producción. No hay vía de respuesta desplegada.
8. GAP-11 (alertas), kill switch probado con el worker del carril, L3 y autorización explícita por SHA.

### 7.2 E3 (Checkout sandbox desde WhatsApp)

Además de todo lo de E2:

1. **R-3 / C-3: no existe fuente de consentimiento de compra.**
   - El artefacto que acepta Checkout es un JWS ligado a la cotización (`semanticSnapshotHash`, documento).
   - Lo firma un emisor de prueba que sólo existe en las herramientas de operador de Checkout.
   - R4 no lo firma: sería convertirse en autoridad de consentimiento.
   - Se requiere un servicio emisor de prueba autorizado, o el grant CIA `purchase`.
2. **Misma instancia de Quote.** En SBX-2, Checkout leyó un Quote aislado (runner local por túnel). El carril de R4 emite contra el contenedor de integración. Para E3 ambos deben usar la misma instancia.
3. **Runtime.** Hace falta:
   - `sandbox-purchase` detenido hoy (se restauró S0) y debe volver a levantarse;
   - el token de servicio y los scopes de R4;
   - un grant financiero vigente (DB, CK020);
   - la credencial de prueba dentro de su autorización (la E-S1 de SBX-2 vence el 2026-11-07 a las 23:59 UTC; no reutilizar);
   - PrestaShop aislado y no expuesto.
4. Aceptación del contrato por R4 (§6.3), Quote y CIA (H3), y decisión D7-6.
5. **Migraciones:**
   - Core `0014`: aviso de plataforma; cambio transversal.
   - Sales `0010`: deben aplicarse antes de cualquier proceso con este código.
6. D-07/OD-06: captura tardía con intento abierto. Abierto en Checkout.
7. L2 completo y L3; E2E R4-CK-01..12 contra el runtime real; autorización explícita.

## 8. Cambios por archivo

**Commit 1 — `29120bb`, `@14`:**

| Archivo | Cambio |
|---|---|
| `agents/sales/candidates/sales.v14.candidate.json` | Nuevo: v12 + la línea Discover |
| `agents/sales/src/production/profile-v14.ts` | Nuevo: `@14` y su gate |
| `agents/sales/src/production/profile-v5/6/7.ts`, `capabilities/parity-guard.ts` | `@14` en los conjuntos autónomo, de intención confirmada, de oferta determinista y de paridad obligatoria |
| `agents/sales/src/production/profile-v8.ts`, `definition.ts` | Versión fijada 14; archivo candidato |
| `agents/sales/src/production/profile-v12.ts` | `assertF1Canary*` aceptan la etiqueta del perfil |
| `agents/sales/src/production/composition.ts`, `cli/production.ts` | Techos F1, paridad y techo de escrituras para el carril de cotización |
| `agents/sales/src/production/profile-v13.ts`, `bootstrap.ts`, `index.ts` | El registro de carriles se mueve al perfil más reciente |
| `tests/contract/sales-profile-v14.test.ts` | Nuevo |

**Commit 2 — Checkout:**

| Archivo | Cambio |
|---|---|
| `adapters/domains/src/checkout/port.ts` | Nuevo puerto: vistas, `CheckoutService`, `CheckoutConsentSource`, claves §5.1, mapeo §6, errores §7, control de link §8 |
| `adapters/domains/checkout/http/*` | Nuevo `@r4-adapters/checkout-http`: configuración y cliente de las seis rutas |
| `packages/persistence-postgres/migrations/0014_platform_notice_outbound.sql` | `notice_key` y una restricción: una fila `platform` es fallback **o** aviso |
| `packages/live-ops/src/ports.ts`, `delivery.ts`, `context-source.ts` | `createPlatformNotice`. Gate de entrega del aviso: el de agente, sin supersesión por entradas nuevas. El contexto muestra el aviso por clave, nunca su cuerpo |
| `packages/persistence-postgres/src/production-store.ts` | `createPlatformNotice` (idempotente por `(task, notice_key)`); el claim distingue aviso de fallback; el hilo muestra `platform.notice` sin cuerpo |
| `agents/sales/migrations/0010_sales_checkout_requests.sql` | Nuevo: solicitudes congeladas, sesiones e intentos (inmutables) |
| `agents/sales/src/workspace/store.ts` | Métodos de Checkout |
| `agents/sales/src/capabilities/checkout.ts` | Nuevo: tres capacidades, gramática de pedido de pago `r4-sales-purchase-es-v1`, texto del aviso |
| `agents/sales/src/production/profile-v15.ts` | Nuevo: `@15`, su política y su gate. Ahora contiene el registro de carriles |
| `agents/sales/candidates/sales.v15.candidate.json` | Nuevo: v14 + 4 líneas + scopes `checkout.purchase` y `checkout.read` |
| `agents/sales/src/production/composition.ts`, `profile-v8.ts`, `cli/production.ts`, `ids.ts`, `profile.ts` | Composición de `@15` (Checkout tras el kill switch), política, binding desde `R4_CHECKOUT_*` y sin fuente de consentimiento |
| Configuración del workspace (`package.json`, `tsconfig*`, `vitest.config.ts`, `agents/sales/*`) | Registro del paquete nuevo |
| Pruebas | Nuevas: `tests/unit/checkout/*`, `tests/integration/sales-checkout.test.ts`, `tests/integration/platform-notice.test.ts`, `tests/contract/sales-profile-v15.test.ts`. Ajustadas: listas de migraciones, el carril y los límites de dependencias |

## 9. Herramientas, idempotencia y reglas de respuesta

**`checkout.start_purchase@1`** (FINANCIAL, `idempotent_replay`). Antes de enviar nada exige cuatro condiciones:

- la cotización fue emitida **en esta conversación**;
- Quote la informa `issued` y vigente;
- el último mensaje del cliente posterior a la emisión es un pedido explícito de pago (gramática cerrada);
- hay un artefacto de consentimiento.

Luego:

- congela el cuerpo;
- llama a `POST sessions` con la clave `session`;
- llama a `prepare` con la clave `prepare` si el estado es `CREATED`;
- lee la sesión hasta que salga de `CREATED`/`PREPARING`.

**`checkout.request_payment_link@1`** (FINANCIAL). Lee primero:

- **Intento abierto:** si el último intento es `CREATED`, `PROCESSING` o `LINK_AVAILABLE` sin vencer, se informa o se reenvía su aviso. Nunca se publica otro.
- **Intento nuevo** (clave `link`), sólo si:
  - la sesión está `READY` y no hay intento; o
  - el último intento terminó `FAILED`/`CANCELED`/`EXPIRED` **y** el cliente volvió a pedirlo después.
- **Sin intento:** con `HUMAN_INTERVENTION_REQUIRED`, pago acreditado o `NOT_PURCHASABLE` nunca se crea un intento.

**`checkout.purchase_status@1`** (READ). Es la única base para decir «pagado», y sólo con `paymentAccredited=true`. La referencia de la orden sólo se da con `ORDER_COMPLETED`, y nunca se muestra `psOrderId`.

**Idempotencia:**

- Una ejecución de R4 corresponde a una operación de Checkout por paso.
- **Timeout:** se devuelve `unknown` y la plataforma reintenta **la misma** clave de ejecución. Checkout devuelve la respuesta original (`replayed`).
- **Reconciliación:** sin un comando congelado responde `not_applied`, y nunca envía nada.

**WhatsApp:**

- El link lo entrega el aviso de plataforma `checkout.link:<attemptId>`, uno por intento, por el único dueño de entrega existente.
- Pasa por los mismos gates que la salida del agente: kill switch, deny, rollout y allowlist; propiedad humana, ventana y antigüedad.
- El texto se arma con la URL, el monto y el vencimiento que devuelve Checkout, con la etiqueta «ambiente de prueba».
- El modelo ve sólo `linkNotice` (`queued`, `already_queued`, `not_available`); nunca la URL.
- La definición v15 le prohíbe escribir links, montos o vencimientos, o afirmar un pago fuera de `purchase_status`.
- **Una identidad no autorizada no llega a Checkout:**
  - el carril sólo enruta claves allowlisted (ADR-045, ya probado);
  - el kill switch bloquea los comandos antes de llamar;
  - una cotización ajena o la falta de pedido explícito se rechazan sin envío.

## 10. Pruebas (R4_TEST_STRATEGY_02)

| Nivel | Resultado |
|---|---|
| Build, typecheck, lint | 0 errores |
| L1 unit | 1697 ✓ (incluye 52 nuevas de Checkout y 3 de gate de avisos) |
| L1 contract | 509 ✓ (incluye `sales-profile-v14` y `-v15`) |
| L2 integration | Ver §10.1 |
| L2 mutaciones | Ver §10.1 |
| L3 | **NOT_RUN** (es de despliegue) |
| E2E contra el runtime real de Checkout | **NOT_RUN** (§7.2). Los resultados del stub **no** son evidencia de proveedor real |

**Escenarios del mandato** (`tests/integration/sales-checkout.test.ts`: Postgres real, kill switch durable real, stub determinista de Checkout):

| # | Escenario | Resultado (stub) |
|---|---|---|
| 1 | La aceptación crea una sesión | ✓; también los rechazos sin envío: cotización ajena, sin pedido explícito, pedido anterior a la emisión, cotización vencida o cancelada, sin consentimiento |
| 2 | Aceptación repetida sin duplicados | ✓ (1 sesión, 1 intento, 1 aviso) |
| 3 | Un timeout conserva la identidad | ✓ (misma clave de Checkout, `replayed`; 1 sesión y 1 intento). Se detectó y corrigió una falla: el reintento tras un intento perdido no esperaba el link |
| 4 | Pedir el link de nuevo reutiliza el intento | ✓ (sin POST; el aviso lleva URL, monto y vencimiento; la salida del modelo no) |
| 5 | Un link vencido no se presenta como pagable | ✓ (margen de 60 s; `LINK_EXPIRED_PROVISIONAL`; tras `EXPIRED` sólo con un nuevo pedido, ordinal 2) |
| 6 | «Ya pagué» no cambia el estado | ✓ |
| 7 | Acreditación verificada | ✓ |
| 8 | Orden confirmada sólo con `COMPLETED` | ✓ (referencia sí, `psOrderId` no) |
| 9 | `ACTION_REQUIRED` no genera otro pago | ✓ (también con captura tardía o anomalía) |
| 10 | Una iniciación no autorizada no llega a Checkout | ✓ (kill switch; sin compra en curso). El enrutamiento por allowlist es ADR-045 (`conversation-lane`) |

**Otras pruebas:**

- `platform-notice.test.ts`: entrega única por el camino real; replay; texto distinto rechazado; hilo sin cuerpo; retención por el kill switch; restricción de esquema.
- `checkout-http.test.ts`: rutas, cabeceras, cuerpo, 15 clasificaciones de error, timeout; la telemetría no lleva secretos.
- `checkout-port.test.ts`: las 12 reglas de §6 y los estados desconocidos.

### 10.1 L2

Ver el comentario de la revisión (se completa al terminar las corridas).
