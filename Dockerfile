FROM docker.io/cloudflare/sandbox:0.6.11

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Create workspace directory
WORKDIR /home/user/workspace

# Expose OpenCode server port
EXPOSE 4096
