# R4-J4-R1 — Requisitos de autorización y contratos para Customer Profile

| Campo | Valor |
|---|---|
| Destinatario | Equipo de Customer Profile (CP) |
| Emisor | R4 (J4 — Customer Profile Integration) |
| Fecha | 2026-10-15. Revisado en R4-J4-R1A-REVIEW-01 (versión previa: commit `b680b2c`) y corregido en R4-J4-R1C |
| Estado | **Solicitud abierta.** D2 (autorización individual) tiene una **recomendación** de R4, no una decisión: se cierra con la aceptación de CP y del owner de identidad (D1, aún BLOCKED). Las posiciones de R4 sobre el contrato (AP-01 a AP-11, D6) están en el [registro de decisiones compartidas](R4-J4-R1C_SHARED_DECISION_REGISTER.md); la conformidad de CP está **pendiente** |
| Marco | [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md); [especificación del consumidor](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md) §5–§11 |
| Base observada | `MS-pesaschile-customer-profile`, rama `feat/cp-j4-security-01-resilience-01` en `f631f32` (R1C). Contiene SECURITY-01 (`086b9b2`), RESILIENCE-01 (`45b28a3`), CONTEXT-01 (`4b66504`), CONTEXT-02A (`91b6739`) y el contrato candidato CONTEXT-02B (`f631f32`). Ninguno de esos commits está en una rama remota; `main` de CP sigue en `3bb4c94`. La revisión R1A había observado `45b28a3`, con 02A y los documentos CP-J4-CONTEXT todavía sin commit |

## 1. Estado de partida (verificado en código; `45b28a3`, actualizado a `f631f32` en R1C)

| Tema | Estado |
|---|---|
| Autenticación de consumidores | Registro de principales con Bearer por consumidor, hashes SHA-256 y `timingSafeEqual`; scopes por familia de rutas (`src/http/auth/principal-registry.ts`; `route-families.ts:60-92`) |
| Modo por defecto | `off`. `enforce` está bloqueado según el propio informe de CP. El modo desplegado es desconocido |
| Autorización por cliente | **No existe**: cualquier principal con `customer.facts.read` lee cualquier `customerId` (`docs/reviews/CP_J4_SECURITY_01_VALIDATION_REPORT.md:278`) |
| Rutas para R4 | **No existen** (sin ruta, handler, DTO ni reader). Hay un contrato **candidato** `customer-profile.sales-context` v1: JSON Schema, 23 fixtures sintéticos escritos a mano y 147 tests (`docs/contracts/customer-sales-context-v1/`, `f631f32`). Define `GET …?customerRef=`, una sola ruta, montos e ids de PrestaShop por ítem: **no cumple** la revisión R1C |
| Identificadores en URLs | Las rutas actuales llevan `customerId` en el path (`/v1/customers/:customerId/...`) y los handlers lo registran en logs |
| Datos predictivos bajo scope de hechos | `commercial-profile` exige `customer.facts.read` y contiene RFM, cluster y CLV (`route-families.ts:66`) |
| Correlation id, rate limit, `bind` | Sin correlation id entrante; sin rate limit (salvo export); escucha en todas las interfaces (`src/index.ts:104` en `f631f32`; `:136` en `45b28a3`) |
| Contrato publicado | Ninguno. El candidato 02B está solo en una rama local (`contractStatus: candidate`, `publishedApi: false`) |

## 2. Problema

El token de servicio de R4 (`r4-sales`) prueba **qué consumidor** llama, no **a qué cliente** puede leer. El requisito I4 es que CP aplique la autorización **por cliente**, basada en una decisión de la autoridad de identidad.

## 3. D2 — Alternativas

**A. Grant verificable.** La autoridad de identidad emite, al resolver, un grant firmado y corto. Sus claims son: emisor, cliente, consumidor (`r4-sales`), audiencia (`customer-profile`), propósitos, emisión, expiración (≤ 10 min) e identificador. R4 lo reenvía sin interpretarlo. CP verifica localmente:
- la firma, con la clave publicada por la autoridad;
- que la audiencia sea CP;
- que el consumidor del grant sea el principal autenticado por Bearer;
- que el cliente del grant sea el cliente pedido;
- que los propósitos del grant cubran el `purpose` de la petición (una sola ruta, AP-01);
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

## 5. Requisitos para CP (DRAFT, revisados en R1C)

**Regla de lectura (AP-01):** la forma del cable es de CP. Estos requisitos dicen qué **necesita** R4 y qué garantías exige; no imponen nombres de campo. Las formas que R4 había publicado en CP-04 y CP-05 pasan a ser **tipos del puerto R4** (especificación §5), no rutas de CP.

| ID | Requisito | Relación con el estado actual |
|---|---|---|
| CP-01 | Modo `enforce` en el despliegue que use R4, con evidencia | Hoy `off` por defecto |
| CP-02 | Principal `r4-sales` con **un único** scope dedicado, `customer.sales_context.read` (AP-04). Nunca `customer.facts.read`, `customer.pii.read`, `customer.analytics.read` ni `dashboard.read`, tampoco de forma transitoria. La distinción entre contexto e historial la dan `purpose` y el grant | El candidato 02B reutiliza `customer.facts.read`; DEC-04 de CP propone el scope dedicado |
| CP-03 | **Autorización por cliente** en la ruta R4 según D2. Sin grant válido, 403 con el cuerpo plano de CP. Nunca `not_found` | No existe |
| CP-04 | **Una** ruta factual, `POST /v1/capabilities/customer/sales-context`, de solo lectura y sin efecto transaccional. `customerRef` y `purpose` (`sales_context` \| `purchase_history`) obligatorios en el cuerpo JSON; paginación solo con `purchase_history`. Sin query. Respuesta con `Cache-Control: no-store` (AP-01, AP-02) | El candidato 02B usa `GET …?customerRef=` |
| CP-05 | **Composición por propósito decidida por CP**: el cliente no puede pedir componentes fuera de su propósito. Lo que R4 necesita de cada propósito está en el registro §3 (AP-01). `sales_context` no emite ítems | El candidato 02B devuelve el envelope completo; DEC-08c usa `limit: 0` |
| CP-06 | **Minimización en el cable (frontera B, AP-03):** sin datos personales, montos, componentes monetarios, derivados ni datos predictivos en los propósitos J4. Sin ids de PrestaShop ni SKU mientras D6 esté diferida. CP los conserva en su dominio y en sus otras rutas. R4 valida por estructura (`purpose_minimization_violated`) y no por prefijos de clave | El candidato 02B emite `spend.*`, `derived.*`, `productId` y `productAttributeId` |
| CP-07 | **Hardening independiente (AP-04-H):** sacar `commercial-profile` de `customer.facts.read`, previo inventario de impacto de los consumidores existentes. No es gate de J4: CP-02 basta para `r4-sales` | Hallazgo en `route-families.ts:66` |
| CP-08 | Cliente desconocido = 200 con `status: not_found`. **401/403 nunca se convierten en 404** ni en `not_found` | Ya en la propuesta de CP |
| CP-09 | Errores tipados: 400, 405, 413, 415; 401/403; 429 con límite por principal; 503/504. **Cuerpo plano de CP aceptado** (`{"error":"<code>"}`; AP-06). R4 clasifica por status HTTP y código. Corregir `requiredScope: null` en el 403 (H-15) | RESILIENCE-01 tipa 503. El cuerpo plano ya es el de CP |
| CP-10 | `x-correlation-id` entrante, validado, registrado y devuelto | No implementado |
| CP-11 | Logs sin grant, sin token y sin `customerRef` en claro (hash o id de grant). Ningún identificador en las URLs de las rutas R4, para que no llegue a access logs ni a proxies | Hoy `customerId` va en el path y en los logs |
| CP-12 | Exposición de red limitada a los consumidores, sin `*:3010` público; TLS si cruza hosts | Hoy escucha en todas las interfaces |
| CP-13 | Contrato publicado: `schemaVersion` entero, JSON Schema de petición y respuesta, fixtures de cada propósito, `status` y error, SHA del repositorio, política de cambios aditivos | Candidato 02B solo en rama local |
| CP-14 | `validUntil` en cada respuesta, nunca posterior a la expiración del grant | Declarado en el candidato (`asOf + 15 min`) |
| CP-15 | Respuesta ≤ 64 KiB **medida en bytes UTF-8**. Máximo explícito y verificable de ítems por página para `purchase_history` (R4 pide ≤ 10, `offset` ≤ 40). CP puede tener otros límites para otros consumidores (AP-07). Presupuesto de la ruta ≤ timeout de R4 − 500 ms (AP-11) | El candidato admite 50 ítems; con caracteres de 4 bytes supera 64 KiB (H-10) |
| CP-16 | **Retirado en R1C.** R4 no pide `items` vacío ni `degraded` parcial. Un componente no disponible va con su `status`/`reason` y datos `null`, como en el candidato; R4 lo mapea (AP-08) | — |
| CP-17 | **Nulos y ceros:** `null` = desconocido o no aplica, nunca 0 ni una fecha sustituta. Un 0 es un hecho y se emite como 0. Un nombre histórico ausente es `null`, nunca inventado | El candidato ya lo cumple; las rutas v1 dan 500 con nombre en blanco (CTX-11b) |
| CP-18 | **Orden total y declarado.** Fechas como `sourceDate` sin zona más `timezoneStatus`, con `utcInstant: null` mientras la zona no esté verificada (D14). El productor no reutiliza el formateo v1 que agrega `Z` (H-14) | El candidato ya lo declara |
| CP-19 | **Campos adicionales:** cambios aditivos permitidos sin cambiar `schemaVersion`, nunca con datos que CP-06 excluye | — |
| CP-20 | **Datos sintéticos para integración:** un despliegue de integración con clientes y compras sintéticos para J4-R5. Mientras R4 no tenga controles de retención (D7), no se procesan clientes reales | El despliegue actual lee el MariaDB real de PrestaShop (DOC J4-R0) |
| CP-21 | **Ciclo de vida (AP-05):** `schemaVersion`, `contractStatus` (`candidate`, `approved`, `deprecated`), `policyVersion`, `serviceBuildRef` y `authorizationBasis` (`service_scope_only` \| `customer_grant_verified`). `authorizationBasis` es evidencia declarada, nunca autorización suficiente | El candidato fija `contractStatus` y `policyVersion` como `const` y no tiene `authorizationBasis` |
| CP-22 | **Eco de `customerRef`:** si CP lo devuelve, igual al pedido. R4 lo verifica y lo descarta | El candidato lo devuelve |
| CP-23 | **Estado de cuenta (AP-09):** `primaryState` en ambos propósitos, para que R4 retenga eliminadas, operacionales, de estado desconocido y, provisionalmente, guest e inactivas | El candidato ya emite `primaryState` y `not_applicable` |
| CP-24 | **Tipo de línea (AP-10):** `lineKind` por ítem, que distinga los servicios puramente administrativos de los productos (incluidos los de precio cero). La clasificación requiere aceptación comercial | El candidato emite `standard`, `zero_price_line` y `administrative_service` |

## 6. Significado comercial: depende de CP-J4-CONTEXT

El significado de "compra" no puede congelarse sin la aceptación de CP-J4-CONTEXT. Estado observado en CP (2026-10-15; documentos sin commit en R1A, commiteados después en `4b66504`, solo en la rama local):
- `CP_J4_CONTEXT_01_VALIDATION_REPORT.md`, veredicto `FACTS_CORRECTIONS_REQUIRED`;
- `CP_J4_COMMERCIAL_FACTS_MATRIX.md`;
- `CP_J4_CONTEXT_FIX_PLAN.md`, "Propuesta para revisión. Ninguna tarea está aprobada ni iniciada".

| Tema | Hoy en CP (según su matriz) | Qué debe fijar la aceptación |
|---|---|---|
| Compra válida | `ps_orders.valid = 1` evaluado **al consultar**: refleja el estado vigente y puede cambiar retroactivamente (CTX-02) | Definición estable de "compra" para R4 |
| Cancelaciones | Estado vigente 6. Ignora el error de pago (8), las pendientes y las cancelaciones posteriores a otro estado (CTX-06) | Si una orden cancelada aparece o no en el historial |
| Devoluciones | **No se leen** `ps_order_slip`, `ps_order_return` ni `product_quantity_refunded` (CTX-05) | Si las cantidades descuentan devoluciones |
| Unidades | Brutas: incluyen servicios, regalos de precio 0 y unidades reembolsadas (CTX-12) | Qué cuenta `totalQuantity`. Hasta entonces R4 las declara **brutas** (`quantityBasis`) y nunca las presenta como netas |
| Producto frente a variante | Historial por variante; otros agregados por producto (CTX-13) | Unidad de un ítem del historial |
| Fechas | Creación de la orden; zona horaria sin verificar (CTX-09) | Zona y precisión de `lastPurchasedOn`. Hasta entonces, ±1 día |
| Referencia de producto | Corregido en CONTEXT-02A (`91b6739`): un SKU en blanco pasa a `null` | D6 (§7) |

Hasta esa aceptación, R4 trata estos significados como **provisionales** (especificación §5) y no da por cerrado J4-R1B.

## 7. Referencia de producto (D6): **diferida con `catalogKey: null`**

- Catalog conserva la autoridad sobre las claves de producto.
- CP debe hacer el mapeo cuando exista un contrato verificado de Catalog que permita hacerlo sin ambigüedad. CP ya tiene un cliente HTTP de Catalog (`src/infrastructure/catalog-product-semantics/`).
- Mientras tanto, `catalogKey: null` y el modelo usa `catalog.search` por nombre.
- La referencia (SKU) puede ser nula y no es una clave de Catalog. R4 no la usa y no se transmite en J4.
- Nadie deriva una clave Catalog de `productId` y `productAttributeId`.
- **D6 queda diferida, no aceptada** (antes BLOCKED). Para cerrarla hace falta el pronunciamiento de Catalog y la conformidad de CP.

## 8. Qué cierra los contratos de CP (J4-R1B)

1. CP acepta D2 (o una alternativa equivalente) junto con el owner de identidad.
2. CP-01 a CP-24 se cumplen (CP-16 retirado), o sus desviaciones son aceptadas por el owner de R4. Para cada uno: commit en `main` de CP, versión y `archivo:línea`.
3. CP-J4-CONTEXT aceptado, con el significado de §6 fijado.
4. JSON Schema y fixtures publicados con su SHA, que R4 copiará con `SOURCE.json`.
5. Evidencia de `enforce`, restricción de red y datos sintéticos en el despliegue de integración.

El paso intermedio es F2 (contrato candidato revisado, v1-rc). Sus condiciones de entrada y sus criterios de aceptación desde R4 están en el [registro](R4-J4-R1C_SHARED_DECISION_REGISTER.md) §6.
