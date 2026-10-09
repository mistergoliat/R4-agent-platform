# ADR-033 — Identidad de operador por OIDC (Google Workspace) para aprobaciones

- **Estado:** Aceptado (R4-J3D-S). Implementado y validado **localmente** contra un emisor OIDC local conforme al estándar. El inicio de sesión con Google Workspace real está **pendiente**: hay que registrar el cliente OAuth y provisionar el registro de operadores.
- **Fecha:** 2026-10-09
- **Autoridad superior:** Constitución ("model output is untrusted"; "writes require governed execution"); PRD; ADR-021 §5–§6; R4-I D-5
- **Evidencia:** `docs/architecture/R4-J3D-S_TRUSTED_HUMAN_APPROVAL_REPORT.md`

## Contexto

La aprobación de `quote.create@2` (`REQUIRE_APPROVAL` en `sales-production@4`) necesita una decisión humana. El runtime la acepta solo vía `TemporalRuntime.respondHuman` con un `TrustedHumanContext`. Según ADR-021 §5, ese contexto lo produce el adapter de autenticación del API (`AppDependencies.humanContext`) y nunca sale de headers ni de bodies. R4 no traía ninguna implementación de ese adapter. Además, D-5 rechazó que la administración del host fingiera ser un humano.

Opciones auditadas:

| Opción | Veredicto |
|---|---|
| Sesión del CRM-Customer-360 | **Rechazada.** El login compara un único token compartido (`ADMIN_BYPASS_TOKEN`). La cookie `hub_session` es `timestamp.HMAC(timestamp)`, con TTL de 12 h y **sin sujeto**, y el header `x-admin-bypass-token` la omite. No identifica a ninguna persona. Además, R4 no puede depender de código ni de estado del CRM (AGENTS.md). |
| Email, header HTTP o usuario Linux | **Rechazada.** El cliente lo declara, o el host lo comparte; no es una identidad verificada (D-5). |
| **Google Workspace OIDC directo** | **Elegida.** Es el IdP de la organización y entrega un identificador estable (`sub`), firma asimétrica (RS256 con JWKS publicado), dominio (`hd`) y frescura (`iat`). |

## Decisión

1. **Punto de extensión existente, sin tocar el harness.** El adapter implementa `AppDependencies.humanContext` (síncrono). Las claves JWKS se cargan de forma asíncrona antes de componer la plataforma, y la verificación es síncrona (`crypto.verify`). No cambian Policy Engine, ActionExecutor, Task/Temporal Runtime, aprobaciones genéricas, rutas ni migraciones.
2. **Flujo de inicio de sesión.** OAuth 2.0 Authorization Code con PKCE S256, `state` y `nonce` OIDC, con redirect a loopback `127.0.0.1:<puerto>` (RFC 8252; cliente "Desktop app" de Google, consent interno del Workspace). El listener acepta un solo callback, compara `state` en tiempo constante, cierra todas las conexiones y expira a los 5 minutos. En un host remoto el operador reenvía el puerto con `ssh -L`. El ID token no sale del proceso.
3. **Verificación del ID token.**
   - `alg` debe ser RS256: se rechazan `none` y HMAC.
   - `kid` publicado; firma válida.
   - `iss` exacto (para Google se aceptan sus dos formas documentadas).
   - `aud` debe contener el client id; `azp`, si viene, debe ser el client id.
   - `exp` y `nbf` se validan con 60 s de tolerancia de reloj.
   - `iat` no puede ser futuro ni más antiguo que `R4_OPERATOR_OIDC_MAX_AUTH_AGE_S` (300 s por defecto).
   - `nonce` debe ser el de este login.
   - `email_verified` debe ser verdadero.
   - `hd` debe ser el dominio Workspace configurado (obligatorio con Google).
   - El discovery debe servirse por HTTPS (o loopback) y nombrar el mismo `issuer`.
4. **Autorización (RBAC) sobre la identidad estable.** Un registro de operadores, provisto por el owner, vive en el host fuera de Git con modo 0600 (se rechaza si group u others tienen acceso). Asocia `(issuer, subject)` → `operatorRef` y roles. El rol `approver` da `approval.decide`. Nunca se busca por email. Un registro deshabilitado o desconocido no es operador. `humanRef = oidc:<operatorRef>`.
5. **Un solo productor de identidad.** `operator-auth/human-context.ts` es el único lugar del Sales pack que construye un `TrustedHumanContext`. Solo lee `Authorization: Bearer <id_token>` y exige que el `nonce` esté pendiente en el ledger del proceso, lo que lo vuelve **de un solo uso**: un token repetido se rechaza. Cualquier fallo devuelve `null`, y el API responde `trusted_human_required`. Un operador autenticado pero sin el scope es rechazado por el propio runtime (`human_scope_denied`).
6. **Decisión solo por la ruta del runtime.** `production:sales:operator approvals approve|reject` y `sales:canary approvals approve|reject` siguen estos pasos:
   - Inspeccionan la solicitud abierta, con sus argumentos exactos y su hash.
   - Exigen el hash revisado (`--arguments-hash`) y que el hash almacenado coincida con los argumentos.
   - Autentican y verifican al operador y su rol antes de tocar el runtime.
   - Vuelven a comprobar la solicitud tras el login.
   - Deciden con `POST /v1/human-requests/:id/respond` sobre `createPlatform({ humanContext })`, sin escuchar en red y sin registrar definiciones.
   - Releen el evento de auditoría del runtime: `actor_ref`, tipo, `response_key`, motivo y fecha.

   Las aprobaciones expiradas o ya decididas siguen la semántica del runtime (`approval_not_open`, `human_request_terminal`, `human_request_expired`).
7. **D-5 se mantiene.** `production:sales:control` (administración del host) sigue sin decidir y responde a `approve|reject` con `trusted_human_required`, indicando el comando de operador. Los tests de contrato `live-ops-boundaries` (D-5) y `operator-auth-boundaries` (este ADR) lo fijan.
8. **Configuración** (solo el entorno del proceso, nunca `.env`):
   - `R4_OPERATOR_OIDC_ISSUER`, `R4_OPERATOR_OIDC_CLIENT_ID`, `R4_OPERATOR_OIDC_CLIENT_SECRET` (secreto de app instalada; no es confidencial, pero nunca se registra en logs)
   - `R4_OPERATOR_OIDC_HOSTED_DOMAIN`
   - `R4_OPERATOR_REGISTRY_FILE`
   - `R4_OPERATOR_OIDC_REDIRECT_PORT` (por defecto 8765)
   - `R4_OPERATOR_OIDC_MAX_AUTH_AGE_S`

## Límite de confianza

- **Quién es el operador:** lo decide Google Workspace, con firma verificada. **Qué puede hacer:** lo decide el registro de operadores, que gestiona el owner. **Qué se aprueba:** los argumentos exactos que vinculó el Policy Engine. Su integridad la protege la base de datos (un trigger impide alterar el payload de una solicitud) y además la verifica el runtime (`argumentsHash` contra el fingerprint del comando) al ejecutar.
- Quien tiene acceso root al host y a la base de datos productiva puede, como siempre, alterar el estado por fuera del runtime. Este ADR no protege contra el administrador del host: protege la **atribución**, porque una decisión registrada como `oidc:<operator>` exige un login de esa persona.
- El ledger de nonces vive en memoria y su alcance es el proceso que hace el login, que también es el único que decide. Si en el futuro un servicio HTTP de operador hospeda el adapter para varios procesos, el ledger deberá ser durable y compartido.

## Consecuencias

- La aprobación humana real deja de estar bloqueada en R4. En producción la habilitan el registro del cliente OAuth y el registro de operadores; ninguno de los dos pasos requiere código.
- Sin dependencias nuevas: `node:crypto` y `fetch`.
- Queda diferido: un servicio de operador HTTP de larga vida (con sesión del navegador, CSRF por cookie y ledger durable), MFA impuesta por la política del Workspace (se configura en Google, no en R4), y la revocación inmediata de un operador (hoy, editar el registro afecta a los procesos nuevos).
