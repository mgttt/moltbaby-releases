# Makefile for ndtsdb-cli
# 正式构建: make cosmo-docker → ndtsdb-cli.com (APE 跨平台, podman + cosmocc)

# 版本号优先级: 1) 传入的 VERSION 参数 2) ../ndtsdb-lib/VERSION 3) ../ndtsdb/VERSION (向后兼容) 4) 默认值
VERSION := $(if $(VERSION),$(VERSION),$(shell cat ../ndtsdb-lib/VERSION 2>/dev/null || cat ../ndtsdb/VERSION 2>/dev/null || echo "1.0.0.1"))

# ============================================================================
# 正式构建: Cosmocc (podman 容器, APE 跨平台二进制)
# 产物: ndtsdb-cli.com — Linux/macOS/Windows/FreeBSD 通用单文件
# ============================================================================

COSMO_IMAGE  = localhost/cosmocc:latest
COSMO_BINARY = ndtsdb-cli.com

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
	ndtsdb-cli/src/cmd_facts_enhancements.c \
	ndtsdb-cli/src/ndtsdb_lock.c \
	ndtsdb-cli/src/bindings/qjs_ndtsdb.c \
	ndtsdb-lib/native/ndts.c \
	ndtsdb-lib/native/ndtsdb_vec.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/quickjs.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libregexp.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libunicode.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/cutils.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libbf.c

COSMO_FLAGS = \
	-O2 \
	-I./ndtsdb-cli/src/bindings \
	-I./ndtsdb-cli/include \
	-I./ndtsdb-lib/native \
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
	@rm -f *.elf *.dbg
	@echo "  Cleaned: *.elf *.dbg (intermediate files)"

# cosmo-docker-ci: 从 moltbaby 根目录调用（CI 环境专用）
# 用法: make -C ndtsdb-cli cosmo-docker-ci
cosmo-docker-ci:
	@echo "=== Cosmocc APE Build (CI mode) ==="
	@echo "Image : $(COSMO_IMAGE)"
	@echo "Output: ndtsdb-cli/$(COSMO_BINARY)"
	@rm -f ndtsdb-cli/$(COSMO_BINARY)
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
	@rm -f *.elf *.dbg
	@echo "  Cleaned: *.elf *.dbg (intermediate files)"

# cosmo: 从 ndtsdb-cli 目录内挂载 (备用, 需手动调整路径)
cosmo:
	@echo "=== Cosmocc APE Build (local workspace mount) ==="
	@rm -f $(COSMO_BINARY)
	@podman run --rm \
		-v $$(pwd):/workspace \
		-v $$(pwd)/../ndtsdb-lib:/ndtsdb-lib \
		$(COSMO_IMAGE) \
		cosmocc -o $(COSMO_BINARY) \
			src/main.c src/common.c src/cmd_query.c \
			src/cmd_io.c src/cmd_indicators.c src/cmd_sql.c \
			src/cmd_plugin.c src/cmd_embed.c src/cmd_search.c \
			src/cmd_facts.c src/ndtsdb_lock.c \
			src/bindings/qjs_ndtsdb.c \
			/ndtsdb-lib/native/ndts.c /ndtsdb-lib/native/ndtsdb_vec.c \
			vendor/quickjs-2024-01-13/quickjs.c \
			vendor/quickjs-2024-01-13/libregexp.c \
			vendor/quickjs-2024-01-13/libunicode.c \
			vendor/quickjs-2024-01-13/cutils.c \
			vendor/quickjs-2024-01-13/libbf.c \
			-I./src/bindings -I./include -I/ndtsdb-lib/native \
			-I./vendor/quickjs-2024-01-13 \
			-DCONFIG_VERSION=\"2024-01-13\" -D_GNU_SOURCE -DCONFIG_BIGNUM -lm
	@echo "✓ APE binary: $(COSMO_BINARY)  ($$(ls -lh $(COSMO_BINARY) | awk '{print $$5}'))"
	@rm -f *.elf *.dbg
	@echo "  Cleaned: *.elf *.dbg (intermediate files)"

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

# 生成 SQL 引擎 C 头文件（从 src/sql_engine.js → src/sql_engine_js.h）
# 使用 define/endef 避免多行 Python 内联脚本的 Makefile tab 缩进问题
define GEN_SQL_HEADER_PY
import sys
data = open('ndtsdb-cli/src/sql_engine.js', 'rb').read()
lines = ['/* AUTO-GENERATED - do not edit by hand. Run: make gen-sql-header */\n',
         '/* Source: src/sql_engine.js */\n',
         'static const char sql_engine_js[] = {\n']
row = []
for i, b in enumerate(data):
    row.append(f'0x{b:02x}')
    if len(row) == 16:
        lines.append('    ' + ','.join(row) + ',\n')
        row = []
if row:
    lines.append('    ' + ','.join(row) + ',\n')
lines.append('    0x00\n};\n')
lines.append(f'static const size_t sql_engine_js_len = {len(data)};\n')
open('ndtsdb-cli/src/sql_engine_js.h', 'w').writelines(lines)
print(f'OK sql_engine_js.h ({len(data)} bytes -> ndtsdb-cli/src/sql_engine_js.h)')
endef
export GEN_SQL_HEADER_PY

gen-sql-header:
	@echo "=== Generating sql_engine_js.h from src/sql_engine.js ==="
	@python3 -c "$$GEN_SQL_HEADER_PY"

# ============================================================================
# gcc-linux: Native Linux x86-64 ELF build (no podman required)
# 产物: ndtsdb-cli.elf — Linux x86-64 native binary, dynamically linked
# ============================================================================

GCC_SOURCES = \
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
	ndtsdb-cli/src/cmd_facts_enhancements.c \
	ndtsdb-cli/src/ndtsdb_lock.c \
	ndtsdb-cli/src/bindings/qjs_ndtsdb.c \
	ndtsdb-lib/native/ndts.c \
	ndtsdb-lib/native/ndtsdb_vec.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/quickjs.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libregexp.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libunicode.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/cutils.c \
	ndtsdb-cli/vendor/quickjs-2024-01-13/libbf.c

GCC_FLAGS = \
	-O2 \
	-I./ndtsdb-cli/src/bindings \
	-I./ndtsdb-cli/include \
	-I./ndtsdb-lib/native \
	-I./ndtsdb-cli/vendor/quickjs-2024-01-13 \
	'-DCONFIG_VERSION="2024-01-13"' \
	-D_GNU_SOURCE \
	-DCONFIG_BIGNUM \
	-lm

gcc-linux:
	@echo "=== gcc Native Linux Build ==="
	@gcc -O2 $(GCC_SOURCES) $(GCC_FLAGS) -o ndtsdb-cli/ndtsdb-cli.elf
	@chmod +x ndtsdb-cli/ndtsdb-cli.elf
	@ln -sf ndtsdb-cli.elf ndtsdb-cli/ndtsdb-cli
	@echo "✓ Native ELF: ndtsdb-cli/ndtsdb-cli.elf  ($$(ls -lh ndtsdb-cli/ndtsdb-cli.elf | awk '{print $$5}'))"
	@echo "  Symlink updated: ndtsdb-cli/ndtsdb-cli → ndtsdb-cli.elf"

# 清理
clean:
	@rm -rf build/*.o
	@echo "✓ Cleaned build artifacts"

# 帮助
help:
	@echo "ndtsdb-cli Makefile v$(VERSION)"
	@echo ""
	@echo "正式构建 (podman + cosmocc → APE 跨平台):"
	@echo "  make              → make cosmo-docker (默认)"
	@echo "  make cosmo-docker → ndtsdb-cli.com (Linux/macOS/Windows/FreeBSD)"
	@echo "  make cosmo        → 备用: 从 ndtsdb-cli 目录挂载编译"
	@echo "  make install      → 安装 ndtsdb-cli.com 到 ~/.local/bin"
	@echo "  make install PREFIX=/usr/local → 安装到 /usr/local/bin"
	@echo "  make clean        → 清理构建产物"
	@echo "  make gen-sql-header → 从 src/sql_engine.js 重新生成 sql_engine_js.h"
	@echo "  make help         → 显示此帮助"
	@echo ""
	@echo "前提: podman image localhost/cosmocc:latest 已就绪"
	@echo "      如需重建镜像: podman build -f podman/ndtsdb-cli-cosmo/Dockerfile -t cosmocc:latest ."

.PHONY: all cosmo cosmo-docker gcc-linux install uninstall clean help gen-sql-header

# ============================================================================
# [已归档] Legacy 构建目标 (gcc/zig) —— 已禁用，仅作历史参考
# 正式构建请使用: make cosmo-docker
# ============================================================================
# 
# CC      = gcc
# CFLAGS  = -O2 -Wall -I./src/bindings -I./include -I../ndtsdb/native
# ...
# (gcc-build, build-zig, release, lib-static, lib-shared, plugin-example 等)
#
