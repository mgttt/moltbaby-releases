# Makefile for ndtsdb-lib (C 核心库)
# 产物: native/dist/libndts-<os>-<cpu>-<bits>.so  (shared)
#        native/dist/libndts-<os>-<cpu>-<bits>.a   (static)
# 同时供 ndtsdb-bun (FFI) 和 ndtsdb-cli (静态编译) 使用

VERSION := $(shell cat VERSION 2>/dev/null || echo "1.0.0.1")

CC      = gcc
CFLAGS  = -O2 -Wall -fPIC -I./native -D_GNU_SOURCE
SRCS    = native/ndts.c native/ndtsdb_vec.c native/cosine_sim.c
OBJS    = $(SRCS:.c=.o)

# 平台检测
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
  OS  = osx
  EXT = dylib
  LDFLAGS = -dynamiclib
else
  OS  = lnx
  EXT = so
  LDFLAGS = -shared
endif

ifeq ($(UNAME_M),arm64)
  CPU  = arm
  BITS = 64
else ifeq ($(UNAME_M),aarch64)
  CPU  = arm
  BITS = 64
else
  CPU  = x86
  BITS = 64
endif

LIBNAME = libndts-$(OS)-$(CPU)-$(BITS)
DISTDIR = native/dist

all: shared static

shared: $(OBJS)
	@mkdir -p $(DISTDIR)
	$(CC) $(LDFLAGS) -o $(DISTDIR)/$(LIBNAME).$(EXT) $(OBJS) -lm
	@echo "✓ Shared library: $(DISTDIR)/$(LIBNAME).$(EXT)"

static: $(OBJS)
	@mkdir -p $(DISTDIR)
	ar rcs $(DISTDIR)/$(LIBNAME).a $(OBJS)
	@echo "✓ Static library: $(DISTDIR)/$(LIBNAME).a"

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJS)
	@echo "✓ Cleaned object files"

distclean: clean
	rm -f $(DISTDIR)/$(LIBNAME).$(EXT) $(DISTDIR)/$(LIBNAME).a
	@echo "✓ Cleaned dist libraries"

help:
	@echo "ndtsdb-lib Makefile v$(VERSION)"
	@echo ""
	@echo "Targets:"
	@echo "  make          → build shared + static libraries"
	@echo "  make shared   → shared library (.so/.dylib)"
	@echo "  make static   → static library (.a)"
	@echo "  make clean    → remove object files"
	@echo "  make distclean → remove object files + dist libraries"

.PHONY: all shared static clean distclean help
