# Makefile for ndtsdb-lib (C 核心库)
#
# 正式构建: make → podman ndts-zig-builder → 所有平台
#   产物: native/dist/libndts-{lnx,osx,win}-{x86,arm}-64.{so,dylib,dll,a}
#
# 同时供 ndtsdb-bun (FFI) 和 ndtsdb-cli (静态编译) 使用

VERSION  := $(shell cat VERSION 2>/dev/null || echo "1.0.0.1")
ZIG_IMAGE = localhost/ndts-zig-builder

DISTDIR = native/dist

# ──────────────────────────────────────────────────────────────────────────────
# 默认目标: 跨平台构建 (podman + zig)
# ──────────────────────────────────────────────────────────────────────────────
all: cross

cross:
	@echo "=== Cross-platform build (podman + zig) ==="
	@echo "Image : $(ZIG_IMAGE)"
	@echo "Output: $(DISTDIR)/"
	@mkdir -p $(DISTDIR)
	@podman run --rm \
		-v $(CURDIR)/native:/src \
		$(ZIG_IMAGE)
	@echo ""
	@echo "✓ Cross-platform build complete:"
	@ls -lh $(DISTDIR)/

# 重建容器镜像 (修改 build-in-container.sh 后执行)
image:
	@echo "=== Building $(ZIG_IMAGE) ==="
	@podman build \
		-f $(CURDIR)/../podman/ndts-zig-builder/Containerfile \
		-t $(ZIG_IMAGE) \
		$(CURDIR)/../podman/ndts-zig-builder/
	@echo "✓ Image built: $(ZIG_IMAGE)"

clean:
	rm -f native/*.o
	@echo "✓ Cleaned object files"

distclean-all:
	rm -f $(DISTDIR)/libndts-*.so $(DISTDIR)/libndts-*.dylib $(DISTDIR)/libndts-*.a
	@echo "✓ Cleaned all dist libraries"

help:
	@echo "ndtsdb-lib Makefile v$(VERSION)"
	@echo ""
	@echo "  make            → cross (podman + zig, all platforms)"
	@echo "  make cross      → 所有平台: lnx-x86-64 lnx-arm-64 osx-x86-64 osx-arm-64 win-x86-64 win-arm-64"
	@echo "  make image      → 重建 $(ZIG_IMAGE) 镜像"
	@echo "  make clean      → 删除 .o 文件"
	@echo "  make distclean-all → 删除所有平台构建产物"
	@echo ""
	@echo "前提: podman image $(ZIG_IMAGE):latest 已就绪"
	@echo "      如需重建镜像: make image"

.PHONY: all cross image clean distclean-all help
