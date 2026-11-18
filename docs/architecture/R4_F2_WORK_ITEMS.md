---
title: R4 F2 — Items de trabajo ejecutables (CIA + Checkout + Quote + e-commerce + R4)
status: O-5 y O-6 APROBADOS (owner, 2026-11-18); items ajustados a las opciones aprobadas. Nada se activa (sin pagos, órdenes, carritos ni Checkout productivos)
date: 2026-11-18
mandate: «F2 preparation» (owner, 2026-11-18)
base: main 85d9192 (carril WhatsApp `sales-production@22`)
source: R4_CHECKOUT_STATUS_2026-11.md (PR #86): cada bloqueo de su §1 y §4 es aquí un item
issues: R4_F2_WORK_ITEM_ISSUES.md (un cuerpo de issue por item, listo para pegar; no se crearon issues)
---

# F2 — Items de trabajo

## 0. Cómo leer la tabla

- **Id:** `F2-D*` decisión del owner · `F2-C*` CIA · `F2-K*` Checkout · `F2-Q*` Quote · `F2-E*` e-commerce · `F2-R*` R4.
- **Dueño:** quien ejecuta o decide. «(decisión)» = decisión, no trabajo de código.
- **¿Ahora?:** «Sí» = puede empezar hoy sin pagos reales ni decisiones pendientes; «No» = espera sus dependencias;
  «Hecho» = cerrado.
- Decisiones aprobadas el 2026-11-18: **O-5** = opción D ([registro](R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md)):
  Checkout emite la evidencia de consentimiento desde el acto explícito que R4 registra y transmite. **O-6** = opción C
  ([registro](R4_F2_O6_DELIVERY_CART_DECISION.md)): módulo de PrestaShop que preserva exactamente las condiciones
  comerciales autorizadas por Quote. Sus seguimientos (FU-*) están como items abajo.
- Ningún item habilita pagos, órdenes, carritos ni Checkout productivos. Un E2E con Mercado Pago **de prueba** necesita
  una E-S1 nueva del owner.

## 1. Tabla

| Id | Dueño | Entregable | Criterio de aceptación (verificable) | Depende de | ¿Ahora? |
|---|---|---|---|---|---|
| F2-D01 | Owner R4 (decisión) | Revisión y merge del PR #64 (plan + auditoría R4-L) | En `main`, la fila R4-L del roadmap dice «Iniciado: solo integración sandbox» y existen el plan y la auditoría | — | Sí |
| F2-D02 | Owner (decisión) | O-5: emisor del consentimiento | Aprobado 2026-11-18: opción D | — | Hecho |
| F2-D03 | Owner (decisión) | O-6: entrega y carrito | Aprobado 2026-11-18: opción C (módulo) | — | Hecho |
| F2-D04 | Owner + owner Checkout (decisión) | O-7: si un reintento (`waiting_retry`) o un pago offline cuentan como «iniciado» en C1, y tope de demora | Regla escrita con un ejemplo por caso (en proceso min 10 + captura 3 días después; offline) | — | Sí |
| F2-D05 | Owner + e-commerce (decisión) | O-4: topología del E2E desde WhatsApp ((a) tienda aislada clonada, (b) E2E hasta la emisión, (c) esperar el camino productivo) | Opción elegida y entorno nombrado fuera del repositorio público | — | Sí |
| F2-D06 | Owner R4 (decisión) | O-8 / D-10: número de perfil y definición del carril de compra sobre el linaje vigente (`@22`) | Número y versión de definición reservados por escrito; respetan los retiros y reservas previas | — | Sí |
| F2-D07 | Owner R4 (decisión) | D7-6 / D-06: política FINANCIAL fuera de sandbox (ADR de autonomía con identidad `verified` y tope de importe, o aprobación humana) | ADR o decisión escrita; sin efecto hasta G3 | F2-C03 (para la opción a) | Sí (decisión) |
| F2-D08 | Owner R4 (decisión) | R4L-D1: tope de operaciones financieras por task en sandbox (2 hoy; 3 permite un relink) | Valor escrito; `CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK` y su prueba coinciden | — | Sí |
| F2-D09 | Owner R4 (decisión) | O-1: nombre del incremento (evitar la colisión con F2 de J5) | Nombre registrado en el plan | — | Sí |
| F2-D10 | Owner de datos (decisión) | OA-04 / D7 / J7: correos y datos reales para OTP e identidad | Decisión escrita con alcance (allowlist interna) y retención (DEP-10) | — | Sí (decisión) |
| F2-D11 | Owner R4 + owner Checkout (decisión) | FU-2 de O-5 (R4L-D2): un consentimiento por sesión con un acto por enlace, o uno por intento | Regla confirmada en el registro O-5 §4 | — | Sí |
| F2-D12 | Owner comercial + legal (decisión) | FU-4 de O-5: texto legal que acepta el cliente y retención del consentimiento y del mensaje | Texto versionado y plazos de retención escritos | — | Sí (no bloquea el sandbox) |
| F2-D13 | Owner R4 (decisión) | FU-6 de O-5: ¿el primer E2E exige el texto determinista de compra (F2-R10) o basta la gramática cerrada? | Decisión escrita | — | Sí |
| F2-D14 | Owner comercial (decisión) | FU-O6-3: ¿un E2E sandbox con retiro (`pickup-zero-v1`) antes del módulo? Opcional; no es parte de O-6 | Sí/no escrito y transportista de retiro (O-10) si es sí | — | Sí (opcional) |
| F2-C01 | CIA | Publicar el candidato H3 (rama local `docs/h3-purchase-authorization-candidate` @ `39342b2`) en el remoto CIA y abrir PR de revisión | PR abierto en el repo CIA con el documento sin cambios; revisores de CIA, Quote y Checkout | — | Sí |
| F2-C02 | CIA + Quote + Checkout | Aceptación cruzada de H3, incluida X-1 (`azp`, OQ-H3-1), OQ-H3-2 y OQ-H3-10; §10 alineado con O-5 (Checkout emite desde el acto de R4) | H3 marcado ACEPTADO por los tres owners; X-1 cerrado con un valor | F2-C01, F2-Q01, F2-K07 | No |
| F2-C03 | CIA | Propósito `purchase` y audiencia por propósito en modo sintético (C-CIA-1/-3; H3-D2/D3) | `resolve(['purchase'])` para `r4-sales` → grant `aud=quote-cart-preparer`, `purposes=["purchase"]`; mezcla de propósitos → 400 sin emitir; suite existente (304 + 41) verde | F2-C02 | No |
| F2-C04 | CIA + owner comercial (decisión) | FU-3 de O-5: frescura de la prueba OTP para `purchase` (OQ-H3-3) | Valor decidido (propuesta: misma conversación, ≤ 30 min) y prueba en la CIA | — | Sí (decisión) |
| F2-C05 | CIA | Modo no sintético: claves en KMS (C-CIA-8, DEP-6), credencial (DEP-2), correo real (DEP-5), revocación (OD-CIA-4) | Instancia no productiva con el proveedor real de la tienda aislada; G3 en entorno no productivo | F2-E01, F2-D10 | No |
| F2-E01 | e-commerce | Productor del proveedor de cuentas (DEP-3, `ACCOUNT_PROVIDER_V1_CONTRACT.md` de la CIA) en la tienda aislada | El cliente remoto de la CIA pasa contra él (`find-by-email`, `revalidate`); respuestas cerradas por schema; nunca `passwd`, `secure_key`, direcciones ni pedidos | Aceptación del contrato por e-commerce | Sí |
| F2-E02 | e-commerce | Transportista de retiro a costo 0 (E-5 / O-10) en la tienda aislada, sólo si F2-D14 es sí | Referencia documentada fuera del repo público | F2-D14 | No |
| F2-E03 | e-commerce | Endpoint gobernado `ps-cart-totals/v1` (E-3) en la tienda aislada, informando el despacho por el camino de la orden (O-6 M-5) | `parseCartTotals` de Quote lo acepta; `calculationPath` = camino de la orden; `totals.shipping` presente | — | Sí |
| F2-E04 | e-commerce | Llaves Webservice dedicadas de mínimo privilegio para Quote y Checkout (E-6) | Cada llave sólo tiene los recursos listados en el plan F0 §3 | — | Sí |
| F2-E05 | e-commerce + Checkout | Lectura de direcciones existentes del cliente (E-7 / H2) | Checkout obtiene las direcciones del `sub` del grant en la tienda aislada; ningún id de dirección llega a R4 | F2-E04 | Sí |
| F2-E06 | e-commerce + Shipping | FU-O6-2: inventario B2 (transportistas, rangos, reglas de envío gratis) y mapa versionado (transportista, servicio) → referencia de PrestaShop; códigos estables en pc-carrier | Inventario y mapa versionados fuera del repo público; pc-carrier devuelve códigos | — | Sí |
| F2-E07 | e-commerce (+ Quote) | FU-O6-1: **módulo de PrestaShop** que aplica las condiciones de despacho congeladas por Quote (O-6 §4, M-1..M-6): primero el diseño, luego el módulo en la tienda aislada | Diseño aceptado por e-commerce y Quote; en la tienda aislada, un carrito preparado por Quote cobra exactamente el despacho fijado; nadie más puede fijarlo; reglas de envío gratis no lo alteran | F2-E06 (mapa), F2-E04 | Sí (diseño) |
| F2-E08 | e-commerce | Entorno para el E2E según O-4 (E-9) | Entorno disponible con ids de catálogo coherentes con Catalog V2 | F2-D05 | No |
| F2-E09 | e-commerce + Quote | FU-O6-5: medición en la tienda aislada: cotizaciones reales del carril reproducidas por el módulo con paridad exacta, sin cobrar | Informe fuera del repo público: N cotizaciones, 0 diferencias, incluida la banda de $1 | F2-E07, F2-Q04 | No |
| F2-K01 | Checkout | Remoto privado y CI (D-11) desde el respaldo verificado | Remoto privado con las ramas `pay-*`; CI corre unit + domain + contract en cada push | Permisos P-1..P-8 | Sí |
| F2-K02 | Checkout | Corregir las dos guardas estáticas rotas desde `14335cb` (`scripts/sbx2/localStack.ts` importa código de prueba) | `u6SecurityClosure` C-1 y `pay04G1FinalAcceptanceUnit` SBX-1 en verde sin debilitar la regla | — | Sí |
| F2-K03 | Checkout | Comprador desde el grant CIA (R4L-D3): verificar `x-customer-access-grant`; comprador = `grant.sub` | Pruebas con JWKS de la CIA sintética: sin grant → rechazo; `sub` ≠ sujeto del acto → rechazo; comprador registrado = `sub` | F2-K01; formato de F2-C01 | Sí (contra la CIA sintética) |
| F2-K04 | Checkout (+ R4) | **O-5:** contrato de transmisión del acto (FU-1) y emisión de la evidencia de consentimiento por Checkout desde el acto que R4 transmite (`assurance = service_attested`, `consentId`) | Contrato escrito (sin texto ni PII); pruebas: acto de otra cotización/versión/importe → rechazo; un acto por sesión (o por intento según F2-D11); acto sin grant válido → rechazo | F2-K01, F2-K03, F2-D11 | Sí (contrato) |
| F2-K05 | Checkout | Sonda C1 como prueba de caracterización (en proceso al minuto 10, captura 3 días después) | La prueba existe y documenta el comportamiento actual | — | Sí |
| F2-K06 | Checkout | Corrección C1 según O-7 | Sonda C1 con el resultado decidido; LATE-A/B/C sin cambios; revisión independiente | F2-D04, F2-K05 | No |
| F2-K07 | Checkout | Publicar y aceptar `/v1 1.0.4-proposed` (G0) junto con H3 y A7, incluyendo la transmisión del acto (F2-K04) | Contrato publicado en el remoto; estado ACEPTADO | F2-K01, F2-C01 | Sí (publicar) |
| F2-K08 | Checkout | **O-6:** dirección coherente con la comuna cotizada y paridad de importe en sesión, enlace y conciliación; mapear los motivos `NOT_READY` nuevos | Pruebas: dirección fuera de la comuna → no `READY`; importe distinto → sin enlace | F2-E05, FU-O6-4 (origen de la dirección) | No |
| F2-K09 | Checkout | OD-06 / D-07: evidencia del vencimiento efectivo del enlace en el proveedor | Observación con Mercado Pago de prueba registrada | E-S1 nueva | No |
| F2-K10 | Checkout | FU-5 de O-5: cancelación de sesión antes del pago (revocación) | Ruta documentada en `/v1`; prueba: sesión cancelada → sin enlace | F2-K01 | Sí |
| F2-Q01 | Quote | Publicar A7 §12 (rama local `docs/a7-f0-review`) para revisión cruzada con H3 | PR en el repo Quote | — | Sí |
| F2-Q02 | Quote | Verificador del grant de producción: `azp` según X-1, exactamente `["purchase"]`, claims `bv` y `amount`, consumo del `jti`, sin `details.code` público | Pruebas por regla en la suite de Quote | F2-C02 | No |
| F2-Q03 | Quote | Ensayo local de H3 `verify` (fuera de `NODE_ENV=production`) en la tienda aislada con grant de la CIA sintética o el emisor de prueba de Checkout | Un `POST carts`, carrito `READY` con paridad | F2-E03 o paridad sintética | Sí (con el emisor de prueba) |
| F2-Q04 | Quote | **O-6:** quitar el bloqueo H1 para el módulo: fijar transportista desde el código, escribir las condiciones congeladas para el `id_cart`, verificar la paridad del despacho; motivos `NOT_READY` tipados | Carrito con despacho `READY` sólo con paridad de despacho y total; cada desajuste → motivo tipado; sin recálculo | F2-E07 (diseño), F2-E06 | No |
| F2-R01 | R4 | Evidencia determinista del acto de compra | `purchase-act.ts`, unit 7/7 | — | Hecho |
| F2-R02 | R4 | Persistir el acto (Sales `0012`, append-only, `request_input_id` único) en `checkout.start_purchase@1`, detrás de `purchaseActRecording` (apagado) | Integration 4/4: apagado = sin registro; encendido = un registro, réplica idempotente, un mensaje = un inicio, fila inmutable; tripwire: ningún perfil, composición ni app lo enciende | — | Hecho (este PR) |
| F2-R03 | R4 | Cabecera `x-customer-access-grant` en el adaptador Checkout (opcional en el puerto); ningún código de R4 la provee aún | Unit 3/3: sólo en la cabecera, nunca en el cuerpo ni la telemetría; ausente = petición de hoy; un grant que no es JWS compacto se rechaza sin enviar; tripwire: nadie en `agents/` o `apps/` la provee | Contrato `/v1 1.0.4-proposed` (F2-K07) para cerrar | Hecho (este PR) |
| F2-R04 | R4 | Propósito `purchase` en el cliente CIA y `resolve` determinista dentro de `checkout.start_purchase`; el grant pasa a F2-R03 | Unit + interop contra la CIA sintética con `purchase`; tripwires F2-R03/F2-R04 actualizados | F2-C03 | No |
| F2-R05 | R4 | Perfil de carril de compra (inactivo) sobre el linaje vigente, con identidad + Checkout + acto | Contrato del perfil; L2 completo; no registrado en producción | F2-D06, F2-R04, F2-R11 | No |
| F2-R06 | R4 | Enviar `carrier.code` y `serviceType.code` a Quote (O-6 M-4) | Contract: el cuerpo congelado lleva los códigos del mapa | F2-E06 | No |
| F2-R07 | R4 | Mapear motivos `NOT_READY` de paridad/despacho/destino a «cotización nueva para aceptar» o derivación (nunca enlace) | Unit por motivo; motivo desconocido → derivación | F2-Q04, F2-K08 | No |
| F2-R08 | R4 | Extender el evaluador de afirmaciones de pago (R-6): el modelo no afirma «pagado», URL ni importe sin `purchase_status` | Casos de evaluación negativos y positivos en verde | — | Sí |
| F2-R09 | R4 | E2E sandbox desde WhatsApp (S8 del plan) | R4-CK-01..12 reales; L3 + F-1..F-7 en PASS | F2-D05, F2-D13, F2-R05, F2-K03/K04, F2-Q03, E-S1 nueva | No |
| F2-R10 | R4 | Texto determinista de la oferta de compra generado desde Quote (aviso de plataforma) y exigido por el acto | Unit: el acto exige el aviso inmediatamente anterior con número y total de la cotización | F2-D13 | No |
| F2-R11 | R4 | **O-5:** transmitir el acto registrado (`0012`) a Checkout según el contrato de F2-K04 | Unit/contract contra el contrato: sin texto ni PII; mismo acto en réplicas; tripwire sin perfiles | F2-K04, F2-K07 | No |

## 2. Grafo (resumen)

```text
O-5 (aprobada) ─► K04 (contrato de transmisión, FU-1) ─► R11 ─┐
                  K03 ◄── C01 (formato del grant)             │
       C01 ─► C02 ─► C03 ─► R04 ──────────────────────────────┤
                                                              ├─► R05 (perfil inactivo) ─► R09 (E2E sandbox, E-S1)
O-6 (aprobada) ─► E06 (mapa) ─► E07 (módulo) ─► Q04 ─► R07 ───┘          ▲
                         └─► R06            K08 ◄── E05                  │
D04 (O-7) ─► K06 ◄── K05                                                 │
D05 (O-4) ─► E08 ────────────────────────────────────────────────────────┘
```

## 3. Incrementos independientes, sin pagos reales

| # | Incremento | Item | Estado |
|---|---|---|---|
| 1 | Evidencia determinista del acto de compra (pura) | F2-R01 | **Implementado** |
| 2 | Persistencia del acto (Sales `0012`, aditiva) en `checkout.start_purchase@1` detrás de `purchaseActRecording`, apagado | F2-R02 | **Implementado en este PR** |
| 3 | Cabecera del grant CIA en el adaptador Checkout, sin proveedor | F2-R03 | **Implementado en este PR** |
| 4 | Tripwires de contrato F2 (nada alcanzable desde perfiles, composiciones ni apps; sin `purchase`; sin modo Checkout productivo) | F2-R01..R04 | **Implementado en este PR** |
| 5 | Evaluador de afirmaciones de pago | F2-R08 | Especificado |
| 6 | Sonda C1, guardas estáticas, cancelación de sesión, contrato de transmisión | F2-K05, K02, K10, K04 | Especificados (repo Checkout; no se tocó) |
| 7 | Ensayo local de H3 `verify`; diseño del módulo | F2-Q03, F2-E07 | Especificados (Quote, e-commerce) |
| 8 | Publicación de H3 y A7 §12 | F2-C01, F2-Q01 | Especificados (repos CIA y Quote) |

**Despliegue.** `0012` es una migración Sales aditiva: el próximo despliegue que incluya este cambio la aplicará
(una tabla vacía, sin escrituras mientras el flag esté apagado). Ningún perfil, composición ni app enciende el flag ni
provee el grant.
