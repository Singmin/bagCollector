#!/bin/sh
# .Id means config digest in graphdriver and manifest digest in containerd.
# Hash portable filesystem layers and runtime config instead of store metadata.
set -eu
image=${1:?set image}
format='os={{.Os}}
architecture={{.Architecture}}
layers={{json .RootFS.Layers}}
user={{json .Config.User}}
env={{if .Config.Env}}{{json .Config.Env}}{{else}}[]{{end}}
cmd={{if .Config.Cmd}}{{json .Config.Cmd}}{{else}}[]{{end}}
entrypoint={{if .Config.Entrypoint}}{{json .Config.Entrypoint}}{{else}}[]{{end}}
workdir={{json .Config.WorkingDir}}
labels={{if .Config.Labels}}{{json .Config.Labels}}{{else}}{}{{end}}
ports={{if .Config.ExposedPorts}}{{json .Config.ExposedPorts}}{{else}}{}{{end}}
volumes={{if .Config.Volumes}}{{json .Config.Volumes}}{{else}}{}{{end}}
stopsignal={{json .Config.StopSignal}}
healthcheck={{if .Config.Healthcheck}}{{json .Config.Healthcheck}}{{else}}null{{end}}'
metadata=$(docker image inspect --format "$format" "$image") || exit 1
digest=$(printf '%s\n' "$metadata" | sha256sum | cut -d' ' -f1)
printf 'sha256:%s\n' "$digest"
