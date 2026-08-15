#!/usr/bin/env bash
# Deprecated compatibility stub. Database deployment belongs to Nearventure.
printf '%s\n' \
  'ERROR: scripts/atomic-deploy.sh is permanently disabled.' \
  'It exits before reading, copying, or deleting artifacts and never accesses a database.' \
  "Use Nearventure's manifest-validated importer handoff: docs/nearventure-handoff.md" >&2
exit 64
