# LomoAgent — Linux / Docker 版

一个镜像里包含了和 Windows 桌面版相同的组件（不含桌面外壳）：

- **lomod**：照片存储服务，从 `submodules/lomod` 源码编译，自带 exiftool（读取拍摄时间、GPS 等 EXIF）和 ffmpeg（视频）
- **网页端**：基于 Immich 的照片浏览界面，以及把它的请求转给 lomod 的 proxy

部署在一台 Linux 机器上之后，同一局域网里的电脑和手机用这台机器的 IP 就能打开网页看照片，也能用手机把照片传上来。

目前提供 `linux/amd64`（x86_64）镜像。

## 快速开始：一条命令安装

```bash
curl -fsSL https://raw.githubusercontent.com/lomorage/lomoagent/main/docker/install.sh | bash
```

脚本会依次完成：

1. 检查环境（Linux x86_64、所需端口是否空闲）
2. 没装 Docker 就用官方脚本装上
3. 在 `~/lomo` 下生成 `docker-compose.yml` 和 `.env`
4. 拉取镜像并启动
5. 最后打印访问地址：

```
  LomoAgent is running.

  Web app (computer or phone browser):  http://192.168.1.20:3001
  Lomorage mobile app server address:   http://192.168.1.20:8000
  Account:  user: admin   password: open the web app; the first visit asks you to choose it
```

**首次设置密码**：账号默认是 `admin`。第一次用浏览器打开网页时，会先进入设置页面，在那里为 `admin` 设定密码（至少 6 位），之后用这个密码登录网页和 Lomorage App。

- 密码只能设置一次：谁先打开网页谁来设。所以装好后请尽快自己打开一次。
- 设置完成后，再打开网页就是正常的登录页。

**可选设置**：通过环境变量传给脚本，例如把照片放到大硬盘上。如果是无人值守安装，也可以直接指定密码，这样就跳过网页设置：

```bash
curl -fsSL https://raw.githubusercontent.com/lomorage/lomoagent/main/docker/install.sh \
  | LOMO_PHOTOS_DIR=/mnt/disk/photos LOMO_ADMIN_PASSWORD='你的密码' bash
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LOMO_DIR` | `~/lomo` | 安装目录（compose 文件、`.env`） |
| `LOMO_PHOTOS_DIR` | `$LOMO_DIR/photos` | 照片存放位置 |
| `LOMO_DATA_DIR` | `$LOMO_DIR/data` | 数据库、日志、设置 |
| `LOMO_ADMIN_USER` / `LOMO_ADMIN_PASSWORD` | `admin` / 空（第一次打开网页时设置） | 首个账号；填了密码就直接创建，跳过网页设置 |
| `LOMO_IMAGE` | `ghcr.io/lomorage/lomo-photo-viewer:latest` | 要运行的镜像 |
| `TZ` | 本机时区 | 照片日期使用的时区 |
| `LOMO_WEB_PORT` / `LOMO_LOMOD_PORT` / `LOMO_WEBDAV_PORT` | `3001` / `8000` / `8004` | 网页、lomod（Lomorage App 连接）、WebDAV 的端口 |
| `LOMO_SKIP_DOCKER_INSTALL=1` | — | 没装 Docker 时报错退出，不自动安装 |

**端口被占用**（例如这台机器上已经装了原生的 lomod，占着 8000）：脚本会自动换一个空闲端口，并提示换成了哪个，例如 `using 8001 instead`。打印出来的 Lomorage App 服务器地址也会是新端口。网页端不受影响，仍然用 3001。如果是你自己指定的端口被占用，脚本会报错退出，不会擅自更改。

**升级**：再运行一次同样的命令即可。上次的设置（照片目录等）会从 `~/lomo/.env` 里读取，照片、数据和账号都会保留。

**脚本下载地址**：上面的地址在合并到 `main` 分支后才能用。在那之前，可以从 GitHub Release 页面下载 `install.sh`。

## 手动用 Docker Compose 安装

需要 Docker 和 Docker Compose 插件。

```bash
mkdir lomo && cd lomo
curl -fsSLO https://raw.githubusercontent.com/lomorage/lomoagent/main/docker/docker-compose.yml
docker compose up -d
docker compose logs
```

日志里会打印访问地址：

```
[lomo] Web app (browser, phone or computer): http://192.168.1.20:3001
[lomo] Lomorage mobile app server address:   http://192.168.1.20:8000
[lomo] First visit: open the web app and choose the password for the "admin" account.
```

用浏览器打开网页，第一次会让你为 `admin` 设定密码。如果想跳过这一步，可以在**第一次启动之前**，把 `docker-compose.yml` 里的 `LOMO_ADMIN_PASSWORD` 填上。

不用 Compose 的话，等价的命令是：

```bash
docker run -d --name lomo-photo-viewer --restart unless-stopped --network host \
  -e TZ=Asia/Shanghai \
  -v "$PWD/lomo/photos:/photos" -v "$PWD/lomo/data:/data" \
  ghcr.io/lomorage/lomo-photo-viewer:latest
```

## 使用

**看照片**：在同一局域网的电脑或手机浏览器里打开 `http://<机器IP>:3001`，用上面的账号登录。

**用手机传照片**，两种方式任选：

1. **手机浏览器**：打开 `http://<机器IP>:3001` 并登录，然后点上传按钮选择照片。登录后在用户设置里还能打开"手机上传"二维码，用手机扫码直接进入上传页面。
2. **Lomorage App**（iOS / Android）：服务器地址填 `http://<机器IP>:8000`，用同一个账号登录。App 可以在后台自动备份手机相册。

**照片存放位置**：

- 照片在 `./lomo/photos/<用户名>/` 下面
- 原图在 `Photos/master/年/月/日/`，缩略图在 `Photos/preview/`

## 配置

| 项目 | 默认值 | 说明 |
|---|---|---|
| `LOMO_ADMIN_USER` | `admin` | 首个账号的用户名（只在第一次启动时使用） |
| `LOMO_ADMIN_PASSWORD` | 空（第一次打开网页时设置） | 首个账号的密码；填了就在第一次启动时直接创建账号 |
| `TZ` | 镜像内为 UTC，compose 文件里设为 `Asia/Shanghai` | 时区，影响照片按日期分组 |
| `WEB_PORT` | `3001` | 网页端口 |
| `LOMOD_PORT` | `8000` | lomod 端口（Lomorage App 连接这个端口） |
| `WEBDAV_PORT` | `8004` | lomod 的 WebDAV 端口 |
| `LOMOD_ARGS` | 空 | 追加给 lomod 的额外参数 |
| 卷 `/photos` | — | 照片（原图和缩略图）。数据量大，建议放在大硬盘上 |
| 卷 `/data` | — | 数据库、日志（`/data/lomod/var/log/`）、设置 |

**防火墙**：如果机器开了防火墙，需要放行 3001 和 8000 端口，例如：

```bash
sudo ufw allow 3001/tcp
sudo ufw allow 8000/tcp
```

### 为什么默认用 host 网络

`network_mode: host` 让容器直接使用这台机器的网络，好处有三点：

- 手机和电脑用机器本身的 IP 就能访问
- Lomorage App 能在局域网里自动发现服务器（mDNS）
- 网页里显示的访问地址和二维码是机器的真实 IP

host 网络只在 Linux 上可用。

如果必须用端口映射，可以改成：

```yaml
    ports: ["3001:3001", "8000:8000", "8004:8004"]
```

这样基本功能可用，但有两个限制：

- App 无法自动发现服务器，需要手动填地址
- 网页里"手机上传"二维码显示的是容器内部 IP，要手动改成机器的 IP

## 升级与备份

```bash
docker compose pull && docker compose up -d   # 升级
```

**备份**：停掉容器后，备份 `./lomo/photos` 和 `./lomo/data` 两个目录即可。

**沿用已有的 lomod 数据**：

1. 把原来 lomod 的数据目录（`--base`）放到 `./lomo/data/lomod`，照片目录（`--mount-dir`）挂载到 `/photos`
2. 启动后日志会提示 "already has an account"，用原来的账号密码登录即可

## 镜像标签

| 标签 | 内容 |
|---|---|
| `test` | 最新的测试版 |
| `latest` | 最新的正式版 |
| `X.Y.Z` / `X.Y.Z-test.N` | 固定版本 |
| `release-…` | 对应 `release/…` 分支的最新构建 |

镜像由 `.github/workflows/docker.yml` 构建。每次构建都会启动容器，跑一遍登录、上传、缩略图的冒烟测试，通过后才推送。
