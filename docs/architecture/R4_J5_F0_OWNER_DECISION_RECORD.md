---
title: R4-J5 — Registro de decisiones del owner (preparación comercial y F0)
status: recorded
mandate: R4_J5_F0_AUTHORIZED
date: 2026-11-02
base: main 52a58f4
---

# R4-J5 — Registro de decisiones del owner

Decisiones del owner sobre el [informe de preparación comercial](R4_J5_COMMERCIAL_INTEGRATION_READINESS.md).
Prevalecen sobre las recomendaciones del informe.

## 1. Contradicciones C-1 a C-3

| Id | Decisión | Consecuencia |
|---|---|---|
| **C-1 — Descuentos** | La primera compra controlada **no incluye descuentos**. Una representación explícita de descuentos en Quote requiere una decisión posterior | Quote mantiene el modelo vigente: sin campo de descuento ni cart rules. El diseño de descuentos no forma parte de F0 |
| **C-2 — Autoridad del carrito** | **Quote V2 crea idempotentemente el carrito técnico PrestaShop.** Checkout no crea carritos ni recalcula cotizaciones | Confirma ADR-0002 de Checkout (aprobada) y ADR-Q001 de Quote. Los documentos que dicen otra cosa se alinean (§4) |
| **C-3 — Roadmap** | J5 conserva Sales Autonomy. R4-L conserva Checkout y pagos. F0–F8 es el plan transversal de integración y **no reemplaza** la estructura vigente del roadmap | El roadmap no cambia de fases. J5.5 no se usa como identificador |

## 2. Vigencia del enlace de pago

D-07 y OD-06 **siguen abiertos**. No se acepta que la cancelación interna de Checkout garantice por sí sola la
expiración efectiva del enlace Mercado Pago. Se conserva el requisito estricto de 15 minutos. La recomendación del
informe de cerrar OD-06 con el cancel de Checkout **queda rechazada**.

## 3. F0 autorizado

Se autoriza el trabajo documental y contractual de F0, en este orden de prioridad:

1. A7: contrato Quote/Checkout.
2. H3: autorización de compra CIA/Quote/Checkout.
3. OpenAPI Checkout `/v1`.
4. Dependencias del owner e-commerce.
5. Responsables de los servicios.
6. Preparación de F1 y F2.

G0 no se marca aprobado hasta cumplir sus criterios. No se inician despliegues productivos.

## 4. Documentos alineados con C-2 y C-3

| Documento | Cambio |
|---|---|
| `docs/roadmap/R4_DELIVERY_ROADMAP.md` (R4) | Fila Checkout/R4-L: el carrito lo crea Quote V2. Se registra C-3 y la rama `d8a6b94` queda superada |
| `R4_J5_COMMERCIAL_INTEGRATION_READINESS.md` (R4) | Adenda con estas decisiones |
| ADR-Q001 y candidato A7 (Quote) | Registro de C-2 y revisión para F0. En los repositorios privados de cada servicio |
| ADR-0002, PRD v0.1 y OpenAPI `/v1` (Checkout) | Corrección O-18 de §1 como adenda, más la nota de supersesión de la preparación de carrito por Checkout. En el repositorio de Checkout |

## 5. Checkout

- Prioridad: remoto privado y respaldo verificable del historial existente.
- No se publica código comercial ni configuración sensible en un repositorio público sin auditoría.
- No se ejecutan pagos reales.

## 6. R7-4

R7-4 continúa independientemente de Quote. Antes de solicitar su aceptación hay que:

- completar la regresión pendiente;
- verificar la continuidad entre tasks;
- verificar la recuperación tras reinicio;
- verificar que el contexto se preserva dentro del presupuesto;
- verificar la ausencia de duplicados;
- registrar las pruebas omitidas como `NOT_RUN`.

R7-4 no se declara terminado sin evidencia. Las pruebas posteriores de continuidad de cotizaciones pertenecen a la
integración J5/Quote.

## 7. Restricciones vigentes

- Sin despliegue y sin cambios en EC2.
- Sin cambios del kernel por necesidades comerciales.
- Sin pagos reales.
- Sin perfiles productivos nuevos.
- Sin activar `enforce`.
- Sin llamadas a modelos de pago no autorizadas.

## 8. Cierre de R7-4 y transición a J5 (owner, 2026-11-05)

- **R7-4 queda cerrado** para el alcance aprobado, con la validación productiva aceptada. Sólo se modifica por
  defectos materiales. Esto cumple §6.
- **J5 está activo.** La prioridad es cerrar J5-F0 (G0 sigue sin aprobar) y preparar:
  - F1: Quote V2;
  - F2: Catalog con fuente comercial vigente.
- **Despliegues comerciales:** ninguno sin autorización específica. Las restricciones de §7 siguen vigentes.
- **DS-1:** es un requisito de Sales, no del kernel. El agente no puede afirmar que registró, reservó, modificó o
  programó una operación sin confirmación de una capacidad que realmente haya ejecutado esa acción.
- **D-7:** se mantiene la política de escritura productiva (`maxWriteActions=0`), que no se aumenta automáticamente.
  La autonomía de las operaciones comerciales se resolverá en una decisión separada.

Detalle: `R4_R7_4_FOLLOWUPS_AND_SALES_BACKLOG.md` §C.
