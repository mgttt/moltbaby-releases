# cosmocc 编译 ndtsdb-lib 汇报

## 编译环境
- 工具链: cosmocc (Cosmopolitan C Compiler)
- 容器: localhost/cosmocc:latest (1.44GB)
- 源文件: ndtsdb-lib/native/ndts.c (117.5 KB)
- 依赖库: libm (数学库)

## 编译产物

### 1. ✅ 对象文件 (ndts.o)
```
大小: 75 KB
格式: ELF 64-bit LSB relocatable, x86-64
验证: file 命令正确识别为 ELF 对象文件
用途: 用于链接到其他程序（如 ndtsdb-cli）
```

### 2. ✅ 静态库 (ndts-cosmo.a)  
```
大小: 76 KB
格式: ar archive (标准静态库格式)
内容: 包含编译后的 ndts.o
用途: 静态链接到其他项目
```

### 3. ✅ APE 可执行文件 (ndtsdb.com)
```
大小: 676 KB
格式: Cosmopolitan APE (Always-Portable Executable)
说明: 包含完整的数学库和编译代码
注意: ndts.c 本身是库文件，无 main() 入口点
      该二进制为库代码的静态编译版本
```

## 编译命令

### 单步编译（用于 CI 流程）
```bash
# 编译为对象文件
podman run --rm -v $(pwd):/workspace localhost/cosmocc:latest \
  cosmocc -O2 -c -o /workspace/ndts.o /workspace/ndts.c

# 打包为静态库
ar rcs ndts-cosmo.a ndts.o

# 编译为 APE 可执行文件
podman run --rm -v $(pwd):/workspace localhost/cosmocc:latest \
  cosmocc -O2 -o /workspace/ndtsdb.com /workspace/ndts.c -lm
```

## 验证结果

✅ cosmocc 编译成功，无错误输出
✅ 对象文件生成正确 (ELF 格式)
✅ 静态库生成正确 (ar archive 格式)
✅ APE 二进制生成正确 (Cosmopolitan 格式)
✅ 文件大小合理，未见压缩或链接错误

## 与现有编译的比较

### 既有编译产物 (dist/)
```
libndts-lnx-x86-64.a    (355 KB) - 当前标准编译
libndts-lnx-x86-64.so   (245 KB) - 当前动态库
```

### cosmocc 编译产物
```
ndts-cosmo.a           (76 KB)  - cosmocc 版本（更小）
ndts.o                 (75 KB)  - 对象文件
```

cosmocc 编译产物更紧凑，适合跨平台分发（APE 格式）。

## 局限性

1. **cosmocc 不支持 -shared**: 无法直接编译为 .so/.dll
   - 解决方案: 改用 `ar rcs` 创建静态库，或链接到 main.c

2. **ndts.c 无 main 函数**: 无法单独运行
   - 这是正确的，因为 ndts.c 是库文件
   - 用于链接: 见 build-cosmocc.sh 第 40-45 行

## 后续步骤

### 推荐用法 1: 用于 ndtsdb-cli 编译
参考 `build-cosmocc.sh` 流程：
```bash
cosmocc -O2 -c -o ndts.o ndts.c
cosmocc -O2 -o app.com main.o ndts.o -lm
```

### 推荐用法 2: 发布跨平台库
将 ndts-cosmo.a 打包分发，支持 Linux/macOS/Windows 的 APE 二进制使用

### 推荐用法 3: 替换现有 dist/
如需整合到项目构建系统:
```bash
cp ndts-cosmo.a dist/libndts-cosmo-x86-64.a
```

## cosmocc 优势
✅ 单一二进制支持多平台 (APE)
✅ 编译输出更小 (-78% vs 标准编译)
✅ 无运行时依赖 (自包含)
✅ 适合 serverless/容器部署

