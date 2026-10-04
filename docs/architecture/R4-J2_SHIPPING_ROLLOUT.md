# R4-J2 — Shipping: estado y rollout

Fecha: 2026-10-03

| Tramo | Estado | Evidencia |
|---|---|---|
| J2A — auditoría del owner pc-carrier | **CERRADO** | `R4-J2A_SHIPPING_OWNER_AUDIT.md` |
| J2B — adapter de producción | **CERRADO** (PR #4) | ADR-032, `@r4-adapters/shipping-http` |
| J2C — capability `shipping.quote` + composición con Catalog | **CERRADO** (PR #4) | ADR-032 §5–§10 |
| J2D — activación en producción | **IMPLEMENTADO — despliegue PENDIENTE** | este documento |

Producción **no** está validada para Shipping: nada de J2D se ha desplegado.

## 1. Qué es `sales-production@3`

```
sales-production@3
  = sales-production@2
  + Sales definition v4
  + Shipping REAL (pc-carrier, sólo lectura)
  + shipping.quote (READ, reason read_real)
```

| Dominio | v1 | v2 | v3 |
|---|---|---|---|
| catalog | UNAVAILABLE | REAL | REAL |
| shipping | UNAVAILABLE | UNAVAILABLE | **REAL** |
| customer | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE |
| quote | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE |
| sales-workspace | INTERNAL | INTERNAL | INTERNAL |
| definición Sales | sales@3 | sales@3 | **sales@4** |

Escrituras y gobernanza sin cambios: `sales.workspace.update` ALLOW; `quote.create` REQUIRE_APPROVAL
(y no disponible: Quote UNAVAILABLE). `shipping.quote` es un READ: nunca pasa por el Action Runtime.

Fingerprints (fijados por `tests/contract/sales-profile-v3.test.ts`):

| Artefacto | Fingerprint |
|---|---|
| sales-production@1 | `bd30523fba7cd17b2996af8205862e30c6756b4efb812777d00c2a5f9f84d313` (sin cambio) |
| sales-production@2 | `2430a3e05c384a61a581707a2d397bcf64a72a703e7e08abbc713535988da3a8` (sin cambio) |
| sales-production@3 | `847aa0efda66782e393305d62370b8ab130189d949b4622ca6449da0072a8d95` |
| definición sales@3 | `44b5b0935c0c20d0304cc7c41a873e8b31252bce8a3c3df3bce8b64247db462a` (sin cambio) |
| definición sales@4 | `c91f0e9da593a30cec1c0294f368cb3f922f2c8a261403e57acf47371aa3f020` |

## 2. Definición Sales v4 e inmutabilidad

- `agents/sales/sales.agent.json` (v3) queda **byte a byte idéntico**: es el contenido registrado en
  producción y el registry rechaza contenido editado para una versión existente
  (`agent_definition_version_immutable`).
- `agents/sales/sales.v4.agent.json` = v3 con exactamente dos cambios: `"version": 4` y la viñeta de
  `shipping.quote` (base reference/order, el modelo no aporta peso/precio/IVA/dimensiones, ofertas sin
  ranking ni recomendación, $1 de Despacho Directo como incentivo, `serviceable=false` y fallas sin
  tarifa inventada, comuna sin dirección).
- El bootstrap registra ambos; v3 queda `unchanged`.

## 3. Fijación de versión por perfil (aislamiento)

El ingress creaba tareas sólo con `agentId`, y el registry resuelve una versión omitida a la **última
registrada**: registrar `sales@4` habría cambiado silenciosamente v1/v2 a v4. Ahora la fábrica de
tareas fija la versión del perfil (`SALES_PRODUCTION_AGENT_VERSIONS`: v1→3, v2→3, v3→4), fuera de los
objetos de perfil para no tocar los fingerprints desplegados. Probado por mutación: sin la fijación,
una conversación de `sales-production@1` abre una tarea `agent_version 4`.

Consecuencia: **una conversación ya existente conserva su tarea y su versión** (la tarea de una
conversación es durable). Tras activar v3, las conversaciones abiertas bajo v2 siguen en sales@3 (verán
`shipping.quote` disponible con su descripción, pero sin la guía de v4); las conversaciones nuevas usan
sales@4.

## 4. Composición

`R4_SHIPPING_*` → `loadShippingHttpConfig` → `ProductionShippingAdapter` (sobre `PcCarrierClient`:
sólo `getLocations()` y `quoteAll()`) → `ShippingService` → `shippingCapability(shipping, catalog)` →
`shipping.quote`. Sólo cuando el perfil declara Shipping REAL. Falla cerrado si falta el binding, si
se entrega un fixture, si la configuración es incompleta o si Catalog no es REAL (la base `order` lee
Catalog). v1/v2 ignoran cualquier binding de Shipping entregado.

## 5. Configuración requerida (sólo worker)

```
R4_PROD_POLICY_PROFILE=sales-production@3        # gateway Y worker
R4_SHIPPING_MODE=real                            # worker
R4_SHIPPING_BASE_URL=https://ms.pesaschile.cl/api/pc-carrier
R4_SHIPPING_TIMEOUT_MS=5000
```

Sin credenciales (el owner no las usa). Requiere `R4_PROD_ALLOW_NETWORK=true` (ya presente en el worker
productivo) y los `R4_CATALOG_*` existentes. El gateway no compone Shipping: sólo necesita el perfil
(para fijar sales@4 en las conversaciones nuevas).

## 6. Pasos de despliegue (NO ejecutados)

1. Merge del PR de J2D en `main`.
2. EC2 (`ssh Master`), en el checkout de R4: `git pull`, `npm ci`, `npm run build`.
   No hay migraciones nuevas.
3. Registrar la definición: `npm run production:sales:bootstrap` → esperado
   `registered: sales@4` y `unchanged: sales@3`. Un `agent_definition_version_immutable` aquí significa
   que v3 cambió: detenerse.
4. Agregar al entorno del worker `R4_SHIPPING_MODE`, `R4_SHIPPING_BASE_URL`, `R4_SHIPPING_TIMEOUT_MS` y
   cambiar `R4_PROD_POLICY_PROFILE=sales-production@3` en gateway y worker (el mismo valor en ambos).
5. `npm run production:sales:plan` (no envía nada) y verificar: `profile: sales-production@3`,
   `profileFingerprint: 847aa0ef…`, `agentDefinition: sales@4`, `domainBindings.shipping: REAL`,
   `shipping.quote` `available: true` / `read_real`, sección `shipping` con `binding: REAL`,
   `baseHost: ms.pesaschile.cl`, `timeoutMs: 5000`, `authentication: none`.
6. Reiniciar `r4-sales-worker` y `r4-channel-gateway` juntos (pm2).
7. Validación canary (requiere una conversación **nueva**; ver §3): preguntar costo de envío a una
   comuna sin productos (base reference) y con productos (base order); confirmar en
   `agent_tasks.agent_version = 4`, observaciones `shipping.quote` y logs `shipping.quote`/
   `shipping.owner_call` (sólo GET `/location` y `/carrier/v1/all`).

## 7. Rollback

`R4_PROD_POLICY_PROFILE=sales-production@2` en gateway y worker y reinicio. sales@4 queda registrado
sin efecto (las conversaciones nuevas vuelven a fijarse a sales@3). Las tareas ya creadas con sales@4
seguirían en v4 sobre un worker v2, donde `shipping.quote` no está registrado: si alguna de esas
conversaciones lo intenta, la capability no existe y no se inventa tarifa.

## 8. Gaps conocidos

- Conversaciones abiertas antes de la activación no adoptan sales@4 (§3).
- Una cotización `order` hace lecturas de Catalog + 2 llamadas a pc-carrier dentro del timeout de
  capability de 10 s; con 5 s por llamada al owner el peor caso puede agotar la capability (fallo
  clasificado, nunca tarifa inventada). Latencia típica observada: < 3 s.
- Dimensiones 1×1×1 (subestima voluminosos); carrier caído indistinguible de sin cobertura; descuentos
  de carro fuera de J2 (ADR-032).
