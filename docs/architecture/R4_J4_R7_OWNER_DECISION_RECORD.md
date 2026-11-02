---
title: R4-J4-R7 — registro de decisiones del owner (G2 y G-sem)
status: REGISTRADO
date: 2026-10-30
state: R4_J4_R7_GSEM_PENDING_HUMAN_ADJUDICATION
versioning_state: R4_SALES_VERSIONING_DECISION_RECORDED
---

# R4-J4-R7 — registro de decisiones del owner

La §1 reproduce el registro del owner sin cambios. La §2 es la lectura operativa que se hizo para ejecutarlo: no es una decisión del owner y él
puede corregirla.

## 1. Decisiones (texto del owner)

**G2:** `R4_J4_R7_G2_APPROVED`

**G-sem:** `G_SEM_INCONCLUSIVE`, pendiente de revisión humana.

### D1 — Revisión humana

Designar al owner de PesasChile como responsable de la adjudicación final.

Preparar un paquete de revisión autocontenido con:

- Los cuatro cierres ratificados.
- Mensaje original del cliente.
- Contexto anterior relevante.
- Primera decisión del modelo.
- Episodio de reconsideración.
- Segunda decisión.
- Resultado durable.
- Respuestas seleccionadas de C03, C09, C10 y C12.
- Evidencia de propuestas comerciales, rechazos J3 y receipts.

No sustituir las trayectorias por resúmenes.

No completar los veredictos automáticamente.

No utilizar un LLM como juez.

### D2 — Sales v9

Se aprueba condicionalmente su adopción.

Sólo habilitarla después de una adjudicación humana favorable y de emitir formalmente `G_SEM_PASS` para el brazo B.

La adopción modifica exclusivamente las instrucciones del agente.

No modificar kernel, protocolo v5, Quote ni Policy Engine.

Conservar los mecanismos comerciales de confirmación J3.

### D3 — Silencio incorrecto

Un cierre ratificado que omita una solicitud real impide declarar satisfactorio el gate.

Registrar el hallazgo sin modificar retrospectivamente las definiciones del pre-registro.

Distinguir las métricas pre-registradas de los hallazgos adicionales de revisión humana.

### D4 — Turn Completion Guard

Conservar la implementación aprobada en G2.

No agregar reglas semánticas deterministas.

No implementar un segundo modelo supervisor.

### D5 — Siguiente desarrollo

Preparar el diseño de R7-3, contemplando:

- Vigencia de solicitudes humanas.
- Seguridad de autorizaciones.
- Protección frente a aprobaciones desactualizadas.
- Persistencia y correlación.
- Dependencias futuras de Owner Collaboration.

No introducir aprobación humana obligatoria para cotizaciones ordinarias.

No iniciar implementación R7-3 hasta cerrar la revisión humana y aprobar su alcance.

### Restricciones

Sin push, merge ni despliegue.

Sin nuevas llamadas a DeepSeek.

Sin modificaciones productivas.

### Estado inmediato

`R4_J4_R7_GSEM_PENDING_HUMAN_ADJUDICATION`

## 2. Lectura operativa

| # | Punto | Lectura aplicada | Por qué |
|---|---|---|---|
| L-1 | D3 frente al pre-registro | Un cierre adjudicado `solicitud desatendida` no suma a M1 ni cambia ninguna métrica: queda como hallazgo adicional y el gate no es satisfactorio. Por pre-registro el brazo queda `G_SEM_INCONCLUSIVE`, no `G_SEM_FAIL` | M1 sólo cuenta C05–C11 y C14, y los 4 cierres están en casos sociales. D3 prohíbe redefinirlo. **Corrige** el `G_SEM_FAIL` que proponía la primera versión del informe G-sem |
| L-2 | Alcance de D3 | Un hallazgo adverso en **cualquiera** de los 4 cierres, también el del brazo A, impide emitir `G_SEM_PASS` para el brazo B | D3 habla del gate, no de un brazo. Es la lectura más conservadora |
| L-3 | D2 frente al empaquetado | La adopción de v9 cambia el **texto** de las instrucciones, pero el repositorio exige además un archivo nuevo y que un perfil sirva esa versión. Se propone un perfil `@9` idéntico al `@8`, sin cambios de política ni de capacidades | Ver `R4_J4_R7_SALES_V9_ADOPTION_PLAN.md` §2. Requiere confirmación del owner |
| L-4 | D2 y R7-3 | «No modificar Policy Engine» se aplica a la adopción de v9, no a R7-3, cuyo diseño agrega una regla pura al engine | Se somete aparte al aprobar el alcance (`R4_J4_R7_3_SCOPE_PROPOSAL.md` §6) |
| L-5 | Reproducciones sin modelo | Las reproducciones del paquete usan un modelo falso y la base local: no son llamadas a DeepSeek ni tocan producción | Respeta las restricciones |

## 3. Entregables

| # | Entregable | Estado |
|---|---|---|
| 1 | Paquete de revisión humana | Listo: `R4_J4_R7_HUMAN_REVIEW_PACKAGE.md`. Veredictos en blanco |
| 2 | Registro de decisiones del owner | Este documento |
| 3 | Plan de adopción condicionada de v9 | Listo: `R4_J4_R7_SALES_V9_ADOPTION_PLAN.md`. Nada implementado |
| 4 | Estado definitivo de G-sem | **Bloqueado por la adjudicación.** No puede emitirse antes de ella. El procedimiento está en `R4_J4_R7_GSEM_REPORT.md` §6 |
| 5 | Propuesta de alcance R7-3 | Lista: `R4_J4_R7_3_SCOPE_PROPOSAL.md`. Nada implementado |

## 4. Decisión de versionado Sales (texto del owner, 2026-10-30)

**Estado:** `OWNER_APPROVED_FOR_LOCAL_COMMIT`

### D1 — Retiro de v9

Se aprueba retirar `sales.v9.agent.json` y `sales-production@9` de la planificación futura.

No reutilizar estos identificadores.

No eliminar ni modificar registros históricos inmutables que pudieran existir.

### D2 — Secuencia de versiones

Se establece:

- v10 = v8 + cláusula comercial Shipping.
- v11 = v10 + instrucciones conversacionales G-sem.
- v12+ = versiones posteriores según roadmap.

La aprobación condicionada anterior de Sales v9 pasa a referirse al bloque conversacional incorporado en v11.

La aprobación de v11 como definición desplegable requiere:

1. Adjudicación humana favorable de G-sem.
2. Resolución del contrato semántico Shipping/Quote en las instrucciones.
3. Validación de la composición completa.
4. Pruebas contractuales.
5. Autorización de activación.

### D3 — PR #28

No fusionar el PR #28 en su estado actual.

Preparar un reemplazo que conserve únicamente los cambios autorizados.

No cerrar el PR hasta que el sustituto esté preparado y verificado.

### D4 — Commit

Se autoriza crear un commit local con:

- `R4_SALES_INSTRUCTIONS_VERSIONING_REVIEW.md`
- `sales-instruction-versioning.test.ts`
- `shipping-promotion.txt`
- Registro de decisiones actualizado.

Verificar que el commit no incluya secretos, archivos temporales ni modificaciones productivas.

### D5 — Verificaciones pendientes

Antes de crear las definiciones finales:

- Consultar qué definiciones Sales están registradas en producción.
- Confirmar si v9 o `@9` existen históricamente.
- Resolver la composición de instrucciones.
- Confirmar compatibilidad con los perfiles autorizados.
- Verificar qué versión del agente continúa ejecutándose en EC2.

### Restricciones

- Sin despliegue.
- Sin nuevas llamadas a DeepSeek.
- Sin modificación de Shipping, Quote o Checkout.
- Sin cambios del kernel.
- Sin creación de perfiles definitivos.
- Sin push ni merge.
- Sin alteración de registros inmutables.

### Estado final esperado

`R4_SALES_VERSIONING_DECISION_RECORDED`

## 5. Lectura operativa de la decisión de versionado

No es una decisión del owner, y puede corregirla.

| # | Punto | Lectura aplicada | Por qué |
|---|---|---|---|
| L-6 | D2 anterior frente a la nueva D2 | Las condiciones se acumulan: el bloque conversacional sigue exigiendo `G_SEM_PASS` para el brazo B, además de las cinco condiciones nuevas | La nueva D2 traslada la aprobación condicionada a v11, no la reemplaza |
| L-7 | Contrato semántico Shipping/Quote | Resolverlo puede exigir cambiar el bloque o la cláusula. Si cambia un texto, deja de ser idéntico a lo evaluado: se actualizan sus hashes por decisión del owner y debe evaluarse de nuevo | La prueba de contrato fija ambos textos byte a byte |
| L-8 | L-3 y el plan de adopción | L-3 y el perfil `@9` de `R4_J4_R7_SALES_V9_ADOPTION_PLAN.md` quedan reemplazados. Esos documentos no se reescriben | D1 retira `@9`; los registros históricos se conservan |
| L-9 | D3 frente a D5 | El reemplazo del PR #28 no está en este commit y no se ha preparado. Su contenido central es v10, y D5 pide verificaciones antes de crear las definiciones finales. El PR sigue abierto, sin fusionar ni modificar | D4 enumera los archivos del commit |
| L-10 | Verificaciones de D5 | Se registran como pendientes. No se accedió a EC2: el estado esperado es registrar la decisión, y ese acceso requiere autorización explícita por tarea | D5 las titula «pendientes» |
| L-11 | Fuera del commit | El informe de despliegue, el de validación y su evidencia, en este worktree, y el `sales.v9.agent.json` local, el informe, la evidencia y el arnés de J5 en `dev/r4-j5-shipping` siguen sin confirmar | D4 no los enumera |
