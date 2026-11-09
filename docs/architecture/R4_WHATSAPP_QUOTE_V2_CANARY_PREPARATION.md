---
title: R4 — preparación del canary de Quote V2 desde WhatsApp (sales-production@14)
status: R4_WHATSAPP_QUOTE_V2_CANARY_PREPARED_ACTIVATION_BLOCKED
mandate: «R4 — WhatsApp Quote V2 Canary Preparation» (owner, 2026-11-09)
date: 2026-11-09
r4: PR #55 (feat/r4-quote-checkout-e2e), merge con main en a0e1a6e; sin merge a main, sin despliegue
quote: candidato a79d33f (sin desplegar)
---

# R4 — Preparación del canary de Quote V2 desde WhatsApp

## 0. Resultado

**Estado: `R4_WHATSAPP_QUOTE_V2_CANARY_PREPARED_ACTIVATION_BLOCKED`.**

`R4_WHATSAPP_QUOTE_V2_CANARY_READY_FOR_REVIEW` no se alcanza. El perfil está preparado y validado de forma aislada; la activación sigue bloqueada por gates que R4 no puede cerrar (R1.7 de Quote, P-1) y por un hallazgo conversacional (F-WA-1).

| # | Entregable | Estado |
|---|---|---|
| 1 | Revisión del PR #55 | Revisión independiente: `PR55_CHANGES_REQUIRED`. Las correcciones D-1, D-2 y D-3 están hechas, el branch está mergeado con `main` (D-4) y la L2 se re-ejecutó sobre el merge (§2) |
| 2 | Estado exacto de R1.7 | **`NOT_MET`** (§3) |
| 3 | Release candidate R4/Quote | §6, **no activable** todavía |
| 4 | Validación autónoma con Task Runtime | **10/10 escenarios ejecutados** con el Task Runtime, el Policy Engine y el ActionExecutor reales, el modelo real y Catalog V2/Discover reales (§5). 9 PASS; el 5 tiene un defecto conversacional (F-WA-1) que el gate determinista contuvo |
| 5 | Bloqueos de activación | §7 |
| 6 | Rollback | §8 |

## 1. Reconocimiento de E3-A (2026-11-09)

Queda validado, contra Mercado Pago sandbox real:

- la integración real R4 → Quote V2;
- la preparación del carrito en la PrestaShop aislada;
- el consentimiento sandbox;
- Checkout sandbox, el pago de prueba y la conciliación;
- **exactamente una orden**;
- la recuperación de R4 en los dos puntos probados: después de `createSession` y después de `createPaymentAttempt`.

**No se extiende** a WhatsApp, al Task Runtime, al Policy Engine ni al ActionExecutor, porque E3-A los evitó con un driver. Esos componentes sólo quedan cubiertos por la validación de §5, que es una prueba de cotización, no de pago. E3-A no se repite: nada posterior invalida su evidencia, porque las correcciones D-1 y D-2 endurecen el mismo camino sin cambiar su resultado.

## 2. PR #55

**Revisión independiente** (un revisor sin contexto de la implementación, sobre `326560b`): `PR55_CHANGES_REQUIRED`.

| # | Punto | Resultado |
|---|---|---|
| 1 | F-E3A-1 / F-E3A-2 | Incompletos (D-1, D-2), **corregidos** en `7557401` |
| 2 | 91 pruebas focalizadas | PASS (re-ejecutadas por el revisor) |
| 3 | Mutaciones 15/15 | PASS (re-ejecutadas por el revisor) |
| 4 | Migración Core `0014` | PASS: aditiva; la restricción se reduce exactamente a la anterior para las filas existentes; rollback de código seguro con la base en `0014`; identidad de compatibilidad `0014` (todos los procesos juntos) |
| 5 | Aislamiento de `@13` | PASS |
| 6 | Definiciones `@14`/`@15` | PASS |
| 7 | Sin activación comercial automática | PASS |

**Correcciones (`7557401`):**

- **D-1 (media).** El límite D7-6 ahora cuenta, en los dos caminos (`start_purchase` y `request_payment_link`), los intentos que Checkout lista para cada sesión de la task. Antes, una segunda cotización después de un intento no registrado podía abrir una segunda sesión. Se agregó la prueba «F-E3A-1 start path», y CK-M15 ahora cubre los dos caminos.
- **D-2 (baja).** Las descripciones de `purchase_status` y `request_payment_link` y la definición v15 ya no ofrecen un link nuevo al modelo.
- **D-3 (información).** Se quitó una palabra de dominio de un comentario de Core.

**D-4.** `main` avanzó a `ae0bedf` (#53, indicador de escritura). Se mergeó en el branch (`a0e1a6e`, sin conflictos) y se re-ejecutaron, sobre el SHA del merge, la regresión L2 completa y las 9 suites de mutación que selecciona el diff (§2.1).

**Además en este PR** (`41c5004`): el canary aislado (`sales:canary`) acepta `@14`, sólo con Catalog V2 y con el binding de Discover. La API de composición productiva no cambia: `@14` sigue siendo sólo perfil de carril.

**Pendiente menor:** I-2. Un worker `@15` no verifica al arrancar que la migración Sales `0010` esté aplicada; falla cerrado en tiempo de ejecución.

### 2.1 L2 sobre `a0e1a6e`

Sobre el merge `a0e1a6e`, con la corrección de frontera posterior en `d84bfac`:

| Nivel | Resultado |
|---|---|
| Lint (excluido `.e2e-local/`, no versionado) y `tsc` | 0 errores |
| Unitarias | 1715 ✓ (4 omitidas, preexistentes) |
| Contrato | **Primera corrida: 3 fallas.** Dos eran guardias de frontera (el runtime del canary y el de Sales no deben nombrar un canal): un comentario de `canary/runtime.ts` lo hacía. La tercera, un pin de la lista del canary. Corregidas en `d84bfac`: **509 ✓** |
| Integración | 743 ✓ (12 omitidas, preexistentes) |
| Recuperación | 19 ✓ |
| Sales | 29 ✓ |
| Shadow | 5 ✓ |
| Mutaciones (las 9 suites que selecciona el diff contra `main`, §7) | `canary-j4` 13/13, `checkout` 15/15, `identity-verification-ingress` 13/13, `prior-conversation` 11/11, `profile-v8` 8/8, `run-failure-fallback` 8/8 y `runtime-contingency` 11/11 sobre `a0e1a6e`; `production` 23/23 y `production-control` 13/13 sobre `d84bfac`, porque en la primera corrida su baseline estaba rojo por los contratos. **115/115** |
| Interop | NOT_RUN (sin cambios en CIA ni en CP) |
| L3 | NOT_RUN: pendiente para el SHA del release |

`d84bfac` sólo cambia un comentario y dos pines de pruebas. No invalida las 7 suites corridas sobre `a0e1a6e`.

## 3. Estado exacto de R1.7 (Quote V2)

Auditoría documental del repositorio de Quote. La definición vinculante es `docs/reviews/R1.7_PRODUCTION_READINESS_PRE_FLIGHT.md`, cuyo veredicto es `R1.7_READY_TO_START=NO`; ningún documento posterior cierra R1.7.

| Criterio | Estado | Falta |
|---|---|---|
| A. Contenido e identidad | MET | — |
| B-S1. Redacción de errores y TLS de base | MET (local) | — |
| B-S2. Inventario de producción | **NOT_MET** | Ejecutarlo |
| B-G1/G2. Despliegue | MET sólo para integración (`6735352`) | Aceptación de producción |
| B. Respaldo y restore verificado | **NOT_MET** | Respaldo pareado (PostgreSQL + documentos) y simulacro de restore |
| B. Reinicio del host | **NOT_MET** | Procedimiento probado de arranque |
| B. Holgura de disco | **NOT_MET** | Unos 1,06 GB libres frente a un pico de carga medido de 1,21 GB |
| B. Principales de producción | Parcial | Decisión de principal y perfil |
| C. Ensayo de migración con datos reales | **NO_EVIDENCE** | Ensayo o waiver formal |
| D. Canary por etapas 0–4 sobre el candidato | **NO_EVIDENCE** para `a79d33f` | Etapas sobre el SHA candidato |
| E. Siete días estables y cutover de V1 | **NO_EVIDENCE** | Todo |
| F. Aceptación del owner y paquete §Z | **NO_EVIDENCE** | Firma |

**Confirmaciones:**

- **SHA candidato:** `a79d33f` (`origin/main`), 36 commits adelante del desplegado en integración (`6735352`).
- **Migración `000010`:** crea sólo las tablas de carrito y es reversible. El candidato **no sirve ninguna request sin ella**, aun con el carrito apagado (`schema_not_ready`). Alternativa: un SHA en `000009` que ya trae A10 (`ca66a2e` o `d419640`), no probado como candidato.
- **A10:** R4 ya lo implementa (`main`). El despliegue va en lockstep con Quote, con el chequeo posterior al despliegue de la propia enmienda.
- **Principal:** `r4-sales-integration` (estándar → `cl-retail-5-calendar-days-v1`). El de 60 minutos **no** está autorizado para producción.
- **Vigencia:** la fija el perfil del principal, se resuelve una vez y queda congelada.
- **P-1:** pendiente del owner de Catalog (#54). No hay archivo de evidencia por SKU.
- **Idempotencia:** clave por principal y operación; un replay devuelve el estado actual; otro cuerpo da 409; existe el endpoint de lookup.
- **Emisión sin carrito:** son los valores por defecto (`QUOTE_CART_PREPARATION_ENABLED=false`, H3 `closed`). Nunca se ejecutó desplegado.
- **Recuperación:** lecturas de cotización, operación y documento; los leases `issuing` se reclaman. En la EC2 no hay prueba de reinicio con una cotización en curso.

## 4. Perfil `@14`

`sales-production@14` (definición v14 = v12 + la línea Discover de v13) compone, sin herramientas nuevas:

- Catalog V2 y Discover (fuente decidida por el perfil);
- Shipping (pc-carrier);
- Quote V2 con `quote.preview@3` y `quote.create@5`: oferta determinista de Sales y confirmación registrada por la plataforma;
- los techos F1 (≤ 250.000 CLP, 3 líneas, 5 unidades, 1 cotización por conversación, 2 por hora) y el techo de escrituras 1..6;
- la guarda de paridad P-1;
- el kill switch;
- la continuidad entre tasks (`PriorConversationContextSource`).

Sin Checkout y sin identidad. Es perfil de carril: allowlist del carril ADR-045 y su propio worker. **`@13` no cambia.**

## 5. Validación conversacional aislada

### 5.1 Entorno

| Componente | Instancia |
|---|---|
| R4 | `sales:canary` (`a0e1a6e` + `41c5004`): el worker de producción real (`composeSalesProductionWorker(@14)`), con Task Runtime, Policy Engine (política autónoma) y ActionExecutor reales, recuperación ADR-028, scheduler, dueño de entrega real con un adaptador de captura local, y admisión que re-prueba el aislamiento antes de cada claim. Base PostgreSQL **dedicada** y marcada; allowlist sólo de conversaciones sintéticas; entrada por el `ChannelIngress.ingest` real |
| Modelo | DeepSeek, el mismo modelo y formato que producción |
| Catalog V2 y Discover | **Reales**, la generación productiva que sirve el carril `@13`. Sólo lectura, por túnel SSH, con las claves del carril autorizadas por el owner para esta tarea (nunca impresas; borradas al terminar) |
| Shipping | pc-carrier real (endpoints públicos, sin credenciales) |
| Quote V2 | Candidato `a79d33f` local, **carrito apagado**, principal con los scopes de `r4-sales-integration` (vigencia de 5 días) |
| P-1 | **Evidencia de paridad SÓLO DE PRUEBA**, autorizada por el owner: para cada ítem cotizado, el precio de Catalog V2 se comparó con el que publica la tienda pública (3/3 coinciden). **No es P-1** |

### 5.2 Resultados

| # | Escenario | Capacidades invocadas (evidencia en la base) | Escritura y autorización | Quote | Respuesta | Resultado |
|---|---|---|---|---|---|---|
| 1 | Producto exacto | `catalog.search` → `catalog.get_product_context` | — | — | Precio exacto de Catalog V2 y especificaciones del contexto | PASS |
| 2 | Producto por necesidad | `catalog.discover` ×3, contexto ×5 | `sales.workspace.update`: `allow` (REVERSIBLE_WRITE, política autónoma) | — | 2 productos con precios verificados | PASS |
| 3 | Variantes | search → contexto | — | — | Las 5 tallas reales; el precio exacto se confirma al elegir talla | PASS |
| 4 | Cantidad disponible (3 de un ítem con stock 56) | search → contexto | `workspace.update` `allow` | — | Disponible, 3 unidades en la selección | PASS |
| 5 | Stock insuficiente (2 de un ítem con stock 1) | search → contexto → … → `quote.preview` | `workspace.update` `allow` | **`quote.preview` bloqueado**: `insufficient_stock` (disponible 1, pedido 2); sin snapshot emitible | La **primera** respuesta afirmó stock para 2; después de la vista previa el modelo corrigió (1 unidad, alternativas o una persona) | **PARCIAL** (F-WA-1) |
| 6 | Despacho | search → `shipping.quote` | — | — | Opciones reales a Providencia con precio | PASS |
| 7 | Confirmación explícita | search → contexto → `workspace.update` → `quote.preview` | `workspace.update` `allow` | Snapshot de la oferta | Oferta determinista `r4-sales-offer-es-v1` (2 × 35.990 = 71.980; neto 60.487, IVA 11.493) y pedido de confirmación | PASS |
| 8 | Cotización emitida | `quote.create@5` (propuesta del modelo) | Política: `allow` (IRREVERSIBLE_WRITE). Decisión autónoma: `authorized/eligible`. Recibo del ActionExecutor: `succeeded`, 1 intento | **Persistida en Quote:** `issued`, número, mismos totales, vigencia de 5 días, documento disponible y verificado | Número, totales y vigencia | PASS |
| 9 | Repetición del mensaje («Sí, emítela» otra vez) | `respond` | **Ningún** `quote.create` nuevo | Sigue 1 cotización | «ya quedó emitida» | PASS |
| 10 | Recuperación tras interrupción (proceso del worker matado con `kill -9` tras el `quote.create` aplicado y antes de la respuesta) | Al reiniciar, la recuperación retomó el turno | Un solo `quote.create` (1 ejecución, 1 recibo) | 1 cotización | La respuesta con el número llegó tras el reinicio | PASS |

**Ninguna operación se dio por exitosa sólo porque el modelo la afirmara.** Cada éxito tiene su observación, decisión de política, recibo o fila de Quote en la base del canary.

### 5.3 Hallazgo F-WA-1 (media; bloquea la activación)

En el escenario 5, el modelo afirmó al comprador que había stock para la cantidad pedida, apoyándose en la vendibilidad agregada del producto, sin verificar la cantidad a nivel de ítem. El gate determinista (`quote.preview`) lo contuvo: no se podía emitir y el modelo se corrigió. Pero la primera afirmación fue incorrecta.

**Corrección propuesta** (definición, sin herramientas nuevas): instruir que la disponibilidad para una cantidad concreta se afirme sólo con el contexto de ítem para esa cantidad, o con `quote.preview`. Exige una nueva definición candidata y su evaluación con el modelo real (como DS-1); **no se hizo** sin decisión.

### 5.4 Otras observaciones

- La primera ejecución del canary encontró dos problemas de configuración del operador (formato JSON del modelo y la política de reconciliación del scheduler). Se corrigieron en el entorno; no son defectos de R4.
- Los 4 puntos de cada escenario (capacidades, evidencia de Catalog, autorización de escritura y Quote) se leyeron de la base. Las respuestas, del archivo de captura.

## 6. Release candidate coordinado (propuesto, no activable)

| Componente | SHA | Condición |
|---|---|---|
| R4 | El merge del PR #55 a `main` (hoy `a0e1a6e` en el branch) | Merge con revisión; migraciones Core `0014` y Sales `0010`; **todos** los procesos en el mismo SHA |
| Quote V2 | `a79d33f` (con `000010`) o un SHA en `000009` con A10 | R1.7 y la decisión del owner de Quote; carrito apagado |
| Catalog V2 | La generación productiva actual | P-1 |

**Orden de despliegue:**

1. Quote (A10), más su chequeo posterior.
2. R4 `production:migrate`, después `production:sales:bootstrap`.
3. Todos los procesos.
4. Registro de v14 con `--lane`.
5. Variables del carril para `@14`.
6. Kill switch probado con el worker del carril.
7. Activación del carril para la allowlist actual, por SHA, con autorización explícita.

## 7. Bloqueos de activación de `@14`

1. **R1.7 de Quote:** B-S2, el restore, el reinicio, el disco, y C a F. Owner de Quote/ops.
2. **SHA de Quote y `000010`:** plan de aplicación y rollback, o un SHA en `000009` probado.
3. **P-1:** evidencia por SKU del owner de Catalog.
4. **Principal R4:** decisión 5 días (`r4-sales-integration`) o 60 minutos (no autorizado), y el token en la configuración del carril.
5. **F-WA-1:** corrección de la definición y evaluación con el modelo real.
6. **F-E1-1:** que una consulta deje de dejar la conversación sin respuesta. Sigue abierto.
7. **L3** sobre el SHA del release, alertas (GAP-11) y kill switch con el worker del carril.
8. **Autorización de despliegue por SHA.**

El resto de las conversaciones sigue excluido por la allowlist actual; `@13` no cambia.

## 8. Rollback

| Etapa | Rollback |
|---|---|
| Activación del carril `@14` | Volver la variable de perfil del carril a `@13` y reiniciar el worker del carril. Las tasks `@14` abiertas quedan fijadas a v14; el kill switch las detiene. La allowlist no cambia |
| Despliegue de R4 (`0014`) | Todos los procesos al SHA anterior **a la vez**: la identidad de compatibilidad cambia. La base en `0014` es segura con el código anterior (el migrador ignora ids desconocidos; los avisos se cancelan y no se envían) |
| Quote | Con `a79d33f`: volver a `6735352` exige `down` de `000010` (o se queda en `SCHEMA_AHEAD`). Con un SHA en `000009`: rollback directo. El chequeo A10 manda: si falla, se vuelve a la versión anterior |
| Kill switch | `global` deshabilitado: detiene claims, despachos y trabajo autónomo nuevo sin borrar estado |
