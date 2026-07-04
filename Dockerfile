FROM node:20-slim AS build
WORKDIR /app
# git for transitive git deps, openssh-client so npm's git subprocess has ssh
# binary if it ever tries a ssh:// URL (Baileys' libsignal-node dep historically
# resolves via ssh://git@github.com and needs at least ssh + a URL redirect).
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Rewrite any ssh://git@github.com or git@github.com: URL to https://github.com so
# no credentials are needed. Belt and suspenders alongside the lockfile rewrite.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
  && git config --global url."https://github.com/".insteadOf "git@github.com:"
ENV GIT_TERMINAL_PROMPT=0
# Copy lockfile so npm ci is deterministic (avoids re-resolving to ssh URLs).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
  && git config --global url."https://github.com/".insteadOf "git@github.com:"
ENV GIT_TERMINAL_PROMPT=0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
VOLUME /app/auth-state
EXPOSE 8080
CMD ["npm", "start"]
