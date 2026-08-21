# AgentCore Runtime container: Strands graph orchestrator + Claude Code CLI.
FROM public.ecr.aws/docker/library/node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# claude CLI must be on PATH for the planner/reviewer subprocesses.
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV HOME=/root

EXPOSE 8080
# ADOT preload registers a global tracer provider with SigV4 export to
# CloudWatch before the app loads (activated by AGENT_OBSERVABILITY_ENABLED).
CMD ["node", "--require", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "dist/index.js"]
