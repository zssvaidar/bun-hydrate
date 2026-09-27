-- migrate:up
create table users (
  id varchar(36) primary key,
  name varchar(100) not null,
  email varchar(255) not null unique,
  created_at varchar(32) not null
);

-- migrate:down
drop table users;
