# Makefile for ndtsdb-cli
# 正式构建: make cosmo-docker → ndtsdb-cli.com (APE 跨平台, podman + cosmocc)
# 归档: gcc/zig 构建已移至文件底部 Legacy 区

VERSION = 0.2.0

# ============================================================================
# 正式构建: Cosmocc (podman 容器, APE 跨平台二进制)
# 产物: ndtsdb-cli.com — Linux/macOS/Windows/FreeBSD 通用单文件
# ============================================================================

COSMO_IMAGE  = localhost/cosmocc:latest
COSMO_BINARY = ndtsdb-cli.com
COSMO_DOCKER_BINARY = ndtsdb-cli-docker.com

# 所有参与编译的源文件（cmd_serve.c 已禁用，不在列表中）
COSMO_SOURCES = \
	ndtsdb-cli/src/main.c \
	ndtsdb-cli/src/common.c \
	ndtsdb-cli/src/cmd_query.c \
	ndtsdb-cli/src/cmd_io.c \
	ndtsdb-cli/src/cmd_indicators.c \
	ndtsdb-cli/src/cmd_sql.c \
	ndtsdb-cli/src/cmd_plugin.c \
	ndtsdb-cli/src/cmd_embed.c \
	ndtsdb-cli/src/cmd_search.c \
	ndtsdb-cli/src/cmd_facts.c \
	ndtsdb-cli/src/ndtsdb_lock.c \
	ndtsdb-cli/src/bindings/qjs_ndtsdb.c \
	ndtsdb/native/ndts.c \
	ndtsdb/native/ndtsdb_vec.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/quickjs.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libregexp.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libunicode.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/cutils.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libbf.c

COSMO_FLAGS = \
	-O2 \
	-I./ndtsdb-cli/src/bindings \
	-I./ndtsdb-cli/include \
	-I./ndtsdb/native \
	-I./ndtsdb-cli/vendor/quickjs-2024-01-13 \
	-DCONFIG_VERSION=\"2024-01-13\" \
	-D_GNU_SOURCE \
	-DCONFIG_BIGNUM \
	-lm

# 默认目标 = cosmo-docker (正式构建)
all: cosmo-docker

# cosmo-docker: 从 moltbaby 根目录挂载，路径与 COSMO_SOURCES 对齐
# 产物: ndtsdb-cli/ndtsdb-cli.com (APE 跨平台可执行文件)
cosmo-docker:
	@echo "=== Cosmocc APE Build (podman, reproducible) ==="
	@echo "Image : $(COSMO_IMAGE)"
	@echo "Output: ndtsdb-cli/$(COSMO_BINARY)"
	@rm -f $(COSMO_BINARY)
	@podman run --rm \
		-v $$(pwd)/..:/workspace \
		-w /workspace \
		$(COSMO_IMAGE) \
		cosmocc -o ndtsdb-cli/$(COSMO_BINARY) \
			$(COSMO_SOURCES) $(COSMO_FLAGS)
	@echo ""
	@echo "✓ APE binary: ndtsdb-cli/$(COSMO_BINARY)"
	@echo "  Size  : $$(ls -lh $(COSMO_BINARY) | awk '{print $$5}')"
	@echo "  Format: $$(file $(COSMO_BINARY) | cut -d: -f2)"
	@echo "  Runs on: Linux / macOS / Windows / FreeBSD (x86-64)"

cosmo-docker-size: $(COSMO_DOCKER_BINARY)
	@echo "=== APE Binary Info ==="
	@ls -lh $(COSMO_BINARY) $(COSMO_DOCKER_BINARY) 2>/dev/null
	@file $(COSMO_BINARY) 2>/dev/null
	@echo ""
	@./$(COSMO_BINARY) --help 2>&1 | head -5

# cosmo: 从 ndtsdb-cli 目录内挂载 (备用, 需手动调整路径)
cosmo:
	@echo "=== Cosmocc APE Build (local workspace mount) ==="
	@rm -f $(COSMO_BINARY)
	@podman run --rm \
		-v $$(pwd):/workspace \
		-v $$(pwd)/../ndtsdb:/ndtsdb \
		$(COSMO_IMAGE) \
		cosmocc -o $(COSMO_BINARY) \
			src/main.c src/common.c src/cmd_query.c \
			src/cmd_io.c src/cmd_indicators.c src/cmd_sql.c \
			src/cmd_plugin.c src/cmd_embed.c src/cmd_search.c \
			src/cmd_facts.c src/ndtsdb_lock.c \
			src/bindings/qjs_ndtsdb.c \
			/ndtsdb/native/ndts.c /ndtsdb/native/ndtsdb_vec.c \
			vendor/quickjs-2024-01-13/quickjs.c \
			vendor/quickjs-2024-01-13/libregexp.c \
			vendor/quickjs-2024-01-13/libunicode.c \
			vendor/quickjs-2024-01-13/cutils.c \
			vendor/quickjs-2024-01-13/libbf.c \
			-I./src/bindings -I./include -I/ndtsdb/native \
			-I./vendor/quickjs-2024-01-13 \
			-DCONFIG_VERSION=\"2024-01-13\" -D_GNU_SOURCE -DCONFIG_BIGNUM -lm
	@echo "✓ APE binary: $(COSMO_BINARY)  ($$(ls -lh $(COSMO_BINARY) | awk '{print $$5}'))"

# 安装 APE 到 ~/.local/bin（或 PREFIX=/usr/local make install）
PREFIX ?= $(HOME)/.local
BINDIR  = $(PREFIX)/bin

install: $(COSMO_BINARY)
	@mkdir -p $(BINDIR)
	@cp $(COSMO_BINARY) $(BINDIR)/ndtsdb-cli
	@chmod +x $(BINDIR)/ndtsdb-cli
	@echo "✓ Installed: $(BINDIR)/ndtsdb-cli"

uninstall:
	@rm -f $(BINDIR)/ndtsdb-cli
	@echo "✓ Removed: $(BINDIR)/ndtsdb-cli"

# 清理（只清 legacy gcc build 产物，不动 APE）
clean:
	@rm -rf build/*.o
	@echo "✓ Cleaned gcc build artifacts (build/*.o)"
	@echo "  APE binaries (*.com) retained."

# 帮助
help:
	@echo "ndtsdb-cli Makefile"
	@echo ""
	@echo "正式构建 (podman + cosmocc → APE 跨平台):"
	@echo "  make                  → make cosmo-docker  (默认)"
	@echo "  make cosmo-docker     → ndtsdb-cli.com  (Linux/macOS/Windows/FreeBSD)"
	@echo "  make cosmo-docker-size→ 显示 APE 信息"
	@echo "  make cosmo            → 备用: 从 ndtsdb-cli 目录挂载编译"
	@echo "  make install          → 安装 ndtsdb-cli.com 到 ~/.local/bin"
	@echo "  make install PREFIX=/usr/local → 安装到 /usr/local/bin"
	@echo "  make clean            → 清理 gcc build 产物"
	@echo ""
	@echo "Legacy (归档，见文件底部):"
	@echo "  make gcc-build        → gcc 静态链接 ELF (仅当前 Linux, 不跨平台)"
	@echo "  make build-zig        → Zig 构建 (podman)"
	@echo "  make release          → Zig ReleaseFast + strip"
	@echo ""
	@echo "前提: podman image localhost/cosmocc:latest 已就绪"
	@echo "      如需重建镜像: podman build -f Dockerfile.cosmocc -t cosmocc:latest .."

.PHONY: all cosmo cosmo-docker cosmo-docker-size install uninstall clean help \
        gcc-build build-zig release release-size plugin-example lib lib-static lib-shared

# ============================================================================
# Legacy: gcc 静态链接构建（已归档，非正式产物，仅供调试/CI对比）
# 产物: ndtsdb-cli (ELF x86-64, 仅当前 Linux, 不跨平台)
# 正式分发请用: make cosmo-docker
# ============================================================================

CC      = gcc
CFLAGS  = -O2 -Wall -I./src/bindings -I./include -I../ndtsdb/native
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
    LDFLAGS =
else
    LDFLAGS = -static
endif

HAVE_READLINE := $(shell pkg-config --exists readline && echo 1 || echo 0)
ifeq ($(HAVE_READLINE),1)
CFLAGS  += -DHAVE_READLINE $(shell pkg-config --cflags readline)
LDLIBS  += $(shell pkg-config --libs readline) $(shell pkg-config --libs ncurses)
endif

SRC_DIR   = src
BUILD_DIR = build
LIB_DIR   = lib

GCC_SOURCES = \
	$(SRC_DIR)/main.c \
	$(SRC_DIR)/common.c \
	$(SRC_DIR)/bindings/qjs_ndtsdb.c \
	$(SRC_DIR)/ndtsdb_lock.c \
	$(SRC_DIR)/cmd_query.c \
	$(SRC_DIR)/cmd_io.c \
	$(SRC_DIR)/cmd_indicators.c \
	$(SRC_DIR)/cmd_sql.c \
	$(SRC_DIR)/cmd_plugin.c \
	$(SRC_DIR)/cmd_embed.c \
	$(SRC_DIR)/cmd_search.c \
	$(SRC_DIR)/cmd_facts.c

GCC_OBJECTS = \
	$(BUILD_DIR)/main.o \
	$(BUILD_DIR)/common.o \
	$(BUILD_DIR)/qjs_ndtsdb.o \
	$(BUILD_DIR)/ndtsdb_lock.o \
	$(BUILD_DIR)/cmd_query.o \
	$(BUILD_DIR)/cmd_io.o \
	$(BUILD_DIR)/cmd_indicators.o \
	$(BUILD_DIR)/cmd_sql.o \
	$(BUILD_DIR)/cmd_plugin.o \
	$(BUILD_DIR)/cmd_embed.o \
	$(BUILD_DIR)/cmd_search.o \
	$(BUILD_DIR)/cmd_facts.o \
	$(BUILD_DIR)/quickjs.o \
	$(BUILD_DIR)/libregexp.o \
	$(BUILD_DIR)/libunicode.o \
	$(BUILD_DIR)/cutils.o \
	$(BUILD_DIR)/libbf.o

LIBNDTSDB = $(LIB_DIR)/libndtsdb.a

GCC_TARGET = ndtsdb-cli

gcc-build: $(GCC_TARGET)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

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
$(BUILD_DIR)/cmd_plugin.o: $(SRC_DIR)/cmd_plugin.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD_DIR)/cmd_embed.o: $(SRC_DIR)/cmd_embed.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD_DIR)/cmd_search.o: $(SRC_DIR)/cmd_search.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD_DIR)/cmd_facts.o: $(SRC_DIR)/cmd_facts.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

QJS_DIR    = vendor/quickjs-2024-01-13
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

LIB_SOURCES = ../ndtsdb/native/ndts.c ../ndtsdb/native/ndtsdb_vec.c
LIB_OBJECTS = $(BUILD_DIR)/ndts_lib.o $(BUILD_DIR)/ndtsdb_vec_lib.o
LIB_CFLAGS  = -O2 -Wall -fPIC -I./include -I../ndtsdb/native -D_DEFAULT_SOURCE -D_XOPEN_SOURCE=600

lib-static: $(LIBNDTSDB)
$(BUILD_DIR)/ndts_lib.o: ../ndtsdb/native/ndts.c | $(BUILD_DIR)
	$(CC) $(LIB_CFLAGS) -c $< -o $@
$(BUILD_DIR)/ndtsdb_vec_lib.o: ../ndtsdb/native/ndtsdb_vec.c | $(BUILD_DIR)
	$(CC) $(LIB_CFLAGS) -c $< -o $@
$(LIBNDTSDB): $(LIB_OBJECTS) | $(LIB_DIR)/.dir
	ar rcs $@ $^
	@echo "Static library: $@"

lib-shared: $(LIB_DIR)/libndtsdb.so
$(LIB_DIR)/libndtsdb.so: $(LIB_OBJECTS) | $(LIB_DIR)/.dir
	$(CC) -shared -Wl,-soname,libndtsdb.so.0 -o $@.0.4.0 $^ -lm
	ln -sf libndtsdb.so.0.4.0 $@.0
	ln -sf libndtsdb.so.0 $@
	@echo "Shared library: $@"

lib: lib-static lib-shared
	@echo "Built both static and shared libraries"

$(GCC_TARGET): $(GCC_OBJECTS) $(LIBNDTSDB)
	$(CC) $(LDFLAGS) $(GCC_OBJECTS) $(LIBNDTSDB) -lm $(LDLIBS) -o $@
	@echo "⚠  gcc ELF binary: $@ (NOT cross-platform, use make cosmo-docker for distribution)"

$(LIB_DIR)/.dir:
	mkdir -p $(LIB_DIR)
	touch $@

# Legacy: Zig Build
ZIG_IMAGE ?= localhost/ndts-zig-builder

build-zig:
	podman run --rm \
		--entrypoint="" \
		-v $(shell pwd)/..:/work \
		-w /work/ndtsdb-cli \
		$(ZIG_IMAGE) zig build $(ZIG_FLAGS)

DIST_DIR       = dist
RELEASE_BINARY = $(DIST_DIR)/ndtsdb-cli

release: clean
	@echo "=== Legacy Release Build (Zig) ==="
	@zig build -Doptimize=ReleaseFast
	@mkdir -p $(DIST_DIR)
	@cp zig-out/bin/ndtsdb-cli $(RELEASE_BINARY)
	@strip -s $(RELEASE_BINARY)
	@echo "Release binary: $(RELEASE_BINARY)  ($$(ls -lh $(RELEASE_BINARY) | awk '{print $$5}'))"

release-size: $(RELEASE_BINARY)
	@ls -lh $(RELEASE_BINARY)

# Legacy: Plugin Example
PLUGIN_EXAMPLE = examples/my-plugin.so
plugin-example:
	@gcc -shared -fPIC -o $(PLUGIN_EXAMPLE) \
		examples/my-plugin.c \
		-I./include \
		-I./vendor/quickjs-2024-01-13 \
		-I../ndtsdb/native \
		-DNDTSDB_PLUGIN_API_VERSION=1
	@echo "Plugin: $(PLUGIN_EXAMPLE)"
