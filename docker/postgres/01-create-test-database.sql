-- Runs once, on the first start of an empty volume.
-- Integration and concurrency tests run against this separate database so a
-- test run never truncates data you are demonstrating in notify_queue.
CREATE DATABASE notify_queue_test;
