# R4-J4-R1 — Especificación del consumidor Customer de R4

| Campo | Valor |
|---|---|
| Estado | **DRAFT.** Diseño de consumidor; **no implementado**. Los esquemas externos son lo que R4 necesita, no contratos publicados. Cambiarán cuando los owners publiquen los suyos (J4-R1B) |
| Fecha | 2026-10-15 |
| Decisión marco | [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md) (propuesta) |
| Destinatarios | Owner de R4; equipos de Customer Service y Customer Profile (como especificación de lo que R4 consumirá) |

Las formas de tipos usan notación TypeScript/zod solo como lenguaje de especificación. No hay código asociado.

---

## 1. Alcance

| Incluido | Excluido |
|---|---|
| Puertos `CustomerIdentityResolver` y `CustomerProfilePort` | Implementación, adaptadores, migraciones, perfiles |
| Capacidades `customer.get_context@2` y `customer.get_purchase_history@1` | Cambios a `customer.get_context@1`, a `@1`–`@7` o al harness |
| Estados, errores, límites, frescura, minimización | Datos declarados por el cliente (GAP-05), RFM/predictivos, Customer Expansion |

---

## 2. Identificadores

| Identificador | Forma | Quién lo emite | Dónde vive en R4 | Visible para el modelo |
|---|---|---|---|---|
| Sujeto de canal | `{ channel, accountRef, subjectRef }` (WhatsApp: `whatsapp`, `phone_number_id`, `wa_id`) | R4 ChannelIngress | Binding de producción, existente | **No** |
| Referencia de cliente | `prestashop_customer:<id>`, con `id` en `^[1-9][0-9]{0,9}$` | Autoridad de identidad | Memoria de la invocación | **No** |
| Referencia de maestro | `crm_master_customer:<id>` | Autoridad de identidad | **Nunca entra a R4** (I11) | No |
| Grant | Opaco | Autoridad de identidad | Memoria de la invocación | **No** |
| Clave de producto | Clave de Catalog (`CATALOG_KEY_PATTERN`) o `null` | Catalog (D6) | Salida del historial | Sí |

Reglas:
- Si un puerto recibe una referencia de cliente en otro namespace, o un entero desnudo, responde `contract_violation`.
- R4 nunca construye una referencia a partir de otra: no hay conversión entre maestro y PrestaShop, ni deriva claves Catalog desde ids de PrestaShop.

---

## 3. Sujeto de canal

```ts
// DRAFT
type ChannelSubject = { readonly channel: string; readonly accountRef: string; readonly subjectRef: string };
```

- **Origen único:** `ProductionStore.bindingByTask(execution.taskId)`, que da `{ channel, accountRef, recipientRef }` (I10).
- Si no hay binding (tareas de referencia, shadow, evaluación o API sin canal), la respuesta es `identity: 'unavailable', reason: 'anonymous'` y no se hace ninguna llamada externa.
- **Nunca proviene de:** argumentos del modelo, inputs, transcript, workspace, memoria ni `task.requestedBy`.
- Se envía solo a la autoridad de identidad. **Nunca** a Customer Profile.

---

## 4. Puerto `CustomerIdentityResolver` (DRAFT)

```ts
type CustomerPurpose = 'sales_context' | 'purchase_history';

interface CustomerAccessGrant {
  readonly token: string;            // opaco: R4 no lo decodifica ni lo valida
  readonly expiresAt: string;        // instante declarado por la autoridad en la respuesta (campo, no claim parseado)
  readonly purposes: readonly CustomerPurpose[];
}

type IdentityResolution =
  | { readonly status: 'verified'; readonly customerRef: string; readonly grant: CustomerAccessGrant; readonly resolvedAt: string }
  | { readonly status: 'not_linked' | 'not_verified' | 'ambiguous' | 'conflicted' | 'not_authorized'; readonly resolvedAt: string };

interface CustomerIdentityResolver {
  resolve(subject: ChannelSubject, purposes: readonly CustomerPurpose[], options?: CallOptions): Promise<IdentityResolution>;
}
```

Semántica que R4 exige del owner (detalle en el documento de requisitos de Customer Service):

| `status` | Significado | `customerRef`/grant |
|---|---|---|
| `verified` | Vínculo verificado entre el sujeto y un cliente PrestaShop, con grant para **todos** los propósitos pedidos | Presentes |
| `not_linked` | El sujeto no tiene cliente vinculado | Ausentes |
| `not_verified` | Hay coincidencia o vínculo declarado, pero no verificado (p. ej., solo por teléfono) | Ausentes |
| `ambiguous` / `conflicted` | Más de un candidato o evidencia contradictoria | Ausentes |
| `not_authorized` | Vínculo verificado, pero la autoridad no emite grant para ese propósito (política, restricción u opt-out) | Ausentes |

Reglas adicionales:
- **Mínimo privilegio:** cada capacidad pide **solo su propósito** (`get_context@2` pide `sales_context`; el historial pide `purchase_history`).
- **Sin coherencia, no hay `verified`:** si la respuesta dice `verified` pero falta el grant, su `expiresAt` ya pasó o no cubre el propósito, se trata como `contract_violation`.

---

## 5. Puerto `CustomerProfilePort` (DRAFT)

```ts
interface CustomerSalesContext {
  readonly status: 'available' | 'not_found';
  readonly displayName: string | null;         // D4
  readonly customerSince: string | null;       // YYYY-MM
  readonly purchaseHistory: 'present' | 'none' | 'unknown';
  readonly validUntil: string | null;          // frescura declarada por CP
}

interface CustomerPurchasePage {
  readonly status: 'available' | 'not_found';
  readonly items: readonly {
    readonly productName: string;              // ≤ 120
    readonly catalogKey: string | null;        // D6; null mientras no exista un mapeo del owner
    readonly lastPurchasedOn: string;          // YYYY-MM-DD
    readonly totalQuantity: number;            // entero ≥ 1
    readonly orderCount: number;               // entero ≥ 1
  }[];
  readonly hasMore: boolean;
  readonly validUntil: string | null;
}

interface CustomerProfilePort {
  getSalesContext(customerRef: string, grant: CustomerAccessGrant, options?: CallOptions): Promise<CustomerSalesContext>;
  getPurchaseHistory(customerRef: string, grant: CustomerAccessGrant, page: { readonly offset: number; readonly limit: number }, options?: CallOptions): Promise<CustomerPurchasePage>;
}
```

Reglas:
- El puerto **no tiene** operaciones sin grant.
- No hay métodos de escritura.
- El adaptador no reordena, no filtra y no completa datos.
- Si el owner devuelve campos que esta forma no admite (email, montos, RFM…), el adaptador los descarta. Si devuelve campos obligatorios inválidos, responde `contract_violation`.

---

## 6. Capacidades Sales (DRAFT)

Comunes a ambas:
- READ;
- owner `customer`;
- scope `customer.read`;
- `identityRequirement: 'none'`: el control vive en el handler, porque la `identityAssurance` del harness no describe al cliente;
- `maxAttempts: 1`;
- `timeoutMs: 10 000`;
- `freshnessTtlMs: 600 000`;
- `ownerValidUntil(output) = output.validUntil` (ADR-030).

### 6.1 `customer.get_context@2`

```ts
input  = strictObject({})

output = union([
  strictObject({ identity: literal('unavailable'),
                 reason: enum(['anonymous', 'not_linked', 'not_verified', 'not_authorized', 'not_on_file']) }),
  strictObject({ identity: literal('verified'),
                 customer: strictObject({ displayName: string().max(80).nullable(),
                                          customerSince: string().regex(/^\d{4}-\d{2}$/).nullable(),
                                          purchaseHistory: enum(['present', 'none', 'unknown']) }),
                 validUntil: timestamp }),
])
```

Descripción para el modelo (borrador):

> Lee lo que se sabe del cliente de esta conversación, solo si su identidad está verificada. No recibe argumentos. `unavailable` no impide ayudar ni cotizar como invitado. Un historial existente no significa que el cliente aún tenga esos productos.

### 6.2 `customer.get_purchase_history@1`

```ts
input  = strictObject({ offset: int().min(0).max(40).default(0),
                        limit:  int().min(1).max(10).default(5) })

output = union([
  /* mismo variante unavailable que 6.1 */,
  strictObject({ identity: literal('verified'),
                 meaning: literal('purchased_historically_not_ownership'),
                 items: array(strictObject({ productName: string().max(120),
                                             catalogKey: string().regex(CATALOG_KEY_PATTERN).nullable(),
                                             lastPurchasedOn: isoDate,
                                             totalQuantity: int().min(1),
                                             orderCount: int().min(1) })).max(10),
                 page: strictObject({ offset: int(), returned: int(), hasMore: boolean(),
                                      nextOffset: int().nullable() }),
                 validUntil: timestamp }),
])
```

- **Alcance de la paginación:** como máximo 50 ítems (offset 0–40 más limit 10). `nextOffset = offset + returned` cuando `hasMore` y ese valor es ≤ 40; en otro caso es `null`.
- **Paginación por offset y no por cursor:** un cursor opaco podría transportar identidad (I1), y CP ya pagina por offset.
- **Estabilidad:** cada página es una observación con su propio `observedAt`. Una compra nueva entre páginas puede duplicar u omitir un ítem; la descripción para el modelo lo advierte.
- **Orden:** el del owner (última compra descendente). R4 no reordena.
- **Datos que R4 no infiere:** `catalogKey: null` mientras D6 no esté cerrada. El modelo debe usar `catalog.search` para cualquier dato vigente (I8).

---

## 7. Estados de identidad y autorización

Mapeo de cada caso al resultado de la capacidad. "Respuesta" = observación exitosa; "Fallo" = observación fallida con `error.details.category`.

| # | Situación | Llamadas | Resultado |
|---|---|---|---|
| 1 | Sin binding de canal | ninguna | Respuesta `unavailable/anonymous` |
| 2 | Resolver: `not_linked` | resolver | Respuesta `unavailable/not_linked` |
| 3 | Resolver: `not_verified`, `ambiguous` o `conflicted` | resolver | Respuesta `unavailable/not_verified`. La telemetría distingue el `status` |
| 4 | Resolver: `not_authorized` | resolver | Respuesta `unavailable/not_authorized` |
| 5 | Resolver `verified` + CP `available` | ambos | Respuesta `verified` |
| 6 | Resolver `verified` + CP `not_found` | ambos | Respuesta `unavailable/not_on_file` |
| 7 | Resolver o CP: 401/403 | uno | **Fallo** `unauthorized`, sin reintento (I5) |
| 8 | Resolver o CP: 429, 5xx, red caída | uno | **Fallo** `temporarily_unavailable` |
| 9 | Deadline local | uno | **Fallo** `timeout` |
| 10 | Cuerpo inválido, `schemaVersion` ajeno, namespace ajeno, `verified` sin grant válido | uno | **Fallo** `contract_violation` |
| 11 | CP: 200 con datos parciales (`degraded`) | ambos | Respuesta `verified` con campos `unknown`/`null`. Nunca se completa |

Los casos 7–10 **nunca** se convierten en `unavailable`. Si lo hicieran, quedaría registrada como verdad una ausencia de cliente durante el TTL.

---

## 8. Latencia, límites y configuración (DRAFT)

| Elemento | Valor propuesto | Motivo |
|---|---|---|
| Timeout del resolver | `R4_CUSTOMER_IDENTITY_TIMEOUT_MS`, 100–3 000 (sugerido 1 500) | Sigue el patrón de Catalog |
| Timeout de CP | `R4_CUSTOMER_PROFILE_TIMEOUT_MS`, 100–5 000 (sugerido 3 000) | El presupuesto de CP es 2 500 ms (EXT-CP `config.ts:151`) |
| Peor caso por invocación | ≤ 4,5 s (sugerido), menor que `timeoutMs` 10 000 | Margen para `bindingByTask` |
| Tope de respuesta del resolver / CP | 16 KB / 64 KB | Catalog usa 1 MB. Aquí las respuestas son pequeñas |
| Tope de salida de la capacidad (JSON serializado) | `get_context@2` ≤ 1 000 caracteres; página de historial ≤ 3 000 | Presupuesto de contexto (ADR-015); se verifica con test |
| Reintentos | Ninguno en el adaptador ni en la capacidad | El reintento es una nueva invocación del modelo |
| Caché | Ninguna | Se agregará solo si J4-R5 mide que hace falta |
| Variables | `R4_CUSTOMER_MODE` (`real` o sin definir); `R4_CUSTOMER_IDENTITY_{BASE_URL,BEARER_TOKEN,TIMEOUT_MS}`; `R4_CUSTOMER_PROFILE_{BASE_URL,BEARER_TOKEN,TIMEOUT_MS}` | Fail-closed, https fuera de loopback, `R4_PROD_ALLOW_NETWORK`, sin credenciales en URL. Longitud mínima del token según cada owner (CP: ≥ 43) |
| Headers salientes | `authorization: Bearer <servicio>`; grant en el header que defina el owner (D2); `x-correlation-id` = correlationId de la tarea; `accept: application/json` | La correlación permite auditar sin enviar refs a los logs |

---

## 9. Taxonomía de errores

Se reutiliza `DomainErrorCategory` (`adapters/domains/src/shared/errors.ts:18`) sin categorías nuevas.

| Origen | Categoría | Reintentable | Código R4 sugerido |
|---|---|---|---|
| 400 | `validation` | no | código del owner o `invalid_request` |
| 401 / 403 del resolver | `unauthorized` | no | `identity_unauthorized` |
| 401 / 403 de CP (incluye grant rechazado) | `unauthorized` | no | `profile_unauthorized` |
| 404 de ruta y otros estados no contratados | `contract_violation` | no | `unexpected_status` |
| 429 | `temporarily_unavailable` | sí | `rate_limited` |
| 5xx, 503, 504 | `temporarily_unavailable` | sí | código del owner o `*_unavailable` |
| Red | `temporarily_unavailable` | sí | `*_unreachable` |
| Deadline | `timeout` | sí | `deadline_exceeded` |
| JSON inválido, esquema, `schemaVersion`, tamaño, namespace, grant incoherente | `contract_violation` | no | `invalid_response`, `unsupported_schema_version`, `response_too_large`, `foreign_customer_ref`, `incoherent_grant` |

`domainRead` (`agents/sales/src/capabilities/common.ts:38-47`) ya traduce estas categorías a observaciones fallidas.

---

## 10. Datos personales

| Dato | Resolver → R4 | CP → R4 | R4 → modelo | Logs y telemetría |
|---|---|---|---|---|
| `wa_id`, `accountRef` | R4 lo envía | **Nunca** | No | No |
| `customerRef` | Sí | Sí (como parámetro) | No | No |
| Grant | Sí | Sí (header) | No | No |
| `masterCustomerId` | No debe enviarse | No | No | No |
| Nombre visible | — | `displayName` | D4 (propuesta: sí, ≤ 80 caracteres; redactado para jueces de evaluación) | No |
| Email, teléfono, RUT, dirección | — | **No debe enviarse**; se descarta | No | No |
| Montos, referencias de pedido, ids PrestaShop de producto | — | No debe enviarse; se descarta | No | No |
| Cliente desde (mes) | — | Sí | Sí | No |
| Productos comprados (nombre, clave Catalog, fecha, cantidades) | — | Sí | Sí | No |
| RFM, cluster, CLV, affinity, intelligence | — | **Ruta no alcanzable** (I12) | No | No |

Lo que contiene la telemetría por llamada: operación, propósito, `status` de la resolución, estado HTTP, duración, categoría y código de error, `correlationId`. **Nunca** refs, grant, sujeto ni cuerpos (I6).

---

## 11. Invariantes y pruebas de aceptación

Invariantes según ADR-039. Tipos de prueba: **C** contract, **U** unit, **I** integración con Postgres, **E** E2E contra despliegues de integración (J4-R5), **M** mutación (quitar la guarda debe romper al menos un test).

| Inv. | Prueba de aceptación | Tipo |
|---|---|---|
| I1 | Los esquemas de entrada son `strictObject` sin identificadores. Los argumentos `customerRef`, `customerId`, `phone`, `email`, `waId`, `cursor` y `subject` se rechazan con `invalid_arguments`. Un argumento rechazado no produce llamadas al resolver ni a CP | C, U |
| I2 | Con un binding y una resolución `not_verified` (solo teléfono), el resultado es `unavailable/not_verified` y no se llama a CP | U, I |
| I3 | Sin `verified`, o con un grant que no cubre `purchase_history`: 0 llamadas a CP para historial | U, M |
| I4 | (CP, en su repo) Un grant de otro cliente, de otro consumidor, de otro propósito o vencido produce 403, aunque el token de servicio sea válido | E (owner) |
| I5 | 401/403 del resolver o de CP terminan en observación fallida `unauthorized`, nunca en `unavailable` ni `not_on_file` | U, M |
| I6 | Captura de logs y telemetría de una invocación completa: no contiene el token de servicio, el grant, el `wa_id`, el `customerRef`, el email ni el nombre (patrón de `cli/production.ts:277`) | U, I |
| I7 | Con `@8`, CP o el resolver caídos, lentos o con 403: `catalog.search`, `shipping.quote`, `quote.preview@3` y `quote.create@5` emiten una cotización `guest` en el runtime real | I, E |
| I8 | La salida del historial lleva `meaning: purchased_historically_not_ownership`. La instrucción v8 prohíbe afirmar posesión o compatibilidad. Hay un caso de evaluación negativo | C, U |
| I9 | Las huellas de `@1`–`@7`, los hashes de política y las versiones `customer.get_context@1`, `quote.*` existentes no cambian (tests en `tests/contract/sales-*`) | C |
| I10 | Un input inyectado por `POST /v1/tasks/:id/inputs`, un texto del cliente con otro número o email y un workspace manipulado no cambian el sujeto enviado al resolver | I, M |
| I11 | Una respuesta del resolver con `crm_master_customer:` o con un entero desnudo produce `contract_violation`. Ningún código del pack accede a tablas de CRM (test de dependencias) | C, U |
| I12 | La allowlist de rutas del adaptador CP rechaza `rfm`, `cluster`, `clv`, `affinity`, `intelligence`, `commercial-profile`, `copilot` y `audiences` | C |
| — | Las salidas serializadas respetan sus topes (1 000 / 3 000 caracteres) con 10 ítems de longitud máxima | U |
| — | Una observación vence en `min(TTL, validUntil)` y el contexto la clasifica `expired` | U |
| — | La composición de `@8` sin `R4_CUSTOMER_*` completo se niega a arrancar; `@7` compone sin esas variables | C |

---

## 12. Compatibilidad y versionado

- **Sin cambios:** `customer.get_context@1`, `CustomerDirectory` y el fixture (referencia, shadow, evaluación).
- **Nuevos y aditivos:** los puertos y las capacidades de este documento, la definición Sales v8 (además, quita la mención huérfana de GAP-15) y `sales-production@8` con Customer `REAL` y `contractRef` a los contratos publicados. Pin `@8 → 8`.
- **Esquemas externos:** se fija la `schemaVersion` entera de cada owner. Un cambio rompiente del owner produce `contract_violation` y requiere una nueva versión de la capacidad o del perfil.
- **Este documento pasa de DRAFT a versión 1** solo cuando existan contratos publicados con owner, versión, esquemas y SHA verificables (J4-R1B).
