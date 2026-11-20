# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
# Cinewright audio image (M4.0a): TTS and STT only. Every version arrives as a build arg
# that `cinewright-build-image --kind audio` reads from container/audio/pins.json; Python
# packages come from uv.lock and models from models.json, each checked by sha256. Plugin
# code is not baked in: the plugin host mounts each plugin at /plugins/<id> read-only.
# Runs have the network off.
ARG BASE_IMAGE
ARG UV_IMAGE
FROM ${UV_IMAGE} AS uv
FROM ${BASE_IMAGE}

ARG DEBIAN_SNAPSHOT
ARG FFMPEG_VERSION
ARG INPUTS_HASH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# FFmpeg (for decoding) from the render image's Debian snapshot, at its exact version.
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
 && apt-get install -y --no-install-recommends "ffmpeg=$FFMPEG_VERSION" \
 && rm -rf /var/lib/apt/lists/*

# Models, before the Python environment so a lock change does not download them again.
ENV CINEWRIGHT_MODELS=/opt/models
COPY models.json fetch_models.py /opt/cinewright/build/
RUN python /opt/cinewright/build/fetch_models.py /opt/cinewright/build/models.json /opt/models

# The Python environment, exactly as locked.
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1
WORKDIR /opt/cinewright/audio
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY audio_job/ audio_job/
COPY NOTICES.md licenses/ /usr/share/doc/cinewright-audio/
RUN uv sync --frozen --no-dev --no-editable \
 && rm /usr/local/bin/uv

# Offline at run time: every model is local, and nothing may download.
ENV PATH=/opt/venv/bin:$PATH \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HOME=/opt/models/hf \
    TORCH_HOME=/opt/models/torch \
    NLTK_DATA=/opt/models/nltk_data \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DO_NOT_TRACK=1

LABEL org.cinewright.inputs-hash=$INPUTS_HASH
ENTRYPOINT ["audio-job"]
