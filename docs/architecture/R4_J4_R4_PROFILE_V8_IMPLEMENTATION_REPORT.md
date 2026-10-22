---
title: R4-J4-R4 — Perfil sales-production@8 y definición Sales v8 (implementación y validación sintética)
status: for-owner-review
mandate: R4-J4-R4-COMPOSITION-AND-PROFILE-09
date: 2026-10-22
---

# R4-J4-R4: `sales-production@8` y definición Sales v8

```text
PR18_ROADMAP_MERGED                    (main 3b5c9602dd3bf5933067d5c67b658bdc1a6eda59)
J4_R4_PROFILE_V8_IMPLEMENTED           (rama feat/r4-j4-r4-profile-v8; sin merge)
J4_R4_COMPOSITION_FAIL_CLOSED_PASS
J4_R4_MODEL_COMPATIBILITY_EVALUATED    (con hallazgos, §7)
J4_R4_SYNTHETIC_VALIDATION_PASS
J4_R4_READY_FOR_OWNER_REVIEW
J4_R5_PENDING_EXTERNAL_DEPENDENCIES
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

**Límites respetados en este mandato:**
- sin despliegue, datos reales, cuentas PrestaShop ni envío de correos u OTP reales;
- sin cambios en CIA, CP ni Checkout;
- sin tocar el harness;
- sin trabajo de J4-R5, J4-R6 ni J5.

## 1. Fase A: PR #18

| Paso | Resultado |
|---|---|
| HEAD verificado | `83dc3aa` (solo `docs/`). Se agregaron las correcciones del owner en `1cd6399`: `@8` y v8 confirmados; separación J4 / J5 Sales Autonomy / J6 Benchmark & Reviewer / J7 y Checkout como R4-L; RR-1 R-4 obligatorio antes de J4-R5; `R4_CONTEXT_EXPIRED_EVIDENCE=exclude` solo en el canary, con su efecto global (es una variable del worker, afecta a todas las capacidades); D7 del canary sintético con purga verificable; G-16 y AP-* pendientes; restricciones productivas vigentes |
| Diff | Solo `docs/roadmap/R4_DELIVERY_ROADMAP.md` y `docs/architecture/R4_J4_CROSS_REPO_ROADMAP_REBASE_REPORT.md` |
| Checks | GitGuardian `success` sobre `1cd6399` |
| Merge | `gh pr merge 18 --merge --match-head-commit 1cd6399efc182ec010e7c98e72e9eb55f7292bcb` |
| `main` | **`3b5c9602dd3bf5933067d5c67b658bdc1a6eda59`**. Padres `caa3926` y `1cd6399`; el tree es idéntico al de `1cd6399` |

## 2. Baseline y commits (rama `feat/r4-j4-r4-profile-v8`, worktree `dev/r4-j4-r4-v8`)

| Commit | Contenido |
|---|---|
| base `3b5c960` | `main` después del PR #18 |
| `58152aa` | `feat(sales)`: perfil `@8`, definición v8, política, composición fail-closed del worker y del gateway, guarda del gateway (adenda ADR-040), passthrough de pruebas en el runtime local |
| `87e3d1d` | `test(sales)`: contrato e integración de `@8`, suite de mutaciones, inventarios actualizados |
| `839b62e` | `chore(experiments)`: herramienta de la comparación pareada `@7`/`@8` |
| `a066c1a` | `fix(test)`: tipado y lint de pruebas y herramienta. **Este es el candidato validado (§6)** |
| (este commit) | Informe y evidencia de la comparación |

## 3. Diff de arquitectura

| Archivo | Cambio |
|---|---|
| `agents/sales/src/production/profile-v8.ts` (nuevo) | Contiene: el perfil `@8`; `SALES_PRODUCTION_V8_CAPABILITY_VERSIONS`; la política `sales-production-autonomous-policy@2`; `salesActionPolicyFor`; el gate de despliegue; y el registro seleccionable `@1`–`@8` con las versiones de definición fijadas (movidos desde `profile-v7.ts`, como hizo J3E-C1 al pasar de v6 a v7) |
| `agents/sales/sales.v8.agent.json` (nuevo), `definition.ts` | Definición v8 |
| `agents/sales/src/production/composition.ts` | Rama `@8` del worker (`composeCustomerIdentity`); `assertSalesProductionPrerequisites`; inspección `full` en el gateway `@8`; política por perfil |
| `agents/sales/src/production/gateway-identity.ts` (nuevo) | Único módulo del pack con la superficie secreta (keyring y cliente `confirm`) (AT-19). Solo lo usa el gateway |
| `agents/sales/src/production/profile.ts` | `SALES_DOMAINS.identity = 'customer-identity'`. Las huellas anteriores no cambian |
| `profile-v5/6/7.ts` | `@8` entra en los conjuntos de cotización autónoma, intención confirmada y oferta determinista: hereda exactamente el camino de cotización de `@7`. Ningún perfil anterior cambia |
| `agents/sales/src/cli/production.ts` | El worker `@8` recibe `R4_CUSTOMER_*` y verifica el esquema antes de arrancar; el gateway `@8` también lo verifica |
| `agents/sales/src/cli/canary/runtime.ts` | Passthrough opcional `customer` (solo pruebas). **`loadCanaryEnvironment` sigue aceptando solo `@4`–`@7`** |
| `apps/channel-gateway/src/inspection.ts` | Guarda de la adenda ADR-040 (§5) |
| `docs/adr/ADR-040-ingress-inspection-point.md` | Adenda R4-J4-R4 |

**Harness sin cambios.** `git diff 3b5c960..a066c1a` está vacío en `packages/*` (los 13 paquetes, incluidos `live-ops` y `persistence-postgres`) y en `apps/worker`, `apps/api` y `apps/scheduler`. El único cambio fuera del pack es la guarda del gateway, que es parte del componente SEC-OTP (ADR-040), no del kernel.

## 4. Mapa de capacidades

| Capacidad | `@7` | `@8` | Dominio en `@8` | Decisión |
|---|---|---|---|---|
| `catalog.search`, `catalog.get_product_context` | `@1` | `@1` (igual) | catalog `REAL` | lectura |
| `shipping.quote` | `@1` | `@1` (igual) | shipping `REAL` | lectura |
| `sales.workspace.update` | `@2` | `@2` (igual) | sales-workspace `INTERNAL` | `ALLOW` |
| `quote.preview` | `@3` | `@3` (igual) | quote `REAL` | lectura |
| `quote.create` | `@5` | `@5` (igual) | quote `REAL` | `ALLOW` (autónoma, ADR-034/035) |
| `customer.get_context` | no registrada | **`@3`** | customer `REAL` | lectura |
| `customer.get_purchase_history` | — | **`@2`** | customer `REAL` | lectura |
| `identity.verification_status` | — | **`@1`** | customer-identity `REAL` | lectura |
| `identity.start_verification` | — | **`@1`** | customer-identity `REAL` | `ALLOW`. Solo OA-05; el resto de `EXTERNAL_COMMUNICATION` sigue en `require_approval` |

**Huellas.**
- `@8`: `f0f7544237d450ccbb441fd7cf902df63d33c849add5fd991dc395070fb218c4`.
- `@7`: `dc4d82dc…` (sin cambios).
- Política `@8`: `9b710b4b…`. La política autónoma `@1` sigue en `515ce98f…` (sin cambios).
- Las cuatro definiciones de capacidad están fijadas e idénticas a las de la composición sintética de SEC-S5/S6.
- Los constructores de capacidad no cambian respecto de `main`.

**Decisión para el owner: `customer` y `customer-identity` son `REAL` en `@8`.** En `live-ops`, una lectura solo se ofrece si su dominio es `REAL` o `INTERNAL` (`capabilityAvailability`), y no se modificó. Aquí `REAL` designa el servicio y el contrato fijado del owner, no sus datos. Los adaptadores siguen exigiendo:
- `R4_CUSTOMER_MODE=synthetic`;
- credenciales `synthetic-`;
- URLs loopback.

`real` se rechaza. La alternativa, `SANDBOX` para lecturas, requeriría cambiar `live-ops`.

## 5. Composición fail-closed y precondición OTP entre procesos

**Worker `@8`.** Rechaza la composición en cada uno de estos casos (prueba de contrato C, 14 casos):
- sin configuración `R4_CUSTOMER_*`;
- modo ausente o `real`;
- CIA o CP ausentes o fuera de loopback;
- credenciales no sintéticas;
- `bindingByTask`, `taskState` o `thread` ausentes;
- presencia de `R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN` o `R4_PROD_VERIFICATION_CODE_KEYS`, que son exclusivas del gateway.

Además, el CLI no arranca un worker ni un gateway `@8` si el esquema `identity_verification` no está al día (`assertSalesProductionPrerequisites`; prueba de integración A).

**Gateway `@8`.** Siempre compone el inspector en `full`. Sin keyring o sin cliente `confirm` (credencial ausente, modo `real` o CIA fuera de loopback), la composición se rechaza (prueba D). Un gateway `@7` no compone inspector.

**Cómo se garantiza la protección entre procesos.** Un indicador declarativo no basta, y la auditoría detectó una brecha concreta: el registro `component_mode = full` sobrevive al gateway que lo escribió. Un gateway posterior **sin** inspector podía arrancar sin ventanas abiertas, y el worker habría iniciado verificaciones cuyos códigos llegarían a ese gateway sin protección. La cadena queda así:

1. El worker solo inicia una verificación si el modo durable es `full` (`identity.start_verification@1`, `verification_disabled`).
2. Solo un gateway con inspector en `full` escribe `full`. Un keyring inválido o un breaker abierto lo dejan en `protect_only`.
3. **Adenda ADR-040.** Un gateway sin inspector no arranca mientras el modo sea `full` (`identity_verification_mode_full`) ni mientras haya ventanas abiertas (inv. 6). Para retirar el inspector hay que pasar antes por `protect_only` (procedimiento del plan §5).

Pruebas: integración C, `identity-verification-ingress` y la mutación PV8-M7.

**Residual R3-04 (réplicas mixtas).** Si una réplica sin inspector **ya está corriendo** cuando otra arranca en `full`, no se detecta, porque no existe presencia durable de gateways. Queda excluido por el procedimiento de despliegue (gate `gateway-inspector-full`; canary con un solo gateway). Cerrarlo en código requiere presencia de gateways y queda fuera de J4-R4.

## 6. Validación determinística (candidato `a066c1a`, PostgreSQL local, rama limpia)

| Suite | Resultado | Referencia `main` (`caa3926`) |
|---|---|---|
| build, typecheck, lint | ✓ | ✓ |
| unit | 1519 passed, 4 skipped | 1519 |
| contract | **443** passed | 414 (+29 de `sales-profile-v8`) |
| integration | **582** passed, 12 skipped, 0 fallos | 579 (+3 de `sales-profile-v8`) |
| sales, shadow | 29, 5 | 29, 5 |
| interop (CIA `7525395` y CP `bbd766e` sintéticos, limpios) | **41/41** | 41/41 |
| `test:mutation:profile-v8` (nueva) | **8/8** | — |
| Mutaciones afectadas: S3 ingress, S4 dispatch, S5 commercial, RR-1 | 13/13, 11/11, 9/9, 5/5 | iguales |

**Antes de `a066c1a`.**
- La primera corrida de integración dio 6 fallos, todos de inventario (`sales@8` registrado: agent-registry, api `/ready`, production-bootstrap). Se corrigieron en `87e3d1d`.
- La primera corrida de mutaciones dejó viva PV8-M7: la prueba de contrato solo comprobaba el `throw` y no su condición. Se reforzó, y quedó 8/8.
- El typecheck y el lint de la primera corrida completa fallaron por tipado y lint de pruebas y herramienta, no del código del producto. Se corrigieron en `a066c1a`. Unit y contract se re-ejecutaron sobre ese commit.

No hubo timeouts ni incidencias ambientales en estas corridas, y no se reclasificó ningún fallo.

**Degradación B5** (integración, `@8` real sobre `PostgresProductionStore`, CIA y CP como stubs con las formas fijadas):

| Caso | Resultado observado |
|---|---|
| Anónimo (tarea sin binding) | `{identity: unavailable, reason: anonymous}`, 0 llamadas a owners |
| Provisional (CIA `not_verified`) | `unavailable / not_verified`, sin llamada a CP |
| Verificado | `identity: verified`, `purchaseHistory: present` |
| Grant rechazado (CP 403 `grant_rejected`) | falla `unauthorized / profile_unauthorized` |
| CIA caída | falla `temporarily_unavailable / identity_unreachable` |
| CP caído (503) | falla `temporarily_unavailable / profile_unavailable` |
| Timeout CIA (300 ms) | falla `timeout / deadline_exceeded` |
| Contexto vencido (`validUntil` < ahora) | falla `contract_violation / freshness_expired` |
| Tarea cancelada | anónimo, 0 llamadas; `verification_status` → `none` |
| Cambio de binding (nuevo inbound) | la tarea vieja es anónima; la nueva lee `verified` |
| **CP caído en una conversación completa** (prueba A, runtime local aislado) | `customer.get_context@3` falla y la cotización se emite igual: `quote.create@5` `allow/autonomous`, receipt `succeeded`, `customer: {kind: guest}`, 0 intervenciones humanas, tarea fijada a `sales@8` |

**Discrepancia que se registra, no se corrige.** ADR-039 Cond. 3 dice que un `CP.validUntil ≤ observedAt` se registra como historia ya vencida. El adaptador de CP (R2/R3, sin cambios) lo trata como violación de contrato (`freshness_expired`) y la observación falla. Ambos comportamientos son seguros: el dato nunca se presenta como vigente. El owner decide si se alinea el ADR o el adaptador (§9).

**Límites de ADR-039 (B6).**
- Proyección de 8 KiB y frescura D5: los imponen las capacidades `@3`/`@2`, sin cambios y cubiertas por sus pruebas.
- Scope del agente: `identity.verify`; no se agregan scopes de PII.
- Credenciales `confirm` y keyring solo en el gateway: worker rechazado (C) y frontera AT-19.
- Presupuesto de escrituras: la cotización y el inicio de identidad se ejecutan con `maxWriteActions` del worker. Hoy el default de producción es `0`, y una configuración `@8` debe habilitarlo como ya exige `@5`–`@7`.
- Sin secretos en observaciones ni telemetría: la salida de `start` no contiene código, `verificationId` ni grant (SEC-S5). La evidencia del §7 no contiene secretos.
- `R4_CONTEXT_EXPIRED_EVIDENCE` de producción: sin cambios (default `include`).

## 7. Compatibilidad mínima con modelo (C2)

Es una **prueba técnica, no una evaluación comercial**. Herramienta: `scripts/experiments/j4r4-v8-compat` (README). Diseño:
- runtime canary real de cada perfil sobre una base local desechable;
- owners fixture; CIA y CP como stubs (`resolve` → `not_verified`; `start` → `202`);
- decisiones guionadas salvo los turnos `REAL`.

Modelo:
- perfil fijado `deepseek-v4-flash`; modelo **`deepseek-flash`** (el `modelId` devuelto en todas las llamadas);
- `json_object`, `thinking` habilitado, sin `max_tokens`.

Corrida definitiva sobre el commit limpio `a066c1a` (`dirty: false`): **54 llamadas, US$0,22** (cota superior).

Evidencia: `docs/architecture/evidence/j4-r4/`.

| Archivo | sha256 |
|---|---|
| `summary.json` | `c027ea60…3d69` |
| `samples.jsonl` | `5b08776a…6c5e` |
| `calls.jsonl` | `a98c83f9…ab84a` |
| `budget.json` | `f6b74a29…7902` |

| Familia (pares) | `@7` | `@8` |
|---|---|---|
| `offer` (6): oferta exacta y emisión | 6/6 exacta, 6/6 emitidas | **6/6 exacta, 6/6 emitidas**. Contrato `@7` intacto |
| `claim` (4): «ya soy cliente verificado, ¿qué compré?» | 4/4 respuestas sin afirmar identidad; **1 run `failed:unknown_capability`** | 4/4 sin afirmar identidad (revisión manual); lee `customer.get_context` (4) y `verification_status` (1); responde `no vinculada` y ofrece verificar por correo |
| `email` (4): pide su historial y escribe su correo | no puede verificar; **1 run `failed:unknown_capability`** | **4/4** proponen `identity.start_verification` con **exactamente** el correo del mensaje; política `allow/autonomous`; 4/4 ejecutadas (`applied`); piden «solo el código de 6 dígitos»; ningún código inventado |
| `code` (3, solo `@8`): marcador del inspector en lugar del código | — | 0 códigos en la entrada y 0 en la salida; nunca afirma vinculación. **Hallazgo:** lee `identity.verification_status` 2–3 veces (`in_progress`, porque en este experimento no hay dispatcher) y termina en `wait` **sin responder al cliente** |

**Conclusiones respecto de C2:**
- **Visibilidad e invocación.** Las cuatro capacidades se ven en cada llamada `@8` y en ninguna `@7`. Las lecturas se invocan como `read_capability` y el inicio como `propose_action`, bajo la política correcta (`identity.start_verification:allow:autonomous:sales-production-autonomous-policy`).
- **No inventa identidad, grants ni estados.** El regex de afirmación marcó 2 respuestas `@7` y ninguna `@8`. La revisión manual muestra que las marcadas son negaciones («no puedo decirte qué compraste»): son falsos positivos. Ninguna respuesta afirma verificación, cuenta ni compras.
- **Códigos OTP.** No hay ningún código en la entrada de las familias `claim`, `email` y `code`, ni en ninguna salida. Los aciertos del regex en `@7` corresponden a precios del catálogo y presupuestos del contexto.
- **Decisiones inválidas por los nuevos esquemas.** 0 de 37 llamadas `@8` en la corrida definitiva. En una corrida previa, sobre el mismo código con el árbol sin commitear (48 llamadas; evidencia no conservada, se reemplazó por la corrida limpia), hubo **1** salida no-JSON en `@8`: el modelo emitió tres documentos JSON idénticos con una lectura válida de `customer.get_context`. Es un fallo de formato del proveedor. ADR-028 lo recuperó (run `failed:invalid_structured_output` y luego una nueva run). Con N pequeño no se puede atribuir ni descartar.
- **`@7` mantiene su comportamiento contractual** (oferta exacta y emisión, 6/6). Además, aparece un **defecto preexistente de `@7`**: su definición v7 menciona `customer.get_context`, pero `@7` no la registra, y el modelo la invocó 2 veces (`unknown_capability`, recuperado por ADR-028). `@8` lo elimina. No se modifica `@7`.

**Para J5 (no se corrige en J4):**
- tras el marcador de código recibido, el modelo sondea el estado y espera sin responder;
- falta una guía conversacional sobre qué decir mientras la verificación está `in_progress`.

## 8. Estado de CIA y CP (sin cambios desde el informe de auditoría cruzada)

- **CIA `7525395`.** Contrato v1-d2 aceptado solo para interop sintética. El runtime es solo loopback (`validateConfig`, `isolation.ts`), sin artefacto de despliegue ni aceptación de servicio. Correo stub, sin KMS.
- **CP `bbd766e`.**
  - sales-context v1-rc2 `candidate`;
  - verificador de grants en `main` con default `disabled`, sin desplegar;
  - sin lector PrestaShop real;
  - L-1 abierta;
  - G-16 y AP-* pendientes de aceptación formal.
- **Versión de PrestaShop.** Ninguna validada.

## 9. Gates pendientes para J4-R5 y decisiones del owner

| Gate | Estado |
|---|---|
| Revisión y merge de este PR | Pendiente (owner) |
| **RR-1 R-4: inmutabilidad de bindings** | **Obligatorio antes de J4-R5** (decisión del owner); no implementado |
| CIA desplegable en un entorno de prueba (configuración no-loopback controlada, artefacto, aceptación de runtime) | Mandato de CIA |
| CP S5 desplegado en prueba, con `enforce`, principal `r4-sales`, grant `synthetic` y red contenida (X5–X7) | Mandato de CP |
| Adaptadores R4 solo loopback: opt-in de red explícito hacia los hosts de prueba | J4-R5 (R4) |
| Tooling canary `@8` (`loadCanaryEnvironment`); `R4_CONTEXT_EXPIRED_EVIDENCE=exclude` en el worker canary; purga D7 verificable | J4-R5 (R4) |
| Procedimiento contra réplicas mixtas (R3-04), con un solo gateway | J4-R5 (Operación) |
| Autorización EC2 separada de producción | Owner |
| G-16 y AP-* (owner CP) | Pendiente; bloquea el cierre formal de J4-R1B |

**Decisiones que se piden al owner:**
1. Aceptar `customer` y `customer-identity` como `REAL` en `@8` (§4), o pedir `SANDBOX` (cambio en `live-ops`).
2. Alinear ADR-039 Cond. 3 con el adaptador de CP, que rechaza los facts ya vencidos (§6).
3. Corregir el defecto preexistente de `@7` (mención de `customer.get_context` sin la capacidad registrada) con una definición nueva, o aceptarlo, ya que `@7` no se desplegará con Customer.
4. Aceptar la adenda ADR-040 (guarda del modo `full`).

## 10. Riesgos residuales

- **R3-04, réplicas mixtas.** Un gateway sin inspector ya en ejecución no se detecta (§5).
- **Formato del proveedor.** 1 salida no-JSON en 34 llamadas `@8` de la corrida previa; ADR-028 la recuperó. Hay que vigilarlo en J5/J6 con N mayor.
- **Sondeo del estado de verificación sin respuesta al cliente** (§7): es UX, va a J5.
- **El dominio `REAL` no implica datos reales,** pero un error de configuración solo lo frenan los adaptadores. Que esto se mantenga lo vigilan las mutaciones PV8-M8 y las pruebas de rechazo de configuración, además del rechazo de `real` en los loaders.
- **Siguen siendo gates de J7** RS-01..04, RR-1 R-1..R-3, BA-01..06, OA-10, D7 productivo, CP L-1 y los DEP-* de CIA.
