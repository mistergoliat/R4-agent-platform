# R4-J4-R1 — Requerimiento técnico de identidad para Customer Service

| Campo | Valor |
|---|---|
| Destinatario | Equipo de Customer Service |
| Emisor | R4 (J4 — Customer Profile Integration) |
| Fecha | 2026-10-15 |
| Estado | **Respondida en parte** (2026-10-15). La [auditoría](CS_R4_J4_IDENTITY_AUTHORITY_AUDIT_REPORT.md) dio `INCONCLUSIVE`, y el owner confirmó que "Customer Service" es `pc-users`, que **no** implementa el contrato de resolución y vinculación. Los requisitos CS-01 a CS-12 se mantienen y pasan a aplicar a la autoridad que se designe (recomendada: Customer Identity Authority, [ID-AUTHORITY-DECISION-01](ID-AUTHORITY-DECISION-01_CUSTOMER_IDENTITY_AUTHORITY.md)). D1 sigue BLOCKED |
| Marco | [ADR-039](../adr/ADR-039-customer-identity-and-profile-consumption.md) (propuesta); [especificación del consumidor](R4-J4-R1_CUSTOMER_CONSUMER_SPECIFICATION.md) §4 |

## 1. Por qué se pide

R4 es una plataforma de agentes que atiende a clientes por WhatsApp. Para que el agente de ventas use datos del cliente (contexto e historial de compras, servidos por Customer Profile), R4 necesita que una autoridad responda:

> Este sujeto de canal autenticado (`whatsapp`, `phone_number_id`, `wa_id`), ¿corresponde a un cliente PrestaShop **verificado**? Si es así, ¿cuál, y con qué autorización de acceso?

Hoy ningún componente le da esa respuesta a R4:
- R4 no resuelve identidad.
- Customer Profile no resuelve identidad.
- CRM decide niveles de identidad solo para su propio agente (detalle en §4).

La documentación de CRM nombra a Customer Service como "la única autoridad de creación y vinculación". R4 **no ha auditado** Customer Service y no tiene acceso a su repositorio.

## 2. Lo que R4 ya sabe (de segunda mano)

Todo lo que sigue proviene de CRM (`CRM-Customer-360` en `8298723`), no de Customer Service.

| Observación | Fuente | Etiqueta |
|---|---|---|
| CRM invoca `POST /v1/customers/resolve` con `{ channel, externalId, phoneNumber, email }` | `lib/integrations/customer-service/http-adapter.ts:219-231` | Código consumidor |
| La respuesta documentada es `resolved` + `customerMasterId`, `no_match` o `conflict` + `conflictCode`. **No incluye nivel de verificación, método ni referencia PrestaShop** | `docs/integrations/customer-service-http-contract.md:62-83` (marcado `approved`) | Contrato documentado por el consumidor |
| CRM invoca `POST /v1/customers` (crear) y `POST /v1/customers/{id}/external-identities` (vincular, incluido `provider: prestashop`) con `consent` | `http-adapter.ts`; contrato :87-134 | Código consumidor |
| La autenticación es `x-api-key` | `http-adapter.ts` (`postJson`) | Código consumidor |
| CRM marca `prestashop` como verificado (`is_verified=1`) solo después de que Customer Service responde `completed` o `already_linked` | EXT-CRM `customerIdentityCapabilities.ts:495-520` | Código CRM |

Con esa información, `/v1/customers/resolve` parece una **búsqueda por coincidencia** (acepta teléfono y email) que devuelve un maestro. **No es** una resolución verificada apta para autorizar datos privados. Necesitamos confirmarlo o refutarlo con evidencia de Customer Service.

## 3. Auditoría solicitada

Pedimos responder cada punto con evidencia del repositorio de Customer Service: repositorio, SHA y `archivo:línea`. Si algo solo está documentado, indicarlo así.

| # | Pregunta |
|---|---|
| A1 | ¿Qué capacidades de identidad y vinculación existen (endpoints, operaciones, consumidores autorizados)? ¿Cuáles están desplegadas y en qué versión? |
| A2 | ¿Cuál es el **modelo de verificación real**? ¿Qué evento hace que un vínculo `channel → cliente` o `maestro → prestashop_customer` se considere verificado: OTP, confirmación de email, operador, coincidencia de email más pedido, otro? ¿Se registran el método, el momento y la evidencia? |
| A3 | ¿Puede resolver una identidad de canal **autenticada** (`whatsapp`, `phone_number_id`, `wa_id`) a un cliente **verificado**, sin aceptar teléfono ni email como prueba? |
| A4 | ¿Distingue **coincidencia** (mismo teléfono o email), **vínculo declarado** (el cliente lo afirma) y **vínculo verificado**? ¿Cómo se expone cada uno? |
| A5 | ¿Cómo trata identidades **ambiguas** (varios candidatos) y **conflictos** (evidencia contradictoria)? |
| A6 | **Números reciclados.** ¿Cómo evita que un `wa_id` o teléfono reasignado herede el vínculo de su titular anterior? ¿Caducan los vínculos o se revalidan? |
| A7 | **Revocación.** ¿Se puede revocar un vínculo (por el cliente, un operador o fraude)? ¿Cuánto tarda en reflejarse? ¿Queda auditado? |
| A8 | ¿Existe ya una API apta para R4 (solo lectura, sin PII en la respuesta, con nivel de verificación)? Si no, ¿cuál es el camino para tenerla? |
| A9 | ¿Cómo se relacionan `masterCustomerId` y `prestashop_customer`? ¿Es 1:1, 1:N o N:1? ¿Quién es la fuente de cada relación? R4 **no** los equipara |
| A10 | ¿Cómo se autentica y autoriza a cada consumidor (claves por consumidor, scopes, rotación)? ¿Puede limitarse un consumidor a un canal y a una lista de `phone_number_id`? |
| A11 | ¿Disponibilidad, latencia (p50/p95), límites de tasa y despliegue (host, red, TLS) del servicio? |
| A12 | ¿Qué consentimientos registra y para qué? ¿Existe consentimiento o restricción que impida divulgar historial a un canal? |

## 4. Por qué R4 no usa directamente los niveles de CRM

Hallazgos en EXT-CRM `8298723`, verificados en código:

1. **Vinculación automática sin verificar.** Un `wa_id` nuevo cuyo teléfono normalizado coincide con otra fila se vincula automáticamente al cliente con `isVerified: false` (`lib/brain/native-whatsapp/service.ts:325-336`).
2. **L2 no exige verificación.** L2 se otorga ante cualquier vínculo de canal o evidencia de teléfono convergente, sin comprobar `is_verified` (`lib/domains/customer-identity-verification/evaluate.ts:45-70`).
3. **El recheck de L3 es parcial.** Comprueba `customer_id` y no `is_verified` (`service.ts:80-95`).
4. **Prueba de identidad débil.** La prueba más fuerte para L3 es que el email y la referencia de pedido declarados apunten al mismo `ps_customer`, más un consentimiento detectado por regex. No hay OTP ni confirmación de control del email (`lib/domains/customer-identity/evidence.ts:49-53`; `consentEvidence.ts:17-45`).
5. **Restricciones de arquitectura.** R4 no puede leer tablas de CRM (AGENTS.md), y CRM está en proceso de retiro.

Si Customer Service se apoya hoy en la misma evidencia, los mismos puntos aplican y deben corregirse o declararse explícitamente como el nivel aceptado.

## 5. Requisitos si Customer Service asume la autoridad (DRAFT)

| ID | Requisito |
|---|---|
| CS-01 | **Operación de resolución de solo lectura** (`POST` sin efectos). Entrada en el **cuerpo JSON**: `{ schemaVersion, channel, accountRef, subjectRef, purposes[] }`. **No acepta** teléfono, email ni ids de cliente como entrada. Ningún identificador va en la ruta ni en la query, para que no aparezca en access logs ni en proxies |
| CS-02 | Salida con `status ∈ { verified, not_linked, not_verified, ambiguous, conflicted, not_authorized }`, `resolvedAt` y, solo si `verified`, `customerRef = prestashop_customer:<id>` y un grant (CS-05). **Sin PII.** Sin `masterCustomerId` hacia R4 |
| CS-03 | `verified` exige un vínculo verificado con método y momento registrados, y válido para el sujeto **actual** (A6). Coincidencia de teléfono o email nunca es `verified` |
| CS-04 | Las respuestas de dominio van en 200 con `status`. 400 = validación, 401/403 = credenciales, 429/5xx = disponibilidad. Cuerpo de error `{ error: { code, retryable } }`, sin mensajes libres |
| CS-05 | Si D2 = A: emitir un grant firmado (formato a acordar con Customer Profile) con claims de emisor, cliente (`prestashop_customer:<id>`), audiencia (`customer-profile`), consumidor (`r4-sales`), propósitos, emisión, expiración (≤ 10 min) e identificador único. Opcionalmente, un hash del sujeto de canal **solo para auditoría**: deriva de lo que R4 afirma y CP no puede verificarlo, así que **no es prueba de autenticidad**. Claves publicadas para su verificación (con `kid` y rotación) y custodia de la clave de firma (su compromiso permite fabricar grants). Además, devolver `expiresAt` y `purposes` como campos legibles de la respuesta |
| CS-06 | **Mínimo privilegio por propósito:** solo se incluyen en el grant los propósitos pedidos y permitidos |
| CS-07 | **Consumidor acotado:** el principal `r4-sales` solo puede resolver `channel = whatsapp` y `accountRef` dentro de una allowlist. Debe tener límite de tasa |
| CS-08 | **Auditoría y detección:** cada resolución queda registrada con consumidor, propósito, `status`, `correlationId` (`x-correlation-id` entrante) y un hash del sujeto, sin PII en claro. Alertas ante volúmenes o patrones anómalos del consumidor `r4-sales` (por ejemplo, muchos sujetos distintos por hora). Es la principal mitigación ante un R4 comprometido, que podría pedir resoluciones de `wa_id` arbitrarios (ADR-039 §5) |
| CS-09 | **Revocación:** revocar un vínculo hace que las resoluciones siguientes no devuelvan `verified`. Los grants emitidos expiran por su TTL. Si se requiere revocación inmediata, se aplica D2-B o una lista de revocación (a acordar) |
| CS-10 | Contrato publicado con `schemaVersion` entero, JSON Schema, fixtures para cada `status` y error, y SHA de repositorio. Cambios rompientes = versión nueva |
| CS-11 | Objetivos de servicio declarados (latencia p95 ≤ 1 000 ms sugerida, disponibilidad) y comportamiento ante caídas de sus fuentes (respuesta `5xx` o `503` tipada, nunca un `not_linked` falso) |
| CS-12 | **Identidades sintéticas para integración.** Un entorno de integración con sujetos de canal y clientes sintéticos que cubran cada `status` (incluidos `verified` y `not_authorized`). Mientras R4 no tenga controles de retención (D7), J4-R5 **solo** puede usar datos sintéticos |

## 6. Qué cierra D1

D1 pasa a **ACCEPTED** solo cuando existan:
1. respuestas a A1–A12 con evidencia del repositorio de Customer Service;
2. la aceptación explícita de Customer Service como autoridad de identidad para R4 (o la designación de otro owner);
3. un contrato publicado que cumpla CS-01 a CS-12, o desviaciones aceptadas por el owner de R4.

Si Customer Service no puede dar la garantía, J4 enriquecido se difiere y Sales sigue operando como hoy, con clientes `guest`. **R4 no creará un servicio de identidad propio** en este hito.
