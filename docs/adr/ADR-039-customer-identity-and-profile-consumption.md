# ADR-039 — Consumo de identidad y perfil de cliente en R4

- **Estado:** **Propuesto — revisado por el owner: `ACCEPTED_WITH_REQUIRED_CHANGES`** (R4-J4-R1A-REVIEW-01, 2026-10-15). Las correcciones exigidas están aplicadas en esta versión. Pasa a **Aceptado (interno de R4)** cuando el owner confirme esas correcciones.
  - La aceptación interna cubre solo las decisiones de R4: D3, D4 (parte R4), D5 y D8.
  - **No** cubre ni declara resueltas las dependencias externas: D1 (autoridad de identidad), D2 (autorización individual) y D6 (identificador de producto) siguen pendientes de sus owners. D7 sigue como gate de datos reales y de producción.
  - **Corrección documental R4-J4-R1C (2026-10-15):** aplica las posiciones de R4 AP-01 a AP-11 y D6 del [registro de decisiones compartidas](../architecture/R4-J4-R1C_SHARED_DECISION_REGISTER.md) (§1, §5, §6, §7 y Pendiente). No cambia el estado de esta ADR: sigue Propuesta.
- **Fecha:** 2026-10-15. Versión entregada sin correcciones: commit `b680b2c`. Versión revisada en R1A: `2890a9c`.
- **Alcance:** cómo el pack Sales (y cualquier pack futuro) obtiene la identidad de cliente de una conversación y lee datos del cliente sin que el modelo elija a quién consulta. No modifica `packages/`, `apps/` ni `adapters/`; no crea migraciones, perfiles ni dependencias.
- **No cubre:** datos declarados por el cliente (GAP-05); entrega documental (R4 Media); corrección de la `identityAssurance` del harness (J7); retención y purga de observaciones (D7, plataforma/J7).
- **Autoridad superior:** Constitución ("model output is untrusted", "do not add infrastructure without demonstrated need"); AGENTS.md (Customer fuera de Core; sin acceso a tablas internas de CRM); ADR-005, ADR-011, ADR-013, ADR-016, ADR-030, ADR-036.
- **Documentos asociados:**
  - [especificación del consumidor](../architecture/R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md);
  - [requerimiento a Customer Service](../architecture/R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md);
  - [requisitos a Customer Profile](../architecture/R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md);
  - [informe de diseño](../architecture/R4-J4-R1_DESIGN_REPORT.md);
  - [informe de revisión](../architecture/R4-J4-R1A_REVIEW_01_REPORT.md);
  - [registro de decisiones compartidas R4 ↔ CP](../architecture/R4-J4-R1C_SHARED_DECISION_REGISTER.md) (R1C);
  - [decisión sobre la autoridad de identidad](../architecture/ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md);
  - evidencia de partida en [R4-J4-R0](../architecture/R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md).

## Contexto

Hechos verificados (las rutas de R4 se citan con línea; las externas, por repositorio y SHA):

| Hecho | Evidencia |
|---|---|
| R4 solo conoce una **identidad de canal**: el `wa_id` de un webhook autenticado por la firma de Meta, guardado como `recipientRef` del binding. Solo la ingress abre bindings | `adapters/channels/whatsapp-cloud/src/inbound.ts:105-112`; `packages/live-ops/src/ingress.ts:192-197` |
| R4 no resuelve clientes: producción escribe `customerRef: null` y Customer es `UNAVAILABLE` en `@1`–`@7` | `agents/sales/src/production/composition.ts:214-216`; `production/profile.ts:31` |
| `customer.get_context@1` no recibe argumentos y toma el cliente de `sales.conversations.customer_ref` (el `customerRef` de la conversación Sales, siempre `null` en producción). **No** usa el binding de canal de `ProductionStore` que usará `@2` (§3) | `agents/sales/src/capabilities/customer.ts:8,41-44` |
| La `identityAssurance` del harness describe al principal de la tarea (en producción, el servicio de ingress), no al cliente | `packages/task-runtime/src/action-runtime.ts:288-298`; `packages/contracts/src/capability.ts:139-145` |
| `ProductionStore.bindingByTask` devuelve el binding (con `recipientRef`) de una tarea | `packages/live-ops/src/ports.ts:311` |
| Vigencia de observaciones, contexto y persistencia (ADR-030) | §6 de esta ADR, verificado en código y con tests |
| Customer Profile (CP) autentica principales por Bearer y scope, pero **cualquier principal con scope lee cualquier `customerId`** | EXT-CP `45b28a3`: `src/http/auth/route-families.ts:60-92`; `docs/reviews/CP_J4_SECURITY_01_VALIDATION_REPORT.md:278` |
| CP no resuelve identidad de canal | EXT-CP `45b28a3` |
| CP tiene un contrato **candidato** `customer-profile.sales-context` v1 (schema, 23 fixtures sintéticos, 147 tests), sin productor ni ruta. Commits solo en una rama local sin upstream | EXT-CP `f631f32`: `docs/contracts/customer-sales-context-v1/` |
| CRM decide niveles L0–L3 solo para su propio agente. Su L2 no comprueba `is_verified` y vincula automáticamente por teléfono | EXT-CRM `8298723`: `evaluate.ts:45-70`; `native-whatsapp/service.ts:325-336` |
| La autoridad documentada de creación y vinculación es Customer Service. Auditado después: es `pc-users` y **no** ofrece resolución ni vinculación de identidades | EXT-CRM `docs/data/customer-creation-linking-authority-contract.md:124`; [ID-AUTHORITY-DECISION-01](../architecture/ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md) §1 |

Problema: para dar al agente contexto e historial de cliente sin crear acceso horizontal, R4 necesita tres cosas que hoy no existen:
1. una autoridad que diga qué cliente verificado corresponde a una identidad de canal autenticada;
2. una autorización **por cliente** que CP haga cumplir;
3. un contrato de consumo mínimo que degrade sin afectar la venta.

## Decisión

### 1. Autoridades

| Concepto | Autoridad | Estado |
|---|---|---|
| Identidad de canal (quién escribe en esta conversación) | **R4 ChannelIngress**, a partir de la firma del proveedor | Vigente |
| Identidad de cliente (qué cliente comercial verificado corresponde a esa identidad) | Autoridad de identidad externa. **Recomendada:** Customer Identity Authority (CIA), servicio dedicado con owner por designar (ID-AUTHORITY-DECISION-01). Customer Service (`pc-users`) no ofrece esa capacidad | **D1 BLOCKED**, pendiente de la designación del owner y de un contrato publicado |
| Autorización individual | Emitida por la autoridad de identidad; **aplicada por CP** | **D2 PROPOSED**, pendiente de CP y de la autoridad |
| Hechos de cliente | **Customer Profile** | Datos vigentes; contrato para R4 pendiente; significado comercial pendiente de la aceptación de CP-J4-CONTEXT |
| Qué ve el modelo | **Pack Sales**, mediante capacidades READ con esquema estricto | Esta ADR (D4) |

R4 **no** es autoridad de identidad de cliente, no lee tablas de CRM y no usa los niveles L2/L3 de CRM mientras sus comprobaciones sean insuficientes.

### 2. Identidad de canal ≠ identidad de cliente

- Un binding prueba que los mensajes llegan desde un `wa_id`. **No prueba la titularidad de una cuenta comercial**: el número puede estar reciclado o compartido, o vinculado solo por coincidencia de teléfono.
- R4 trata el `wa_id` como sujeto de canal y solo lo usa para pedir una resolución a la autoridad.
- Solo `assurance: verified` con un grant válido produce una referencia de cliente utilizable.

### 3. Resolución perezosa mediante `bindingByTask` — D3 **ACCEPTED**

En cada invocación, el handler obtiene el sujeto con `bindingByTask(execution.taskId)` y pide la resolución. No hay llamadas externas ni vinculación estática en la ingress, y `sales.conversations.customer_ref` sigue `null`.

Son dos bindings distintos:
- `@1` lee `sales.conversations.customer_ref`, una referencia de cliente ya resuelta y guardada en la conversación;
- `@2` y `get_purchase_history@1` leen el **sujeto de canal** (`channel`, `accountRef`, `recipientRef`) de `ProductionStore.bindingByTask` y obtienen el `customerRef` de la autoridad en cada invocación. Ese `customerRef` vive solo en la memoria de la invocación.

Consecuencias:
- una vinculación o revocación surte efecto en la siguiente invocación;
- no hay migración;
- cada lectura tiene el costo de una resolución, sin caché, hasta que J4-R5 mida que la necesita.

### 4. Autenticación de servicio ≠ autorización individual

- Los tokens de servicio de R4 frente a la autoridad y frente a CP solo identifican al consumidor (`r4-sales`) y limitan las rutas que puede usar. **No** autorizan un cliente concreto.
- Toda lectura de datos de cliente exige un **grant individual**, ligado a: cliente, consumidor, audiencia, propósito y expiración.

### 5. Modelo de grants — D2 **PROPOSED**

**Recomendación (no decisión): alternativa A.** La autoridad emite un grant firmado y corto (≤ 10 min) junto con la resolución. R4 lo transporta sin interpretarlo y CP lo verifica localmente.

La alternativa B (CP consulta en línea a la autoridad) y el modelo de amenazas completo están en el documento de requisitos de CP, §3 y §4. Hallazgos del modelo de amenazas que esta ADR fija como límites:

| Compromiso | Efecto con A | Mitigación | Residuo |
|---|---|---|---|
| **R4 comprometido** (worker o host con sus credenciales) | Puede pedir resoluciones para `wa_id` arbitrarios y leer cualquier cliente verificado cuyo número conozca. Ni A ni B lo evitan | Consumidor limitado a canal y cuentas, límites de tasa, auditoría y alertas de volumen en la autoridad | **Alto**, inherente a que R4 termina el canal |
| **Token de servicio de CP** solo | Inútil sin un grant emitido para `r4-sales` | Mantenerlo sin logs; rotación | Bajo |
| **Credencial del resolver** sola | Obtiene grants, pero no puede usarlos sin el token de CP | Credenciales separadas por destino; rotación | Medio |
| **Ambas credenciales de R4** | Equivale a "R4 comprometido" | Las mismas | Alto |
| **Un grant filtrado** | Lectura de un cliente, un propósito, ≤ TTL, solo junto con el token de CP | No registrar grants; TTL corto | Bajo |
| **Clave de firma de la autoridad** | Permite fabricar grants para cualquier cliente (requiere además el token de CP) | Custodia y rotación con `kid` | Alto, fuera de R4 |
| **Modelo / prompt injection** | No cambia a quién se consulta (I1). Solo puede repetir lecturas del mismo cliente | Esquemas estrictos | Bajo |

**El hash del sujeto no es prueba de autenticidad.** Si el grant incluye un hash del sujeto de canal, ese hash deriva de lo que R4 afirma. CP no recibe el sujeto ni puede verificarlo. Sirve para auditoría y correlación forense, **no** como prueba independiente de que el cliente escribió por ese canal.

**`authorizationBasis` (R1C, AP-05).** CP declara en cada respuesta si leyó con `service_scope_only` o con `customer_grant_verified`. Es **evidencia declarada** de su configuración, nunca una autorización individual suficiente:
- ninguna lectura privada real de J4 se habilita con `service_scope_only`;
- `customer_grant_verified` es necesaria, pero no suficiente: además hace falta D2 acordada, implementada y verificada en CP (I4);
- D2 sigue abierta hasta que la autoridad de identidad y CP aprueben el grant.

### 6. Vigencia, nuevas invocaciones y observaciones anteriores — D5 **ACCEPTED_WITH_CONDITIONS**

Comportamiento del runtime vigente, verificado en código y con `owner-freshness.test.ts`, `compiler.test.ts` y `context-config.test.ts` (54/54 PASS, 2026-10-15):

| # | Comportamiento | Evidencia |
|---|---|---|
| F1 | `runtimeValidUntil = observedAt + freshnessTtlMs`, con `observedAt` tomado **al terminar** el handler | `packages/capability-runtime/src/invoker.ts:91-96` |
| F2 | `validUntil = min(runtimeValidUntil, ownerValidUntil)`. El owner solo acorta, nunca extiende | `invoker.ts:97-98`; test `owner-freshness.test.ts:42,50` |
| F3 | `ownerValidUntil(output)` puede devolver `null`, y entonces rige el runtime. Si devuelve algo que no es un instante, o lanza, la invocación **falla** con `invalid_capability_output` | `registry.ts:31-38`; `invoker.ts:202-214`; tests `:57,93` |
| F4 | Las observaciones fallidas o rechazadas tienen `validUntil: null`. El compilador las clasifica `unknown`, nunca `expired`, y siguen en el contexto | `invoker.ts:98`; `context-compiler/src/freshness.ts:22-28`; test `:124` |
| F5 | Reinvocar con el mismo `invocationId` devuelve la observación registrada, sin recalcular ni extender | `invoker.ts:84-85`; test `:100` |
| F6 | Una invocación nueva crea otra observación con su propia vigencia. Las anteriores no cambian | `invoker.ts:103-133` |
| F7 | El contexto de cada run incluye **todas** las observaciones **de la tarea**, de cualquier run, con su payload completo. Nunca las de otras tareas | `task-runtime/src/execution-runtime.ts:412`; `persistence-postgres/src/observation-store.ts:27-28`; `context-compiler/src/sources/platform.ts:268-297` |
| F8 | Una observación vencida sale de lo "vigente". Con `R4_CONTEXT_EXPIRED_EVIDENCE=include` (**default**) **sigue visible como historia, con payload**. Con `exclude` sale del contexto. En ambos casos sigue persistida | `context-compiler/src/compiler.ts:326-329`; `apps/worker/src/config.ts:39,103`; test `compiler.test.ts:169` |

Decisión:

- **Expiración efectiva de una lectura Customer exitosa:** `min(observedAt + 10 min, ownerBound)`.
  - Para una respuesta `verified`, el handler calcula `ownerBound = min(CP.validUntil si no es nulo, grant.expiresAt)` y lo expone como `validUntil`, un campo **siempre presente y no nulo** en esa variante.
  - El extractor `ownerValidUntil` devuelve ese campo para `verified` y `null` para `unavailable`, que queda acotada por el runtime (10 min).
  - Así se corrige la incompatibilidad de la versión entregada, donde `validUntil: null` del puerto chocaba con un `validUntil` obligatorio en la salida.
- **Condición 1.** La vigencia controla qué es **verdad vigente**, no qué ve el modelo ni qué se borra (F8). La privacidad no puede apoyarse en la expiración: se apoya en la minimización (§7, D4). La eliminación es D7.
- **Condición 2.** El valor desplegado de `R4_CONTEXT_EXPIRED_EVIDENCE` no está verificado en EC2. Antes de J4-R5 se decide si el canary de `@8` usa `exclude`. Es configuración de despliegue, no harness, y afecta a todas las capacidades.
- **Condición 3.** Un grant con `expiresAt ≤ ahora` de R4 al recibirlo se trata como `contract_violation` (`incoherent_grant`). Un `CP.validUntil ≤ observedAt` se registra ya vencido (ADR-030 regla 4): entra solo como historia.
- **Condición 4 (R1C).** La observación persiste solo la **salida proyectada** de la capacidad (frontera C, §7). El adaptador no persiste ni registra la respuesta de CP (frontera B). Vencer no borra: la observación sigue persistida y, con `include`, visible como historia hasta que exista D7.

### 7. Minimización — D4 **corregida** (R1A) y **ampliada** (R1C, AP-03)

Tres fronteras distintas. Cada una tiene su autoridad y su control:

| Frontera | Qué es | Autoridad | Regla |
|---|---|---|---|
| **A. Dominio de CP** | Lo que CP necesita para representar fielmente los hechos comerciales | CP (y negocio) | J4 no la restringe. CP conserva montos, componentes de gasto, derivados e ids para otros productos y consumidores legítimos |
| **B. Cable CP → R4** | Lo que CP transmite a R4 | Acuerdo CP + R4; el owner de datos decide la legitimidad del propósito | Una ruta con `purpose` (AP-01). CP compone solo lo que el propósito necesita |
| **C. Observación del modelo** | La salida de la capacidad | R4 (pack Sales) | Allowlist de proyección y esquemas estrictos (especificación §6, §10) |

- **B en J4.** Lo que necesita cada propósito está en el [registro](../architecture/R4-J4-R1C_SHARED_DECISION_REGISTER.md) §3 (AP-01):
  - en ambos: estado, ciclo de vida, vigencia, estado primario de la cuenta y eco de `customerRef`;
  - `sales_context`: un indicador de historial;
  - `purchase_history`: por ítem, nombre histórico (o `null`), `catalogKey` (`null` mientras D6 esté diferida), unidades brutas, órdenes, día de última compra y tipo de línea.
  - **No viajan:** nombre, email, teléfono, RUT, dirección, **montos ni componentes monetarios**, referencias de pedido, ids de PrestaShop, SKU, antigüedad del cliente ni datos predictivos.
- **Un dato que el modelo no ve no queda justificado en B por eso.** Cada campo de B necesita un uso en C o en una decisión del adaptador (filtrar, retener, fijar precisión, controlar el gate).
- **Control en B:** composición por propósito en CP (primario) y, en R4, validación con un esquema estructurado por propósito. Un componente monetario o predictivo en una respuesta J4 da `contract_violation`. **No** se usa una lista de prefijos de clave.
- **C.** Solo los campos de la especificación §6. `displayName` **no forma parte** de la salida de `customer.get_context@2`. Agregarlo en el futuro requiere una nueva versión de la capacidad y una nueva decisión D4.
- **Nunca llegan al modelo ni a logs:** `customerRef`, `wa_id`, grant, `masterCustomerId` ni ids PrestaShop.

### 8. Revocación, reutilización y eliminación — D7 **PROPOSED_PRODUCTION_BLOCKER**

Son tres cosas distintas:

| Concepto | Qué ocurre hoy | Qué controla |
|---|---|---|
| **Revocación** | La autoridad deja de emitir `verified` y grants. Los grants ya emitidos valen hasta `expiresAt` (≤ 10 min). La siguiente invocación de R4 recibe `unavailable` | Nuevas lecturas |
| **Reutilización de observaciones** | Dentro de **la misma tarea**, las observaciones anteriores reaparecen en cada run: como vigentes hasta su `validUntil` y después como historia, con payload (F7, F8). No se reutilizan entre tareas | Qué ve el modelo durante la conversación |
| **Eliminación** | **No existe** en R4: no hay retención ni purga de observaciones (J4-R0, R3). Las copias en artefactos de evaluación pasan por la proyección de privacidad, que no elimina | Qué queda persistido |

Mientras no existan controles de retención aprobados:
- **J4-R5 queda restringido a identidades y datos sintéticos**: no se procesa ningún cliente real;
- la habilitación con clientes reales o productiva queda **bloqueada** hasta J7.

### 9. Degradación independiente

- Customer es una lectura opcional: ninguna capacidad de Catalog, Shipping o Quote la invoca ni depende de ella.
- `quote.create@5` sigue emitiendo `customer: { kind: 'guest' }` (I7).
- Un perfil que declare Customer `REAL` no compone sin su configuración. En ejecución, cualquier fallo Customer degrada solo esa lectura.

### 10. Compatibilidad y rollback

- `customer.get_context@1`, `CustomerDirectory`, el fixture, las definiciones v3–v7 y los perfiles `@1`–`@7` **no cambian** (I9). Lo nuevo es aditivo y solo se compone en un perfil nuevo (`@8`), fuera de esta ADR.
- **Rollback del canary:** `@8 → @7`, en el runtime de canary aislado. Es el que se ensaya en J4-R6.
- **Producción:** está en **`sales-production@3`** (`ef5a354`), no en `@7`. J4 no despliega ni modifica producción, y su rollout no está autorizado. Un futuro paso a `@8` en producción partiría de `@3` y tendría su propio rollback (a `@3` o al perfil vigente entonces), definido en J7.

## Invariantes de seguridad

Normativos. Sus pruebas de aceptación están en la especificación del consumidor §11.

| ID | Invariante |
|---|---|
| I1 | El modelo nunca proporciona la identidad del cliente consultado |
| I2 | El binding del canal no demuestra titularidad de una cuenta comercial |
| I3 | Solo identidad verificada **y** autorización individual permiten acceder a historial privado |
| I4 | Customer Profile aplica la autorización por cliente; no confía exclusivamente en el token de servicio |
| I5 | Una respuesta `not_found` nunca sustituye silenciosamente a un rechazo 401/403 |
| I6 | Los grants y datos sensibles no aparecen en logs, telemetría ni URLs |
| I7 | La ausencia de Customer Profile nunca impide una cotización `guest` |
| I8 | Los datos históricos de compra no demuestran propiedad actual ni compatibilidad con otros productos |
| I9 | Los perfiles Sales anteriores conservan sus contratos y hashes |
| I10 | El sujeto de canal proviene solo de `bindingByTask`; nunca de inputs, transcript, workspace ni memoria |
| I11 | R4 nunca equipara `masterCustomerId` con `prestashop_customer` ni lee tablas de CRM |
| I12 | R4 no consume datos predictivos (RFM, cluster, CLV, affinity, intelligence, commercial-profile) |

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Resolver en `afterOpen` y escribir `customer_ref` | Acopla la ingress a un servicio externo y congela la identidad: `bindConversation` es insert-once (`workspace/store.ts:140-147`) |
| Niveles L2/L3 de CRM | Viola AGENTS.md; L2 no comprueba `is_verified`; CRM en retiro |
| Confiar en el token de servicio frente a CP | Acceso horizontal a cualquier cliente (I4) |
| Que el modelo pase `customerRef` o un cursor | Viola I1 |
| Usar la `identityAssurance` del harness | En producción vale `provisional` para todo cliente |
| Modificar `customer.get_context@1` | Las definiciones son inmutables (I9) |
| Responder `unavailable` ante la caída del owner | Una respuesta exitosa queda vigente y oculta la caída. Se usa observación fallida |
| Apoyar la privacidad en la expiración | Las observaciones vencidas siguen visibles como historia y persistidas (F8) |
| `displayName` en la salida por defecto | Sin necesidad demostrada; minimización estricta (D4) |

## Consecuencias

- R4 depende de dos contratos externos que no existen: la resolución con grant y la lectura con grant. J4-R2 a J4-R6 quedan condicionadas a J4-R1B.
- El significado de "compra" (órdenes válidas, cancelaciones, devoluciones, unidades, fechas y zona horaria) depende de la aceptación de CP-J4-CONTEXT. No se congela antes.
- Mientras D7 no se resuelva, solo se usan datos sintéticos.
- El riesgo de un R4 comprometido se acota, pero no se elimina.

## Pendiente

| ID | Estado | Responsable |
|---|---|---|
| D1 | BLOCKED | Negocio (designación del owner de la CIA) + owner de la CIA |
| D2 | PROPOSED. La verificación individual no existe; `authorizationBasis` no la sustituye | Customer Profile + owner de identidad |
| D6 | DEFERRED_WITH_NULL (no aceptada): `catalogKey: null` hasta que exista un contrato verificado de Catalog y CP haga el mapeo | Catalog + Customer Profile |
| D7 | PROPOSED_PRODUCTION_BLOCKER | Plataforma R4 (J7) |

La matriz completa D1–D8 está en el [informe de diseño](../architecture/R4-J4-R1_DESIGN_REPORT.md) §3. Las conformidades externas de AP-01 a AP-11 están en el [registro de decisiones compartidas](../architecture/R4-J4-R1C_SHARED_DECISION_REGISTER.md).
