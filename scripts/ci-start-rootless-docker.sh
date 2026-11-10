#!/usr/bin/env bash
# CI-only rootless Docker host for mandatory, credential-free Compose tests.
# The shared GitHub runner Docker daemon is rootful and intentionally rejected
# by the deployment certificate. Never alter the operator's running daemon.
set -euo pipefail
if [[ $(id -u) -eq 0 ]]; then
  echo "::error::Rootless certification must run as an unprivileged runner user"
  exit 1
fi
if ! command -v dockerd-rootless.sh >/dev/null 2>&1 &&
   [[ ! -x /usr/bin/dockerd-rootless.sh ]] &&
   [[ ! -x /usr/share/docker.io/contrib/dockerd-rootless.sh ]]; then
  # GitHub's runner ships containerd.io and a rootful Docker engine.
  # Ubuntu's docker.io conflicts with that package, so add Docker's official
  # apt repository for the standalone rootless extras instead of replacing
  # the preinstalled Docker engine and CLI.
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$VERSION_CODENAME" |
    sudo tee /etc/apt/sources.list.d/docker-rootless-ci.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    docker-ce-rootless-extras uidmap slirp4netns fuse-overlayfs
fi
if command -v dockerd-rootless.sh >/dev/null 2>&1; then
  runner=$(command -v dockerd-rootless.sh)
elif [[ -x /usr/bin/dockerd-rootless.sh ]]; then
  runner=/usr/bin/dockerd-rootless.sh
else
  runner=/usr/share/docker.io/contrib/dockerd-rootless.sh
fi
name=$(id -un)
for file in /etc/subuid /etc/subgid; do
  if ! grep -q "^$name:" "$file"; then
    echo "::error::Missing subordinate UID/GID allocation for $name in $file"
    exit 1
  fi
done
runtime="/run/user/$(id -u)"
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 700 "$runtime"
export XDG_RUNTIME_DIR="$runtime"
export DOCKER_HOST="unix://$runtime/docker.sock"
# Docker CE's Ubuntu package supplies rootlesskit's AppArmor profile; prefer
# an independent daemon over a privileged nested Docker-in-Docker container.
log="${RUNNER_TEMP:-/tmp}/noveltea-rootless-dockerd.log"
nohup "$runner" > "$log" 2>&1 < /dev/null &
pid=$!
echo "Rootless Docker daemon PID: $pid"
for i in $(seq 1 100); do
  if docker info --format '{{json .SecurityOptions}}' >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    tail -n 100 "$log"
    echo "::error::Rootless Docker daemon exited"
    exit 1
  fi
  sleep 1
done
docker info --format '{{json .SecurityOptions}}' | grep -q 'rootless' || {
  tail -n 100 "$log"
  echo "::error::Rootless Docker was not selected"
  exit 1
}
docker compose version
echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >> "$GITHUB_ENV"
echo "DOCKER_HOST=$DOCKER_HOST" >> "$GITHUB_ENV"
echo "NT_ROOTLESS_DOCKER_SOCKET=$runtime/docker.sock" >> "$GITHUB_ENV"
echo 'Rootless Docker ready; isolated local socket and namespace verified.'
