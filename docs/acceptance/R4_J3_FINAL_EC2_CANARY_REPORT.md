# R4-J3 — Canary EC2 final de `sales-production@7` y cierre formal del alcance

## Resumen

| Campo | Valor |
|---|---|
| Fecha | 2026-10-14 |
| Rama de ejecución | `r4-j3e-c-deterministic-commercial-offer` |
| Documentos hermanos | [`R4_J3_FINAL_ACCEPTANCE.md`](R4_J3_FINAL_ACCEPTANCE.md) §15–§16 y [`R4_J3_CUSTOMER_JOURNEY_GAP_REGISTER.md`](R4_J3_CUSTOMER_JOURNEY_GAP_REGISTER.md) |

**Estado vigente (§20, ejecución del 2026-10-15 con timeouts del canary autorizados): PASS.**

```text
J3_CANARY_EC2=PASS
J3_REAL_QUOTE_V2_ISSUANCES=1              (PC-000006, Quote V2 de integración)
J3_PRODUCTION_UNCHANGED=YES               (verificado antes y después, solo lectura)
J3_TECHNICAL_ACCEPTANCE=PASS
J3_AUTONOMOUS_ISSUANCE=PASS
J3_REAL_MODEL_E2E=PASS
J3_REAL_QUOTE_V2_E2E=PASS                 (@7 contra Catalog, Shipping y Quote V2 reales)
J3_OFFER_INTEGRITY=PASS
J3_DOCUMENT_VERIFICATION=PASS
J3_DOCUMENT_DELIVERY=DEFERRED
J3_CUSTOMER_JOURNEY_FULL=INCOMPLETE
J3_PRODUCTION_ROLLOUT=NOT_AUTHORIZED
J3_FINAL_STATUS=READY_TO_CLOSE_RESCOPED   (propuesta; el cierre formal lo aprueba el owner)
```

**Intento del 2026-10-14 (§18, histórico): FAIL** por el límite de 60 s por llamada.

```text
J3_CANARY_EC2=FAIL                         (latencia del proveedor del modelo frente al límite de 60 s por llamada de R4; no es un fallo de seguridad ni de integridad)
J3_REAL_QUOTE_V2_ISSUANCES=0
J3_PRODUCTION_UNCHANGED=YES                (verificado antes y después, en solo lectura)
J3F_DEFERRED_DOCUMENTED=YES
GAP_03_DISPOSITION=J7_PRODUCTION_GATE_P0
J3_FINAL_STATUS=CONDITIONAL
```

**Primer intento (histórico): BLOCKED por acceso SSH.**

```text
J3_CANARY_EC2=BLOCKED
J3_REAL_QUOTE_V2_ISSUANCES=0
J3_PRODUCTION_UNCHANGED=NOT_VERIFIED       (esta sesión no ejecutó nada en EC2; su estado no se pudo leer)
J3F_DEFERRED_DOCUMENTED=YES
J3_FINAL_STATUS=CONDITIONAL
```

**Qué pasó en el primer intento.**
- La sesión no tiene acceso SSH legítimo a EC2 desde esta estación (§2).
- Siguiendo el mandato §3, se detuvo la ejecución remota: no se buscaron llaves, no se listaron directorios de credenciales y no se modificó la configuración SSH.
- **No se emitió ninguna cotización.**
- Todo lo verificable localmente se verificó (§1, §13). El procedimiento para un operador con acceso legítimo está en §17.
- La falta de permiso SSH no es un fallo del producto.

Etiquetas de evidencia, que no se mezclan:

| Etiqueta | Significado |
|---|---|
| **LOCAL** | Ejecutado en esta estación (Docker PostgreSQL 16, owners fixture) |
| **SOURCE** | Código de la rama, con archivo y línea |
| **EC2-DOC** | Informes anteriores; no repetido |
| **NOT_VERIFIED** | No se pudo comprobar en esta sesión |

## 1. Commit exacto (LOCAL)

| Verificación | Resultado |
|---|---|
| SHA remoto completo (`git ls-remote origin refs/heads/r4-j3e-c-deterministic-commercial-offer`) | `d19bffe63f5ca112f22a6fc29f8cdb7a49b2c8ad` |
| SHA local de la rama y de `origin/…` | Idénticos al remoto |
| `origin/main` | `092715e693044119c819ea96e2b7b736d931746b` |
| Integridad (`git fsck --no-dangling`) | Sin errores (exit 0) |
| Árbol | Limpio al empezar; la rama sigue a `origin` sin divergencia |
| Cambios de harness vs `main` (`git diff origin/main..HEAD -- packages apps adapters`) | **Vacío** |
| Migraciones nuevas vs `main` (`*.sql`) | **Ninguna**. `0008` y `0009` ya están en `main` (J3E-A/B). `@7` no agrega migraciones |
| GAP-16 incluido | Commit `ab6f55d`. `quote-v5.ts:110`: un `DomainError` `temporarily_unavailable` ⇒ `ownerUnavailableHeld` (`:138`), es decir `unknown`, retenida en su clave |
| Tests E2E de GAP-16 presentes | `tests/integration/sales-deterministic-offer-canary.test.ts:418-524` (bloque "quote owner failures after the authorization (GAP-16)") |
| Build y typecheck | Exit 0 |
| Huellas y hashes fijados (`tests/contract/sales-deterministic-offer.test.ts`, `sales-boundaries.test.ts`) | 24/24 passed: huellas `@1–@7` y política `515ce98f…` sin cambio |

**Disponibilidad de `0008`/`0009` solo en la base aislada:** NOT_VERIFIED (requiere el host). EC2-DOC (handoff J3E §5): "`0008` y `0009` existen **solo en la base del canary**; producción tiene Sales hasta `0007`".

## 2. Estado preflight del servidor

**Acceso.** Se intentaron, una vez cada uno, los dos caminos documentados en informes anteriores. Ambos fueron no interactivos (`BatchMode=yes`, `StrictHostKeyChecking=yes`) y con un comando inocuo (`echo`):

| Intento | Resultado |
|---|---|
| Alias `ssh Master` (J2, J3D) | `Could not resolve hostname master`: el alias no existe en esta estación. El traspaso J3E fue entre PCs (handoff J3E) |
| `ec2-user@<host documentado en J3B §O.1>` con la identidad por defecto de esta estación | `Permission denied (publickey)`. La llave del host sí es conocida (pasó la verificación estricta), pero esta estación no tiene una identidad autorizada |

No se hizo nada más:
- no se buscaron archivos `.pem`;
- no se listaron `~/.ssh` ni otros directorios de credenciales;
- no se imprimieron llaves;
- no se tocó la configuración SSH.

| Ítem de preflight (mandato §4) | Estado |
|---|---|
| Checkout productivo y commit (histórico `ef5a354`) | NOT_VERIFIED |
| Perfil efectivo `sales-production@3` | NOT_VERIFIED |
| PM2 (`r4-*`, contadores de reinicio) | NOT_VERIFIED |
| Readiness (`/ready`, `/ready/r4`) | NOT_VERIFIED |
| Ausencia de despliegues no autorizados | NOT_VERIFIED. En el repositorio: no hay GitHub Actions, webhooks ni runners; EC2 solo se despliega por el runbook manual (EC2-DOC handoff J3E §5) |
| Bases productivas sin modificar | NOT_VERIFIED |

## 3. Pruebas de aislamiento

Remotas: **NOT_VERIFIED** (checkout `~/r4-j3e-canary`, base aislada, credenciales, procesos, eventos pendientes, `j3eb-pos-1`, Gmail, WhatsApp, espacio, perfil y modelo). Se verifican en el procedimiento §17.

Lo que garantiza el código del canary (SOURCE; vale cuando se ejecute):
- `sales:canary` solo opera sobre una base **marcada** (`COMMENT ON DATABASE r4-sales-canary:v1:<canaryId>`).
- `init` se niega a inicializar una base con tablas y sin marcador (`agents/sales/src/cli/canary/isolation.ts:9,62,85`).
- `run` nunca entrega `R4_DATABASE_URL` productiva a un componente del canary (`command.ts:190-191`).
- `run` se detiene si el aislamiento deja de cumplirse (`command.ts:213-216`).
- El outbound se captura localmente (`CaptureOutboundAdapter`); no hay proveedor de canal.

## 4. Configuración del modelo

No ejecutado. Esperado según el perfil validado: DeepSeek V4 Flash (`deepseek-v4-flash`), sin JSON mode ni cambios de modelo (EC2-DOC J3E-B §12.2). El operador lo verifica en §17.

## 5. Conversación sintética

No ejecutada. El guion del cliente sintético está en §17.4. Solo los mensajes del cliente están guionados; las decisiones del agente no.

## 6–11. Decisiones del agente, capabilities ejecutadas, política, Quote ID, totales y líneas, SHA-256 del PDF

**No aplica:** no hubo ejecución. 0 cotizaciones reales nuevas. Quote V2 no fue llamado desde esta sesión. La política esperada es `sales-production-autonomous-policy@1`, con hash `515ce98f…`, la misma de `@5–@7` (contrato fijado en `tests/contract/sales-deterministic-offer.test.ts`).

## 12. Idempotencia y recibos

Sin ejecución remota. La evidencia local está en §13.

## 13. Recuperación y errores: GAP-16 contra el owner fixture (LOCAL)

Archivo: `tests/integration/sales-deterministic-offer-canary.test.ts`. Usa el ciclo de vida real: ChannelIngress sintético, worker, kernel, ActionRuntime, ActionExecutor, `action_retry` durable y scheduler. Ningún caso invoca el handler directamente. Base: Docker PostgreSQL 16 local. Commit `d19bffe`.

**Corridas:**

| Corrida | Resultado |
|---|---|
| Archivo completo | **9/9 passed**, 194,8 s. Incluye la oferta exacta, el rechazo `offer_not_presented` y los cuatro casos de retención por kill switch, que también reproducen la misma clave |
| Bloque GAP-16 (`-t "GAP-16"`, verbose) | **3/3 passed** (6 omitidos por el filtro), 143,3 s |

**Casos del mandato §8 y el test que los cubre:**

| Caso pedido | Test |
|---|---|
| Owner temporalmente no disponible → retenida en su clave (no `failed`) | "the owner is unavailable at the send: held on its key (not failed); after the owner not-found window … the SAME key replays once" ✓ |
| Emisión aplicada con respuesta HTTP perdida | "the owner commits but its answer is lost: unknown, reconciled by the SAME key, and settled as the quote it already issued — one POST, one quote" ✓ |
| Reconciliación con la misma clave | Los dos casos anteriores (lookup por clave; `not_applied` solo tras la ventana del owner) ✓ |
| Reanudación tras restablecer el owner | El caso "unavailable at the send": replay de la misma clave y del mismo cuerpo, 1 cotización ✓ |
| Indisponibilidad prolongada | "the owner stays unavailable through every in-run reconciliation: never failed, never a new key — the command is left needing reconciliation and nothing is claimed to the customer" ✓ |
| Ausencia de duplicados | 1 POST y 1 cotización (respuesta perdida); 1 cotización encontrada por la clave (retenida); 0 cotizaciones y nunca una clave nueva (prolongada) ✓ |

No se usó Quote V2 real para GAP-16: 0 emisiones reales.

**Limitaciones operacionales de GAP-16. Se registran; no se declaran resueltas** (ADR-037 L1–L4, propuesto):

| Limitación | Efecto | Hito |
|---|---|---|
| Silencio con el cliente durante una emisión retenida (L3) | Mientras está retenida o incierta, el run está diferido o suspendido y no hay mensaje "pendiente". Observado: ≈ 5,5 min sin respuesta en una caída breve (aceptación §14.3) | J7 (alerta) o un acuse durable (slice y ADR propios) |
| Agotamiento del presupuesto del run (L4) | La retención consume ≈ 300 s de plataforma. Con un presupuesto menor, la cotización se emite sin respuesta al cliente | J7: `R4_EXEC_MAX_RUN_DURATION_MS` ≥ 10 min, verificado en el despliegue |
| Necesidad de intervención humana (L2, R6) | Un corte más largo que las reconciliaciones del run deja la tarea `blocked` y luego `failed/write_not_applied`, con la autorización varada. No hay operadores reales (GAP-10) | J7: runbook y operador |
| Ausencia de caducidad comercial automática (R5, GAP-08) | Una emisión retenida se envía al liberarse con el cuerpo congelado, sin re-verificar precios, stock ni despacho | J7: runbook o caducidad |

## 14. Evidencia de producción intacta

**NOT_VERIFIED.**
- Esta sesión no ejecutó ningún comando en EC2: los dos intentos SSH no autenticaron.
- No publicó ramas que desplieguen (un push no despliega).
- No modificó ninguna base.

No puede, sin embargo, afirmar el estado actual de producción. Lo verifica el operador en §17.1.

## 15. Limitaciones y riesgos

1. **Prueba contra owners reales con `@7`: pendiente** (GAP-02). La parte nueva de `@7` falla **cerrado**, sin éxito falso ni segunda cotización. Lo que falta demostrar es que el cliente obtiene la emisión contra los owners desplegados. Incluye la liquidación estricta por línea, despacho, `exemptNet` y tipo de correlación, y la cobertura de San Bernardo en Shipping real.
2. **Entrega documental: DEFERRED** (`J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA`). El cliente recibe número, totales y validez en texto; no recibe el PDF. No es un fallo del canary de emisión.
3. **Mensaje de emisión redactado por el modelo** (GAP-03): `GAP_03_DISPOSITION=J7_PRODUCTION_GATE_P0` (Sales Response Integrity). Antes del outbound, la emisión comunicada al cliente debe protegerse mediante validación o composición determinista. No bloquea el cierre de J3.
4. Las limitaciones operacionales de §13.
5. Los gates J7 del registro de brechas siguen abiertos (GAP-06 a GAP-14 y GAP-17).

## 16. Decisión de aceptación propuesta

El canary no se ejecutó, de modo que, según el mandato §11:

```text
J3_TECHNICAL_ACCEPTANCE=PASS            (LOCAL @7; EC2 @5/@6)
J3_AUTONOMOUS_ISSUANCE=PASS             (LOCAL/REAL-MODEL @7; EC2 @5/@6) · EC2 @7 NOT_RUN
J3_REAL_MODEL_E2E=PASS
J3_REAL_QUOTE_V2_E2E=PASS @5/@6 · NOT_RUN @7
J3_OFFER_INTEGRITY=PASS                 (LOCAL)
J3_DOCUMENT_VERIFICATION=PASS
J3_DOCUMENT_DELIVERY=DEFERRED
J3_CUSTOMER_JOURNEY_FULL=INCOMPLETE
J3_PRODUCTION_ROLLOUT=NOT_AUTHORIZED
J3_FINAL_STATUS=CONDITIONAL             (único faltante del alcance re-delimitado: el canary EC2 de @7)
```

Si el canary de §17 pasa todos sus gates, la propuesta pasa a `J3_FINAL_STATUS=READY_TO_CLOSE_RESCOPED`. El cierre formal lo aprueba el owner.

## 17. Procedimiento para un operador autorizado

**Precondiciones:**
- operador con acceso SSH legítimo al host;
- autorización del owner vigente (mandato del 2026-10-14);
- **una** cotización real como máximo.

**Detenerse** ante cualquier gate fallido y conservar la evidencia. No improvisar. No ejecutar una segunda emisión.

### 17.1 Producción, solo lectura

1. `pm2 jlist`: procesos `r4-*` (gateway, worker, scheduler) `online`. Anotar contadores de reinicio y `pm_cwd`.
2. En el checkout productivo de R4:
   - `git rev-parse HEAD`: esperado `ef5a354…`; anotar el SHA completo;
   - `git status --porcelain` vacío.
3. Gateway `GET /ready` y `/ready/r4` (puerto del gateway, por defecto `127.0.0.1:8090`): `sales-production@3`, `pendingMigrations: []`.
4. Ledger productivo: `select id, checksum from r4_schema_migrations order by id`. Debe tener Sales hasta `0007`, **sin** `0008` ni `0009`. Comparar con el ledger registrado en J3E-B §11.3.
5. `production.env`: perfil `@3`, rollout 0 %, allowlist sin cambios. Solo leer, sin imprimir valores secretos.
6. Si algo no coincide: **detenerse** y reportarlo. No corregir.

### 17.2 Aislamiento del canary

1. Checkout `~/r4-j3e-canary`, independiente del productivo.
2. Llevarlo a `d19bffe63f5ca112f22a6fc29f8cdb7a49b2c8ad`:
   - la rama ya está publicada: `git fetch` con la llave de solo lectura del host, o un bundle incremental;
   - luego `git checkout --detach d19bffe63f5ca112f22a6fc29f8cdb7a49b2c8ad`.
   - Verificar `git rev-parse HEAD` = SHA completo y `git status --porcelain` vacío.
3. `npm ci` **solo** si cambió `package-lock.json` respecto del checkout anterior; luego `npm run build`. Verificar **≥ 700 MB libres** después.
4. Entorno del canary:
   - archivo nuevo, 0600, derivado de `canary-j3eb.env`;
   - `sales-production@7`, su propia captura, **sin** claves de WhatsApp, **sin** `R4_DATABASE_URL` productiva, `R4_QUOTE_*` hacia el despliegue de **integración** de Quote V2;
   - los límites aprobados del canary, **sin elevarlos**;
   - `R4_AUTONOMOUS_QUOTE_MAX_PER_CONVERSATION=1` y `…_MAX_PER_HOUR=1`.
5. Aislamiento en la base y en el host:
   - `npm run sales:canary -- status`: `isolation: verified`, tráfico ajeno 0;
   - ningún proceso `apps/api` contra la base del canary;
   - ningún worker antiguo del canary vivo;
   - el contenedor de la base solo en loopback, con un rol.
6. Estado previo:
   - sin ejecuciones abiertas, solicitudes humanas, schedules ni outbound pendientes en la base del canary;
   - Gmail `disabled` en Quote V2;
   - WhatsApp real ausente del entorno del canary.
7. **Tarea histórica `j3eb-pos-1`** (task `01a138aa-b3f9-797d-981f-20eea3a9273c`, de la base marcada del canary): leer su estado.
   - Si sigue ejecutable, cancelarla **solo** contra la base del canary.
   - Opción: `production:sales:control tasks cancel --task <id> --reason "J3 final canary preflight: retire j3eb-pos-1"`, con un entorno efímero cuyo `R4_DATABASE_URL` sea la URL de la base **del canary**. Confirmar el marcador antes y el estado `cancelled` después.
   - Si la herramienta exige configuración productiva, **no** cargar `production.env`: detenerse y consultar.
   - `j3eb-neg-1` puede seguir `blocked` (handoff).
8. `npm run sales:canary -- init` con `@7`. Esperado: **0** migraciones aplicadas y registro **solo** de `sales@7`.
9. Línea base de Quote V2, por lectura con el principal de R4: cantidad de cotizaciones, operaciones, bindings de idempotencia y entregas.
10. Modelo: DeepSeek V4 Flash según el perfil validado; sin JSON mode ni cambios.

### 17.3 Shipping real a San Bernardo (antes de la conversación)

Comprobar con el owner de Shipping, por lectura, que San Bernardo tiene cobertura y tarifa para un peso razonable. Si no la tiene, la conversación debe mostrarlo honestamente: es un resultado válido, no se inventa ninguna tarifa. En ese caso, decidir con el owner un destino alternativo justificable antes de empezar.

### 17.4 Conversación sintética (una sola, positiva)

1. `npm run sales:canary -- identity-key --conversation j3-final-1` y agregar la clave a la allowlist **del canary**.
2. `npm run sales:canary -- run`, en una sesión separada con log a archivo.
3. Mensajes del cliente, con `npm run sales:canary -- send --conversation j3-final-1 --text "<texto>"`:
   1. "Hola, necesito cotizar una rack, una barra olímpica y discos con despacho a San Bernardo."
   2. Responder con veracidad las preguntas del agente sobre productos, variantes y cantidades. Mantener la cesta **dentro** de los límites del canary; si excede, elegir una cesta sintética más económica y justificarlo en el informe.
   3. Elegir una alternativa de despacho válida y pedir la cotización del conjunto.
   4. Tras la oferta: "Sí."
   5. Tras la aclaración o la re-presentación: "Sí, emítela."
4. Detener el runtime en cuanto el agente responda la emisión.
5. **Prohibido:** reenviar eventos manualmente o intentar crear otra cotización. Ante un estado incierto: consultar primero al owner por la clave existente (lookup de idempotencia) y dejar actuar la reconciliación gobernada.

### 17.5 Evidencia a registrar (mandato §7)

| Grupo | Qué registrar |
|---|---|
| Oferta | Productos de Catalog (keys y variantes); cantidades; precios del owner; despacho de Shipping real; totales; SHA-256 del mensaje presentado = renderización Sales (`offer_text_sha256` de `0009`) |
| Confirmación | Propuesta de "Sí." rechazada `customer_confirmation_not_explicit`; "Sí, emítela." `authorized:eligible` (`0008`); `confirmation_input_id` = último input real; confirmación posterior a la oferta |
| Quote V2 | 1 cotización; 1 clave (`execution_key` = `Idempotency-Key`); recibo `succeeded`; liquidación estricta sin `unknown`; tipo de correlación; manifiesto `available`; SHA-256 del PDF `verified` (manifiesto = artefacto = recibo); conteos antes y después (+1 cotización, +1 operación, +1 binding, +0 entregas) |
| Outbound | Todo en la captura del canal sintético con el destinatario sintético; 0 WhatsApp; 0 email; ningún texto afirma que el PDF fue entregado |
| Producción | Repetir §17.1: todo idéntico |
| Métricas | Llamadas al modelo, tokens, latencias y errores de formato. Sin secretos ni datos personales |

**Criterio de aprobación:**
- todas las filas cumplen;
- exactamente **1** cotización real;
- producción idéntica.

Cualquier desvío ⇒ `J3_CANARY_EC2=FAIL`, con el bloqueo exacto documentado y sin ampliar el alcance.

## 18. Ejecución del canary con la identidad SSH autorizada (2026-10-14, 22:23–23:10 UTC): **FAIL**

**Autorización del owner:**
- usar la identidad SSH local indicada, solo por SSH (sin mostrar, copiar ni modificar la llave);
- fijar el checkout aislado a `c46d6c3c0a16dd3d35ae113ba06ee916618094fb`;
- como máximo una cotización sintética en Quote V2 de integración.

Tras el primer intento fallido, el owner autorizó **un último intento** con una conversación nueva. Todo el preflight de §17 se cumplió. Ninguna conversación llegó a presentar una oferta: el modelo superó dos veces seguidas el límite de 60 s por llamada en cada una, la recuperación de ADR-028 se agotó y la plataforma pasó la tarea a humanos. **0 cotizaciones, 0 propuestas `quote.create` y producción intacta.**

### 18.1 Commit y transferencia

- Bundle incremental `a841adb..r4-j3e-c-deterministic-commercial-offer`, con una sola cabecera (`c46d6c3`):
  - 210 127 bytes, SHA-256 `39e7025096ae483d61d76aaf6a1ca2283690ed59650ad89c5ec249301c22c2d6`;
  - el mismo hash en el host; `git bundle verify` "is okay".
- Checkout aislado `~/r4-j3e-canary`:
  - `fetch` solo de esa rama; `checkout --detach c46d6c3c0a16dd3d35ae113ba06ee916618094fb`;
  - árbol limpio;
  - desde `a841adb`: 0 cambios de harness, 0 SQL, `package-lock.json` sin cambios, de modo que no se ejecutó `npm ci`;
  - `npm run build` exit 0.
- Disco libre: 747 MB antes y 745 MB después (≥ 700).

### 18.2 Preflight de producción (solo lectura; antes y después)

| Verificación | Antes (22:23) | Después (23:10) |
|---|---|---|
| Identidad del servidor | Llave del host verificada (`StrictHostKeyChecking=yes`); `ip-172-31-1-183`, `ec2-user` | Igual |
| PM2 `r4-channel-gateway` / `r4-sales-worker` / `r4-scheduler` | online; reinicios 11 / 16 / 0; en línea desde el 2026-10-09 21:01 (despliegue J3D) | online; 11 / 16 / 0 |
| Checkout productivo | `ef5a35404a7d28bf6ee1a1370de739bd8610df79`, `main`, limpio | Igual |
| `production.env` | `R4_EXECUTION_MODE=production`, `sales-production@3`, rollout 0 % | Sin cambios |
| Gateway `/ready` | `ready`, `sales-production@3`, WhatsApp REAL, `pendingMigrations: []`; `/ready/r4` 200 | Igual |
| Ledger productivo | 11 migraciones; Sales hasta `0007`; **sin** `0008`/`0009` | 11 |
| Outbound productivo | Último del 2026-10-08 | 0 nuevos en las últimas 3 h |
| Otros | 20 inbound `rejected` en 24 h: tráfico previo del número productivo, ajeno al canary | — |

### 18.3 Aislamiento

| Gate | Resultado |
|---|---|
| Base del canary | `r4_sales_canary`, marcador `r4-sales-canary:v1:50ea36160c0b`, solo `127.0.0.1:55434`, 1 rol de login, 0 sesiones ajenas |
| `sales:canary status` | `isolation: verified`, tráfico ajeno 0/0/0 (antes de cada arranque) |
| Procesos | Ningún proceso del canary ni `apps/api` vivo antes de arrancar; solo los de producción, Catalog y Quote V2 |
| Estado previo | 0 ejecuciones, schedules u outbound abiertos. 4 tareas `waiting` sin timers. `j3eb-neg-1` `blocked` (handoff) |
| `j3eb-pos-1` (`01a138aa-…`) | Estaba `running` sin worker. **Cancelada solo en la base del canary**: `production:sales:control tasks cancel`, con `R4_DATABASE_URL` del canary, destino verificado `127.0.0.1:55434/r4_sales_canary` antes de ejecutar |
| Entorno | `canary-j3e7.env` (0600), derivado de `canary-j3eb.env` con las mismas claves. Solo cambian el perfil (`sales-production@7`), la captura (`j3e7-canary-outbound.jsonl`) y `R4_BUILD_REF`. La allowlist del canary agrega dos claves sintéticas. 0 claves de WhatsApp, sin `R4_DATABASE_URL` |
| Límites (sin cambios) | ≤ 250 000 CLP bruto, ≤ 3 líneas, ≤ 5 unidades por línea y ≤ 5 en total, 1 por conversación, 1 por hora, ventana de confirmación 900 s |
| `sales:canary init` | Migraciones Core `[]` y Sales `[]`; registró **solo** `sales@7`; `@3–@6` sin cambios |
| Quote V2 de integración | `QUOTE_EMAIL_PROVIDER=disabled`. Línea base: 6 cotizaciones, 5 operaciones, 8 bindings de idempotencia, 1 entrega |
| Shipping real, San Bernardo | Resuelta (comuna 121, Metropolitana). Blue Express EXPRESS: $4.896 (10 kg), $8.921 (40 kg), lectura |

### 18.4 Modelo

`openai_compatible`, perfil `deepseek-v4-flash` (`R4_MODEL_NAME=deepseek-flash`), *thinking* activado (`R4_MODEL_EXTRA_BODY`). Es la misma configuración validada en J3E-A/B, sin cambios.

Hay dos límites de tiempo:
- el del proveedor, `R4_MODEL_TIMEOUT_MS=120000`;
- el de cada llamada en el worker, `R4_EXEC_MODEL_CALL_TIMEOUT_MS`. No está definido en el entorno, así que vale su default de **60 000 ms** (`apps/worker/src/config.ts:27`) y se aplica primero (`packages/model-gateway/src/gateway.ts:79-92`).

### 18.5 Conversaciones (canal sintético; mensajes del cliente guionados, decisiones del agente no)

**`j3-final-1`** (task `01a13c88-d517-…`):
1. Cliente: "Hola, necesito cotizar una rack, una barra olímpica y discos con despacho a San Bernardo." El agente pidió el tipo de entrenamiento, el espacio (alto y ancho) y el presupuesto. No inventó productos.
2. Cliente: entrenamiento de fuerza en casa, garaje de 2,3 × 2 m, unos $200.000 con despacho. Tras varias búsquedas en Catalog real, el agente dijo **con honestidad** que $200.000 no alcanzan para el set completo. Citó un precio real (barra Cerakote Black Camo 700lb, $129.990, en stock) y ofreció tres caminos.
3. Cliente: opción 3, hasta $240.000 con despacho (dentro del límite), las tres cosas en su versión más económica. Tras 9 lecturas de Catalog, dos llamadas seguidas al modelo superaron 60 s. Resultado: `model_failure`, recuperación agotada, handoff, task `blocked`, **sin mensaje al cliente** (comportamiento de GAP-17).

**`j3-final-2`** (último intento autorizado; task `01a13ca3-393a-…`):
1. Cliente: el mismo pedido, con presupuesto máximo de $240.000 y "lo más económico" desde el inicio. El agente hizo lecturas de Catalog y un `sales.workspace.update` (`REVERSIBLE_WRITE`, política `allow`, solo en la base del canary). Luego dos llamadas seguidas superaron 60 s, de nuevo con handoff, task `blocked` y 0 mensajes.

En ninguna conversación se llegó a `quote.preview`, a la oferta determinista ni a la confirmación.

### 18.6 Evidencia

| Rubro | Valor |
|---|---|
| Oferta determinista, SHA-256 | No aplica: 0 `quote.preview` |
| Confirmación ("Sí." / "Sí, emítela.") | No alcanzada; 0 decisiones `0008` nuevas y 0 evidencias `0009` nuevas |
| Política y autorizaciones | 2 propuestas `sales.workspace.update`, 1 ejecución `succeeded`. 0 propuestas `quote.create` |
| Quote V2 | **0 emisiones.** Después: 6 / 5 / 8 / 1, idéntico a la línea base. `sales.quote_v2_requests` sin filas nuevas (2) |
| Liquidación estricta, PDF, idempotencia, recibos de emisión | No aplica |
| Outbound | 2 mensajes, ambos `accepted` en la captura sintética, al destinatario sintético `synthetic:j3-final-1`. 0 WhatsApp, 0 email. Ningún texto afirma una emisión ni una entrega |
| Llamadas al modelo | 61: 56 completadas y 5 `timeout`, todas a 60 000–60 003 ms con `httpStatus` nulo (el corte es de R4, no un error de DeepSeek). Latencia de las completadas: p50 21,4 s, p90 48,5 s, máximo 53,2 s. Tokens de entrada ≈ 1,93 M |
| Comparación | J3E-B (misma configuración): p50 4,2 s, máximo 14,5 s. La latencia del proveedor fue ≈ 4–5 × mayor en esta ventana |
| Estado final | Runtime del canary detenido (SIGTERM). Tareas `j3-final-1/2` `blocked` con handoff. Logs en `~/r4-j3d/j3e7-canary-run.log` y captura en `~/r4-j3d/j3e7-canary-outbound.jsonl` |

### 18.7 Diagnóstico y lo que no se hizo

- **No es un fallo de seguridad, aislamiento ni integridad.** Nada se emitió, nada salió del canal sintético y producción quedó idéntica.
- **Causa:** latencia del proveedor del modelo frente al límite por llamada de R4 (60 s, default no configurado del worker), con dos excesos seguidos en un mismo turno. Es la misma clase que GAP-17 (dos fallas del modelo ⇒ handoff ⇒ cliente sin respuesta), con timeouts en vez de salidas mal formadas.
- **Por decisión, no se hizo:**
  - subir `R4_EXEC_MODEL_CALL_TIMEOUT_MS`;
  - desactivar *thinking*;
  - cambiar de modelo;
  - un tercer intento.
- **Opciones para el owner antes de un nuevo canary**, cada una con autorización propia:
  1. Fijar en el entorno del canary `R4_EXEC_MODEL_CALL_TIMEOUT_MS=120000`, alineado con el timeout del proveedor. Es configuración del canary; no toca código, límites comerciales ni producción.
  2. Repetir en una ventana con latencia normal del proveedor (J3E-B: máximo 14,5 s).
  3. Evaluar *thinking* desactivado o JSON mode (propuesta J3E-B §12.2).
- La recomendación es la opción 1, porque el umbral efectivo de 60 s no es una decisión explícita del perfil validado.

### 18.8 Decisión de aceptación propuesta

```text
J3_CANARY_EC2=FAIL                 (proveedor del modelo / límite de 60 s; 0 emisiones)
J3_REAL_QUOTE_V2_ISSUANCES=0
J3_PRODUCTION_UNCHANGED=YES
J3_FINAL_STATUS=CONDITIONAL        (falta la prueba final contra owners reales con @7)
```

No se amplía el alcance. GAP-17 (J7) recibe esta evidencia adicional: también los timeouts del proveedor llevan a un handoff sin respuesta al cliente.

## 19. Repetición del canary (2026-10-15, 15:25–15:33 UTC): **FAIL, sin emisión, con la causa precisada**

Según el owner, la falla del 14 coincidió con una falla de la API de DeepSeek. Se repitió el canary con la misma configuración (sin cambiar el timeout, el modelo ni los límites) y la misma autorización (≤ 1 cotización).

**Preflight, solo lectura, en verde:**
- producción `ef5a354`, `@3`, rollout 0 %, `/ready` `ready` con WhatsApp REAL y `pendingMigrations: []`;
- 11 migraciones (sin `0008`/`0009`); PM2 11/16/0; 0 outbound productivos en 24 h;
- canary en `c46d6c3`, limpio, `isolation: verified`, 0 tráfico ajeno, 0 ejecuciones, schedules ni outbound abiertos;
- Quote V2 6/5/8/1; Gmail `disabled`; 733 MB libres.

**Conversación `j3-final-3`** (mismo primer mensaje que `j3-final-2`). En el turno 1, el agente hizo 11 `catalog.search` seguidos sin responder. Dos llamadas superaron 60 s, en la run original y en la de recuperación: recuperación agotada, handoff, task `blocked`, 0 mensajes al cliente. **0 propuestas `quote.create`, 0 emisiones; Quote V2 6/5/8 sin cambios.** Runtime detenido.

**Causa precisada.** DeepSeek respondió con normalidad al inicio (3–9 s). Lo que crece es la salida del modelo, razonamiento incluido; la entrada se mantiene acotada:

| Llamada | Latencia (ms) | Tokens de entrada | Tokens de salida |
|---|---|---|---|
| 1 | 2 956 | 9 433 | 316 |
| 2 | 7 201 | 10 435 | 1 111 |
| 3 | 9 124 | 12 162 | 1 346 |
| 4 | 15 576 | 13 889 | 2 431 |
| 5 | 24 237 | 15 654 | 4 056 |
| 6 | **60 006 (timeout)** | — | — |
| 8 (recuperación) | 54 132 | 19 164 | **8 987** |
| … | 31 517 | 26 026 | 4 793 |
| 13 | **60 009 (timeout)** | — | — |

- La latencia escala con la salida (≈ 6 ms por token): unos 10 000 tokens de salida superan el límite de R4 de 60 s por llamada (`R4_EXEC_MODEL_CALL_TIMEOUT_MS`, default).
- La entrada (≤ 26 k tokens) no es el factor.
- No hay código de error de DeepSeek: el corte es de R4.

**Conclusión.** Con *thinking* activado y el patrón de búsquedas sucesivas de `@7`, el límite de 60 s por llamada no es suficiente. No se repite sin una decisión del owner. Opciones de configuración del canary (sin código, sin límites comerciales, sin producción):
1. `R4_EXEC_MODEL_CALL_TIMEOUT_MS=120000`, alineado con `R4_MODEL_TIMEOUT_MS`.
2. Acotar la salida con `R4_MODEL_MAX_OUTPUT_TOKENS`. Riesgo: cortar una decisión válida.
3. Desactivar *thinking*. Cambia el perfil del modelo validado; requeriría revalidar.

```text
J3_CANARY_EC2=FAIL (3 conversaciones, 0 emisiones)
J3_REAL_QUOTE_V2_ISSUANCES=0
J3_PRODUCTION_UNCHANGED=YES
J3_FINAL_STATUS=CONDITIONAL
```

## 20. Canary con timeouts del canary autorizados (2026-10-15, 15:42–17:12 UTC): **PASS**

**Autorización del owner:**

```text
CANARY_RETRY=AUTHORIZED
R4_MODEL_TIMEOUT_MS=180000
R4_EXEC_MODEL_CALL_TIMEOUT_MS=195000
CONFIG_EFFECTIVE_VERIFICATION=REQUIRED
MODEL_PROFILE=UNCHANGED, THINKING=ENABLED, CATALOG_DEPLOYMENT=UNCHANGED
PRODUCTION_CHANGES=FORBIDDEN
MAX_NEW_QUOTE_ISSUANCES=1
```

### 20.1 Cambio aplicado (solo en el canary)

- `~/.config/r4-canary/canary-j3e7.env` (0600), con respaldo `canary-j3e7.env.bak-20261015T154247Z` (0600):
  - `R4_MODEL_TIMEOUT_MS` 120000 → 180000;
  - `R4_EXEC_MODEL_CALL_TIMEOUT_MS` agregado, 195000.
- La única otra modificación es la clave sintética de cada conversación nueva en la allowlist del canary.
- `production.env`, el checkout productivo y PM2 no se tocaron.
- **Corrección de un dato del mandato:** antes no se había aplicado ningún valor de 135 s. El corte a 60 s era el default de `R4_EXEC_MODEL_CALL_TIMEOUT_MS`, que el entorno nunca definía.

### 20.2 Verificación de la configuración efectiva (exigida antes de ejecutar)

| Exigencia | Evidencia |
|---|---|
| Archivo de entorno del worker aislado | El proceso se inicia con `bash -c 'set -a; . ~/.config/r4-canary/canary-j3e7.env; set +a; exec node agents/sales/dist/cli/canary.js run'`. La CLI lee solo `process.env`, nunca un `.env` (`command.ts:19-28`) |
| Precedencia | La sesión SSH no define ninguna variable `R4_*`, así que manda el archivo. El worker recibe `{...env, R4_DATABASE_URL: <canary>}` (`command.ts:191-192`) |
| Valores en el proceso vivo | `/proc/<pid>/environ` del `node … canary.js run`: `R4_EXEC_MODEL_CALL_TIMEOUT_MS=195000`, `R4_MODEL_TIMEOUT_MS=180000`, `R4_PROD_POLICY_PROFILE=sales-production@7` |
| El executor usa 195 000 ms | Script de solo lectura con los mismos cargadores (`loadWorkerConfig`, `resolveExecutionLimits`, `modelCallTimeout`): `modelCallTimeoutMs=195000`; timeout de la primera llamada 195 000 y con 5 min consumidos 195 000 |
| DeepSeek usa 180 000 ms | `loadOpenAICompatibleConfig`: `timeoutMs=180000` (validador: 1 000–600 000). Perfil `deepseek-v4-flash`, *thinking* `enabled`, sin `maxOutputTokens` |
| Ningún timeout inferior en la cadena | Kernel: `min(modelCallTimeoutMs, maxRunDurationMs − elapsed)` (`budget.ts:133`). Gateway: `limits.timeoutMs` (`gateway.ts:79`). Proveedor: `AbortSignal.timeout(180000)` (`provider.ts:90`). Transporte: Node v22.23.1 con undici 6.27.0, dispatcher por defecto (`headersTimeout`/`bodyTimeout` 300 000 ms) y sin `setGlobalDispatcher` ni `Agent` propio. Lease de 30 s con heartbeat de 10 s, que se renueva durante la llamada |
| Presupuesto total del run | **Corrección:** el run efectivo es de **600 000 ms (10 min)**, no 15. La definición `sales@7` declara `budgets.maxDurationMs=600000` y el kernel aplica el más estricto (`resolveExecutionLimits`). También 40 llamadas al modelo y 40 lecturas por run. No se cambió, porque las definiciones son inmutables. Cada turno es un run propio |

### 20.3 Preflight (solo lectura)

- **Producción:** `ef5a354`, limpio, `@3`, rollout 0 %. `/ready` `ready` con WhatsApp REAL y `pendingMigrations: []`. 11 migraciones (sin Sales `0008`/`0009`). PM2 11/16/0. 0 outbound productivos en 24 h.
- **Canary:**
  - `c46d6c3`, limpio;
  - `isolation: verified`, tráfico ajeno 0/0/0;
  - 0 ejecuciones, schedules u outbound abiertos; 0 sesiones ajenas;
  - límites sin cambios;
  - Quote V2 6/5/8/1, Gmail `disabled`;
  - 733 MB libres.

### 20.4 Conversación `j3-final-4` (task `01a1403b-9da2-71db-aadf-36d4a299cf31`, `sales@7`, binding `sales-production@7` `allowlisted`)

| # | Cliente (sintético) | Agente (DeepSeek real) |
|---|---|---|
| 1 | "Hola, necesito cotizar una rack, una barra olímpica y discos con despacho a San Bernardo. Es para entrenar fuerza en mi casa y busco lo más económico: mi presupuesto máximo es 240 mil pesos con despacho incluido." | Rack más económico del Catalog real: Squat Rack Delta (HWM) $109.990. Pregunta el peso de discos y el tipo de rack. La primera run agotó sus 10 min tras 14 búsquedas; la run de recuperación (ADR-028) respondió |
| 2 | "Me sirve el Squat Rack Delta. En discos necesito poco, unos 20 kilos en total, lo más económico. Y una barra olímpica económica." | 3 líneas del Catalog ($195.970 en productos). `shipping.quote` real a San Bernardo con dos alternativas: Pesas Chile Despacho Directo **$1** (dato del owner, ver §20.7) y Blue Express EXPRESS $17.654. Primera run otra vez agotada a los 10 min; la recuperación respondió |
| 3 | "Prefiero Blue Express. Prepárame la cotización de todo el conjunto, por favor." | **Oferta determinista Sales** `r4-sales-offer-es-v1`, ref. `Q-DDEB47-2`: líneas, despacho, neto $179.516, IVA $34.108, total $213.624, "¿Emito esta cotización? Puedes responder: Sí, emítela." |
| 4 | "Sí." | Propone `quote.create@5`. Política `allow/autonomous`. **La capability rechaza** `customer_confirmation_not_explicit` (`not_a_confirmation`). Re-presenta la oferta idéntica |
| 5 | "Sí, emítela." | `quote.create@5` → `authorized:eligible` → 1 envío → **PC-000006 emitida**, recibo `succeeded`. Respuesta: número, líneas, despacho, totales y validez hasta el 19-10-2026; "El documento fue generado y verificado correctamente". No afirma haber entregado el PDF al cliente |

### 20.5 Evidencia

**Oferta**

| Ítem | Valor |
|---|---|
| Productos (Catalog) | P1536 `HWM-DT50-SR-N` Squat Rack Delta 1 × $109.990 · P28 `BORC` Barra Olímpica 8.5kg Eco Serie 1 × $39.990 · P573 `DOBL25` Par Discos Olímpicos 25lb 1 × $45.990. Sin variantes (`variantRef` nulo) |
| Despacho (Shipping real) | Blue Express EXPRESS, San Bernardo, Metropolitana: neto 14 835, IVA 2 819, bruto 17 654 |
| Totales | Neto 179 516 · IVA 34 108 · bruto 213 624. Iguales en el snapshot, el cuerpo congelado, el owner y el recibo |
| Render y SHA-256 del mensaje presentado | `r4-sales-offer-es-v1`. `offer_text_sha256` (`0009`) = `offerMessageSha256` (`0008`) = SHA-256 del texto capturado en el canal sintético = `693e27f64989972927818982ddded86ab0db9bc92bec70c9c94733a2b96f14af` |

**Confirmación**

| Ítem | Valor |
|---|---|
| "Sí." | Decisión `0008` `rejected:customer_confirmation_not_explicit`; recibo `rejected`; 0 llamadas al owner |
| "Sí, emítela." | Decisión `0008` `authorized:eligible`: bruto 213 624, 3 líneas, 3 unidades, versión comercial 2, 0 en la última hora, 0 en la conversación. Gramática `r4-sales-confirmation-es-v1`, regla `affirmation=si;courtesy=none` |
| Evidencia `0009` | `confirmation_input_id 01a1408c-36c0-…`; confirmación 17:11:33.3 posterior a la oferta re-presentada (17:11:14.2; outbound `accepted`); `confirmation_text_sha256 5cad1a42…` |

**Política**
- 4 decisiones `allow/autonomous` con `sales-production-autonomous-policy@1`, hash `515ce98f…`, `r4.policy-engine.v1`, identidad `provisional`:
  - 2 para `sales.workspace.update@2`;
  - 2 para `quote.create@5`.
- 0 solicitudes humanas.

**Quote V2**

| Ítem | Valor |
|---|---|
| Emisión | **PC-000006**, `quote_id 1d2d66e9-f05b-4f75-80f1-798c03ad0761`, `issued` 2026-10-15T17:11:38.974Z. Correlación `r4-sales` / `r4-task` / `01a1403b-…` (la task). Cliente `guest` |
| Validez | `cl-retail-5-calendar-days-v1`, hasta 2026-10-19 (`valid_until_exclusive` 2026-10-20T03:00Z) |
| Liquidación estricta | Recibo `succeeded` con liquidación estricta. Por línea y en despacho, owner = snapshot (92 429/17 561/109 990 · 33 605/6 385/39 990 · 38 647/7 343/45 990 · 14 835/2 819/17 654); `exemptNet` 0; tipo de correlación `r4-task` |
| Idempotencia | `execution_key r4x_01a1408c4b2970488e90b067b5deb532` = `Idempotency-Key`. 1 binding `r4-sales-integration`/`quote.create_and_issue` → esta cotización. 1 operación `quote.issue` `succeeded` (1 intento). 1 fila de envío (`0007`). Recibo `replayed: false` |
| Conteos del owner | Cotizaciones 6 → **7**, operaciones 5 → 6, bindings 8 → 9, entregas 1 → **1**, documentos 5 → 6 |

**PDF**

| Ítem | Valor |
|---|---|
| Manifiesto del owner | `application/pdf`, SHA-256 `1913c9d93b2156ce99814d97f48b81e2098b311db01e444eb0cd460c905ca2e2`, 31 669 bytes, `quote-pdf-template-v5` |
| Artefacto y R4 | `artifact_ref sha256:1913c9d9…` = `sales.quote_v2_issued.pdf_sha256` = recibo `document.pdfSha256`. Verificación `verified` |

**Recibos y resto**

| Ítem | Valor |
|---|---|
| Recibos de la task | `workspace.update@2` ×2 `succeeded`; `quote.create@5` `rejected` (Sí.); `quote.create@5` `succeeded` (`quote:1d2d66e9…`, `PC-000006`, 1 intento `execute`, `applied`) |
| Outbound | 5 mensajes de `j3-final-4`, todos `r4-synthetic`/`accepted`, a `synthetic:j3-final-4`. 0 WhatsApp. 0 email (proveedor `disabled`; entregas del owner 1 → 1). Ningún texto afirma que el PDF fue entregado al cliente |
| Producción, después | `ef5a354` limpio; `/ready` `sales-production@3` y `pendingMigrations: []`; 11 migraciones; PM2 11/16/0; 0 outbound productivos en 6 h |

### 20.6 Modelo y eficiencia (para medir después; no se optimiza dentro de J3)

| Métrica | Valor |
|---|---|
| Llamadas | 56: 54 completadas, 2 cortadas por el **presupuesto de 10 min del run**, no por el timeout de DeepSeek |
| Latencia de las completadas | p50 26,0 s, p90 49,2 s, **máximo 77,4 s**. Esa llamada habría fallado con el límite anterior de 60 s |
| Tokens | ≈ 2,74 M de entrada y 271 k de salida; salida máxima por llamada 13 395 |
| Lecturas | 44 (`catalog.search`, `catalog.get_product_context`, `shipping.quote`). En los turnos 1 y 2, la primera run agotó los 10 min (14 y 16 lecturas) y ADR-028 los recuperó (2 de 2) |
| Tiempo total | Primer mensaje → emisión: ≈ 88 min de reloj. Incluye ≈ 60 min de espera del lado del operador entre el turno 1 y el 2; el cliente sintético respondió tarde. Turnos 3–5: ≈ 2 min |

Coincide con la lectura del owner: el timeout era insuficiente (resuelto en el canary), pero además el agente hace búsquedas repetitivas que agotan el presupuesto del run. Es un problema de eficiencia del agente, distinto del timeout. Se mide aquí y no se desarrolla dentro de J3.

### 20.7 Observaciones

1. **Tarifa de $1 de Shipping.** Shipping real ofreció "Pesas Chile – Despacho Directo" a $1 hacia San Bernardo. Es un dato del owner que el agente transmitió tal cual, sin inventarlo, y el cliente no lo eligió. Hay que revisarlo con el owner de Shipping antes de clientes reales.
2. **Recuperación en cada turno largo.** Los turnos 1 y 2 completaron gracias a la recuperación de ADR-028 tras agotar el presupuesto del run. Funcionó, pero duplica latencia y costo; queda como entrada para la medición de eficiencia.
3. **GAP-03.** El mensaje de emisión, redactado por el modelo, coincidió con el recibo (número, líneas, totales, validez). Es una coincidencia observada, sin garantía de código (J7 P0).
4. **Estado que queda en EC2:**
   - runtime del canary detenido;
   - `canary-j3e7.env` con los timeouts autorizados (respaldo disponible);
   - tareas `j3-final-1/2/3` `blocked` con handoff; `j3-final-4` `waiting`;
   - logs `~/r4-j3d/j3e7-canary-run.log` y captura `j3e7-canary-outbound.jsonl`;
   - PC-000006 en Quote V2 de integración (solo sintético, Gmail deshabilitado).

### 20.8 Decisión de aceptación propuesta

Todos los gates de §17.5 cumplen:
- exactamente 1 cotización real;
- producción idéntica;
- todo el outbound en el canal sintético;
- "Sí." no autoriza y "Sí, emítela." sí;
- oferta byte a byte;
- liquidación estricta;
- PDF verificado;
- idempotencia y recibos coherentes.

```text
J3_CANARY_EC2=PASS
J3_REAL_QUOTE_V2_ISSUANCES=1
J3_PRODUCTION_UNCHANGED=YES
J3_TECHNICAL_ACCEPTANCE=PASS
J3_AUTONOMOUS_ISSUANCE=PASS
J3_REAL_MODEL_E2E=PASS
J3_REAL_QUOTE_V2_E2E=PASS
J3_OFFER_INTEGRITY=PASS
J3_DOCUMENT_VERIFICATION=PASS
J3_DOCUMENT_DELIVERY=DEFERRED
J3_CUSTOMER_JOURNEY_FULL=INCOMPLETE
J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA
GAP_03_DISPOSITION=J7_PRODUCTION_GATE_P0
J3_PRODUCTION_ROLLOUT=NOT_AUTHORIZED
J3_FINAL_STATUS=READY_TO_CLOSE_RESCOPED
```

El cierre formal de J3 lo aprueba el owner al revisar este informe.
