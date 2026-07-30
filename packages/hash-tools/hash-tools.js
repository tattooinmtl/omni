// Omni extension: cryptographic hashes for strings and files.
// Contract: export default { name, tools: [...], impl: { toolName: fn } }

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ALGOS = ["md5", "sha1", "sha256", "sha512"];
const resolve = (p) => path.resolve(process.cwd(), p);

export default {
  name: "hash-tools",
  tools: [
    {
      type: "function",
      function: {
        name: "hash_text",
        description: "Hash a string and return the hex digest.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            algorithm: { type: "string", description: `One of ${ALGOS.join(", ")} (default sha256)` },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "hash_file",
        description: "Hash a file's contents and return the hex digest.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            algorithm: { type: "string", description: `One of ${ALGOS.join(", ")} (default sha256)` },
          },
          required: ["path"],
        },
      },
    },
  ],
  impl: {
    hash_text({ text, algorithm = "sha256" }) {
      if (!ALGOS.includes(algorithm)) throw new Error(`unsupported algorithm: ${algorithm}`);
      return `${algorithm}: ${createHash(algorithm).update(text ?? "").digest("hex")}`;
    },
    hash_file({ path: p, algorithm = "sha256" }) {
      if (!ALGOS.includes(algorithm)) throw new Error(`unsupported algorithm: ${algorithm}`);
      const full = resolve(p);
      if (!fs.existsSync(full)) throw new Error(`file not found: ${p}`);
      return `${algorithm}: ${createHash(algorithm).update(fs.readFileSync(full)).digest("hex")}`;
    },
  },
};
