-- migrate:up
create table if not exists account_passwords (
  account_id varchar(36) primary key references accounts (id) on delete cascade,
  hash varchar(255) not null,
  updated_at varchar(32) not null
);

-- migrate:down
drop table if exists account_passwords;
