-- migrate:up
create table if not exists sessions (
  id_hash varchar(64) primary key,
  user_id varchar(64) not null,
  created_at bigint not null,
  last_seen_at bigint not null,
  expires_at bigint not null,
  user_agent varchar(512),
  ip varchar(64)
);
create index if not exists sessions_user_id on sessions (user_id);

-- migrate:down
drop table if exists sessions;
