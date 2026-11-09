---
title: R4 — Quote V2 + Checkout: PR e integración sandbox
status: R4_QUOTE_CHECKOUT_SANDBOX_E2E_AUTHORIZATION_PENDING (antes _BLOCKED y _NO_GO; §10)
mandate: «R4 — Quote V2 + Checkout: PR and Sandbox Integration» (owner, 2026-11-06)
date: 2026-11-07
base: main 7008048
branch: feat/r4-quote-checkout-e2e (PR #55, sin merge)
previous: R4_CHECKOUT_INTEGRATION_REPORT.md (estado inicial R4_QUOTE_CHECKOUT_E2E_INTEGRATION_READY_FOR_REVIEW, HEAD 2a6ec2a)
checkout: MS-pesaschile-checkout pay-02b @ d11e3c7 (sin cambios; sólo lectura y pruebas fuera de su árbol)
---

# R4 — Quote V2 + Checkout: PR e integración sandbox

## 0. Resultado

**Estado: `R4_QUOTE_CHECKOUT_SANDBOX_E2E_BLOCKED`.**

El mandato no puede cerrarse como `R4_QUOTE_CHECKOUT_SANDBOX_E2E_READY_FOR_REVIEW`: el E2E contra los servicios reales aislados (§5) **no se ejecutó**. Para ejecutarlo hay que arrancar `sandbox-purchase` en la EC2 y abrir el túnel SSH de SBX-2, y el propio mandato prohíbe cambios en la EC2 (§7). Todo lo demás está entregado.

| # | Entregable | Estado |
|---|---|---|
| 1 | PR de integración R4 | **Abierto: #55**, sin merge. Chequeos previos al push en §1 |
| 2 | Matriz de contratos R4–Quote–Checkout | §2 |
| 3 | Decisión D7-6 para sandbox | **Implementada** (§3): política propia, máximo 2 operaciones financieras por task, aislamiento sandbox comprobado antes de cada comando |
| 4 | Mecanismo de consentimiento sandbox | **Implementado y validado** contra el firmador y el verificador reales de Checkout (§4). Sin servicios ni firmas nuevas |
| 5 | E2E contra servicios reales aislados | **NOT_RUN — bloqueado por §7 del mandato** (§5). Runbook listo |
| 6 | Defecto de pago tardío | **Confirmado y reproducido en el código de Checkout** (§6). Abierto en Checkout; no se corrigió aquí |
| 7 | Evidencia L2 | §7 |
| 8 | Bloqueos de E2 y E3 | §8 |

**No se hizo:** merge, despliegue, cambios en la EC2, activación de `@14`/`@15`, cambios en `@13`, cambios en el kernel, cambios en Quote, Checkout o CIA, servicios nuevos, cobros, órdenes, llamadas a proveedores.

## 1. Publicación (PR)

Chequeos antes del push:

| Chequeo | Resultado |
|---|---|
| Diff y archivos nuevos | 70+ archivos respecto de `main`. Nuevos: el paquete `@r4-adapters/checkout-http` (cliente, configuración, fuente de consentimiento sandbox), el puerto Checkout, las capacidades Checkout, los perfiles `@14`/`@15` y sus definiciones candidatas, las migraciones Core `0014` y Sales `0010`, pruebas y este informe |
| Secretos y datos productivos | Barrido de todo el diff (incluido lo no versionado): ninguna clave privada, token, credencial, host de la EC2 ni correo real. Las pruebas usaban identificadores de SBX-2 (cotización, orden y referencia de la PrestaShop **aislada**, no productiva) y un teléfono de prueba nuevo: se reemplazaron por valores sintéticos y por el número de prueba ya usado en el repositorio |
| Migración Core `0014` | Aditiva: una columna `notice_key` nullable, la restricción de origen de plataforma reemplazada por un superconjunto exacto (una fila de plataforma es fallback ADR-041 **o** aviso, nunca ambas ni ninguna), un índice único parcial `(task_id, notice_key)`. Las filas existentes la cumplen (prueba de upgrade). Sin palabras de dominio (pureza Core). **No es reversible** una vez que existan avisos. Cambia la identidad de compatibilidad de los workers: gateway, workers y scheduler deben moverse juntos |
| `@14`/`@15` no se registran solos | Sus definiciones son archivos candidatos: sólo `production:sales:bootstrap --lane` con `R4_PROD_POLICY_PROFILE` en ese perfil las registra. No están en `SALES_PRODUCTION_PROFILES`, así que no pueden ser perfil principal de un gateway, de producción ni de canary (pruebas de contrato v14/v15) |
| `@13` sin cambios | El objeto `SALES_PRODUCTION_PROFILE_V13`, su definición v13 y su huella no cambian. Sólo se movió el registro de perfiles de carril (`SALES_LANE_PROFILES`) a `profile-v15.ts`; `@13` sigue resolviendo Catalog V2 |
| Chequeos focalizados | §7.1 |

## 2. Matriz de contratos R4–Quote–Checkout

| Relación | Contrato | Autoridad | R4 |
|---|---|---|---|
| R4 → Quote: emitir | `POST /v2/quotes` (A10, validez por política) | Quote | `quote.create@5`, existente, sin cambios |
| R4 → Quote: leer | `GET /v2/quotes/{id}` | Quote | `checkout.start_purchase` exige `issued` y vigente antes de pedir consentimiento |
| Checkout → Quote: leer | Lectura de la cotización emitida (estado, versión, aritmética, hash del snapshot) al crear la sesión y antes del link | Quote | — (Checkout) |
| Checkout → Quote: carrito | `QuoteCartPreparer` con `X-Purchase-Authorization` (H3: grant CIA + binding de Checkout) | Quote prepara; Checkout nunca crea carritos (ADR-0002) | `prepare` sólo lo dispara |
| R4 → Checkout: 6 rutas | `/v1` 1.0.3-proposed, §1–§8 y §11 del contrato | Checkout | `CheckoutHttpClient`, sin cambios de rutas ni códigos |
| R4 → Checkout: aislamiento | `GET /health/ready` del mismo Checkout: `ready`, `sandbox-purchase`, `MERCADOPAGO_SANDBOX_TEST_ONLY`, `orderDestination.isolatedTest` (§11.4.6) | Checkout | **Nuevo:** antes de cada comando (§3) |
| Consentimiento | Artefacto `checkout-sbx-test-consent.v1` (JWS ES256) firmado por la herramienta de prueba de Checkout | Checkout (emisor y verificador de prueba) | **Nuevo:** `SandboxConsentDirectory` lo entrega sin modificarlo (§4) |
| Misma instancia de Quote | R4 y Checkout deben leer el mismo Quote V2 | — | Requisito de despliegue (§5); en código, la URL de Quote de R4 y la de Checkout son la misma |
| Comprador | El `sub` del consentimiento, nunca un campo del cuerpo (I-18) | Checkout (prueba) / CIA (producción, inexistente) | R4 no envía identidad de comprador |

Decisión de aceptación del contrato (propuesta, sin cambios desde el informe anterior): aceptar §1–§8 y §11 para `sandbox-purchase`. Las dos excepciones anteriores quedan resueltas: R-3 tiene una fuente sandbox (§4) y la guardia de readiness está implementada (§3).

## 3. D7-6: política financiera sólo sandbox para `@15`

Decisión del owner (2026-11-06): política financiera exclusivamente sandbox para `@15`, alcance `checkout.start_purchase`, `checkout.request_payment_link` y `checkout.purchase_status`, máximo inicial de dos escrituras financieras autónomas por task.

**Dónde se aplica cada parte (sin tocar el kernel):**

| Requisito | Mecanismo |
|---|---|
| Sólo esas capacidades son autónomas | `SALES_PRODUCTION_V15_ACTION_POLICY` (`sales-production-checkout-sandbox-policy@1`): `allow`, identidad provisional y evidencia citada sólo para las dos escrituras Checkout. La regla de la clase FINANCIAL sigue siendo la de la plataforma (aprobación + identidad verificada) para cualquier otra escritura financiera. `purchase_status` es lectura |
| Máximo 2 por task | `CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK = 2` en la capa del pack. Se cuentan operaciones financieras **obtenidas de Checkout**: sesiones distintas más intentos de pago distintos registrados para la task (`sales.checkout_sessions`, `sales.checkout_link_attempts`) |
| No bloquear reintentos idempotentes | Se excluye la propia clave de ejecución: repetir la misma ejecución (respuesta perdida, reinicio, reconciliación) nunca suma. Una segunda aceptación que Checkout responde con la misma sesión viva cuenta una vez (`count(distinct session_id)`). Probado: escenario 2, escenario 3 y la prueba D7-6 |
| Rechazar si no se comprueba el aislamiento sandbox | El cliente Checkout lee `GET /health/ready` del **mismo host** antes de **cada** comando y sólo envía si responde HTTP 200 con `status: ready`, `profile: sandbox-purchase`, `environment: MERCADOPAGO_SANDBOX_TEST_ONLY` y `orderDestination.isolatedTest: true`. Ilegible o inalcanzable → `temporarily_unavailable` (nada enviado); cualquier otra respuesta → `conflict SANDBOX_ISOLATION_UNVERIFIED` → handoff. `R4_CHECKOUT_READINESS_URL` es obligatoria |
| Sin alteración de precios | R4 no envía montos: Checkout cobra el monto congelado de Quote |
| Sin emisión de consentimiento | R4 no firma ni crea artefactos (§4) |
| Sin órdenes desde R4 | No existe capacidad ni ruta; las órdenes las crea Checkout (U6) |
| Sin confirmación por el modelo | "Pagado" sólo sale de `checkout.purchase_status` (§6 del contrato); el link lo envía la plataforma |
| Sin proveedores productivos | R4 nunca llama a proveedores; el entorno lo prueba la readiness |

**Confirmación de que 2 corresponde a las operaciones existentes:** una compra son dos operaciones de Checkout: la sesión (`start_purchase`, que incluye `prepare` sobre la misma sesión) y un intento de pago (`request_payment_link`). Un link reenviado mientras el intento sigue abierto no es una operación nueva (lectura primero).

**Consecuencia que el owner debe conocer:** con 2, **un link nuevo después de que el primero venció** (R4-CK-04) es una tercera operación y se rechaza (`financial_write_limit`); la conversación pasa a una persona. Si se quiere permitir un relink, el máximo debe ser 3. No se cambió sin decisión.

## 4. Consentimiento E3 sandbox

### 4.1 Auditoría del contrato vigente (Checkout `d11e3c7`)

| Aspecto | Contrato y código | Observación |
|---|---|---|
| Emisor | `iss` igual al emisor configurado; una sola clave P-256 por `kid` (`TestOnlyConsentVerifier`) | Sólo la autoridad de prueba de Checkout |
| Audiencia | **No hay claim `aud`** | Brecha: el artefacto no nombra a quién se presenta. Mitigada en sandbox por la clave y la lista de compradores. Para producción, el grant CIA sí tiene audiencia |
| Comprador | `sub` debe estar en la lista configurada de compradores de prueba; el comprador de la sesión es el `sub`, nunca el cuerpo | Correcto |
| Cotización | `quoteId`, `quoteVersion`, `semanticSnapshotHash`, `quoteDocumentSha256` (opcional) ligados a la cotización emitida (`assertConsentBoundToQuote`) | Correcto. También: dado después de la emisión y antes del vencimiento |
| Operación | No hay claim de operación. El acto queda ligado a **la compra**: `createSession` lo registra como `purchase_authorization` y la sesión lo referencia; cada intento exige que la sesión tenga esa autorización | Vínculo sesión → intentos. **No hay vínculo 1:1 consentimiento ↔ intento** |
| Expiración | `exp − iat ≤ 900 s`; se verifica al presentarlo en `createSession` | Después, la autorización registrada es evidencia permanente de esa compra |
| Reutilización | `(issuer, act_id)` único. El mismo acto para la misma cotización, versión, comprador y snapshot devuelve la misma autorización (idempotente); para cualquier otra cosa, `QUOTE_IDENTITY_MISMATCH` | Correcto |
| Revocación | **No existe** | Sólo la TTL corta acota el artefacto antes de usarse |
| Entorno sandbox | Verificador `mode: synthetic`, `assurance: SYNTHETIC`. Sólo se compone en `sandbox-purchase` con `CHECKOUT_SBX_TEST_AUTHORITY=test-only`; la puerta de reales (`realConsentApproved: false`) sigue cerrada | Correcto |

**Vínculo con el intento:** el contrato actual vincula el grant a la sesión, y por ella a todos sus intentos; no a cada intento. Para el E2E sandbox esto basta (una compra, un intento bajo D7-6). Exigir un consentimiento por intento sería ampliar el contrato: **no se hizo** (requiere revisión independiente).

### 4.2 Mecanismo (sin servicios, autoridades ni firmas nuevas)

1. R4 emite la cotización en la conversación (`quote.create@5`).
2. El operador lee de Quote el `quoteId`, la `version`, el `semanticSnapshotHash` y el `pdfSha256` de esa cotización.
3. El operador ejecuta la herramienta autorizada de Checkout, en su contenedor `sandbox-purchase`:
   `node dist/src/main.js sign-test-consent --key-file <clave de prueba> --issuer <emisor> --quote-id Q --quote-version V --snapshot H --document D --subject <comprador de prueba>`.
   La clave privada no sale de su archivo.
4. El operador deja la salida, tal cual, en `<R4_CHECKOUT_SBX_CONSENT_DIR>/<quoteId>.json` del host del worker de R4.
5. El cliente escribe «quiero pagar» antes de que venza el artefacto (máximo 15 min; por defecto 10).
6. `checkout.start_purchase` pide el consentimiento a `SandboxConsentDirectory`, que **sólo** comprueba que el artefacto sea del formato de prueba, nombre esta cotización y versión, y le queden al menos 2 minutos. Lo entrega sin modificarlo. Checkout verifica firma, emisor, comprador, snapshot y documento.
7. R4 congela el artefacto con el cuerpo de `createSession` (`sales.checkout_purchase_requests`) para que un reintento envíe exactamente el mismo cuerpo. Nunca se registra en logs ni se muestra al modelo.

Sin archivo, o con un archivo de otra cotización, `start_purchase` se rechaza con `purchase_consent_unavailable` y no se envía nada. `@15` no compone sin `R4_CHECKOUT_SBX_CONSENT_DIR`.

### 4.3 Validación

| Prueba | Resultado |
|---|---|
| Ida y vuelta con las implementaciones reales: `signTestConsent` de Checkout → `consentFor` de R4 → `TestOnlyConsentVerifier` y `assertConsentBoundToQuote` de Checkout | **PASS.** El artefacto llega sin cambios, verifica (`VALID`, `SYNTHETIC`) y queda ligado a la cotización. Otro snapshot es rechazado por Checkout; un byte alterado invalida la firma. Prueba fuera de ambos árboles (scratchpad), con el código de Checkout `d11e3c7` sin modificar |
| Unitarias R4 (`checkout-http.test.ts`) | Selección por cotización y versión, formato, JWS mal formado, vencimiento en menos de 2 min, directorio relativo, archivo inexistente |
| Mutación CK-M14 | Entregar un artefacto de otra cotización es detectado |

## 5. E2E contra los servicios reales aislados

**Estado: NOT_RUN.** Ninguno de los 14 puntos se ejecutó contra servicios reales.

**Bloqueo exacto:**

1. **EC2.** Checkout `sandbox-purchase` corre sólo en la EC2, que tiene la credencial de prueba de Mercado Pago ensamblada en el host y recibe el webhook firmado. Hoy está detenido (S0 `1a8a0ca` restaurado tras SBX-2). Arrancarlo y abrir el túnel es un cambio en la EC2: el mandato lo prohíbe (§7) y el uso de la clave SSH requiere autorización explícita por tarea.
2. **Activación.** El camino real por WhatsApp exige activar `@15` en el carril, prohibido (§7). Sin activación no hay canal que ejecute las capacidades de forma real.
3. **Credencial.** La autorización E-S1 de la credencial de prueba de SBX-2 vence el **2026-11-07 a las 23:59 UTC**. Después no puede reutilizarse: un E2E posterior necesita una autorización nueva.
4. **Pago humano.** El pago con tarjeta de prueba lo hace una persona (SBX-2: el owner, en incógnito).

**Topología preparada (la de SBX-2, con R4 en el mismo lado que Quote):**

```
PC del operador                                         EC2 (loopback)
  PrestaShop aislada :8081 ← proxy contador :18081  ◄─ -R 18081 ─┐
  Quote V2 a79d33f :14120 (carrito + H3 verify)      ◄─ -R 4120  ─┤  Checkout sandbox-purchase
  R4 candidato (worker @15, Postgres local)                       │    :4030 webhook + /health/ready
     R4_QUOTE_* → 127.0.0.1:14120  (el MISMO Quote)               │    :4031 API de comandos
     R4_CHECKOUT_BASE_URL      → 127.0.0.1:14031  ── -L 14031 ────┤
     R4_CHECKOUT_READINESS_URL → 127.0.0.1:14030  ── -L 14030 ────┘
     R4_CHECKOUT_SBX_CONSENT_DIR → directorio local del operador
```

Así Checkout y R4 leen la misma instancia de Quote (punto 2 del mandato) sin exponer PrestaShop.

**Runbook (cuando exista autorización):** pasos 1–6 de `MS-pesaschile-checkout/deploy/sbx2/README.md` (arranque, preflight, grant), más el túnel `-L 14030` para la readiness. Después: `production:sales:bootstrap --lane` con `@15`, en una base local, y el recorrido por los 14 puntos con un comprador de prueba en la lista de Checkout. El rollback es el de SBX-2.

| # | Punto | Cómo se verifica | Hoy |
|---|---|---|---|
| 1 | Emisión de cotización | `sales.quote_v2_issued` + `GET /v2/quotes/{id}` | NOT_RUN |
| 2 | Misma cotización en Checkout | `session.quote.quoteId` = la emitida; Checkout lee `127.0.0.1:4120` = Quote local | NOT_RUN |
| 3 | Comprador de prueba | `sub` en la lista; `buyerSubjectRef` de la sesión | NOT_RUN |
| 4 | Carrito por Quote | `PREPARING → READY`, paridad `MATCH` | NOT_RUN |
| 5 | Consentimiento válido | `purchaseAuthorizationId` presente, `assurance SYNTHETIC` | NOT_RUN (validado fuera de línea, §4.3) |
| 6 | Inicio de Checkout | `start_purchase` → `READY_FOR_LINK` | NOT_RUN |
| 7 | Enlace | Aviso de plataforma con URL `www.mercadopago.cl` | NOT_RUN |
| 8 | Webhook autenticado | `signature_verified = true` | NOT_RUN |
| 9 | Conciliación | `CAPTURED` por relectura al proveedor | NOT_RUN |
| 10 | Una única orden aislada | `ps_orders WHERE id_cart = …` = 1; proxy `POST /api/orders` ×1 | NOT_RUN |
| 11 | Reintentos idempotentes | Mismas claves `r4.ck.*`, `Idempotent-Replay: true` | NOT_RUN (stub: escenarios 2–3) |
| 12 | Recuperación tras reinicio | Matar el worker R4 durante `request_payment_link`; reanuda con la misma clave | NOT_RUN |
| 13 | Pago tardío | §6 | NOT_RUN (reproducido en el código de Checkout, proveedor sintético) |
| 14 | Vencimiento del enlace | `LINK_EXPIRED_PROVISIONAL` → `LINK_EXPIRED`; relink rechazado por D7-6 | NOT_RUN (stub: escenario 5) |

Las pruebas con stub (§7) **no son evidencia de proveedor real**.

## 6. Gate financiero: pago acreditado después del vencimiento con el intento abierto

**Estado: defecto confirmado. Abierto en Checkout. El gate productivo sigue bloqueado.**

**Causa (Checkout `src/application/checkout/financial.ts`):**

```ts
const lateCapture = attempt.lateCapture || (RESOLVED_WITHOUT_PAYMENT.includes(attempt.status) && path.includes('CAPTURED'));
```

`lateCapture` sólo se marca si el intento **ya estaba resuelto sin pago** (`FAILED`, `CANCELED`, `EXPIRED`). Si sigue abierto (`LINK_AVAILABLE` o `PROCESSING`), una captura posterior a `expiresAt` pasa por `onConfirmed` → `PAYMENT_CONFIRMED_ORDER_PENDING` → `SYNC_ORDER` → orden creada. Nada compara la captura con la vigencia autorizada. `EXPIRE_ATTEMPT` no cierra el hueco: si al vencer el proveedor muestra la orden en pago o ya capturada, aplica esa vista y el intento nunca pasa por `EXPIRED`.

**Reproducción** (código de Checkout `d11e3c7` sin modificar, base de prueba local, **proveedor sintético**; prueba fuera de su árbol):

| Caso | Intento | Sesión | Órdenes | Intervención |
|---|---|---|---|---|
| LATE-A: link aún `LINK_AVAILABLE`, pagado 1 min después de `expiresAt` (antes de que corra `EXPIRE_ATTEMPT`) | `CAPTURED`, `lateCapture: false` | **COMPLETED** | **1** | ninguna |
| LATE-B (= CT-11 de Checkout): pago iniciado en el minuto 14, capturado en el 17 | `CAPTURED`, `lateCapture: false` | **COMPLETED** | **1** | ninguna |
| LATE-C (control): pagado después de que el intento quedó `EXPIRED` | `CAPTURED`, `lateCapture: true` | `ACTION_REQUIRED` | 0 | `LATE_CAPTURE` |

LATE-B es **comportamiento de diseño**: la prueba CT-11 de Checkout lo exige (PRD I-06, «el vencimiento del link no es liquidación»). LATE-A no tiene ni siquiera un inicio de pago dentro de la vigencia.

**Contra el criterio del mandato:**

| Criterio | Hoy |
|---|---|
| Registrar el resultado financiero real | Cumple: `captured_minor` y estado del proveedor registrados |
| No generar la orden fuera de las condiciones autorizadas | **No cumple** (LATE-A; LATE-B si el owner no lo autoriza) |
| Trazabilidad para intervención | **No cumple** en LATE-A/B: no se abre caso |
| No perder ni duplicar el pago | Cumple: una captura, una orden, `DUPLICATE_PAYMENT` para dobles |
| No alterar la vigencia del link | Cumple: `expiresAt` no se toca |

**Corrección propuesta (en Checkout, con su propia revisión; no aplicada):** marcar `lateCapture` también cuando la captura se observa en o después de `attempt.expiresAt`, salvo la excepción que el owner autorice para CT-11 (pago iniciado y observado `PROCESSING` antes de `expiresAt`, decisión AD-5). Con eso, `onConfirmed` abre `LATE_CAPTURE`, la sesión pasa a `ACTION_REQUIRED`, `storedPaymentProblem` ya impide la orden, y el pago queda registrado sin duplicarse. Las pruebas LATE-A/B/C sirven como pruebas de regresión.

**Lado R4:** R4 no puede detectarlo; informa lo que Checkout informa. Un `COMPLETED` tardío llegaría como `ORDER_COMPLETED`. La mitigación de R4 sigue siendo no ofrecer links a menos de 60 s del vencimiento y llevar `lateCapture`/anomalías a `HUMAN_INTERVENTION_REQUIRED`.

El gate productivo sigue bloqueado hasta resolver este comportamiento y verificar F-1 a F-7.

## 7. Evidencia L2

### 7.1 Pruebas

Árbol final: `33696a4` (código), base de prueba local `r4-agent-platform-postgres`. Corridas en serie; `test:recovery` sin nada concurrente.

| Nivel | Comando | Resultado |
|---|---|---|
| L1 | `tsc --noEmit` | 0 errores (tras `33696a4`, que corrigió el tipo de `obtain` en una prueba) |
| L1 | `npm run lint` | 0 |
| L1 | `test:unit` | 1707 ✓, 4 omitidas (preexistentes) |
| L1 | `test:contract` | 509 ✓ |
| L2 | `test:integration` | **738 ✓**, 12 omitidas (preexistentes); 0 fallas. Cierra el `NOT_RUN` del informe anterior (la corrida completa tras los pines) |
| L2 | `test:recovery` | 19 ✓ |
| L2 | `test:sales` | 29 ✓ |
| L2 | `test:shadow` | 5 ✓ |
| L2 | `test:interop` | **NOT_RUN** (la propia suite lo declara): necesita checkouts compilados de CIA `7525395` y CP `bbd766e`. El diff no toca CIA, CP ni su camino |
| — | Consentimiento ida y vuelta con Checkout real (§4.3) | PASS (fuera del árbol) |
| — | Pago tardío LATE-A/B/C (§6) | Reproducido (código de Checkout, proveedor sintético) |
| L3 | Cadena completa sobre el SHA del release, gate financiero F-1..F-7 | **NOT_RUN**: no hay candidato integrado estable (mandato §6) |
| — | E2E real R4-CK-01..12 | **NOT_RUN** (§5) |

Las pruebas con stub de Checkout no son evidencia de proveedor real.

### 7.2 Mutaciones: matriz suite → invariantes

El cambio es **transversal** (migración Core `0014`, entrega en `live-ops`) y toca el camino del dinero: R4_TEST_STRATEGY_02 §7 pide **todas** las suites en L2. Hay 20 (19 en `main` más `checkout`).

Corridas en serie, sin editar fuentes durante la cadena. `SKIPPED` cuenta como falla: no hubo ninguno.

| Suite | Invariantes que muta | ¿Toca el diff? | Árbol | Resultado |
|---|---|---|---|---|
| `checkout` | Lectura primero, pedido explícito, relink pedido, sin pago con intervención, kill switch, misma clave tras respuesta perdida, margen 60 s, «pagado» sólo con COMPLETED; **D7-6**: límite por task, sin doble conteo, aislamiento sandbox, entorno; **R-3**: consentimiento de su cotización | Sí (todas sus fuentes) | `33696a4` | **14/14** |
| `worker-readiness` | Identidad de compatibilidad, readiness de workers | Sí (`platform.ts`); no se había corrido antes | `33696a4` | **15/15** |
| `canary-j4` | Política de evidencia vencida de `@8` | No; se corre por ser transversal | `33696a4` | **13/13** |
| `evaluation` | Evaluador de calidad | No; transversal | `33696a4` | **6/6** |
| `identity-verification` | Verificación de identidad | No; transversal | `33696a4` | **23/23** |
| `identity-verification-state` | Estados de verificación | No; transversal | `33696a4` | **16/16** |
| `identity-verification-dispatch` | Despacho de OTP | No; transversal | `33696a4` | **11/11** |
| `identity-verification-commercial` | Bloqueo comercial sin verificación | No; transversal | `33696a4` | **9/9** |
| `rr1` | Revalidación RR-1 | No; transversal | `33696a4` | **5/5** |
| `recovery` | Recuperación tras falla de run | No; transversal | `33696a4` | **14/14** |
| `shadow` | Modo sombra | No; transversal | `33696a4` | **9/9** |
| `turn-guard` | Guardia de fin de turno | No; transversal | `33696a4` | **24/24** |
| `production` | Entrega, kill switch, dueño único | Sí (`delivery.ts`, `production-store.ts`, `platform.ts`) | `2a6ec2a` | **23/23** |
| `production-control` | Controles de producción | Sí (`delivery.ts`, `production-store.ts`) | `2a6ec2a` | **13/13** |
| `runtime-contingency` | Contingencia del runtime | Sí (`production-store.ts`) | `2a6ec2a` | **11/11** |
| `prior-conversation` | Continuidad entre tasks | Sí (`context-source.ts`, `production-store.ts`, `composition.ts`) | `2a6ec2a` | **11/11** |
| `binding-immutability` | Inmutabilidad de bindings | No; transversal | `2a6ec2a` | **12/12** |
| `identity-verification-ingress` | Ingreso de verificación | Sí (`production-store.ts`) | `2a6ec2a` | **13/13** |
| `profile-v8` | Política por perfil | Sí (`profile-v8.ts`, `composition.ts`) | `2a6ec2a` | **8/8** |
| `run-failure-fallback` | Fallback ADR-041 y avisos de plataforma (RFF-N1/N2) | Sí (`delivery.ts`, `production-store.ts`, `composition.ts`) | `2a6ec2a` | **8/8** |
| **Total** | | | | **258/258 en 20 suites** |

**Evidencia conservada del árbol anterior (8 suites, 99 mutaciones).** Entre `2a6ec2a` y `33696a4`, ninguno de los archivos que esas suites mutan cambió, salvo `composition.ts`. Allí sólo cambiaron el texto del rechazo de `@15` sin consentimiento y un comentario, fuera de sus anclas, que siguen resolviendo. Sus pruebas no usan Checkout. Lo nuevo (límite, aislamiento, consentimiento) lo cubre `checkout`, que se volvió a correr.

**Ninguna suite excluida.** Una ambigüedad preexistente en `main`: el ancla `ignore the kill switch` de `production` aparece dos veces en `delivery.ts`; muta la primera y es detectada. No se tocó.

## 8. Bloqueos restantes

### 8.1 E2 (cotización real por WhatsApp)

Sin cambios respecto del informe anterior (§7.1):

1. Gate R1.7 `NOT_MET`.
2. SHA candidato de Quote (`a79d33f` trae `000010`; carrito apagado garantizado).
3. Despliegue de Quote con A10 en lockstep con este R4.
4. Principal R4: 60 minutos o 5 días.
5. P-1: evidencia de paridad de Catalog.
6. DS-1 y v14 evaluados con el modelo real.
7. F-E1-1: una consulta deja la conversación sin respuesta.
8. Alertas, kill switch con el worker del carril, L3 y autorización por SHA.

### 8.2 E3 (Checkout sandbox desde WhatsApp)

Además de E2:

1. **Autorización para la EC2:** arrancar `sandbox-purchase`, túnel, clave SSH (§5).
2. **Credencial de prueba:** E-S1 vence el 2026-11-07 23:59 UTC; después, autorización nueva.
3. **Pago tardío** (§6): corrección en Checkout y decisión AD-5 sobre CT-11.
4. **Relink bajo D7-6:** con máximo 2, un link nuevo tras vencimiento pasa a una persona; subir a 3 si se quiere (§3).
5. Audiencia y revocación ausentes en el consentimiento de prueba (aceptable en sandbox; no para producción). Producción necesita el grant CIA `purchase` (H3, C-CIA-1..8).
6. Activación de `@15` en el carril para el comprador de prueba, por SHA.
7. Migraciones Core `0014` y Sales `0010` antes de cualquier proceso con este código; todos los procesos juntos.
8. Evaluación de v15 con el modelo real (sin URL, montos ni acreditación escritos por el modelo).
9. L3 sobre el candidato integrado y el E2E R4-CK-01..12 real.

## 9. Cambios de este mandato

Commits sobre `2a6ec2a`, publicados en el PR #55:

| Commit | Archivo | Cambio |
|---|---|---|
| `6636944` | `adapters/domains/checkout/http/src/config.ts` | `R4_CHECKOUT_READINESS_URL` obligatoria: origen, mismo host que la API, distinto del listener de comandos |
| | `adapters/domains/checkout/http/src/client.ts` | Prueba de aislamiento sandbox antes de cada comando (`/health/ready`, sin credencial); telemetría `sandboxReadiness` |
| | `adapters/domains/checkout/http/src/sandbox-consent.ts` | Nuevo: `SandboxConsentDirectory` / `consentFor` (R-3 sandbox) |
| | `agents/sales/src/workspace/store.ts` | `checkoutFinancialOperations(taskId, exceptExecutionKey)` |
| | `agents/sales/src/capabilities/checkout.ts` | `CHECKOUT_FINANCIAL_OPERATIONS_PER_TASK = 2`, rechazo `financial_write_limit` antes de congelar la compra y antes de un intento nuevo |
| | `agents/sales/src/cli/production.ts` | El worker `@15` recibe la fuente de consentimiento si `R4_CHECKOUT_SBX_CONSENT_DIR` está definida |
| | `agents/sales/src/production/profile-v15.ts`, `composition.ts`, `profile-v13.ts` | D7-6 documentada en la política y el gate; mensaje de rechazo; comentario |
| | Pruebas | Unitarias de readiness y consentimiento; escenario 5 y prueba D7-6 de integración; contrato v15; mutaciones CK-M9..M14; identificadores sintéticos en lugar de los de SBX-2 |
| `33696a4` | `sandbox-consent.ts` | `obtain` usa el tipo de solicitud del puerto |
| (este) | `docs/architecture/R4_QUOTE_CHECKOUT_SANDBOX_E2E_REPORT.md` | Este informe |

Sin cambios en Quote, Checkout, CIA, Catalog, la EC2 ni el kernel. Las pruebas de §4.3 y §6 viven fuera de ambos repositorios.

## 10. Campaña sandbox real (2026-11-07): estado `R4_QUOTE_CHECKOUT_SANDBOX_E2E_AUTHORIZATION_PENDING`

Secuencia del día:

1. **«Real Sandbox E2E» → `_NO_GO` en el preflight.** La E-S1 vigente para la credencial de prueba era la de SBX-2. Tenía alcance sólo SBX-2 y vencía al cierre de esa campaña, que cerró el 2026-11-06. No se usó el token, ni siquiera para el preflight del proveedor.
2. **«Sandbox E2E Unblock».** Se preparó todo lo que no requiere una llamada autenticada al proveedor (§10.1–§10.5).

La evidencia de la EC2 y lo relativo a credenciales se conservan **fuera de este repositorio**.

### 10.1 Decisión sobre la prueba parcial

El owner autorizó usar un producto de la PrestaShop aislada:

- La cotización **se origina con el adaptador real Quote V2 de R4** (`QuoteV2HttpClient.createAndIssue`, la misma llamada que `quote.create@5`), contra el Quote candidato `a79d33f`. Se persiste en Quote y en `sales.quote_v2_*` de R4.
- Esa instancia de Quote es la que lee Checkout (túnel de SBX-2).
- Después corren las capacidades reales de R4, en este orden:
  - `checkout.start_purchase`: consentimiento por `SandboxConsentDirectory`;
  - `checkout.request_payment_link`: el aviso de plataforma queda en un archivo privado para el pagador;
  - `checkout.purchase_status`.
  Usan `CheckoutHttpClient` con la prueba de aislamiento y el kill switch.

**No cubre:**

- Catalog V2, Discover, la vista previa desde Catalog ni la confirmación de la oferta;
- WhatsApp y el dueño de entrega;
- el modelo;
- el Task Runtime, el Policy Engine y el ActionExecutor: un driver local invoca directamente las capacidades registradas. Ya los cubren las pruebas de integración y de mutación.

El driver queda fuera del PR (no versionado).

### 10.2 E-S1

| Ítem | Estado |
|---|---|
| E-S1 de SBX-2 | Cerrada, no reutilizable |
| Nueva solicitud (alcance `R4_QUOTE_CHECKOUT_E2E_SANDBOX`: una operación de CLP 2.500, máximo 1 intento, ventana de 1 h, comprador de prueba de Checkout, sólo Mercado Pago sandbox y PrestaShop aislada) | **Preparada, sin firmar.** E4 cambia respecto del texto original (1.000 → 2.500) y requiere aceptación expresa. No se creó ni simuló ninguna firma |
| Verificación de la credencial (huella, vendedor, aplicación, entorno) | **Pendiente.** Sólo puede hacerse con el procedimiento autorizado (ensamblado con huella, runtime `VERIFIED`, preflight `/users/me`) **después** de la firma |
| Copia del token de la campaña SBX-2 en la EC2 | **Retirada** (`shred -u`, 2026-11-07 05:15Z) tras comprobar que la E-S1 terminó, que ningún proceso la usaba y que S0 no depende de ella. El archivo original del operador se conserva (es la fuente autorizada para ensamblar la nueva campaña) |

### 10.3 AD-5 (en Checkout, no en R4)

Corrección implementada en el repositorio Checkout: rama local `pay-02c-ad5-late-capture`, commit `3d7b23d`, **sin revisión independiente todavía**.

**Investigación del contrato del proveedor.** La API de órdenes de Mercado Pago no expone la hora de inicio del pago (la orden documentada sólo trae `created_date`, `last_updated_date` y `expiration_time`). Por eso, la evidencia es la hora del proveedor en la primera vista de la orden en proceso. Se guarda una sola vez (`payment_started_at`, migración `0018`) y nunca se usa la hora de observación de Checkout.

**Tres momentos separados:**

- inicio: hora del proveedor;
- primera observación: reloj de Checkout, en la auditoría;
- acreditación: hora del proveedor en la vista de la captura.

**Reglas:**

| Inicio | Resultado |
|---|---|
| Verificable antes del vencimiento | Sigue con los demás controles |
| Posterior al vencimiento | `ACTION_REQUIRED`, caso `LATE_CAPTURE`, sin orden |
| Desconocido | `ACTION_REQUIRED`, caso `LATE_CAPTURE`, sin orden |

En todos los casos la captura queda registrada, sin pérdida ni duplicado.

**Pruebas:**

- 7/7 de aceptación: LATE-A retenido, CT-11 completa, inicio posterior, inicio desconocido, pago normal, captura tras vencimiento, inmutabilidad.
- 3/3 mutaciones detectadas: sin comparación de tiempo, hora de observación como inicio, estado abierto como evidencia.
- Regresión de Checkout: 1559 pruebas aprobadas, con 2 fallas que **ya existían** en `d11e3c7`. Son guardias estáticas que marcan `scripts/sbx2/localStack.ts`, de SBX-2, y no están relacionadas con este cambio.

**Cambio de comportamiento:** una prueba previa de Checkout ("orden oculta por el retraso de búsqueda y pagada entretanto") completaba la orden. Ahora queda retenida, porque el pago llega en el vencimiento sin evidencia de inicio anterior; el pago sigue registrado.

**Para la campaña:** la imagen ya revisada en la EC2 es `14335cb`, sin AD-5. Usar `3d7b23d` exige revisarlo y construir la imagen; lo decide el owner. Con un único intento pagado dentro de la ventana, AD-5 no se ejercita contra el proveedor real (OD-06 sigue abierto).

### 10.4 Readiness del entorno integrado

| Componente | Estado (2026-11-07) |
|---|---|
| R4 candidato | PR #55 (`91b11bb`), sin cambios. El driver usa el build local |
| Quote V2 candidato `a79d33f` | Recreado localmente. **Ensayo:** R4 emitió una cotización real por su adaptador (CLP 2.101 + 399 = 2.500, PDF verificado por sha256), persistida en Quote y en R4. Detenido después |
| Consentimiento | **Ensayo:** la herramienta `sign-test-consent` de Checkout firmó para esa cotización; `SandboxConsentDirectory` lo entregó; el verificador de Checkout, con la clave pública y el comprador que fija la configuración del runtime de la EC2, respondió `VALID` (`SYNTHETIC`, ligado al documento) |
| PrestaShop aislada | Responde localmente; el centinela se verifica en el runtime al ejecutar |
| Checkout `sandbox-purchase` (EC2) | Imagen, configuración y base presentes. **Detenido.** Sin `app.env`: se reensambla con la huella aprobada después de la E-S1 |
| S0 | En ejecución. **Sin operaciones financieras pendientes:** 0 sesiones, 0 intentos, sin workers. 8 trabajos de eventos de proveedor inertes del 2026-10-26, nunca ejecutados; detener S0 no los afecta |
| Bases de datos | Checkout: contenedor y volumen propios en loopback. Quote y R4: locales. Ninguna productiva |
| Rollback | El de SBX-2 (detener `checkout-sbx2`, revocar grants, arrancar S0, cerrar el túnel). El respaldo de la base `checkout-sbx2` se toma al abrir la ventana |
| Recursos de la EC2 | Suficientes (1,7 GiB de RAM y 6,8 GB de disco libres) |

### 10.5 Condiciones pendientes para ejecutar

1. **E-S1 firmada** por el responsable de la credencial, incluida la aceptación de E4 = 2.500, E7 y E8.
2. **Verificación de la credencial**, sólo después de la firma: ensamblado con huella, runtime `VERIFIED`, preflight PASS.
3. **Autorización financiera** (grant: CLP 2.500, 1 intento, 1 h), en el momento de ejecutar.
4. **Pagador disponible**, con la tarjeta de prueba, en incógnito y sin sesión de Mercado Pago.
5. **Imagen de Checkout para la campaña:** `14335cb` (revisada) o `3d7b23d` (AD-5, sin revisar).
6. **Ventana aprobada:** dentro de ella se detiene S0, se toma el respaldo de la base, se arranca `sandbox-purchase` y se abre el túnel.

Con 1–4 y 6 cumplidos y el preflight completo, el estado pasa a `R4_QUOTE_CHECKOUT_SANDBOX_E2E_READY_TO_EXECUTE`.
