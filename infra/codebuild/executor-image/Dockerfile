# Custom CodeBuild image for the claude-code-executor job (linux/arm64).
# Bakes in everything the buildspec needs so builds skip ~1.5 min of setup:
# node 22, Claude Code CLI, git, python3, AWS CLI v2.
FROM public.ecr.aws/docker/library/node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl unzip python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

RUN npm install -g @anthropic-ai/claude-code && claude --version && aws --version
