# R4-J4-R1 — Requisitos de autorización y contratos para Customer Profile

| Campo | Valor |
|---|---|
| Destinatario | Equipo de Customer Profile (CP) |
| Emisor | R4 (J4 — Customer Profile Integration) |
| Fecha | 2026-10-15 |
| Estado | **Solicitud abierta.** D2 (autorización individual) tiene una **recomendación**, no una decisión. Cerrarla requiere aceptación de CP y del owner de identidad (D1) |
| Marco | [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md) (propuesta); [especificación del consumidor](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md) §5–§10 |
| Base observada | `MS-pesaschile-customer-profile`, rama `feat/cp-j4-security-01-resilience-01` en `45b28a3`. `main` de CP está en `3bb4c94` y aún no contiene SECURITY-01 ni RESILIENCE-01; esos commits tampoco están en ninguna rama remota del checkout local. Hay trabajo **sin commit** de CONTEXT-02A (§5) que no se tomó como base |

## 1. Estado de partida (verificado en código, `45b28a3`)

| Tema | Estado |
|---|---|
| Autenticación de consumidores | Registro de principales con Bearer por consumidor, hashes SHA-256 y `timingSafeEqual`; scopes por familia de rutas (`src/http/auth/principal-registry.ts`; `route-families.ts:60-92`) |
| Modo por defecto | `off`. El informe de seguridad de CP marca `enforce` como bloqueado. El modo desplegado es desconocido |
| Autorización por cliente | **No existe.** Cualquier principal con `customer.facts.read` lee cualquier `customerId` (`docs/reviews/CP_J4_SECURITY_01_VALIDATION_REPORT.md:278`) |
| Rutas para R4 (`/v1/capabilities/customer/*`) | **No existen.** Solo propuestas (`docs/audits/CP_R4_J4_TARGET_CONTRACT_PROPOSAL.md:6`) |
| Datos predictivos bajo scope de hechos | `commercial-profile` exige `customer.facts.read` pero contiene RFM, cluster y CLV (`route-families.ts:66`) |
| Correlation id, rate limit, `bind` | Sin correlation id entrante; sin rate limit (salvo export); escucha en todas las interfaces (`src/index.ts:136`) |
| Contrato publicado | Sin JSON Schema ni OpenAPI; solo tipos TypeScript |

Los documentos de CP (PRD de readiness R4-J4, borrador v0.1) ya piden un grant por cliente, un vínculo L3 y que el modelo nunca elija al cliente. Este documento es compatible con ellos y los concreta desde el lado del consumidor.

## 2. Problema que debe resolver la autorización

El token de servicio de R4 (`r4-sales`) prueba **qué consumidor** llama. No prueba **a qué cliente** puede leer. Sin un control adicional en CP:
- un error de R4 o un R4 comprometido podría leer cualquier cliente;
- un token filtrado también.

El requisito (I4) es que CP aplique la autorización **por cliente**, basada en una decisión de la autoridad de identidad, y no solo en el token de servicio.

## 3. D2 — Alternativas

**A. Grant verificable.** La autoridad de identidad, al resolver, emite un grant firmado, de vida corta, con estas claims: cliente, hash del sujeto de canal, consumidor (`r4-sales`), audiencia (`customer-profile`), propósitos, emisión, expiración e identificador. R4 lo reenvía sin interpretarlo. CP verifica localmente la firma con la clave publicada de la autoridad, y además que:
- la audiencia sea CP;
- el consumidor del grant sea el principal autenticado por Bearer;
- el cliente del grant sea el cliente pedido;
- el propósito corresponda a la ruta;
- el grant no esté vencido.

**B. Verificación directa.** CP consulta a la autoridad en cada lectura si el sujeto o el cliente presentado por R4 está vinculado de forma verificada y autorizado para ese propósito.

| Criterio | A — Grant verificable | B — Verificación directa |
|---|---|---|
| Suplantación de consumidor | Grant ligado al consumidor: un grant robado no sirve sin el Bearer de `r4-sales` | Depende solo del Bearer |
| Acceso horizontal (otro cliente) | Imposible con un grant ajeno: CP exige que el cliente del grant sea el cliente pedido | CP pregunta por el par (sujeto, cliente) que envía R4; equivalente si la autoridad responde bien |
| Residuo común | La autoridad confía en el sujeto que presenta R4. Un R4 comprometido podría pedir resoluciones de otros `wa_id`. Se acota con consumidor limitado a canal y cuentas, rate limit y auditoría (CS-07, CS-08) | Igual: CP confía en el sujeto que presenta R4 |
| Revocación | Efectiva al vencer el grant (≤ 10 min). Inmediata solo con lista de revocación | **Inmediata** en la siguiente lectura |
| Replay | Posible dentro del TTL, solo por el mismo consumidor y para el mismo cliente y propósito. Son lecturas, sin efecto | No aplica (no hay token por cliente) |
| Rotación de claves | Requiere claves publicadas con `kid` y solapamiento de rotación (carga operativa en la autoridad y en CP) | Solo credenciales de servicio entre CP y la autoridad |
| Latencia | Verificación local en CP (sub-milisegundo). La resolución la paga R4 una vez por lectura | CP añade una llamada a la autoridad por lectura |
| Disponibilidad | Las lecturas de CP no dependen de la autoridad. Para R4, el camino completo depende de ambas en las dos alternativas | Las rutas R4 de CP dependen de la autoridad en cada lectura |
| Datos personales | CP **no recibe** el `wa_id`: solo el cliente y el grant | CP recibe o reenvía el sujeto (`wa_id`). Además contradice el principio de CP "Customer Profile nunca resuelve teléfono, email ni wa_id" |
| Auditoría | Doble: emisión en la autoridad y uso en CP, correlacionables por el identificador del grant y `x-correlation-id` | Doble: consulta en CP y respuesta en la autoridad |
| Aislamiento entre clientes | Por cliente, consumidor y propósito, dentro del grant | Por cliente y propósito, según la respuesta en línea |
| Compatibilidad con CP actual | Se suma a SECURITY-01 (Bearer y scope). Necesita verificación de firma (`node:crypto`, sin dependencia nueva) y la configuración de claves de la autoridad | Necesita un cliente HTTP hacia la autoridad, su configuración, timeouts y manejo de caídas, más la semántica de identidad dentro de CP |

**Recomendación de R4: A.** Mantiene a CP fuera de la resolución de identidad y sin `wa_id`, aísla sus lecturas de la autoridad y deja auditoría en ambos extremos.

Condiciones de la recomendación:
- **TTL corto:** ≤ 10 min.
- **Ligaduras del grant:** a consumidor, audiencia, cliente y propósito.
- **Revocación inmediata solo si se exige:** si CP o la autoridad la requieren, A se complementa con una lista de revocación o con B solo para las rutas sensibles.

**D2 sigue PROPUESTA.** Se cierra con la aceptación de CP y del owner de identidad, y con el formato del grant acordado entre ambos.

## 4. Requisitos para CP (DRAFT)

| ID | Requisito | Relación con el estado actual |
|---|---|---|
| CP-01 | Modo `enforce` en el despliegue que use R4, con evidencia | Hoy `off` por defecto; `enforce` bloqueado |
| CP-02 | Principal `r4-sales` con scopes **solo** para las rutas R4 (sugerido: `customer.sales_context.read`, `customer.purchase_history.read`). Sin `customer.pii.read`, `customer.analytics.read` ni `dashboard.read` | El informe SECURITY-01 propone `r4-sales` con `customer.facts.read`. Debe acotarse a las rutas R4 |
| CP-03 | **Autorización por cliente** en las rutas R4 según D2 (si A: verificación del grant con todas las comprobaciones de §3). Sin grant válido → 403 con `{ error: { code } }` | No existe |
| CP-04 | **Ruta de contexto** (sugerida: `GET /v1/capabilities/customer/sales-context?customerRef=prestashop_customer:<id>`) que devuelva la forma de la especificación §5: `status`, `displayName` (D4), `customerSince` (mes), `purchaseHistory` (`present`/`none`/`unknown`), `validUntil`, `schemaVersion` | Propuesta en CP; no implementada |
| CP-05 | **Ruta de historial** (sugerida: `GET /v1/capabilities/customer/purchase-history?customerRef=…&offset=&limit=`) con `limit` 1–10, `offset` 0–40 y `hasMore`. Ítems: nombre, `catalogKey` (D6), fecha de última compra (día), cantidad total, número de pedidos. Orden estable y declarado | Hoy la más cercana es `purchased-products` (offset y limit 1–100, con `productId` y `productAttributeId` numéricos y `totalSpentTaxIncl`) |
| CP-06 | **Sin datos personales ni predictivos** en las rutas R4: sin email, teléfono, RUT, dirección, montos, referencias de pedido, ni RFM, cluster, CLV, affinity o intelligence | `profile` emite email; `commercial-profile` emite RFM y CLV |
| CP-07 | Corregir que `commercial-profile` quede bajo `customer.facts.read`, o excluirla de cualquier principal R4 | Hallazgo en `route-families.ts:66` |
| CP-08 | Cliente desconocido = 200 con `status: not_found`. **401/403 nunca se convierten en 404** ni en `not_found` (I5) | La propuesta de CP ya lo establece |
| CP-09 | Errores tipados: 400 validación; 401/403; 429 con límite de tasa por principal; 503/504 tipados ante caída o presupuesto; cuerpo `{ error: { code, retryable } }` | RESILIENCE-01 tipa 503 para PrestaShop. Hoy el cuerpo es `{ error: '<code>' }` |
| CP-10 | `x-correlation-id` entrante, validado, registrado y devuelto | No implementado |
| CP-11 | Logs sin grant, sin token y sin `customerRef` en claro (usar hash o id de grant) | Hoy los handlers registran `customerId` |
| CP-12 | Exposición de red limitada a los consumidores (sin `*:3010` público); TLS si cruza hosts | Hoy escucha en todas las interfaces |
| CP-13 | Contrato publicado: `schemaVersion` entero, JSON Schema de las respuestas, fixtures de cada `status` y error, SHA del repositorio y política de cambios | Sin esquemas publicados |
| CP-14 | `validUntil` en cada respuesta (frescura del owner, ADR-030), sin superar la expiración del grant | No existe |
| CP-15 | Tamaño de respuesta acotado (≤ 64 KB) y presupuesto de servidor declarado (hoy 2 500 ms) | Presupuesto existente; tope no declarado |

## 5. Referencia de producto del historial (D6): no se congela todavía

- **Qué se observó.** Durante J4-R0 y J4-R1 apareció en CP trabajo **sin commit**: CONTEXT-02A (`docs/reviews/CP_J4_CONTEXT_02A_VALIDATION_REPORT.md`, "Pendiente de revisión"). Ese cambio normaliza `product_reference` vacío o en blanco a `null` en `purchased-products` y `purchase-behavior`. En producción hay al menos 20 líneas con referencia `NULL` o vacía (según ese informe; dato documentado, no verificado por R4). R4 no modificó ni tomó como base ese trabajo.
- **Qué implica para R4.**
  - La referencia de producto (SKU) de CP puede ser nula y no es un identificador de Catalog. R4 **no** la usará como clave.
  - R4 tampoco derivará una clave de Catalog a partir de `productId` y `productAttributeId`: eso es una regla del owner de Catalog.
- **Opciones para cerrar D6.**
  1. CP devuelve la clave de Catalog, obtenida de un mapeo publicado por Catalog.
  2. CP devuelve `catalogKey: null`, y el modelo usa `catalog.search` por nombre.
- **Decisión.** D6 queda **BLOQUEADA** hasta que CONTEXT-02A se revise y se integre en CP, y hasta que el owner de Catalog se pronuncie sobre el mapeo.

## 6. Qué cierra los contratos de CP (J4-R1B)

1. CP acepta D2 (o propone una alternativa equivalente) junto con el owner de identidad.
2. CP-01 a CP-15 se cumplen, o sus desviaciones son aceptadas por el owner de R4. Para cada uno: commit en `main` de CP, versión y referencias `archivo:línea`.
3. Están publicados el JSON Schema y los fixtures con su SHA. R4 los copiará con `SOURCE.json`, como en Catalog.
4. Hay evidencia de `enforce` y de restricción de red en el despliegue de integración.
