# ADR-024 — Primer adapter real de ModelProvider: OpenAI-compatible (R4-F)

- **Estado:** Aceptado; publicado en el R4-F BASELINE `1927499`
- **Fecha:** 2026-09-23
- **Autoridad superior:** Constitución §20, §25.11; PRD §13; ADR-004, 008, 015
- **Relacionado:** ADR-023

## Contexto

Hasta R4-E sólo existía `FakeModelProvider`. R4-F debe poder ejecutar el
Sales Agent con un modelo real sin que Core conozca proveedores, y dejar
abierta la puerta a endpoints hospedados, vLLM, modelos locales de 70B u
otros adapters sin cambiar el Sales Agent.

## Decisión

1. **`OpenAICompatibleModelProvider`** (`adapters/models/openai-compatible`,
   fuera de Core; depende sólo de `@r4/model-gateway`, `@r4/contracts`, `zod`)
   implementa la SPI `ModelProvider` contra `POST {baseUrl}/chat/completions`.
   Nombre genérico por protocolo, no por vendor.
2. **Configuración de despliegue** (`R4_MODEL_PROVIDER=openai_compatible`,
   `R4_MODEL_BASE_URL`, `R4_MODEL_API_KEY` opcional, `R4_MODEL_NAME`,
   `R4_MODEL_PROFILE`, `R4_MODEL_TIMEOUT_MS`, `R4_MODEL_CONTEXT_WINDOW_TOKENS`,
   `R4_MODEL_MAX_OUTPUT_TOKENS`, `R4_MODEL_RESPONSE_FORMAT`,
   `R4_MODEL_TEMPERATURE`, `R4_MODEL_EXTRA_BODY`). La `AgentDefinition` sigue sin proveedor, modelo,
   host ni secreto. `providerId = openai-compatible.<profile>` identifica el
   perfil lógico en telemetría.
3. **Renderizado en el adapter**: los mensajes del kernel conservan su rol; el
   JSON Schema de `AgentDecision` va como instrucción de salida; el
   `CompiledContext` viaja como un único documento JSON (sólo se omiten campos
   con valor por defecto). Nada se resume, reordena ni trunca.
4. **Protocolo de decisiones intacto** (ADR-008): `response_format:
   json_object` cuando se configura; no se envían tools nativas; tool calls o
   texto de razonamiento que devuelva un servidor se ignoran (nunca se guarda
   chain-of-thought). El adapter sólo quita un code fence Markdown alrededor
   del JSON; cualquier otra cosa la rechaza el parser estricto de la plataforma.
5. **Envelope físico en el adapter** (ADR-015: input efectivo =
   min(envelope, presupuesto R4)): estimación conservadora (bytes UTF-8 / 3) +
   salida reservada > ventana ⇒ `provider_error` no reintentable
   `model_envelope_exceeded`, sin llamar al servidor; un 400 del servidor por
   tamaño se mapea igual. Nunca se trunca en silencio. El Context Compiler no
   conoce el envelope.
6. **Errores clasificados**: 429 → `rate_limited`; 408/504 y el deadline de
   transporte propio → `timeout`; 5xx y fallos de transporte →
   `provider_error` reintentable; otros 4xx → `provider_error`; respuesta no
   mapeable → `invalid_provider_response`. El abort del gateway lo clasifica
   el gateway. Requiere el cambio mínimo de Core en `ModelProviderError`
   (ADR-023, tabla de cambios).
7. **Campos extra de la petición** (`R4_MODEL_EXTRA_BODY`, validación live
   pre-G): un objeto JSON opaco que se agrega al cuerpo, el `extra_body` de los
   clientes OpenAI-compatible. Sirve para hacer explícito un switch del
   servidor en vez de depender de su default, p. ej. DeepSeek
   `{"thinking":{"type":"disabled"}}` (`deepseek-flash` razona por defecto).
   El adapter no lo interpreta (sin `if (vendor)` en ningún lado) y no puede
   pisar campos propios (model, messages, max_tokens, stream,
   response_format, temperature, tools…): la configuración los rechaza y el
   cuerpo los escribe después. Se reporta en `describeModelConfig`, así que
   no es para credenciales. El texto de razonamiento sigue sin conservarse;
   los reasoning tokens no se exponen (requeriría ampliar `ModelUsage` en Core).
8. **Secretos**: la clave sólo viaja en el header `Authorization` de la
   petición saliente; nunca en mensajes de error (redactados), respuestas,
   logs, snapshots, observations, receipts ni artifacts (tests).

## Alternativas descartadas

- `DeepSeekProvider` u otro nombre de vendor para un protocolo genérico.
- SDK de vendor como dependencia (el `fetch` de Node basta; sin infraestructura nueva).
- Tool calling nativo como transporte de decisiones (queda para después de F).
- Tokenizer de vendor para el envelope (sólo hace falta rechazar lo que no cabe).

## Consecuencias

- Futuros adapters (Anthropic, vLLM con extensiones, local) implementan la
  misma SPI; el Sales Agent no cambia.
- Sin reintentos de modelo (C1): un timeout o una decisión inválida terminan
  la run con una razón clasificada.

## Enmienda R4-J1E-R2.3 — límite de salida gestionado por el proveedor

Evidencia de producción (DeepSeek `deepseek-flash`, thinking habilitado,
`max_tokens=8192`): el cuarto turno agotó `completion_tokens=8192` con
`finish_reason=length` y terminó en `invalid_structured_output`; la run de
recuperación repitió la misma condición. En thinking mode el razonamiento
consume el mismo `max_tokens` que el JSON, así que un techo de aplicación
restringía al agente sin representar un límite físico.

- `R4_MODEL_MAX_OUTPUT_TOKENS` deja de tener default. Ausente o vacío ⇒
  `outputLimitMode = provider_managed`: no se envía `max_tokens` ni
  `max_completion_tokens`; el proveedor/modelo es dueño del techo de salida.
  Un número ⇒ `fixed`: comportamiento previo (se envía y se reserva).
- Envelope (punto 5): en `fixed` sigue siendo input estimado + salida
  reservada > ventana; en `provider_managed` sólo input estimado > ventana.
  No se inventa reserva de salida.
- Un límite explícito por request (`limits.maxOutputTokens`, p. ej. el juez
  del evaluador) se sigue enviando; en `fixed` sólo puede bajar el techo.
- `describeModelConfig` agrega `outputLimitMode` (aditivo) y reporta
  `maxOutputTokens: null`; el plan de producción lo muestra tal cual.
- Perfil DeepSeek de producción: `R4_MODEL_CONTEXT_WINDOW_TOKENS=1000000`,
  `R4_MODEL_MAX_OUTPUT_TOKENS` sin definir; proveedor, modelo, thinking,
  `response_format`, temperatura y timeout sin cambios.

## Verificación

`tests/unit/sales/openai-compatible-provider.test.ts` (fetch falso: render,
JSON, envelope, estados HTTP, deadline propio vs. del gateway, respuesta
inválida, telemetría sin secretos); `tests/integration/sales-reference.test.ts`
(turno completo con el adapter, sin secretos en ninguna tabla ni log; timeout
del adapter → `model_failure/timeout`); `tests/contract/sales-boundaries.test.ts`
(imports del adapter; Core sin referencias).
