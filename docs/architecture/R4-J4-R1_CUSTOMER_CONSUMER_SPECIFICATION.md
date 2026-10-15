# R4-J4-R1 — Especificación del consumidor Customer de R4

| Campo | Valor |
|---|---|
| Estado | **DRAFT, revisado (R4-J4-R1A-REVIEW-01).** Diseño de consumidor; **no implementado**. Los esquemas externos son lo que R4 necesita, no contratos publicados. Cambiarán cuando los owners publiquen los suyos (J4-R1B) |
| Fecha | 2026-10-15. Versión previa a la revisión: commit `b680b2c` |
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
| Clave de producto | Clave Catalog (`CATALOG_KEY_PATTERN`) o `null` | Catalog (D6) | Salida del historial | Sí |

Reglas:
- Una referencia de cliente en otro namespace, o un entero desnudo, es `contract_violation` (`foreign_customer_ref`).
- R4 nunca construye una referencia a partir de otra.

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
- Cada capacidad pide **solo su propósito**.
- Una respuesta `verified` es incoherente, y por tanto `contract_violation` (`incoherent_grant`), si:
  - falta el grant;
  - `expiresAt ≤ ahora` según el reloj de R4;
  - los propósitos no cubren el pedido.

---

## 5. Puerto `CustomerProfilePort` (DRAFT)

```ts
interface CustomerSalesContext {
  readonly status: 'available' | 'not_found' | 'degraded';
  readonly purchaseHistory: 'present' | 'none' | 'unknown';   // 'unknown' obligatorio si status = degraded
  readonly validUntil: string | null;                          // frescura declarada por CP; null = no declara
}

interface CustomerPurchaseItem {
  readonly productName: string;              // 1–120
  readonly catalogKey: string | null;        // D6; null mientras no exista un mapeo del owner
  readonly lastPurchasedOn: string | null;   // fecha calendario (zona del owner, CTX-09); null = desconocida
  readonly totalQuantity: number | null;     // entero ≥ 1; null = desconocida (nunca 0 para "desconocida")
  readonly orderCount: number | null;        // entero ≥ 1; null = desconocido
}

interface CustomerPurchasePage {
  readonly status: 'available' | 'not_found' | 'degraded';
  readonly items: readonly CustomerPurchaseItem[];   // vacío si status ≠ available
  readonly hasMore: boolean;
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
| Sin grant | El puerto no tiene operaciones sin grant ni métodos de escritura |
| `degraded` en contexto | Significa que CP respondió, pero no pudo establecer todos los hechos. Se mapea a `verified` con `purchaseHistory: 'unknown'`. Nunca se completa |
| `degraded` en historial | **No se presenta como una lista parcial.** Se mapea a fallo `temporarily_unavailable` (`history_degraded`) |
| Cantidades y fechas desconocidas | `null` explícito. El adaptador no sustituye `null` por 0 ni por una fecha |
| Orden | Lo declara el owner y es total. Propuesta: última compra descendente, `null` al final, y desempates internos estables (hoy CP usa `last_purchased_at DESC, product_id DESC, product_attribute_id DESC`). R4 no reordena; el adaptador verifica que las fechas no nulas de una página no crecen (si crecen, `contract_violation`) |
| Campos adicionales | Los desconocidos se descartan: no se reenvían ni se registran. Agregar campos no rompe el contrato |
| Datos sensibles | Si aparece una clave prohibida (nombre, email, teléfono, RUT, dirección, montos, referencias de pedido, ids PrestaShop o predictivos; lista en §10), el resultado es `contract_violation` (`sensitive_field_present`): el owner rompió la minimización y R4 falla cerrado |
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
                 reason: enum(['anonymous', 'not_linked', 'not_verified', 'not_authorized', 'not_on_file']) }),
  strictObject({ identity: literal('verified'),
                 purchaseHistory: enum(['present', 'none', 'unknown']),
                 validUntil: timestamp }),        // obligatorio y no nulo (§7)
])
```

Sin `displayName`, sin antigüedad y sin ningún dato personal (D4 corregida). La capacidad solo dice si el cliente de la conversación está verificado y si tiene historial.

Descripción para el modelo (borrador):

> Indica si el cliente de esta conversación tiene identidad verificada y si tiene historial de compras. No recibe argumentos. `unavailable` no impide ayudar ni cotizar como invitado.

### 6.2 `customer.get_purchase_history@1`

```ts
input  = strictObject({ offset: int().min(0).max(40).default(0),
                        limit:  int().min(1).max(10).default(5) })

output = union([
  /* misma variante unavailable que 6.1 */,
  strictObject({ identity: literal('verified'),
                 meaning: literal('purchased_historically_not_ownership'),
                 items: array(strictObject({ productName: string().min(1).max(120),
                                             catalogKey: string().regex(CATALOG_KEY_PATTERN).nullable(),
                                             lastPurchasedOn: isoDate.nullable(),
                                             totalQuantity: int().min(1).nullable(),
                                             orderCount: int().min(1).nullable() })).max(10),
                 page: strictObject({ offset: int(), returned: int(), hasMore: boolean(), nextOffset: int().nullable() }),
                 validUntil: timestamp }),
])
```

- **Alcance:** como máximo 50 ítems (offset 0–40 más limit 10). `nextOffset = offset + returned` cuando `hasMore` y ese valor es ≤ 40; en otro caso es `null`.
- **Por offset y no por cursor:** un cursor opaco podría transportar identidad (I1).
- **Estabilidad:** cada página es una observación con su propio `observedAt`. Una compra nueva entre páginas puede duplicar u omitir un ítem; la descripción lo advierte.
- **Vigencia de los datos:** `catalogKey: null` mientras D6 no esté cerrada. El modelo usa `catalog.search` para cualquier dato vigente (I8). La descripción dice que una compra pasada no implica posesión actual ni compatibilidad.

---

## 7. Estados, vigencia efectiva y mapeo

**Vigencia efectiva** (ADR-039 §6, verificada contra el runtime):

| Resultado | `validUntil` registrado |
|---|---|
| `verified` | `min(observedAt + 10 min, CP.validUntil ?? ∞, grant.expiresAt)`. El handler expone `min(CP.validUntil ?? ∞, grant.expiresAt)` como `output.validUntil`, siempre no nulo |
| `unavailable` | `observedAt + 10 min` (el extractor devuelve `null`) |
| Fallo o rechazo | `null`: freshness `unknown`; contiene solo el error |

Vencer **no** quita la observación del contexto de la tarea: con el default `include`, sigue como historia con payload, y siempre sigue persistida.

| # | Situación | Llamadas | Resultado |
|---|---|---|---|
| 1 | Sin binding de canal | ninguna | Respuesta `unavailable/anonymous` |
| 2 | Resolver: `not_linked` | resolver | Respuesta `unavailable/not_linked` |
| 3 | Resolver: `not_verified`, `ambiguous` o `conflicted` | resolver | Respuesta `unavailable/not_verified`. La telemetría distingue el `status` |
| 4 | Resolver: `not_authorized` | resolver | Respuesta `unavailable/not_authorized` |
| 5 | `verified` + CP `available` | ambos | Respuesta `verified` |
| 6 | `verified` + CP `not_found` | ambos | Respuesta `unavailable/not_on_file` |
| 7 | `verified` + contexto CP `degraded` | ambos | Respuesta `verified`, `purchaseHistory: 'unknown'` |
| 8 | `verified` + historial CP `degraded` | ambos | **Fallo** `temporarily_unavailable` (`history_degraded`) |
| 9 | 401/403 del resolver o de CP | uno | **Fallo** `unauthorized`, sin reintento (I5) |
| 10 | 429, 5xx o red caída | uno | **Fallo** `temporarily_unavailable` |
| 11 | Deadline local | uno | **Fallo** `timeout` |
| 12 | Cuerpo inválido, `schemaVersion` ajeno, namespace ajeno, grant incoherente, campo sensible u orden violado | uno | **Fallo** `contract_violation` |

Los fallos (casos 8–12) **nunca** se convierten en `unavailable`.

---

## 8. Transporte, latencia y límites (DRAFT)

| Elemento | Valor propuesto |
|---|---|
| Identificadores fuera de URLs | `wa_id`, `accountRef` y `customerRef` viajan **en el cuerpo JSON** de peticiones `POST` de solo lectura, sin efectos. Ninguna ruta, query ni path los contiene. El grant viaja en un header (nombre según D2). Así no aparecen en access logs, proxies ni trazas HTTP (I6) |
| Timeout del resolver | `R4_CUSTOMER_IDENTITY_TIMEOUT_MS`, 100–3 000 (sugerido 1 500) |
| Timeout de CP | `R4_CUSTOMER_PROFILE_TIMEOUT_MS`, 100–5 000 (sugerido 3 000) |
| Peor caso por invocación | ≤ 4,5 s, menor que `timeoutMs` 10 000 |
| Tope de respuesta | Resolver 16 KB; CP 64 KB |
| Tope de salida (JSON serializado) | `get_context@2` ≤ 300 caracteres; página de historial ≤ 3 000 |
| Reintentos y caché | Ninguno |
| Variables | `R4_CUSTOMER_MODE`; `R4_CUSTOMER_IDENTITY_{BASE_URL,BEARER_TOKEN,TIMEOUT_MS}`; `R4_CUSTOMER_PROFILE_{BASE_URL,BEARER_TOKEN,TIMEOUT_MS}`. Fail-closed, https fuera de loopback, `R4_PROD_ALLOW_NETWORK`, sin credenciales en la URL |
| Headers salientes | `authorization: Bearer <servicio>`; grant (solo hacia CP); `x-correlation-id` = correlationId de la tarea; `accept`/`content-type: application/json` |
| Telemetría del adaptador | Nombre de operación (no la URL), propósito, `status` de resolución, estado HTTP, duración, categoría y código. Los mensajes de error nunca reproducen cuerpos |

---

## 9. Taxonomía de errores

Se reutiliza `DomainErrorCategory` (`adapters/domains/src/shared/errors.ts:18`) sin categorías nuevas. `domainRead` (`agents/sales/src/capabilities/common.ts:38-47`) ya traduce estas categorías a observaciones fallidas.

| Origen | Categoría | Reintentable | Código R4 sugerido |
|---|---|---|---|
| 400 | `validation` | no | código del owner o `invalid_request` |
| 401/403 del resolver | `unauthorized` | no | `identity_unauthorized` |
| 401/403 de CP (incluye grant rechazado) | `unauthorized` | no | `profile_unauthorized` |
| 404 de ruta y otros estados no contratados | `contract_violation` | no | `unexpected_status` |
| 429 | `temporarily_unavailable` | sí | `rate_limited` |
| 5xx, 503, 504 | `temporarily_unavailable` | sí | código del owner o `*_unavailable` |
| Historial `degraded` | `temporarily_unavailable` | sí | `history_degraded` |
| Red | `temporarily_unavailable` | sí | `*_unreachable` |
| Deadline | `timeout` | sí | `deadline_exceeded` |
| Contrato | `contract_violation` | no | `invalid_response`, `unsupported_schema_version`, `response_too_large`, `foreign_customer_ref`, `incoherent_grant`, `sensitive_field_present`, `order_violation` |

---

## 10. Datos personales: qué emite cada parte

| Dato | Resolver → R4 | CP → R4 (puede emitir) | R4 → modelo | Logs, telemetría, URLs |
|---|---|---|---|---|
| `wa_id`, `accountRef` | R4 lo envía en el cuerpo | **Nunca** | No | No |
| `customerRef` | Sí | No lo emite; R4 lo envía en el cuerpo | No | No |
| Grant | Sí | No; R4 lo envía en un header | No | No |
| `masterCustomerId` | **No debe emitirlo** | No | No | No |
| Nombre, apellido, `displayName` | — | **No** (sensible → `contract_violation`) | No | No |
| Email, teléfono, RUT, dirección | — | **No** (sensible → `contract_violation`) | No | No |
| Montos, referencias de pedido, ids PrestaShop de producto o cliente | — | **No** (sensible → `contract_violation`) | No | No |
| RFM, cluster, CLV, affinity, intelligence | — | **No** (ruta no alcanzable, I12) | No | No |
| Estado de respuesta, indicador de historial, `validUntil`, `schemaVersion` | — | Sí | Indicador y `validUntil` | Solo `status` |
| Ítems del historial: nombre de producto, clave Catalog, fecha, cantidades | — | Sí | Sí | No |

Claves prohibidas para la comprobación `sensitive_field_present` (en cualquier nivel, sin distinguir mayúsculas): `name`, `firstname`, `lastname`, `displayName`, `email`, `phone`, `rut`, `address`, `total*`, `amount*`, `price*`, `reference`, `orderReference`, `id_customer`, `customerId`, `productId`, `productAttributeId`, `rfm`, `cluster`, `clv`, `affinity`. `productName` está permitido. La lista final se acuerda con CP.

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
| D4 | La salida de `get_context@2` no admite ningún campo además de los del §6.1. Una respuesta de CP con una clave prohibida da `contract_violation` | C, U |
| D5 | `verified` se registra con `validUntil = min(10 min, CP, grant)`; `unavailable` con 10 min; un grant vencido al recibirlo da `incoherent_grant`; la observación vencida queda como historia (`include`) o excluida (`exclude`) | U |
| — | `degraded`: el contexto da `unknown`; el historial da fallo `history_degraded` | U |
| — | `null` en cantidades y fechas se conserva; una página con fechas crecientes da `order_violation`; los campos desconocidos no llegan a la salida | U |
| — | Las salidas serializadas respetan sus topes con 10 ítems de longitud máxima | U |
| — | `@8` no compone sin `R4_CUSTOMER_*` completo; `@7` compone sin esas variables | C |
| D7 | Procedimiento de J4-R5: lista de identidades sintéticas aprobada por el owner; 0 clientes reales procesados (verificado en los registros del canary) | E |

---

## 12. Compatibilidad y versionado

- **Sin cambios:** `customer.get_context@1`, `CustomerDirectory` y el fixture (referencia, shadow, evaluación).
- **Nuevos y aditivos:** los puertos y capacidades de este documento, la definición v8 (quita la mención de GAP-15) y `sales-production@8` con Customer `REAL` y `contractRef` a los contratos publicados.
- **Esquemas externos:** se fija la `schemaVersion` entera de cada owner. Un cambio rompiente produce `contract_violation` y requiere una versión nueva de la capacidad o del perfil.
- **Paso de DRAFT a v1:** solo con contratos publicados con owner, versión, esquemas, SHA verificable y CP-J4-CONTEXT aceptado (J4-R1B).
