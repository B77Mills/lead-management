#!/bin/bash
docker-compose run \
  --rm \
  --no-deps \
  --entrypoint yarn \
  manage-commands \
  $@
