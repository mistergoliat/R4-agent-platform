---
title: R4 F2 — Cuerpos de issue por item de trabajo (listos para pegar)
status: LISTO PARA PEGAR — O-5 y O-6 aprobados (2026-11-18); no se creó ningún issue; generado desde la tabla de R4_F2_WORK_ITEMS.md §1
date: 2026-11-18
---

# F2 — Cuerpos de issue

Uno por item de R4_F2_WORK_ITEMS.md (`docs/architecture/R4_F2_WORK_ITEMS.md`). Título sugerido = `[F2-xxx] <entregable>`. Etiquetas sugeridas: `f2` + el área. Sin datos productivos: los valores de tienda, hosts y credenciales van fuera de los repositorios públicos.

## Decisiones aprobadas (owner, 2026-11-18)

- **O-5:** «Checkout issues the purchase-consent evidence from an explicit act that R4 records and transmits.» Registro: `docs/architecture/R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` (opción D; identidad = grant CIA `purchase` relevado en `x-customer-access-grant`).
- **O-6:** «Delivery is integrated through a PrestaShop module that preserves exactly the commercial conditions authorized by Quote.» Registro: `docs/architecture/R4_F2_O6_DELIVERY_CART_DECISION.md` (opción C; requisitos M-1..M-6; sin recálculo silencioso).
- Pagos y rollout real siguen deshabilitados.

Los items marcados «Hecho» están cerrados: no abrir issue.

---

## [F2-D01] Revisión y merge del PR #64 (plan + auditoría R4-L)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner R4 (decisión)

**Entregable**

Revisión y merge del PR #64 (plan + auditoría R4-L)

**Criterios de aceptación**

- [ ] En `main`, la fila R4-L del roadmap dice «Iniciado: solo integración sandbox» y existen el plan y la auditoría
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D01); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D02] O-5: emisor del consentimiento

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner (decisión)

**Entregable**

O-5: emisor del consentimiento

**Criterios de aceptación**

- [ ] Aprobado 2026-11-18: opción D
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Hecho

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D02); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D03] O-6: entrega y carrito

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner (decisión)

**Entregable**

O-6: entrega y carrito

**Criterios de aceptación**

- [ ] Aprobado 2026-11-18: opción C (módulo)
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Hecho

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D03); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D04] O-7: si un reintento (`waiting_retry`) o un pago offline cuentan como «iniciado» en C1, y tope de demora

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner + owner Checkout (decisión)

**Entregable**

O-7: si un reintento (`waiting_retry`) o un pago offline cuentan como «iniciado» en C1, y tope de demora

**Criterios de aceptación**

- [ ] Regla escrita con un ejemplo por caso (en proceso min 10 + captura 3 días después
- [ ] offline)
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D04); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D05] O-4: topología del E2E desde WhatsApp ((a) tienda aislada clonada, (b) E2E hasta la emisión, (c) esperar el camino productivo)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner + e-commerce (decisión)

**Entregable**

O-4: topología del E2E desde WhatsApp ((a) tienda aislada clonada, (b) E2E hasta la emisión, (c) esperar el camino productivo)

**Criterios de aceptación**

- [ ] Opción elegida y entorno nombrado fuera del repositorio público
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D05); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D06] O-8 / D-10: número de perfil y definición del carril de compra sobre el linaje vigente (`@22`)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner R4 (decisión)

**Entregable**

O-8 / D-10: número de perfil y definición del carril de compra sobre el linaje vigente (`@22`)

**Criterios de aceptación**

- [ ] Número y versión de definición reservados por escrito
- [ ] respetan los retiros y reservas previas
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D06); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D07] D7-6 / D-06: política FINANCIAL fuera de sandbox (ADR de autonomía con identidad `verified` y tope de importe, o aprobación humana)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner R4 (decisión)

**Entregable**

D7-6 / D-06: política FINANCIAL fuera de sandbox (ADR de autonomía con identidad `verified` y tope de importe, o aprobación humana)

**Criterios de aceptación**

- [ ] ADR o decisión escrita
- [ ] sin efecto hasta G3
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-C03 (para la opción a)

**¿Puede empezar ahora?** Sí (decisión)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D07); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D08] R4L-D1: tope de operaciones financieras por task en sandbox (2 hoy; 3 permite un relink)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner R4 (decisión)

**Entregable**

R4L-D1: tope de operaciones financieras por task en sandbox (2 hoy; 3 permite un relink)

**Criterios de aceptación**

- [ ] Valor escrito
- [ ] `CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK` y su prueba coinciden
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D08); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D09] O-1: nombre del incremento (evitar la colisión con F2 de J5)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner R4 (decisión)

**Entregable**

O-1: nombre del incremento (evitar la colisión con F2 de J5)

**Criterios de aceptación**

- [ ] Nombre registrado en el plan
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D09); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D10] OA-04 / D7 / J7: correos y datos reales para OTP e identidad

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner de datos (decisión)

**Entregable**

OA-04 / D7 / J7: correos y datos reales para OTP e identidad

**Criterios de aceptación**

- [ ] Decisión escrita con alcance (allowlist interna) y retención (DEP-10)
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí (decisión)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D10); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D11] FU-2 de O-5 (R4L-D2): un consentimiento por sesión con un acto por enlace, o uno por intento

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner R4 + owner Checkout (decisión)

**Entregable**

FU-2 de O-5 (R4L-D2): un consentimiento por sesión con un acto por enlace, o uno por intento

**Criterios de aceptación**

- [ ] Regla confirmada en el registro O-5 §4
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D11); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D12] FU-4 de O-5: texto legal que acepta el cliente y retención del consentimiento y del mensaje

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner comercial + legal (decisión)

**Entregable**

FU-4 de O-5: texto legal que acepta el cliente y retención del consentimiento y del mensaje

**Criterios de aceptación**

- [ ] Texto versionado y plazos de retención escritos
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí (no bloquea el sandbox)

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D12); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D13] FU-6 de O-5: ¿el primer E2E exige el texto determinista de compra (F2-R10) o basta la gramática cerrada?

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner R4 (decisión)

**Entregable**

FU-6 de O-5: ¿el primer E2E exige el texto determinista de compra (F2-R10) o basta la gramática cerrada?

**Criterios de aceptación**

- [ ] Decisión escrita
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D13); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-D14] FU-O6-3: ¿un E2E sandbox con retiro (`pickup-zero-v1`) antes del módulo? Opcional; no es parte de O-6

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner comercial (decisión)

**Entregable**

FU-O6-3: ¿un E2E sandbox con retiro (`pickup-zero-v1`) antes del módulo? Opcional; no es parte de O-6

**Criterios de aceptación**

- [ ] Sí/no escrito y transportista de retiro (O-10) si es sí
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí (opcional)

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D14); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-C01] Publicar el candidato H3 (rama local `docs/h3-purchase-authorization-candidate` @ `39342b2`) en el remoto CIA y abrir PR de revisión

**Repositorio / destino:** MS-pesaschile-customer-identity-authority · **Etiquetas:** `f2`, `cia`

**Dueño:** CIA

**Entregable**

Publicar el candidato H3 (rama local `docs/h3-purchase-authorization-candidate` @ `39342b2`) en el remoto CIA y abrir PR de revisión

**Criterios de aceptación**

- [ ] PR abierto en el repo CIA con el documento sin cambios
- [ ] revisores de CIA, Quote y Checkout
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C01); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-C02] Aceptación cruzada de H3, incluida X-1 (`azp`, OQ-H3-1), OQ-H3-2 y OQ-H3-10; §10 alineado con O-5 (Checkout emite desde el acto de R4)

**Repositorio / destino:** MS-pesaschile-customer-identity-authority · **Etiquetas:** `f2`, `cia`

**Dueño:** CIA + Quote + Checkout

**Entregable**

Aceptación cruzada de H3, incluida X-1 (`azp`, OQ-H3-1), OQ-H3-2 y OQ-H3-10; §10 alineado con O-5 (Checkout emite desde el acto de R4)

**Criterios de aceptación**

- [ ] H3 marcado ACEPTADO por los tres owners
- [ ] X-1 cerrado con un valor
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-C01, F2-Q01, F2-K07

**¿Puede empezar ahora?** No

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C02); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-C03] Propósito `purchase` y audiencia por propósito en modo sintético (C-CIA-1/-3; H3-D2/D3)

**Repositorio / destino:** MS-pesaschile-customer-identity-authority · **Etiquetas:** `f2`, `cia`

**Dueño:** CIA

**Entregable**

Propósito `purchase` y audiencia por propósito en modo sintético (C-CIA-1/-3; H3-D2/D3)

**Criterios de aceptación**

- [ ] `resolve(['purchase'])` para `r4-sales` → grant `aud=quote-cart-preparer`, `purposes=["purchase"]`
- [ ] mezcla de propósitos → 400 sin emitir
- [ ] suite existente (304 + 41) verde
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-C02

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C03); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-C04] FU-3 de O-5: frescura de la prueba OTP para `purchase` (OQ-H3-3)

**Repositorio / destino:** MS-pesaschile-customer-identity-authority · **Etiquetas:** `f2`, `cia`

**Dueño:** CIA + owner comercial (decisión)

**Entregable**

FU-3 de O-5: frescura de la prueba OTP para `purchase` (OQ-H3-3)

**Criterios de aceptación**

- [ ] Valor decidido (propuesta: misma conversación, ≤ 30 min) y prueba en la CIA
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí (decisión)

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C04); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-C05] Modo no sintético: claves en KMS (C-CIA-8, DEP-6), credencial (DEP-2), correo real (DEP-5), revocación (OD-CIA-4)

**Repositorio / destino:** MS-pesaschile-customer-identity-authority · **Etiquetas:** `f2`, `cia`

**Dueño:** CIA

**Entregable**

Modo no sintético: claves en KMS (C-CIA-8, DEP-6), credencial (DEP-2), correo real (DEP-5), revocación (OD-CIA-4)

**Criterios de aceptación**

- [ ] Instancia no productiva con el proveedor real de la tienda aislada
- [ ] G3 en entorno no productivo
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E01, F2-D10

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C05); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E01] Productor del proveedor de cuentas (DEP-3, `ACCOUNT_PROVIDER_V1_CONTRACT.md` de la CIA) en la tienda aislada

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Productor del proveedor de cuentas (DEP-3, `ACCOUNT_PROVIDER_V1_CONTRACT.md` de la CIA) en la tienda aislada

**Criterios de aceptación**

- [ ] El cliente remoto de la CIA pasa contra él (`find-by-email`, `revalidate`)
- [ ] respuestas cerradas por schema
- [ ] nunca `passwd`, `secure_key`, direcciones ni pedidos
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** Aceptación del contrato por e-commerce

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E01); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E02] Transportista de retiro a costo 0 (E-5 / O-10) en la tienda aislada, sólo si F2-D14 es sí

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Transportista de retiro a costo 0 (E-5 / O-10) en la tienda aislada, sólo si F2-D14 es sí

**Criterios de aceptación**

- [ ] Referencia documentada fuera del repo público
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D14

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E02); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E03] Endpoint gobernado `ps-cart-totals/v1` (E-3) en la tienda aislada, informando el despacho por el camino de la orden (O-6 M-5)

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Endpoint gobernado `ps-cart-totals/v1` (E-3) en la tienda aislada, informando el despacho por el camino de la orden (O-6 M-5)

**Criterios de aceptación**

- [ ] `parseCartTotals` de Quote lo acepta
- [ ] `calculationPath` = camino de la orden
- [ ] `totals.shipping` presente
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E03); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E04] Llaves Webservice dedicadas de mínimo privilegio para Quote y Checkout (E-6)

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Llaves Webservice dedicadas de mínimo privilegio para Quote y Checkout (E-6)

**Criterios de aceptación**

- [ ] Cada llave sólo tiene los recursos listados en el plan F0 §3
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E04); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E05] Lectura de direcciones existentes del cliente (E-7 / H2)

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce + Checkout

**Entregable**

Lectura de direcciones existentes del cliente (E-7 / H2)

**Criterios de aceptación**

- [ ] Checkout obtiene las direcciones del `sub` del grant en la tienda aislada
- [ ] ningún id de dirección llega a R4
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E04

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E05); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E06] FU-O6-2: inventario B2 (transportistas, rangos, reglas de envío gratis) y mapa versionado (transportista, servicio) → referencia de PrestaShop; códigos estables en pc-carrier

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce + Shipping

**Entregable**

FU-O6-2: inventario B2 (transportistas, rangos, reglas de envío gratis) y mapa versionado (transportista, servicio) → referencia de PrestaShop; códigos estables en pc-carrier

**Criterios de aceptación**

- [ ] Inventario y mapa versionados fuera del repo público
- [ ] pc-carrier devuelve códigos
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E06); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E07] FU-O6-1: **módulo de PrestaShop** que aplica las condiciones de despacho congeladas por Quote (O-6 §4, M-1..M-6): primero el diseño, luego el módulo en la tienda aislada

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce (+ Quote)

**Entregable**

FU-O6-1: **módulo de PrestaShop** que aplica las condiciones de despacho congeladas por Quote (O-6 §4, M-1..M-6): primero el diseño, luego el módulo en la tienda aislada

**Criterios de aceptación**

- [ ] Diseño aceptado por e-commerce y Quote
- [ ] en la tienda aislada, un carrito preparado por Quote cobra exactamente el despacho fijado
- [ ] nadie más puede fijarlo
- [ ] reglas de envío gratis no lo alteran
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E06 (mapa), F2-E04

**¿Puede empezar ahora?** Sí (diseño)

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Requisitos del módulo (O-6 §4)**

- **M-1** El módulo aplica, para un carrito preparado por Quote, el transportista y el costo de despacho que Quote fijó desde la cotización emitida (importe con impuesto incluido igual al congelado). No consulta pc-carrier ni recalcula
- **M-2** Sólo Quote puede fijar esas condiciones, con su llave dedicada (E-6), ligadas al `id_cart` que Quote creó; un carrito sin condiciones fijadas no usa el módulo
- **M-3** Ninguna regla de la tienda (envío gratis por monto, reglas de carrito automáticas, manejo) altera el resultado: si lo haría, `ps-cart-totals/v1` lo muestra y la paridad falla
- **M-4** El transportista se identifica por un código estable del mapa (transportista, servicio) → referencia de PrestaShop, versionado entre Shipping y e-commerce (F2-E06)
- **M-5** `ps-cart-totals/v1` informa el despacho calculado por el camino de la orden; Quote exige `shipping.taxIncl` = despacho congelado y `total.taxIncl` = `totals.gross`
- **M-6** La orden creada por Checkout conserva transportista y costo (la logística de la tienda opera sobre ella)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E07); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E08] Entorno para el E2E según O-4 (E-9)

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Entorno para el E2E según O-4 (E-9)

**Criterios de aceptación**

- [ ] Entorno disponible con ids de catálogo coherentes con Catalog V2
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D05

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E08); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-E09] FU-O6-5: medición en la tienda aislada: cotizaciones reales del carril reproducidas por el módulo con paridad exacta, sin cobrar

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce + Quote

**Entregable**

FU-O6-5: medición en la tienda aislada: cotizaciones reales del carril reproducidas por el módulo con paridad exacta, sin cobrar

**Criterios de aceptación**

- [ ] Informe fuera del repo público: N cotizaciones, 0 diferencias, incluida la banda de $1
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E07, F2-Q04

**¿Puede empezar ahora?** No

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E09); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K01] Remoto privado y CI (D-11) desde el respaldo verificado

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Remoto privado y CI (D-11) desde el respaldo verificado

**Criterios de aceptación**

- [ ] Remoto privado con las ramas `pay-*`
- [ ] CI corre unit + domain + contract en cada push
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** Permisos P-1..P-8

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K01); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K02] Corregir las dos guardas estáticas rotas desde `14335cb` (`scripts/sbx2/localStack.ts` importa código de prueba)

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Corregir las dos guardas estáticas rotas desde `14335cb` (`scripts/sbx2/localStack.ts` importa código de prueba)

**Criterios de aceptación**

- [ ] `u6SecurityClosure` C-1 y `pay04G1FinalAcceptanceUnit` SBX-1 en verde sin debilitar la regla
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K02); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K03] Comprador desde el grant CIA (R4L-D3): verificar `x-customer-access-grant`; comprador = `grant.sub`

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Comprador desde el grant CIA (R4L-D3): verificar `x-customer-access-grant`; comprador = `grant.sub`

**Criterios de aceptación**

- [ ] Pruebas con JWKS de la CIA sintética: sin grant → rechazo
- [ ] `sub` ≠ sujeto del acto → rechazo
- [ ] comprador registrado = `sub`
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-K01; formato de F2-C01

**¿Puede empezar ahora?** Sí (contra la CIA sintética)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K03); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K04] **O-5:** contrato de transmisión del acto (FU-1) y emisión de la evidencia de consentimiento por Checkout desde el acto que R4 transmite (`assurance = service_attested`, `consentId`)

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout (+ R4)

**Entregable**

**O-5:** contrato de transmisión del acto (FU-1) y emisión de la evidencia de consentimiento por Checkout desde el acto que R4 transmite (`assurance = service_attested`, `consentId`)

**Criterios de aceptación**

- [ ] Contrato escrito (sin texto ni PII)
- [ ] pruebas: acto de otra cotización/versión/importe → rechazo
- [ ] un acto por sesión (o por intento según F2-D11)
- [ ] acto sin grant válido → rechazo
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-K01, F2-K03, F2-D11

**¿Puede empezar ahora?** Sí (contrato)

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K04); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K05] Sonda C1 como prueba de caracterización (en proceso al minuto 10, captura 3 días después)

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Sonda C1 como prueba de caracterización (en proceso al minuto 10, captura 3 días después)

**Criterios de aceptación**

- [ ] La prueba existe y documenta el comportamiento actual
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K05); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K06] Corrección C1 según O-7

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Corrección C1 según O-7

**Criterios de aceptación**

- [ ] Sonda C1 con el resultado decidido
- [ ] LATE-A/B/C sin cambios
- [ ] revisión independiente
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D04, F2-K05

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K06); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K07] Publicar y aceptar `/v1 1.0.4-proposed` (G0) junto con H3 y A7, incluyendo la transmisión del acto (F2-K04)

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Publicar y aceptar `/v1 1.0.4-proposed` (G0) junto con H3 y A7, incluyendo la transmisión del acto (F2-K04)

**Criterios de aceptación**

- [ ] Contrato publicado en el remoto
- [ ] estado ACEPTADO
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-K01, F2-C01

**¿Puede empezar ahora?** Sí (publicar)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K07); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K08] **O-6:** dirección coherente con la comuna cotizada y paridad de importe en sesión, enlace y conciliación; mapear los motivos `NOT_READY` nuevos

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

**O-6:** dirección coherente con la comuna cotizada y paridad de importe en sesión, enlace y conciliación; mapear los motivos `NOT_READY` nuevos

**Criterios de aceptación**

- [ ] Pruebas: dirección fuera de la comuna → no `READY`
- [ ] importe distinto → sin enlace
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E05, FU-O6-4 (origen de la dirección)

**¿Puede empezar ahora?** No

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K08); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K09] OD-06 / D-07: evidencia del vencimiento efectivo del enlace en el proveedor

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

OD-06 / D-07: evidencia del vencimiento efectivo del enlace en el proveedor

**Criterios de aceptación**

- [ ] Observación con Mercado Pago de prueba registrada
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** E-S1 nueva

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K09); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-K10] FU-5 de O-5: cancelación de sesión antes del pago (revocación)

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

FU-5 de O-5: cancelación de sesión antes del pago (revocación)

**Criterios de aceptación**

- [ ] Ruta documentada en `/v1`
- [ ] prueba: sesión cancelada → sin enlace
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-K01

**¿Puede empezar ahora?** Sí

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K10); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-Q01] Publicar A7 §12 (rama local `docs/a7-f0-review`) para revisión cruzada con H3

**Repositorio / destino:** MS-pesaschile-quote-service · **Etiquetas:** `f2`, `quote`

**Dueño:** Quote

**Entregable**

Publicar A7 §12 (rama local `docs/a7-f0-review`) para revisión cruzada con H3

**Criterios de aceptación**

- [ ] PR en el repo Quote
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q01); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-Q02] Verificador del grant de producción: `azp` según X-1, exactamente `["purchase"]`, claims `bv` y `amount`, consumo del `jti`, sin `details.code` público

**Repositorio / destino:** MS-pesaschile-quote-service · **Etiquetas:** `f2`, `quote`

**Dueño:** Quote

**Entregable**

Verificador del grant de producción: `azp` según X-1, exactamente `["purchase"]`, claims `bv` y `amount`, consumo del `jti`, sin `details.code` público

**Criterios de aceptación**

- [ ] Pruebas por regla en la suite de Quote
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-C02

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q02); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-Q03] Ensayo local de H3 `verify` (fuera de `NODE_ENV=production`) en la tienda aislada con grant de la CIA sintética o el emisor de prueba de Checkout

**Repositorio / destino:** MS-pesaschile-quote-service · **Etiquetas:** `f2`, `quote`

**Dueño:** Quote

**Entregable**

Ensayo local de H3 `verify` (fuera de `NODE_ENV=production`) en la tienda aislada con grant de la CIA sintética o el emisor de prueba de Checkout

**Criterios de aceptación**

- [ ] Un `POST carts`, carrito `READY` con paridad
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E03 o paridad sintética

**¿Puede empezar ahora?** Sí (con el emisor de prueba)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q03); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-Q04] **O-6:** quitar el bloqueo H1 para el módulo: fijar transportista desde el código, escribir las condiciones congeladas para el `id_cart`, verificar la paridad del despacho; motivos `NOT_READY` tipados

**Repositorio / destino:** MS-pesaschile-quote-service · **Etiquetas:** `f2`, `quote`

**Dueño:** Quote

**Entregable**

**O-6:** quitar el bloqueo H1 para el módulo: fijar transportista desde el código, escribir las condiciones congeladas para el `id_cart`, verificar la paridad del despacho; motivos `NOT_READY` tipados

**Criterios de aceptación**

- [ ] Carrito con despacho `READY` sólo con paridad de despacho y total
- [ ] cada desajuste → motivo tipado
- [ ] sin recálculo
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E07 (diseño), F2-E06

**¿Puede empezar ahora?** No

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Requisitos del módulo (O-6 §4)**

- **M-1** El módulo aplica, para un carrito preparado por Quote, el transportista y el costo de despacho que Quote fijó desde la cotización emitida (importe con impuesto incluido igual al congelado). No consulta pc-carrier ni recalcula
- **M-2** Sólo Quote puede fijar esas condiciones, con su llave dedicada (E-6), ligadas al `id_cart` que Quote creó; un carrito sin condiciones fijadas no usa el módulo
- **M-3** Ninguna regla de la tienda (envío gratis por monto, reglas de carrito automáticas, manejo) altera el resultado: si lo haría, `ps-cart-totals/v1` lo muestra y la paridad falla
- **M-4** El transportista se identifica por un código estable del mapa (transportista, servicio) → referencia de PrestaShop, versionado entre Shipping y e-commerce (F2-E06)
- **M-5** `ps-cart-totals/v1` informa el despacho calculado por el camino de la orden; Quote exige `shipping.taxIncl` = despacho congelado y `total.taxIncl` = `totals.gross`
- **M-6** La orden creada por Checkout conserva transportista y costo (la logística de la tienda opera sobre ella)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q04); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R01] Evidencia determinista del acto de compra

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Evidencia determinista del acto de compra

**Criterios de aceptación**

- [ ] `purchase-act.ts`, unit 7/7
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Hecho

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R01); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R02] Persistir el acto (Sales `0012`, append-only, `request_input_id` único) en `checkout.start_purchase@1`, detrás de `purchaseActRecording` (apagado)

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Persistir el acto (Sales `0012`, append-only, `request_input_id` único) en `checkout.start_purchase@1`, detrás de `purchaseActRecording` (apagado)

**Criterios de aceptación**

- [ ] Integration 4/4: apagado = sin registro
- [ ] encendido = un registro, réplica idempotente, un mensaje = un inicio, fila inmutable
- [ ] tripwire: ningún perfil, composición ni app lo enciende
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Hecho (este PR)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R02); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R03] Cabecera `x-customer-access-grant` en el adaptador Checkout (opcional en el puerto); ningún código de R4 la provee aún

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Cabecera `x-customer-access-grant` en el adaptador Checkout (opcional en el puerto); ningún código de R4 la provee aún

**Criterios de aceptación**

- [ ] Unit 3/3: sólo en la cabecera, nunca en el cuerpo ni la telemetría
- [ ] ausente = petición de hoy
- [ ] un grant que no es JWS compacto se rechaza sin enviar
- [ ] tripwire: nadie en `agents/` o `apps/` la provee
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** Contrato `/v1 1.0.4-proposed` (F2-K07) para cerrar

**¿Puede empezar ahora?** Hecho (este PR)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R03); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R04] Propósito `purchase` en el cliente CIA y `resolve` determinista dentro de `checkout.start_purchase`; el grant pasa a F2-R03

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Propósito `purchase` en el cliente CIA y `resolve` determinista dentro de `checkout.start_purchase`; el grant pasa a F2-R03

**Criterios de aceptación**

- [ ] Unit + interop contra la CIA sintética con `purchase`
- [ ] tripwires F2-R03/F2-R04 actualizados
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-C03

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R04); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R05] Perfil de carril de compra (inactivo) sobre el linaje vigente, con identidad + Checkout + acto

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Perfil de carril de compra (inactivo) sobre el linaje vigente, con identidad + Checkout + acto

**Criterios de aceptación**

- [ ] Contrato del perfil
- [ ] L2 completo
- [ ] no registrado en producción
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D06, F2-R04, F2-R11

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R05); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R06] Enviar `carrier.code` y `serviceType.code` a Quote (O-6 M-4)

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Enviar `carrier.code` y `serviceType.code` a Quote (O-6 M-4)

**Criterios de aceptación**

- [ ] Contract: el cuerpo congelado lleva los códigos del mapa
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E06

**¿Puede empezar ahora?** No

**Decisión aplicable:** O-6 aprobada (opción C: módulo de PrestaShop; requisitos M-1..M-6 del registro O-6 §4)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R06); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R07] Mapear motivos `NOT_READY` de paridad/despacho/destino a «cotización nueva para aceptar» o derivación (nunca enlace)

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Mapear motivos `NOT_READY` de paridad/despacho/destino a «cotización nueva para aceptar» o derivación (nunca enlace)

**Criterios de aceptación**

- [ ] Unit por motivo
- [ ] motivo desconocido → derivación
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-Q04, F2-K08

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R07); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R08] Extender el evaluador de afirmaciones de pago (R-6): el modelo no afirma «pagado», URL ni importe sin `purchase_status`

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Extender el evaluador de afirmaciones de pago (R-6): el modelo no afirma «pagado», URL ni importe sin `purchase_status`

**Criterios de aceptación**

- [ ] Casos de evaluación negativos y positivos en verde
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R08); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R09] E2E sandbox desde WhatsApp (S8 del plan)

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

E2E sandbox desde WhatsApp (S8 del plan)

**Criterios de aceptación**

- [ ] R4-CK-01..12 reales
- [ ] L3 + F-1..F-7 en PASS
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D05, F2-D13, F2-R05, F2-K03/K04, F2-Q03, E-S1 nueva

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R09); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R10] Texto determinista de la oferta de compra generado desde Quote (aviso de plataforma) y exigido por el acto

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Texto determinista de la oferta de compra generado desde Quote (aviso de plataforma) y exigido por el acto

**Criterios de aceptación**

- [ ] Unit: el acto exige el aviso inmediatamente anterior con número y total de la cotización
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D13

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R10); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
---

## [F2-R11] **O-5:** transmitir el acto registrado (`0012`) a Checkout según el contrato de F2-K04

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

**O-5:** transmitir el acto registrado (`0012`) a Checkout según el contrato de F2-K04

**Criterios de aceptación**

- [ ] Unit/contract contra el contrato: sin texto ni PII
- [ ] mismo acto en réplicas
- [ ] tripwire sin perfiles
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-K04, F2-K07

**¿Puede empezar ahora?** No

**Decisión aplicable:** O-5 aprobada (opción D: Checkout emite la evidencia de consentimiento desde el acto que R4 registra y transmite)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R11); estado en `R4_CHECKOUT_STATUS_2026-11.md`.
