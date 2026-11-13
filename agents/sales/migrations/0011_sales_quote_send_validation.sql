-- (F1-COMMERCIAL-POLICY-v3 hardening) The validation a promotional quote passed IMMEDIATELY before each send attempt.
--
-- Additive and nullable: a regular quote's send stays exactly as before (validation is null), older code keeps
-- inserting rows without it, and the append-only trigger of 0007 still forbids any update or delete. One object per
-- attempt: when it was validated, against which preview, and per promotional line the price, the promotion end and
-- the Catalog provenance that backed it. No customer data and no copy of Catalog answers.
alter table sales.quote_v2_sends
  add column validation jsonb check (validation is null or jsonb_typeof(validation) = 'object');
