---
title: R4 Voice — G0 Discovery técnico (WhatsApp Calling, gateway WebRTC, consulta humana)
status: R4_VOICE_G0_DISCOVERY_READY_FOR_REVIEW — sin código; G1 bloqueado por prerrequisitos del owner
date: 2026-11-22
mandate: PRD «R4 Voice Gateway & Human Consultation Service» v0.1 (2026-11-22), §16–§17
roadmap: voz pertenece a R4-L Extended Platform (PRD R4 §40). Este documento no abre la fase; propone su primer paso.
---

# R4 Voice — G0 Discovery técnico

## 0. Resumen

- **Es viable** atender llamadas de WhatsApp con un gateway propio en Go + Pion sobre EC2, sin proveedor de telefonía.
  Meta documenta exactamente lo que Pion hace por defecto: Meta es ICE-lite y siempre CONTROLLED, el negocio debe ser
  ICE completo, CONTROLLING y cliente DTLS (`setup:active`), con Opus a 48 kHz y 20 ms. Las llamadas entrantes son
  gratis y abren la ventana de 24 h de WhatsApp.
- **No hace falta transcodificar.** El gateway puede reenviar los paquetes Opus entre WhatsApp y el motor de voz, que
  también habla WebRTC. Lo mismo vale para el navegador del operador. G1 y G2 no necesitan libopus ni cgo.
- **El motor de voz recomendado es GPT-Live de OpenAI** (`/v1/live/sessions`, WebRTC entre servidores). Su modelo de
  *delegación* sigue hablando mientras un backend lento trabaja. Es el calce exacto con R4, cuyos turnos de texto tardan
  decenas de segundos. La alternativa es la Realtime API (`gpt-realtime-2.1` / `-mini`) por la misma vía.
- **R4 ya tiene el «Human Consultation Service».** Consultas, aprobaciones ligadas a los argumentos exactos y handoff
  son primitivas de Core, y se contestan desde la consola y la mesa de ventas. G4 no es un servicio nuevo: es ADR-056
  más opciones de respuesta y avisos al responsable.
- **R4 no puede estar en el camino caliente de la voz.** Un turno de R4 tarda decenas de segundos, casi todo en el
  modelo. La voz conversa sola y delega en R4 solo lo comercial. R4 responde con evidencia y la voz lo dice.
- **G1 está bloqueado** por seis prerrequisitos externos: número de prueba con Calling, override de webhook, puerto UDP
  en AWS, acceso al host, ruta HTTPS y teléfonos de prueba (§12.1). Por eso esta ejecución entrega solo G0, sin código.

## 1. Arquitectura real encontrada

### 1.1 Componentes que tocan el PRD

| Componente | Qué hace hoy | Evidencia |
|---|---|---|
| Gateway de canal | Proceso Fastify en loopback detrás de nginx con TLS. Recibe `/v1/channels/:channel/webhook`, compone **un** canal por proceso | `apps/channel-gateway/src/platform.ts:97`, `:221` |
| Adaptador WhatsApp | Firma `X-Hub-Signature-256` obligatoria con el app secret. Acepta un solo `phone_number_id`. **Solo lee `field: messages`**; cualquier otro campo se ignora | `adapters/channels/whatsapp-cloud/src/inbound.ts:53`, `:80`, `:85` |
| Ingress | Un payload sin mensajes responde 200. Activar Calling no rompe el texto, pero una llamada que llegue a esta URL suena hasta fallar | `packages/live-ops/src/ingress.ts:202` |
| Canal web (ADR-046) | Un *edge* externo firma eventos JSON (HMAC con timestamp) y recibe las respuestas firmadas. Es transporte puro | `adapters/channels/web/src/index.ts:13` |
| Tareas y workers | Cada conversación es una tarea durable; un worker ejecuta el Agent Kernel. Un turno de texto dura decenas de segundos, casi todo en tiempo de modelo (medido; las cifras de producción no van en este repo público) | ADR-008, ADR-045 |
| Salida | Durable, con despachador por *polling*, idempotente, sin reenvío de resultado incierto y con la ventana de 24 h aplicada | ADR-029, ADR-055 |
| Colaboración humana | `consultation`, `approval` y `handoff` como `HumanRequest`, con scopes, `TrustedHumanContext`, `responseKey` idempotente y expiración agendada | `packages/contracts/src/temporal.ts:73`, `:181`, `:220` |
| Aprobaciones | Ligadas a `proposalId` + `capabilityId@version` + `argumentsHash` + `validatedArguments`: una aprobación no sirve para otra acción | `packages/contracts/src/temporal.ts:201` |
| Consola (ADR-049/050) | Aplicación del owner: atención, tomar, responder y soltar conversaciones, operaciones de producción | repo privado de la consola |
| Mesa de ventas (ADR-048) | PWA de vendedores: «Pesín te consulta», tomar y soltar conversaciones. Está en QA | repo privado de la mesa |
| Omnicanalidad (ADR-053) | Un agente por canal (`sales-<canal>`), capas contacto → persona → cliente, vínculos probados | `docs/adr/ADR-053-omnichannel-contacts-persons.md` |
| Modelos | Adaptador OpenAI-compatible (ADR-024), modelos de texto vía un agregador. No hay proveedor de voz a voz ni clave directa de OpenAI | ADR-024 |
| Despliegue | Un host EC2 compartido, procesos pm2, nginx + certbot, Postgres en Docker. Poca memoria libre y sin swap. Los security groups nunca se auditaron en este repo | `R4-J3A_QUOTE_OWNER_AUDIT.md:91` |

### 1.2 Lo que no existe

- Nada de streaming: no hay WebSocket, UDP, WebRTC, audio continuo ni procesos de baja latencia.
- No hay Go en el repo, que es un monorepo TypeScript.
- No hay endpoint para ejecutar capacidades fuera de una corrida del kernel. Las lecturas de Catalog solo ocurren
  dentro de un turno de agente.
- No hay manejo del campo `calls` de Meta.

## 2. Diferencias respecto al PRD v0.1

| # | PRD | Realidad | Consecuencia |
|---|---|---|---|
| D1 | Human Consultation Service nuevo, con tablas propias | Ya existe en Core como `HumanRequest`, con consola y mesa | G4 = extender (ADR-056, opciones, avisos). No hay tablas `human_consultation_*` |
| D2 | Human Operator Console nueva | La consola (owner) y la mesa (vendedores) existen | La UI de llamadas va en la mesa de ventas |
| D3 | 13 estados de llamada | Meta no avisa RINGING en las entrantes, no renegocia y puede mandar terminate antes que connect | 4 estados más un atributo de quién tiene el audio (§6.3) |
| D4 | 9 tablas `voice_*` | Los permisos son de Meta (se consultan), las herramientas son corridas de R4, las métricas son logs | G1 no usa base de datos; G2+ usa 2 tablas del servicio de voz (§6.5) |
| D5 | `VoiceTurnRequest/Result` síncrono | R4 es asíncrono (tarea, input, salida) y lento: el resultado «pendiente» es la norma | El contrato es un canal firmado como ADR-046 (§7) |
| D6 | Realtime por WebSocket | WebSocket solo acepta PCM o G.711, no Opus. Habría que transcodificar con libopus (cgo) | WebRTC sin transcodificar (§8) |
| D7 | UC-04: descuento excepcional | Política vigente del owner: sin descuentos. R4 no tiene capacidad de descuento | Ejemplo de aprobación: una cotización sobre el tope de autonomía |
| D8 | Despliegue independiente | Un solo host compartido, sin swap: un proceso de voz sin tope puede tumbar el texto por memoria | Tope de memoria duro o instancia aparte (decisión O-5) |
| D9 | Webhook de llamadas al gateway | Una app de Meta tiene **una** URL de callback para todos los campos. El gateway de R4 ignora `calls` | Override del número de prueba para G1; reenvío desde el gateway de R4 para el número de R4 (§6.2, O-3) |
| D10 | No almacenar transcripciones | R4 guarda cada input de forma durable. Lo que la voz delegue a R4 queda escrito, como un WhatsApp | Entra en la retención y el aviso legal (§10, O-8) |
| D11 | — | Meta ofrece SIP, pero al activarlo **deshabilita** los endpoints de llamadas de la Graph API. Conectar Meta SIP directo a OpenAI SIP no está documentado y no calza la URI | SIP descartado para el MVP |

## 3. Viabilidad de Pion WebRTC con Meta

**Veredicto: viable, con confianza alta en la señalización y el medio.** Lo que falta probar es la llamada real (G1).

| Requisito de Meta (docs, 2026-11-22) | Pion v4.2.x |
|---|---|
| Meta es ICE-lite y siempre CONTROLLED; el negocio debe ser ICE completo y CONTROLLING | Pion pasa a CONTROLLING automáticamente cuando el remoto es ICE-lite, aunque responda la oferta (`peerconnection.go`). Nunca usar `SetLite(true)` |
| El negocio es cliente DTLS (`setup:active`); certificados ECDSA recomendados | Es la respuesta normal de Pion ante `actpass`; ECDSA por defecto |
| Opus 48 kHz, ptime 20 ms, una SSRC, un m-line; DTMF RFC 4733 a 8 kHz (PT 126 en la oferta de Meta) | Registrar Opus y `telephone-event/8000`. Verificar que la respuesta use el PT 126 de la oferta |
| Sin trickle; Meta acepta chequeos desde direcciones no anunciadas | Responder con la SDP completa tras reunir candidatos (`GatheringCompletePromise`) |
| Sin medio del negocio por 20 s al inicio o 30 s a mitad de llamada, se corta | Generador de silencio Opus cada 20 ms cuando no hay fuente (§6.4) |
| Sin renegociación ni ICE restart | Reiniciar el proceso corta las llamadas en curso: se registra y se acepta |
| Responder en unos 30–60 s desde el webhook `connect` | Webhook → 200 inmediato → aceptar en paralelo |
| Medio de Meta por UDP 40012/3478/3480/3482/3484; unos 60 kbps por llamada | Un puerto UDP propio con `SetICEUDPMux`; IP pública con `SetICEAddressRewriteRules` (reemplaza a `SetNAT1To1IPs`, obsoleto) |

**Evidencia externa:**
- whatomate usa Pion v4.2 con WhatsApp Calling y reporta audio en un solo sentido y cortes a los 20 s por UDP cerrado.
  Su licencia es AGPL, así que **no se copia su código**.
- jargo deja solo la huella SHA-256 porque, según dice, WhatsApp rechaza las otras.
- VoiceBlender usa Pion por SIP y confirma que Meta no inicia el DTLS.
- mediasoup falla porque es solo ICE-lite: el mismo rol que Meta.

**Cambio de fuente.** `TrackLocalStaticRTP.WriteRTP` reescribe SSRC y payload type, pero no la secuencia ni el
timestamp. Al cambiar de fuente (IA → humano, o saludo → eco) hay que mantenerlos monótonos. Si no, el receptor descarta
los paquetes como viejos y hay silencio; whatomate lo sufrió y lo corrigió. Es el patrón del ejemplo `swap-tracks`.

## 4. Requisitos de configuración de Meta

| # | Requisito | Fuente |
|---|---|---|
| M1 | Número en Cloud API, no en la app Business | Calling overview |
| M2 | Límite diario de mensajería de al menos 2.000 destinatarios únicos; si no, error 138015. **Los números de prueba y el sandbox están exentos** | Calling overview, FAQ |
| M3 | Línea de crédito o medio de pago válido (error 131044). No exige verificación del negocio | Troubleshooting |
| M4 | App suscrita al campo `calls`. Las respuestas a permisos llegan por `messages` (solo G6) | Webhooks de Calling |
| M5 | `POST /{phone-number-id}/settings` con `calling.status=ENABLED`, `call_icon_visibility`, `call_hours`, `srtp_key_exchange_protocol=DTLS` (defecto) y sin `sip` | Call settings |
| M6 | Graph API v17.0 como mínimo; se fija la versión vigente al iniciar G1 (la última es v27.0) | FAQ, changelog |
| M7 | Token de usuario de sistema con `whatsapp_business_messaging` | Calling overview |
| M8 | El cliente llama desde iPhone o Android; no desde WhatsApp Web ni Desktop | FAQ |
| M9 | Los clientes de WhatsApp pueden tardar hasta 7 días en reflejar un cambio de configuración. **Desactivar Calling en Meta no es un kill switch inmediato** | Call settings |
| M10 | Chile admite llamadas entrantes y salientes. Las salientes requieren permiso explícito del usuario | Calling overview, business-initiated |

## 5. Requisitos de red en AWS

| # | Requisito | Nota |
|---|---|---|
| N1 | IPv4 pública estable (Elastic IP) en el host del gateway | Pion la anuncia con `SetICEAddressRewriteRules` |
| N2 | Security group: entrada UDP en **un** puerto (por ejemplo 40000/udp) desde 0.0.0.0/0 | Las IP de relay de Meta cambian; restringir al AS32934 de Meta es un endurecimiento opcional |
| N3 | Salida UDP hacia los puertos de Meta | La regla de salida por defecto ya lo permite; verificar |
| N4 | Firewall del host (si lo hay) con el mismo puerto abierto | Por verificar en el host |
| N5 | Ruta HTTPS para el webhook de llamadas, en nginx con el certbot existente, hacia un puerto loopback del gateway | Subdominio o path propio |
| N6 | Tope de memoria del proceso (`MemoryMax` de systemd o `--memory` de Docker) si va en el host compartido | Riesgo R-6 |
| N7 | Reloj sincronizado (NTP) | Los webhooks se ordenan por timestamp |
| N8 | Región: los webhooks salen de EE. UU. y OpenAI está en EE. UU. El host actual sirve para el MVP; São Paulo se evalúa solo si la latencia medida lo justifica | Riesgo R-9 |
| N9 | Para G5 (navegadores de operadores): el mismo puerto UDP y, de respaldo, ICE-TCP en un puerto propio. El gateway tiene IP pública, así que TURN no debería hacer falta (por verificar en redes restrictivas) | — |

## 6. Diseño del Voice Gateway

### 6.1 Proceso y ubicación

Un binario Go, `r4-voice`, con Pion v4.2.x, sin cgo en G1 y G2. Se compila estático en local con la imagen Docker de
Go y se copia al host, que no necesita toolchain.

Va en un **repo privado aparte**, igual que el edge web, la consola y la mesa (decisión O-2). Es un *proveedor de canal*
para R4, no Core: otro lenguaje, despliegue independiente y aislamiento (PRD §3.4). En R4 solo entra, en G3, el
adaptador del canal `voice`, junto a `adapters/channels/web`.

```text
 Cliente WhatsApp ──(Meta Calling)──┬── HTTPS webhook `calls` ──► nginx ──► r4-voice :control
                                    └── UDP WebRTC (Opus) ───────────────► r4-voice :media (1 puerto)
 r4-voice
   control: webhook firmado → máquina de estados → Graph API (pre_accept/accept/reject/terminate)
   media:   PeerConnection Meta ◄─► relay RTP (reescribe SSRC/seq/ts) ◄─► fuente activa:
              · G1: eco / saludo pregrabado (Ogg Opus) / silencio
              · G2: PeerConnection al motor de voz (WebRTC) + canal de datos de control
              · G5: PeerConnection al navegador del operador
   r4:      (G3) canal `voice` firmado ◄─► gateway de canal R4 (input / respuesta en texto)
```

### 6.2 Ruteo del webhook `calls`

La app de Meta tiene una sola URL de callback, y hoy esa URL es el gateway de R4. Meta permite además una URL alternativa
por **número de negocio** (o por WABA), y `calls` está entre los campos admitidos (docs «Webhook overrides»). El override
es **por número, no por campo**: también se lleva los `messages` de ese número.

**G1 y G2:** se usa el **número de prueba público de Meta** de la app actual, con un override a nivel de número hacia
`r4-voice`. No hay app nueva ni cambio en R4, y el número de R4 no se toca.

**Número de R4 (G3 en adelante):** un override movería también sus `messages` fuera de R4, así que no sirve. Hay dos
opciones:
- El gateway de R4 reenvía tal cual, y sin esperar, los `changes` con `field: calls` a `r4-voice` por loopback.
  Es un cambio chico en R4 y es el recomendado.
- Una segunda app de Meta suscrita al WABA. Que Meta le entregue `calls` no está documentado.

Se decide con la evidencia de G1 (O-3).

**Descartado:** poner `r4-voice` delante del webhook de mensajería. Metería la voz en el camino crítico del texto.

### 6.3 Estados de la llamada (derivados de los eventos reales de Meta)

```text
OFFERED ──accept 200──► ACTIVE ──terminate (nuestro o de Meta)──► ENDED
   │                                                              ▲
   └── reject / timeout / terminate antes de aceptar ─────────────┘
ENDED.reason ∈ {completed, failed, rejected, missed, killed}
ACTIVE.mediaOwner ∈ {test, ai, human, none}   (cambia en G5, sin cambiar el estado)
```

- **ENDED es absorbente.** Un `connect` repetido o atrasado después de ENDED se ignora. Un terminate que llega antes
  que el connect deja la llamada en ENDED, y el connect posterior nunca se acepta.
- **Idempotencia.** La clave es `wacid` más evento más timestamp. Un `connect` duplicado produce un solo accept.
- **Webhook.** Se valida la firma, se responde 200 de inmediato y se procesa en segundo plano (Meta corta a ~20 s y
  reintenta).
- **Sin `pre_accept` en G1.** Cualquier paquete enviado antes del 200 del `accept` inicia el cronómetro del cliente.
  Aceptar directo es más simple y es lo que Meta recomienda si no se controla ese momento.

### 6.4 Medio

- **Relay.** Lee RTP de una PeerConnection y lo escribe en la otra, con secuencia y timestamp monótonos propios
  (+960 por cada 20 ms a 48 kHz).
- **Silencio.** Si la fuente activa no entrega un paquete en 20 ms, se manda una trama Opus de silencio precodificada.
  Así se cumple la regla de 20/30 s de Meta sin codificador. La trama exacta se valida en el paso S2.
- **Saludo de G1.** Archivo Ogg Opus generado fuera de línea y leído con el `oggreader` de Pion.
- **Allowlist de llamantes.** Se rechaza toda llamada de un número que no esté en la lista, guardada en la
  configuración del host.
- **Concurrencia.** Una llamada a la vez en el MVP; una segunda se rechaza. Duración máxima configurable (30 min), con
  aviso y terminate.
- **Kill switch.** Una variable de entorno o archivo hace que `r4-voice` rechace toda llamada nueva y termine las
  activas. Es inmediato, a diferencia del ajuste de Meta (M9).
- **Métricas** (stats de Pion, a logs estructurados): tiempo hasta accept, estado ICE/DTLS, RTT, jitter, pérdida, paquetes
  en cada sentido y razón de término.
- **Sin grabación.** El audio nunca se escribe a disco.

### 6.5 Datos

- **G1:** sin base de datos. Las llamadas no sobreviven a un reinicio (Meta no renegocia), así que no hay nada que
  reanudar. Los eventos van a logs estructurados.
- **G2+:** dos tablas en un esquema propio de `r4-voice`, con su propio rol y migraciones, nunca en el esquema de Core:
  - `voice_calls`: `call_id`, `wacid` único, dirección, contacto (con el mismo HMAC de identidad de R4, nunca el número
    en claro), estado, `media_owner`, inicio, fin, razón, tarea R4 y correlación.
  - `voice_call_events`: append-only.
- **Fuera del modelo:** los permisos son de Meta (`GET /call_permissions`), las herramientas son corridas y receipts de
  R4, y las consultas son de R4.

## 7. Diseño de interfaces con R4 (G3)

**Principio:** la voz conversa; R4 decide lo comercial. Ningún precio, stock o compatibilidad se dice si no viene de R4.

1. **Canal `voice` en R4**, con el patrón de ADR-046: eventos JSON firmados (HMAC con timestamp) de entrada y texto
   firmado de salida. Lo atiende un agente `sales-voice` propio (ADR-053 D2) con **perfil solo de lectura** (Catalog,
   despacho), como la web. No hay escritura de cotizaciones en el MVP. El ADR-053 D2 implica un gateway y un worker por
   canal: es memoria adicional en el host (R-6).
2. **Entrada.** Por cada pedido delegado: `{ callRef, contactRef, utteranceId, text, occurredAt, modality: "voice" }`.
   - `utteranceId` es la idempotencia.
   - `text` es la **transcripción final** de lo que dijo el cliente. Nunca un parcial, y nunca el resumen del modelo de
     voz, porque la salida del modelo no es confiable.
   - `contactRef` es el número del llamante firmado por Meta.
3. **Salida.** La respuesta de `sales-voice` (con evidencia, guardas de turno y aviso F-ADV-2) llega a `r4-voice` como
   texto firmado. El motor de voz la recibe como resultado de la delegación, con la instrucción de decir las cifras
   textuales.
4. **Interrupciones.** Si el cliente interrumpe, se cancela el **audio**, no la tarea de R4. Si una respuesta llega con
   la llamada terminada, `r4-voice` la devuelve como no entregada y R4 no la reenvía (semántica actual de resultado
   incierto).
5. **Auditoría de lo dicho.** Al cortar, `r4-voice` compara las cifras de la transcripción de salida del motor con los
   textos que entregó R4 en esa llamada. Guarda solo el resultado (coincide / cifras sin respaldo), no la transcripción.
   Es la evaluación obligatoria de G3.
6. **Continuidad con WhatsApp escrito (UC-08).** Queda fuera de G3. Es el mismo número firmado por Meta, pero la regla
   de vínculo de ADR-053 hoy no cubre «mismo identificador del proveedor en dos canales»: es la decisión O-6. La llamada
   sí abre la ventana de 24 h, así que la entrega por texto será posible cuando se decida.

**Descartadas:**
- El motor de voz llama a Catalog directo: duplica y salta a R4.
- R4 decide cada frase y la voz solo transcribe y sintetiza: con decenas de segundos por turno, es inusable.
- Un endpoint nuevo de lecturas rápidas para la voz: es cambio de Core y ADR propio. Se reevalúa solo si la latencia
  medida de `sales-voice` en G3 no se sostiene con la delegación.

## 8. Estrategia de integración con el motor de voz

1. **Primero GPT-Live** (`gpt-live-1.1`, GA): WebRTC entre servidores, con `r4-voice` como cliente.
   - El Opus pasa sin transcodificar y el control va por el canal de datos.
   - La **delegación** es nativa: acuse hablado automático, la conversación sigue y llega un `commentary` con el
     resultado verificado.
   - Precio: US$0,05 por minuto activo.
   - La documentación oficial no muestra una oferta SDP generada por un servidor, así que **G2 abre con un spike de un día**.
2. **Respaldo: Realtime API** (`gpt-realtime-2.1` o `-mini`) por WebRTC (`POST /v1/realtime/calls`).
   - Tiene llamadas a función asíncronas.
   - Interrupción con `response.cancel` + `output_audio_buffer.clear`.
   - Sesiones de hasta 60 min.
3. **Último recurso: WebSocket con transcodificación** (pion/opus para decodificar y libopus por cgo para codificar).
   Solo si los dos caminos WebRTC fallan.
4. **Abstracción del proveedor.** Un motor es «un par WebRTC más un canal de control». No se construye un segundo
   proveedor hasta que haga falta. Gemini Live, por ejemplo, exige PCM por WebSocket, o sea transcodificar.
5. **Turnos.** Detección semántica del motor, reducción de ruido `near_field` (teléfono) y saludo inicial con aviso de
   asistente automático (O-7).
6. **Datos.** OpenAI retiene 30 días por monitoreo de abuso. ZDR requiere aprobación previa de OpenAI. Enviar audio a
   EE. UU. es transferencia internacional (Ley 21.719 art. 27).

Requiere una cuenta y clave de OpenAI con tope de gasto. Hoy no existe: el modelo de producción va por un agregador sin
API de voz a voz.

## 9. Propuesta de Human Consultation Service

**No se crea un servicio.** Las piezas del PRD se mapean a Core así:

| PRD | R4 hoy |
|---|---|
| Información | `request_consultation` → `HumanRequest{kind: consultation}` → respuesta `answer` |
| Autorización | `ActionProposal` → política → `HumanRequest{kind: approval}` ligada a `argumentsHash` → `approve`/`reject` |
| Decisión | Consulta **sin opciones estructuradas** (brecha H-2) |
| Escalamiento | `request_handoff` / takeover del operador → `accept`/`release` |
| `consultation_id`, `conversation_id`, `requested_by` | `requestId`, `taskId` (más binding), `runId` |
| `assigned_responsible`, `response`, `expires_at` | `humanRef` (asignación en la mesa), `HumanResponse` con `responseKey`, `expiresAt` + agenda `human_expiry` |
| `authorization_scope` | Exacto por diseño: capacidad, versión y hash de argumentos |
| Estados | `requested → answered/approved/rejected/expired/cancelled`; `PENDING_DELIVERY` no existe porque la entrega es la consola o la mesa |
| «Una transcripción no es autorización» | Ya garantizado: `approval.decide` solo entra con `TrustedHumanContext` firmado por la API, nunca desde un input de canal |

**Brechas** (G4, cada una con su autorización):
- **H-1 — ADR-056** (PR #119): hoy `WAIT_FOR_HUMAN` silencia la conversación. En voz congelaría la llamada. Es
  prerrequisito de usar consultas desde `sales-voice`.
- **H-2:** opciones de respuesta sugeridas en `request_consultation`, para el tipo «decisión» y los botones de la mesa.
- **H-3:** aviso push al responsable. ntfy ya existe para alertas; un WhatsApp a un número del equipo pasa por las
  reglas de ADR-055.
- **H-4:** llamar al responsable. Es G6: llamada saliente a su WhatsApp con permiso permanente. Su app es un destinatario
  normal, no un cliente SIP.

## 10. Riesgos técnicos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R-1 | Rol ICE o DTLS mal negociado: sin audio | Media | Alto | Pruebas S1 y S2 con una oferta igual a la de Meta; logs de rol |
| R-2 | Silencio > 20/30 s mientras R4 piensa: Meta corta | Alta sin mitigar | Alto | Generador de silencio permanente (§6.4) más acuse hablado del motor |
| R-3 | Secuencia o timestamp no monótonos al cambiar de fuente: silencio | Media | Alto | Reescritura propia en el relay; prueba de cambio de fuente en S2 |
| R-4 | Ventana de 30–60 s para aceptar más webhooks duplicados o desordenados | Media | Medio | 200 inmediato, idempotencia por `wacid`, ENDED absorbente |
| R-5 | El override del número de prueba no entrega `calls` | Baja | Medio | Probar en S3; respaldo con reenvío desde el gateway de R4 (§6.2) |
| R-6 | Memoria en el host compartido sin swap: un proceso nuevo tumba el texto | Media | Alto | Tope de memoria o instancia aparte (O-5); `sales-voice` suma un gateway y un worker |
| R-7 | El motor de voz dice cifras que R4 no dio | Media | Alto | Instrucciones, cifras textuales, auditoría de lo dicho (§7.5) y evaluación de G3 |
| R-8 | La latencia de `sales-voice` hace eterna la espera | Alta | Medio | Delegación con acuses; perfil solo de lectura y respuestas cortas; medir en G3 |
| R-9 | Latencia Chile ↔ EE. UU. | Media | Bajo | Medir en G1 (RTT de stats); São Paulo solo con datos |
| R-10 | Español de Chile: no hay garantía documentada de acento | Media | Medio | Prueba de oído en G2 con el owner, GPT-Live contra Realtime |
| R-11 | El número de producción no llega a 2.000 destinatarios diarios | Desconocida | Medio | G1–G3 con número de prueba; verificar el límite antes de G7 |
| R-12 | Meta oculta el botón de llamada por baja tasa de atención (gateway caído, rechazos) | Media | Medio | `call_hours`, kill switch con aviso, buzón de voz de Meta ante timeout |
| R-13 | Ley 21.719: entra en vigor el 2026-12-01 (la postergación al 2027-10-15 se despachó pero no se había publicado) | — | Alto | Sin grabación; aviso de IA; aviso de privacidad y retención antes de G7; revisión legal (O-8) |
| R-14 | Reinicio del proceso corta las llamadas (no hay renegociación) | Alta | Bajo | Despliegues fuera de horario de llamadas; `call_hours`; se registra |
| R-15 | Proyecto de ley de IA: exigiría avisar que se habla con una máquina | Media | Bajo | Aviso de IA desde G2 (O-7) |

## 11. Recursos y costos (estimados)

| Concepto | Costo | Nota |
|---|---|---|
| Meta, llamada entrante | US$0 | Abre la ventana de 24 h |
| Meta, llamada saliente a Chile (G6) | US$0,0121/min | Pulsos de 6 s |
| GPT-Live | US$0,05/min activo | Más las corridas de R4 delegadas, que se cobran como turnos de texto |
| Realtime 2.1-mini (respaldo) | ~US$0,02–0,04/min | Estimación desde precio por token; OpenAI no publica precio por minuto |
| CPU del relay | < 1 % de un núcleo por llamada | ~200 paquetes/s por llamada puenteada |
| Ancho de banda | ~60 kbps por tramo | Despreciable |
| Instancia aparte (si O-5 la elige) | ~US$12–15/mes | t4g.small on-demand, aproximado |

Ejemplo: 500 minutos al mes con GPT-Live son unos US$25, más los turnos de R4.

Esfuerzo aproximado, por gate y solo de ingeniería:

| Gate | Esfuerzo |
|---|---|
| G1 | 3–5 días |
| G2 | 1–1,5 semanas (incluye el spike) |
| G3 | 1,5–2 semanas (adaptador, definición `sales-voice` v1 y evaluación) |
| G4 | 1–2 semanas (ADR-056 K1–K2 y H-2) |
| G5 | 2–3 semanas |
| G6 | 1 semana |
| G7 | 1–2 semanas |

## 12. Plan ejecutable del primer prototipo (G1)

### 12.1 Prerrequisitos (del owner)

| # | Prerrequisito |
|---|---|
| P-1 | El número de prueba público de Meta de la app actual, con Calling activado. Está exento del límite de 2.000 y no toca el número de R4 |
| P-2 | Un token de usuario de sistema con `whatsapp_business_messaging` en la app actual, y el override de webhook del número de prueba hacia `r4-voice` (§6.2). No hace falta una app nueva |
| P-3 | Security group con entrada UDP en un puerto y verificación de que el host tiene Elastic IP |
| P-4 | Autorización de SSH al host para instalar `r4-voice` y la ruta en nginx, sin tocar procesos de R4 |
| P-5 | Una ruta HTTPS para el webhook |
| P-6 | Teléfonos que llaman: el del owner (el de la allowlist) y uno del otro sistema operativo. Sus números van solo en la configuración del host, nunca en este repo |

### 12.2 Pasos

| Paso | Dónde | Qué prueba |
|---|---|---|
| S1 | Local (Docker Go) | La respuesta de Pion a la oferta de muestra de Meta: `setup:active`, un m-line, `opus/48000/2` con el PT de la oferta, `telephone-event/8000` con PT 126, solo huella SHA-256, sin `ice-lite` propio, candidatos con la IP reescrita |
| S2 | Local | Un par «Meta falso» (Pion en ICE-lite, oferta igual a la muestra) contra `r4-voice`. Verifica: ICE conectado con `r4-voice` CONTROLLING, DTLS con `r4-voice` como cliente, eco de ida y vuelta, silencio cada 20 ms sin fuente, secuencia y timestamp monótonos al pasar de saludo a eco, firma inválida → 401, `connect` duplicado → un accept, terminate antes de connect → nunca se acepta, kill switch → reject, segunda llamada → reject |
| S3 | Host | Override del número de prueba hacia `r4-voice`, verificación del webhook y entrega de `calls` (R-5) |
| S4 | Host | Llamada real desde el número de prueba: saludo pregrabado y luego eco. El owner confirma que oye el saludo y su propia voz |
| S5 | Host | Términos: corta el cliente, corta `r4-voice`, no se contesta, kill switch y reinicio del proceso |

Repetir S4 y S5 desde los dos sistemas operativos.

### 12.3 Rollback

Detener `r4-voice`, quitar la ruta de nginx, cerrar el puerto UDP, quitar el override del número de prueba
(`override_callback_uri` vacío) y desactivar Calling en ese número. R4 no
cambia en G1: no hay nada que revertir en R4.

### 12.4 Estado del siguiente gate

**G1: BLOQUEADO** por P-1…P-6. G2 no empieza sin la evidencia de G1.

## 13. Pruebas y criterios de aceptación

**G1 (aprobado solo con evidencia real):**
- S1 y S2 automáticas y en verde.
- Una llamada real con webhook `connect` recibido, `accept` con 200, ICE y DTLS conectados, y paquetes RTP en los dos
  sentidos por ≥ 60 s.
- El owner oye el saludo y el eco.
- Webhook de término `COMPLETED` con duración.
- Recursos liberados: PeerConnections y goroutines vuelven a la base.
- Durante la llamada, `/ready` del gateway de R4 sigue en 200 y una conversación de texto de la lane responde normal.

No se declara «funciona» sin señalización, audio entrante y audio saliente probados contra Meta.

**Los gates siguientes, en una línea cada uno:**
- **G2:** conversación con el motor; interrupción del agente en ≤ 500 ms (p95 medido); respuesta simple en ≤ 1,5 s
  (p95 medido); sin cortes por silencio en 10 llamadas.
- **G3:** 20 preguntas comerciales grabadas como casos; 0 cifras dichas sin respaldo de R4 según la auditoría de lo
  dicho; con R4 caído, la voz dice que no puede confirmarlo y no inventa.
- **G4:** consulta desde WhatsApp, web y voz con el mismo contrato; con ADR-056 la conversación sigue mientras espera.
- **G5:** un operador atiende desde el navegador; el traspaso IA → humano → IA ocurre sin cortar la llamada.
- **G6:** sin permiso válido no hay llamada (error 138006 nunca alcanzado por diseño); con permiso, la respuesta queda en
  la consulta.
- **G7:** carga con N llamadas, runbook, alertas, piloto con allowlist y activación reversible.

## 14. Decisiones que requieren al owner

| # | Decisión | Recomendación |
|---|---|---|
| O-1 | Autorizar G1 aislado (número de prueba) con P-1…P-6, incluido el SSH al host y el cambio de security group | Sí |
| O-2 | Ubicación del código de `r4-voice` | Repo privado aparte; el adaptador `voice` en R4 a partir de G3 |
| O-3 | Ruteo del webhook `calls` | G1: override del número de prueba en la app actual. Número de R4: reenvío desde el gateway de R4, a decidir tras G1 |
| O-4 | Motor de voz y cuenta | GPT-Live en una cuenta de OpenAI nueva con tope mensual; comparar contra Realtime 2.1 en G2. ¿Pedir ZDR? |
| O-5 | Host | G1–G2 en el host actual con tope de memoria duro; instancia aparte antes de G3 si `sales-voice` suma procesos |
| O-6 | Modelo de canal | Canal `voice` con `sales-voice` de solo lectura; decidir después si el mismo número de Meta vincula la llamada con el WhatsApp escrito (ADR-053) |
| O-7 | Aviso inicial: «hablas con el asistente automático de …» | Sí, desde G2 |
| O-8 | Grabación y transcripciones | Ninguna por defecto; solo metadatos de llamada y los inputs delegados a R4 (como un WhatsApp). Revisión legal antes de G7. Re-verificar la publicación de la postergación de la Ley 21.719 antes del 2026-12-01 |
| O-9 | Número de producción | Solo después de G3, tras verificar el límite de 2.000 |
| O-10 | Fase del roadmap | Este documento no abre R4-L. El ADR de voz (siguiente número libre) se escribe con la evidencia de G1, antes de tocar R4 en G3 |

## Anexo A — Fuentes (consultadas el 2026-11-22)

- **Meta WhatsApp Calling:** `https://developers.facebook.com/documentation/business-messaging/whatsapp/calling` y las
  subpáginas `call-settings`, `user-initiated-calls`, `business-initiated-calls`, `user-call-permissions`, `reference`
  (oferta SDP de muestra), `sip`, `faq` (ICE-lite y CONTROLLING en las líneas 115 y 128 de la copia), `troubleshooting`,
  `integration-patterns`, `pricing` y `call-recording`.
- **Webhooks:** `.../whatsapp/webhooks/create-webhook-endpoint`.
- **OpenAI:**
  - `https://developers.openai.com/api/docs/guides/voice-webrtc?api=live`
  - `.../guides/live-delegation`
  - `.../guides/realtime-webrtc`
  - `.../guides/realtime-server-controls`
  - `.../guides/realtime-sip`
  - `.../pricing`
  - `.../deprecations`
  - `.../guides/your-data`
- **Pion:**
  - `https://github.com/pion/webrtc` (v4.2.29, `settingengine.go`, `track_local_static.go`, `examples/swap-tracks`,
    `examples/ice-single-port`)
  - `https://github.com/pion/opus`
  - `https://github.com/pion/interceptor` (`pkg/jitterbuffer`)
- **Proyectos de terceros:**
  - `https://github.com/shridarpatil/whatomate` (AGPL; PR 340, PR 489, issue 517)
  - `https://github.com/gojargo/jargo`
  - `https://pkg.go.dev/github.com/VoiceBlender/voiceblender`
- **Chile:**
  - Ley 21.719 (texto, `idNorma=1209272`)
  - Ley 19.628
  - Código Penal art. 161-A
  - Ley 19.496 art. 28 B
  - Boletín 18.623-07 (postergación, despachada el 2026-11-17 y sin publicar a la fecha de las fuentes)
  - Boletín 16.821-19 (proyecto de ley de IA)

Lo marcado «por verificar» en este documento no se probó. Las cifras de OpenAI y Meta se re-verifican al abrir cada
gate, porque cambian seguido.
