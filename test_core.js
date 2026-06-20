"use strict";

const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("app.js", "utf8");
const coreSource = source.slice(0, source.indexOf("function switchView"));
const harness = `${coreSource}
  state = {
    version: 2,
    settings: normalizeSettings({
      intervals: { 1: 2, 2: 3, 3: 6, 4: 10, 5: 30 },
      dailyLimit: 12,
      answerMode: "forgiving",
      prioritizeMistakes: true
    }),
    words: [
      normalizeWord({ english: "resilient", chinese: "有韧性的", level: 1, nextReview: localISO(), wrongCount: 3 }),
      normalizeWord({ english: "ice cream", chinese: "冰淇淋", aliases: ["ice-cream"], level: 2, nextReview: localISO(), wrongCount: 1 }),
      normalizeWord({ english: "concise", chinese: "简洁的", level: 4, nextReview: addDays(localISO(), 3) })
    ]
  };
  if (intervalForLevel(1) !== 2 || intervalForLevel(5) !== 30) throw new Error("custom intervals failed");
  if (addDays("2026-06-18", 15) !== "2026-07-03") throw new Error("date scheduling failed");
  if (dueWords().length !== 2 || dueWords()[0].english !== "resilient") throw new Error("mistake priority failed");
  if (!answersMatch(" ICE-CREAM ", state.words[1])) throw new Error("forgiving alias match failed");
  const migrated = normalizeWord({ english: "legacy", chinese: "旧数据" });
  if (!Array.isArray(migrated.aliases) || migrated.correctCount !== 0) throw new Error("legacy migration failed");
  console.log("core tests passed");
`;

const memory = new Map();
const context = {
  console,
  Date,
  Intl,
  Blob,
  URL,
  setTimeout,
  clearTimeout,
  crypto: require("crypto").webcrypto,
  localStorage: {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  },
  document: {},
  globalThis: {},
};
context.globalThis.crypto = context.crypto;
vm.runInNewContext(harness, context);
