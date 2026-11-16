# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# Cinewright render image (M0.2). Every version arrives as a build arg that
# `cinewright-build-image` reads from container/pins.json, .node-version and package.json;
# none is typed here. The image's only process is `render-job`, run with the network off.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG DEBIAN_SNAPSHOT
ARG FFMPEG_VERSION
ARG LIBX264_VERSION
ARG PYTHON_VERSION
ARG FONTS_NOTO_CORE_VERSION
ARG CHROME_HEADLESS_SHELL
ARG PNPM_VERSION
ARG INPUTS_HASH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# System packages come from one Debian snapshot at exact versions. apt checks every package
# against the snapshot's signed indexes, using the base image's own archive keyring.
RUN test -n "$DEBIAN_SNAPSHOT" \
 && keyring="$(sed -n 's/^Signed-By: //p' /etc/apt/sources.list.d/debian.sources | head -n 1)" \
 && test -n "$keyring" \
 && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/%s/%s\nSuites: %s\nComponents: main\nSigned-By: %s\n\n' \
      debian "$DEBIAN_SNAPSHOT" trixie "$keyring" \
      debian-security "$DEBIAN_SNAPSHOT" trixie-security "$keyring" \
      > /etc/apt/sources.list.d/snapshot.sources \
 && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "ffmpeg=$FFMPEG_VERSION" \
      "libx264-164=$LIBX264_VERSION" \
      "python3.13=$PYTHON_VERSION" \
      "fonts-noto-core=$FONTS_NOTO_CORE_VERSION" \
 && rm -rf /var/lib/apt/lists/*

# pnpm at the version in package.json's packageManager.
RUN npm install --global "pnpm@${PNPM_VERSION}" && test "$(pnpm --version)" = "$PNPM_VERSION"

WORKDIR /opt/cinewright/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .node-version ./
COPY container/render-runner/ container/render-runner/
RUN pnpm install --frozen-lockfile --filter "@cinewright/render-runner..." \
 && pnpm --filter @cinewright/render-runner run build \
 && chmod +x container/render-runner/dist/cli.js \
 && ln -s /opt/cinewright/app/container/render-runner/dist/cli.js /usr/local/bin/render-job

# chrome-headless-shell at the pinned build id, and the system libraries it needs
# (installed by apt from the same snapshot).
RUN apt-get update \
 && cd container/render-runner \
 && pnpm exec browsers install "chrome-headless-shell@${CHROME_HEADLESS_SHELL}" \
      --path /opt/chrome-headless-shell --install-deps \
 && rm -rf /var/lib/apt/lists/*

ENV HYPERFRAMES_BROWSER_PATH=/opt/chrome-headless-shell/chrome-headless-shell/linux-${CHROME_HEADLESS_SHELL}/chrome-headless-shell-linux64/chrome-headless-shell \
    HYPERFRAMES_FFMPEG_PATH=/usr/bin/ffmpeg \
    HYPERFRAMES_FFPROBE_PATH=/usr/bin/ffprobe \
    HYPERFRAMES_NO_TELEMETRY=1 \
    HYPERFRAMES_NO_UPDATE_CHECK=1 \
    HYPERFRAMES_NO_PREVIEW_DISCOVERY=1 \
    DO_NOT_TRACK=1

LABEL org.cinewright.inputs-hash=$INPUTS_HASH
ENTRYPOINT ["render-job"]
