---
title: R4-J5 — Preparación de F1 (Quote V2) y F2 (Catalog vigente)
status: PREPARACIÓN — no autoriza la ejecución de F1 ni de F2
mandate: «R4 — J5 D-7 Owner Decision» (owner, 2026-11-05), §4
date: 2026-11-05
base: main d895413
depends-on: R4_J5_COMMERCIAL_INTEGRATION_READINESS.md §3, §4 y §7; R4_J5_F0_PLAN.md; R4_J5_F0_OWNER_DECISION_RECORD.md; R4_J5_D7_COMMERCIAL_AUTONOMY_DECISION.md; R4_TEST_STRATEGY_02.md
---

# R4-J5 — Preparación de F1 y F2

## 0. Alcance

Este documento prepara la ejecución en paralelo de F1 (cotización productiva) y F2 (catálogo veraz). Cubre:

- las decisiones pendientes de Quote;
- las dependencias de Catalog;
- los límites de autonomía que necesitan valores aprobados;
- los requisitos de DS-1;
- los contratos y gates de la primera cotización controlada.

**No activa nada.** Siguen vigentes estas condiciones:

- G0 sigue `NOT_APPROVED`.
- Producción sigue en `sales-production@3` con `maxWriteActions=0`.
- Quote y Checkout siguen inactivos.
- No hay cambios de kernel ni despliegues.
- No hay llamadas a modelos de pago.

Ejecutar F1 o F2 requiere un mandato y una autorización de despliegue por SHA.

## 1. Estado de referencia (verificado el 2026-11-05)

| Elemento | Estado |
|---|---|
| R4 `main` | `d895413` (decisión D-7 integrada) |
| R4 PR #32 (aritmética A10) | **Abierto**, head `89942da`, sin fusionar |
| Quote PR #26 (A10) | **Fusionado** en Quote (`ca66a2e`). Fusionado no es desplegado |
| Quote `main` | `a79d33f`. Incluye A10, la migración de preparación de carrito y su código, desactivado por defecto |
| Catalog `main` | `d9c63cc` |
| Contrato de Catalog fijado en R4 | `catalog-commercial-v2`, `schemaVersion 1`, commit del owner `fea0dc5`, 24 fixtures (`adapters/domains/catalog/http/fixtures/SOURCE.json`) |
| Perfil productivo | `@3`: no registra Quote y lee Catalog V1 |

**Correcciones a documentos anteriores.** Estos hechos cambiaron después de la auditoría de preparación comercial:

- **El lockstep A10 ya sólo aplica al despliegue.** Quote #26 está fusionado y R4 #32 sigue abierto. Ninguno de
  los dos se despliega antes que el otro. Lo afirmado en el plan F0 §7.1 («ambos abiertos») quedó superado.
- **Catalog V2 está desplegado, pero contra la base de desarrollo de la tienda, no contra la productiva.** No tiene
  consumidores ni paridad productiva verificada. La lectura «`CATALOG_V2=NOT_DEPLOYED`» del informe de preparación
  quedó superada, pero la conclusión no cambia: V2 no está listo para R4.
- **E-10 (versión de PrestaShop):** la base viva de la tienda corresponde a 8.2.3. La 1.7.8.3 corresponde a la
  copia desactualizada. La versión de la aplicación sigue sin confirmar.

## 2. F1 — decisiones pendientes de Quote

| ID | Decisión | Dueño | Estado | Bloquea |
|---|---|---|---|---|
| **Q-1** | **SHA de Quote para F1.** `main` incluye, además de A10, la migración y el código del carrito, desactivado por defecto. Hay que elegir entre desplegar `main` con el carrito apagado y preparar su migración, o fijar un SHA anterior al carrito | Owner Quote | Abierta | Despliegue de F1 |
| **Q-2** | **Lockstep A10:** fusionar R4 #32 y desplegarlo junto con Quote. La verificación posterior ya está definida: una cotización multilínea con totales esperados conocidos (handoff A10 §4.3) | Owner R4 + owner Quote | R4 #32 abierto | G1 |
| **Q-3** | **Vigencia de la cotización (D-05 / B13).** La política de 60 minutos está aprobada como política, pero su principal está autorizado sólo para sintético o staging. Usarla con ofertas reales exige seis condiciones (V1–V6: clasificación en Catalog, vigencia de Shipping, política de compromiso de precio del e-commerce, gate de elegibilidad en R4, ejecución en staging y decisión de mapeo). Ninguna está cumplida. La alternativa es la vigencia actual de 5 días | Owner comercial + owner Quote | Abierta | Principal de F1 |
| **Q-4** | **Gate R1.7 de Quote:** respaldo y restauración verificada, arranque tras reinicio del host, holgura de disco, canary sintético aprobado y 7 días estables. Hoy `QUOTE_V2_READY_FOR_REAL_CUSTOMERS=NO`, con deudas abiertas de disco, respaldo y reinicio | Owner Quote + infraestructura | No cumplido | F1 |
| **Q-5** | **Principal R4 en Quote:** scopes exactos `quotes:create`, `quotes:read` y `quotes:document:read` (ADR-034 §8). El perfil de vigencia del principal sigue sin definir (depende de Q-3) | Owner Quote | Abierta | F1 |
| **Q-6** | **Retención de cotizaciones (U1):** debe decidirse antes de que se acumulen datos productivos | Owner Quote | Abierta | F1 |
| **Q-7** | **Perfil R4 que lleva F1 (D-10).** `@7` es el linaje de cotización autónoma del canary J3. `@8` agrega Customer e identidad, sólo sintéticos, y su confiabilidad conversacional (F-1, G-sem) está pendiente. v9/`@9` están retirados y v10/v11 reservados. Las instrucciones de DS-1 exigen una versión nueva del perfil (§5) | Owner R4 | Abierta | F1 |
| **Q-8** | **Conflicto en GAP-14.** Su prueba de aceptación exige un «PDF con estado `delivered`», pero la entrega de documentos está diferida (ADR-038, R4 Media) y `@7`/`@8` no entregan el PDF. Hay que redefinir la aceptación de GAP-14 sin entrega de documento, o incluir esa entrega en F1 | Owner R4 | Abierta | G1 |

Los ítems X-1..X-7 del plan F0 corresponden al carrito y a H3 (F4). No bloquean F1. X-7 parece resuelto en Quote
`main`. X-1, la audiencia `azp` del binding, sigue contradictoria entre documentos de Quote.

## 3. F2 — dependencias de Catalog

**Fuente de verdad.** El owner de Catalog decidió que la fuente comercial es la **base viva de la tienda**, y que la
copia anterior no debe usarse. Hoy:

- **V1, que lee `@3` en producción, sigue leyendo la copia desactualizada.** Volver a V1 también vuelve a la copia.
- En una muestra de páginas de la tienda, la paridad fue de 14/25 contra la copia y de 23/25 contra la base viva. Los
  2 fallos fueron packs.
- El código de V2 contra la base viva dio 105/105 en precio, 105/105 en stock y 59/59 en packs sobre su muestra.
  Se midió con un acceso de diagnóstico, no con el lector productivo definitivo.
- Siguen sin verificar los escenarios de carrito, precio fijo, monto, backorder y precio por cliente.

**Dependencias.**

| ID | Dependencia | Dueño | Estado |
|---|---|---|---|
| **C-a** | **D-01:** opción A, cutover a V2 (corrige todas las conversaciones, más lento), u opción B, un conjunto interino de SKUs con paridad verificada (rápido, deja el resto en la copia). El plan F0 §7.2 recomienda B para la primera compra con A en paralelo | Owner Catalog | Abierta |
| **C-b** | **Preparación productiva de V2:** no existe el lector productivo, el paquete productivo no está listo, `PRODUCTION_CUTOVER_GO=NO` y la calidad de Discover no está aceptada. El primer paso es del owner de Catalog | Owner Catalog | No listo |
| **C-c** | **Re-enlace de R4:** el cutover requiere una URL y una clave nuevas, porque V2 rechaza claves compartidas con V1. Cambiar el binding productivo es un despliegue y necesita autorización | Owner R4 | Pendiente de C-a |
| **C-d** | **Contrato:** R4 fija `fea0dc5` con 24 fixtures. Catalog `main` tiene 26 fixtures, el motor v2.3.0 (campos aditivos `requestedQuantity` y `stockCoverage`) y un 400 `query_too_broad`. Los esquemas de R4 toleran campos aditivos. Falta re-sincronizar los fixtures (`scripts/sync-catalog-fixtures.mjs`), correr las pruebas de contrato y verificar cómo trata R4 el nuevo 400 | R4 | Pendiente |
| **C-e** | **Frescura:** `validUntil` mide la antigüedad de la caché, no la de la fuente. `provenance.sourceUpdatedAt` siempre es `null`, así que una respuesta leída de una fuente desactualizada parece fresca. **G2 no puede apoyarse en la frescura declarada.** Necesita una verificación de paridad explícita | Owner Catalog | Requisito |
| **C-f** | **Paridad contra la tienda viva:** R4 no tiene herramienta propia de paridad, y `catalog-http-real` usa una base sintética local. La verificación de G2 depende de la herramienta de Catalog o de una nueva | Owner Catalog + R4 | Falta definir |
| **C-g** | **Datos de clientes en las vistas de V2 (D-MB-1):** su revisión es obligatoria antes de cualquier consumidor comercial | Owner Catalog | Abierta |
| **C-h** | **Secuencia J4.5 frente a J5:** la opción A de D-01 trae trabajo de J4.5 (gaps G-1..G-4 del consumidor Discover) a F2. La opción B no | Owner R4 | Abierta (roadmap §1.1) |

**Qué usa R4 de Catalog.**

- Las capacidades exponen al modelo precio, vendibilidad y frescura, pero no la cantidad en stock
  (`agents/sales/src/capabilities/catalog.ts`).
- La cotización usa el precio final de Catalog y bloquea con:
  - `item_not_sellable`;
  - `insufficient_stock`;
  - `catalog_evidence_stale`;
  - `item_price_unavailable`;
  - `item_price_tier_mismatch`.

  Fuente: `commercial-snapshot.ts:121-173`.
- Shipping toma el peso y el valor declarado de Catalog.

## 4. Relación entre F1 y F2

- **Formalmente, G1 no exige G2.** El informe de preparación las declara paralelas.
- **Pero Quote V2 congela lo que R4 le envía (Modelo B).** Quote no consulta Catalog. Una cotización emitida antes
  de F2 congelaría en una cotización inmutable el precio y el stock leídos de la copia desactualizada.
- **Propuesta P-1:** la primera cotización controlada de F1 se limita a SKUs con paridad verificada contra la tienda
  viva. Puede ser el conjunto interino de la opción B. Con eso, la convergencia mínima de los dos frentes es
  «G2 sobre los SKUs del escenario», no el cutover completo.

## 5. Límites de autonomía que requieren valores aprobados

Ningún valor productivo está propuesto en ningún documento (GAP-12, P0). Los valores del canary J3 no son
productivos. Este documento **no propone valores**: los fija el owner con la autorización de F1 (D7-5).

| Variable | Qué gobierna | Estado |
|---|---|---|
| `R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP` | Total bruto máximo, con despacho | Sin valor productivo |
| `R4_AUTONOMOUS_QUOTE_MAX_LINES` | Líneas por cotización | Sin valor productivo |
| `R4_AUTONOMOUS_QUOTE_MAX_UNITS_PER_LINE` | Unidades por línea | Sin valor productivo |
| `R4_AUTONOMOUS_QUOTE_MAX_TOTAL_UNITS` | Unidades totales | Sin valor productivo |
| `R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION` | Cotizaciones por conversación | Sin valor productivo |
| `R4_AUTONOMOUS_QUOTE_MAX_PER_HOUR` | Cotizaciones por hora, en la base del despliegue | Sin valor productivo |
| `R4_AUTONOMOUS_QUOTE_CONFIRMATION_WINDOW_SECONDS` | Tiempo entre la oferta y la confirmación | Sin valor productivo |
| `R4_EXEC_MAX_WRITE_ACTIONS` | Techo de escrituras por task (D7-5) | 0 en producción. Se dimensiona contra las cotizaciones por conversación. F1 no es compatible con 0 |
| `R4_EXEC_MAX_RUN_DURATION_MS` | Duración del run. ADR-037 L4 propone al menos 10 min | Propuesto |
| `R4_QUOTE_TIMEOUT_MS` | Timeout hacia Quote. Se recomienda 20 000 (`profile-v4.ts:55`) | Recomendado |
| Vigencia de la cotización | 60 min o 5 días (Q-3) | Abierta |

Los siete límites autónomos no tienen valor por defecto, y la composición no arranca si falta alguno
(`autonomy-limits.ts:22-57`; `composition.ts:166-171`).

## 6. Requisitos de DS-1 antes de la primera cotización

D7-3 exige que DS-1 se implemente y se valide, con mandato propio, **antes de habilitar escrituras**. Para F1, esto
significa:

| Capa | Requisito para F1 |
|---|---|
| **Prevención** | Instrucciones en la **versión nueva del perfil** que lleve F1 (Q-7), sin modificar un perfil publicado. El agente no ofrece ni afirma registrar, reservar, modificar o programar sin una capacidad autorizada que lo ejecute. Tampoco ofrece modalidades de entrega no confirmadas por ninguna capacidad (DS-2) |
| **Evaluación offline** | Detector de Sales ampliado a registrar, reservar, modificar y programar, junto al de cotizaciones ya existente. Mide la tasa de afirmaciones sin recibo en la campaña y en la observación. **No impide promesas en producción por sí solo** |
| **Confirmación del efecto** | Una cotización existe sólo con el recibo de `quote.create` y su número emitido por Quote. El texto al cliente sobre la cotización se apoya en ese recibo |
| **Validación** | Pruebas y mutaciones según `R4_TEST_STRATEGY_02`, y una campaña acotada con el modelo real. Esa campaña **requiere su propia autorización de gasto**, porque hoy no se autorizan llamadas a modelos de pago |

## 7. Contratos y gates de la primera cotización controlada (G1)

| Elemento | Estado |
|---|---|
| Contrato Quote 2.0.0 + A10 | Congelado; fusionado en Quote; no desplegado |
| A10 en R4 (#32) | Abierto |
| Verificación posterior al despliegue A10 | Definida, no ejecutada |
| Gate R1.7 de Quote (Q-4) | No cumplido |
| Vigencia y principal productivo (Q-3, Q-5) | Faltan |
| Perfil F1 (Q-7) | Falta decidir |
| ADR-034 / ADR-035 | Aceptadas sólo para canary. Su uso en F1 requiere aceptación productiva |
| ADR-043 y D-7 (D7-4) | Registradas y aprobadas |
| ADR-036 (procedencia de entrada) | Propuesta. Alternativa: el owner acepta la topología de un solo productor de entrada, verificada en el host |
| ADR-037 (semántica de escrituras comerciales) | Propuesta; decisiones 1–4 del owner pendientes |
| GAP-11 (observabilidad de decisiones autónomas) | Abierto: sin alertas para `unknown`, `needs_reconciliation` ni handoffs |
| GAP-12 (límites) | Abierto, P0 (§5) |
| GAP-13 (gates del perfil exigidos en código) | Abierto |
| GAP-14 (WhatsApp real) | Abierto, P0, con el conflicto de Q-8 |
| GAP-16 (emisión varada) | Corregido en `quote.create@5`; quedan pendientes L1–L6 de ADR-037 |
| Kill switch | Existe y arranca deshabilitado. D7-4 exige probarlo antes de F1. El kill switch por canal no detiene las escrituras de `@7` (GAP-07) |
| DS-1 (§6) | Requiere mandato propio |
| G2 sobre los SKUs del escenario (P-1) | Propuesto |
| Pruebas | L2 como piso; L3 sobre el SHA desplegado con el servicio real, coordinado entre repositorios; canary con allowlist. Un `NOT_RUN` bloquea. El gate financiero F-1..F-7 no aplica a F1 (cubre pago y orden) |

## 8. Plan paralelo

Cada paso requiere su autorización. El orden dentro de cada frente es el de dependencia. No hay fechas.

**Frente F1 (Quote + R4)**
1. Decisiones Q-1, Q-3, Q-5, Q-6, Q-7 y Q-8.
2. Cierre de R1.7 en Quote (Q-4).
3. Mandato DS-1: perfil nuevo, detector y pruebas (§6).
4. Valores de los límites y del techo (§5), aprobados por el owner.
5. Revisión y fusión de R4 #32, sin despliegue.
6. Cierre de GAP-11, GAP-13 y ADR-036, o aceptación de su alternativa. Prueba del kill switch.
7. L2 y L3 sobre los SHA candidatos. Campaña con modelo real, autorizada aparte.
8. Despliegue coordinado A10 por SHA y canary con allowlist (G1).

**Frente F2 (Catalog)**
1. Decisión D-01 (C-a) y secuencia J4.5 (C-h).
2. Opción B: elegir los SKUs del escenario y verificar su paridad contra la tienda viva (C-f). Opción A: preparación
   productiva de V2 (C-b) y revisión D-MB-1 (C-g).
3. Re-sincronización de los fixtures y pruebas de contrato en R4 (C-d).
4. Re-enlace de R4 si se elige A (C-c). Es un despliegue y requiere autorización.
5. G2.

**Convergencia:** la primera cotización controlada usa SKUs que pasaron G2 (P-1).

## 9. Decisiones solicitadas al owner

1. **Alcance de G0 para F1/F2.** G0 exige aceptar A7, H3 y Checkout `/v1`, que corresponden al carrito y al pago
   (F4–F6). **Propuesta P-2:** permitir que F1 y F2 avancen con las decisiones y los responsables que les
   corresponden (D-01, D-05, D-10 y los owners de Quote y Catalog), y que A7, H3 y `/v1` sigan su curso hacia G0
   antes de F4.
2. Las decisiones Q-1..Q-8 (§2) y C-a, C-h (§3), cada una con su dueño.
3. **P-1:** la primera cotización controlada se limita a SKUs con paridad verificada.
4. El mandato de DS-1 (§6) y, aparte, la autorización de gasto de su campaña con el modelo real.
5. Los valores de los límites y del techo (§5), junto con la autorización de F1.

## 10. Qué no hace este documento

- No activa F1 ni F2 ni despliega nada.
- No fusiona R4 #32.
- No cambia `@3`, `maxWriteActions` ni ninguna política.
- No modifica el kernel ni activa Quote o Checkout.
- No propone valores de límites.
