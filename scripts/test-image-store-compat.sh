#!/bin/bash
# Reproduce graphdriver/config-ID vs containerd/manifest-ID behavior on CI only.
set -euo pipefail
mkdir -p .runtime/image-store-compat
trap 'docker rm -f bagcollect-compat-classic bagcollect-compat-containerd >/dev/null 2>&1 || true' EXIT
for store in classic containerd; do
  if [ "$store" = classic ]; then port=23751; feature=false; else port=23752; feature=true; fi
  docker run -d --privileged --name "bagcollect-compat-$store" \
    -e DOCKER_TLS_CERTDIR= -p "127.0.0.1:$port:2375" \
    docker:29-dind --tls=false --feature "containerd-snapshotter=$feature"
  ready=0
  for attempt in $(seq 1 40); do
    if DOCKER_HOST="tcp://127.0.0.1:$port" docker info >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" != 1 ]; then docker logs "bagcollect-compat-$store"; exit 1; fi
  DOCKER_HOST="tcp://127.0.0.1:$port" docker info --format 'Docker={{.ServerVersion}} driver={{.Driver}}'
done
cat > .runtime/image-store-compat/Dockerfile <<'DOCKERFILE'
FROM busybox:1.37.0
RUN mkdir /check && echo content-matches > /check/payload
ENV CHECK_VALUE=known
LABEL test=portable-identity
USER 1234:1234
WORKDIR /check
EXPOSE 8080
VOLUME /check
STOPSIGNAL SIGTERM
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["test \"$CHECK_VALUE\" = known && grep -q content-matches /check/payload"]
HEALTHCHECK --interval=10s --timeout=2s --retries=3 CMD test -f /check/payload
DOCKERFILE
image=bagcollect-fingerprint:fixture
DOCKER_HOST=tcp://127.0.0.1:23751 docker build -t "$image" .runtime/image-store-compat
for source in 23751 23752; do
  if [ "$source" = 23751 ]; then target=23752; else target=23751; fi
  expected=$(DOCKER_HOST="tcp://127.0.0.1:$source" sh infra/image-fingerprint.sh "$image")
  source_id=$(DOCKER_HOST="tcp://127.0.0.1:$source" docker image inspect --format '{{.Id}}' "$image")
  DOCKER_HOST="tcp://127.0.0.1:$source" docker image save "$image" > .runtime/image-store-compat/fixture.tar
  bundle=.runtime/image-store-compat/bundle-$source
  mkdir -p "$bundle"
  printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$bundle/source-sha"
  printf '%s\n' amd64 > "$bundle/architecture"
  printf '%s %s\n' "$source_id" "$image" > "$bundle/images.ids"
  printf '%s %s\n' "$expected" "$image" > "$bundle/images.fingerprints"
  python3 infra/image-bundle.py pack --archive .runtime/image-store-compat/fixture.tar --bundle "$bundle" --objects .runtime/image-store-compat/objects
  python3 infra/image-bundle.py rebuild --bundle "$bundle" --objects .runtime/image-store-compat/objects --output "$bundle/reconstructed.tar.gz"
  DOCKER_HOST="tcp://127.0.0.1:$target" docker image load --input "$bundle/reconstructed.tar.gz"
  actual=$(DOCKER_HOST="tcp://127.0.0.1:$target" sh infra/image-fingerprint.sh "$image")
  target_id=$(DOCKER_HOST="tcp://127.0.0.1:$target" docker image inspect --format '{{.Id}}' "$image")
  echo "source ID=$source_id target ID=$target_id source content=$expected target content=$actual"
  test "$source_id" != "$target_id"
  test "$expected" = "$actual"
  DOCKER_HOST="tcp://127.0.0.1:$target" docker run --rm "$image"
done
echo 'PASS: identical image content verified in both directions despite differing image IDs'
