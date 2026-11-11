# R4-J5 — Clasificación de errores de Customer Profile

| Campo | Valor |
|---|---|
| Mandato | owner, "J5 — Customer Profile error classification" |
| Rama | `fix/r4-j5-customer-profile-error-classification` (base `origin/main` 09d6579) |
| Alcance | sólo R4; el repo de Customer Profile no se toca; sin despliegue ni EC2 |
| Datos | sintéticos |
| Estado | implementado y probado localmente; **cambio de harness y de contrato Core: requiere revisión independiente** |

## 1. Evidencia

Canary J4-R5 (EC2, 2026-10-26, datos sintéticos): worker `sales-production@8`, Customer Profile S5
(CP bbd766e) en `127.0.0.1:13011`, modo `enforce`, grant requerido. Con el proceso CP detenido
(TCP rechazado), `customer.get_context` produjo:

```
capability.invocation.completed { capabilityId: customer.get_context, outcome: failed, errorCode: handler_error }
```

Tras reiniciar CP la misma llamada tuvo éxito. La respuesta del agente fue aceptable; el código de
plataforma no estaba tipado.

## 2. Causa raíz

La clasificación **no** se perdía en el adaptador. `CustomerProfileHttpClient` ya clasificaba el
rechazo TCP como `DomainError('temporarily_unavailable', 'profile_unreachable')`
(`adapters/domains/customer/http/src/client.ts:166-168`), y `domainRead` lo convertía en
`CapabilityFailure` con `details.category` (`agents/sales/src/capabilities/common.ts:43`, versión base).

El tipo se perdía en el harness:

1. `packages/capability-runtime/src/invoker.ts:186` (base) — todo error lanzado por un handler,
   incluido un `CapabilityFailure` ya clasificado, se registraba con `error.code = 'handler_error'`;
   la clase sólo viajaba en `error.details`.
2. `packages/capability-runtime/src/invoker.ts:138` — la telemetría `capability.invocation.completed`
   emite sólo `errorCode: recorded.error?.code`, sin `details`. Resultado: `handler_error`.
3. Agravante: la composición de producción (`agents/sales/src/production/composition.ts:232`, base)
   no conectaba `onProfileCall`/`onIdentityCall`, así que la telemetría propia del adaptador
   (`owner_call` con `errorCategory`/`errorCode`) no llegaba al log del worker.

Hallazgo adicional (exposición al modelo): `domainRead` copiaba al `observation.error` — que el
compilador de contexto entrega íntegro al modelo (`packages/context-compiler/src/sources/platform.ts:281`) —
el mensaje del adaptador y sus diagnósticos, p. ej. `"Customer Profile could not be reached (ECONNREFUSED)"`,
`"Customer Profile refused R4's credential (HTTP 401)"`, `httpStatus`, `ownerCode`, `requiredScope`.

## 3. Clasificación

Se reutilizan las categorías existentes de `DomainError` (`adapters/domains/src/shared/errors.ts`);
no se crea una taxonomía paralela. Sólo se agrega su proyección a códigos de observación genéricos.

| Situación CP | Adaptador (sin cambios) | `observation.error.code` | Mensaje al modelo |
|---|---|---|---|
| conexión rechazada / DNS / reset | `temporarily_unavailable` · `profile_unreachable` | `dependency_unavailable` | the capability owner is temporarily unavailable |
| 5xx, 503 no degradado o degradado, 429 | `temporarily_unavailable` · `profile_unavailable` / código owner / `rate_limited` | `dependency_unavailable` | ídem |
| deadline del adaptador o del llamador | `timeout` · `deadline_exceeded` | `dependency_timeout` | the capability owner did not answer in time |
| 401 / 403 (incl. `grant_rejected`) | `unauthorized` · `profile_unauthorized` | `dependency_unauthorized` | the capability owner refused the platform credential |
| 200 no JSON, fuera de contrato, 3xx/404/405, > 64 KiB | `contract_violation` · `invalid_response` / `unexpected_status` / … | `dependency_contract_violation` | the capability owner answered outside its contract |
| `validation`, `not_found`, `conflict`, `unknown_outcome` | sin cambios | `handler_error` (sin cambios, con detalles del owner) | mensaje del owner |
| timeout del propio invoker (`timeoutMs` de la capability) | — | `timeout` (sin cambios) | sin cambios |

Para las cuatro clases de dependencia, `error.details` queda en `{ category, code, retryable }`
(`code` es el código acotado del adaptador). HTTP status, código del owner, scope requerido, host,
código de transporte y mensajes del proveedor ya no llegan a la observación; quedan en la telemetría
`owner_call` del adaptador, ahora conectada al log del worker (`customer_profile.call`,
`customer_identity.call`; sin token, `customerRef`, grant ni cuerpo, por contrato del adaptador).

## 4. Cambios

| Archivo | Cambio |
|---|---|
| `packages/contracts/src/capability.ts` | `DEPENDENCY_FAILURE_CODES` (4 códigos genéricos), agregados a `CAPABILITY_FAILURE_CODES` (aditivo). **Contrato Core.** |
| `packages/capability-runtime/src/invoker.ts` | `CapabilityFailure` acepta un `code` opcional (`DependencyFailureCode`, por defecto `handler_error`); el invoker lo usa. **Harness — requiere revisión independiente.** |
| `agents/sales/src/capabilities/common.ts` | `domainRead` proyecta las 4 categorías de dependencia a código tipado, mensaje fijo y detalles mínimos. Aplica a todos los READ de Sales sobre puertos de dominio (Customer, CIA vía `revalidatedRead`, Catalog, Shipping, Quote preview): un solo punto, misma regla. |
| `agents/sales/src/production/composition.ts` | conecta `onIdentityCall` / `onProfileCall` al logger del worker. |

Sin migraciones (`error_code` es `text` sin CHECK de enumeración), sin cambios en el repo CP, en el
adaptador CP, en definiciones `sales.v*.agent.json` ni en `profile-*.ts`.

## 5. Pruebas

Nuevas:

- `tests/unit/sales/customer-profile-error-classification.test.ts` (12): adaptador CP real +
  `customer.get_context@3` real + invoker real + logger que captura telemetría. Casos: ECONNREFUSED,
  ENOTFOUND, 401, 403, 403 `grant_rejected`, 200 no JSON, 200 fuera de contrato, 500, 502, 503 no
  degradado, deadline del adaptador, y **un puerto TCP real cerrado con `fetch` real** (el caso del
  canary). Cada uno verifica `error.code` tipado, `errorCode` tipado en `capability.invocation.completed`,
  mensaje fijo, `details` = `{category, code, retryable}` y ausencia de host, puerto, código de
  transporte, `HTTP`, `httpStatus`, `ownerCode`, `requiredScope`, token, grant y `customerRef`.
  Antes del fix: 12/12 fallaban con `handler_error`.
- `tests/unit/capability-runtime/invoker.test.ts` (+4): `CapabilityFailure` con código de dependencia
  produce ese código y una observación válida.

Actualizadas (consecuencia esperada, misma regla para Catalog):
`tests/unit/sales/catalog-capabilities.test.ts`, `tests/unit/sales/domain-fixtures.test.ts`
(`handler_error` → `dependency_*`) y `tests/integration/sales-profile-v8.test.ts` (código persistido exacto).

Resultados: ver §7.

## 6. Residuales

- **R-1 despliegue coordinado.** El enum de `observation.error.code` crece: un worker anterior que lea
  una observación nueva desde la base fallaría su validación. Todos los workers deben actualizarse a la vez
  (hoy hay uno por entorno).
- **R-2 escrituras.** `action-executor.ts:192` sigue registrando `handler_error` para un write que lanza;
  allí el resultado es `unknown` y la semántica es distinta. Fuera de alcance.
- **R-3 Catalog/Quote/Shipping.** También cambian de código (mismo `domainRead`). No hay evaluadores ni
  dashboards en el repo que dependan de `handler_error` para esos casos (búsqueda en `agents/`, `packages/`).
- **R-4 ADR.** ADR-023 afirma que ningún contrato Core cambió con `CapabilityFailure`; este cambio
  aditivo debería registrarse en un ADR o enmienda si el owner lo acepta.
- **R-5 validación real.** No re-ejecutado en EC2 (no autorizado); validar en el próximo canary que
  `errorCode: dependency_unavailable` y `customer_profile.call` aparecen con CP detenido.

## 7. Resultados

Ejecutado localmente en el worktree (Windows, PostgreSQL Docker `127.0.0.1:55432`), 2026-10-26:

| Suite | Resultado |
|---|---|
| `npm run lint` | 0 problemas |
| `npm run typecheck` | sin errores |
| `npm run test:unit` | 86 archivos (1 omitido) · 1535 passed, 4 skipped |
| `npm run test:contract` | 33 archivos · 450 passed |
| `npm run test:sales` | 4 archivos · 29 passed |
| integración (archivo por archivo) | 9 archivos · 106 passed, 12 skipped (`catalog-http-real`, opt-in) |

Integración: `customer-rr1-revalidation` 2, `sales-profile-v8` 3, `binding-identity-immutability` 19,
`sales-canary-j4` 6, `worker-kernel` 19, `sales-autonomous-quote` 20, `sales-confirmed-intent-quote` 22,
`identity-verification-commercial` 15, `catalog-http-real` 12 skipped. `sales-profile-v8` ahora exige
`error_code = 'dependency_unavailable'` persistido en `observations` con CP en 503 (antes `any(String)`).
Una primera corrida en paralelo de esos archivos falló por timeouts y `57P01` (conexiones terminadas por
otra sesión sobre la misma base compartida); archivo por archivo, todos pasan. `test:recovery` no se ejecutó.
