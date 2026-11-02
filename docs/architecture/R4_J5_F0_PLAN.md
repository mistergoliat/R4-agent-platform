---
title: R4-J5 — Plan F0 (decisiones y contratos de la integración comercial)
status: ready-for-gate-review
mandate: R4_J5_F0_AUTHORIZED
date: 2026-11-02
base: main 52a58f4
---

# R4-J5 — Plan F0

F0 es la fase documental y contractual del plan transversal F0–F8. El plan está en el
[informe de preparación comercial](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md) §7. Las decisiones que lo rigen están en
el [registro de decisiones](R4_J5_F0_OWNER_DECISION_RECORD.md).

En esta fase no hubo despliegues, cambios en EC2, cambios de kernel, pagos ni perfiles nuevos. Tampoco hubo llamadas a
modelos ni a servicios.

```text
R4_J5_F0_READY_FOR_GATE_REVIEW
G0                          NOT_APPROVED (criterios abiertos: §1)
CONTRACTS A7 / H3 / CO-v1   CANDIDATE — FOR REVIEW (no aceptados)
OWNERS                      ROLES DEFINED — PERSONS PENDING
```

## 1. Gate G0: estado de sus criterios

| Criterio | Estado | Evidencia o falta |
|---|---|---|
| C-1..C-3 decididas | **CUMPLIDO** | [Registro de decisiones](R4_J5_F0_OWNER_DECISION_RECORD.md) §1 |
| D-01..D-13 decididas | **NO CUMPLIDO** | D-07 sigue abierta por decisión del owner; el resto, abiertas (§6) |
| A7 aceptado | **NO CUMPLIDO** | Candidato revisado para F0 (§2) |
| H3 aceptado | **NO CUMPLIDO** | Candidato nuevo (§2) |
| OpenAPI Checkout `/v1` aceptado | **NO CUMPLIDO** | `1.0.4-proposed` (§2) |
| Responsables nombrados | **NO CUMPLIDO** | Roles definidos; sólo la CIA tiene un owner designado (§5) |

G0 no se marca aprobado.

## 2. Contratos para revisión

Están en los repositorios privados de cada servicio, en commits locales sin publicar. Se indican rama y commit.

| Contrato | Repositorio y ubicación | Rama / commit | Estado | Contenido principal |
|---|---|---|---|---|
| **A7**: preparación de carrito Quote/Checkout | Quote V2, `docs/cart/QUOTE_V2_CART_CONTRACT_CANDIDATE.md` §12 y `ADR-Q001` | `docs/a7-f0-review` / `36fbdfc` | CANDIDATO `a7-candidate-2.1/cart-02b-r1` (sin cambio de wire, sin cambio de id) | Incorpora C-1, C-2 y D-07/OD-06 abiertos. Tabla de vigencias: cotización, preparación, grant, binding, intento de pago ≤ 15 min, fulfilment. Perfil de la primera compra (S3, SKU simple, cliente y dirección existentes, sin descuentos). Bloqueos B1–B13 con roles |
| **H3**: autorización de compra CIA/Quote/Checkout | CIA, `contract/h3/PURCHASE_AUTHORIZATION_V1_CANDIDATE.md` | `docs/h3-purchase-authorization-candidate` / `39342b2` | CANDIDATO `h3-purchase-authorization-v1-candidate` | Ver detalle abajo |
| **Checkout `/v1`** | Checkout, `contracts/checkout/v1/openapi.json` y `docs/reviews/F0_CHECKOUT_V1_CONTRACT_REVIEW.md` | `docs/f0-checkout-v1-review` / `e6768e8` | `1.0.4-proposed`, `approved: false` | Ver detalle abajo |

**H3.** Tiene dos capas:
- **Grant CIA:** formato `cv=1`, propósito `purchase`, audiencia `quote-cart-preparer`, `azp=r4-sales`, TTL ≤ 300 s, `jti`.
- **Binding JWS de Checkout:** vincula cotización, versión, hash, tienda, sesión, consentimiento, comprador, direcciones y monto. Lleva `exp` ≤ al del grant y `jti` de uso único en Quote.

El transporte a Quote no cambia (`X-Purchase-Authorization`). El modelo nunca ve `customerRef`, las direcciones ni el
grant. Los cambios de la CIA (C-CIA-1..8) están listados y no implementados.

**Checkout `/v1`.** Los cambios son:
- C-2 explícito: `/prepare` sólo pide y verifica la preparación de Quote.
- Sin campo de descuento (C-1).
- La expiración del enlace en el proveedor se declara **no garantizada** (D-07/OD-06).
- Encabezado opcional `x-customer-access-grant` (depende de H3).
- Principal byte-idéntico a `r4-sales`.
- Errores de autorización sin motivo público.
- Catálogo de errores alineado con el código.
- Corrección del patrón de `x-signature` del webhook.
- ADR-0002 recibe una adenda O-18/C-1/C-2. El PRD v0.1 queda marcado [SUPERADO] en la preparación de carrito.

### 2.1 Contradicciones entre contratos que la revisión debe resolver

| # | Contradicción | Dueños |
|---|---|---|
| X-1 | CART-00 §4.3 y A7 §4 fijan `azp=checkout`. La CIA (REV-08) define `azp` como el consumidor que llamó a `resolve`, y ése sólo puede ser R4. H3 propone `azp=r4-sales` (OQ-H3-1) | CIA, Quote, Checkout |
| X-2 | CART-00 supone que Checkout recibe el grant de la CIA, pero ninguna ruta de la CIA se lo entrega. H3 propone el relay R4 → Checkout → Quote | CIA, Checkout |
| X-3 | «Audiencias» en plural no caben en `cv=1`: el esquema define `aud` como string único. H3 propone una audiencia por propósito | CIA |
| X-4 | El servicio de preparación de Quote en `main` expone en el 403 público el código del verificador. La CIA (REV-01) lo prohíbe para el rechazo de grants (OQ-H3-9) | Quote |
| X-5 | La verificación de fulfilment de Quote no impone la ventana de 15 min, y `revalidate(pre_payment)` no está expuesto (B10) | Quote, Checkout |
| X-6 | Las respuestas de Checkout llevan `contractVersion` `checkout.v1.0-proposed`, que no corresponde a `info.version` | Checkout |
| X-7 | El informe PAY-02B de Quote existe sólo como archivo sin versionar en una copia local | Quote |

**Preguntas abiertas.** OQ-H3-1..13 están en H3 y B1–B13 en A7 §12. Además, en la nota de revisión de Checkout:
- si el grant entra en el hash de idempotencia de la sesión;
- si `statusReason` pasa a ser un enum;
- si se retiran los 5 códigos de error que nunca se emiten.

## 3. Dependencias del owner e-commerce (PrestaShop)

Es el cuello de botella del camino crítico. Paquete para solicitar al owner e-commerce:

| Id | Necesidad | Consumidor | Fase que bloquea | Documento de entrega existente |
|---|---|---|---|---|
| E-1 | Endpoint del proveedor de cuentas (`find-by-email`, `revalidate`), contrato `provider/v1` (DEP-3) | CIA | F3 | Contrato del proveedor de cuentas (CIA) |
| E-2 | Credencial del proveedor (DEP-2) | CIA | F3 | — |
| E-3 | Endpoint gobernado de totales del carrito `ps-cart-totals/v1` (D3) | Quote | F4 | `HANDOFF_ECOMMERCE_CART_TOTALS_AND_CONFIGURATION.md` (Quote) |
| E-4 | Inventario de configuración A1–A15 | Quote | F4 | Mismo handoff |
| E-5 | Transportista de retiro con costo 0 y su referencia (O-10) | Quote | F4 | CART-00 §4.1 |
| E-6 | Llaves Webservice dedicadas de mínimo privilegio: Quote (carts, specific_prices, lecturas) y Checkout (orders, lecturas) | Quote, Checkout | F4, F5 | ADR-Q001 (seguridad) |
| E-7 | Lectura de direcciones existentes del cliente para el binding H3 (G-ADDR mínimo). **Sin esto no hay binding real**, aunque el cliente ya tenga dirección | Checkout | F4, F5 | H3 §14 punto 9 |
| E-8 | Módulo autor y estado de entrada de la orden; paridad (OD-02, OD-03) | Checkout | F5 | PS-WS01 §7 |
| E-9 | Clon de staging de la tienda productiva (Fase C de Quote, PAY-00 de Checkout) | Quote, Checkout | F4, F5 | — |
| E-10 | Versión de PrestaShop confirmada (J7-CP-04: 1.7.8.3 frente a 8.2.3) | CIA, Quote, Checkout | F3 | — |
| E-11 | Pruebas de los módulos productivos con efectos laterales (SMS, logística, descuentos por cantidad, correos) | Checkout | F5 | — |
| E-12 | Inventario de logística y transportistas, y mapa de transportistas → `id_reference` (H1) | Quote, Shipping | F8 | CART-00 §4.1 |
| E-13 | Creación de cuentas y direcciones de compradores nuevos (D-03) | Checkout | F8 | — |

E-1..E-11 están en el camino crítico de la primera compra. E-12 y E-13 no.

## 4. Orden de trabajo y dependencias dentro de F0

```text
C-1..C-3 (hecho) ─┬─ H3 candidato (hecho) ─┬─ A7 revisión (hecha) ─┐
                  │                        └─ Checkout /v1 (hecho) ┼─ Revisión cruzada X-1..X-7 ─ Aceptación A7/H3/v1 ─┐
                  ├─ Paquete e-commerce E-1..E-13 (§3) ─ respuesta del owner e-commerce ─────────────────────────────────┼─ G0
                  └─ Responsables (§5) ─ asignación de personas ──────────────────────────────────────────────────────────┘
```

Próximos pasos de F0, sin implementación:
1. Revisión cruzada de X-1..X-7 por los dueños de CIA, Quote y Checkout.
2. Envío del paquete e-commerce.
3. Asignación de personas.
4. Decisiones D-01..D-13.

## 5. Responsables

Las personas las asigna el owner. «Pendiente» significa sin persona documentada.

| Servicio | Rol responsable | Persona | Responsable en F0 de | Aprueba |
|---|---|---|---|---|
| R4 Sales | Owner R4 | Pendiente | Coordinación del plan, registro de decisiones, D-06, D-10 | G0, G6, G7 |
| Quote V2 | Owner Quote | Pendiente | Aceptación de A7; X-4, X-5, X-7; preparación de F1 (A10, R1.7) | A7, G1 (parte Quote), G4 |
| Checkout | Owner Checkout | Pendiente | Aceptación de `/v1`; X-6; D-07/OD-06; protección del repositorio | `/v1`, G5 |
| CIA | Owner CIA | Designado (CIA-D1-01) | Aceptación de H3; X-1..X-3; C-CIA-1..8 | H3, G3 |
| PrestaShop | Owner e-commerce | Pendiente | Respuesta a E-1..E-13 | E-*, OD-02 |
| Catalog | Owner Catalog | Pendiente | D-01: cutover V2 o conjunto interino | G2 |
| Shipping | Depto. Informática (pc-carrier) | Pendiente | Sin trabajo en F0; D-12 en F8 | — |
| Mercado Pago | Owner comercial / finanzas | Pendiente | D-08, D-09 | — |
| Infraestructura | Owner de infraestructura R4 | Pendiente | Webhook productivo, backups (F5) | — |

## 6. Decisiones abiertas

| Id | Estado | Comentario |
|---|---|---|
| D-01 Fuente de catálogo | Abierta | Ver §7.2 |
| D-02 Retiro en tienda y transportista | Abierta | Depende de E-5 |
| D-03 Cuentas y direcciones nuevas | Abierta | Fuera de la primera compra. G-ADDR mínimo (E-7) sí es necesario |
| D-04 Estado y módulo de la orden | Abierta | Depende de E-8 |
| D-05 Vigencia de cotización del principal R4 | Abierta | A7 §12 la lista como bloqueo de la primera compra |
| D-06 Política FINANCIAL en R4 | Abierta | |
| D-07 TTL efectivo del enlace (OD-06) | **Abierta por decisión del owner** | El cancel interno no basta. A7 propone que la atestación de pago lleve la expiración del intento y el instante de aprobación |
| D-08 Reembolsos (OD-09) | Abierta | |
| D-09 Cuenta Mercado Pago productiva | Abierta | |
| D-10 Linaje de perfil para la compra | Abierta | Respeta el retiro de v9/`@9` |
| D-11 Remoto privado de Checkout | En preparación | §8 |
| D-12 Promoción de $1 y mapa de transportistas | Abierta | F8 |
| D-13 Autorización del pago real | Abierta | F7 |

## 7. Preparación de F1 y F2

Sólo listas de verificación. No se inicia ninguna de las dos fases.

### 7.1 F1: cotización productiva

| Requisito | Estado |
|---|---|
| A10: Quote #26 y R4 #32 fusionados juntos | Ambos abiertos. Fusión y despliegue en lockstep |
| Gate R1.7 de Quote: 7 días estables y canary sintético aprobado | Abierto |
| Deudas operativas G2-D01..D03: disco, backups, arranque tras reinicio | Abiertas |
| Principal R4 con scopes mínimos y perfil de vigencia (D-05) | Abierto |
| Perfil R4 con Quote REAL (D-10), sin capacidades de compra | No creado (restricción vigente: sin perfiles productivos) |
| Plan de cierre de GAP-14: cotización por WhatsApp real con allowlist | Por redactar en el mandato de F1 |
| Regresión J3 (`sales-autonomous-quote`, `sales-confirmed-intent-*`, `sales-deterministic-offer-*`) | Se corre en F1 |

Para autorizar F1 hacen falta un mandato explícito y la autorización de despliegue por SHA.

### 7.2 F2: catálogo veraz

| Opción | Requisitos | Costo y riesgo |
|---|---|---|
| A. Cutover a Catalog V2 | B-1..B-9, `CUTOVER_GO=YES`, re-enlace R4 antes del corte, G-1..G-4, fixtures re-sincronizados | Resuelve el problema para todas las conversaciones. Más largo |
| B. Conjunto interino de SKUs | Lista de SKUs con precio y stock verificados contra la tienda viva. Cualquier otro SKU queda fuera de la compra | Rápido para F7. No corrige el catálogo de las conversaciones actuales |

Recomendación: **B para F7 y A en paralelo**, por el riesgo del §10 del informe. Lo decide el owner de Catalog (D-01).

## 8. Protección del repositorio Checkout

| Paso | Estado |
|---|---|
| Respaldo verificable | **Hecho.** Bundle de todas las refs, `git bundle verify` OK, prueba de restauración con `--mirror` (refs idénticas, fsck limpio). Hay un segundo bundle tras el commit de F0, también verificado. Hash y manifiesto, en la carpeta de respaldo local |
| Auditoría del historial | **Hecha.** Sin secretos vivos. El historial contiene valores de infraestructura, identificadores sandbox y datos personales de aprobación: **apto para un remoto privado sin reescritura, no apto para un repositorio público** sin decisión del owner |
| Plan | `docs/operations/REPOSITORY_PROTECTION_PLAN.md` (Checkout, rama de F0) |
| Remoto privado | **No creado.** Requiere las decisiones P-1..P-8 |

Decisiones P-1..P-8 del plan:
- P-1: autorizar el remoto privado y el push del historial tal cual.
- P-2: cuenta propietaria.
- P-3: aceptar la ausencia de protección de ramas en un plan gratuito privado, con la disciplina de no hacer force-push.
- P-4: no publicar `refs/s1-candidate/*`, que quedan sólo en el bundle.
- P-5: rama por defecto e integración de la cadena `pay-*` a `main`.
- P-6: orden de push y minutos de CI.
- P-7: copia cifrada del bundle fuera de la máquina.
- P-8: aceptar los valores de infraestructura y los datos personales en un repositorio privado.

## 9. R7-4

R7-4 avanza independientemente de Quote, en su propia rama local (`feat/r4-r7-4-cross-task-continuity`, `32e8173`).
**No está terminado ni se solicita su aceptación.**

| Requisito del owner | Estado (2026-11-02) |
|---|---|
| Regresión pendiente (L2 completa: el cambio es transversal, son 19 suites de mutación) | **En curso** en el worktree de R7-4. Sin resultado registrado aún. Esta línea de trabajo no corrió una cadena paralela, porque comparten la base local y `test:recovery` corta conexiones |
| Continuidad entre tasks | Cubierta por R74-1 y R74-2 (L1). Pendiente de la confirmación en L2 |
| Recuperación tras reinicio | R74-5 compila el turno siguiente con **otro worker en el mismo proceso y la misma base**: no reinicia el proceso ni la base. `test:recovery` no tiene un caso propio de este cambio. **Brecha a cubrir o a registrar como `NOT_RUN`** antes de pedir la aceptación |
| Contexto preservado dentro del presupuesto | R74-6 |
| Ausencia de duplicados | R74-1 y R74-4 |
| Pruebas omitidas registradas como `NOT_RUN` | Hasta ahora, la validación con modelo real (gasto no autorizado) |

Todas las pruebas R74 usan un modelo guionado. Prueban **qué se le muestra al modelo**, no cómo lo usa. La evidencia
final se registra en `R4_R7_4_CROSS_TASK_CONTINUITY_REPORT.md` §6, junto al cambio. Las pruebas de continuidad de
cotizaciones pertenecen a la integración J5/Quote.

## 10. Estado

```text
R4_J5_F0_READY_FOR_GATE_REVIEW
```

Pendiente del owner:
- revisión de A7, H3 y `/v1` con X-1..X-7;
- envío y respuesta del paquete e-commerce;
- asignación de personas;
- D-01..D-13;
- P-1..P-8.
