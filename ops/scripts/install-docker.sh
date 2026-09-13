#!/usr/bin/env bash
# 在 Linux Mint 22.x / Ubuntu 24.04 上安装 Docker Engine + Compose 插件（Docker 官方 apt 源）
# 用法：sudo bash ops/scripts/install-docker.sh [--mirror]
#   --mirror  使用阿里云镜像源（download.docker.com 访问慢时）
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行：sudo bash ops/scripts/install-docker.sh" >&2
  exit 1
fi

MIRROR_HOST="download.docker.com"
if [[ "${1:-}" == "--mirror" ]]; then
  MIRROR_HOST="mirrors.aliyun.com/docker-ce"
fi

# Mint 的 os-release 若无 UBUNTU_CODENAME 则回退 noble（Mint 22.x 基于 Ubuntu 24.04）
# shellcheck disable=SC1091
. /etc/os-release
UBUNTU_CODENAME="${UBUNTU_CODENAME:-noble}"

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://${MIRROR_HOST}/linux/ubuntu/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://${MIRROR_HOST}/linux/ubuntu ${UBUNTU_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

# 当前用户加入 docker 组，免 sudo 使用 docker（注销重新登录后生效，或临时执行 newgrp docker）
if [[ -n "${SUDO_USER:-}" ]]; then
  usermod -aG docker "$SUDO_USER"
  echo "已将 ${SUDO_USER} 加入 docker 组：注销重新登录生效（或临时 newgrp docker）"
fi

docker --version
docker compose version
echo "Docker 安装完成。回到项目根目录执行：cp .env.example .env && docker compose up -d"
