# R4-J1D Step 5 — Verdict

**NOT_READY_FOR_R4** — stop condition `DEPLOY_CONFIG_INCORRECT` at preflight (2026-09-30T17:00Z).

- Deployed revision correct: `47875d5fe0f98f17c1d96863f02a5ed7e4195694`, clean tree, fresh build, PM2 online.
- `PRESTASHOP_TIMEZONE` is not set anywhere in the effective environment → Catalog reads PrestaShop
  specific-price windows as UTC instead of `America/Santiago` (Step 2 B7: CONTRADICTED default).
- Health is otherwise clean: live 200, ready 200 `ok`, all four capabilities `ok`, snapshots loaded, no errors.
- Functional smoke (legacy, /v2, gold, contexts, parity, OD-1..3, sellability, performance, cache) was
  **not run**, per the stop condition.

Current production effect: none measured today — Step 2 found no active bounded promotion window and no
future-starting row, so no price differs yet; the first dated promotion would be applied ~3 h off
(UTC vs UTC−3). The v1 (CRM) path does not use the setting.

Required to resume (operator, not this task): add `PRESTASHOP_TIMEZONE=America/Santiago` to the
catalog-service `.env`, restart with `pm2 restart catalog-service --update-env`, then rerun Step 5 from preflight.
