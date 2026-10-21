# R4-J4-SEC-OTP — Modelo de amenazas y pruebas de aceptación

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-DESIGN-01` |
| Fecha | 2026-10-21 |
| Para | Owner de R4, owner de la CIA, revisión de seguridad |
| Alcance | Arquitectura A de `R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md`: inspector pre-persistencia, almacén cifrado, despachador de confirmación diferida y capacidad de inicio. Incluye RR-1 (detalle en `R4_J4_RR1_BINDING_RACE_ANALYSIS.md`) |
| Estado | Diseño. **Ninguna prueba existe todavía**: los identificadores AT-* son la especificación de aceptación de los slices del plan |

---

## 1. Activos y fronteras de confianza

| Activo | Sensibilidad | Dónde puede existir |
|---|---|---|
| Código OTP | **Secreto** (10 min, de un solo uso) | Correo del cliente, chat de WhatsApp, memoria del gateway, `verification_responses` (cifrado), CIA (HMAC) |
| Email declarado | Dato personal | Chat, `memory_entries` (E1), `action_proposals`, CIA (cifrado o HMAC) |
| `verificationId` | Interno (inútil sin el código) | `verification_expectations`, CIA |
| Credencial `confirm` | Secreto | Solo en el entorno del gateway |
| Clave de cifrado del código | Secreto | Solo en el entorno del gateway |
| `appSecret` de Meta | Secreto | Gateway (ya existente) |
| Vínculo sujeto↔cuenta y grant | Autoridad de la CIA | CIA; el grant está en la memoria del handler (ADR-039) |

**Fronteras de confianza:**
- (F1) Meta → gateway: HMAC.
- (F2) Texto del cliente → plataforma: dato no confiable.
- (F3) Modelo → capacidades: salida no confiable.
- (F4) Gateway → CIA: bearer + TLS.
- (F5) Procesos R4 ↔ Postgres: base compartida.
- (F6) Logs de stdout → PM2 → disco.

---

## 2. Matriz de amenazas

Columna **Verif.**: **S** = verificable con pruebas sintéticas en el repositorio · **R** = requiere infraestructura o cuenta reales · **S+R** = ambas.

| ID | Amenaza | Escenario | Control | Capa | Prueba | Verif. |
|---|---|---|---|---|---|---|
| T-01 | Suplantación de mensajes del canal | Un atacante envía a `/v1/channels/whatsapp/webhook` un mensaje con un código para otro sujeto | HMAC `x-hub-signature-256` sobre el cuerpo crudo con `timingSafeEqual` **antes** de `parse` e `inspect` (`inbound.ts:51-60`; `ingress.ts:106-110`). Un 401 no persiste ni inspecciona nada | Gateway | AT-01 | S |
| T-02 | Reutilización del OTP | El mismo código se envía dos veces (dos mensajes distintos) | Dos `providerEventId` dan dos respuestas, procesadas en orden. Tras `linked` la segunda pasa a `cancelled(already_confirmed)`. Ante la CIA, un desafío consumido da `invalid_code` | Despachador + CIA | AT-05 | S |
| T-03 | OTP de otro sujeto | B escribe en su chat el código que recibió A | La expectativa se busca por `conversationKey` (el sujeto de B): B no tiene expectativa, o tiene la suya. En la CIA, otro sujeto da `invalid_code` sin revelar el motivo (SR-02, VC15) | Inspector + CIA | AT-03 | S |
| T-04 | OTP de otra sesión | El código llega a un binding nuevo de la misma conversación (la tarea anterior terminó) | El inspector exige `expectation.binding_id = binding abierto` con tarea no terminal. Si no, redacta, no captura y cancela la expectativa. En la CIA, otra `sessionRef` da `invalid_code` | Inspector + CIA | AT-04 | S |
| T-05 | Desafío sustituido | El cliente pide un código nuevo y luego escribe el anterior | `openExpectation` reemplaza la expectativa y cancela los `pending` en la misma transacción. La CIA invalida el desafío anterior. Un resultado en vuelo del desafío viejo no reanuda la tarea | Store + despachador + CIA | AT-06 | S |
| T-06 | Mensajes duplicados | Meta reentrega la misma notificación | `unique (channel, provider_event_id)` en `inbound_events` y `verification_responses`, escritos en una transacción. `confirm_idempotency_key` derivada de `(channel, providerEventId)` | Store + CIA | AT-08 | S |
| T-07 | Entrega fuera de orden | Un código viejo se procesa después de uno nuevo | Orden por `received_seq` dentro de la expectativa, con un reclamo serializado por expectativa. Las respuestas de expectativas no vigentes se cancelan | Despachador | AT-09 | S |
| T-08 | OTP expirado | El código llega tras `expiresAt` | Si `now ≥ challenge_expires_at`, no hay llamada a la CIA: redacción hasta `redact_until` y marcador `challenge_expired` | Inspector | AT-10 | S |
| T-09 | Mensaje parcialmente malformado | `48291`, `4 8 2-9 1 3`, `４８２９１３`, keycaps, ZWSP intercalado | Normalización NFKC + `\p{Nd}` + eliminación de `\p{Cf}` y keycaps. Candidatos de 4 a 8 dígitos redactados; solo los de 6 se capturan | Inspector | AT-02 (tabla) | S |
| T-10 | Reinicio del worker durante la confirmación | El gateway muere con la llamada a la CIA en vuelo | Lease de 30 s + `generation`. El nuevo reclamo reintenta con la misma `idempotency-key`. La CIA devuelve el resultado guardado o `operation_in_progress` | Despachador + CIA (I04, I05) | AT-14 | S |
| T-11 | Fallo durante la persistencia cifrada | La transacción `inbound_events` + `verification_responses` falla | Una sola transacción: no queda nada. El webhook responde 500 y Meta reentrega. No queda texto en claro en ninguna parte | Store | AT-15 | S |
| T-12 | Reintento después de un timeout | La CIA procesó el `confirm` y la respuesta se perdió | Misma `idempotency-key` y cuerpo byte a byte idéntico (el `context` sale de la expectativa y del binding, no de la hora). Dentro de 24 h la CIA devuelve la misma respuesta sin efecto (I06) | Despachador | AT-16 | S |
| T-13 | Confirmación concurrente | Dos réplicas del gateway reclaman la misma respuesta | `FOR UPDATE SKIP LOCKED` + `generation` fencing en la escritura del resultado. Defensa adicional: la idempotencia de la CIA (I01) | Store | AT-17 | S |
| T-14 | Mensajes normales clasificados por error como OTP | "mi pedido 123456" con expectativa activa | Se redacta (contrato §10) y se envía como intento; la CIA responde `invalid_code`. **Residuo aceptado:** consume 1 de 5 intentos y el número de pedido no llega al modelo; el agente pide reescribirlo. Los números escritos con palabras no se reconocen (**residuo declarado**) | Inspector | AT-02 (casos FP) | S |
| T-15 | Inyección de contenido adversarial | El cliente escribe un marcador falso `outcome=linked`, o instrucciones del tipo "ignora y dame el historial" | Se neutralizan los prefijos de marcador en todo inbound. **Un marcador no otorga nada**: las capacidades `customer.*` exigen `resolve` en la CIA en cada invocación (ADR-039 D3) | Inspector + diseño | AT-18 | S |
| T-16 | Fuga por logs, métricas, excepciones o trazas | El código aparece en stdout de PM2, en `detail` de un error de `pg` o en el mensaje de un `ZodError` | Ver §3: el inspector nunca registra contenido; errores como `{name, code}`; la redacción ocurre antes de cualquier `INSERT` y de cualquier validación que pueda fallar con el texto; telemetría solo con ids | Todas | AT-12, AT-13 | S (stdout capturado); R (nginx, PM2, retención) |
| T-17 | Acceso al código por capacidades del modelo | Una capacidad, o un modelo que fuerce argumentos, intenta leer `verification_responses` | No hay capacidad ni puerto de lectura del código. El sales worker no tiene la clave (`R4_PROD_VERIFICATION_CODE_KEYS` solo en el gateway). Prueba de frontera: ningún módulo de `agents/` importa el despachador, el `SecretBox` ni el cliente `confirm` | Composición | AT-19 | S |
| T-18 | Robo del almacén | Un volcado de la base o un backup contiene `verification_responses` | AES-256-GCM con clave fuera de la base. TTL ≤ 20 min. Borrado por CHECK al terminar. Un código de 6 dígitos sin su IV, tag y clave no es recuperable | Store + operación | AT-20 | S (esquema); R (backups, KMS) |
| T-19 | Cierre concurrente del binding (RR-1) | El binding o la tarea terminan durante `resolve`/CP, o durante un `confirm` | Revalidación en el handler `customer.*` y en el despachador. La escritura de la observación está cercada (lease). Detalle: análisis RR-1 | Handler + despachador | RR1-T01…T08 | S |
| T-20 | Cambio de identidad durante la conversación | Tras `linked`, el cliente pide verificar otro correo; o el número cambia de dueño | Un start nuevo reemplaza la expectativa. La CIA responde `conflicted` si el sujeto ya tiene un vínculo `verified` con otra cuenta (VC14). El reciclaje del número es responsabilidad de la CIA (revalidación B a 90 días, OD-CIA-3). R4 no cachea identidad | CIA + R4 | AT-21 | S (conflicted); R (reciclaje) |
| T-21 | El modelo inicia una verificación para otro sujeto | El modelo inventa `subjectRef` o `sessionRef` | La capacidad solo acepta `{email}` (`strictObject`). El `context` sale de `bindingByTask` (OWNER-R3-01; N-14) | Handler | AT-22 | S |
| T-22 | Agotamiento: spam de inicios | El modelo, manipulado, llama a `start` repetidamente | Política de la acción (OA-05), límites de la CIA (3/h y 6/día por sujeto, 5/día por email, reenvío ≥ 60 s) y una expectativa viva por conversación | Policy + CIA | AT-23 | S |
| T-23 | Fuerza bruta del código por el chat | El cliente (o quien controla el teléfono) prueba códigos | 5 intentos y luego `locked` (CIA SR-05). Cada mensaje es un intento. R4 no reintenta un `invalid_code` | CIA | AT-24 | S |
| T-24 | Credencial `confirm` usada para otra cosa | Fuga de la credencial del gateway | Scope exclusivo `identity.verification.confirm` (la configuración de la CIA lo impone): no sirve para `start`, `resolve` ni `revoke` | CIA | AT-25 (interop) | S |
| T-25 | Expectativa huérfana | El handler muere tras el 202 y antes de `markIssued` | La expectativa en `created` ya redacta (fail-closed). La acción se reconcilia con `idempotent_replay` y la misma clave. Si no, vence a los 600 s | Handler + barrido | AT-26 | S |
| T-26 | Rollback inseguro | Se desactiva el inspector con expectativas vivas y los códigos vuelven a llegar al modelo | Procedimiento de rollback ordenado: primero el start, luego esperar `redact_until`, luego el inspector (plan §5). El gateway rechaza arrancar sin inspector si existen expectativas vivas (salvo override explícito) | Operación | AT-27 | S |
| T-27 | Hash reversible del código | `content_sha256` o `task_inputs.request_hash` calculados sobre el texto con el código | La redacción ocurre antes de calcular cualquier hash (H3) | Inspector | AT-11 | S |
| T-28 | Código en canales no textuales | Captura de pantalla del correo enviada como imagen | Hoy se registra como `[unsupported inbound content: image]` y se aplica `handoff`: R4 no guarda el medio. **Residuo:** el operador humano ve la imagen en WhatsApp. Fuera de R4 | Adaptador | AT-28 | S |
| T-29 | Código introducido por una ruta que no es el canal | Un operador pega el código en `POST /v1/tasks/:id/inputs` | **Fuera de alcance:** esa ruta no pasa por `ChannelIngress`. Mitigación operativa: instrucciones del operador. Registrado como residuo | API | — | R |

---

## 3. Filtraciones anteriores al handler o fuera de él

| # | Punto | Hallazgo | Riesgo para el código | Control |
|---|---|---|---|---|
| H-L1 | Logging de peticiones de Fastify | Desactivado (`platform.ts:113`, `disableRequestLogging: true`) | Ninguno hoy | Prueba de regresión: un webhook con código no produce ninguna línea de stdout que lo contenga (AT-12) |
| H-L2 | Error handler del gateway | Registra `{name, code}` (`platform.ts:117-122`) | Ninguno | Mantener. El despachador sigue el mismo patrón |
| H-L3 | Barrido `resumeUnsettled` | Registra `error.message` (`platform.ts:182`) | Bajo: procesa filas ya persistidas, que están redactadas | Ninguno adicional |
| H-L4 | `pg` `DatabaseError.detail` | Incluye "Failing row contains (…)" con valores | El texto se redacta **antes** del `INSERT`. En `verification_responses` solo hay cifrado | AT-13: forzar una violación de CHECK y comprobar que `detail` no contiene el código |
| H-L5 | API `apps/api/src/app.ts:86` | Registra `{err}` completo en errores internos | No aplica a la ruta del canal. Aplica a `POST /v1/tasks/:id/inputs` (T-29) | Registrado. No se cambia en este diseño |
| H-L6 | `ZodError` en `canonicalInboundSchema.parse` | No verificado si Zod v4 incluye valores en los mensajes | Bajo: `parse` ocurre antes de `inspect`, pero su error no se registra con el texto en la ruta del gateway | AT-13b: un inbound inválido con 6 dígitos no deja el código en stdout |
| H-L7 | Logger pino | Redacta `authorization`, `cookie` y `*.token`/`secret`/`password`; **no** el texto de mensajes | Solo si alguien registrara el evento | Regla de código + AT-12. Añadir `*.code`/`*.text` a la redacción de pino es opcional (sería un cambio de `observability`, Core) y **no se propone** |
| H-L8 | nginx (EC2) | El log de acceso por defecto no incluye cuerpos | Ninguno con la configuración por defecto | **R:** revisar `log_format` y que no haya `mirror` ni módulos de cuerpo (OA-10) |
| H-L9 | PM2 | Captura stdout y stderr en disco | Solo si un proceso escribe el código | **R:** retención y permisos de `~/.pm2/logs` (OA-10) |
| H-L10 | APM | No existe (sin OpenTelemetry, Sentry ni Datadog) | — | Cualquier APM futuro debe excluir cuerpos y argumentos del inspector y del despachador |
| H-L11 | Meta | Meta conserva el mensaje en su plataforma y en el teléfono del cliente | Fuera del control de R4 | Inherente al canal: el código es de un solo uso y dura 10 min |
| H-L12 | Interfaz de operador (inbox humano) | Si existe una vista del chat de WhatsApp fuera de R4, muestra el mensaje original | Fuera de R4 | Registrado. El código expira y es de un solo uso |

---

## 4. Pruebas de aceptación

Todas son **sintéticas**, usan un doble de la CIA o la CIA sintética en interop, y ninguna envía un OTP real.

### 4.1 No persistencia

| ID | Prueba | Aserción |
|---|---|---|
| AT-02 | Tabla de clasificación (§6.3 del documento de decisión): ~40 casos, incluidos Unicode, separadores, keycaps, ZWSP, 5/7/9 dígitos, dos candidatos, teléfonos, RUT y montos | Texto persistido esperado y captura esperada, exactos. Para cada caso, sin expectativa: texto intacto (N-08) |
| AT-11 | Webhook firmado con `482913` y expectativa activa, contra Postgres real (`LiveOpsTestbed`) | `inbound_events.content_sha256 = sha256(marcador)`. Ningún `task_inputs.request_hash` coincide con el hash de un cuerpo que contenga `482913` |
| AT-12 | **Barrido N-15**: tras un flujo E2E sintético completo (start → código → `linked` → `customer.get_context@2`), `pg_dump --data-only` de la base de R4 + stdout y stderr capturados del gateway y del worker | La cadena `482913`, sus variantes con separadores y su forma de ancho completo **no aparecen** en ninguna tabla ni línea de log. `verification_responses.code_ciphertext` es nulo para todas las filas |
| AT-13 | Forzar errores con el código en vuelo: violación de CHECK, `pg` caído en el `INSERT`, CIA que responde basura | Ningún mensaje de error ni `detail` registrado contiene el código |
| AT-19 | Prueba de frontera (contract) | Ningún archivo de `agents/**` importa `SecretBox`, `VerificationConfirmDispatcher` ni el cliente `confirm`. La composición del sales worker no lee `R4_PROD_VERIFICATION_CODE_KEYS` ni `R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN` |
| AT-20 | Esquema | Un `UPDATE` a un estado terminal sin anular el cifrado falla por CHECK. El cifrado con otra AAD (otra fila) no descifra |

### 4.2 Idempotencia

| ID | Prueba | Aserción |
|---|---|---|
| AT-05 | Dos mensajes con el mismo código correcto | Un `confirm`. El segundo pasa a `cancelled(already_confirmed)` sin llamada |
| AT-08 | La misma notificación entregada 3 veces, también en paralelo | 1 fila de inbound, 1 respuesta y 1 llamada a `confirm` como máximo |
| AT-16 | El doble de la CIA aplica el efecto y corta la conexión antes de responder | El reintento usa la misma clave y el mismo cuerpo (fingerprint idéntico). La CIA (doble con semántica I01–I07) cuenta 1 intento |
| AT-17 | Dos despachadores contra la misma base | Cada respuesta se despacha una vez. Una escritura con `generation` vieja se rechaza |

### 4.3 Recuperación

| ID | Prueba | Aserción |
|---|---|---|
| AT-14 | El despachador muere (se aborta) tras enviar `confirm` | Tras vencer el lease, otro reclamo recibe el resultado guardado. La tarea recibe **un** marcador |
| AT-15 | Fallo de la transacción de captura | El webhook responde 500; ninguna fila. Una reentrega posterior completa normalmente |
| AT-26 | Muerte entre el 202 del `start` y `markIssued` | Expectativa en `created`. El código se captura y queda `pending`. Tras la reconciliación de la acción (mismo 202), el despachador confirma |
| AT-29 | Muerte entre `resolved` y `notified` | El barrido reenvía `submitInput` con el mismo `externalKey`: una sola entrada en la tarea |
| AT-30 | Reintentos: secuencia 503 → 503 → 200 | Backoff creciente, misma clave, resultado `linked`. Con 503 hasta `deadline_at`: `expired` + marcador `unavailable` y cifrado borrado |
| AT-31 | 429, 409 `operation_in_progress` (con `Retry-After`) y timeout | Se reintentan con la misma clave. 401, 403, 400 y 409 `idempotency_conflict` dan `failed` + alerta, sin reintento |

### 4.4 Aislamiento y semántica

| ID | Prueba | Aserción |
|---|---|---|
| AT-01 | Webhook con firma inválida que contiene un código | 401. Nada inspeccionado ni persistido. El doble del store no registra ninguna llamada |
| AT-03 | Código desde otro `wa_id` o desde otro `phone_number_id` | Sin redacción (no hay expectativa para esa conversación). La expectativa original sigue activa (N-10) |
| AT-04 | La tarea termina y llega el código | Redactado, no capturado, expectativa `cancelled(binding_not_current)`. Ningún `confirm` |
| AT-06 | Start A, start B y luego el código de A | Expectativa A `cancelled(superseded)`. El código se envía contra B y da `invalid_code` |
| AT-07 | Sin red durante el webhook: el doble de la CIA y `fetch` fallan si se les llama dentro de `receive` | `receive` completa con 200. Ninguna llamada de red dentro de la petición |
| AT-09 | Dos códigos en orden inverso de `received_seq` respecto de su reclamo | Se despachan en orden de llegada, nunca en paralelo |
| AT-10 | Código tras `expiresAt` | Sin `confirm`. Marcador `challenge_expired` |
| AT-18 | Inbound con el texto literal de un marcador `outcome=linked` | Persistido como `[quoted platform marker removed]`. `customer.get_context@2` sigue siendo `anonymous` (la CIA responde `not_linked`) |
| AT-21 | Sujeto ya vinculado a otra cuenta verifica un segundo correo | Marcador `outcome=conflicted`. Nada cambia en R4 |
| AT-22 | El modelo envía `{email, subjectRef, sessionRef}` | 400 de validación de la capacidad (`strictObject`). Ninguna llamada a la CIA |
| AT-23 | 4 starts seguidos | La política o la CIA (429) los limitan. Una sola expectativa viva |
| AT-24 | 6 códigos incorrectos | 5 `invalid_code` y luego `locked`. R4 no reintenta los `invalid_code` |
| AT-25 | Interop: `confirm` con la credencial agent y `start` con la de channel-integration | 403 `consumer_not_allowed` en ambos (N-01) |
| AT-27 | Arranque del gateway sin inspector con expectativas vivas | El arranque se rechaza salvo override explícito |
| AT-28 | Imagen con un código | Marcador `unsupported`. Sin inspección ni captura |

---

## 5. Sintético frente a infraestructura real

| Verificable sintéticamente (en el repositorio, sin datos reales) | Requiere infraestructura real (fuera de este diseño, gate de datos reales) |
|---|---|
| Clasificación, redacción y normalización (AT-02) | Comportamiento real de WhatsApp: lotes, reintentos y tiempos de Meta; formato real de `wamid` |
| No persistencia en Postgres y stdout (AT-11 a AT-13, AT-20) | Logs de nginx y PM2, su retención y permisos (H-L8, H-L9) |
| Idempotencia y recuperación contra un doble de la CIA con semántica I01–I10 y contra la CIA sintética en interop (AT-05 a AT-17, AT-26 a AT-31) | Custodia de claves en KMS o gestor de secretos, rotación operativa |
| Fronteras de composición (AT-19) | Separación de roles de base de datos |
| Carreras RR-1 deterministas (análisis RR-1) | Entrega real de correo (DEP-5 de la CIA) y su latencia frente al TTL |
| Allowlists y scopes de la CIA (AT-25) | Política de datos personales y legal (D7, DEP-10) |
| | WhatsApp Flows (alternativa C), si se adopta |
