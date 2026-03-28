FROM node:20-slim

# Install Claude Code and dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# App
WORKDIR /agent
COPY package.json ./
COPY scheduler.js ./
COPY telegram.js ./

CMD ["node", "scheduler.js"]
