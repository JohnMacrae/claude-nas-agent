FROM node:20-slim

# Install Claude Code and dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Non-root user required for --dangerously-skip-permissions.
# UID 1002 matches host user john so the container can read john's mounted credential files.
RUN useradd -m -u 1002 -s /bin/bash agent

# App
WORKDIR /agent
COPY package*.json ./
RUN npm install --omit=dev
COPY scheduler.js ./
COPY store.js ./
COPY db.js ./
COPY telegram.js ./
COPY freeagent.js ./
COPY maintenance.js ./
COPY docs.js ./
RUN chown -R agent:agent /agent

USER agent

CMD ["node", "scheduler.js"]
