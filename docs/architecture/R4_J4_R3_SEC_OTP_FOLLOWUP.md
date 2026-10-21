# R4-J4-R3 — Seguimiento de SEC-OTP-01 y SEC-OTP-02

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-R3-CIA-CP-INTEGRATION-01` (§11) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 y owner de la CIA |
| Estado | **SEC_OTP_01_PENDING** y **SEC_OTP_02_PENDING**. Este documento **no implementa nada**: describe qué cambios exigirá cada condición, para que un mandato propio los decida |
| Fuente normativa | Contrato CIA `v1-d2`, §10 (CIA `7525395`), que define SEC-OTP-01/02 y sus requisitos |

## 1. Qué hace R4-J4-R3 y qué no

| Hace | No hace |
|---|---|
| Consume `POST /v1/identity/resolve` por invocación, con el sujeto del binding confiable | Iniciar una verificación (`start`) ni confirmarla (`confirm`) desde R4 |
| Transporta el grant a Customer Profile | Leer, clasificar, redactar o reenviar un OTP |
| — | Tocar el webhook, `ChannelIngress` (`packages/live-ops/src/ingress.ts`), la semántica asíncrona del harness ni los workers |

**El vínculo de la campaña sintética lo establece la propia CIA**, con su flujo `start`/`confirm`:
- confirma un principal de integración de canal **generado para la prueba**;
- el código sale de un buzón falso en memoria de la CIA;
- nada pasa por WhatsApp ni por R4.

Por eso **ningún OTP** llega, en este slice, a:
- `inbound_events.content`;
- `memory_entries`;
- `task_inputs`;
- el prompt;
- el historial de herramientas;
- los logs de ingesta.

## 2. SEC-OTP-01: confirmación sin llamar a la CIA dentro del webhook

**Restricción vigente.** El invariante R4-I prohíbe llamar a un modelo, a un owner de dominio o a una entrega dentro de la petición del webhook (`packages/live-ops/src/ingress.ts:56-61`). Una llamada síncrona a `confirm` en el webhook (opción O1 original) queda descartada.

**Cambios que exigirá** (en un mandato propio, previa enmienda del invariante R4-I y DEP-11):

| Pieza | Cambio necesario | Dónde |
|---|---|---|
| Desvío en la ingesta | Cuando hay un desafío activo para el binding, **antes** de `recordInbound` (`ingress.ts:115`, `:140`), el mensaje candidato se desvía y no se persiste como contenido conversacional | `packages/live-ops` (puerto nuevo, no una capacidad) |
| Almacén del código | Dedicado, **cifrado**, con TTL ≤ TTL del desafío y borrado al entregar. Nunca en `inbound_events.content`, `memory_entries`, `task_inputs` ni telemetría | Migración nueva de `persistence-postgres` |
| Entrega diferida | Un worker llama a `POST /v1/identity/verifications/confirm`:<br>• con la credencial **de integración de canal**, distinta de la credencial `agent` que R4-J4-R3 usa para `resolve`;<br>• con `idempotency-key` derivada de `(channel, providerEventId)` | Worker de la plataforma (`apps/worker` o `apps/channel-gateway`) |
| Fallos de la CIA | 503 o timeout: reintento con backoff dentro del TTL y con la **misma** clave.<br>4xx: terminal. 409 `idempotency_conflict`: error de programación | Worker |
| Orden | Por conversación: un código no adelanta a un desafío nuevo que lo invalidó | Worker y almacén |
| Reanudación | La tarea se reanuda con un **marcador de plataforma sin código** (patrón `unsupportedContentMarker`) | Ingesta y harness, sin cambiar su semántica asíncrona |

**Alternativas a evaluar,** sin solución elegida:
- O1 diferido;
- O2: relay externo, sin cambios en R4;
- O3: formulario nativo del canal.

**Decisión previa necesaria:** quién emite el `start` y cómo llega el e-mail del cliente. Hoy R4 no tiene ninguna capacidad que lo haga, y el e-mail es un dato personal que entraría en la conversación.

## 3. SEC-OTP-02: el OTP nunca llega a la persistencia ni al modelo

**Restricción del contrato.** Con un desafío activo, una respuesta OTP **reconocible**, aunque tenga mal formato, **no debe** llegar sin tratamiento a la memoria ni al modelo. Ejemplos:
- una frase con el código;
- otro separador;
- 5 o 7 dígitos;
- dígitos de ancho completo.

**Cambios que exigirá:**

| Pieza | Cambio necesario |
|---|---|
| Clasificador | En la ingesta, **antes de cualquier persistencia**, y solo con una expectativa activa del mismo sujeto y la misma sesión (`bindingId`). Detecta las variantes reconocibles |
| Redacción | La secuencia candidata se sustituye por un marcador de plataforma **antes** de persistir. Los falsos positivos (por ejemplo, un número de pedido) también se redactan, y la conversación pide reescribirlos |
| Normalización | Solo un código normalizado de 6 dígitos sigue la ruta de SEC-OTP-01 hacia la CIA |
| Pruebas | N-09 cambia: el texto llega redactado y el código no aparece en `memory_entries`, `inbound_events`, la telemetría ni el contexto del modelo |
| Expectativa | Estado efímero por binding (desafío activo con TTL), escrito por quien emite el `start` (ver §2). Nunca derivado del texto del usuario |

## 4. Lo que **no** debe hacerse

- **No** diseñar la confirmación como una capacidad ordinaria que reciba el código del modelo. El modelo **nunca** ve el OTP: ni en argumentos, ni en observaciones, ni en el contexto.
- **No** introducir llamadas síncronas a la CIA dentro del webhook.
- **No** persistir el código en ningún almacén conversacional, ni siquiera de forma temporal.

## 5. Dependencias y bloqueos

| Bloqueo | Owner |
|---|---|
| Enmienda del invariante R4-I (entrega diferida desde la ingesta) | R4 |
| DEP-11 | R4 · CIA |
| Credencial de integración de canal de R4 ante la CIA (scope `identity.verification.confirm`) | CIA (D1) |
| Política para pedir el e-mail en la conversación (dato personal) | Owner de datos |
| Pruebas de no persistencia (N-09 revisado) | R4 |

```text
SEC_OTP_01_PENDING
SEC_OTP_02_PENDING
```
