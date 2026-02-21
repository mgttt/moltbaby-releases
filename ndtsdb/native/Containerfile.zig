# ============================================================
# Zig 跨平台编译容器
# 用于编译 libndts 到多平台
# ============================================================

FROM docker.io/library/alpine:3.19

# 安装基础工具 + readline/ncurses依赖
RUN apk add --no-cache curl xz readline-dev ncurses-dev

# 下载并安装 Zig
ARG ZIG_VERSION=0.13.0
RUN curl -L "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz" | tar -xJ -C /opt && \
    ln -s /opt/zig-linux-x86_64-${ZIG_VERSION}/zig /usr/local/bin/zig

# 验证安装
RUN zig version

# 工作目录
WORKDIR /src

# 编译脚本
COPY build-in-container.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh

ENTRYPOINT ["/usr/local/bin/build.sh"]
