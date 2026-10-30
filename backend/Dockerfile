FROM node:22.23.4-slim

WORKDIR /app

# Python is used by collection post-run cleanup scripts. The upgrade pulls Debian
# security fixes (e.g. openssl) newer than the base image tag.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies, then drop npm: the app never calls it at runtime and
# every bundled npm (incl. npm@latest's undici) keeps tripping the image scan.
COPY package*.json ./
RUN npm ci \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy application code and configurations
COPY . .

# Build cleanup dependencies into the image; runtime cleanup does not need
# package-index access or write access to the collection directory. pip is
# removed once the install finishes: with POST_RUN_VENV_ROOT set the runner never
# installs at runtime, and pip's vendored msgpack, setuptools and urllib3 are
# flagged by the image scan.
RUN python3 -m venv /opt/post-run-venvs/control-plane \
    && /opt/post-run-venvs/control-plane/bin/python -m pip install --no-cache-dir --upgrade pip "setuptools>=78.1.1" \
    && /opt/post-run-venvs/control-plane/bin/python -m pip install --no-cache-dir -r "collections/Control Plane/requirements.txt" \
    && /opt/post-run-venvs/control-plane/bin/python -m pip uninstall -y pip \
    && python3 -c "from pathlib import Path; import hashlib; req=Path('collections/Control Plane/requirements.txt'); marker=Path('/opt/post-run-venvs/control-plane/.requirements.sha256'); marker.write_text(hashlib.sha256(req.read_bytes()).hexdigest())"

# Environment defaults
ENV NODE_ENV=production
# dotenv 17+ logs a banner on every config() call
ENV DOTENV_CONFIG_QUIET=true
ENV PORT=4000
ENV COLLECTIONS_DIR=/app/collections
ENV RESULTS_FILE=/app/data/results.json
ENV CONTROL_PLANE_PASSWORD_FILE=/app/data/control-plane-password.json
ENV POST_RUN_VENV_ROOT=/opt/post-run-venvs

EXPOSE 4000

CMD ["node_modules/.bin/tsx", "src/index.ts"]
