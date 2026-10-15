# R4-J4-R1 — Especificación del consumidor Customer de R4

| Campo | Valor |
|---|---|
| Estado | **DRAFT, revisado (R4-J4-R1A-REVIEW-01) y corregido (R4-J4-R1C).** Diseño de consumidor; **no implementado**. Los esquemas externos son lo que R4 necesita, no contratos publicados. Cambiarán cuando los owners publiquen los suyos (J4-R1B) |
| Fecha | 2026-10-15. Versión previa a la revisión: commit `b680b2c`. Versión R1A: `2890a9c` |
| R1C | Aplica las posiciones de R4 AP-01 a AP-11 y D6 del [registro de decisiones compartidas](R4-J4-R1C_SHARED_DECISION_REGISTER.md): §2, §3, §5–§12. La forma del cable es la del contrato de Customer Profile; los tipos de este documento son del puerto y de las capacidades de R4 |
| Decisión marco | [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md) |
| Destinatarios | Owner de R4; equipos de Customer Service y Customer Profile |

Las formas de tipos usan notación TypeScript/zod solo como lenguaje de especificación. No hay código asociado.

---

## 1. Alcance

| Incluido | Excluido |
|---|---|
| Puertos `CustomerIdentityResolver` y `CustomerProfilePort` | Implementación, adaptadores, migraciones, perfiles |
| `customer.get_context@2` y `customer.get_purchase_history@1` | Cambios a `customer.get_context@1`, a `@1`–`@7` o al harness |
| Estados, errores, vigencia, límites, minimización | Datos declarados (GAP-05), RFM/predictivos, Customer Expansion |

---

## 2. Identificadores

| Identificador | Forma | Emisor | Dónde vive en R4 | ¿Lo ve el modelo? |
|---|---|---|---|---|
| Sujeto de canal | `{ channel, accountRef, subjectRef }` (WhatsApp: `whatsapp`, `phone_number_id`, `wa_id`) | R4 ChannelIngress | Binding de producción, existente | **No** |
| Referencia de cliente | `prestashop_customer:<id>`, con `id` en `^[1-9][0-9]{0,9}$` | Autoridad de identidad | Memoria de la invocación | **No** |
| Referencia de maestro | `crm_master_customer:<id>` | Autoridad de identidad | **Nunca entra a R4** (I11) | No |
| Grant | Opaco | Autoridad de identidad | Memoria de la invocación | **No** |
| Clave de producto | Clave Catalog (`CATALOG_KEY_PATTERN`) o `null` | Catalog es la autoridad; CP la emite cuando exista un mapeo verificado (D6 **diferida**: `null` en J4) | Salida del historial | Sí |

Reglas:
- Una referencia de cliente en otro namespace, o un entero desnudo, es `contract_violation` (`foreign_customer_ref`).
- R4 nunca construye una referencia a partir de otra.
- R4 no deriva claves Catalog de ids de PrestaShop ni equipara el SKU con `catalogKey`.

---

## 3. Sujeto de canal

```ts
// DRAFT
type ChannelSubject = { readonly channel: string; readonly accountRef: string; readonly subjectRef: string };
```

- **Origen único:** `ProductionStore.bindingByTask(execution.taskId)`, que da `{ channel, accountRef, recipientRef }` (I10; D3 aceptada).
- **Sin binding** (referencia, shadow, evaluación o API sin canal): `identity: 'unavailable', reason: 'anonymous'`, sin llamadas externas.
- **Nunca proviene de:** argumentos del modelo, inputs, transcript, workspace, memoria ni `task.requestedBy`.
- Se envía solo a la autoridad de identidad, **en el cuerpo** de la petición. **Nunca** va a Customer Profile.
- **No es el binding de `@1`.** `customer.get_context@1` lee `sales.conversations.customer_ref`, una referencia de cliente guardada en la conversación (siempre `null` en producción). Las capacidades de este documento no la leen: obtienen el `customerRef` de la autoridad en cada invocación y lo mantienen solo en memoria (ADR-039 §3).

---

## 4. Puerto `CustomerIdentityResolver` (DRAFT)

```ts
type CustomerPurpose = 'sales_context' | 'purchase_history';

interface CustomerAccessGrant {
  readonly token: string;            // opaco: R4 no lo decodifica ni lo valida
  readonly expiresAt: string;        // campo de la respuesta (no claim parseado); obligatorio
  readonly purposes: readonly CustomerPurpose[];
}

type IdentityResolution =
  | { readonly status: 'verified'; readonly customerRef: string; readonly grant: CustomerAccessGrant; readonly resolvedAt: string }
  | { readonly status: 'not_linked' | 'not_verified' | 'ambiguous' | 'conflicted' | 'not_authorized'; readonly resolvedAt: string };

interface CustomerIdentityResolver {
  resolve(subject: ChannelSubject, purposes: readonly CustomerPurpose[], options?: CallOptions): Promise<IdentityResolution>;
}
```

| `status` | Significado | `customerRef`/grant |
|---|---|---|
| `verified` | Vínculo verificado entre el sujeto **actual** y un cliente PrestaShop, con grant para todos los propósitos pedidos | Presentes |
| `not_linked` | El sujeto no tiene cliente vinculado | Ausentes |
| `not_verified` | Coincidencia o vínculo declarado, no verificado (p. ej., solo teléfono) | Ausentes |
| `ambiguous` / `conflicted` | Varios candidatos o evidencia contradictoria | Ausentes |
| `not_authorized` | Vínculo verificado, pero la autoridad niega el grant para ese propósito (política, restricción, opt-out) | Ausentes |

Reglas:
- Cada capacidad pide **solo su propósito**. El mismo valor viaja a CP como `purpose` de la petición (AP-01).
- Una respuesta `verified` es incoherente, y por tanto `contract_violation` (`incoherent_grant`), si:
  - falta el grant;
  - `expiresAt ≤ ahora` según el reloj de R4;
  - los propósitos no cubren el pedido.

---

## 5. Puerto `CustomerProfilePort` (DRAFT, revisado en R1C)

**Contrato del owner (AP-01):** **una** ruta, `POST /v1/capabilities/customer/sales-context`, con `purpose` obligatorio en el cuerpo. El puerto tiene dos operaciones. Cada una envía su propio `purpose` y nunca pide componentes de la otra.

La forma del cable es la del contrato de CP: hoy el candidato `customer-profile.sales-context` v1 (`f631f32`), que **no** cumple esta revisión; su revisión es F2 (v1-rc). Los tipos de abajo son **del puerto R4**, no del cable.

```ts
// DRAFT
type CustomerProfileStatus = 'available' | 'not_found' | 'withheld';
// withheld: CP not_applicable; primaryState deleted, operational o desconocido; y, de forma
// provisional (AP-09), guest e inactive. El puerto no expone el motivo.
// No existe 'degraded': un 503 de CP es DomainError('temporarily_unavailable'), no un estado.

interface CustomerSalesContext {             // purpose: 'sales_context'
  readonly status: CustomerProfileStatus;
  readonly purchaseHistory: 'present' | 'none' | 'unknown';   // 'unknown' si ningún componente disponible lo respalda
  readonly validUntil: string | null;                          // freshness.validUntil de CP; null = no declara
}

interface CustomerPurchaseItem {
  readonly productName: string | null;       // nombre histórico de CP, sin tope en el puerto; null = sin nombre registrado
  readonly catalogKey: string | null;        // D6 diferida: null en J4
  readonly lastPurchasedOn: string;          // lastPurchased.sourceDate de CP: día calendario, zona sin validar
  readonly totalQuantity: number;            // entero ≥ 0: unidades BRUTAS (quantityPurchasedGross), no netas de devoluciones
  readonly orderCount: number;               // entero ≥ 1: órdenes válidas con esta variante
  readonly lineKind: 'standard' | 'zero_price_line' | 'administrative_service';   // solo para el filtro AP-10
}

interface CustomerPurchasePage {             // purpose: 'purchase_history'
  readonly status: CustomerProfileStatus;
  readonly items: readonly CustomerPurchaseItem[];   // vacío si status ≠ available
  readonly hasMore: boolean;
  readonly nextOffset: number | null;                // offset + page.returned de CP, si hasMore
  readonly datePrecision: 'day' | 'day_plus_minus_one';
  readonly validUntil: string | null;
}

interface CustomerProfilePort {
  getSalesContext(customerRef: string, grant: CustomerAccessGrant, options?: CallOptions): Promise<CustomerSalesContext>;
  getPurchaseHistory(customerRef: string, grant: CustomerAccessGrant, page: { readonly offset: number; readonly limit: number }, options?: CallOptions): Promise<CustomerPurchasePage>;
}
```

Reglas de contrato:

| Tema | Regla |
|---|---|
| Petición | `{ customerRef, purpose }` en el cuerpo. `page` solo con `purchase_history`: `offset` 0–40 y `limit` 1–10. Sin query. El grant va en un header (nombre según D2). Mientras D2 no exista, no se envía |
| Sin grant | El puerto no tiene operaciones sin grant ni métodos de escritura |
| Validación | Esquema **estructurado por propósito**. Cerrado en `schemaVersion`, `contract` y `status`. Tolerante con campos aditivos: los desconocidos se descartan, no se reenvían ni se registran. No se usa `.strict()` sobre la respuesta |
| Minimización (frontera B) | Un componente monetario o predictivo, un id de PrestaShop o un SKU en una respuesta J4 da `contract_violation` (`purpose_minimization_violated`). Lo detecta la **estructura** del esquema del propósito, no el nombre de la clave (§10) |
| Eco de `customerRef` | Debe ser igual al pedido; si no, `contract_violation` (`customer_ref_mismatch`). Se descarta tras verificarlo |
| Estados | §7. Con `completeness: partial` solo se usan los componentes con `status: available`. Contexto sin indicador respaldado → `unknown`. Historial con ítems no disponibles (`items: null`) → fallo `history_unavailable`. **Nunca** una lista parcial |
| Cuentas no divulgables | `withheld` (AP-09). El adaptador no devuelve ningún ítem ni el motivo |
| Nombres | `null` se conserva. No se sustituye por el SKU ni por un nombre actual de Catalog. El tope de 120 es de la salida (§6.2), no del puerto |
| Cantidades | 0 es un hecho de CP y se conserva. Son unidades **brutas**: incluyen unidades devueltas o reembolsadas (CTX-05, CTX-12) |
| Fechas | `lastPurchasedOn = lastPurchased.sourceDate`. Mientras `timezoneStatus` sea `unverified`, `datePrecision: day_plus_minus_one`. Nunca se usa un `utcInstant` nulo ni se agrega `Z` |
| Tipo de línea | Un `lineKind` desconocido excluye el ítem de la salida (se registra el código) |
| Orden | Lo declara CP y es total (hoy `last_purchased_desc_product_id_desc_attribute_id_desc`). R4 no reordena. El adaptador verifica que las fechas de la página no crezcan (`order_violation`) |
| Ciclo de vida | Se registran `contractStatus`, `policyVersion`, `serviceBuildRef` y `authorizationBasis`. Un perfil con Customer `REAL` exige `contractStatus: approved` y `authorizationBasis: customer_grant_verified`: condición necesaria, no suficiente (AP-05). Los modos sintéticos aceptan `candidate` y `service_scope_only` |
| Significado de "compra" | Hasta la aceptación de CP-J4-CONTEXT es **provisional**: variantes de órdenes con `valid = 1` evaluado al consultar; devoluciones **no** descontadas (CTX-05); unidades brutas (CTX-12); fecha de creación de la orden, zona sin verificar (CTX-09). No se congela antes de esa aceptación |

---

## 6. Capacidades Sales (DRAFT)

Comunes a ambas:
- READ; owner `customer`; scope `customer.read`;
- `identityRequirement: 'none'`: el control vive en el handler, porque la `identityAssurance` del harness no describe al cliente;
- `maxAttempts: 1`; `timeoutMs: 10 000`; `freshnessTtlMs: 600 000`;
- extractor ADR-030: `ownerValidUntil = (o) => o.identity === 'verified' ? o.validUntil : null`.

### 6.1 `customer.get_context@2`

```ts
input  = strictObject({})

output = union([
  strictObject({ identity: literal('unavailable'),
                 reason: enum(['anonymous', 'not_linked', 'not_verified', 'not_authorized', 'not_on_file', 'withheld']) }),
  strictObject({ identity: literal('verified'),
                 purchaseHistory: enum(['present', 'none', 'unknown']),
                 validUntil: timestamp }),        // obligatorio y no nulo (§7)
])
```

Sin `displayName`, sin antigüedad y sin ningún dato personal (D4 corregida). La capacidad solo dice si el cliente de la conversación está verificado y si tiene historial.

- `not_on_file` significa que CP no tiene el cliente (`not_found`).
- `withheld` significa que CP tiene información que no se divulga (AP-08, AP-09). **Nunca** se usa `not_on_file` para ocultar una cuenta existente.

Descripción para el modelo (borrador):

> Indica si el cliente de esta conversación tiene identidad verificada y si tiene historial de compras. No recibe argumentos. `unavailable` no impide ayudar ni cotizar como invitado. Con `withheld`, no especules sobre el motivo ni lo menciones.

### 6.2 `customer.get_purchase_history@1`

```ts
input  = strictObject({ offset: int().min(0).max(40).default(0),
                        limit:  int().min(1).max(10).default(5) })

output = union([
  /* misma variante unavailable que 6.1 */,
  strictObject({ identity: literal('verified'),
                 meaning: literal('purchased_historically_not_ownership'),
                 quantityBasis: literal('gross_units_not_net_of_returns'),
                 datePrecision: enum(['day', 'day_plus_minus_one']),
                 items: array(strictObject({ productName: string().min(1).max(120).nullable(),
                                             catalogKey: string().regex(CATALOG_KEY_PATTERN).nullable(),
                                             lastPurchasedOn: isoDate,
                                             totalQuantity: int().min(0),
                                             orderCount: int().min(1) })).max(10),
                 page: strictObject({ offset: int(), returned: int(), hasMore: boolean(), nextOffset: int().nullable() }),
                 validUntil: timestamp }),
])
```

- **Alcance:** como máximo 50 ítems (offset 0–40 más limit 10). `nextOffset` viene del puerto (`offset + page.returned` de CP) cuando `hasMore` y ese valor es ≤ 40; en otro caso es `null`. `returned` cuenta los ítems mostrados.
- **Nombres (frontera C):** un nombre de más de 120 code points se trunca de forma determinista a 119 más `…`, sin partir pares sustitutos. `null` se conserva; la descripción dice "producto sin nombre registrado". No se sustituye por el SKU ni por el nombre actual de Catalog.
- **Cantidades:** 0 es un valor válido. `quantityBasis` declara que son unidades brutas, no netas de devoluciones.
- **Fechas:** `datePrecision: day_plus_minus_one` mientras CP declare `timezoneStatus: unverified`. La descripción prohíbe afirmar el día exacto o la hora.
- **Filtro (AP-10):** se excluyen `administrative_service` y los `lineKind` desconocidos: un servicio administrativo no se presenta como equipamiento adquirido. `zero_price_line` **no** se excluye: un producto físico entregado gratis puede ser relevante. La clasificación y sus excepciones requieren aceptación comercial.
- **Por offset y no por cursor:** un cursor opaco podría transportar identidad (I1).
- **Estabilidad:** cada página es una observación con su propio `observedAt`. Una compra nueva entre páginas puede duplicar u omitir un ítem; la descripción lo advierte.
- **Vigencia de los datos:** `catalogKey: null` mientras D6 siga diferida. El modelo usa `catalog.search` para cualquier dato vigente (I8). La descripción dice que una compra pasada no implica posesión actual ni compatibilidad.

---

## 7. Estados, vigencia efectiva y mapeo

**Vigencia efectiva** (ADR-039 §6, verificada contra el runtime):

| Resultado | `validUntil` registrado |
|---|---|
| `verified` | `min(observedAt + 10 min, CP.validUntil ?? ∞, grant.expiresAt)`. El handler expone `min(CP.validUntil ?? ∞, grant.expiresAt)` como `output.validUntil`, siempre no nulo |
| `unavailable` | `observedAt + 10 min` (el extractor devuelve `null`) |
| Fallo o rechazo | `null`: freshness `unknown`; contiene solo el error |

Vencer **no** quita la observación del contexto de la tarea: con el default `include`, sigue como historia con payload, y siempre sigue persistida. Lo que se persiste es la **salida proyectada** (§6), nunca la respuesta de CP (ADR-039 §6, condición 4).

| # | Situación | Llamadas | Resultado |
|---|---|---|---|
| 1 | Sin binding de canal | ninguna | Respuesta `unavailable/anonymous` |
| 2 | Resolver: `not_linked` | resolver | Respuesta `unavailable/not_linked` |
| 3 | Resolver: `not_verified`, `ambiguous` o `conflicted` | resolver | Respuesta `unavailable/not_verified`. La telemetría distingue el `status` |
| 4 | Resolver: `not_authorized` | resolver | Respuesta `unavailable/not_authorized` |
| 5 | `verified` + CP 200 `available`, cuenta divulgable | ambos | Respuesta `verified` |
| 6 | `verified` + CP 200 `not_found` | ambos | Respuesta `unavailable/not_on_file` |
| 7 | `verified` + CP 200 `not_applicable`, o cuenta no divulgable (AP-09) | ambos | Respuesta `unavailable/withheld`. La telemetría registra el código de CP |
| 8 | `verified` + contexto `available` + `partial` sin indicador respaldado | ambos | Respuesta `verified`, `purchaseHistory: 'unknown'` |
| 9 | `verified` + historial con ítems no disponibles o incompletos | ambos | **Fallo** `temporarily_unavailable` (`history_unavailable`) |
| 10 | 401/403 del resolver o de CP | uno | **Fallo** `unauthorized`, sin reintento (I5) |
| 11 | 429, 503 (`degraded` de CP), 504, otro 5xx o red caída | uno | **Fallo** `temporarily_unavailable` |
| 12 | Deadline local | uno | **Fallo** `timeout` |
| 13 | Cuerpo inválido, `schemaVersion` ajeno, namespace ajeno, eco distinto, grant incoherente, componente fuera del propósito, campo sensible, orden violado o tamaño excedido | uno | **Fallo** `contract_violation` |

Los fallos (casos 9–13) **nunca** se convierten en `unavailable`. `not_found` (caso 6) nunca sustituye a un 401/403 (caso 10) ni a un error de integridad (caso 13).

---

## 8. Transporte, latencia y límites (DRAFT)

| Elemento | Valor propuesto |
|---|---|
| Identificadores fuera de URLs | `wa_id`, `accountRef` y `customerRef` viajan **en el cuerpo JSON** de peticiones `POST` de solo lectura, sin efectos. Ninguna ruta, query ni path los contiene. El grant viaja en un header (nombre según D2). Así no aparecen en access logs, proxies ni trazas HTTP (I6) |
| Ruta de CP | Una sola: `POST /v1/capabilities/customer/sales-context`, con `purpose` en el cuerpo (AP-01, AP-02). Respuesta con `Cache-Control: no-store` |
| Timeout del resolver | `R4_CUSTOMER_IDENTITY_TIMEOUT_MS`, 100–3 000 (sugerido 1 500) |
| Timeout de CP | `R4_CUSTOMER_PROFILE_TIMEOUT_MS`, **3 000–5 000** (sugerido 3 000). El presupuesto de la ruta en CP debe ser ≤ este timeout − 500 ms (hoy 2 500). Son presupuestos locales, no SLO productivos (AP-11) |
| Peor caso por invocación | ≤ 4,5 s con los valores sugeridos y ≤ 8 s con los máximos. Siempre menor que `timeoutMs` 10 000 |
| Tope de respuesta | Resolver 16 KiB; CP 64 KiB. **Medidos en bytes UTF-8** sobre el stream, con corte al superarlos (`response_too_large`). No en caracteres JavaScript (AP-07) |
| Tope de salida (JSON serializado, bytes UTF-8) | `get_context@2` ≤ 300 B; página de historial ≤ 8 KiB. Peor caso calculado: 10 ítems con nombres de 120 code points de 4 bytes y `catalogKey` de 64 caracteres ≈ 6,9 KB |
| Reintentos y caché | Ninguno |
| Variables | `R4_CUSTOMER_MODE`; `R4_CUSTOMER_IDENTITY_{BASE_URL,BEARER_TOKEN,TIMEOUT_MS}`; `R4_CUSTOMER_PROFILE_{BASE_URL,BEARER_TOKEN,TIMEOUT_MS}`. Fail-closed, https fuera de loopback, `R4_PROD_ALLOW_NETWORK`, sin credenciales en la URL |
| Headers salientes | `authorization: Bearer <servicio>`; grant (solo hacia CP); `x-correlation-id` = correlationId de la tarea; `accept`/`content-type: application/json` |
| Telemetría del adaptador | Nombre de operación (no la URL), propósito, `status` de resolución, estado HTTP, duración, categoría y código. Los mensajes de error nunca reproducen cuerpos |

---

## 9. Taxonomía de errores

Se reutiliza `DomainErrorCategory` (`adapters/domains/src/shared/errors.ts:18`) sin categorías nuevas. `domainRead` (`agents/sales/src/capabilities/common.ts:38-47`) ya traduce estas categorías a observaciones fallidas.

**Cuerpo de error de CP (AP-06):** plano, `{"error":"<code>"}`; el 503 lleva el envelope `degraded` con `statusDetail.code`. La **categoría** sale del status HTTP. El código del owner es diagnóstico: se valida contra un patrón antes de registrarse y nunca cambia la categoría. CP-09 (cuerpo anidado) queda retirado para CP.

| Origen | Categoría | Reintentable | Código R4 sugerido |
|---|---|---|---|
| 400, 413, 415 | `validation` | no | código del owner o `invalid_request` |
| 401/403 del resolver | `unauthorized` | no | `identity_unauthorized` |
| 401/403 de CP (incluye grant rechazado) | `unauthorized` | no | `profile_unauthorized` |
| 404, 405 y otros estados no contratados | `contract_violation` | no | `unexpected_status` |
| 429 | `temporarily_unavailable` | sí | `rate_limited` |
| 503 de CP (`degraded`: `prestashop_unavailable`, `prestashop_timeout`, `prestashop_schema_incompatible`) | `temporarily_unavailable` | sí | `profile_unavailable` (+ código del owner en telemetría) |
| 504 de CP (`request_budget_exceeded`) y otros 5xx | `temporarily_unavailable` | sí | código del owner o `*_unavailable` |
| Historial no disponible o incompleto | `temporarily_unavailable` | sí | `history_unavailable` |
| Red | `temporarily_unavailable` | sí | `*_unreachable` |
| Deadline | `timeout` | sí | `deadline_exceeded` |
| Contrato | `contract_violation` | no | `invalid_response`, `unsupported_schema_version`, `response_too_large`, `foreign_customer_ref`, `customer_ref_mismatch`, `incoherent_grant`, `purpose_minimization_violated`, `sensitive_field_present`, `order_violation`, `contract_not_approved`, `authorization_basis_insufficient` |

`retryable` se deriva de la categoría, como hoy. `maxAttempts: 1`: R4 no reintenta.

---

## 10. Minimización: qué cruza cada frontera

Tres fronteras (ADR-039 §7):
- **A.** El dominio factual de CP: J4 no lo restringe; CP conserva montos, componentes de gasto, derivados e ids.
- **B.** Lo que CP transmite a R4.
- **C.** Lo que R4 deja observar al modelo.

Que un dato no llegue a C **no** lo justifica en B.

| Dato | Resolver → R4 | CP → R4 (B) | R4 → modelo (C) | Logs, telemetría, URLs |
|---|---|---|---|---|
| `wa_id`, `accountRef` | R4 lo envía en el cuerpo | **Nunca** | No | No |
| `customerRef` | Sí | Eco: R4 verifica que sea igual al pedido y lo descarta. R4 lo envía en el cuerpo | No | No |
| Grant | Sí | No; R4 lo envía en un header | No | No |
| `masterCustomerId` | **No debe emitirlo** | No | No | No |
| Nombre, apellido, `displayName`, email, teléfono, RUT, dirección | — | **No** (`sensitive_field_present`) | No | No |
| Montos, componentes de gasto, derivados monetarios | — | **No en J4** (`purpose_minimization_violated`). Siguen en A | No | No |
| Referencias de pedido, ids PrestaShop de producto o cliente, SKU | — | **No en J4** (`purpose_minimization_violated`; D6 diferida) | No | No |
| RFM, cluster, CLV, affinity, intelligence, `commercial-profile` | — | **No** (scope dedicado; I12) | No | No |
| Antigüedad del cliente, primera compra, conteos de canceladas o reembolsadas, flags crudos de cuenta | — | No en J4 (sin uso) | No | No |
| Estado, completitud, `primaryState`, ciclo de vida, `authorizationBasis`, `timezoneStatus`, `limitations` | — | Sí | No: se traducen al estado de la salida, a `datePrecision` y a instrucciones | Solo códigos |
| Indicador de historial | — | Sí (`sales_context`) | Sí (`purchaseHistory`) | No |
| Ítems: nombre histórico (o `null`), `catalogKey` (`null`), día, unidades brutas, órdenes | — | Sí (`purchase_history`) | Sí | No |
| `lineKind` | — | Sí (`purchase_history`) | No: solo filtra (AP-10) | Código |
| `validUntil`, `schemaVersion` | — | Sí | `validUntil` | No |

**Controles:**

1. **Frontera B, primario:** composición por propósito en CP. En R4, validación con un esquema estructurado por propósito: un componente que el propósito no admite (montos, derivados, ids, SKU) da `purpose_minimization_violated`. **No** se usa una lista de prefijos de clave: `total*`, `amount*` o `price*` rechazan cantidades legítimas y dejan pasar montos con otros nombres (auditoría cruzada §9.2).
2. **Frontera C:** proyección por allowlist hacia el puerto y la salida. Los campos desconocidos se descartan: no se reenvían ni se registran.
3. **Defensa en profundidad:** fallo cerrado `sensitive_field_present` ante claves reconocibles de PII o predictivas, en cualquier nivel y sin distinguir mayúsculas: `firstname`, `lastname`, `displayName`, `email`, `phone`, `rut`, `address`, `orderReference`, `id_customer`, `customerId`, `rfm`, `cluster`, `clv`, `affinity`, `intelligence`. `productName` y `nameAtLastPurchase` están permitidos. La lista final se acuerda con CP.

---

## 11. Invariantes y pruebas de aceptación

Tipos: **C** contract · **U** unit · **I** integración (Postgres) · **E** E2E contra despliegues de integración **con datos sintéticos** (J4-R5) · **M** mutación.

| Inv. | Prueba de aceptación | Tipo |
|---|---|---|
| I1 | Las entradas son `strictObject` sin identificadores. `customerRef`, `customerId`, `phone`, `email`, `waId`, `cursor` y `subject` se rechazan con `invalid_arguments`, sin llamadas externas | C, U |
| I2 | Binding más `not_verified` (solo teléfono) da `unavailable/not_verified` y 0 llamadas a CP | U, I |
| I3 | Sin `verified`, o con un grant que no cubre `purchase_history`: 0 llamadas a CP para historial | U, M |
| I4 | (Repositorio de CP) Un grant de otro cliente, consumidor o propósito, o vencido, da 403 aunque el token de servicio sea válido | E (owner) |
| I5 | 401/403 terminan en fallo `unauthorized`; nunca `unavailable` ni `not_on_file` | U, M |
| I6 | Captura de logs, telemetría y URLs salientes de una invocación completa: no contiene token, grant, `wa_id`, `customerRef` ni datos personales. Ninguna URL saliente contiene `prestashop_customer` ni el `wa_id` | U, I |
| I7 | Con `@8`, y CP o el resolver caídos, lentos o con 403: cotización `guest` emitida en el runtime real | I, E |
| I8 | La salida lleva `meaning: purchased_historically_not_ownership`. La instrucción v8 prohíbe afirmar posesión o compatibilidad. Hay un caso de evaluación negativo | C, U |
| I9 | Las huellas `@1`–`@7`, los hashes de política y las versiones existentes no cambian | C |
| I10 | Un input de API, un texto con otro número o email y un workspace manipulado no cambian el sujeto enviado | I, M |
| I11 | Una respuesta con `crm_master_customer:` o un entero desnudo da `contract_violation`. El pack no accede a tablas de CRM | C, U |
| I12 | La allowlist de rutas del adaptador CP rechaza las rutas predictivas | C |
| D4 | La salida de `get_context@2` no admite ningún campo además de los del §6.1. Una respuesta de CP con un componente monetario, un id de PrestaShop o un SKU da `purpose_minimization_violated`; con una clave de PII o predictiva, `sensitive_field_present`. Una cantidad legítima con nombre `total*` **no** falla | C, U |
| D5 | `verified` se registra con `validUntil = min(10 min, CP, grant)`; `unavailable` con 10 min; un grant vencido al recibirlo da `incoherent_grant`; la observación vencida queda como historia (`include`) o excluida (`exclude`). La observación persistida contiene solo la salida proyectada | U |
| — | Estados (AP-08): 503 `degraded` de CP da fallo `temporarily_unavailable`; `partial` sin indicador da `unknown`; ítems no disponibles dan `history_unavailable`; `not_found` da `not_on_file`; `not_applicable`, eliminada, operacional, estado desconocido, guest e inactiva dan `withheld` y 0 ítems | U |
| — | `productName: null` y `totalQuantity: 0` se conservan; un nombre de más de 120 code points se trunca de forma determinista; una página con fechas crecientes da `order_violation`; los campos desconocidos no llegan a la salida ni a los logs; un eco de `customerRef` distinto da `customer_ref_mismatch` | U |
| — | `administrative_service` y `lineKind` desconocido se excluyen de la salida; `zero_price_line` se conserva | U |
| — | Tamaños en bytes UTF-8: las salidas serializadas respetan sus topes con 10 ítems de longitud máxima en caracteres de 4 bytes; una respuesta de CP de más de 64 KiB da `response_too_large` | U |
| — | Un perfil con Customer `REAL` falla con `contractStatus: candidate` (`contract_not_approved`) o `authorizationBasis: service_scope_only` (`authorization_basis_insufficient`); los modos sintéticos los aceptan | C, U |
| — | Sondeo cruzado sin fallos sobre todos los fixtures de CP, copiados con `ownerCommit` (gate F2, G-15) | C |
| — | `@8` no compone sin `R4_CUSTOMER_*` completo; `@7` compone sin esas variables | C |
| D7 | Procedimiento de J4-R5: lista de identidades sintéticas aprobada por el owner; 0 clientes reales procesados (verificado en los registros del canary) | E |

---

## 12. Compatibilidad y versionado

- **Sin cambios:** `customer.get_context@1`, `CustomerDirectory` y el fixture (referencia, shadow, evaluación).
- **Nuevos y aditivos:** los puertos y capacidades de este documento, la definición v8 (quita la mención de GAP-15) y `sales-production@8` con Customer `REAL` y `contractRef` a los contratos publicados.
- **Esquemas externos:** se fija la `schemaVersion` entera de cada owner. Un cambio rompiente produce `contract_violation` y requiere una versión nueva de la capacidad o del perfil.
- **Contrato de CP:** `customer-profile.sales-context`, `schemaVersion: 1`. J4-R2 se implementa contra el v1-rc de F2, que supera el gate del [registro](R4-J4-R1C_SHARED_DECISION_REGISTER.md) §6, **nunca** contra el candidato 02B (`f631f32`).
- **Paso de DRAFT a v1:** solo con contratos publicados con owner, versión, esquemas, SHA verificable y CP-J4-CONTEXT aceptado (J4-R1B).
