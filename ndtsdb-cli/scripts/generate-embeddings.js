#!/usr/bin/env bun
/**
 * scripts/generate-embeddings.js - 为 facts 生成 embedding 并写入 ndtsdb
 *
 * 用法:
 *   bun scripts/generate-embeddings.js --db /path/to/db --api-key $GEMINI_API_KEY --facts-dir memory/facts
 *   bun scripts/generate-embeddings.js --db ./knowledge --api-key $GEMINI_API_KEY --facts-dir memory/facts --dry-run
 */

import { parseArgs } from "util";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";

// Gemini Embedding API 配置
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

// 解析命令行参数
function parseCliArgs() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      db: { type: "string", short: "d" },
      "api-key": { type: "string", short: "k" },
      "facts-dir": { type: "string", short: "f", default: "memory/facts" },
      "dry-run": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      port: { type: "string", short: "p", default: "9099" },
      batch: { type: "string", short: "b", default: "5" },
      dims: { type: "string", default: "256" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: bun scripts/generate-embeddings.js [options]

Options:
  --db, -d          Database directory path (required)
  --api-key, -k     Gemini API key (required)
  --facts-dir, -f   Facts directory (default: memory/facts)
  --port, -p        ndtsdb-cli serve port (default: 9099)
  --batch, -b       Batch size for API calls (default: 5)
  --dims            Embedding dimensions: 256/768/3072 (default: 256)
  --dry-run         Preview without calling API or writing
  --verbose, -v     Verbose output
  --help, -h        Show this help

Prerequisites:
  - ndtsdb-cli serve must be running on the specified port
  - GEMINI_API_KEY must be set

Example:
  bun scripts/generate-embeddings.js --db ./knowledge --api-key $GEMINI_API_KEY
`);
    process.exit(0);
  }

  if (!values.db) {
    console.error("Error: --db is required");
    process.exit(1);
  }

  if (!values["api-key"] && !values["dry-run"]) {
    console.error("Error: --api-key is required (unless --dry-run)");
    process.exit(1);
  }

  return {
    db: values.db,
    apiKey: values["api-key"] || "",
    factsDir: values["facts-dir"],
    dryRun: values["dry-run"] || false,
    verbose: values.verbose || false,
    port: parseInt(values.port),
    batchSize: parseInt(values.batch),
    dims: parseInt(values.dims),
  };
}

// 调用 Gemini Embedding API
async function generateEmbedding(text, apiKey, dims = 256) {
  const url = `${GEMINI_API_URL}?key=${apiKey}`;
  
  const body = {
    content: {
      parts: [{ text }]
    },
    outputDimensionality: dims
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  
  if (!data.embedding || !data.embedding.values) {
    throw new Error("Invalid response from Gemini API: missing embedding.values");
  }

  return data.embedding.values;
}

// 解析单个 facts 文件
function parseFactsFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const facts = [];

  const lines = content.split("\n");
  let i = 0;
  const filename = basename(filePath, ".md");

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith("<!--") || trimmed.startsWith("# ")) {
      i++;
      continue;
    }

    // 新格式: ### [date] type|validity|certainty
    const newFormatMatch = trimmed.match(
      /^###\s*\[(\d{4}-\d{2}-\d{2})\]\s*(\w+)\|(\w+)\|(\w+)/i
    );

    if (newFormatMatch) {
      const date = newFormatMatch[1];
      const type = newFormatMatch[2];
      const validity = newFormatMatch[3];
      const certainty = newFormatMatch[4];
      let key = undefined;
      const textLines = [];

      i++;

      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();

        // 遇到新的 section 或文件结束
        if (
          nextTrimmed.startsWith("### [") ||
          (nextTrimmed.startsWith("[") &&
            nextTrimmed.includes("] [") &&
            /\[\d{4}-\d{2}-\d{2}\]/.test(nextTrimmed))
        ) {
          break;
        }

        // key: xxx 行
        const keyMatch = nextLine.match(/^key:\s*(.+)$/i);
        if (keyMatch && textLines.length === 0) {
          key = keyMatch[1].trim();
          i++;
          continue;
        }

        // 普通 text 行
        if (nextTrimmed) {
          textLines.push(nextTrimmed);
        }
        i++;
      }

      const fullText = textLines.join(" ");
      if (fullText || key) {
        facts.push({
          date,
          type: type.toLowerCase(),
          validity: validity.toLowerCase(),
          certainty: certainty.toLowerCase(),
          key,
          text: fullText,
          filename,
        });
      }
      continue;
    }

    // 旧格式: [date] [type|validity|certainty] key=K text
    const oldFormatMatch = trimmed.match(
      /^\[(\d{4}-\d{2}-\d{2})\]\s+\[(\w+)\|(\w+)\|(\w+)\]\s*(?:key=([^\s]+))?\s*(.*)$/i
    );

    if (oldFormatMatch) {
      const date = oldFormatMatch[1];
      const type = oldFormatMatch[2];
      const validity = oldFormatMatch[3];
      const certainty = oldFormatMatch[4];
      const key = oldFormatMatch[5];
      const text = oldFormatMatch[6];

      facts.push({
        date,
        type: type.toLowerCase(),
        validity: validity.toLowerCase(),
        certainty: certainty.toLowerCase(),
        key,
        text: text?.trim() || "",
        filename,
      });
      i++;
      continue;
    }

    i++;
  }

  return facts;
}

// 生成知识记录 JSON（带 embedding）
async function factToVectorRecord(fact, apiKey, dryRun, verbose, dims = 256) {
  // timestamp: 从 date 解析（毫秒）
  const date = new Date(fact.date);
  const timestamp = date.getTime();

  // agent_id: 从 filename 解析 (bot-xxx 或 shared/antipattern)
  let agentId = fact.filename;
  if (agentId === "shared") agentId = "shared";
  else if (agentId === "antipattern") agentId = "antipattern";

  // type: semantic/episodic/procedural
  const type = fact.type || "semantic";

  // confidence: 从 certainty 映射
  const certaintyMap = {
    observed: 0.9,
    inferred: 0.7,
    asserted: 0.8,
  };
  const confidence = certaintyMap[fact.certainty] || 0.5;

  // content: 组合 key 和 text
  const content = fact.key ? `[${fact.key}] ${fact.text}` : fact.text;

  // 生成 embedding
  let embedding = [];
  if (content) {
    if (dryRun) {
      // 模拟生成
      embedding = Array(dims).fill(0).map(() => (Math.random() - 0.5) * 2);
      if (verbose) {
        console.log(`  [DRY-RUN] Generated embedding (${embedding.length} dims) for: ${content.slice(0, 50)}...`);
      }
    } else {
      try {
        embedding = await generateEmbedding(content, apiKey, dims);
        if (verbose) {
          console.log(`  Generated embedding (${embedding.length} dims) for: ${content.slice(0, 50)}...`);
        }
      } catch (err) {
        console.error(`  Failed to generate embedding: ${err.message}`);
        throw err;
      }
    }
  }

  return {
    timestamp,
    agent_id: agentId,
    type,
    confidence,
    embedding,
    content,
    references: [],
    access_count: 0,
    decay_rate: 0.01,
  };
}

// 写入向量记录到 ndtsdb
async function writeVectorToNdtsdb(port, record) {
  const response = await fetch(`http://localhost:${port}/write-vector`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  
  if (!response.ok) {
    console.error(`Failed to write vector: ${response.status}`);
    return false;
  }
  
  const result = await response.json();
  return result.inserted > 0 || result.errors === 0;
}

// 主函数
async function main() {
  const args = parseCliArgs();

  console.log(`Generate embeddings and import to ndtsdb`);
  console.log(`  Database: ${args.db}`);
  console.log(`  Facts dir: ${args.factsDir}`);
  console.log(`  Port: ${args.port}`);
  console.log(`  Batch size: ${args.batchSize}`);
  console.log(`  Dimensions: ${args.dims}`);
  if (args.dryRun) console.log(`  Mode: DRY-RUN`);
  console.log();

  // 检查 facts 目录
  if (!existsSync(args.factsDir)) {
    console.error(`Error: Facts directory not found: ${args.factsDir}`);
    process.exit(1);
  }

  // 查找所有 .md 文件
  const files = readdirSync(args.factsDir).filter(f => f.endsWith(".md"));

  console.log(`Found ${files.length} fact files:`);
  console.log(files.map((f) => `  - ${f}`).join("\n"));
  console.log();

  let totalFacts = 0;
  let importedFacts = 0;
  let failedFacts = 0;

  for (const file of files) {
    const filePath = join(args.factsDir, file);
    console.log(`Processing ${file}...`);

    const facts = parseFactsFile(filePath);
    console.log(`  Found ${facts.length} facts`);

    if (facts.length === 0) {
      console.log(`  Skipping ${file} (no records)`);
      continue;
    }

    // 批量处理
    for (let i = 0; i < facts.length; i += args.batchSize) {
      const batch = facts.slice(i, i + args.batchSize);
      
      if (args.verbose) {
        console.log(`  Processing batch ${Math.floor(i / args.batchSize) + 1}/${Math.ceil(facts.length / args.batchSize)}...`);
      }

      for (const fact of batch) {
        try {
          const record = await factToVectorRecord(fact, args.apiKey, args.dryRun, args.verbose, args.dims);
          
          if (args.verbose) {
            console.log(`  - ${record.agent_id}/${record.type}: ${record.content.slice(0, 50)}...`);
          }

          if (!args.dryRun) {
            const success = await writeVectorToNdtsdb(args.port, record);
            if (success) {
              importedFacts++;
              if (args.verbose) console.log(`    ✓ Written to ndtsdb`);
            } else {
              failedFacts++;
              console.error(`    ✗ Failed to write to ndtsdb`);
            }
          } else {
            importedFacts++;
          }
        } catch (err) {
          console.error(`  Error processing fact: ${err.message}`);
          failedFacts++;
        }
      }
    }

    totalFacts += facts.length;
  }

  console.log();
  console.log("================================");
  console.log(`Total facts: ${totalFacts}`);
  console.log(`Imported: ${importedFacts}`);
  console.log(`Failed: ${failedFacts}`);
  console.log("================================");

  process.exit(failedFacts > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
