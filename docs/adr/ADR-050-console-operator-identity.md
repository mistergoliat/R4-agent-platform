# ADR-050 — Identidad de operador de la consola R4: aserción firmada por solicitud

- **Identificador:** `R4-CONSOLE-02`
- **Estado:** **Aceptado para la Fase 3 de ADR-049** (owner, 2026-11-19). Implementado en R4; el despliegue en
  producción, el cambio de rol de base de datos de `r4-api` y la exposición de la consola necesitan autorización
  explícita del owner.
- **Fecha:** 2026-11-19
- **Mandato:** owner, 2026-11-19: la consola debe poder hacer toda escritura de operador que R4 ya expone.
- **Autoridad superior:** Constitución ("las escrituras requieren ejecución gobernada"); PRD §17 (operador humano);
  ADR-021 §5 (contexto humano confiable); ADR-033 (identidad de operadores, OIDC); ADR-049 (consola R4).

## Contexto

1. **Un solo operador.** Hoy el owner es el único operador. Quiere controlar producción desde la consola: kill switch,
   tomar y soltar conversaciones, responder a mano, responder solicitudes humanas, cancelar tareas, resolver o
   cancelar envíos y reprogramar reconciliaciones.
2. **Todas esas rutas ya existen** y exigen un `TrustedHumanContext` que produce `AppDependencies.humanContext`
   (`human(request)` en `apps/api/src/app.ts`):
   - `POST /v1/production/controls`;
   - `POST /v1/tasks/:id/handoff`, `/operator-messages`, `/cancel`;
   - `POST /v1/human-requests/:id/respond`;
   - `POST /v1/outbound/:id/resolve`, `/cancel`;
   - `POST /v1/executions/:id/reconciliation/reschedule`.
3. **El adapter de ADR-033 no sirve para una aplicación web.** Es de terminal (cliente de escritorio, redirect a
   loopback) y cada ID token sirve una sola vez dentro del proceso que hizo el login. `r4-api` en producción no tiene
   ningún adapter: toda escritura humana responde `trusted_human_required`.
4. **La consola ya verifica el login.** Su backend hace el login OIDC de Google Workspace con un cliente **web**
   propio, con las mismas verificaciones del ID token que ADR-033 (incluida `hd`), autoriza por `(iss, sub)` en su
   lista y mantiene una sesión del lado del servidor (ADR-049, Decisión 3).
5. **Mismo host.** El backend de la consola corre en el mismo host que `r4-api`, que escucha solo en loopback detrás
   de nginx.
6. **`r4-api` usa hoy un rol de base de datos de solo lectura** (ADR-049, Decisión 6), que además mantiene cerradas
   las escrituras anónimas de R4-B (`POST /v1/tasks`, `POST /v1/tasks/:id/inputs`).

## Decisión 1 — Aserción firmada por solicitud

Cada escritura de la consola lleva un header:

```
x-r4-console-assertion: v1.<payload>.<sig>
```

- `<payload>` = base64url(JSON) y `<sig>` = base64url(HMAC-SHA256(clave, `"v1." + <payload>`)).
- La clave es `R4_CONSOLE_OPERATOR_KEY` decodificada de base64url; debe tener al menos 32 bytes.
- El JSON del payload (objeto estricto: un campo de más invalida la aserción):

| Campo | Contenido |
|---|---|
| `v` | `1` |
| `iss`, `sub` | la identidad verificada por la consola (Google) |
| `scopes` | los scopes que la consola pide para esta acción |
| `method` | `"POST"` |
| `path` | la ruta exacta de la solicitud, con query (`request.url`), p. ej. `/v1/production/controls` |
| `bodySha256` | SHA-256 hex del cuerpo exacto en bytes; el de `""` si no hay cuerpo |
| `iat`, `exp` | segundos Unix |
| `jti` | UUID |

**Verificación en R4.** Cualquier fallo devuelve `null`: la ruta responde `trusted_human_required` y el log registra
solo un código de motivo, nunca detalles al cliente.

1. El adapter existe solo si están `R4_CONSOLE_OPERATOR_KEY` y `R4_CONSOLE_OPERATORS_FILE`. Sin ninguna, no hay
   adapter (falla cerrado). Con una sola, una clave corta o un archivo inválido, el arranque falla.
2. Formato del header y HMAC comparado en tiempo constante.
3. `v === 1`, `0 < exp − iat ≤ 60` y el reloj de la plataforma dentro de `[iat − 30 s, exp]`.
4. `method` y `path` iguales a los de la solicitud real.
5. `bodySha256` igual al SHA-256 de los bytes crudos del cuerpo. La API guarda esos bytes junto al JSON parseado;
   el parseo sigue siendo el de Fastify, sin cambios para las demás rutas.
6. `jti` de un solo uso, en un registro en memoria hasta su `exp`.
7. `(iss, sub)` debe estar en el archivo de operadores.
8. Scopes otorgados = `payload.scopes` ∩ scopes del registro. Si la intersección es vacía, se rechaza.

Resultado: `TrustedHumanContext { humanRef: "oidc:<operatorRef>", scopes, correlationId }`, con el correlation id de
la solicitud. El runtime sigue exigiendo el scope de cada operación (`human_scope_denied`).

**Por qué así:**

- **HMAC con clave compartida.** Ambos procesos viven en el mismo host y el límite de confianza ya es ese host:
  quien lo controla también controla `production:sales:control`. Una firma asimétrica o mTLS no cambian ese límite y
  suman piezas. Sin dependencias nuevas: `node:crypto`.
- **Atada a método, ruta y cuerpo.** Una aserción capturada no sirve para otra acción, otra tarea ni otro texto.
- **Un solo uso y ≤ 60 s.** Acotan una repetición al instante de la acción. `r4-api` es un solo proceso, así que
  el registro en memoria basta. Un reinicio solo puede reabrir una ventana de 60 s como máximo para una aserción ya
  usada y todavía vigente.
- **Registro por `(iss, sub)`, nunca por email.** Igual que ADR-033: el email se puede renombrar o reasignar.
- **Intersección de scopes.** La consola pide lo justo para cada acción y R4 nunca concede más de lo que el owner
  registró.

## Decisión 2 — Archivo de operadores

`R4_CONSOLE_OPERATORS_FILE` es un JSON que provee el owner, fuera de Git, con modo 0600 en el host (se rechaza si
group u others tienen acceso, igual que ADR-033):

```json
[
  {
    "issuer": "https://accounts.google.com",
    "subject": "<sub de Google>",
    "operatorRef": "felipe",
    "scopes": ["autonomy.control", "handoff.manage", "consultation.answer", "approval.decide", "task.cancel", "reconciliation.manage"]
  }
]
```

- `operatorRef` en minúsculas (`[a-z0-9][a-z0-9._-]{0,63}`).
- `scopes`: los `HumanScope` de la plataforma (al menos uno).
- Una identidad o un `operatorRef` repetido invalida el archivo.
- Se carga una vez, al arrancar.

## Decisión 3 — Escrituras anónimas cerradas

- Variable nueva: `R4_API_ANONYMOUS_WRITES` (`enabled` por defecto, o `disabled`).
- Con `disabled`, `POST /v1/tasks` y `POST /v1/tasks/:id/inputs` rechazan a quien llega como `unauthenticated` con
  **422 `anonymous_writes_disabled`**, antes de validar el cuerpo.
- Sin la variable, el comportamiento es el de hoy.

## Decisión 4 — Rol de base de datos de `r4-api`

`r4-api` pasa del rol de solo lectura (ADR-049, Decisión 6) a un rol con escritura **solo** con esto en su lugar:

- el adapter configurado;
- `R4_API_ANONYMOUS_WRITES=disabled`;
- `R4_AGENT_DEFINITIONS_DIR` sigue apuntando a una carpeta vacía.

Crear ese rol y cambiarlo necesita autorización del owner.

## Decisión 5 — Acciones del host, fuera de R4

Desplegar, revertir, cambiar de lane y cambiar el porcentaje de rollout no son rutas de la API de R4. Si la consola
las ofrece, las ejecuta su backend **en el host**, con los scripts que ya existen (`ops/`, `production:sales:control`).
Es responsabilidad de la consola: R4 no expone esas acciones ni las registra como acciones de un humano verificado.

## Consecuencias

- La consola puede hacer toda escritura de operador que R4 ya expone, con atribución `oidc:<operatorRef>`.
- **Comprometer la consola es comprometer al operador.** Quien tenga la clave puede firmar como cualquier operador del
  registro. Es el mismo límite del host que `production:sales:control`. Por eso la clave vive solo en el entorno de
  los dos procesos en el host, nunca en Git ni en el navegador.
- **Rotación:** una clave nueva en los dos archivos de entorno y reiniciar ambos procesos.
- **Revocación:** quitar al operador del archivo y reiniciar `r4-api`.
- El registro de `jti` vive en memoria. Si `r4-api` llega a correr en más de un proceso, debe ser durable y
  compartido.
- ADR-033 no cambia: el adapter de terminal sigue siendo el único productor dentro del Sales pack. El test de contrato
  `operator-auth-boundaries` fija ahora también que `apps/api/src/console-operator.ts` es el único productor dentro de
  la API y qué lee de la solicitud.

## Fuera de alcance

- Más operadores o roles (decisión del owner).
- Un registro de `jti` durable.
- Las acciones del host (Decisión 5), que viven en la consola.
