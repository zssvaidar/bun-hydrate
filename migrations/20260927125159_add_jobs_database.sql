-- migrate:up
create table if not exists hydrate_jobs (
  id varchar(36) primary key,
  queue varchar(64) not null,
  name varchar(200) not null,
  payload text not null,
  state varchar(16) not null,
  priority smallint not null default 0,
  attempt integer not null default 0,
  max_attempts integer not null,
  run_at bigint not null,
  locked_until bigint,
  locked_by varchar(64),
  idempotency_key varchar(255) unique,
  trace_parent varchar(55),
  last_error text,
  created_at bigint not null,
  finished_at bigint
);
create index if not exists hydrate_jobs_claim on hydrate_jobs (queue, state, run_at);
create index if not exists hydrate_jobs_locked on hydrate_jobs (state, locked_until);

-- migrate:down
drop table if exists hydrate_jobs;
