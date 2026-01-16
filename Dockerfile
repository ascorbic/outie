FROM docker.io/cloudflare/sandbox:0.7.0

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI (use -k to skip cert verification during build due to WARP)
RUN curl -fsSLk https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Configure git for bot commits (Scout serves both Innie and Outie)
# Set system-wide so it applies regardless of which user runs git
RUN git config --system user.name "Scout" && \
    git config --system user.email "ascorbic-scout-agent@users.noreply.github.com" && \
    git config --system init.defaultBranch main && \
    git config --system safe.directory '*'

# Copy MCP bridge (bridges OpenCode MCP requests to DO via WebSocket)
COPY container/mcp-bridge /opt/mcp-bridge

# Copy OpenCode config (points MCP to local bridge)
COPY container/.opencode /root/.config/opencode

# Install plugin dependencies (package.json is in plugin dir)
RUN cd /root/.config/opencode/plugin && bun install

# Create workspace directory
WORKDIR /home/user/workspace

# Expose ports:
# - 4096: OpenCode server
# - 3000: Sandbox control plane
# - 8787: MCP bridge HTTP (for OpenCode to connect locally)
# - 8788: MCP bridge WebSocket (for DO to connect)
EXPOSE 4096
EXPOSE 3000
EXPOSE 8787
EXPOSE 8788