#!/bin/sh
# Compatibility entry point: production builds have been removed.
set -eu
exec sh "$(dirname "$0")/load-and-deploy.sh"
