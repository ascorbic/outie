FROM docker.io/cloudflare/sandbox:0.6.11

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI (use -k to skip cert verification during build due to WARP)
RUN curl -fsSLk https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Create workspace directory
WORKDIR /home/user/workspace

# Expose OpenCode server port
EXPOSE 4096
