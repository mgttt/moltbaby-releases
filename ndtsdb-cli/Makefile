# Makefile for ndtsdb-cli
# Phase 1: 静态链接 QuickJS + libndts.a，产出单二进制

VERSION = 0.2.0

CC = gcc
CFLAGS = -O2 -Wall -I./src/bindings -I./include -I../ndtsdb/native

# 跨平台链接选项
# macOS 不支持静态链接，Linux 使用静态链接
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
    LDFLAGS = 
else
    LDFLAGS = -static
endif

# Readline 检测
HAVE_READLINE := $(shell pkg-config --exists readline && echo 1 || echo 0)

ifeq ($(HAVE_READLINE),1)
CFLAGS += -DHAVE_READLINE $(shell pkg-config --cflags readline)
LDLIBS += $(shell pkg-config --libs readline) $(shell pkg-config --libs ncurses)
endif

# 目录
SRC_DIR = src
BUILD_DIR = build
LIB_DIR = lib
INCLUDE_DIR = include

# 源文件
SOURCES = $(SRC_DIR)/main.c \
          $(SRC_DIR)/common.c \
          $(SRC_DIR)/bindings/qjs_ndtsdb.c \
          $(SRC_DIR)/ndtsdb_lock.c \
          $(SRC_DIR)/cmd_query.c \
          $(SRC_DIR)/cmd_io.c \
          $(SRC_DIR)/cmd_indicators.c \
          $(SRC_DIR)/cmd_sql.c \
          $(SRC_DIR)/cmd_serve.c \
          $(SRC_DIR)/cmd_plugin.c \
          $(SRC_DIR)/cmd_embed.c \
          $(SRC_DIR)/cmd_search.c \
          $(SRC_DIR)/cmd_facts.c

OBJECTS = $(BUILD_DIR)/main.o \
          $(BUILD_DIR)/common.o \
          $(BUILD_DIR)/qjs_ndtsdb.o \
          $(BUILD_DIR)/ndtsdb_lock.o \
          $(BUILD_DIR)/cmd_query.o \
          $(BUILD_DIR)/cmd_io.o \
          $(BUILD_DIR)/cmd_indicators.o \
          $(BUILD_DIR)/cmd_sql.o \
          $(BUILD_DIR)/cmd_serve.o \
          $(BUILD_DIR)/cmd_plugin.o \
          $(BUILD_DIR)/cmd_embed.o \
          $(BUILD_DIR)/cmd_search.o \
          $(BUILD_DIR)/cmd_facts.o \
          $(BUILD_DIR)/quickjs.o \
          $(BUILD_DIR)/libregexp.o \
          $(BUILD_DIR)/libunicode.o \
          $(BUILD_DIR)/cutils.o \
          $(BUILD_DIR)/libbf.o

# 库文件
LIBNDTSDB = $(LIB_DIR)/libndtsdb.a

# 目标
TARGET = ndtsdb-cli

# 默认目标
all: $(TARGET)

# 创建构建目录
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# 编译规则
$(BUILD_DIR)/main.o: $(SRC_DIR)/main.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/common.o: $(SRC_DIR)/common.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/qjs_ndtsdb.o: $(SRC_DIR)/bindings/qjs_ndtsdb.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/ndtsdb_lock.o: $(SRC_DIR)/ndtsdb_lock.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_query.o: $(SRC_DIR)/cmd_query.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_io.o: $(SRC_DIR)/cmd_io.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_indicators.o: $(SRC_DIR)/cmd_indicators.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_sql.o: $(SRC_DIR)/cmd_sql.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_serve.o: $(SRC_DIR)/cmd_serve.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_plugin.o: $(SRC_DIR)/cmd_plugin.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_embed.o: $(SRC_DIR)/cmd_embed.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_search.o: $(SRC_DIR)/cmd_search.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR)/cmd_facts.o: $(SRC_DIR)/cmd_facts.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

# QuickJS 源码编译
QJS_DIR = vendor/quickjs-2024-01-13
QJS_CFLAGS = $(CFLAGS) -D_GNU_SOURCE -DCONFIG_VERSION=\"2024-01-13\" -DCONFIG_BIGNUM

$(BUILD_DIR)/quickjs.o: $(QJS_DIR)/quickjs.c | $(BUILD_DIR)
	$(CC) $(QJS_CFLAGS) -c $< -o $@

$(BUILD_DIR)/libregexp.o: $(QJS_DIR)/libregexp.c | $(BUILD_DIR)
	$(CC) $(QJS_CFLAGS) -c $< -o $@

$(BUILD_DIR)/libunicode.o: $(QJS_DIR)/libunicode.c | $(BUILD_DIR)
	$(CC) $(QJS_CFLAGS) -c $< -o $@

$(BUILD_DIR)/cutils.o: $(QJS_DIR)/cutils.c | $(BUILD_DIR)
	$(CC) $(QJS_CFLAGS) -c $< -o $@

$(BUILD_DIR)/libbf.o: $(QJS_DIR)/libbf.c | $(BUILD_DIR)
	$(CC) $(QJS_CFLAGS) -c $< -o $@

# 复制 libndts.a 到 lib/ 目录
$(LIBNDTS):
	cp ../ndtsdb/native/libndts.a $(LIB_DIR)/

# 链接最终二进制（-lm 必须在最后，静态链接顺序敏感）
# 依赖 libndtsdb.a，确保库先构建
$(TARGET): $(OBJECTS) $(LIBNDTSDB)
	$(CC) $(LDFLAGS) $(OBJECTS) $(LIBNDTSDB) -lm $(LDLIBS) -o $@

# 安装目录（支持 PREFIX 覆盖）
PREFIX ?= $(HOME)/.local
BINDIR = $(PREFIX)/bin

# 安装目标
install: $(TARGET)
	@mkdir -p $(BINDIR)
	@cp $(TARGET) $(BINDIR)/
	@echo "Installed $(TARGET) to $(BINDIR)/"
	@echo "Make sure $(BINDIR) is in your PATH"

# 卸载目标
uninstall:
	@rm -f $(BINDIR)/$(TARGET)
	@echo "Removed $(TARGET) from $(BINDIR)/"

# 清理
clean:
	rm -rf $(BUILD_DIR)/*.o $(TARGET)

# 运行测试
test: $(TARGET)
	./$(TARGET) scripts/test.js

# 互操作性测试
interop: $(TARGET)
	@echo '=== 运行互操作性测试 ==='
	@cd tests/interop && bash run-interop-tests.sh

# Zig Build（本地或容器）
ZIG_IMAGE ?= localhost/ndts-zig-builder

build-zig:
	podman run --rm \
		--entrypoint="" \
		-v $(shell pwd)/..:/work \
		-w /work/ndtsdb-cli \
		$(ZIG_IMAGE) zig build $(ZIG_FLAGS)

# Release 构建（zig build + strip）
DIST_DIR = dist
RELEASE_BINARY = $(DIST_DIR)/ndtsdb-cli

release: clean
	@echo "=== Release Build (Zig) ==="
	@echo "1. Running zig build -Doptimize=ReleaseFast..."
	@zig build -Doptimize=ReleaseFast
	@echo "2. Creating dist directory..."
	@mkdir -p $(DIST_DIR)
	@echo "3. Copying binary..."
	@cp zig-out/bin/ndtsdb-cli $(RELEASE_BINARY)
	@echo "4. Stripping binary..."
	@strip -s $(RELEASE_BINARY)
	@echo "5. Done!"
	@echo ""
	@echo "Release binary: $(RELEASE_BINARY)"
	@echo "Size: $$(ls -lh $(RELEASE_BINARY) | awk '{print $$5}')"

release-size: $(RELEASE_BINARY)
	@echo "=== Release Binary Size ==="
	@echo "File: $(RELEASE_BINARY)"
	@echo "Size: $$(ls -lh $(RELEASE_BINARY) | awk '{print $$5}')"
	@echo "Full: $$(ls -lh $(RELEASE_BINARY))"

# Cosmocc 构建（APE 跨平台二进制）
COSMO_IMAGE = localhost/cosmocc:latest
COSMO_BINARY = ndtsdb-cli.com

COSMO_SOURCES = src/main.c \
                src/common.c \
                src/cmd_query.c \
                src/cmd_io.c \
                src/cmd_indicators.c \
                src/cmd_sql.c \
                src/cmd_serve.c \
                src/cmd_plugin.c \
                src/cmd_embed.c \
                src/cmd_search.c \
                src/cmd_facts.c \
                src/ndtsdb_lock.c \
                src/bindings/qjs_ndtsdb.c \
                ../ndtsdb/native/ndts.c \
                ../ndtsdb/native/ndtsdb_vector.c \
                vendor/quickjs-2024-01-13/quickjs.c \
                vendor/quickjs-2024-01-13/libregexp.c \
                vendor/quickjs-2024-01-13/libunicode.c \
                vendor/quickjs-2024-01-13/cutils.c \
                vendor/quickjs-2024-01-13/libbf.c

COSMO_FLAGS = -O2 \
              -I./src/bindings \
              -I./include \
              -I../ndtsdb/native \
              -I./vendor/quickjs-2024-01-13 \
              -DCONFIG_VERSION=\"2024-01-13\" \
              -D_GNU_SOURCE \
              -DCONFIG_BIGNUM \
              -lm

cosmo: clean
	@echo "=== Cosmocc Build (APE) ==="
	@echo "Building portable binary for Linux/macOS/Windows/FreeBSD..."
	@podman run --rm \
		-v $$(pwd):/workspace \
		-v $$(pwd)/../ndtsdb:/ndtsdb \
		$(COSMO_IMAGE) \
		cosmocc -o $(COSMO_BINARY) $(COSMO_SOURCES) $(COSMO_FLAGS)
	@echo "Done!"
	@echo ""
	@echo "APE binary: $(COSMO_BINARY)"
	@echo "Size: $$(ls -lh $(COSMO_BINARY) | awk '{print $$5}')"
	@echo "Format: $$(file $(COSMO_BINARY) | cut -d: -f2)"

cosmo-size: $(COSMO_BINARY)
	@echo "=== APE Binary Info ==="
	@echo "File: $(COSMO_BINARY)"
	@echo "Size: $$(ls -lh $(COSMO_BINARY) | awk '{print $$5}')"
	@echo "Type: $$(file $(COSMO_BINARY))"
	@echo ""
	@echo "Runs on: Linux x86_64, Windows x86_64, macOS x86_64/arm64, FreeBSD x86_64"

# Cosmocc Docker 构建（可复现构建，使用现有 cosmocc 镜像）
COSMO_DOCKER_BINARY = ndtsdb-cli-docker.com

cosmo-docker:
	@echo "=== Cosmocc Docker Build (Reproducible) ==="
	@echo "Using existing cosmocc image..."
	@rm -f $(COSMO_DOCKER_BINARY)
	@podman run --rm \
		-v $$(pwd)/..:/workspace \
		-w /workspace \
		$(COSMO_IMAGE) \
		cosmocc -o ndtsdb-cli/ndtsdb-cli-docker.com \
			ndtsdb-cli/src/main.c ndtsdb-cli/src/common.c ndtsdb-cli/src/cmd_query.c \
			ndtsdb-cli/src/cmd_io.c ndtsdb-cli/src/cmd_indicators.c ndtsdb-cli/src/cmd_sql.c \
			ndtsdb-cli/src/cmd_serve.c ndtsdb-cli/src/cmd_plugin.c \
			ndtsdb-cli/src/cmd_embed.c ndtsdb-cli/src/cmd_search.c \
			ndtsdb-cli/src/cmd_facts.c ndtsdb-cli/src/ndtsdb_lock.c \
			ndtsdb-cli/src/bindings/qjs_ndtsdb.c \
			ndtsdb/native/ndts.c ndtsdb/native/ndtsdb_vector.c \
			ndtsdb-cli/vendor/quickjs-2024-01-13/quickjs.c \
			ndtsdb-cli/vendor/quickjs-2024-01-13/libregexp.c \
			ndtsdb-cli/vendor/quickjs-2024-01-13/libunicode.c \
			ndtsdb-cli/vendor/quickjs-2024-01-13/cutils.c \
			ndtsdb-cli/vendor/quickjs-2024-01-13/libbf.c \
			-I./ndtsdb-cli/src/bindings -I./ndtsdb-cli/include \
			-I./ndtsdb/native -I./ndtsdb-cli/vendor/quickjs-2024-01-13 \
			-DCONFIG_VERSION=\"2024-01-13\" -D_GNU_SOURCE -DCONFIG_BIGNUM -lm
	@echo "Done!"
	@echo ""
	@echo "APE binary: $(COSMO_DOCKER_BINARY)"
	@echo "Size: $$(ls -lh $(COSMO_DOCKER_BINARY) | awk '{print $$5}')"
	@echo "Format: $$(file $(COSMO_DOCKER_BINARY) | cut -d: -f2)"

cosmo-docker-size: $(COSMO_DOCKER_BINARY)
	@echo "=== Docker-built APE Binary Info ==="
	@echo "File: $(COSMO_DOCKER_BINARY)"
	@echo "Size: $$(ls -lh $(COSMO_DOCKER_BINARY) | awk '{print $$5}')"
	@echo "Type: $$(file $(COSMO_DOCKER_BINARY))"
	@echo ""
	@echo "Verification:"
	@echo "  ./$(COSMO_DOCKER_BINARY) --help | head -5"
	@./$(COSMO_DOCKER_BINARY) --help 2>&1 | head -5 || echo "  (help output truncated)"

# 显示帮助
help:
	@echo "ndtsdb-cli Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  all           - 构建完整二进制（gcc）"
	@echo "  install       - 安装到 ~/.local/bin（支持 PREFIX=）"
	@echo "  uninstall     - 从安装目录移除"
	@echo "  build-zig     - 使用 Zig 构建（Podman 容器）"
	@echo "  release       - Zig build + strip，输出到 dist/ndtsdb-cli"
	@echo "  release-size  - 显示 release 二进制大小"
	@echo "  cosmo         - Cosmocc 构建 APE 跨平台二进制"
	@echo "  cosmo-docker  - Cosmocc Docker 构建（可复现）"
	@echo "  cosmo-docker-size - 显示 Docker 构建的 APE 信息"
	@echo "  clean         - 清理构建文件"
	@echo "  test          - 运行测试脚本"
	@echo "  interop       - 运行互操作性测试（CLI ↔ Bun）"
	@echo "  help          - 显示此帮助信息"
	@echo ""
	@echo "用法示例:"
	@echo "  make install              # 安装到 ~/.local/bin"
	@echo "  make install PREFIX=/usr  # 安装到 /usr/bin"
	@echo "  make build-zig"
	@echo "  make build-zig ZIG_FLAGS='-Dtarget=x86_64-linux-musl -Doptimize=ReleaseFast'"
	@echo "  make release              # 构建 release 版本 (~1.2MB)"
	@echo "  make cosmo                # 构建 APE 跨平台版本 (~3MB)"

# ============================================================================
# Plugin Example
# ============================================================================

PLUGIN_EXAMPLE = examples/my-plugin.so

plugin-example:
	@echo "=== Building Plugin Example ==="
	@echo "Compiling my-plugin.c..."
	@gcc -shared -fPIC -o $(PLUGIN_EXAMPLE) \
		examples/my-plugin.c \
		-I./include \
		-I./vendor/quickjs-2024-01-13 \
		-I../ndtsdb/native \
		-DNDTSDB_PLUGIN_API_VERSION=1
	@echo "Done!"
	@echo ""
	@echo "Plugin: $(PLUGIN_EXAMPLE)"
	@echo "Usage: ./ndtsdb-cli script --plugin $(PLUGIN_EXAMPLE)"

# ============================================================================
# Library Targets (libndtsdb)
# ============================================================================

LIB_SOURCES = ../ndtsdb/native/ndts.c ../ndtsdb/native/ndtsdb_vector.c
LIB_OBJECTS = $(BUILD_DIR)/ndts_lib.o $(BUILD_DIR)/ndtsdb_vector_lib.o
LIB_CFLAGS = -O2 -Wall -fPIC -I./include -I../ndtsdb/native -D_DEFAULT_SOURCE -D_XOPEN_SOURCE=600

# 静态库
lib-static: $(LIB_DIR)/libndtsdb.a

$(BUILD_DIR)/ndts_lib.o: ../ndtsdb/native/ndts.c | $(BUILD_DIR)
	$(CC) $(LIB_CFLAGS) -c $< -o $@

$(BUILD_DIR)/ndtsdb_vector_lib.o: ../ndtsdb/native/ndtsdb_vector.c | $(BUILD_DIR)
	$(CC) $(LIB_CFLAGS) -c $< -o $@

$(LIB_DIR)/libndtsdb.a: $(LIB_OBJECTS) | $(LIB_DIR)/.dir
	ar rcs $@ $^
	@echo "Static library: $@"

# 动态库
lib-shared: $(LIB_DIR)/libndtsdb.so

$(LIB_DIR)/libndtsdb.so: $(LIB_OBJECTS) | $(LIB_DIR)/.dir
	$(CC) -shared -Wl,-soname,libndtsdb.so.0 -o $@.0.4.0 $^ -lm
	ln -sf libndtsdb.so.0.4.0 $@.0
	ln -sf libndtsdb.so.0 $@
	@echo "Shared library: $@"

# 同时构建两种库
lib: lib-static lib-shared
	@echo "Built both static and shared libraries"

$(LIB_DIR)/.dir:
	mkdir -p $(LIB_DIR)
	touch $@

.PHONY: all clean test interop help build-zig install uninstall release release-size cosmo cosmo-size cosmo-docker cosmo-docker-size plugin-example lib lib-static lib-shared
