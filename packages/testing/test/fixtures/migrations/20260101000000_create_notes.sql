-- migrate:up
create table notes (id integer primary key, body text not null);

-- migrate:down
drop table notes;
