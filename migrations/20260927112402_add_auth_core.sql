-- migrate:up
create table if not exists accounts (
  id varchar(36) primary key,
  email varchar(320) not null unique,
  role varchar(64) not null,
  created_at varchar(32) not null
);

-- migrate:down
drop table if exists accounts;
