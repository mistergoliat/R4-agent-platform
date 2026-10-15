# R4-J4-R1 — Requisitos de autorización y contratos para Customer Profile

| Campo | Valor |
|---|---|
| Destinatario | Equipo de Customer Profile (CP) |
| Emisor | R4 (J4 — Customer Profile Integration) |
| Fecha | 2026-10-15. Revisado en R4-J4-R1A-REVIEW-01 (versión previa: commit `b680b2c`) |
| Estado | **Solicitud abierta.** D2 (autorización individual) tiene una **recomendación** de R4, no una decisión: se cierra con la aceptación de CP y del owner de identidad (D1, aún BLOCKED) |
| Marco | [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md); [especificación del consumidor](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md) §5–§11 |
| Base observada | `MS-pesaschile-customer-profile`, rama `feat/cp-j4-security-01-resilience-01` en `45b28a3`. `main` de CP está en `3bb4c94` y no contiene SECURITY-01 ni RESILIENCE-01; esos commits tampoco están en ninguna rama remota del checkout local. Hay trabajo **sin commit** (CONTEXT-02A y los documentos CP-J4-CONTEXT) que no se tomó como base y que R4 no modificó |

## 1. Estado de partida (verificado en código, `45b28a3`)

| Tema | Estado |
|---|---|
| Autenticación de consumidores | Registro de principales con Bearer por consumidor, hashes SHA-256 y `timingSafeEqual`; scopes por familia de rutas (`src/http/auth/principal-registry.ts`; `route-families.ts:60-92`) |
| Modo por defecto | `off`. `enforce` está bloqueado según el propio informe de CP. El modo desplegado es desconocido |
| Autorización por cliente | **No existe**: cualquier principal con `customer.facts.read` lee cualquier `customerId` (`docs/reviews/CP_J4_SECURITY_01_VALIDATION_REPORT.md:278`) |
| Rutas para R4 | **No existen**; solo propuestas (`docs/audits/CP_R4_J4_TARGET_CONTRACT_PROPOSAL.md:6`) |
| Identificadores en URLs | Las rutas actuales llevan `customerId` en el path (`/v1/customers/:customerId/...`) y los handlers lo registran en logs |
| Datos predictivos bajo scope de hechos | `commercial-profile` exige `customer.facts.read` y contiene RFM, cluster y CLV (`route-families.ts:66`) |
| Correlation id, rate limit, `bind` | Sin correlation id entrante; sin rate limit (salvo export); escucha en todas las interfaces (`src/index.ts:136`) |
| Contrato publicado | Sin JSON Schema ni OpenAPI |

## 2. Problema

El token de servicio de R4 (`r4-sales`) prueba **qué consumidor** llama, no **a qué cliente** puede leer. El requisito I4 es que CP aplique la autorización **por cliente**, basada en una decisión de la autoridad de identidad.

## 3. D2 — Alternativas

**A. Grant verificable.** La autoridad de identidad emite, al resolver, un grant firmado y corto. Sus claims son: emisor, cliente, consumidor (`r4-sales`), audiencia (`customer-profile`), propósitos, emisión, expiración (≤ 10 min) e identificador. R4 lo reenvía sin interpretarlo. CP verifica localmente:
- la firma, con la clave publicada por la autoridad;
- que la audiencia sea CP;
- que el consumidor del grant sea el principal autenticado por Bearer;
- que el cliente del grant sea el cliente pedido;
- que el propósito corresponda a la ruta;
- que no esté vencido.

**B. Verificación directa.** CP consulta a la autoridad en cada lectura si el sujeto o el cliente presentado por R4 está vinculado de forma verificada y autorizado para ese propósito.

| Criterio | A — Grant verificable | B — Verificación directa |
|---|---|---|
| Acceso horizontal (otro cliente) | Imposible con un grant ajeno: CP exige que el cliente del grant sea el pedido | CP pregunta por el par que envía R4; equivalente si la autoridad responde bien |
| Revocación | Al vencer el grant (≤ 10 min). Inmediata solo con lista de revocación | Inmediata en la siguiente lectura |
| Replay | Dentro del TTL, solo por el mismo consumidor y para el mismo cliente y propósito. Son lecturas, sin efecto | No aplica |
| Rotación de claves | Claves publicadas con `kid` y solapamiento. Carga operativa | Solo credenciales de servicio |
| Latencia | Verificación local en CP (sub-milisegundo) | Una llamada a la autoridad por lectura |
| Disponibilidad | Las lecturas de CP no dependen de la autoridad. El camino completo de R4 depende de ambas en las dos alternativas | Las rutas R4 de CP dependen de la autoridad |
| Datos personales | CP no recibe el `wa_id` | CP recibe o reenvía el sujeto. Contradice el principio de CP "nunca resuelve wa_id" |
| Auditoría | Emisión en la autoridad más uso en CP, correlacionables por el identificador del grant y `x-correlation-id` | Consulta en CP más respuesta en la autoridad |
| Aislamiento entre clientes | Por cliente, consumidor y propósito | Por cliente y propósito |
| Compatibilidad con CP actual | Se suma a SECURITY-01. Requiere verificación de firma (`node:crypto`, sin dependencia nueva) y configuración de claves | Requiere un cliente HTTP hacia la autoridad y semántica de identidad dentro de CP |

**Recomendación de R4: A**, con TTL ≤ 10 min y ligaduras a consumidor, audiencia, cliente y propósito. Si se exige revocación inmediata, se complementa con una lista de revocación o con B solo en rutas sensibles. **D2 sigue PROPUESTA.**

## 4. Modelo de amenazas

Actores: R4 (consumidor), la autoridad de identidad, CP, y un atacante que obtiene alguna credencial o grant.

| # | Compromiso | Con A | Con B | Mitigaciones | Residuo |
|---|---|---|---|---|---|
| T1 | **R4 comprometido** (worker o host con todas sus credenciales) | Pide resoluciones de `wa_id` arbitrarios a la autoridad, obtiene grants y lee a cualquier cliente verificado cuyo número conozca | Igual: presenta sujetos arbitrarios y CP los consulta | Consumidor limitado a canal y cuentas; límites de tasa; auditoría y alertas de volumen en la autoridad (CS-07, CS-08); auditoría de uso en CP (CP-11) | **Alto.** Inherente mientras R4 termine el canal |
| T2 | **Token de servicio de R4 frente a CP** filtrado, sin más | Inútil: sin un grant válido para `r4-sales`, CP responde 403 | **Grave**: el atacante presenta cualquier sujeto o cliente y CP consulta a la autoridad | Token sin logs; rotación; restricción de red (CP-12) | A: bajo · B: alto |
| T3 | **Credencial de R4 frente a la autoridad** filtrada, sin más | Obtiene grants, pero no puede usarlos sin el token de CP | No aplica (R4 no llama a la autoridad) | Credenciales separadas por destino; rotación; alertas (CS-08) | Medio |
| T4 | **Un grant filtrado** (de memoria o de un log por error) | Lectura de un cliente, un propósito, ≤ TTL, y solo junto con el token de CP de `r4-sales` | No aplica | No registrar grants (I6); TTL corto; ligadura al consumidor | Bajo |
| T5 | **Clave de firma de la autoridad** comprometida | Permite fabricar grants para cualquier cliente; combinada con el token de CP, lectura total | No aplica | Custodia (KMS o HSM); rotación por `kid`; lista de revocación de claves | Alto, fuera de R4 |
| T6 | **Replay** de una petición capturada | Válido hasta la expiración del grant, solo con el token de CP | Válido mientras la autoridad mantenga el vínculo | TLS; TTL corto | Bajo (lecturas) |
| T7 | **Modelo / prompt injection** | No elige al cliente (I1); solo puede repetir lecturas del mismo cliente | Igual | Esquemas estrictos; límites de tasa | Bajo |

**El hash del sujeto no es una prueba independiente de autenticidad.** Si el grant lleva un hash del sujeto de canal, ese hash lo calcula la autoridad a partir de lo que **R4 afirma**. CP no recibe el sujeto y no puede contrastarlo. El hash sirve para auditoría y correlación, **no** para demostrar ante CP que el cliente escribió por ese canal. La única evidencia de canal es la firma de Meta, que verifica R4 (T1 la anula).

## 5. Requisitos para CP (DRAFT)

| ID | Requisito | Relación con el estado actual |
|---|---|---|
| CP-01 | Modo `enforce` en el despliegue que use R4, con evidencia | Hoy `off` por defecto |
| CP-02 | Principal `r4-sales` con scopes **solo** para las rutas R4 (sugerido: `customer.sales_context.read`, `customer.purchase_history.read`). Sin `customer.pii.read`, `customer.analytics.read` ni `dashboard.read` | SECURITY-01 propone `customer.facts.read`. Debe acotarse |
| CP-03 | **Autorización por cliente** en las rutas R4 según D2. Sin grant válido, 403 con `{ error: { code } }` | No existe |
| CP-04 | **Ruta de contexto**, `POST` de solo lectura (p. ej., `/v1/capabilities/customer/sales-context`) con `{ customerRef }` en el cuerpo. Responde `{ schemaVersion, status: available\|not_found\|degraded, purchaseHistory: present\|none\|unknown, validUntil }`. **Sin nombre ni `displayName`** ni otros datos personales | Propuesta en CP (con `displayName` y GET). Se pide quitar ambos |
| CP-05 | **Ruta de historial**, `POST` de solo lectura con `{ customerRef, offset 0–40, limit 1–10 }` en el cuerpo. Responde `status`, `items[]` (`productName`, `catalogKey` o `null`, `lastPurchasedOn` o `null`, `totalQuantity` o `null`, `orderCount` o `null`), `hasMore`, `validUntil` y `schemaVersion` | La más cercana hoy es `purchased-products`: GET con `customerId` en el path, ids numéricos y `totalSpentTaxIncl` |
| CP-06 | **Sin datos personales ni predictivos** en las rutas R4 (lista de claves prohibidas en la especificación §10). Su presencia hace fallar a R4 cerrado (`sensitive_field_present`) | `profile` emite email; `commercial-profile` emite RFM y CLV |
| CP-07 | Sacar `commercial-profile` de `customer.facts.read`, o excluirla de cualquier principal R4 | Hallazgo en `route-families.ts:66` |
| CP-08 | Cliente desconocido = 200 con `status: not_found`. **401/403 nunca se convierten en 404** ni en `not_found` | Ya en la propuesta de CP |
| CP-09 | Errores tipados: 400; 401/403; 429 con límite por principal; 503/504; cuerpo `{ error: { code, retryable } }` | RESILIENCE-01 tipa 503. Hoy el cuerpo es `{ error: '<code>' }` |
| CP-10 | `x-correlation-id` entrante, validado, registrado y devuelto | No implementado |
| CP-11 | Logs sin grant, sin token y sin `customerRef` en claro (hash o id de grant). Ningún identificador en las URLs de las rutas R4, para que no llegue a access logs ni a proxies | Hoy `customerId` va en el path y en los logs |
| CP-12 | Exposición de red limitada a los consumidores, sin `*:3010` público; TLS si cruza hosts | Hoy escucha en todas las interfaces |
| CP-13 | Contrato publicado: `schemaVersion` entero, JSON Schema, fixtures de cada `status` y error, SHA del repositorio, política de cambios aditivos | Sin esquemas publicados |
| CP-14 | `validUntil` en cada respuesta, nunca posterior a la expiración del grant | No existe |
| CP-15 | Respuesta ≤ 64 KB y presupuesto de servidor declarado (hoy 2 500 ms) | Presupuesto existente |
| CP-16 | **Semántica de `degraded`:** en contexto, `purchaseHistory: unknown`; en historial, `items` vacío (R4 lo trata como fallo, nunca como lista parcial) | No definida |
| CP-17 | **Desconocidos explícitos:** cantidades y fechas desconocidas como `null`, nunca 0 ni una fecha sustituta | No definida |
| CP-18 | **Orden total y declarado:** última compra descendente, `null` al final, desempates estables. Fechas como **día calendario en la zona declarada por el owner** (depende de CTX-09) | Hoy: `last_purchased_at DESC, product_id DESC, product_attribute_id DESC`; la zona horaria no está verificada |
| CP-19 | **Campos adicionales:** cambios aditivos permitidos sin cambiar `schemaVersion`, nunca con datos de la lista prohibida | — |
| CP-20 | **Datos sintéticos para integración:** un despliegue de integración con clientes y compras sintéticos para J4-R5. Mientras R4 no tenga controles de retención (D7), no se procesan clientes reales | El despliegue actual lee el MariaDB real de PrestaShop (DOC J4-R0) |

## 6. Significado comercial: depende de CP-J4-CONTEXT

El significado de "compra" no puede congelarse sin la aceptación de CP-J4-CONTEXT. Estado observado en CP (documentos **sin commit**, 2026-10-15):
- `CP_J4_CONTEXT_01_VALIDATION_REPORT.md`, veredicto `FACTS_CORRECTIONS_REQUIRED`;
- `CP_J4_COMMERCIAL_FACTS_MATRIX.md`;
- `CP_J4_CONTEXT_FIX_PLAN.md`, "Propuesta para revisión. Ninguna tarea está aprobada ni iniciada".

| Tema | Hoy en CP (según su matriz) | Qué debe fijar la aceptación |
|---|---|---|
| Compra válida | `ps_orders.valid = 1` evaluado **al consultar**: refleja el estado vigente y puede cambiar retroactivamente (CTX-02) | Definición estable de "compra" para R4 |
| Cancelaciones | Estado vigente 6. Ignora el error de pago (8), las pendientes y las cancelaciones posteriores a otro estado (CTX-06) | Si una orden cancelada aparece o no en el historial |
| Devoluciones | **No se leen** `ps_order_slip`, `ps_order_return` ni `product_quantity_refunded` (CTX-05) | Si las cantidades descuentan devoluciones |
| Unidades | Brutas: incluyen servicios, regalos de precio 0 y unidades reembolsadas (CTX-12) | Qué cuenta `totalQuantity` |
| Producto frente a variante | Historial por variante; otros agregados por producto (CTX-13) | Unidad de un ítem del historial |
| Fechas | Creación de la orden; zona horaria sin verificar (CTX-09) | Zona y precisión de `lastPurchasedOn` |
| Referencia de producto | En revisión (CONTEXT-02A): un SKU en blanco pasa a `null` | D6 (§7) |

Hasta esa aceptación, R4 trata estos significados como **provisionales** (especificación §5) y no da por cerrado J4-R1B.

## 7. Referencia de producto (D6): no se congela

- La referencia (SKU) puede ser nula y no es una clave de Catalog. R4 no la usará.
- R4 tampoco derivará una clave de Catalog de `productId` y `productAttributeId`: es una regla de Catalog.
- Opciones para cerrar D6:
  1. CP devuelve `catalogKey` a partir de un mapeo publicado por Catalog.
  2. CP devuelve `catalogKey: null`, y el modelo usa `catalog.search` por nombre.
- **D6 sigue BLOCKED** hasta que CONTEXT-02A se revise e integre y Catalog se pronuncie sobre el mapeo.

## 8. Qué cierra los contratos de CP (J4-R1B)

1. CP acepta D2 (o una alternativa equivalente) junto con el owner de identidad.
2. CP-01 a CP-20 se cumplen, o sus desviaciones son aceptadas por el owner de R4. Para cada uno: commit en `main` de CP, versión y `archivo:línea`.
3. CP-J4-CONTEXT aceptado, con el significado de §6 fijado.
4. JSON Schema y fixtures publicados con su SHA, que R4 copiará con `SOURCE.json`.
5. Evidencia de `enforce`, restricción de red y datos sintéticos en el despliegue de integración.
