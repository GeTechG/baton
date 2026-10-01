#!/usr/bin/env bash
# Web UI login: enter your email at http://localhost:3000, then run this to read the one-time code (no mail is sent).
docker logs --since 10m baton-backend-1 2>&1 | grep -oE 'Verification code for .*' | tail -1
