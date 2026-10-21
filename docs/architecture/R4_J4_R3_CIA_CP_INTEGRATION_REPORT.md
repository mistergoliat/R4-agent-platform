# R4-J4-R3 — Integración sintética de la CIA y Customer Profile con R4 Sales

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-R3-CIA-CP-INTEGRATION-01` |
| Fecha | 2026-10-21 |
| Para | Owner de R4 (revisión previa a merge) |
| Rama | `feat/r4-j4-r3-cia-cp-synthetic`, desde `origin/main` `3e7b4ee`. Publicada, **sin merge** |
| Alcance | Solo sintético. **Sin despliegue y sin perfiles productivos.** CIA, CP, el harness de R4, el webhook y PrestaShop no se modificaron |

```text
R4_J4_R3_CIA_ADAPTER_IMPLEMENTED
R4_J4_R3_CP_GRANT_TRANSPORT_PASS
R4_J4_R3_CONTRACT_ALIGNMENT_PASS
R4_J4_R3_TRUSTED_TASK_BINDING_PASS
R4_J4_R3_CUSTOMER_CAPABILITIES_PASS              (registradas solo en la composición sintética)
R4_J4_R3_THREE_SERVICE_SYNTHETIC_INTEROP_PASS     (23/23 en 3 ejecuciones; E2E, FAULT y ADAPTER separados)
R4_J4_R3_SECURITY_BOUNDARIES_PASS
R4_J4_R3_REGRESSION_PASS
R4_HARNESS_UNCHANGED
R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED
SEC_OTP_01_PENDING
SEC_OTP_02_PENDING
G16_PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
R4_J4_R3_READY_FOR_OWNER_REVIEW
```

---

## 1. Baselines y SHA

| Repositorio | Referencia | SHA | Uso |
|---|---|---|---|
| R4 | `origin/main` | `3e7b4eec6772ffd4f192a3c78fe89dbe39d4f05a` | Base de la rama. Contiene J4-R2 |
| CIA | `origin/main` | `7525395d14d72c36853add31b327c6ebd5fb9e73` | Contrato `v1-d2` fijado y clon limpio de la campaña |
| CP | `origin/main` | `bbd766ef4b32c0ceb1065f9b7791f63f46798ef9` | Contrato `v1-rc2` fijado y clon limpio compilado de la campaña |

**Checkouts:**
- El checkout R4 existente (`feat/r4-j4-customer-adapter-r2`) no se tocó, y su archivo sin seguimiento `docs/architecture/R4_J4_R2_OWNER_REVIEW_REPORT.md` quedó intacto. El trabajo se hizo en el worktree `dev/r4-j4-r3-cia-cp`.
- La CIA y CP se usaron en **clones limpios** propios (`7525395` y `bbd766e`). Sus checkouts no se modificaron.

**Commits de la rama:**

| Commit | Slice |
|---|---|
| `adaa413` | R3.0: punteros D1/D2/CP-S5 y transferencia de autoridad en el registro de decisiones |
| `f026059` | R3.1: puerto `CustomerIdentityResolver` y adaptador HTTP de la CIA |
| `6a7c117` | R3.2/R3.3: transporte del grant a CP y adopción de v1-rc2 |
| `1a3587e` | R3.4–R3.6: capacidades `customer.get_context@2` y `customer.get_purchase_history@1`, y composición sintética |
| `d5885ae` | R3.7/R3.8: campaña R4 → CIA → CP |
| `26a77e8` | Seguimiento de SEC-OTP-01/02 |
| *(este informe)* | Informe y evidencia en el registro de decisiones |

## 2. Integridad de contratos

| Contrato | Dónde se fija | Procedencia | Verificación |
|---|---|---|---|
| CIA `v1-d2` | `adapters/domains/identity/http/contract/`: 3 schemas (`cia-common`, `resolve`, `error`), 12 fixtures de `resolve`, 10 de error y los manifiestos S0 y v1-d2 | `git show 7525395:<ruta>`. `SOURCE.json` registra la ruta de origen, el git blob, el sha256 (LF) y el hash de contenido | `identity-http-contract.test.ts` **23/23**. Los 27 archivos son idénticos byte a byte y coinciden con el `MANIFEST` S0 de la CIA. El runtime carga los schemas verificando sus hashes |
| CP `v1-rc2` | `adapters/domains/customer/http/contract-v1-rc2/`: 2 schemas, el `SOURCE.json` del owner, el `MANIFEST` y 2 fixtures | `git show bbd766e:<ruta>`, con el mismo formato que R2 | `customer-http-v1-rc2-contract.test.ts` **4/4**. Los hashes de contenido son los aceptados por CP-D2-ACC-02: respuesta `fc29ea6b…`, petición `c8da52af…`, manifest `46aab260…` |
| CP `v1-rc1` (R2) | `contract/` y `fixtures/`, sin cambios | `47db415` | `customer-http-contract.test.ts` **41/41**: la evidencia de R2 se conserva |

**Revisión exacta rc1 → rc2:**
- el schema de petición es idéntico;
- el de respuesta difiere solo en textos y en el código `grant_rejected` (comparación estructural automatizada).

**Qué no se fija:** el schema JWS del grant de la CIA. R4 **no decodifica** el grant, y su verificación criptográfica corresponde solo a CP-S5.

## 3. Arquitectura implementada

```text
 capacidad (Sales, fuera de Core)
   └─ binding confiable: ProductionStore.bindingByTask(taskId)        ← única fuente del sujeto
        └─ CustomerIdentityResolver ── HTTP ──► CIA POST /v1/identity/resolve
             (solo con verified)
        └─ CustomerProfilePort ── HTTP (bearer + x-customer-access-grant) ──► CP sales-context (CP-S5 verifica)
        └─ lector de frontera C (R2): proyección por allowlist, topes, AP-10
```

**El harness no cambia.** Kernel, runtime de capacidades, scheduler, persistencia, ingesta de WhatsApp, perfiles productivos, `customer.get_context@1`, ADR-039 y las integraciones de Catalog, Shipping y Quote tienen **diff vacío** frente a `origin/main`.

Toda la lógica específica de la CIA o de CP vive en:
- `adapters/domains/identity/http` (paquete nuevo);
- `adapters/domains/customer/http`;
- `agents/sales/src/capabilities/customer-v2.ts` y `customer-synthetic.ts`.

### Puertos

| Puerto | Cambio | Justificación |
|---|---|---|
| `IdentityResolution`, `CustomerAccessGrant` | **Ninguno** | Coinciden con CIA `v1-d2` §7 |
| `CustomerIdentityResolver` y `ChannelSubject` (`adapters/domains/src/customer/profile-port.ts`) | **Nuevos en código.** Antes solo existían en la especificación R1 §4 (DRAFT) | Implementan el puerto previsto |
| `ChannelSubject.sessionRef` | **Campo añadido** al borrador R1 | **Incompatibilidad contractual demostrada:** CIA `v1-d2` §3 exige `context.sessionRef` y define que el consumidor R4 envía su `bindingId`. Es un cambio aditivo |
| `CustomerProfilePort` | **Ninguno** | — |

## 4. Cambios por adaptador

### 4.1 CIA: `@r4-adapters/identity-http` (nuevo)

**Petición:**
- `POST /v1/identity/resolve` con el bearer `agent` de `r4-sales` como única credencial;
- el sujeto va solo en el cuerpo, con `subjectAssurance: provider_signed`;
- `x-correlation-id`;
- deadline más `AbortSignal` del llamador;
- tope de **16 KiB** UTF-8 sobre el stream;
- **`redirect: 'manual'`** (nunca se sigue un 3xx);
- sin reintentos.

**Validación cerrada contra el schema fijado.** Solo `verified` trae `customerRef` y grant. Además se comprueban:
- el namespace `prestashop_customer`;
- el rango sintético `900000201`–`900000313`;
- que los propósitos del grant sean **exactamente** los pedidos;
- que `expiresAt` sea futuro y no supere ahora + 360 s (300 s de TTL más 60 s de desfase del emisor);
- que `resolvedAt` no esté en el futuro.

**Configuración (fail-closed):**

| Variable | Requisito |
|---|---|
| `R4_CUSTOMER_MODE` | `synthetic`. `real` se rechaza |
| `R4_CUSTOMER_IDENTITY_BASE_URL` | **Solo loopback**, sin ruta, credenciales ni query |
| `R4_CUSTOMER_IDENTITY_BEARER_TOKEN` | Credencial `synthetic-…` |
| `R4_CUSTOMER_IDENTITY_TIMEOUT_MS` | 100–3000 |

**Telemetría:** operación, propósitos, estado de la resolución, estado HTTP, duración, categoría y código. **Nunca** el token, el sujeto, el `customerRef` ni el grant.

### 4.2 Customer Profile: `@r4-adapters/customer-http` (R2, actualizado)

**El grant viaja:**
- exactamente **una vez** y sin modificar, en `x-customer-access-grant`;
- junto a `Authorization: Bearer`;
- nunca en el cuerpo, la URL ni la telemetría.

**Antes de la red, R4 rechaza** (además de las comprobaciones de R2 de propósito y vencimiento):
- un grant que no sea un JWS compacto de ≤ 2048 bytes (`grant_malformed`);
- un cliente fuera del rango sintético.

**Validación de la respuesta:**

| Caso | Resultado |
|---|---|
| Grant enviado y respuesta `service_scope_only` (en 200 y en 503) | `contract_violation` `authorization_basis_insufficient`. Solo `customer_grant_verified` es una lectura autorizada |
| `validUntil` mayor que el `expiresAt` del grant | `contract_violation` `validity_exceeds_grant` (regla de v1-rc2) |
| 403 `grant_rejected` | `unauthorized`. El código del owner es solo diagnóstico, nunca un motivo |
| 3xx | `contract_violation` y no se sigue |

**Se conservan de R2:** el tope de 64 KiB, el escaneo de campos prohibidos, la proyección por allowlist, el namespace, la separación de propósitos, la paginación, la ausencia de reintentos y el correlation id.

## 5. Procedencia del sujeto

1. `bindingByTask(execution.taskId)`.
2. Si no hay binding, o el binding está **cerrado** (decisión de este slice, conservadora): `unavailable/anonymous`, **sin llamadas externas**.
3. El sujeto es `{ channel, accountRef, subjectRef: recipientRef, sessionRef: bindingId }`.

**Los inputs de las capacidades son `strictObject` sin identificadores.** Los argumentos del modelo con `customerRef`, teléfono, sujeto o grant se rechazan (`invalid_arguments`) antes de leer el binding.

**El sujeto nunca proviene de:** argumentos del modelo, texto del usuario, historial, workspace, memoria ni `task.requestedBy`.

## 6. Tratamiento de grants

| Regla | Dónde se aplica |
|---|---|
| Opaco: no se decodifica, firma ni modifica | Los dos adaptadores. Un test estático lo comprueba: el paquete CIA no contiene base64url, `jose` ni `split('.')` |
| Presente, con forma de transporte (JWS compacto, ≤ 2048 bytes) | Adaptador CIA (schema) y adaptador CP (antes de la red) |
| `expiresAt` informado por la CIA; vencido o incoherente → `contract_violation` `incoherent_grant`, y nunca llega a CP | Adaptador CIA y lector de frontera C (`coherentGrant`). Probado en E2E con un grant de la CIA real que vence antes del uso (escenario 12) |
| Cobertura del propósito pedido | Adaptador CIA (igualdad exacta), frontera C y adaptador CP (antes de la red) |
| Uso restringido al `customerRef` resuelto | Mismo objeto de resolución en memoria, por invocación. CP-S5 rechaza otra cuenta (`customer_mismatch`, escenario 10) |
| Sin persistencia, sin caché, sin reutilización entre tareas, sin exposición al modelo | Una resolución por invocación (test: 3 invocaciones → 3 resoluciones). La observación persistida es la **salida proyectada**, sin `customerRef` ni grant (test de fugas) |
| Verificación criptográfica | Solo CP-S5 |

## 7. Composición de capacidades

| Ámbito | Estado |
|---|---|
| Adaptadores integrados | `identity-http` y `customer-http` (con grant) |
| Fronteras de capacidades validadas | `customer.get_context@2` y `customer.get_purchase_history@1` (READ, owner `customer`, scope `customer.read`, `maxAttempts` 1, timeout 10 s, frescura 10 min, `ownerValidUntil` ADR-030) |
| Registro en composición sintética | `composeSyntheticCustomerCapabilities` (`customer-synthetic.ts`). Exige las dos configuraciones (modo `synthetic`, URL loopback sin override de red para CP, credenciales `synthetic-`) y la fuente de bindings. Las fábricas rechazan construir sin bindings, CIA o CP (AG-2). Solo la usan los tests y la campaña |
| **Registro en producción** | **DESHABILITADO.** Ningún perfil, CLI, bootstrap, definición, raíz de composición ni archivo `.agent.json` las registra ni las importa. Lo comprueba el test de fronteras de R2, actualizado para listar exactamente los 4 usuarios permitidos. `sales-production@8` (J4-R4) no está autorizado |

**Sales no usa la CIA en producción.**

## 8. Matriz AG-1 a AG-5

| Gate | Estado | Evidencia |
|---|---|---|
| **AG-1** Aislamiento sintético | **PASS_SYNTHETIC** | • Rango `900000201`–`900000313` en el adaptador CIA y en el adaptador CP.<br>• URLs loopback (CIA siempre; CP sin override en la composición sintética).<br>• Credenciales `synthetic-`.<br>• Sin PrestaShop ni bases comerciales: CP sintético con las variables de BD apuntando a puertos inalcanzables, y CIA con el doble del proveedor |
| **AG-2** Construcción segura | **PASS_SYNTHETIC** | Las fábricas rechazan dependencias ausentes o incompletas. La composición rechaza 8 configuraciones incompletas o inseguras y la ausencia de bindings. No hay constructor alternativo ni fallback a fixture. Mutaciones: quitar la guarda hace fallar 2 tests |
| **AG-3** Grant autenticado | **PASS_SYNTHETIC** | Campaña:<br>• un grant manipulado da `bad_signature`;<br>• uno de otro consumidor, `consumer_mismatch`;<br>• uno de otra cuenta, `customer_mismatch`;<br>• uno sin propósito, `purpose_not_granted`.<br>Todos llegan a R4 como `unauthorized` y **nunca** como identidad verificada. Un CP que no verifica (`service_scope_only`) es `contract_violation` |
| **AG-4** Historial y paginación | **PASS_SYNTHETIC** | Límites de R2 sin cambios (offset 0–40, limit 1–10; los valores fuera de rango se rechazan en el schema de entrada). Campaña: `hasMore`/`nextOffset` (2 → 2, luego 1 → null), historial vacío e historial incompleto como fallo `history_unavailable`, nunca como lista parcial |
| **AG-5** Minimización y vigencia | **PASS_SYNTHETIC** | La salida no contiene `customerRef`, grant, sujeto, `lineKind` ni binding (tests). `validUntil = min(CP, grant)` y la observación queda acotada por el owner. Un campo prohibido inyectado por un proxy se rechaza (`sensitive_field_present`). Restricciones pendientes para una activación real: AP-09/AP-10, G-16, D7 |

Un PASS sintético **no** es un PASS productivo.

## 9. Taxonomía de errores

No hay categorías nuevas: se reutiliza `DomainErrorCategory`.

| Origen | Categoría | Código R4 |
|---|---|---|
| CIA 400 | `validation` | Código del owner o `invalid_request` |
| CIA 401/403 | `unauthorized` | `identity_unauthorized` |
| CIA 429, 5xx | `temporarily_unavailable` | `rate_limited`, código del owner o `identity_unavailable` |
| CIA red / deadline | `temporarily_unavailable` / `timeout` | `identity_unreachable` / `deadline_exceeded` |
| CIA 3xx, 404 u otros | `contract_violation` | `unexpected_status` |
| CIA respuesta fuera de contrato | `contract_violation` | `invalid_response`, `foreign_customer_ref`, `customer_ref_outside_synthetic_range`, `incoherent_grant`, `response_too_large`, `freshness_incoherent` |
| CP 401/403, incluido `grant_rejected` | `unauthorized` | `profile_unauthorized` (`ownerCode` diagnóstico) |
| CP 429, 503 `degraded`, 504, 5xx | `temporarily_unavailable` | Como en R2 |
| CP `service_scope_only` con grant / validez mayor que el grant | `contract_violation` | `authorization_basis_insufficient` / `validity_exceeds_grant` |

**Ningún error técnico se convierte en ausencia de cliente:** los fallos son observaciones `failed` y nunca `unavailable`. Sin reintentos automáticos (`maxAttempts` 1).

**Estados sin identidad:** binding ausente → `anonymous`; `not_linked` → `not_linked`; `not_verified`, `ambiguous` o `conflicted` → `not_verified` (la telemetría conserva el estado exacto); `not_authorized` → `not_authorized`. En ninguno se llama a CP.

**Con identidad:** CP `available` → `verified`; `not_found` → `not_on_file`; `withheld` → `withheld`.

**CP `degraded` (503)** es `temporarily_unavailable`, sin inventar datos, según la especificación R1 §5 (AP-08: el puerto no tiene estado `degraded`).

## 10. Pruebas y regresiones

### Pruebas nuevas o actualizadas

| Archivo | Resultado |
|---|---|
| `tests/unit/customer-identity/client.test.ts` (nuevo) | **46/46** |
| `tests/contract/identity-http-contract.test.ts` (nuevo) | **23/23** |
| `tests/unit/customer-profile/grant-transport.test.ts` (nuevo) | **37/37** |
| `tests/contract/customer-http-v1-rc2-contract.test.ts` (nuevo) | **4/4** |
| `tests/unit/sales/customer-v2-capabilities.test.ts` (nuevo) | **42/42** |
| Tests R2 de CP (`http-client`, `config`, `outputs`) | **121/121**, más 3 opcionales omitidos (interop R2, sin variables de entorno) |
| `tests/contract/customer-http-contract.test.ts` (R2) | **41/41** |

**Ajustes a tests propios de R2,** todos exigidos por el mandato:
- el soporte sirve una **copia** de cada fixture v1-rc1 (idénticos byte a byte en disco) marcada `customer_grant_verified`, como responde CP-S5;
- el grant sintético por defecto tiene forma de JWS;
- las aserciones "nunca se envía el grant" y "se acepta `service_scope_only`" se reescriben a la regla R3;
- el interop opcional de R2 ahora espera que un CP con grant `disabled` sea rechazado;
- el test de fronteras de R2 lista exactamente los 4 usuarios permitidos;
- la allowlist de dependencias de Sales añade los dos adaptadores.

**Mutaciones:** 5/5 detectadas en las capacidades. Los cambios de seguridad de los adaptadores están cubiertos por tests negativos explícitos (§13).

### Regresión completa

Sobre `d5885ae`, en serie y sin otra suite en paralelo, contra el PostgreSQL de tests de R4:

| Proyecto | Resultado | Omitidos y causa |
|---|---|---|
| `unit` | 79 archivos · **1 271 PASS**, 0 FAIL | 4 skip: 3 del interop R2 opcional (sin `R4_CP_SYNTHETIC_*`) y 1 preexistente en `operator-auth` |
| `contract` (incluye core-purity, dependency y sales boundaries) | 29 archivos · **397 PASS**, 0 FAIL | — |
| `integration` (PostgreSQL) | 36 archivos · **471 PASS**, 0 FAIL | 12 skip: `catalog-http-real.test.ts`, opcional contra un catalog real, preexistente |
| `sales` (PostgreSQL) | 4 archivos · **29/29** | — |
| `shadow` (PostgreSQL) | 1 archivo · **5/5** | — |

**Comparación con R2** (`R4_J4_R2_CUSTOMER_ADAPTER_VALIDATION_REPORT.md`): unit + contract pasa de 1 516 a **1 668** PASS (+152, exactamente las pruebas nuevas). Integration, sales y shadow, **idénticos**.

`build`, `lint` (`--max-warnings=0`) y `typecheck` OK.

**Clon limpio:** §16.

## 11. Campaña R4 → CIA → CP

| Servicio | Cómo corre |
|---|---|
| **CIA** | Clon limpio `7525395` compilado, a través de su `createCia`. PostgreSQL 16 de pruebas (`127.0.0.1:55433`), el **doble HTTP del proveedor de cuentas de la propia CIA**, OTP a un buzón falso en memoria, emisión ES256 real. Consumidores `r4-sales` y `other-consumer` con credenciales generadas por ejecución. El vínculo lo hace el flujo `start`/`confirm` de la CIA, con un principal de integración de canal generado para la prueba. **No hay endpoint administrativo ni ingesta de R4** |
| **CP** | Clon limpio `bbd766e`, **servicio compilado**. Fuente sintética, auth `enforce`, grant `required`, JWKS de la CIA fijado antes de arrancar, principal `r4-sales`. Una segunda instancia con grant `disabled` sirve para el escenario 16 |
| **R4** | Composición sintética invocada por `CapabilityRegistry`/`CapabilityInvoker` reales. Bindings **reales** en el PostgreSQL de R4: tarea creada con `platform.tasks.createTask`, más `openBinding` y `attachTask`, el soporte autorizado de pruebas. El lado R4 corre desde las fuentes TypeScript (vitest), porque las capacidades no existen en ningún servicio R4 desplegable |

`npm run test:interop` (proyecto `interop`) **no** forma parte de `npm test`. Sin los clones, el archivo falla con `NOT_RUN`.

**Tipos de evidencia:**
- **E2E:** nada alterado.
- **FAULT:** un salto alterado a propósito por el test (resolver stub, proxy o servicio caído).
- **ADAPTER:** un adaptador contra un servicio real, fuera del flujo de capacidades.

| # | Escenario | Tipo | Resultado observado |
|---|---|---|---|
| 1, 5 | Cliente vinculado; OTP confirmado y grant emitido | E2E | `verified`, `purchaseHistory: present`. Auditoría CP `accepted` |
| 2 | Sin binding | E2E | `anonymous`, sin llamadas a la CIA |
| 3 | Sin vínculo | E2E | CIA `not_linked` → `not_linked`, sin CP |
| 4 | OTP no confirmado | E2E | CIA `not_verified` → `not_verified` |
| 6 | E-mail de dos cuentas | E2E | `confirm` `ambiguous`, CIA `ambiguous` → `not_verified` |
| 7 | Cuenta invitada / inactiva | E2E | `confirm` `ineligible_account`, CIA `not_authorized` → `not_authorized`, sin CP |
| 8 | Propósito no verificado | E2E | CIA `not_verified` (plano C) → `unavailable`, sin CP. El propósito verificado sigue funcionando |
| 8b | Grant real sin el propósito | ADAPTER | R4 rechaza antes de la red (`grant_purpose_not_covered`). Forzado contra CP: `purpose_not_granted` |
| 9 | Grant real de otro consumidor | FAULT | CP `consumer_mismatch` → `unauthorized` |
| 10 | Grant real de otra cuenta | FAULT | CP `customer_mismatch` → `unauthorized` |
| 11, 15 | Grant manipulado (firma) / CP rechaza | FAULT | CP `bad_signature` → `unauthorized`, nunca identidad verificada |
| 12 | Grant real vencido antes del uso | FAULT | `contract_violation` `incoherent_grant`. **CP no recibe nada** |
| 13 | CIA indisponible | FAULT | `temporarily_unavailable` `identity_unreachable`, sin CP |
| 14 | CP indisponible | FAULT | `temporarily_unavailable` `profile_unreachable` |
| 16 | CP responde `service_scope_only` | FAULT | `contract_violation` `authorization_basis_insufficient` |
| 17, 18, 20 | Historial disponible, vacío y paginado | E2E | 3 ítems; `[]`; `hasMore`/`nextOffset` 2, y luego la última página |
| 19 | Historial incompleto; cliente inexistente | E2E | Fallo `history_unavailable`, sin lista parcial; `not_on_file` |
| 21 | Revocación posterior a la emisión | E2E + ADAPTER | La siguiente invocación da `not_linked`. El grant ya emitido sigue aceptado por CP hasta `exp` (v1, DM-06) |
| 22 | CP con un dato prohibido (proxy) | FAULT | `contract_violation` `sensitive_field_present` antes de exponer datos |
| 23 | Dos tareas y dos sujetos en concurrencia | E2E | Cada tarea lee su propio cliente (`present` frente a `none`) |
| 24 | Fugas | E2E | Ningún segmento de los grants emitidos (22–23 por ejecución), e-mail, sujeto, `customerRef`, `accountRef` ni credencial en observaciones o telemetría de R4. El CP compilado tampoco los registra |
| — | Header de grant duplicado | ADAPTER | CP 403 (`malformed`). R4 envía siempre uno solo |

**Ejecuciones:**

| # | Árbol R4 | Resultado | Duración |
|---|---|---|---|
| 1 | Rama de trabajo, antes de ajustar aserciones | **23/23** | 14,7 s |
| 2 | `d5885ae` | **23/23** | 16,2 s |
| 3 | **Clon limpio del remoto** `26a77e8` | **23/23** | 17,1 s |

No quedaron procesos ni schemas residuales en la CIA (`r4_r3_*`).

**Hallazgos de la campaña, sin cambios en la CIA:**
- la CIA limita el reenvío de OTP por sujeto (60 s) y por e-mail (5 al día);
- la campaña los respeta: un sujeto vinculado una vez se reutiliza en conversaciones nuevas, como un cliente que vuelve.

## 12. Seguridad

| Prueba negativa | Resultado |
|---|---|
| Sujeto inyectado desde argumentos del modelo | `invalid_arguments`, sin leer el binding |
| Binding de otra tarea | Cada tarea resuelve su propio binding (unit y campaña) |
| Grant reutilizado en otra cuenta | CP `customer_mismatch` → `unauthorized` |
| Grant sin el propósito | `incoherent_grant` antes de CP; el adaptador lo rechaza antes de la red; CP `purpose_not_granted` |
| CIA sin grant / con otro namespace | `contract_violation` (`invalid_response` / `foreign_customer_ref`) |
| CP con `customerRef` distinto | `customer_ref_mismatch` (R2) |
| CP sin autorización verificable | `authorization_basis_insufficient` |
| Header duplicado / grant demasiado grande | R4 envía uno solo; > 2048 bytes → `grant_malformed` antes de la red |
| 403 público sin motivo | `unauthorized`; un motivo indebido nunca se refleja |
| Timeout con el cuerpo a medias / abort del llamador | `timeout` en ambos adaptadores |
| Redirecciones y hosts no autorizados | `redirect: 'manual'` → `contract_violation`; URL no loopback rechazada al configurar |
| Fugas de JWS, e-mail, sujeto o `customerRef` | Ninguna (unit, adaptadores, capacidades y campaña) |
| Bypass por constructor o composición | Fábricas y composición fail-closed (AG-2) |

**Todos los fallos ocurren antes de exponer datos a la capacidad:** la salida o la observación fallida no contiene payload parcial.

## 13. Limitaciones

| # | Limitación |
|---|---|
| L1 | El lado R4 de la campaña corre desde fuentes (vitest), porque ningún servicio R4 desplegable registra estas capacidades. La CIA y CP sí corren compilados |
| L2 | Un binding **cerrado** se trata como `anonymous`. Es una decisión conservadora de este slice: la especificación solo nombra `bindingByTask` |
| L3 | Revocación v1: un grant ya emitido sigue siendo válido en CP hasta `exp` (≤ 300 s). Es el riesgo residual DM-06 |
| L4 | CP `degraded` es `temporarily_unavailable`, como en R2 (AP-08). No hay salida "degradada" para el modelo |
| L5 | Las descripciones de las capacidades son borradores (especificación R1 §6) |
| L6 | La deuda L-1 de CP (expiración durante la composición → 500) sigue abierta en CP. R4 la clasifica como `temporarily_unavailable` |
| L7 | R4 no inicia verificaciones (`start`) ni confirma OTP: SEC-OTP-01/02 pendientes (`R4_J4_R3_SEC_OTP_FOLLOWUP.md`) |
| L8 | La telemetría de los adaptadores se entrega a callbacks. No está conectada a un sink productivo porque no hay composición productiva |

## 14. Riesgos de activación

Una activación real exige, como mínimo, cada uno de estos puntos con su propio mandato:
- SEC-OTP-01/02;
- G-16, AP-01 a AP-11 (incluido AP-09, la política de cuentas) y D7;
- despliegue de CP-S5 en `required`, con el JWKS productivo fijado (KMS, DEP-6);
- credenciales reales de la CIA y CP, y URLs no loopback (hoy rechazadas por diseño);
- registro en `sales-production@8` (J4-R4);
- pruebas con kill switch y cohorte;
- política de datos personales para pedir el e-mail.

**Los modos de activación real no existen:**
- `R4_CUSTOMER_MODE=real` se rechaza en ambos adaptadores;
- la CIA solo admite loopback;
- la composición solo admite credenciales `synthetic-`.

## 15. Ausencia de despliegue

- Sin merge a `main` y sin despliegue en EC2.
- No se modificaron CIA (`origin/main` `7525395`), CP (`origin/main` `bbd766e`), el harness de R4, el webhook ni PrestaShop.
- No se enviaron e-mails reales ni se accedió a clientes reales.
- No se incorporaron credenciales productivas ni se habilitó ningún perfil productivo.
- **Sales no usa la CIA en producción.**
- G-16, AP-*, D7 y el merge histórico de 02C no se regularizan.

## 16. Clon limpio y dictamen

**Clon limpio de `origin/feat/r4-j4-r3-cia-cp-synthetic` @ `26a77e8`,** desde GitHub y en un directorio nuevo:

| Prueba | Resultado |
|---|---|
| `npm ci`, `build`, `lint`, `typecheck` | OK |
| `unit` + `contract` | 108 archivos · **1 668 PASS**, 4 skip (los opcionales de §10), 0 FAIL. Idéntico al worktree |
| Campaña R4 → CIA → CP (ejecución 3) | **23/23** (17,1 s) |
| Árbol tras la ejecución | Limpio, sin archivos generados sin seguimiento |

El commit de este informe solo añade documentación: este archivo y la evidencia en el registro de decisiones §9.

**Dictamen:**
- **R4-J4-R3 está listo para revisión del owner** (`R4_J4_R3_READY_FOR_OWNER_REVIEW`), solo en sintético.
- Rama publicada y sin merge.
- Las capacidades siguen fuera de todo perfil productivo (`R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED`).
- Siguen pendientes: SEC-OTP-01/02, G-16 y el bloqueo de datos reales.
