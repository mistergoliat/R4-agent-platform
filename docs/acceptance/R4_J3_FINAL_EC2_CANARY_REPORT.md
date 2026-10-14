# R4-J3 — Canary EC2 final de `sales-production@7` y cierre formal del alcance

## Resumen

| Campo | Valor |
|---|---|
| Fecha | 2026-10-14 |
| Rama de ejecución | `r4-j3e-c-deterministic-commercial-offer` |
| Documentos hermanos | [`R4_J3_FINAL_ACCEPTANCE.md`](R4_J3_FINAL_ACCEPTANCE.md) §15–§16 y [`R4_J3_CUSTOMER_JOURNEY_GAP_REGISTER.md`](R4_J3_CUSTOMER_JOURNEY_GAP_REGISTER.md) |

```text
J3_CANARY_EC2=BLOCKED
J3_REAL_QUOTE_V2_ISSUANCES=0
J3_PRODUCTION_UNCHANGED=NOT_VERIFIED       (esta sesión no ejecutó nada en EC2; su estado no se pudo leer)
J3F_DEFERRED_DOCUMENTED=YES
J3_FINAL_STATUS=CONDITIONAL
```

**Qué pasó.**
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
