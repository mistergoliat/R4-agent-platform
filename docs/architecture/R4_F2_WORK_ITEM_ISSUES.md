---
title: R4 F2 — Cuerpos de issue por item de trabajo (listos para pegar)
status: BORRADOR — no se creó ningún issue; generado desde la tabla de R4_F2_WORK_ITEMS.md §1
date: 2026-11-18
---

# F2 — Borradores de issues

Uno por item de R4_F2_WORK_ITEMS.md (`docs/architecture/R4_F2_WORK_ITEMS.md`). Título sugerido = `[F2-xxx] <entregable>`. Etiquetas sugeridas: `f2` + el área. Sin datos productivos: los valores de tienda, hosts y credenciales van fuera de los repositorios públicos.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D01); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-D02] Decisión O-5 y R4L-D2 sobre el registro O-5 (`docs/architecture/R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md`)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner + Checkout + CIA (decisión)

**Entregable**

Decisión O-5 y R4L-D2 sobre el registro O-5 (`docs/architecture/R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md`)

**Criterios de aceptación**

- [ ] El registro pasa a DECIDIDO con respuesta a Q1..Q6
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D02); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-D03] Decisión O-6 sobre el registro O-6 (`docs/architecture/R4_F2_O6_DELIVERY_CART_DECISION.md`)

**Repositorio / destino:** R4-agent-platform (decisión del owner; issue de seguimiento) · **Etiquetas:** `f2`, `decision`

**Dueño:** Owner comercial + e-commerce (decisión)

**Entregable**

Decisión O-6 sobre el registro O-6 (`docs/architecture/R4_F2_O6_DELIVERY_CART_DECISION.md`)

**Criterios de aceptación**

- [ ] El registro pasa a DECIDIDO con opción elegida y respuestas Q1..Q5
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D03); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D04); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D05); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D06); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D07); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D08); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D09); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-D10); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C01); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-C02] Aceptación cruzada de H3, incluida X-1 (`azp`, OQ-H3-1), OQ-H3-2 y OQ-H3-10

**Repositorio / destino:** MS-pesaschile-customer-identity-authority · **Etiquetas:** `f2`, `cia`

**Dueño:** CIA + Quote + Checkout

**Entregable**

Aceptación cruzada de H3, incluida X-1 (`azp`, OQ-H3-1), OQ-H3-2 y OQ-H3-10

**Criterios de aceptación**

- [ ] H3 marcado ACEPTADO por los tres owners
- [ ] X-1 cerrado con un valor
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-C01, F2-Q01, F2-K07

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C02); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C03); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-C04] Frescura de la prueba OTP para `purchase` (OQ-H3-3)

**Repositorio / destino:** MS-pesaschile-customer-identity-authority · **Etiquetas:** `f2`, `cia`

**Dueño:** CIA + owner comercial (decisión)

**Entregable**

Frescura de la prueba OTP para `purchase` (OQ-H3-3)

**Criterios de aceptación**

- [ ] Valor decidido (propuesta: misma conversación, ≤ 30 min) y prueba en la CIA
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí (decisión)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C04); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-C05); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E01); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-E02] Designar el transportista de retiro a costo 0 (E-5 / O-10) en la tienda aislada

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Designar el transportista de retiro a costo 0 (E-5 / O-10) en la tienda aislada

**Criterios de aceptación**

- [ ] Referencia documentada fuera del repo público
- [ ] Quote arranca con `QUOTE_CART_PICKUP_CARRIER_REFERENCE`
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E02); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-E03] Endpoint gobernado `ps-cart-totals/v1` (E-3) en la tienda aislada

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Endpoint gobernado `ps-cart-totals/v1` (E-3) en la tienda aislada

**Criterios de aceptación**

- [ ] `parseCartTotals` de Quote lo acepta
- [ ] `calculationPath` = camino de la orden
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E03); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E04); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E05); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-E06] Inventario B2 (transportistas, rangos, reglas de envío gratis) y mapa estable (transportista, servicio) → referencia de PrestaShop; códigos estables en pc-carrier

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce + Shipping

**Entregable**

Inventario B2 (transportistas, rangos, reglas de envío gratis) y mapa estable (transportista, servicio) → referencia de PrestaShop; códigos estables en pc-carrier

**Criterios de aceptación**

- [ ] Inventario y mapa versionados fuera del repo público
- [ ] pc-carrier devuelve códigos
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E06); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-E07] Módulo de transportista con costo congelado (opción C de O-6)

**Repositorio / destino:** owner e-commerce (fuera de los repos de servicios) · **Etiquetas:** `f2`, `ecommerce`

**Dueño:** e-commerce

**Entregable**

Módulo de transportista con costo congelado (opción C de O-6)

**Criterios de aceptación**

- [ ] En la tienda aislada, un carrito preparado por Quote cobra exactamente el despacho escrito por Quote
- [ ] nadie más puede escribirlo
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D03 (= C), F2-E06

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E07); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-E08); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K01); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K02); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-K03] Comprador desde el grant CIA (R4L-D3): verificar `x-customer-access-grant`; comprador = `grant.sub`; el consentimiento sólo prueba el acto

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Comprador desde el grant CIA (R4L-D3): verificar `x-customer-access-grant`; comprador = `grant.sub`; el consentimiento sólo prueba el acto

**Criterios de aceptación**

- [ ] Pruebas con JWKS de la CIA sintética: sin grant → rechazo
- [ ] `sub` ≠ sujeto del acto → rechazo
- [ ] comprador registrado = `sub`
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-K01; formato de F2-C01

**¿Puede empezar ahora?** Sí (contra la CIA sintética)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K03); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-K04] Consentimiento según O-5: emisión y registro por Checkout desde la evidencia del acto; audiencia; cancelación de sesión

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Consentimiento según O-5: emisión y registro por Checkout desde la evidencia del acto; audiencia; cancelación de sesión

**Criterios de aceptación**

- [ ] Pruebas: acto de otra cotización/versión/importe → rechazo
- [ ] un acto por sesión
- [ ] cancelación antes del pago
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D02

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K04); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-K05] Sonda C1 como prueba de caracterización (en proceso al minuto 10, captura 3 días después)

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Sonda C1 como prueba de caracterización (en proceso al minuto 10, captura 3 días después)

**Criterios de aceptación**

- [ ] La prueba existe y documenta el comportamiento actual
- [ ] se marcará como regresión cuando llegue F2-K06
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Sí

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K05); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K06); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-K07] Publicar y aceptar `/v1 1.0.4-proposed` (G0) junto con H3 y A7

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Publicar y aceptar `/v1 1.0.4-proposed` (G0) junto con H3 y A7

**Criterios de aceptación**

- [ ] Contrato publicado en el remoto
- [ ] estado ACEPTADO
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-K01, F2-C01

**¿Puede empezar ahora?** Sí (publicar)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K07); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-K08] Coherencia de dirección con la comuna cotizada y paridad de importe en sesión y enlace (O-6)

**Repositorio / destino:** MS-pesaschile-checkout (sin remoto: abrir cuando exista, F2-K01) · **Etiquetas:** `f2`, `checkout`

**Dueño:** Checkout

**Entregable**

Coherencia de dirección con la comuna cotizada y paridad de importe en sesión y enlace (O-6)

**Criterios de aceptación**

- [ ] Pruebas: dirección fuera de la comuna → no `READY`
- [ ] importe distinto → sin enlace
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D03, F2-E05

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K08); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-K09); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q01); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q02); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-Q03] Ensayo local de H3 `verify` (fuera de `NODE_ENV=production`) en la tienda aislada con grant de la CIA sintética o el emisor de prueba de Checkout

**Repositorio / destino:** MS-pesaschile-quote-service · **Etiquetas:** `f2`, `quote`

**Dueño:** Quote

**Entregable**

Ensayo local de H3 `verify` (fuera de `NODE_ENV=production`) en la tienda aislada con grant de la CIA sintética o el emisor de prueba de Checkout

**Criterios de aceptación**

- [ ] Un `POST carts`, carrito `READY` con paridad, retiro a costo 0
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E02; F2-E03 o paridad sintética

**¿Puede empezar ahora?** Sí (con el emisor de prueba)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q03); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-Q04] Representar el despacho según O-6 (quitar H1 para el método elegido; motivos `NOT_READY` tipados nuevos)

**Repositorio / destino:** MS-pesaschile-quote-service · **Etiquetas:** `f2`, `quote`

**Dueño:** Quote

**Entregable**

Representar el despacho según O-6 (quitar H1 para el método elegido; motivos `NOT_READY` tipados nuevos)

**Criterios de aceptación**

- [ ] Carrito con despacho `READY` sólo con paridad de despacho y total
- [ ] cada desajuste → motivo tipado
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D03, F2-E06 (+ E07 si C)

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-Q04); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-R01] Evidencia determinista del acto de compra (sin conectar)

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Evidencia determinista del acto de compra (sin conectar)

**Criterios de aceptación**

- [ ] **Hecho en este PR**: `purchase-act.ts`, unit 7/7, tripwire de contrato
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** —

**¿Puede empezar ahora?** Hecho

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R01); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-R02] Persistir el acto (migración Sales append-only, `request_input_id` único) en la transacción de `recordCheckoutPurchaseRequest`

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Persistir el acto (migración Sales append-only, `request_input_id` único) en la transacción de `recordCheckoutPurchaseRequest`

**Criterios de aceptación**

- [ ] Integración: un acto por input
- [ ] inmutable
- [ ] sin texto ni `customerRef`
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D02; autorización de la migración

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R02); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-R03] Transporte del grant en `x-customer-access-grant` en el adaptador Checkout, sin conectar a ningún perfil

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Transporte del grant en `x-customer-access-grant` en el adaptador Checkout, sin conectar a ningún perfil

**Criterios de aceptación**

- [ ] Unit/contract: la cabecera se envía
- [ ] el grant nunca aparece en salidas al modelo, logs, recibos ni el cuerpo congelado
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** Contrato `/v1 1.0.4-proposed` (F2-K07)

**¿Puede empezar ahora?** Sí (contra el candidato)

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R03); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-R04] Propósito `purchase` en el cliente CIA y `resolve` determinista dentro de `checkout.start_purchase`

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Propósito `purchase` en el cliente CIA y `resolve` determinista dentro de `checkout.start_purchase`

**Criterios de aceptación**

- [ ] Unit + interop contra la CIA sintética con `purchase`
- [ ] tripwire F2-R04 actualizado
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-C03

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R04); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-R05] Perfil de carril de compra (inactivo) sobre el linaje vigente, con identidad + Checkout

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Perfil de carril de compra (inactivo) sobre el linaje vigente, con identidad + Checkout

**Criterios de aceptación**

- [ ] Contrato del perfil
- [ ] L2 completo
- [ ] no registrado en producción
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D06, F2-R02, F2-R03, F2-R04

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R05); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-R06] Enviar `carrier.code` y `serviceType.code` a Quote (CART-00 M8)

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Enviar `carrier.code` y `serviceType.code` a Quote (CART-00 M8)

**Criterios de aceptación**

- [ ] Contract: el cuerpo congelado lleva los códigos del mapa
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-E06

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R06); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R07); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R08); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

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

**Depende de:** F2-D05, F2-R05, F2-K03/K04, F2-Q03, E-S1 nueva

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R09); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.

---

## [F2-R10] Texto determinista de la oferta de compra generado desde Quote (aviso de plataforma) y exigido por el acto

**Repositorio / destino:** R4-agent-platform · **Etiquetas:** `f2`, `r4`

**Dueño:** R4

**Entregable**

Texto determinista de la oferta de compra generado desde Quote (aviso de plataforma) y exigido por el acto

**Criterios de aceptación**

- [ ] Unit: el acto exige el aviso inmediatamente anterior con número y total de la cotización
- [ ] Sin pagos, órdenes, carritos ni Checkout productivos; sin datos productivos en repositorios públicos

**Depende de:** F2-D02

**¿Puede empezar ahora?** No

**Contexto:** R4 `docs/architecture/R4_F2_WORK_ITEMS.md` (F2-R10); estado en `R4_CHECKOUT_STATUS_2026-11.md`; decisiones en `R4_F2_O5_PURCHASE_IDENTITY_CONSENT_DECISION.md` y `R4_F2_O6_DELIVERY_CART_DECISION.md`.
