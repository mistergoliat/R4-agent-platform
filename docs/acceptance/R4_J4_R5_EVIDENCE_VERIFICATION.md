---
title: R4-J4-R5 — Verificación independiente de la evidencia en el EC2
status: verified — read-only
mandate: R4-J4-R6 Evidence Verification and Contract Acceptance (owner, 2026-10-27), Fase A
date: 2026-10-27
---

# Verificación de la evidencia J4-R5 (EC2, solo lectura)

**Acceso.** Autorizado por el owner el 2026-10-27, estrictamente de solo lectura:
- host `ip-172-31-1-183` vía SSH con la llave del owner;
- comandos: `cat`, `ls`, `sha256sum -c`, `ps`, `ss`, `docker ps`, `pm2 jlist` (solo nombres de variables de
  perfil, modo y rollout, nunca claves);
- `psql` con `default_transaction_read_only = on` sobre el Postgres del canary.

Sin escrituras, reinicios, migraciones ni cambios en producción.

**La evidencia queda en el EC2** (`~/r4-j4-canary`, 0700). Al repositorio solo pasan hashes y hallazgos. No se copió
texto de conversación, ningún código OTP ni ningún secreto. Retención en el host: logs hasta el **2026-11-02** e
informes hasta el **2026-11-25**.

## 1. Integridad

`sha256sum -c evidence.sha256`: **23/23 OK**. `evidence.sha256` =
`9ddc7a6599b31282f1d85bf816ef10caa926072f7ee39f6222638c42a16cf90c`.

| Archivo | sha256 |
|---|---|
| `01-init.json` | `83a45b8ee10050f403bbbf88ff5910a696ce53cda69c5232b9df66c807549af0` |
| `02-gateway.json` | `c6f0c186bece86b3ee8e4c8dd3c688091e21bbbe757398631f89980b8162f77c` |
| `02-rollback-status-after-gateway.json` | `c1c8eb9dbdbc34a381eb67eaa538fcf72158e82e40e61f81c3ab0f366a11e51c` |
| `03-status.json` | `1f1da74fedde76eec1d9068862410d2d47b79ecc29a666635a2f1b60935ebffb` |
| `03-worker.json` | `5c0627192d59374ce0ac477c5aeb44b683b5e25b02abc1ab6c7589185ecf165c` |
| `04-pair-at8.txt` | `cd30a2b6d30fd5031f4cb0aaa7dcd78ca243ab74d3733f9f36b6f812884bf412` |
| `05-cp-outage-context.txt` | `a36f9e7b7b698e443e087fc7349505ab1b0c179221ac2fd6a3ebbe7d70d15f86` |
| `05-cp-outage-fresh.txt` | `470f01324619b0e6759c98474af1641ccd3de619e9117b27e0c128f30c14f2ca` |
| `05-cp-outage.txt` | `8780da409bece4577cfc14507821575f236c64a8a2e99cf3de3d8c6cf7a1974e` |
| `06-otp-leakscan-db.json` | `bc4126f91e37a6fe94574084a4db014da3a7cb2f3d60ad51139702921842a51b` |
| `06-otp-leakscan-files.txt` | `fef5480861e2dbc786807af778287b98ac9644345b80647e76035d1bc820a0c6` |
| `07-dispatcher-recovery.txt` | `4da80667a3c64582cca29268f226c184760da64c945ab729941a67b46bba146c` |
| `08-concurrent-gateways.txt` | `134c5de566ad34115132d1f3f81acbe348a56ae5b0932f2cd2a02d04c4548363` |
| `08-second-gateway.txt` | `58e8009a24267b4711071c44275174239783fad71e7c8b01b0dc22400dac438a` |
| `09-pair-at7.txt` | `83a775a9e1eaba9133847f5c064c3a3b1b30d68b8e0769e5fe5298fc68372a32` |
| `10-protect-only-withheld.txt` | `c07db16e0cfaf6b1288d257ca646f730a614cd7e87ce4422eec5079d98336498` |
| `10-rollback-1.txt` | `d6fcb0d83b9117669ff0df5d85e3567cc0b4b690b9f0a7bfb62dc8b8c2de730f` |
| `10-rollback-2.txt` | `97f023377e3838a664a9bdf52de4d3991abc9cde53df35961be62107a2552a33` |
| `11-purge-cia.txt` | `dc20a194257ff38fec87b8636abdcaaf3428dc5077bb862ced2565ba0f593e64` |
| `11-purge.json` | `59da4900c28da16970b69940fd1f727ff3e09baac0c4bcdaf1cdce6418cbe3b9` |
| `capture/outbound.jsonl` | `7a953c0c99fa9ddbfca251bf81f0432d403aab0d5be6c9fe2439040f6967bdd4` |
| `p0-failure-chain.txt` | `243219286e8e22b00e319f1b06feeedfdcbd856d0bd18679663fb2183ab344c7` |
| `p0-replay-shapes.jsonl` | `688947b6a904bfd5dedf079874768407fd03134b7beed1767a76346bcabb49d7` |
| `logs/cp.log` | `3bf769e4e9b585998a47fde93a7ff35b8b5fa9cf873110adbe25883853386513` |
| `logs/cia.log` | `7f50b641cde7c201429c9c5fe8157c38599e9cac3d045b5bbfd39c0133b05a77` |
| `logs/gateway.log` | `220cb083c0685c5a15a0f06f139549e13446a784c6171dfcdd32afdca43c0c79` |
| `logs/worker.log` | `248ae81c866ddc9d56035f52c204ca3e6172ebefaa04958ad5d1591823d8a275` |

## 2. Resultado por punto

| Punto del mandato | Resultado | Evidencia |
|---|---|---|
| Ejecución integrada CIA + CP | **VERIFIED** | `01-init`: migraciones Core `0001`–`0011`, Sales `0006`–`0009`, identity `0011`–`0014`, `sales@3`–`@8`. `cp.log`: `enforce`, 1 principal, grant `required` con kid `cia-synthetic-j4r5-k1`, fuente `synthetic`, `realDataAccess: false`. `cia.log`: CIA en `127.0.0.1:18787`, 5 cuentas sintéticas |
| Grants y comportamiento 401/403 | **PARTIAL** | `cp.log`: 3 `customer_grant_decision`, las 3 `accepted`; 3 respuestas `200 available` (`purchase_history` ×2, `sales_context` ×1). Un solo `denied`/`missing_credentials` (GET sin credenciales a una ruta no clasificada: sondeo, no tráfico de R4). **No hubo** grant ajeno, grant de un vínculo provisional, 401 ni 403 hacia R4, así que el mapeo de R4 a `unavailable` y `unauthorized` **no se ejerció en el canary desplegado**. Sí está cubierto en local (S7 41/41, interop 23/23) |
| Quote `guest` con CP caído | **NOT EVIDENCED** | `PC-000007` (`04-pair-at8`) se emitió con CP arriba. En las dos caídas de CP (`05-*`) el cliente no pidió cotización. `worker.log`: 1 fallo `handler_error` de `customer.get_context` (F-3). Cubierto solo en local: `tests/integration/sales-profile-v8.test.ts` §A |
| Confidencialidad del OTP | **VERIFIED, con salvedad de método** | `06-otp-leakscan-db`: 0 coincidencias en 301 columnas; `06-otp-leakscan-files`: 0 archivos. Salvedad en §3 |
| Recuperación del dispatcher | **VERIFIED** | `07-dispatcher-recovery`: la respuesta `fa8dba59a17b` queda `pending` y sellada mientras la CIA está caída (intentos 10 → 11 tras reiniciar el gateway). Al volver la CIA: `confirmed/notified/linked`, intento 12, **la misma clave**. Las dos respuestas previas no se tocan |
| Rollback protegido `@8 → @7` | **VERIFIED** | `10-rollback-1`: worker `@8` detenido; gateway en `protect_only` con 3 ventanas abiertas; worker e ingesta `@7` rechazados (`canary_rollback_not_ready`). `10-rollback-2`: ventanas en 0, gateway detenido (`ready: true`), worker `@7`, ingesta `@8` sin gateway rechazada. Sin `FORCE_OFF`. `10-protect-only-withheld`: código en una ventana abierta, 0 coincidencias |
| Ausencia de ejecuciones huérfanas | **VERIFIED, con hallazgo** | `p0-failure-chain` (20:04, después del rollback): ninguna run `running`; tasks `waiting` (5) o `blocked` (2). `11-purge` (antes de la purga): `action_executions` 7 = `action_receipts` 7; `identity_verification.expectations` 3 = `responses` 3, todas `confirmed`; 0 `discarded_outcomes`; 0 `task_terminal_intents`. **Hallazgo EV-2** (§4) |
| Purga y limpieza de procesos | **Purga VERIFIED. Limpieza PARTIAL** | Re-verificado hoy en solo lectura: **0 filas en 45 tablas** de `r4_j4_canary` (fuera de `r4_schema_migrations` y `agent_definitions`) y 0 tablas en `cia_j4_synthetic`. No quedan procesos Node del canary. **El contenedor `r4-j4-canary-postgres` sigue en ejecución** en `127.0.0.1:55435` (EV-1) |
| Aislamiento del `@2` productivo | **VERIFIED** | `pm2`: `r4-channel-gateway` y `r4-sales-worker` con `R4_PROD_POLICY_PROFILE=sales-production@2`, `R4_PROD_ROLLOUT_PERCENT=0`, iniciados el **2026-10-09**; `r4-scheduler` el 2026-10-01; `customer-profile` el 2026-09-16. Ninguno se reinició durante el canary (2026-10-26). `~/R4-agent-platform` en `ef5a354`, árbol limpio. `03-status`: `foreignTraffic` 0/0/0; `11-purge`: `nonCanaryAccounts` 0 |

## 3. Salvedad de `leakscan.mjs` (columnas binarias)

`leakscan.mjs` compara `"columna"::text` con `strpos`. En una columna `bytea`, ese texto es hexadecimal (`\x…`): un
código en claro **no** se detectaría ahí. Por eso las 0 coincidencias **no** prueban por sí solas la ausencia en
esas columnas.

Hay exactamente **3 columnas `bytea`** en el alcance, consultadas hoy en solo lectura:
`identity_verification.responses.code_ciphertext`, `code_iv` y `code_tag`. La ausencia de texto en claro en ellas
se sostiene por otra vía, no por el escaneo:
- **CHECK `secret_only_while_open`** (migración `0011_identity_verification_state.sql:72`): esas columnas son NULL
  salvo en `pending` o `dispatching`, y `sealed_fields_together` exige las cuatro juntas.
- En el escaneo de las 19:00, la única respuesta (18:59:40) ya estaba `notified` (`07-dispatcher-recovery`), así que
  sus columnas selladas eran NULL por restricción.
- Mientras una respuesta está abierta, el código va cifrado con AES-256-GCM, con IV aleatorio y AAD ligado a la
  respuesta (`secret-box.ts`, SEC-S2).

Conclusión: **298 columnas** escaneadas válidamente con 0 coincidencias, y 3 columnas binarias cubiertas por la
restricción y el cifrado, no por el escaneo. Para la repetición del canary, el escaneo debe comparar las columnas
`bytea` en binario (`position(convert_to($1, 'UTF8') in col) > 0`).

## 4. Discrepancias con el informe del PR #25 (erratas)

| # | El informe dice | La evidencia muestra | Efecto |
|---|---|---|---|
| EV-1 | «0 procesos y 0 puertos del canary» (§4, etapa 10) | `11-purge-cia.txt` registra «canary processes still running: 3». Hoy no hay procesos Node, pero **el contenedor `r4-j4-canary-postgres` sigue corriendo** en `127.0.0.1:55435` (vacío) | Limpieza incompleta. Acción del owner u operación: detener y retirar el contenedor (no se hizo: acceso de solo lectura) |
| EV-2 | «Limitación conocida de `@7` observada (`unknown_capability` recuperado)» | Fue la task `01a17994` (**definición v8**), creada antes del rollback, que siguió ejecutándose en el worker `@7` a las 19:58 (runs 9 y 10, v8): las runs heredan `task.agentVersion` (`execution-runtime.ts` `#newRun`). Con el registro de `@7` no existe la capacidad Customer: falla cerrada (`unknown_capability`) y la recuperación sigue | No hubo acceso a datos ni huérfanas, pero el rollback deja tasks `@8` abiertas que continúan con instrucciones v8 y capacidades `@7`. Debe definirse en el protocolo de rollback: cerrar, traspasar o dejar fallar cerrado de forma explícita |
| EV-3 | «El código no aparece en 301 columnas» | 298 columnas escaneadas válidamente más 3 binarias (§3) | Precisión de método; la conclusión se mantiene por la restricción y el cifrado |

## 5. Dictamen

```text
J4_R5_EVIDENCE_INTEGRITY=VERIFIED (23/23 sha256)
J4_R5_REPORT_CONSISTENCY=CONSISTENT_WITH_ERRATA (EV-1, EV-2, EV-3)
J4_R5_DEPLOYED_GAPS=CONFIRMED (grant ajeno/provisional, 401/403 hacia R4, quote guest con CP caído)
PRODUCTION_AT2_ISOLATION=VERIFIED
CANARY_PURGE=VERIFIED (0 filas)   CANARY_CONTAINER_STILL_RUNNING=TRUE
```
