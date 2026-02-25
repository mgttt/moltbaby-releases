// stdlib/console.js - QuickJS 控制台输出封装
// 提供 console.log/warn/error 支持

const { __stdout, __stderr } = globalThis;

function formatValue(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'object') {
        try {
            return JSON.stringify(v);
        } catch {
            return '[Object]';
        }
    }
    return String(v);
}

function formatArgs(args) {
    return args.map(formatValue).join(' ');
}

export const console = {
    log(...args) {
        const line = formatArgs(args);
        if (typeof __stdout === 'function') {
            __stdout(line + '\n');
        } else if (typeof std !== 'undefined' && std.out) {
            std.out.puts(line + '\n');
        } else {
            // 备用：使用 puts
            if (typeof puts === 'function') {
                puts(line);
            }
        }
    },

    warn(...args) {
        const line = formatArgs(args);
        if (typeof __stderr === 'function') {
            __stderr(line + '\n');
        } else if (typeof std !== 'undefined' && std.err) {
            std.err.puts(line + '\n');
        } else {
            this.log('[WARN]', ...args);
        }
    },

    error(...args) {
        const line = formatArgs(args);
        if (typeof __stderr === 'function') {
            __stderr(line + '\n');
        } else if (typeof std !== 'undefined' && std.err) {
            std.err.puts(line + '\n');
        } else {
            this.log('[ERROR]', ...args);
        }
    },

    // 简单断言
    assert(cond, message = 'Assertion failed') {
        if (!cond) {
            this.error('Assertion failed:', message);
            throw new Error(message);
        }
    }
};

// 兼容：如果 globalThis.console 不存在则设置
if (!globalThis.console) {
    globalThis.console = console;
}

export default console;
