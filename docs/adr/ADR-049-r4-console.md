# ADR-049 — Consola R4: aplicación web de operación, fuera del CRM y fuera de este repositorio

- **Identificador:** `R4-CONSOLE-01`
- **Estado:** **Aceptado para la Fase 1** (owner, 2026-11-19), incluido el lector de servicio (Decisión 6). La
  Fase 3 (acciones) se rige por **ADR-050** (identidad de operador de la consola). El despliegue en producción y cada
  fase siguiente necesitan autorización explícita del owner.
- **Fecha:** 2026-11-19
- **Mandato:** owner, 2026-11-18 y 2026-11-19: una consola en vivo para ver y operar los agentes, en una aplicación
  aparte del CRM. Se construye primero la consola; la app de ventas (ADR-048) queda para después.
- **Autoridad superior:** Constitución; PRD §17 (operador humano) y §18 (experiencia de operador, de la que este ADR
  se aparta); ADR-021 §5 (contexto humano confiable); ADR-033 (identidad de operadores, OIDC); ADR-042
  (colaboración con el owner); ADR-048 (mesa de ventas).

## Contexto

El PRD §18 ubica la consola de agentes como una sección `/agents` del CRM que consume solo la API de R4. El owner
pidió una aplicación aparte. El diseño de referencia es un lienzo privado del owner, fuera de este repositorio.

Hechos verificados en el código (`main` `485d797`):

1. **La API ya expone casi todo lo que necesita una consola de solo lectura.**
   - Agentes: `GET /v1/agents`, `GET /v1/agents/:id`.
   - Pendientes humanos: `GET /v1/attention`, `GET /v1/production/attention`.
   - Conversaciones: `GET /v1/production/conversations`, `GET /v1/tasks/:id`, `/thread`, `/temporal`, `/outbound`,
     `GET /v1/runs/:id`.
   - Producción: `GET /v1/production/metrics`, `GET /v1/production/controls`, `/health`, `/ready`.
2. **La API no autentica a quien llama.** `unauthenticatedPrincipalResolver` devuelve `anonymous`, y la API solo
   debe escuchar en loopback o en una red privada (`apps/api/src/principal.ts`).
3. **La identidad humana confiable existe solo para aprobaciones por terminal.** El adapter de ADR-033 usa el
   flujo de app de escritorio con redirect a loopback, y cada ID token sirve **una sola vez** (nonce pendiente en el
   proceso). Está validado en local; el login con Google Workspace real sigue pendiente.
4. **Los datos tienen límites conocidos.**
   - `ProductionMetrics` son totales acumulados: no se pueden cortar por día ni por agente.
   - El costo del modelo no se registra en dinero, solo `model_calls`.
   - `ConversationSummary` trae canal, estado, si la tiene una persona y la fecha del último inbound, pero no el
     último mensaje ni su resultado.
   - No hay un feed de eventos (es el cambio C-4 de ADR-048).
5. **Este repositorio no puede depender de Next.js, React ni del estado del navegador** (AGENTS.md), y es público.
6. **Las lecturas del plano de operador también exigen una persona verificada.** `/v1/attention`,
   `/v1/production/*`, `/thread`, `/outbound` y `/temporal` responden `trusted_human_required` sin un
   `TrustedHumanContext`. Solo `/health`, `/ready`, `/v1/agents`, `/v1/tasks/:id` y `/v1/runs/:id` están abiertas.
7. **`r4-api` no corre en producción.** El despliegue levanta `r4-channel-gateway`, `r4-sales-worker`,
   `r4-sales-worker-lane` y `r4-scheduler` (`ops/r4-inbound-media/deploy.sh`). Hoy la operación se hace desde el
   host con `production:sales:control`.

## Decisión 1 — Aplicación propia, en un repositorio privado

- La consola vive en el repositorio privado **`r4-console`**, no en el CRM ni aquí.
- **No va en el CRM** por tres razones: es una aplicación grande con procesos autónomos propios, ataría la consola a
  sus despliegues, y ADR-033 ya descartó su sesión como identidad.
- **No va en este repositorio** por AGENTS.md (sin dependencias de interfaz web) y porque la consola es la puerta a
  conversaciones de clientes.
- **Stack:** Next.js y TypeScript, el mismo que ya conoce el equipo.

Es un desvío del PRD §18 en la ubicación, no en el principio: el CRM no era la fuente autoritativa y la consola
tampoco lo es.

## Decisión 2 — Contrato con R4

- **Solo la API de R4.** La consola nunca lee la base de R4 ni la de otros servicios.
- **Backend propio entre el navegador y R4.** El navegador solo habla con la consola. La consola llama a R4 por la
  red interna del host. R4 sigue escuchando solo en loopback.
- **Lista cerrada de rutas.** La consola no reenvía rutas arbitrarias: cada lectura que usa está en una lista
  explícita del código. En las fases 1 y 2 son solo `GET`.
- **Sin copia de los datos.** La consola no tiene base de datos ni caché persistente en las fases 1 y 2. R4 sigue
  siendo la fuente autoritativa.
- **Si R4 no responde, la consola lo dice.** Nunca muestra ceros ni datos viejos como si fueran actuales: cada
  bloque indica de cuándo es su dato.

## Decisión 3 — Acceso y datos de clientes

- **Fase 1 sin exposición a internet.** Corre en local contra un R4 local con datos sintéticos. Contra producción,
  solo por túnel SSH y con autorización del owner para esa tarea.
- **Exposición solo con login.** Antes de publicar un subdominio (genérico con HTTPS mientras no haya dominio
  propio), la consola debe tener:
  - login OIDC de Google Workspace con un cliente **web** nuevo, distinto del cliente de escritorio de ADR-033;
  - las mismas verificaciones del ID token que ADR-033 (`iss`, `aud`, `exp`, `nonce`, `email_verified`, `hd`);
  - autorización por `(issuer, subject)` en un registro de operadores, nunca por email;
  - sesión del lado del servidor, con cookie `HttpOnly`, `Secure` y `SameSite=Strict` y expiración corta.
- **Rol inicial:** solo el owner (`admin`). Otros roles se agregan con decisión del owner.
- **Datos de clientes:**
  - teléfonos y correos enmascarados en listas y tableros; el hilo completo, solo dentro de la conversación;
  - la consola no registra contenido de conversaciones en sus logs;
  - sin analítica de terceros.

## Decisión 4 — Fases (cada una requiere autorización del owner)

1. **Solo lectura con lo que ya existe**, más el lector de servicio de la Decisión 6. Pantallas:
   - **Hoy:** pendientes humanos y totales de producción.
   - **Conversaciones:** lista, hilo, run y línea de tiempo de la tarea.
   - **Agentes:** definiciones y capabilities.
   - **Salud:** `/health`, `/ready`, envíos desconocidos, retenidos o fallidos, y controles (solo lectura).

   Gate: el owner la usa en el día a día y confirma que muestra lo mismo que las herramientas actuales.
2. **Lecturas nuevas en R4, genéricas.** Métricas por ventana de tiempo y por agente, costo de modelo, feed de
   eventos (C-4, compartido con ADR-048) y resumen de conversación enriquecido. Cada una con autorización propia.
3. **Acciones.** Kill switch, rollout, tomar y responder conversaciones. Requiere un ADR propio sobre cómo una
   aplicación web entrega a R4 una identidad humana confiable: el adapter de ADR-033 es de un solo uso y de
   terminal. Mientras ese ADR no exista, la consola no escribe.
4. **Mejora continua.** Incidentes (con detectores en R4), lanzamientos y calidad.
5. **Lo que depende de otros servicios.** Mesa de ventas (ADR-048), contacto con clientes, autonomía y aprendizaje.

## Decisión 5 — Dónde corre

- En el mismo host que R4, como proceso aparte, con su propio chequeo de salud.
- Sin base de datos, colas ni caché externa. Se agrega infraestructura solo con necesidad demostrada.
- Despliegue por SHA explícito, igual que R4.

## Decisión 6 — Lector de servicio y `r4-api` en producción

El owner eligió esta vía (2026-11-19) para tener la consola funcionando antes del login de Google.

- **Credencial de solo lectura.** La API acepta `Authorization: Bearer <token>` en las lecturas del plano de
  operador (hechos 6) cuando el SHA-256 del token coincide con `R4_SERVICE_READER_TOKEN_SHA256`. La comparación es
  en tiempo constante. Sin esa variable no existe lector (falla cerrado). El host guarda solo el hash; el token
  vive en el backend de la consola.
- **Nunca escribe.** El lector no construye un `TrustedHumanContext`. Toda escritura (controles, responder, tomar,
  cancelar, aprobar) sigue exigiendo una persona verificada, aunque llegue el token.
- **`r4-api` en producción**, como proceso nuevo que escucha solo en loopback:
  - con un **usuario de base de datos de solo lectura**, para que ni siquiera las rutas abiertas de escritura de
    R4-B (`POST /v1/tasks`, `/inputs`) puedan escribir;
  - con `R4_AGENT_DEFINITIONS_DIR` apuntando a una carpeta vacía, para que el arranque no registre definiciones;
  - el despliegue y la creación del usuario de solo lectura necesitan autorización del owner.
- **Acceso hasta tener login.** El owner usa la consola en su equipo y llega a `r4-api` por túnel SSH. La consola no
  se expone a internet hasta cumplir la Decisión 3.
- **Rotación.** Cambiar el token es cambiar el hash en el host y reiniciar `r4-api`.

Con esto la Fase 1 sí modifica R4, pero solo en la API: la consola sigue sin escribir.

## Fase 2 — Lecturas nuevas (autorizada por el owner, 2026-11-19)

Tres `GET` nuevos en la API, detrás del mismo lector de servicio (o de una persona verificada). Solo leen tablas
durables; ninguno devuelve texto de mensajes, razonamiento del modelo, contenido libre de una decisión, teléfonos ni
correos.

- **`GET /v1/runs/:id/steps`** — los pasos de un run, del más antiguo al más nuevo: origen, resultado, código de
  error (nunca el mensaje), tipo de decisión, capability invocada, tokens y tiempos. `decideMs` es el tiempo desde el
  fin del paso anterior (o el inicio del run) hasta que se registró el paso: contexto más llamada al modelo.
  `executeMs` es el tiempo de la lectura o de la acción hasta su observación.
- **`GET /v1/production/activity?days=N`** (1 a 31, 7 por defecto) — por día local de `America/Santiago` y por
  agente: tareas creadas, mensajes entrantes, salientes entregados o leídos, derivaciones a humano, runs, runs
  fallidos, llamadas al modelo, tokens y llamadas a capabilities. Por día, la mediana del tiempo de respuesta al
  cliente (del último mensaje del cliente a la aceptación de la respuesta por el proveedor).
- **`GET /v1/events?before=<cursor>&limit=N`** (1 a 200, 50 por defecto) — la bitácora, la forma mínima de C-4:
  transiciones de tareas, eventos temporales (derivaciones, consultas, aprobaciones, esperas), cambios de autonomía y
  recibos de acciones, del más nuevo al más antiguo, con cursor estable `<iso>|<id>`. Un contacto aparece como
  `contact` y cualquier referencia con `@` como `redacted`. El motivo de un cambio de autonomía sigue en
  `GET /v1/production/controls`.

El costo del modelo en dinero sigue sin registrarse: la consola muestra tokens. El resumen de conversación enriquecido
queda para otra autorización.

## Fuera de alcance

- La app de ventas (ADR-048).
- Cambios en R4 Core durante la Fase 1.
- Un buscador que responda preguntas con un modelo.
- Recibir telemetría de agentes externos a R4.

## Consecuencias

- R4 cambia en la Fase 1 solo para aceptar el lector de servicio. La consola se puede descartar sin tocar
  producción: basta con quitar el hash y detener `r4-api`.
- Quien obtenga el token puede leer conversaciones de clientes. Por eso solo se guarda su hash en el host, vive
  únicamente en el backend de la consola y se rota ante cualquier duda.
- Hay una aplicación más que operar en el host.
- La API de R4 sigue sin autenticar a quien llama. La consola no lo resuelve: cualquier proceso dentro de la red
  privada puede leer todo, igual que hoy. La Fase 3 depende de cerrar ese punto.
- Las pantallas con más valor (incidentes, costos por agente, bitácora) llegan en las fases 2 y 4, porque los datos
  no existen todavía.

## Decisiones abiertas del owner

1. Registrar el cliente OAuth web de Google Workspace y confirmar el dominio (`hd`).
2. Cuándo exponer la consola a internet, y con qué subdominio.
3. Quién, además del owner, puede entrar y con qué rol.
4. Si las vistas de conversación muestran los datos de contacto completos o siempre enmascarados.
