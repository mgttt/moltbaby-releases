// stdlib/fs.js - QuickJS 文件系统封装
// 提供基础的文件读写功能

// 异步/基础版本（通过 C 层函数）
export function readFile(path, encoding = 'utf8') {
    if (typeof __readFile === 'function') {
        return __readFile(path, encoding);
    }
    throw new Error('readFile not implemented in this runtime');
}

export function writeFile(path, data, encoding = 'utf8') {
    if (typeof __writeFile === 'function') {
        return __writeFile(path, data, encoding);
    }
    throw new Error('writeFile not implemented in this runtime');
}

export function exists(path) {
    if (typeof __fileExists === 'function') {
        return __fileExists(path);
    }
    throw new Error('exists not implemented in this runtime');
}

// Sync 版本（Node.js 风格，同步操作）
export function readFileSync(path, options = {}) {
    const encoding = typeof options === 'string' ? options : (options.encoding || 'utf8');
    if (typeof __readFile === 'function') {
        return __readFile(path, encoding);
    }
    throw new Error('readFileSync not implemented in this runtime');
}

export function writeFileSync(path, data, options = {}) {
    const encoding = typeof options === 'string' ? options : (options.encoding || 'utf8');
    if (typeof __writeFile === 'function') {
        return __writeFile(path, data, encoding);
    }
    throw new Error('writeFileSync not implemented in this runtime');
}

export function existsSync(path) {
    if (typeof __fileExists === 'function') {
        return __fileExists(path);
    }
    throw new Error('existsSync not implemented in this runtime');
}

// 额外实用函数
export function removeSync(path) {
    if (typeof __removeFile === 'function') {
        return __removeFile(path);
    }
    throw new Error('removeSync not implemented in this runtime');
}

export default {
    readFile,
    writeFile,
    exists,
    readFileSync,
    writeFileSync,
    existsSync,
    removeSync
};
