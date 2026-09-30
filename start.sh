#!/usr/bin/env bash
set -e
if [ ! -d node_modules ]; then npm install; fi
[ -f .env ] || cp .env.example .env
npm start
