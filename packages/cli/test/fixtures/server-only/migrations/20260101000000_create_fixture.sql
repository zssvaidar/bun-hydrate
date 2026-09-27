-- migrate:up
create table fixture (id integer primary key);

-- migrate:down
drop table fixture;
