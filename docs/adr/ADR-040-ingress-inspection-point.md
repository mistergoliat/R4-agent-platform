# ADR-040 — R4-I.1: punto de inspección de la ingesta y protección obligatoria

- **Estado:** **Aceptado** en contenido por el owner (OA-02, `R4-J4-SEC-OTP-DESIGN-OWNER-REVISION-02`, decisión §9.1). Archivo redactado e implementado en SEC-S3 (`R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06`). Alcance **sintético**: ningún perfil productivo compone el inspector.
- **Fecha:** 2026-10-21.
- **Amplía:** R4-I (ingesta canónica de canal, ADR-029). Sin inspector, R4-I no cambia.
- **No cubre:** la clasificación del texto (SEC-S1), el almacén cifrado (SEC-S2), la confirmación en la CIA (SEC-S4), la capa comercial (SEC-S5) ni las entradas alternativas BA-01 a BA-06, que siguen siendo gates de activación real.
- **Autoridad superior:** Constitución ("model output is untrusted", "writes require governed execution", "do not add infrastructure without demonstrated need"); AGENTS.md (Core genérico, sin conceptos de dominio).
- **Documentos asociados:** [decisión de arquitectura SEC-OTP](../architecture/R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md) §5, §6.1, §6.4 y §9 · [modelo de amenazas](../architecture/R4_J4_SEC_OTP_THREAT_MODEL.md) · [informe SEC-S3](../architecture/R4_J4_SEC_S3_INGRESS_PROTECTION_REPORT.md).

## Contexto

- `ChannelIngress` persistía el texto canónico (`inbound_events.content`) y su hash (`content_sha256`) **antes** de cualquier decisión sobre su contenido. Después, `task_inputs.request_hash`, `memory_entries` y `context_snapshots` lo conservan de forma inmutable.
- Un secreto de un solo uso (un código de verificación) escrito en el chat no puede borrarse después. Un hash de 6 dígitos se invierte por fuerza bruta.
- El único punto donde coinciden la autenticidad del proveedor, la ausencia de persistencia, la identidad de la conversación y la deduplicación durable es la ingesta.
- `live-ops` es infraestructura operativa fuera del kernel (OA-01). El harness no debe aprender nada de OTP ni de proveedores.

## Decisión

**R4-I.1 — Punto de inspección de la ingesta.** `ChannelIngress` admite un único inspector genérico y versionado (`InboundInspector` v1), configurado por composición. Con un inspector configurado se cumplen estas invariantes:

1. **Inspección previa.** La inspección ocurre antes de cualquier persistencia conversacional (`inbound_events.content`, `task_inputs`, `memory_entries`) y antes de calcular cualquier hash persistente del contenido (`content_sha256`, `request_hash`).
2. **Sin llamadas externas en el webhook.** Ni la ingesta ni el inspector hacen llamadas de red ni invocan modelos ni servicios de dominio dentro de la petición. Todo efecto externo lo ejecuta un componente asíncrono.
3. **Aislamiento de secretos.** Un secreto capturado solo existe sellado, en almacenamiento propio del componente de integración, y solo lo descifran componentes fuera del agente. El proceso que ejecuta modelos y capacidades no tiene ni las claves ni las credenciales.
4. **Coherencia transaccional.** La lectura del estado que motiva la inspección, los efectos propios del inspector y la escritura del inbound ocurren en una transacción serializada por conversación. Un duplicado del proveedor se detecta antes de inspeccionar.
5. **Fallo cerrado.** Si el inspector tiene una obligación de protección vigente para la conversación y no puede decidir con seguridad, el contenido se reemplaza entero por un marcador de plataforma. Si la transacción no puede completarse, nada se persiste y el proveedor reentrega.
6. **Protección no desactivable.** Mientras un inspector declare una obligación de protección vigente, no puede retirarse de la composición ni ponerse en un modo que persista el contenido sin tratamiento. No existe un override para eso.
7. **Omnicanalidad.** El puerto, el contexto y las decisiones no contienen nombres de canal ni de proveedor. La autenticidad del origen sigue siendo responsabilidad de cada `InboundChannelAdapter`. Un canal nuevo solo requiere su adaptador autenticado.

Sin inspector configurado y sin obligaciones de protección vigentes, la ingesta es idéntica a R4-I.

Un cambio incompatible del puerto exige `version: 2` y una enmienda de este ADR.

## Materialización

| Invariante | Dónde | Prueba |
|---|---|---|
| Puerto v1, contexto confiable, decisión `pass` / `replace` | `packages/live-ops/src/inspection.ts` (`InboundInspector`, `TrustedChannelContext`, `InspectionDecision`) | Frontera AT-19 (`identity-verification-boundaries.test.ts`, `live-ops-boundaries.test.ts`) |
| 1 y 4: una transacción por conversación; lock, duplicado, contexto, inspector, inserción del texto decidido y su hash | `PostgresProductionStore.recordInboundInspected` (`pg_advisory_xact_lock(conversationLockKey)`) | RX-01…RX-07, AT-08, AT-11 |
| Lock idéntico en la ingesta y en el componente | `conversationLockKey` vive en `live-ops`; `@r4-adapters/identity-verification` lo reexporta | Vector fijado (`secret-box.test.ts`) y prueba de contrato S3-DEP-01 |
| 2: sin red en el webhook | El inspector solo usa la transacción recibida | AT-07 |
| 3: secreto sellado solo en el componente; claves solo en el gateway | `VerificationInspector` sella con la `SecretBox` del gateway; el worker no tiene la clave | AT-19, AT-20 (S2) |
| 5: fallo cerrado | Protección leída primero; un fallo posterior reemplaza el mensaje entero y revierte los efectos propios del inspector a un savepoint; un fallo previo aborta la transacción | AT-29b |
| 6: sin override | El gateway recibe el inspector como `GatewayBindings.inspection` (fábrica de la composición, igual que los adaptadores de canal: el gateway no importa adaptadores). Sin inspector, `assertNoOpenProtection` (`apps/channel-gateway/src/inspection.ts`) lee el esquema directamente y rechaza el arranque mientras exista una `protect_until` futura, aunque el componente no se componga. La fábrica `identityVerificationInspection` arranca en `protect_only` si `full` no tiene claves. No hay variable que lo evite | AT-27, AT-27b, AT-27c y prueba de contrato |
| 7: omnicanal | La atestación de conversación directa es del adaptador (`InboundChannelAdapter.directConversations`); `live-ops` no nombra canales | Frontera AT-19 |

## Consecuencias

- **Coste comercial aceptado (OA-07).** Durante una ventana de protección (≤ 20 min), los números de 4 a 8 dígitos no llegan al modelo.
- **El harness no cambia.** Ningún paquete de `agent-kernel`, `task-runtime`, `capability-runtime`, `context-compiler`, `model-gateway`, `policy-engine`, `contracts` u `observability` se modifica.
- **Entradas alternativas.** `POST /v1/tasks/:id/inputs` y las demás rutas E-2 a E-8 **no** pasan por el inspector. No son entradas equivalentes de canal protegidas: siguen siendo gates de activación real (BA-01 a BA-06).
- **Cobertura textual.** El clasificador no reconoce toda representación de un código (informe SEC-S1 §9; `SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING`). Este ADR no declara que una fuga sea imposible.

## Adenda R4-J4-R4 (2026-10-22): sin inspector tampoco con el componente en `full`

**Motivo.** El worker solo inicia una verificación si el modo durable del componente (`identity_verification.component_mode`) es `full`. Ese registro lo escribe el gateway que compone el inspector y sobrevive a ese gateway. Antes de esta adenda, un gateway compuesto **sin** inspector podía arrancar sin ventanas de protección abiertas mientras el registro seguía en `full`. En ese caso el worker podía iniciar una verificación cuyo código llegaría a un gateway sin protección. Un indicador declarativo no basta.

**Decisión.** `assertNoOpenProtection` también rechaza el arranque sin inspector mientras el modo durable sea `full` (`identity_verification_mode_full`). Para retirar el inspector hay que recomponerlo antes en `protect_only`, como ya exige el procedimiento del plan §5: `protect_only` → esperar a que expire la protección → `absent`. No hay override. El orden de las comprobaciones se mantiene: una ventana abierta se informa primero.

**Comprobación entre procesos de `sales-production@8`:**

1. El gateway `@8` compone siempre el inspector y lo pide en `full`. Sin el keyring o sin el cliente `confirm`, la composición se rechaza. Un keyring inválido, o un breaker abierto por credenciales rechazadas, lo dejan en `protect_only`; nunca queda sin inspector.
2. El worker `@8` comprueba al arrancar que el esquema `identity_verification` está al día. Antes de cada inicio, `identity.start_verification@1` lee el modo durable y rechaza (`verification_disabled`) si no es `full`.
3. Un gateway sin inspector no arranca mientras ese modo sea `full` ni mientras haya ventanas abiertas (esta adenda e inv. 6).

**Residual (R3-04, réplicas mixtas).** Un gateway sin inspector que **ya estaba corriendo** cuando otro arranca en `full` no se detecta, porque no existe presencia durable de gateways. Esto queda excluido por el procedimiento de despliegue: todas las réplicas del gateway deben componer el inspector antes de seleccionar `@8`, y el canary de J4-R5 usa un único gateway. Cerrarlo en código exige presencia de gateways, que queda fuera del alcance de J4-R4.

**Pruebas.**
- `tests/integration/sales-profile-v8.test.ts` C.
- `identity-verification-ingress.test.ts` («absent is allowed … and the component left full»).
- Contrato en `identity-verification-boundaries.test.ts`.
- Mutación PV8-M7.
