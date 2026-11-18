---
title: R4 F2 — Items de trabajo ejecutables (CIA + Checkout + Quote + e-commerce + R4)
status: PROPUESTA — preparación de F2; nada se activa (sin pagos, órdenes, carritos ni Checkout productivos)
date: 2026-11-18
mandate: «F2 preparation» (owner, 2026-11-18)
base: main 704c15d (carril WhatsApp `sales-production@22`)
source: R4_CHECKOUT_STATUS_2026-11.md (PR #86): cada bloqueo de su §1 y §4 es aquí un item
issues: R4_F2_WORK_ITEM_ISSUES.md (un cuerpo de issue por item, listo para pegar; no se crearon issues)
---

# F2 — Items de trabajo

## 0. Cómo leer la tabla

- **Id:** `F2-D*` decisión del owner · `F2-C*` CIA · `F2-K*` Checkout · `F2-Q*` Quote · `F2-E*` e-commerce · `F2-R*` R4.
- **Dueño:** quien ejecuta o decide. «Owner R4 (decisión)» = decisión del owner, no trabajo de código.
- **¿Ahora?:** «Sí» = puede empezar hoy sin pagos reales ni decisiones pendientes; «No» = espera sus dependencias.
- Ningún item habilita pagos, órdenes, carritos ni Checkout productivos. Un E2E con Mercado Pago **de prueba** necesita
  una E-S1 nueva del owner.

## 1. Tabla

| Id | Dueño | Entregable | Criterio de aceptación (verificable) | Depende de | ¿Ahora? |
|---|---|---|---|---|---|
| F2-D01 | Owner R4 (decisión) | Revisión y merge del PR #64 (plan + auditoría R4-L) | En `main`, la fila R4-L del roadmap dice «Iniciado: solo integración sandbox» y existen el plan y la auditoría | — | Sí |
| F2-D02 | Owner + Checkout + CIA (decisión) | Decisión O-5 y R4L-D2 sobre el [registro O-5](R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md) | El registro pasa a DECIDIDO con respuesta a Q1..Q6 | — | Sí |
| F2-D03 | Owner comercial + e-commerce (decisión) | Decisión O-6 sobre el [registro O-6](R4_F2_O6_DELIVERY_CART_DECISION.md) | El registro pasa a DECIDIDO con opción elegida y respuestas Q1..Q5 | — | Sí |
| F2-D04 | Owner + owner Checkout (decisión) | O-7: si un reintento (`waiting_retry`) o un pago offline cuentan como «iniciado» en C1, y tope de demora | Regla escrita con un ejemplo por caso (en proceso min 10 + captura 3 días después; offline) | — | Sí |
| F2-D05 | Owner + e-commerce (decisión) | O-4: topología del E2E desde WhatsApp ((a) tienda aislada clonada, (b) E2E hasta la emisión, (c) esperar el camino productivo) | Opción elegida y entorno nombrado fuera del repositorio público | — | Sí |
| F2-D06 | Owner R4 (decisión) | O-8 / D-10: número de perfil y definición del carril de compra sobre el linaje vigente (`@22`) | Número y versión de definición reservados por escrito; respetan los retiros y reservas previas | — | Sí |
| F2-D07 | Owner R4 (decisión) | D7-6 / D-06: política FINANCIAL fuera de sandbox (ADR de autonomía con identidad `verified` y tope de importe, o aprobación humana) | ADR o decisión escrita; sin efecto hasta G3 | F2-C03 (para la opción a) | Sí (decisión) |
| F2-D08 | Owner R4 (decisión) | R4L-D1: tope de operaciones financieras por task en sandbox (2 hoy; 3 permite un relink) | Valor escrito; `CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK` y su prueba coinciden | — | Sí |
| F2-D09 | Owner R4 (decisión) | O-1: nombre del incremento (evitar la colisión con F2 de J5) | Nombre registrado en el plan | — | Sí |
| F2-D10 | Owner de datos (decisión) | OA-04 / D7 / J7: correos y datos reales para OTP e identidad | Decisión escrita con alcance (allowlist interna) y retención (DEP-10) | — | Sí (decisión) |
| F2-C01 | CIA | Publicar el candidato H3 (rama local `docs/h3-purchase-authorization-candidate` @ `39342b2`) en el remoto CIA y abrir PR de revisión | PR abierto en el repo CIA con el documento sin cambios; revisores de CIA, Quote y Checkout | — | Sí |
| F2-C02 | CIA + Quote + Checkout | Aceptación cruzada de H3, incluida X-1 (`azp`, OQ-H3-1), OQ-H3-2 y OQ-H3-10 | H3 marcado ACEPTADO por los tres owners; X-1 cerrado con un valor | F2-C01, F2-Q01, F2-K07 | No |
| F2-C03 | CIA | Propósito `purchase` y audiencia por propósito en modo sintético (C-CIA-1/-3; H3-D2/D3) | `resolve(['purchase'])` para `r4-sales` → grant `aud=quote-cart-preparer`, `purposes=["purchase"]`; mezcla de propósitos → 400 sin emitir; suite existente (304 + 41) verde | F2-C02 | No |
| F2-C04 | CIA + owner comercial (decisión) | Frescura de la prueba OTP para `purchase` (OQ-H3-3) | Valor decidido (propuesta: misma conversación, ≤ 30 min) y prueba en la CIA | — | Sí (decisión) |
| F2-C05 | CIA | Modo no sintético: claves en KMS (C-CIA-8, DEP-6), credencial (DEP-2), correo real (DEP-5), revocación (OD-CIA-4) | Instancia no productiva con el proveedor real de la tienda aislada; G3 en entorno no productivo | F2-E01, F2-D10 | No |
| F2-E01 | e-commerce | Productor del proveedor de cuentas (DEP-3, `ACCOUNT_PROVIDER_V1_CONTRACT.md` de la CIA) en la tienda aislada | El cliente remoto de la CIA pasa contra él (`find-by-email`, `revalidate`); respuestas cerradas por schema; nunca `passwd`, `secure_key`, direcciones ni pedidos | Aceptación del contrato por e-commerce | Sí |
| F2-E02 | e-commerce | Designar el transportista de retiro a costo 0 (E-5 / O-10) en la tienda aislada | Referencia documentada fuera del repo público; Quote arranca con `QUOTE_CART_PICKUP_CARRIER_REFERENCE` | — | Sí |
| F2-E03 | e-commerce | Endpoint gobernado `ps-cart-totals/v1` (E-3) en la tienda aislada | `parseCartTotals` de Quote lo acepta; `calculationPath` = camino de la orden | — | Sí |
| F2-E04 | e-commerce | Llaves Webservice dedicadas de mínimo privilegio para Quote y Checkout (E-6) | Cada llave sólo tiene los recursos listados en el plan F0 §3 | — | Sí |
| F2-E05 | e-commerce + Checkout | Lectura de direcciones existentes del cliente (E-7 / H2) | Checkout obtiene las direcciones del `sub` del grant en la tienda aislada; ningún id de dirección llega a R4 | F2-E04 | Sí |
| F2-E06 | e-commerce + Shipping | Inventario B2 (transportistas, rangos, reglas de envío gratis) y mapa estable (transportista, servicio) → referencia de PrestaShop; códigos estables en pc-carrier | Inventario y mapa versionados fuera del repo público; pc-carrier devuelve códigos | — | Sí |
| F2-E07 | e-commerce | Módulo de transportista con costo congelado (opción C de O-6) | En la tienda aislada, un carrito preparado por Quote cobra exactamente el despacho escrito por Quote; nadie más puede escribirlo | F2-D03 (= C), F2-E06 | No |
| F2-E08 | e-commerce | Entorno para el E2E según O-4 (E-9) | Entorno disponible con ids de catálogo coherentes con Catalog V2 | F2-D05 | No |
| F2-K01 | Checkout | Remoto privado y CI (D-11) desde el respaldo verificado | Remoto privado con las ramas `pay-*`; CI corre unit + domain + contract en cada push | Permisos P-1..P-8 | Sí |
| F2-K02 | Checkout | Corregir las dos guardas estáticas rotas desde `14335cb` (`scripts/sbx2/localStack.ts` importa código de prueba) | `u6SecurityClosure` C-1 y `pay04G1FinalAcceptanceUnit` SBX-1 en verde sin debilitar la regla | — | Sí |
| F2-K03 | Checkout | Comprador desde el grant CIA (R4L-D3): verificar `x-customer-access-grant`; comprador = `grant.sub`; el consentimiento sólo prueba el acto | Pruebas con JWKS de la CIA sintética: sin grant → rechazo; `sub` ≠ sujeto del acto → rechazo; comprador registrado = `sub` | F2-K01; formato de F2-C01 | Sí (contra la CIA sintética) |
| F2-K04 | Checkout | Consentimiento según O-5: emisión y registro por Checkout desde la evidencia del acto; audiencia; cancelación de sesión | Pruebas: acto de otra cotización/versión/importe → rechazo; un acto por sesión; cancelación antes del pago | F2-D02 | No |
| F2-K05 | Checkout | Sonda C1 como prueba de caracterización (en proceso al minuto 10, captura 3 días después) | La prueba existe y documenta el comportamiento actual; se marcará como regresión cuando llegue F2-K06 | — | Sí |
| F2-K06 | Checkout | Corrección C1 según O-7 | Sonda C1 con el resultado decidido; LATE-A/B/C sin cambios; revisión independiente | F2-D04, F2-K05 | No |
| F2-K07 | Checkout | Publicar y aceptar `/v1 1.0.4-proposed` (G0) junto con H3 y A7 | Contrato publicado en el remoto; estado ACEPTADO | F2-K01, F2-C01 | Sí (publicar) |
| F2-K08 | Checkout | Coherencia de dirección con la comuna cotizada y paridad de importe en sesión y enlace (O-6) | Pruebas: dirección fuera de la comuna → no `READY`; importe distinto → sin enlace | F2-D03, F2-E05 | No |
| F2-K09 | Checkout | OD-06 / D-07: evidencia del vencimiento efectivo del enlace en el proveedor | Observación con Mercado Pago de prueba registrada | E-S1 nueva | No |
| F2-Q01 | Quote | Publicar A7 §12 (rama local `docs/a7-f0-review`) para revisión cruzada con H3 | PR en el repo Quote | — | Sí |
| F2-Q02 | Quote | Verificador del grant de producción: `azp` según X-1, exactamente `["purchase"]`, claims `bv` y `amount`, consumo del `jti`, sin `details.code` público | Pruebas por regla en la suite de Quote | F2-C02 | No |
| F2-Q03 | Quote | Ensayo local de H3 `verify` (fuera de `NODE_ENV=production`) en la tienda aislada con grant de la CIA sintética o el emisor de prueba de Checkout | Un `POST carts`, carrito `READY` con paridad, retiro a costo 0 | F2-E02; F2-E03 o paridad sintética | Sí (con el emisor de prueba) |
| F2-Q04 | Quote | Representar el despacho según O-6 (quitar H1 para el método elegido; motivos `NOT_READY` tipados nuevos) | Carrito con despacho `READY` sólo con paridad de despacho y total; cada desajuste → motivo tipado | F2-D03, F2-E06 (+ E07 si C) | No |
| F2-R01 | R4 | Evidencia determinista del acto de compra (sin conectar) | **Hecho en este PR**: `purchase-act.ts`, unit 7/7, tripwire de contrato | — | Hecho |
| F2-R02 | R4 | Persistir el acto (migración Sales append-only, `request_input_id` único) en la transacción de `recordCheckoutPurchaseRequest` | Integración: un acto por input; inmutable; sin texto ni `customerRef` | F2-D02; autorización de la migración | No |
| F2-R03 | R4 | Transporte del grant en `x-customer-access-grant` en el adaptador Checkout, sin conectar a ningún perfil | Unit/contract: la cabecera se envía; el grant nunca aparece en salidas al modelo, logs, recibos ni el cuerpo congelado | Contrato `/v1 1.0.4-proposed` (F2-K07) | Sí (contra el candidato) |
| F2-R04 | R4 | Propósito `purchase` en el cliente CIA y `resolve` determinista dentro de `checkout.start_purchase` | Unit + interop contra la CIA sintética con `purchase`; tripwire F2-R04 actualizado | F2-C03 | No |
| F2-R05 | R4 | Perfil de carril de compra (inactivo) sobre el linaje vigente, con identidad + Checkout | Contrato del perfil; L2 completo; no registrado en producción | F2-D06, F2-R02, F2-R03, F2-R04 | No |
| F2-R06 | R4 | Enviar `carrier.code` y `serviceType.code` a Quote (CART-00 M8) | Contract: el cuerpo congelado lleva los códigos del mapa | F2-E06 | No |
| F2-R07 | R4 | Mapear motivos `NOT_READY` de paridad/despacho/destino a «cotización nueva para aceptar» o derivación (nunca enlace) | Unit por motivo; motivo desconocido → derivación | F2-Q04, F2-K08 | No |
| F2-R08 | R4 | Extender el evaluador de afirmaciones de pago (R-6): el modelo no afirma «pagado», URL ni importe sin `purchase_status` | Casos de evaluación negativos y positivos en verde | — | Sí |
| F2-R09 | R4 | E2E sandbox desde WhatsApp (S8 del plan) | R4-CK-01..12 reales; L3 + F-1..F-7 en PASS | F2-D05, F2-R05, F2-K03/K04, F2-Q03, E-S1 nueva | No |
| F2-R10 | R4 | Texto determinista de la oferta de compra generado desde Quote (aviso de plataforma) y exigido por el acto | Unit: el acto exige el aviso inmediatamente anterior con número y total de la cotización | F2-D02 | No |

## 2. Grafo (resumen)

```text
D02 (O-5) ─► K04 ─┐                         C01 ─► C02 ─► C03 ─► R04 ─┐
           R02 ───┤                     Q01 ─┘   └─► Q02             │
           R10 ───┤                     K07 ─┘                       │
                  ├─► R05 (perfil inactivo) ◄── D06, R03 ◄── K07      │
D03 (O-6) ─► Q04 ─┤                                                  │
     E06 ─► E07 ──┘                                                  │
D04 (O-7) ─► K06 ◄── K05                                             │
D05 (O-4) ─► E08 ──────────────► R09 (E2E sandbox, E-S1) ◄───────────┘
```

## 3. Incrementos independientes, sin pagos reales

| # | Incremento | Item | Estado |
|---|---|---|---|
| 1 | Evidencia determinista del acto de compra en R4 (pura, sin conectar, sin migración) | F2-R01 | **Implementado en este PR** |
| 2 | Tripwires de contrato F2 (acto sin conectar; R4 sin `purchase`; R4 sin modo Checkout productivo) | F2-R01, F2-R04 | **Implementado en este PR** |
| 3 | Transporte del grant en el adaptador Checkout contra `/v1 1.0.4-proposed`, sin conectar | F2-R03 | Especificado; no implementado (espera la publicación del contrato, F2-K07) |
| 4 | Evaluador de afirmaciones de pago | F2-R08 | Especificado |
| 5 | Sonda C1 en Checkout | F2-K05 | Especificado (repo Checkout; no se tocó) |
| 6 | Guardas estáticas de Checkout | F2-K02 | Especificado (repo Checkout) |
| 7 | Ensayo local de H3 `verify` en Quote | F2-Q03 | Especificado (repo Quote) |
| 8 | Publicación de H3 y A7 §12 | F2-C01, F2-Q01 | Especificado (repos CIA y Quote) |

Por qué el incremento 1 no lleva un flag: no está conectado a ninguna capacidad, perfil, composición ni app (lo
verifica una prueba de contrato). Un flag sobre código sin conectar no apaga nada. La conexión (F2-R02) llega con su
migración y su autorización, y ahí se decide si va detrás de un flag.
