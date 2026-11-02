---
title: R4-J4-R7-3 — propuesta de alcance
status: PROPUESTA. Nada implementado
mandate: «R4-J4-R7 — Owner Decision Record», D5
date: 2026-10-30
base: R4_J4_R7_DESIGN.md §5.2–§5.4, R4_J4_R7_TEST_PLAN.md §3.3 y §3.8; código verificado en feat/r4-j4-r7-2-turn-completion-guard
---

# R4-J4-R7-3: propuesta de alcance

## 1. Resumen

**R7-3 hace dos cosas: ninguna espera humana queda abierta sin límite ni sin aviso, y ninguna aprobación se ejecuta sobre una conversación que quien aprobó no vio.**

**Se detiene aquí.** No se inicia hasta que se cierre la revisión humana de G-sem y el owner apruebe este alcance (D5). La §6 lista lo que debe decidir.

Hoy esto sólo afecta a capacidades con `REQUIRE_APPROVAL`, porque las cotizaciones ordinarias no pasan por aprobación y **seguirán sin pasar** (ADR-043). R7-3 no agrega ninguna aprobación a ese camino. Sigue siendo necesario porque G3 no pasa sin él y porque Owner Collaboration (ADR-042) depende de él.

## 2. Alcance por tema de D5

### 2.1 Vigencia de solicitudes humanas

| Solicitud | Hoy | Propuesta |
|---|---|---|
| Consulta | `expiresAt` sólo si el modelo lo pone (`temporal-runtime.ts:332`) | 30 min por defecto (D-2) |
| Aprobación | Siempre `null` (`action-runtime.ts:409`) | 60 min por defecto (D-2); al vencer, `approval_expired` y el agente atiende con todo en contexto |
| Handoff | Siempre `null` (`temporal-runtime.ts:333`) | **Sigue sin vencer** (decisión de producto): atención y aviso |
| Heredadas sin vencimiento | — | Sin backfill; las reporta la verificación de liveness (S47) |

- Reutiliza `human_expiry` (`temporal-runtime.ts:336, 921`). Sin procesos nuevos. Configuración explícita: `R4_TEMPORAL_DEFAULT_CONSULTATION_TTL_MS`, `R4_TEMPORAL_DEFAULT_APPROVAL_TTL_MS`.
- **Avisos deterministas (D-3):** uno por solicitud (`human_request_id`, migración 0012, ya en R7-1) para consultas, aprobaciones y handoffs del agente. No aplican a takeover ni a holds. Son informativos: no cambian estado comercial ni invalidan ofertas (D-4). Fuera de la ventana del canal se cancelan y quedan en atención.

### 2.2 Seguridad de autorizaciones

**Se conserva:** la aprobación es evidencia, nunca un ALLOW por sí sola. El engine exige propuesta, capacidad, versión y hash de argumentos (`engine.ts:66-67`) y vuelve a evaluar la política. La identidad del aprobador es del operador autenticado (ADR-033) y `responseKey` da idempotencia.

**Se agrega:**
- El modelo no puede liberar ni reconfirmar una retención (S73h). Sólo un humano autenticado.
- Transiciones nuevas `approved → rejected/cancelled` sólo mientras la aprobación está retenida y sin comando.

### 2.3 Protección frente a aprobaciones desactualizadas (BLK-AP1)

Approval Horizon Hold, tal como está en el diseño §5.4.3: AH-1 horizonte en la decisión, AH-2 inspección con las entradas posteriores (hoy `approvals.ts` muestra argumentos y estado, no el hilo), AH-3 retención en `authorizeAction`, AH-4 `reconfirm`, AH-5 vencimiento. W3, una escritura en vuelo, sigue sin interrumpirse.

La revisión del diseño contra el código para esta propuesta encontró **dos ajustes**:

| # | Problema | Ajuste propuesto |
|---|---|---|
| A-1 | El diseño define `expectedInputHorizon` como opcional. Si falta, AH-1 registraría como horizonte la última entrada **en el instante de aprobar**, aunque quien aprueba nunca la haya visto. Es exactamente W1, sin detectar | Obligatorio en `approve` y `reconfirm` de una aprobación: si falta, se rechaza. Sigue siendo opcional en el esquema para los demás resultados |
| A-2 | Una aprobación concedida antes de R7-3 y aún sin ejecutar no tiene `inputHorizon` | Fallar cerrado: sin horizonte se trata como no vigente y se retiene. Se agrega una prueba |

El orden se compara por `(received_at, input_id)` bajo el lock de la task, igual que R7-2.

### 2.4 Persistencia y correlación

- **Sin migración:** `inputHorizon` y `reconfirm` van en `temporal_events.data`; `unique(proposal_id)` se respeta porque es la misma fila.
- **Cadena verificable** por consulta, sin estructura nueva: `task → input → human_request → proposal (hash de argumentos, snapshot) → decisión humana (horizonte, responseKey, identidad) → policy_decision → ejecución → receipt`.
- **Atomicidad:** la retención y su evento van en la transacción de `authorizeAction`. Reinicio y lease se prueban (S44, S73e).
- No se guarda razonamiento del modelo ni interpretación del mensaje.

### 2.5 Dependencias futuras de Owner Collaboration (ADR-042, J5-B)

| R7-3 deja listo | R7-3 **no** decide ni construye |
|---|---|
| Vencimiento, horizonte y retención genéricos, aplicables a cualquier decisión humana | Canal privado del responsable ni registro de responsables |
| Decisión ligada a argumentos y conversación vistos | Interpretación de lenguaje natural del responsable |
| Correlación durable de la decisión | `request_consultation` con ruteo frente a un tipo nuevo de solicitud |
| Avisos por solicitud | Aprobación estructurada frente a texto libre |

**Condición para no prejuzgar J5-B:** todo lo de Core usa primitivas genéricas (Approval, Consultation, Handoff) sin conceptos de Sales ni de «operador». La inspección con hilo vive en el pack Sales.

## 3. Fuera de alcance

- **Aprobación humana obligatoria para cotizaciones ordinarias** (D5, ADR-043). Una prueba debe fijarlo: los perfiles `@5` a `@8` no generan ninguna solicitud de aprobación al cotizar.
- Cambios de perfil, Quote, Checkout y protocolo v5; aprobaciones humanas a clientes.
- Clasificadores semánticos, supervisor, segundo modelo (D4). Tampoco autoridad del modelo sobre una retención.
- R7-4 (linaje, predecesor, v10), J5-A, J5-B, R7-5. Tampoco cadena de `WAIT_UNTIL`.
- Cambios al Turn Completion Guard (D4), salvo que la integración destape un defecto, que se reportaría aparte.

## 4. Entrega por partes

| Parte | Contenido | Pruebas | Riesgo |
|---|---|---|---|
| **R7-3a** | TTL y avisos | S40–S47 | Bajo: reutiliza mecanismos existentes |
| **R7-3b** | AH-1 a AH-5, con los ajustes A-1 y A-2 | S73a–S73i, incluida la variante con `quote.create@2` y stand-ins | Mayor: contrato, máquina de estados y regla del engine. Requiere un ADR nuevo |

**Por qué en este orden:** AH-5 depende del TTL de aprobación, y R7-3a es útil por sí sola.

## 5. Gate G3

Sin AH, G3 no pasa (diseño §5.4.3). Exige además:
- S40–S47 y S73a–S73i verdes. Las sondas A-W1 y A-W2 se invierten y pasan.
- Nueva suite de mutaciones de horizonte y vencimiento, más las existentes.
- Regresión completa desde build limpio, en serie, como en G2.
- Revisión independiente del código, con una prueba de lo que el modelo no puede hacer.

**No hacen falta llamadas reales al modelo**: la retención es determinista. Si se quisiera medir cómo responde el modelo tras un rechazo o un vencimiento, sería una autorización aparte.

## 6. Decisiones del owner para aprobar este alcance

| # | Decisión | Recomendación |
|---|---|---|
| 1 | Aprobar el alcance de §2–§5 y el orden R7-3a → R7-3b | Sí |
| 2 | `expectedInputHorizon` obligatorio al aprobar (A-1) | Sí: si es opcional, W1 sigue abierta |
| 3 | AH-3 agrega una regla **pura** al Policy Engine (`approval.horizonCurrent`). D2 sólo prohíbe tocarlo para v9 | Sí: mantiene una sola autoridad y deja la decisión registrada. La alternativa, comprobarlo en `ActionRuntime`, deja una vía de autorización fuera del engine |
| 4 | Un mensaje irrelevante («gracias») también retiene una aprobación y cuesta una reconfirmación humana | Aceptar: es el precio de no clasificar, como fijó G0 |
| 5 | **Pendiente desde G0:** confirmar que producción corre `@2`, sin `REQUIRE_APPROVAL` | No se pudo verificar: la consulta a EC2 no está autorizada. Mientras no cierre G3, ningún perfil con `REQUIRE_APPROVAL` debe usarse con clientes reales |

## 7. Riesgos

| Riesgo | Tratamiento |
|---|---|
| Fricción operativa por retenciones y vencimientos | Hoy es poco frecuente: ninguna cotización ordinaria aprueba. Medir cuando exista J5-B |
| Avisos fuera de la ventana del canal | Se cancelan y quedan en atención. Las plantillas no son parte de R7 |
| Consultas que vencen con el cliente esperando | El agente atiende al vencer, con aviso previo |
| Interacción con el guard: una aprobación abierta hace fallar el cierre (`turn_closure_blocked`) | Comportamiento vigente de R7-2. Cubrirlo en S44 y S73e |
