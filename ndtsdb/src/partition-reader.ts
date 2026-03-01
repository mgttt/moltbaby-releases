// ============================================================
// NDTS Partition File Reader - Direct binary format parsing
// ============================================================
// Reads compressed NDTS partition files directly from disk
// Implements delta and gorilla decompression algorithms

import { readFileSync } from 'fs';

const HEADER_BLOCK_SIZE = 4096;

export interface NdtsReadResult {
  header: {
    totalRows: number;
    columns?: any[];
  };
  data: Map<string, any>;
}

/**
 * Decompression algorithms for NDTS
 */
namespace Decompression {
  /**
   * Delta decode for integers - each value is the difference from previous
   * Formula: actual[i] = base + sum(deltas[0..i])
   */
  export function deltaDecodeInt32(compressed: Int32Array): Int32Array {
    if (compressed.length === 0) return new Int32Array(0);

    const result = new Int32Array(compressed.length);
    let base = compressed[0];
    result[0] = base;

    for (let i = 1; i < compressed.length; i++) {
      base = (base + compressed[i]) | 0;
      result[i] = base;
    }

    return result;
  }

  export function deltaDecodeInt64(compressed: BigInt64Array): BigInt64Array {
    if (compressed.length === 0) return new BigInt64Array(0);

    const result = new BigInt64Array(compressed.length);
    let base = compressed[0];
    result[0] = base;

    for (let i = 1; i < compressed.length; i++) {
      base = base + compressed[i];
      result[i] = base;
    }

    return result;
  }

  /**
   * Gorilla decompress for floats
   * Format: [leading zeros (5 bits), significant bits (6 bits), value bits]
   */
  export function gorillaDecompressF64(
    compressedBytes: Uint8Array,
    count: number
  ): Float64Array {
    const result = new Float64Array(count);
    let bytePos = 0;
    let bitPos = 0;

    // First value is stored uncompressed
    if (count === 0) return result;

    const firstBytes = compressedBytes.subarray(0, 8);
    result[0] = new Float64Array(firstBytes.buffer, 0, 1)[0];
    bytePos = 8;
    bitPos = 0;

    let prevLeadingZeros = 0;
    let prevTrailingZeros = 0;
    let prevValue = result[0];

    for (let i = 1; i < count; i++) {
      // Read control bits
      let controlBits = 0;
      for (let j = 0; j < 2; j++) {
        const byte = compressedBytes[bytePos];
        controlBits = (controlBits << 1) | ((byte >> (7 - bitPos)) & 1);
        bitPos++;
        if (bitPos === 8) {
          bitPos = 0;
          bytePos++;
        }
      }

      let leadingZeros = prevLeadingZeros;
      let trailingZeros = prevTrailingZeros;
      let significantBits = 64 - prevLeadingZeros - prevTrailingZeros;

      if (controlBits === 0) {
        // Value is same as previous
        result[i] = prevValue;
      } else if (controlBits === 1) {
        // Leading zeros and trailing zeros are the same
        // Read only the significant bits
        let value = 0;
        for (let j = 0; j < significantBits; j++) {
          const byte = compressedBytes[bytePos];
          value = (value << 1) | ((byte >> (7 - bitPos)) & 1);
          bitPos++;
          if (bitPos === 8) {
            bitPos = 0;
            bytePos++;
          }
        }

        // Shift to correct position
        value = value << trailingZeros;
        const longVal = value | (new DataView(new Float64Array([prevValue]).buffer).getBigInt64(0, true) & ((1n << BigInt(trailingZeros)) - 1n));
        result[i] = new Float64Array(new BigInt64Array([longVal]).buffer)[0];
      } else if (controlBits === 2) {
        // Different trailing zeros
        trailingZeros = 0;
        for (let j = 0; j < 5; j++) {
          const byte = compressedBytes[bytePos];
          trailingZeros = (trailingZeros << 1) | ((byte >> (7 - bitPos)) & 1);
          bitPos++;
          if (bitPos === 8) {
            bitPos = 0;
            bytePos++;
          }
        }

        significantBits = 64 - leadingZeros - trailingZeros;

        let value = 0;
        for (let j = 0; j < significantBits; j++) {
          const byte = compressedBytes[bytePos];
          value = (value << 1) | ((byte >> (7 - bitPos)) & 1);
          bitPos++;
          if (bitPos === 8) {
            bitPos = 0;
            bytePos++;
          }
        }

        value = value << trailingZeros;
        const longVal = value | (new DataView(new Float64Array([prevValue]).buffer).getBigInt64(0, true) & ((1n << BigInt(trailingZeros)) - 1n));
        result[i] = new Float64Array(new BigInt64Array([longVal]).buffer)[0];

        prevTrailingZeros = trailingZeros;
      } else {
        // controlBits === 3: completely different value
        leadingZeros = 0;
        for (let j = 0; j < 5; j++) {
          const byte = compressedBytes[bytePos];
          leadingZeros = (leadingZeros << 1) | ((byte >> (7 - bitPos)) & 1);
          bitPos++;
          if (bitPos === 8) {
            bitPos = 0;
            bytePos++;
          }
        }

        trailingZeros = 0;
        for (let j = 0; j < 6; j++) {
          const byte = compressedBytes[bytePos];
          trailingZeros = (trailingZeros << 1) | ((byte >> (7 - bitPos)) & 1);
          bitPos++;
          if (bitPos === 8) {
            bitPos = 0;
            bytePos++;
          }
        }

        significantBits = 64 - leadingZeros - trailingZeros;

        let value = 0;
        for (let j = 0; j < significantBits; j++) {
          const byte = compressedBytes[bytePos];
          value = (value << 1) | ((byte >> (7 - bitPos)) & 1);
          bitPos++;
          if (bitPos === 8) {
            bitPos = 0;
            bytePos++;
          }
        }

        value = value << trailingZeros;
        const longVal = BigInt(value);
        result[i] = new Float64Array(new BigInt64Array([longVal]).buffer)[0];

        prevLeadingZeros = leadingZeros;
        prevTrailingZeros = trailingZeros;
      }

      prevValue = result[i];
    }

    return result;
  }

  /**
   * Simple RLE (Run-Length Encoding) decompression
   * Format: [value, count, value, count, ...]
   */
  export function rleDecompress(compressed: Uint8Array, type: string): any {
    // RLE not commonly used, placeholder
    return new Float64Array(0);
  }
}

/**
 * Read and decompress NDTS partition file
 */
export function readNdtsPartitionFile(filePath: string): NdtsReadResult {
  try {
    const buf = readFileSync(filePath);

    // Parse header
    if (buf.length < HEADER_BLOCK_SIZE) {
      console.warn(`[ndts-reader] File too small: ${buf.length}`);
      return { header: { totalRows: 0 }, data: new Map() };
    }

    const headerBlock = buf.subarray(0, HEADER_BLOCK_SIZE);
    const magic = headerBlock.subarray(0, 4).toString('utf-8');

    if (magic !== 'NDTS') {
      console.warn(`[ndts-reader] Invalid magic: ${magic}`);
      return { header: { totalRows: 0 }, data: new Map() };
    }

    // Read header JSON
    const headerLen = headerBlock.readUInt32LE(4);
    const jsonStr = headerBlock.subarray(8, 8 + headerLen).toString('utf-8');
    let headerJson: any = {};

    try {
      headerJson = JSON.parse(jsonStr);
    } catch (e) {
      console.warn('[ndts-reader] Failed to parse header JSON:', e);
      return { header: { totalRows: 0 }, data: new Map() };
    }

    console.log(
      `[ndts-reader] Reading ${filePath}: ${headerJson.totalRows || 0} rows`
    );

    if (!headerJson.totalRows || headerJson.totalRows === 0) {
      return { header: { totalRows: 0 }, data: new Map() };
    }

    const totalRows = headerJson.totalRows;
    const columns: any[] = headerJson.columns || [];
    const compressionConfig: Record<string, string> = headerJson.compression || {};

    // Skip header CRC (4 bytes after header)
    let offset = HEADER_BLOCK_SIZE + 4;

    // Read data chunks
    const columnData = new Map<string, any>();

    // Initialize typed arrays for each column
    for (const col of columns) {
      if (col.type === 'int32') {
        columnData.set(col.name, new Int32Array(totalRows));
      } else if (col.type === 'int64') {
        columnData.set(col.name, new BigInt64Array(totalRows));
      } else if (col.type === 'float64') {
        columnData.set(col.name, new Float64Array(totalRows));
      }
    }

    let rowIndex = 0;

    // Read data blocks
    while (offset < buf.length && rowIndex < totalRows) {
      if (offset + 4 > buf.length) {
        console.log(`[ndts-reader] Reached EOF, stopping at rowIndex=${rowIndex}, offset=${offset}, buf.length=${buf.length}`);
        break;
      }

      // Read chunk header
      const chunkType = buf.readUInt8(offset);
      offset += 1;

      if (chunkType === 0) {
        console.log(`[ndts-reader] Found end marker at offset ${offset}, rowIndex=${rowIndex}`);
        break; // End marker
      }

      const chunkRowCount = buf.readUInt32LE(offset);
      offset += 4;

      if (chunkRowCount === 0 || chunkRowCount > 100000) {
        console.log(`[ndts-reader] Invalid chunkRowCount=${chunkRowCount}, breaking`);
        break;
      }

      console.log(
        `[ndts-reader] Reading chunk: ${chunkRowCount} rows at offset ${offset}`
      );

      // Read each column's compressed data
      for (const col of columns) {
        if (rowIndex + chunkRowCount > totalRows) break;

        // Read column metadata
        if (offset + 8 > buf.length) break;

        const compressType = buf.readUInt8(offset);
        offset += 1;

        const compressedSize = buf.readUInt32LE(offset);
        offset += 4;

        const checksum = buf.readUInt16LE(offset);
        offset += 2;

        if (offset + compressedSize > buf.length) break;

        const compressedData = buf.subarray(offset, offset + compressedSize);
        offset += compressedSize;

        // Decompress based on type
        const colArray = columnData.get(col.name);
        if (!colArray) continue;

        try {
          if (col.type === 'int32') {
            const compressed = new Int32Array(
              compressedData.buffer,
              compressedData.byteOffset,
              compressedData.length / 4
            );

            if (compressType === 1) {
              // Delta
              const decompressed = Decompression.deltaDecodeInt32(compressed);
              for (let i = 0; i < chunkRowCount; i++) {
                colArray[rowIndex + i] = decompressed[i];
              }
            } else if (compressType === 0) {
              // No compression
              for (let i = 0; i < chunkRowCount; i++) {
                colArray[rowIndex + i] = compressed[i];
              }
            }
          } else if (col.type === 'int64') {
            const compressed = new BigInt64Array(
              compressedData.buffer,
              compressedData.byteOffset,
              compressedData.length / 8
            );

            if (compressType === 1) {
              // Delta
              const decompressed = Decompression.deltaDecodeInt64(compressed);
              for (let i = 0; i < chunkRowCount; i++) {
                colArray[rowIndex + i] = decompressed[i];
              }
            } else if (compressType === 0) {
              // No compression
              for (let i = 0; i < chunkRowCount; i++) {
                colArray[rowIndex + i] = compressed[i];
              }
            }
          } else if (col.type === 'float64') {
            if (compressType === 2) {
              // Gorilla
              const decompressed = Decompression.gorillaDecompressF64(
                compressedData,
                chunkRowCount
              );
              for (let i = 0; i < chunkRowCount; i++) {
                colArray[rowIndex + i] = decompressed[i];
              }
            } else if (compressType === 0) {
              // No compression
              const uncompressed = new Float64Array(
                compressedData.buffer,
                compressedData.byteOffset,
                compressedData.length / 8
              );
              for (let i = 0; i < chunkRowCount; i++) {
                colArray[rowIndex + i] = uncompressed[i];
              }
            }
          }
        } catch (e) {
          console.warn(
            `[ndts-reader] Error decompressing column ${col.name}:`,
            e
          );
          // Continue with next column
        }
      }

      rowIndex += chunkRowCount;
      console.log(`[ndts-reader] Updated rowIndex to ${rowIndex}, offset is now ${offset}`);

      // Skip chunk CRC
      if (offset + 4 <= buf.length) {
        offset += 4;
      }
    }

    console.log(`[ndts-reader] Loop exited, returning rowIndex=${rowIndex}, totalRows from header=${totalRows}`);
    return {
      header: { totalRows: rowIndex, columns },
      data: columnData,
    };
  } catch (err: any) {
    console.warn(`[ndts-reader] Error reading ${filePath}:`, err.message);
    return { header: { totalRows: 0 }, data: new Map() };
  }
}
