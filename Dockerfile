FROM docker.io/cloudflare/sandbox:0.7.0

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI (use -k to skip cert verification during build due to WARP)
RUN curl -fsSLk https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Configure git for bot commits (Scout serves both Innie and Outie)
RUN git config --global user.name "Scout" && \
    git config --global user.email "ascorbic-scout-agent@users.noreply.github.com" && \
    git config --global init.defaultBranch main

# Copy OpenCode plugins (commit-gate enforces commit+push before session ends)
COPY container/.opencode /root/.config/opencode

# Install plugin dependencies
RUN cd /root/.config/opencode/plugin && bun install @opencode-ai/plugin

# Create workspace directory
WORKDIR /home/user/workspace

EXPOSE 4096
EXPOSE 3000