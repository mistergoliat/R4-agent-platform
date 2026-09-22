# R4 Agent Platform — Repository Instructions

## Authority

Read before making architectural changes:

1. docs/architecture/R4_AGENTIC_PLATFORM_MOTIVATION_AND_CONSTRAINTS.md
2. docs/architecture/R4_AGENTIC_PLATFORM_PRD_AND_ROADMAP.md
3. relevant ADRs

If documents conflict:

Constitution > PRD > ADR > implementation task.

## Repository boundary

This repository is independent from CRM-Customer-360.

Do not:
- import CRM runtime code;
- access CRM internal tables directly;
- depend on Next.js, React, /hub or browser state;
- introduce Sales-specific concepts into R4 Core.

## Core rule

R4 Core may contain generic primitives such as:
Agent, Task, Run, Goal, Artifact, Observation, Capability,
Action, Receipt, Policy, Schedule, Consultation, Approval,
Handoff and Evaluation.

Domain concepts such as Quote, Cart, Opportunity, Campaign,
Product and Payment belong outside Core.

## Engineering

- Prefer explicit typed contracts.
- Durable state must survive process restart.
- Model output is untrusted.
- Writes require governed execution.
- Do not store chain-of-thought.
- Do not add infrastructure without demonstrated need.
- Evaluation ships with implementation.
- Do not advance roadmap phases without explicit authorization.
