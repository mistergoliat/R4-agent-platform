# ADR-039 — Consumo de identidad y perfil de cliente en R4

- **Estado:** **Propuesto** (R4-J4-R1A, 2026-10-15). Pendiente de revisión del owner de R4. Las responsabilidades atribuidas a Customer Service y Customer Profile son **propuestas a esos owners**, no decisiones: Customer Service no fue auditado y Customer Profile no ha aceptado ningún contrato para R4.
- **Fecha:** 2026-10-15
- **Alcance:** cómo el pack Sales (y cualquier pack futuro) obtiene la identidad de cliente de una conversación y lee datos del cliente sin que el modelo elija a quién consulta. No modifica `packages/`, `apps/` ni `adapters/`; no crea migraciones, perfiles ni dependencias.
- **No cubre:** datos declarados por el cliente (GAP-05), entrega documental (R4 Media), corrección de `identityAssurance` del harness (J7), retención de observaciones (J7, D7).
- **Autoridad superior:** Constitución ("model output is untrusted", "writes require governed execution", "do not add infrastructure without demonstrated need"); AGENTS.md (Customer fuera de Core; sin acceso a tablas internas de CRM); ADR-005, ADR-011, ADR-013, ADR-016, ADR-030, ADR-036.
- **Evidencia:** [`R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md`](../architecture/R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md) §3–§4; [`R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md`](../architecture/R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md).

## Contexto

Hechos verificados en J4-R0 (las rutas de R4 se citan con línea; las externas, por repositorio y SHA):

| Hecho | Evidencia |
|---|---|
| R4 solo conoce una **identidad de canal**: el `wa_id` de un webhook autenticado por firma de Meta, guardado como `recipientRef` del binding que únicamente la ingress abre | `adapters/channels/whatsapp-cloud/src/inbound.ts:105-112`; `packages/live-ops/src/ingress.ts:192-197` |
| R4 no resuelve clientes: producción escribe `customerRef: null`; Customer es `UNAVAILABLE` en `@1`–`@7` | `agents/sales/src/production/composition.ts:214-216`; `production/profile.ts:31` |
| `customer.get_context@1` no recibe argumentos y toma el cliente del binding de la conversación | `agents/sales/src/capabilities/customer.ts:8,41-44` |
| La `identityAssurance` del harness describe al principal de la tarea (en producción, el servicio de ingress), no al cliente | `packages/task-runtime/src/action-runtime.ts:288-298`; `packages/contracts/src/capability.ts:139-145` |
| `ProductionStore.bindingByTask` devuelve el binding (con `recipientRef`) de una tarea | `packages/live-ops/src/ports.ts:311` |
| La vigencia de una observación puede acotarla el owner (`ownerValidUntil`) | ADR-030; `packages/capability-runtime/src/invoker.ts:98-100` |
| Customer Profile (CP) autentica principales por Bearer y scope, pero **cualquier principal con scope lee cualquier `customerId`** | EXT-CP `45b28a3`: `src/http/auth/route-families.ts:60-92`; `docs/reviews/CP_J4_SECURITY_01_VALIDATION_REPORT.md:278` |
| CP no resuelve identidad de canal | EXT-CP `45b28a3`: lectores por `id_customer` |
| CRM decide niveles L0–L3 solo para su propio agente. Otorga L2 sin comprobar `is_verified` y vincula automáticamente por teléfono con `isVerified: false` | EXT-CRM `8298723`: `lib/domains/customer-identity-verification/evaluate.ts:45-70`; `lib/brain/native-whatsapp/service.ts:325-336` |
| La autoridad documentada de creación y vinculación es Customer Service. Su repositorio no fue auditado | EXT-CRM `docs/data/customer-creation-linking-authority-contract.md:124` |

Problema: para dar al agente contexto de cliente e historial sin crear un acceso horizontal, R4 necesita tres cosas que hoy no existen:
1. una autoridad que diga qué cliente verificado corresponde a una identidad de canal autenticada;
2. una autorización **por cliente** que Customer Profile haga cumplir;
3. un contrato de consumo que minimice datos y degrade sin afectar la venta.

## Decisión propuesta

### 1. Autoridades

| Concepto | Autoridad | Estado |
|---|---|---|
| Identidad de canal (quién escribe en esta conversación) | **R4 ChannelIngress**, a partir de la firma del proveedor | Vigente |
| Identidad de cliente (qué cliente comercial verificado corresponde a esa identidad de canal) | **Autoridad de identidad externa**. Candidato prioritario: Customer Service | **Propuesta** (D1; requisitos en [`R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md`](../architecture/R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md)) |
| Autorización individual (este consumidor puede leer los datos de este cliente para este propósito) | Emitida por la autoridad de identidad y **aplicada por Customer Profile** | **Propuesta** (D2; requisitos en [`R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md`](../architecture/R4-J4-R1_CUSTOMER_PROFILE_AUTHORIZATION_REQUIREMENTS.md)) |
| Hechos de cliente (perfil, compras) | **Customer Profile** | Vigente como datos; contrato para R4 pendiente |
| Qué ve el modelo | **Pack Sales**, mediante capacidades READ con esquema estricto | Esta ADR |

R4 **no** es autoridad de identidad de cliente, no lee tablas de CRM y no usa directamente los niveles L2/L3 de CRM mientras sus comprobaciones sean insuficientes.

### 2. Identidad de canal ≠ identidad de cliente

- Un binding de canal prueba que los mensajes llegan desde un `wa_id`. **No prueba la titularidad de una cuenta comercial**: el número puede estar reciclado o compartido, o vinculado solo por coincidencia de teléfono.
- R4 trata el `wa_id` como **sujeto de canal** y solo lo usa para pedir una resolución a la autoridad.
- Solo una resolución con `assurance: verified`, emitida por la autoridad, produce una referencia de cliente utilizable.

### 3. Resolución perezosa mediante `bindingByTask` (decisión de R4, D3)

1. El handler de la capacidad obtiene el sujeto con `bindingByTask(context.execution.taskId)`, usando `channel`, `accountRef` y `recipientRef`.
2. Con ese sujeto, pide la resolución a la autoridad **en cada invocación**.
3. Ninguna llamada externa ocurre en la ingress (`afterOpen`), y `sales.conversations.customer_ref` sigue `null`.

Consecuencias:
- una caída de la autoridad no deja inbound sin liquidar;
- una vinculación posterior durante la conversación surte efecto en la siguiente lectura;
- una revocación surte efecto en la siguiente resolución;
- no se requiere migración.

El costo es una llamada adicional por lectura. Esta ADR no agrega caché: se agregará si la latencia medida en J4-R5 lo justifica.

### 4. Autenticación de servicio ≠ autorización individual

- El token de servicio de R4 frente a Customer Profile solo identifica al consumidor (`r4-sales`) y limita **qué rutas** puede usar.
- **No** autoriza a leer un cliente concreto.
- Cada lectura de datos privados exige además un **grant individual** ligado a:
  - cliente;
  - sujeto de canal;
  - consumidor;
  - audiencia;
  - propósito;
  - expiración.
- Customer Profile lo verifica y rechaza cualquier discrepancia.

### 5. Modelo de grants (D2) — recomendación, no decisión cerrada

**Recomendada: alternativa A.** La autoridad de identidad emite un grant firmado, de vida corta (≤ 10 min), junto con la resolución. R4 lo transporta sin interpretarlo y Customer Profile lo verifica localmente (firma, audiencia, consumidor, cliente, propósito, expiración).

**Alternativa B:** Customer Profile consulta en línea a la autoridad en cada lectura.

La comparación completa está en el documento de requisitos de CP §3. Se recomienda A por cuatro razones:
- aísla la disponibilidad de CP de la autoridad;
- no obliga a CP a recibir el `wa_id`;
- da auditoría en ambos extremos;
- su ventana de revocación está acotada por la expiración.

D2 queda **PROPUESTA** hasta que la acepten Customer Profile y el owner de identidad.

**Límite que ninguna alternativa elimina.** La autoridad confía en que R4 presenta un sujeto de canal auténtico. Un R4 comprometido podría pedir resoluciones para otros `wa_id`. Esto se acota, sin eliminarse, mediante:
- un consumidor restringido a un canal y a `accountRef` permitidos;
- límites de tasa;
- auditoría por resolución.

### 6. Revocación, expiración y fallos

- **Vigencia:** cada observación Customer vence en `min(runtime TTL, grant.expiresAt)` (ADR-030 `ownerValidUntil`). Al vencer, el modelo debe volver a leer, lo que provoca una nueva resolución.
- **Revocación:** la exposición máxima tras revocar es la vida del grant. Los datos ya observados quedan en la observación persistida (§7).
- **Respuestas de identidad** (`anonymous`, `not_linked`, `not_verified`, `not_authorized`, `ambiguous`): son **respuestas**, no fallos.
- **Fallos del owner** (caída, timeout, 5xx, 429): son **observaciones fallidas** con categoría `temporarily_unavailable` o `timeout`. No se convierten en una respuesta "sin cliente", porque esa respuesta quedaría vigente durante el TTL y ocultaría la caída.
- **401/403:** son fallos `unauthorized` y no se reintentan. Nunca se presentan como `not_found` ni como `unavailable`.
- **Respuesta fuera de contrato:** es `contract_violation`, sin reparación.

### 7. Minimización y persistencia

- El modelo nunca ve:
  - email, teléfono, RUT, dirección o montos;
  - referencias de pedido;
  - ids de PrestaShop o del maestro;
  - `customerRef`, `wa_id` o grant.
- Lo que sí ve está en la especificación del consumidor §6.
- Las salidas Customer se persisten como observaciones. R4 no tiene hoy retención ni purga de observaciones (J4-R0, riesgo R3). La minimización es la mitigación en J4. La retención (D7) es plataforma y bloquea la habilitación productiva (J7), no las fases J4-R2 a J4-R4.
- El grant y la referencia de cliente viven solo en memoria durante la invocación. No se persisten ni se registran en logs.

### 8. Degradación independiente

- Customer es una lectura opcional: ninguna capacidad de Catalog, Shipping o Quote la invoca ni depende de ella.
- `quote.create@5` sigue emitiendo `customer: { kind: 'guest' }`.
- Si Customer no está configurado, la composición de un perfil que lo declara `REAL` se niega a arrancar, como con Catalog. El rollback es volver al perfil anterior.
- Una vez compuesto, cualquier fallo Customer degrada solo esa lectura.

### 9. Compatibilidad con versiones históricas

- `customer.get_context@1`, `CustomerDirectory`, `FixtureCustomerDirectory`, las definiciones v3–v7 y los perfiles `@1`–`@7` **no cambian**. Sus huellas y hashes siguen fijados en `tests/contract/`.
- La composición de referencia, el shadow y la evaluación siguen usando v1 con el fixture.
- Lo nuevo (puertos, `get_context@2`, `get_purchase_history@1`, definición v8, `sales-production@8`) es aditivo y solo se compone en un perfil nuevo. Esa implementación está **fuera** de esta ADR y de J4-R1.

## Invariantes de seguridad

Normativos para cualquier implementación. Sus pruebas de aceptación están en la especificación del consumidor §10.

| ID | Invariante |
|---|---|
| I1 | El modelo nunca proporciona la identidad del cliente consultado |
| I2 | El binding del canal no demuestra titularidad de una cuenta comercial |
| I3 | Solo identidad verificada **y** autorización individual permiten acceder a historial privado |
| I4 | Customer Profile aplica la autorización por cliente; no confía exclusivamente en el token de servicio |
| I5 | Una respuesta `not_found` nunca sustituye silenciosamente a un rechazo 401/403 |
| I6 | Los grants y datos sensibles no aparecen en logs ni telemetría |
| I7 | La ausencia de Customer Profile nunca impide una cotización `guest` |
| I8 | Los datos históricos de compra no demuestran propiedad actual ni compatibilidad con otros productos |
| I9 | Los perfiles Sales anteriores conservan sus contratos y hashes |
| I10 | El sujeto de canal proviene solo de `bindingByTask`; nunca de inputs, transcript, workspace ni memoria |
| I11 | R4 nunca equipara `masterCustomerId` con `prestashop_customer` ni lee tablas de CRM |
| I12 | R4 no consume datos predictivos (RFM, cluster, CLV, affinity, intelligence, commercial-profile) |

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Resolver en `afterOpen` y escribir `customer_ref` (propuesta CP §2) | Acopla la ingress a un servicio externo. Congela la identidad al inicio: `bindConversation` es insert-once (`workspace/store.ts:140-147`). Una revocación no surtiría efecto durante la conversación |
| Usar niveles L2/L3 de CRM vía su base o su endpoint de contexto | Viola AGENTS.md (tablas CRM). L2 no comprueba `is_verified`. El endpoint es de operador. CRM está en retiro |
| Confiar en el token de servicio de R4 frente a CP | Acceso horizontal a cualquier cliente (I4) |
| Que el modelo pase `customerRef` o un cursor | Viola I1 |
| Usar `identityAssurance` del harness como evidencia de identidad | En producción vale `provisional` para todo cliente (describe al servicio de ingress) |
| Modificar `customer.get_context@1` | Las definiciones son inmutables (I9). v1 sigue sirviendo a referencia y evaluación |
| Responder `unavailable` ante la caída del owner | Una respuesta exitosa quedaría vigente durante el TTL y ocultaría la caída. Se usa observación fallida |

## Consecuencias

- R4 depende de dos contratos externos (resolución con grant y lectura con grant) que aún no existen. J4-R2 a J4-R6 quedan condicionados a su publicación (J4-R1B).
- Cada lectura Customer cuesta una resolución más una lectura. El presupuesto se fija en la especificación §8.
- Sin retención de observaciones, los datos minimizados de clientes verificados persisten en R4 hasta que J7 defina la política.
- El riesgo de un R4 comprometido que fabrique sujetos de canal se acota con controles en el consumidor, pero no se elimina.

## Pendiente de decisión

| ID | Pregunta | Responsable |
|---|---|---|
| D1 | Owner de identidad: confirmar Customer Service tras su auditoría | Customer Service + owner de R4 |
| D2 | Alternativa A o B, formato del grant y gestión de claves | Customer Profile + owner de identidad |
| D4 | Si `displayName` es visible para el modelo y para los jueces de evaluación | Owner de R4 (privacidad) |
| D6 | Identificador de producto del historial (clave Catalog o nulo) | Catalog / Customer Profile |
| D7 | Retención de observaciones con datos de cliente | Plataforma R4 (J7) |

La matriz completa D1–D8 está en [`R4-J4-R1_DESIGN_REPORT.md`](../architecture/R4-J4-R1_DESIGN_REPORT.md) §3.
