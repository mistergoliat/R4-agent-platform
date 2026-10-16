# ID-AUTHORITY-DECISION-01 — Autoridad de identidad de clientes de PesasChile

| Campo | Valor |
|---|---|
| Fecha | 2026-10-15 |
| Tipo | Decisión de arquitectura y ownership. **Sin implementación**: sin desarrollo, migraciones ni despliegues |
| Estado | **PROPUESTA.** La §1 registra hechos confirmados por el owner. La selección de la §2 es una recomendación que necesita un owner designado y un contrato aprobado |
| Estado inicial | `CS_IDENTITY_AUTHORITY_INCONCLUSIVE` ([auditoría](CS_R4_J4_IDENTITY_AUTHORITY_AUDIT_REPORT.md)) |
| Consumidor que la motiva | R4 Agent Platform — J4 ([ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md); requisitos CS-01 a CS-12 en [`R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md`](R4-J4-R1_CUSTOMER_SERVICE_IDENTITY_REQUIREMENTS.md)) |
| Alcance | Vinculación, verificación, revocación y resolución de identidades comerciales entre canales y cuentas PrestaShop. **Excluye** Customer Intelligence, RFM, marketing, campañas y capacidades de Sales |

Evidencia:

| Etiqueta | Fuente |
|---|---|
| **OWNER** | Respuestas del owner, 2026-10-15 |
| **SPEC** | Swagger público del portal `https://ms.pesaschile.cl/docs/`. `pc-users` v1.3.2, SHA-256 `ede84612…e8ed4f34` (idéntico al auditado). `pc-jwt-auth` v1.2.0, SHA-256 `21f0ee85…4c2ceeca`. Son lo que los servicios **declaran**; su código no se auditó |
| **CRM-CODE / CRM-DOC** | `CRM-Customer-360` @ `8298723` |
| **AUDIT** | [`CS_R4_J4_IDENTITY_AUTHORITY_AUDIT_REPORT.md`](CS_R4_J4_IDENTITY_AUTHORITY_AUDIT_REPORT.md) |

---

## 1. Decisión formal sobre Customer Service

| Pregunta | Respuesta registrada | Fuente |
|---|---|---|
| ¿Existe el "Customer Service" de la documentación de CRM? | **Sí, como nombre:** es **`pc-users`**, un microservicio interno de PesasChile. Su punto de entrada para clientes es `POST /client-multiplatform`, que unifica clientes en `master_customer` | OWNER |
| ¿Existe el **contrato** que CRM le atribuye (`POST /v1/customers/resolve`, `POST /v1/customers`, `POST /v1/customers/{id}/external-identities`)? | **No.** `pc-users` no publica ninguna de esas rutas, ni resolución de identidad, verificación, vínculos de canal o revocación. El contrato es una especificación del **consumidor** (CRM), probada contra un doble HTTP y sin productor | SPEC; CRM-DOC `docs/ACTIVE_RELEASE.md:52`; AUDIT §2 |
| Repositorio, despliegue y equipo | Despliegue: `https://ms.pesaschile.cl/api/pc-users` (portal `ms.pesaschile.cl/docs`). Equipo: interno de la empresa (OWNER). **Repositorio fuente: no disponible para auditoría** | OWNER; SPEC; AUDIT §1 |
| Autoridad vigente sobre `master_customer` y las identidades externas | **Ninguna formal.** En la práctica hay al menos dos escritores de `master_customer`: CRM (`POST /api/customers` inserta directamente) y `pc-users` (`client-multiplatform`, según el owner). `customer_external_identity` la escribe solo CRM | OWNER; CRM-DOC `CRM_WEBAPP_MICROSERVICE_INTEGRATION_AUDIT.md:22,334`; AUDIT §4 |

**Decisiones registradas (hechos, no recomendaciones):**

- **F1.** El "Customer Service" de CRM **es `pc-users`**.
- **F2.** La **capacidad de resolución, vinculación y verificación de identidades** que describe la documentación de CRM **no existe** en ningún servicio desplegado conocido. Desde esta decisión, ningún diseño (de R4 ni de otro consumidor) debe asumir su existencia.
- **F3.** No hay autoridad formal sobre `master_customer` ni sobre las identidades externas.
- **F4.** La documentación de CRM que presenta a Customer Service como autoridad de vinculación describe una **intención**, no un sistema vigente.

## 2. Autoridad seleccionada (recomendación)

### 2.1 Alternativas

| Alternativa | A favor | En contra | Veredicto |
|---|---|---|---|
| **A. Ampliar `pc-users`** con vínculos y verificación | Ya existe, tiene equipo, publica Swagger, ya escribe clientes en PrestaShop, POS y `master_customer` | Su dominio es usuarios y POS. Su código no se pudo auditar. Usa autenticación Bearer gruesa y no tiene modelo de consumidores. El Swagger declara rutas de PrestaShop **sin seguridad** (AUDIT §5.3, G4, sin verificar). Concentraría en un mismo servicio **crear** clientes y **certificar** a quién pertenecen | **Admisible solo con condiciones** (§2.3) |
| **B. CRM** (ya tiene tablas y niveles L0–L3) | Tiene el único modelo de identidad existente | Está en retiro. Su L2 no exige verificación, vincula automáticamente por teléfono y su prueba más fuerte es conocimiento de email y pedido. AGENTS.md de R4 prohíbe sus tablas | **Descartada** |
| **C. Customer Profile** | Ya es dominio de cliente | Es lectura de hechos y analítica, y rechaza explícitamente resolver identidad (CP-DOC). Mezclar identidad y hechos rompe la separación que exige la autorización individual (D2) | **Descartada** |
| **D. R4** | Termina el canal | Una plataforma de agentes no es autoridad de clientes (ADR-039; AGENTS.md "Customer fuera de Core") | **Descartada** |
| **E. `pc-jwt-auth`** | Ya autentica clientes PrestaShop (`POST /pc-ps-customer-login`, credenciales → JWT) | Autentica sesiones; no guarda vínculos ni estados. Su logout "invalida" emitiendo un token vencido, sin revocación en servidor (SPEC), así que no sirve para emitir grants | **Descartada como autoridad.** Seleccionada como **dependencia de verificación** (§4.3) |
| **F. Servicio dedicado: Customer Identity Authority (CIA)** | Ownership claro. Mínimo privilegio: certifica vínculos, no crea clientes. Auditable desde el inicio. Contrato a medida de CS-01 a CS-12 | Un servicio y un owner nuevos. AGENTS.md pide no agregar infraestructura sin necesidad demostrada | **Recomendada** |

### 2.2 Por qué un servicio dedicado

La necesidad está **demostrada**:
- ningún componente auditable ofrece hoy las garantías (AUDIT §8, G1 a G3);
- el único candidato existente (`pc-users`) no es auditable y tiene un dominio distinto.

Separar *quién crea clientes* (`pc-users`) de *quién certifica a quién pertenece un canal* (CIA) evita que un mismo componente sea juez y parte. También reduce el impacto de un compromiso: la CIA no puede crear ni modificar clientes.

**Recomendación:** la **Customer Identity Authority** es un dominio y servicio independiente.
- Owner: **por designar** (OWNER). Es bloqueante (§6).
- Usa `pc-jwt-auth` para la prueba de control de cuentas PrestaShop.
- No crea ni modifica clientes.

### 2.3 Condiciones si el negocio prefiere ampliar `pc-users` (alternativa A)

1. El repositorio fuente queda disponible y se audita.
2. G4 (rutas de PrestaShop sin seguridad declarada) se verifica y se cierra.
3. La identidad es un módulo separado: credenciales, scopes y auditoría propios, sin acceso a las rutas de alta y modificación de clientes.
4. Cumple el mismo MVP (§4) y el contrato CS-01 a CS-12.
5. Se designa un owner responsable del dominio de identidad dentro del equipo.

## 3. Límites de ownership

| Dominio | Owner | No hace |
|---|---|---|
| Identidad de canal (quién escribe por un canal) | Quien termina el canal: R4 ChannelIngress para sus números; CRM para los suyos | Decidir a qué cliente pertenece |
| **Vínculos canal → cuenta PrestaShop, verificación, revocación, resolución, grants (D2)** | **CIA** (owner por designar) | Crear, modificar o fusionar clientes; leer hechos comerciales |
| Cuentas y datos maestros de cliente (`master_customer`, sincronización entre PrestaShop, POS y otras plataformas) | **`pc-users`, como único escritor**. **Requiere decisión formal** del owner (hoy no hay autoridad, F3) | Certificar titularidad de canales |
| Autenticación de cuentas PrestaShop | PrestaShop / `pc-jwt-auth` | Persistir vínculos |
| Hechos comerciales (compras) | Customer Profile | Resolver identidad |
| Aplicación de la autorización individual | Customer Profile (verifica grants de la CIA) | Emitir grants |

**Evitar autoridad duplicada sobre clientes maestros:**
- La CIA vincula sujetos de canal con `prestashop_customer:<id>`. **No usa ni escribe `master_customer`** (I11 de ADR-039).
- La autoridad sobre `master_customer` debe quedar en un solo escritor: se recomienda `pc-users`. La inserción directa de CRM (`POST /api/customers`) debe retirarse o redirigirse. Es decisión del owner y de CRM, fuera de R4.

## 4. MVP de identidad

### 4.1 Incluido (exclusivamente)

1. Registro de sujetos de canal.
2. Vinculación con clientes PrestaShop.
3. Verificación por prueba de control.
4. Estados `observed`, `declared`, `verified`, `revoked` y `expired`.
5. Revocación y revalidación.
6. Resolución por consumidor, canal y propósito.
7. Auditoría y controles contra acceso horizontal.
8. Punto de extensión para los grants de D2, que **no se congela aquí**.

### 4.2 Modelo de datos propuesto

| Entidad | Campos clave | Restricciones |
|---|---|---|
| `channel_subject` | `id`, `channel`, `account_ref`, `subject_hash` (HMAC con clave propia), `subject_ref_enc` (cifrado; solo para entregar el desafío), `first_seen_at`, `last_seen_at` | Único `(channel, account_ref, subject_hash)` |
| `identity_link` | `id`, `subject_id`, `prestashop_customer_id`, `state`, `method`, `evidence_ref`, `declared_at`, `verified_at`, `revalidate_after`, `revoked_at`, `revoked_by`, `revocation_reason`, `version` | Como máximo **un vínculo `verified` activo por sujeto** (índice único parcial). Un cliente PrestaShop puede tener varios sujetos (varios teléfonos) |
| `identity_link_event` | `id`, `link_id`, `from_state`, `to_state`, `actor` (sistema, cliente, operador o consumidor), `reason`, `at`, `correlation_id` | Append-only |
| `verification_challenge` | `id`, `subject_id`, `method`, `nonce_hash`, `issued_at`, `expires_at` (minutos), `consumed_at`, `attempts`, `initiated_by_consumer` | Un solo uso; intentos acotados |
| `consumer` | `id`, `name`, hashes de credenciales (rotación), `allowed_channels`, `allowed_accounts`, `allowed_purposes`, `rate_limits` | Credenciales por consumidor |
| `resolution_audit` | `id`, `consumer_id`, `purpose`, `subject_hash`, `result_status`, `correlation_id`, `at` | Append-only; sin PII en claro |

**Estados y transiciones:**

- `observed` → el sujeto se vio; no hay vínculo.
- `declared` → el cliente afirma una cuenta, o hay coincidencia (teléfono o email). **No da acceso a datos privados.**
- `verified` → prueba de control completada (§4.3).
- `revoked` → por el cliente, un operador (auditado), la baja o desactivación de la cuenta PrestaShop, o un conflicto.
- `expired` → pasó `revalidate_after` sin revalidar. Una nueva verificación lo devuelve a `verified`.

**Multiplicidad:**
- Un sujeto que reclama una segunda cuenta pasa a `conflicted` en la resolución, hasta que se revoca el vínculo anterior.
- Si una persona tiene varias cuentas PrestaShop, cada sujeto se vincula a una sola. La CIA no fusiona cuentas.

### 4.3 Verificación por prueba de control

**Método principal: `account_login`.** El cliente demuestra a la vez el control del canal y el de la cuenta:

1. Un consumidor (por ejemplo, R4) pide a la CIA un desafío para el sujeto del canal.
2. La CIA genera un **enlace de un solo uso**, corto, ligado al sujeto.
3. El consumidor lo entrega **por ese mismo canal**. Recibirlo prueba el control actual del canal.
4. El cliente abre el enlace en una página de la CIA y se autentica en su cuenta PrestaShop (vía `pc-jwt-auth` `POST /pc-ps-customer-login` o el login de PrestaShop). Esto prueba el control de la cuenta.
5. La CIA liga el desafío consumido con el `id_customer` autenticado y marca el vínculo `verified`, con `method = account_login`.

Reglas:
- **Las credenciales nunca pasan por el chat ni por un agente.** El cliente las escribe solo en la página de la CIA o de PrestaShop. Un agente que pida contraseñas es un defecto de seguridad.
- La coincidencia de teléfono o email, o el conocimiento de email y número de pedido, nunca producen `verified`: como máximo `declared`.
- Alternativa: código de un solo uso al **email registrado en la cuenta PrestaShop** (`email_otp`), mismo enlace con el canal. Queda para después del MVP si se necesita.

### 4.4 Resolución y controles

- **Contrato de resolución: CS-01 a CS-12.**
  - Lectura por sujeto en el cuerpo, con propósitos.
  - `status ∈ verified | not_linked | not_verified | ambiguous | conflicted | not_authorized`.
  - `prestashop_customer:<id>` solo si `verified`.
  - Sin PII.
- **Sin búsquedas ni listados** para consumidores: solo se resuelve un sujeto. No hay endpoints masivos.
- **Por consumidor:** canales, cuentas y propósitos permitidos, límites de tasa y alertas de volumen anómalo (mitigación de un R4 comprometido).
- **Operadores:** consola o acciones de revocación autenticadas y auditadas, con mínimo privilegio.
- **D2:** cuando la CIA, Customer Profile y el owner lo acuerden, la resolución `verified` incluirá el grant. Hasta entonces, el contrato reserva el campo sin congelar su formato.

## 5. Integración con R4

- **Se preservan** ADR-039 y D3: R4 resuelve en cada invocación desde `bindingByTask`, a través de su puerto neutral `CustomerIdentityResolver`. El harness no se acopla a la CIA; solo cambia el adaptador.
- El contrato de la CIA es exactamente el de la especificación del consumidor de R4 §4. CS-01 a CS-12 son sus criterios de aceptación.
- **Nuevo para R4 (decisión futura, no J4-R1B):** para iniciar una verificación, R4 tendría que entregar el enlace del §4.3 por el canal. Sería una **capacidad de escritura gobernada nueva** (pedir el desafío y enviar el mensaje), con instrucciones que prohíban pedir credenciales en el chat. No se diseña aquí.

## 6. Dependencias y secuencia

No se ejecuta nada de esto aquí: es la secuencia propuesta.

| # | Paso | Responsable | Bloquea |
|---|---|---|---|
| 1 | **Designar el owner de la CIA** (o elegir la alternativa A con sus condiciones) | Negocio | Todo lo demás |
| 2 | Formalizar el único escritor de `master_customer` (recomendado: `pc-users`) y el retiro de la inserción directa de CRM | Negocio + CRM + `pc-users` | Ownership limpio |
| 3 | Verificar G4 en `pc-users` (rutas de PrestaShop sin seguridad declarada) | Equipo de `pc-users` | Uso de `pc-users` o `pc-jwt-auth` como dependencia |
| 4 | Aceptar esta decisión como ADR de PesasChile (fuera de R4) | Owner de arquitectura | 5 |
| 5 | Contrato v1 de la CIA (CS-01 a CS-12): JSON Schema, fixtures, versión, entorno sintético (CS-12) | Owner de la CIA | R4 J4-R1B |
| 6 | Acordar D2 (formato del grant, claves, verificación en CP) | CIA + Customer Profile | R4 J4-R2 y J4-R3 |
| 7 | Implementar el MVP (§4): **fuera de esta decisión**, con autorización propia | Owner de la CIA | Datos verificados reales |
| 8 | Migración de vínculos históricos (§7, R4) | Owner de la CIA + CRM | — |

## 7. Riesgos

| # | Riesgo | Tratamiento en el MVP | Residuo |
|---|---|---|---|
| R1 | **Números reciclados** | `revalidate_after` (valor a fijar por el owner; sugerido 180 días). Expiración ante revalidación fallida y revocación por baja o cambio en la cuenta | Ventana hasta la revalidación |
| R2 | **Números compartidos** | Un solo vínculo `verified` por sujeto; una segunda cuenta pasa a `conflicted` hasta revocar | Un hogar que comparte número ve los datos del titular verificado |
| R3 | **Suplantación por conocimiento de email y pedido** | Nunca produce `verified` (§4.3) | — |
| R4 | **Varias cuentas PrestaShop por persona o maestro** | La CIA no usa maestros. Cada sujeto apunta a una sola cuenta; no se fusionan | Duplicados de PrestaShop siguen siendo de `pc-users` y PrestaShop |
| R5 | **Migración de vínculos históricos no verificados** | Los registros de CRM (`customer_external_identity`, incluidos `is_verified = 1` de `prestashop`) se importan **como máximo `declared`**. **Nunca `verified`.** Se verifican de nuevo con §4.3 | Fricción para clientes ya vinculados |
| R6 | **Compromiso de R4 o de sus credenciales** | Consumidor acotado a canal y cuentas; propósitos; límites de tasa; alertas; credenciales separadas; grants ligados al consumidor (D2) | Alto mientras R4 termine el canal (ADR-039 §5) |
| R7 | **Privilegios de lectura transversal** | Sin búsquedas ni listados para consumidores. Operadores con mínimo privilegio y auditoría. La CIA no lee hechos comerciales | Operadores con privilegio, auditados |
| R8 | **Eliminación y retención de evidencia** | Evidencia mínima (hashes, método, marcas de tiempo, ids de desafío; sin credenciales ni contenido de mensajes). Retención definida y eliminación a solicitud del titular, conservando solo el rastro exigible. Revisar con asesoría legal la normativa chilena de datos personales (Ley 19.628 y su reforma, Ley 21.719) | Depende de la política legal |
| R9 | **G4 de `pc-users` confirmado** | Bloquea usarlo como dependencia hasta corregirlo | — |
| R10 | **Recolección de credenciales en el chat** | Prohibido por diseño (§4.3); página propia de la CIA | Phishing que imite la página: dominio propio y mensajes canónicos |

## 8. Criterios de aceptación

**De esta decisión:**
- Owner de la CIA designado por escrito, o alternativa A aceptada con sus condiciones del §2.3.
- Único escritor de `master_customer` formalizado.
- ADR de PesasChile aceptado.

**Del contrato v1 de la CIA:**
- Cumple CS-01 a CS-12, con JSON Schema, fixtures, versión y SHA del repositorio del productor.
- Repositorio auditable.
- Entorno con identidades sintéticas.

**Del MVP, cuando se autorice:**
- `verified` solo con `account_login` (o un método equivalente aprobado).
- Una prueba demuestra que teléfono, email o email más pedido nunca producen `verified`.
- Revocación y expiración efectivas en la siguiente resolución.
- Un sujeto, a lo sumo un vínculo `verified`.
- Historial CRM importado como máximo `declared` (test de migración).
- Resolución rechazada para canales, cuentas o propósitos no permitidos y por encima del límite de tasa.
- Auditoría sin PII en claro.
- Ninguna ruta de consumidor permite búsquedas ni listados.
- Ninguna credencial pasa por un consumidor.

## 9. Recomendación para D1 en R4

```text
D1=BLOCKED   (sin cambio)
D1_PROPOSED_OWNER=Customer Identity Authority (servicio dedicado), owner POR DESIGNAR
D1_FORMAL_FACTS=Customer Service = pc-users; contrato de resolución/vinculación de CRM sin productor; sin autoridad formal sobre master_customer
D1_ACCEPTANCE_REQUIRES=owner designado con compromiso + contrato técnico CS-01..CS-12 aprobado y publicado por el productor
```

D1 **no** se acepta con esta decisión. Para R4:
- **J4-R1B** sigue abierto en su parte de identidad, y **J4-R3** no puede empezar.
- Sales sigue con clientes `guest`.
- **D2** espera a que exista la CIA, o su equivalente, para acordarla con Customer Profile.
- Se preservan ADR-039 y la resolución perezosa.
