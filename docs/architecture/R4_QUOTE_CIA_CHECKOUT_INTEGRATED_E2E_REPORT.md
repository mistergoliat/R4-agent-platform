---
title: R4 — Quote V2 + CIA + Checkout, E2E integrado
status: R4_QUOTE_CHECKOUT_SANDBOX_E2E_AUTHORIZATION_PENDING
mandate: «R4 — Quote V2 + CIA + Checkout: Integrated E2E» (owner, 2026-11-08)
date: 2026-11-08
r4: PR #55 (feat/r4-quote-checkout-e2e), sin merge
previous: R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md §10
---

# R4 — Quote V2 + CIA + Checkout, E2E integrado

## 0. Resultado

| # | Entregable | Estado |
|---|---|---|
| 1 | Revisión independiente de AD-5 | **`CHECKOUT_AD5_REVIEW_PASS`**, con tres observaciones para el owner (§1) |
| 2 | E-S1 | Preparada y **sin firmar**. Credencial verificada por huella, **sin** llamadas al proveedor (§2) |
| 3 | E3-A real | **NOT_RUN**: espera la E-S1 firmada, el grant, el pagador y la ventana (§3) |
| 4 | Matriz de identidad CIA | §4 |
| 5 | Preparación de E3-B desde WhatsApp | **BLOQUEADA por topología** (§5): Catalog V2 productivo y la PrestaShop aislada no comparten identificadores |
| 6 | Bloqueos restantes | §6 |
| 7 | Plan de activación por SHA | §7 |

**No se hizo:** merge, despliegue, activación de `@14`/`@15`, cambios en `@13`, en Catalog V2, en producción o en el kernel, operaciones financieras, órdenes ni llamadas autenticadas a Mercado Pago.

## 1. Revisión independiente de AD-5 (Checkout `3d7b23d`)

La hizo un revisor sin contexto de la implementación. Leyó el commit y el código alrededor, corrió las pruebas, escribió sondas propias fuera del repositorio y consultó la documentación pública de la API de órdenes de Mercado Pago.

| # | Punto | Resultado |
|---|---|---|
| 1 | Semántica de los timestamps de Mercado Pago | **CONCERN.** Verificado en la documentación: `last_updated_date` es «última actualización de la orden» y no hay hora de inicio del pago a nivel de orden. Inferido: en la primera vista en proceso sólo puede **atrasar** el inicio, que es la dirección segura. La evidencia es de la orden, no de la transacción acreditada (C1) |
| 2 | Persistencia inmutable de la primera evidencia | PASS: trigger `CK023`, incluso contra volver a NULL; el valor guardado siempre prevalece; la fila se bloquea con verificación de versión |
| 3 | Inicio, acreditación y observación separados | PASS: el inicio sale sólo de una vista en proceso; el reloj de Checkout sólo va a la auditoría |
| 4 | Inicio posterior al vencimiento rechazado | PASS |
| 5 | Inicio desconocido | PASS (`ACTION_REQUIRED`) |
| 6 | CT-11 | PASS: completa, como corresponde |
| 7 | Idempotencia y webhooks duplicados | PASS: misma vista dos veces, vistas viejas (`STALE`) y retrocesos (`IGNORED`); sonda con 3 entregas concurrentes → 1 caso, 0 órdenes |
| 8 | Recuperación y conciliación | PASS: `EXPIRE_ATTEMPT`, `RECONCILE_ATTEMPT`, `RESOLVE_PROVIDER_EVENT`, revalidación y finalize pasan por la regla; `storedPaymentProblem` bloquea la orden; `sandbox-purchase` hereda la regla |
| 9 | Sin órdenes automáticas sin evidencia | PASS: toda primera confirmación pasa por `CAPTURED`; tolerancia hacia lo estricto |

Además:

- El cambio de expectativa en `pay03r1` es **legítimo**: el pago llega justo en el vencimiento, sin vista en proceso anterior.
- Las dos guardias que fallan **ya fallaban en `d11e3c7`**, reproducido en un worktree limpio. Marcan `scripts/sbx2/localStack.ts`, agregado en `14335cb`, y no tienen relación con AD-5.

**Observaciones (deciden el owner y el owner de Checkout):**

- **C1 (media).** La evidencia de inicio es la primera vista de la *orden* en proceso, sin tope de tiempo.
  - Con `waiting_retry` (cobro fallido y reintento) o pagos offline (`waiting_payment`/`waiting_transfer`), la transacción acreditada puede iniciarse mucho después del vencimiento y aun así crear la orden. Sonda: en proceso en el minuto 10, capturado 3 días después → orden.
  - Cumple la letra de AD-5 («iniciado antes»), pero el owner debe decidir si un reintento o un pago offline cuentan como «iniciado».
  - Mitigación posible: ligar la evidencia al pago acreditado (`date_created` de `/v1/payments`, o id e intento), o poner un tope de demora.
  - **No bloquea el E3-A** con tarjeta de prueba. **Sí debe resolverse antes de producción.**
- **C2 (baja, dirección segura).** Una captura hecha a tiempo pero vista después de otra actualización posterior queda retenida.
- **C3 (baja).** Se compara el reloj de Mercado Pago con el `expiresAt` de Checkout. Un desfase mayor que la tolerancia de 5 s podría aceptar un inicio levemente posterior.

Lo verificado: typecheck; 38/38 en los archivos afectados; regresión completa con 1559 pruebas aprobadas y las 2 fallas preexistentes; 5 sondas propias.

## 2. Autorización sandbox

| Ítem | Estado |
|---|---|
| E-S1 de SBX-2 | Cerrada; no se reutiliza |
| Nueva E-S1 `R4_QUOTE_CHECKOUT_E2E_SANDBOX` (2.500 CLP, 1 intento, 60 min, sólo Mercado Pago de prueba y PrestaShop aislada, sin órdenes ni cobros productivos) | Preparada con el procedimiento vigente (E1–E9, X1–X6). **Sin firmar.** E4 (1.000 → 2.500) requiere aprobación expresa |
| Huella de la credencial | **Coincide** con la documentada. Se calculó en la EC2 sobre el archivo del operador, sin imprimir el token y sin llamadas al proveedor; los identificadores de aplicación y usuario embebidos en el token también coinciden. El prefijo del token es el mismo para credenciales de prueba y productivas, así que esto **no** prueba el entorno |
| Entorno sandbox efectivo | Pendiente: `/users/me` y el preflight de Checkout son llamadas autenticadas y van después de la firma |

## 3. E3-A: integración transaccional real

**NOT_RUN.** Para ejecutarlo, en orden:

1. E-S1 firmada.
2. Imagen de Checkout `3d7b23d` construida en la EC2 (AD-5 ya revisado).
3. Ensamblado de la credencial con la huella aprobada y arranque con credencial `VERIFIED`.
4. Preflight PASS.
5. Grant de 2.500 CLP con 1 intento.
6. Pagador disponible.

Lo que ya se ensayó en local (informe anterior §10.4):

- R4 emite por su adaptador Quote V2 real.
- Quote persiste la cotización.
- El consentimiento lo firma la herramienta de Checkout y lo verifica la clave de la EC2.

Los puntos 3–12 del mandato (carrito, sesión, link, pago, webhook, conciliación, orden única, idempotencia y recuperación) sólo pueden ejecutarse con el runtime real.

## 4. Matriz de identidad CIA

| Paso | R4 | CIA | Customer Profile | Quote | Checkout |
|---|---|---|---|---|---|
| Identificación por WhatsApp | IMPL sintético (`@8`): binding del canal → contexto firmado por el proveedor; verificación OTP por e-mail; sin `customerRef` durable | IMPL sintético: verificaciones, `sbh` | — | — | FALTA: no recibe contexto de canal |
| Identidad y grant CIA | IMPL sintético: resolución por llamada, en memoria. Propósitos `sales_context` y `purchase_history`; **no existe `purchase`**. `@15` no compone identidad | IMPL sintético para `customer-profile`; `purchase` sólo DISEÑADO (H3, C-CIA-1..8) | IMPL: verificador con `aud=customer-profile` | IMPL en `a79d33f`: verificación del grant y del binding, modo `verify` (rechazado en producción) | FALTA: ni cabecera ni verificador de grant |
| Cliente y direcciones PrestaShop | Nunca maneja ids | Cliente: contrato del proveedor DISEÑADO, sólo un doble; productor real FALTA (DEP-3) | Sin direcciones | Verifica elegibilidad | Direcciones FALTAN (H2); sólo el comprador de prueba configurado |
| Carrito ligado a la identidad | No envía comprador | — | — | IMPL: cliente y direcciones salen de claims firmados | Firmante del binding sólo de prueba |
| Consentimiento y comprador | Consentimiento sandbox desde archivos del operador; consentimiento real FALTA | — | — | — | Comprador = sujeto del consentimiento; verificador y autorización sólo de prueba; `realConsentApproved=false` |

**Identificación ≠ consentimiento.**

- H3 los separa: el grant prueba *quién*, el consentimiento prueba *la aceptación*, y el grant va en su propia cabecera.
- **El contrato y el código actuales de Checkout los mezclan**: el comprador sale del sujeto del consentimiento. Para producción hay que separarlos: comprador = `sub` del grant; el consentimiento prueba sólo el acto.

**Cambios mínimos para un grant de compra productivo** (el CIA sigue siendo el único emisor):

- **CIA:**
  - C-CIA-1 (audiencia por propósito), -2, -3 (`purchase` para `r4-sales`), -5, -6, -7 y -8 (claves KMS);
  - un modo no sintético;
  - el productor de la tienda (DEP-3).
- **R4:**
  - el propósito `purchase`;
  - `identity.resolve(['purchase'])` determinista dentro de `checkout.start_purchase`;
  - el grant en su propia cabecera en `createSession`;
  - componer identidad en el carril de Checkout;
  - reemplazar `SandboxConsentDirectory` por la captura determinista del acto de compra desde un evento firmado del canal.
- **Checkout:**
  - verificador del grant como `BuyerAuthorization` real (puerto del de Customer Profile);
  - comprador desde `grant.sub`;
  - verificador de consentimiento real;
  - firmante productivo del binding;
  - fuente de direcciones (H2);
  - autenticación del principal `r4-sales`.
- **Quote:**
  - `azp=r4-sales` (hoy el valor por defecto es `checkout`);
  - exigir exactamente `["purchase"]` (hoy basta con contenerlo);
  - claims `bv` y `amount`;
  - consumir el `jti` en la misma transacción y al final;
  - no exponer `details.code`;
  - permitir `verify` en producción tras la aceptación.
- **Customer Profile:** ninguno.

**Contradicciones detectadas:**

- `azp`: H3 dice `r4-sales`; Quote y el emisor de prueba usan `checkout`.
- Orden de verificación del binding en Quote frente a H3 §8.
- Forma del grant de prueba (`amr`, `sbh`) fuera del esquema CIA.
- Los `main` locales de CIA y Quote están atrás de `origin`.

## 5. E3-B desde WhatsApp: preparación y bloqueo

**Bloqueo de topología (sin operaciones financieras):**

- Catalog V2 entrega como `productId` el `id_product` de la PrestaShop **productiva**.
- Quote prepara el carrito usando ese mismo número como `id_product` en la tienda destino (`line-representation.ts`).
- La PrestaShop aislada tiene su propia numeración: 38 productos, de los cuales 1–19 son demos de PrestaShop, 20–24 productos de prueba y 25–38 réplicas QA de productos reales (copiadas el 2026-10-28, con otros ids).
- Por eso, un producto encontrado por la búsqueda real caería en otro producto, o en ninguno, de la tienda aislada.

Puentearlo exigiría remapear identificadores, precios o stock artificialmente, y el mandato lo prohíbe. **No existe hoy una topología con aislamiento suficiente para E3-B.** Las opciones requieren decisión:

- **(a)** Una PrestaShop aislada clonada de la productiva (mismos ids y precios) con su propia generación de Catalog V2. Infraestructura nueva.
- **(b)** Ejecutar E3-B sólo hasta la emisión de Quote (Catalog real, Discover, Shipping, oferta y confirmación) y dejar el carrito y el pago en E3-A.
- **(c)** Esperar al camino productivo (CIA `purchase`, H3, AD-5 con C1 resuelto, F-1..F-7).

| # | Verificación de E3-B | Componente | Estado |
|---|---|---|---|
| 1 | Búsqueda real de productos | `catalog.search` / `catalog.discover` (Catalog V2) | Existente en `@13`/`@14`/`@15` |
| 2 | Selección de SKU | `catalog.get_product_context` | Existente |
| 3 | Precio y stock | Catalog V2 (verdad comercial) | Existente; P-1 pendiente |
| 4 | Identidad | CIA | **No compuesta en `@15`** (§4) |
| 5 | Oferta | `quote.preview@3`, oferta renderizada por Sales | Existente |
| 6 | Confirmación explícita | `quote.create@5` (gramática y oferta byte a byte) | Existente |
| 7 | Emisión en Quote | `quote.create@5` | Existente; R1.7 y lockstep A10 pendientes |
| 8 | Preparación del carrito | Checkout → Quote (H3) | Sólo aislada y de prueba; **incompatible con Catalog productivo** |
| 9 | Solicitud del link | `checkout.request_payment_link@1` | Existente (sandbox) |
| 10 | Entrega por la plataforma | Aviso de plataforma (Core `0014`) | Implementado, no desplegado |
| 11 | Estado del pago | `checkout.purchase_status@1` | Existente (sandbox) |

El número, la allowlist y `@13` no cambian. `@14`/`@15` siguen inactivos.

## 6. Bloqueos restantes

1. **E3-A:** E-S1 firmada, grant, pagador, ventana (detener S0, respaldo y túnel) e imagen `3d7b23d` construida.
2. **AD-5:** decisión sobre C1 antes de producción, y merge en Checkout, que no tiene remoto.
3. **E3-B:** topología (§5) y CIA en `@15`.
4. **Producción:**
   - Quote R1.7, P-1, aprobación comercial de los perfiles;
   - CIA productivo (C-CIA-1..8, DEP-3, H2) y separación identidad/consentimiento en Checkout;
   - L3;
   - F-1..F-7;
   - OD-06 (vencimiento del lado del proveedor).

## 7. Plan de activación por SHA

| Componente | SHA candidato | Gate previo | Estado |
|---|---|---|---|
| R4 | PR #55 (`feat/r4-quote-checkout-e2e`) | Revisión del PR, L3, migraciones Core `0014` y Sales `0010` aplicadas con todos los procesos a la vez, definiciones v14/v15 registradas sólo con `--lane` | Abierto, sin merge |
| Quote V2 | `a79d33f` | R1.7, lockstep A10, principal R4 (60 min o 5 días), carrito apagado en producción | Desplegado `6735352` (atrasado) |
| Checkout | `3d7b23d` (AD-5) sobre `d11e3c7` | Merge en Checkout, decisión C1, F-1..F-7, consentimiento real, OD-06 | Local, sin remoto |
| CIA | `origin/main` `7525395`; H3 `39342b2` (documentación) | C-CIA-1..8, modo productivo, DEP-3 | No desplegado |
| Catalog V2 | Generación productiva actual | P-1 | Desplegado |

**Secuencia propuesta:**

1. E3-A sandbox real.
2. `@14` (cotización) para el owner y el tester, tras R1.7, P-1 y L3.
3. `@15` sandbox sólo con la topología de E3-B resuelta.
4. Producción financiera sólo tras CIA `purchase`, H3, AD-5 con C1, F-1..F-7 y autorización explícita por SHA.

**Nada se activa sin autorización específica.**
