const std = @import("std");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const enable_readline = b.option(bool, "enable-readline", "Enable readline support (default: false)") orelse false;

    // ============================================
    // Shared Library: libndtsdb.so
    // ============================================
    const lib = b.addSharedLibrary(.{
        .name = "ndtsdb",
        .root_source_file = null,
        .target = target,
        .optimize = optimize,
        .version = .{ .major = 0, .minor = 4, .patch = 0 },
    });

    // 库 C 编译标志（不含 QuickJS）
    var lib_flags = std.ArrayList([]const u8).init(b.allocator);
    defer lib_flags.deinit();
    try lib_flags.appendSlice(&.{
        "-O2", "-Wall", "-fPIC",
        "-D_DEFAULT_SOURCE", "-D_XOPEN_SOURCE=600",
        "-DNDTSDB_BUILD_SHARED",
    });
    if (target.result.os.tag == .macos) {
        try lib_flags.appendSlice(&.{"-D_DARWIN_C_SOURCE"});
    }

    // 库源文件（仅核心，无 CLI/QuickJS）
    lib.addCSourceFile(.{ .file = b.path("../ndtsdb/native/ndts.c"), .flags = lib_flags.items });
    lib.addCSourceFile(.{ .file = b.path("../ndtsdb/native/ndtsdb_vec.c"), .flags = lib_flags.items });

    // 库包含路径
    lib.addIncludePath(b.path("include"));
    lib.addIncludePath(b.path("../ndtsdb/native"));

    // 链接库
    lib.linkLibC();
    lib.linkSystemLibrary("m");

    b.installArtifact(lib);

    // ============================================
    // Static Library: libndtsdb.a
    // ============================================
    const lib_static = b.addStaticLibrary(.{
        .name = "ndtsdb",
        .root_source_file = null,
        .target = target,
        .optimize = optimize,
    });

    // 静态库不需要 -fPIC，但保留其他标志
    var static_flags = std.ArrayList([]const u8).init(b.allocator);
    defer static_flags.deinit();
    try static_flags.appendSlice(&.{
        "-O2", "-Wall",
        "-D_DEFAULT_SOURCE", "-D_XOPEN_SOURCE=600",
        "-DNDTSDB_BUILD_STATIC",
    });
    if (target.result.os.tag == .macos) {
        try static_flags.appendSlice(&.{"-D_DARWIN_C_SOURCE"});
    }

    lib_static.addCSourceFile(.{ .file = b.path("../ndtsdb/native/ndts.c"), .flags = static_flags.items });
    lib_static.addCSourceFile(.{ .file = b.path("../ndtsdb/native/ndtsdb_vec.c"), .flags = static_flags.items });
    lib_static.addIncludePath(b.path("include"));
    lib_static.addIncludePath(b.path("../ndtsdb/native"));
    lib_static.linkLibC();
    lib_static.linkSystemLibrary("m");

    b.installArtifact(lib_static);

    // ============================================
    // CLI Executable: ndtsdb-cli
    // ============================================
    const exe = b.addExecutable(.{
        .name = "ndtsdb-cli",
        .root_source_file = null,
        .target = target,
        .optimize = optimize,
    });

    // C 编译标志
    var c_flags = std.ArrayList([]const u8).init(b.allocator);
    defer c_flags.deinit();
    try c_flags.appendSlice(&.{
        "-O2", "-Wall",
        "-D_DEFAULT_SOURCE", "-D_XOPEN_SOURCE=600",
        "-DCONFIG_VERSION=\"2024-01-13\"",
    });
    if (target.result.os.tag == .macos) {
        try c_flags.appendSlice(&.{"-D_DARWIN_C_SOURCE"});
    }

    // QuickJS 标志
    var qjs_flags = std.ArrayList([]const u8).init(b.allocator);
    defer qjs_flags.deinit();
    try qjs_flags.appendSlice(&.{
        "-O2", "-Wall",
        "-D_DEFAULT_SOURCE", "-D_XOPEN_SOURCE=600",
        "-DCONFIG_VERSION=\"2024-01-13\"",
        "-D_GNU_SOURCE",
    });
    if (target.result.os.tag == .macos) {
        try qjs_flags.appendSlice(&.{"-D_DARWIN_C_SOURCE"});
    }
    if (target.result.os.tag == .windows) {
        try qjs_flags.appendSlice(&.{"-DCONFIG_DISABLE_PTHREAD"});
    }

    // 源文件
    exe.addCSourceFile(.{ .file = b.path("src/main.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/common.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_indicators.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_io.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_query.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_sql.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_script.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_serve.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_plugin.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_embed.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_search.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_facts.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/cmd_facts_enhancements.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/ndtsdb_lock.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("src/bindings/qjs_ndtsdb.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("../ndtsdb/native/ndts.c"), .flags = c_flags.items });
    exe.addCSourceFile(.{ .file = b.path("../ndtsdb/native/ndtsdb_vec.c"), .flags = c_flags.items });
    
    // QuickJS 源文件
    exe.addCSourceFile(.{ .file = b.path("vendor/quickjs-2024-01-13/quickjs.c"), .flags = qjs_flags.items });
    exe.addCSourceFile(.{ .file = b.path("vendor/quickjs-2024-01-13/libregexp.c"), .flags = qjs_flags.items });
    exe.addCSourceFile(.{ .file = b.path("vendor/quickjs-2024-01-13/libunicode.c"), .flags = qjs_flags.items });
    exe.addCSourceFile(.{ .file = b.path("vendor/quickjs-2024-01-13/cutils.c"), .flags = qjs_flags.items });
    exe.addCSourceFile(.{ .file = b.path("vendor/quickjs-2024-01-13/libbf.c"), .flags = qjs_flags.items });

    // 包含路径
    exe.addIncludePath(b.path("include"));
    exe.addIncludePath(b.path("src/bindings"));
    exe.addIncludePath(b.path("../ndtsdb/native"));
    exe.addIncludePath(b.path("vendor/quickjs-2024-01-13"));

    // 链接库
    exe.linkLibC();
    exe.linkSystemLibrary("m");

    const os_tag = target.result.os.tag;
    if (enable_readline and os_tag == .linux) {
        exe.linkSystemLibrary("readline");
        exe.linkSystemLibrary("ncurses");
        exe.root_module.addCMacro("HAVE_READLINE", "1");
    }

    b.installArtifact(exe);

    // ============================================
    // Test: dlopen 验证程序
    // ============================================
    const test_dlopen = b.addExecutable(.{
        .name = "test_dlopen",
        .root_source_file = null,
        .target = target,
        .optimize = optimize,
    });
    test_dlopen.addCSourceFile(.{ .file = b.path("tests/test_dlopen.c"), .flags = c_flags.items });
    test_dlopen.addIncludePath(b.path("include"));
    test_dlopen.linkLibC();
    test_dlopen.linkSystemLibrary("dl");
    b.installArtifact(test_dlopen);

    // ============================================
    // Build Steps
    // ============================================
    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| { run_cmd.addArgs(args); }
    const run_step = b.step("run", "Run ndtsdb-cli");
    run_step.dependOn(&run_cmd.step);

    const test_step = b.step("test-dlopen", "Run dlopen test");
    test_step.dependOn(b.getInstallStep());
    const run_dlopen_test = b.addRunArtifact(test_dlopen);
    test_step.dependOn(&run_dlopen_test.step);

    const lib_shared_step = b.step("lib-shared", "Build shared library only");
    lib_shared_step.dependOn(b.getInstallStep());

    const lib_static_step = b.step("lib-static", "Build static library only");
    lib_static_step.dependOn(b.getInstallStep());

    const lib_step = b.step("lib", "Build both static and shared libraries");
    lib_step.dependOn(lib_static_step);
    lib_step.dependOn(lib_shared_step);
}
