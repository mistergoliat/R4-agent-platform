-- R4-J1E / ADR-031 — who decided a run step.
-- `model`: one model call (every step before this migration).
-- `platform`: a token-free READ the kernel issued itself to revalidate the
-- evidence of a proposed response before it becomes durable/outbound.
-- Budgets and the model_calls metric count `model` steps only.
alter table agent_run_steps
  add column origin text not null default 'model' check (origin in ('model', 'platform'));
alter table agent_run_steps
  add constraint agent_run_steps_platform_origin_is_read
  check (origin = 'model' or (decision_type = 'read_capability' and input_tokens = 0 and output_tokens = 0));
