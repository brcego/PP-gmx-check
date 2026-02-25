import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { readAccounts, writeAccounts } from "./check-gmx.js";

describe("readAccounts", () => {
  it("parses CSV with header row", async () => {
    const tmpFile = "test-accounts-read.csv";
    await fs.writeFile(tmpFile, "email,password,status\na@gmx.com,pass1,\nb@gmx.com,pass2,Active\n");
    const accounts = await readAccounts(tmpFile);
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].email, "a@gmx.com");
    assert.equal(accounts[0].password, "pass1");
    assert.equal(accounts[0].status, "");
    assert.equal(accounts[1].status, "Active");
    await fs.unlink(tmpFile);
  });

  it("returns empty array for missing file", async () => {
    const accounts = await readAccounts("nonexistent.csv");
    assert.equal(accounts.length, 0);
  });

  it("skips empty lines", async () => {
    const tmpFile = "test-accounts-empty.csv";
    await fs.writeFile(tmpFile, "email,password,status\na@gmx.com,pass1,\n\n\nb@gmx.com,pass2,\n");
    const accounts = await readAccounts(tmpFile);
    assert.equal(accounts.length, 2);
    await fs.unlink(tmpFile);
  });
});

describe("writeAccounts", () => {
  it("writes accounts back to CSV with header", async () => {
    const tmpFile = "test-accounts-write.csv";
    const accounts = [
      { email: "a@gmx.com", password: "pass1", status: "Account Active" },
      { email: "b@gmx.com", password: "pass2", status: "Banned" },
    ];
    await writeAccounts(tmpFile, accounts);
    const content = await fs.readFile(tmpFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    assert.equal(lines[0], "email,password,status");
    assert.equal(lines[1], "a@gmx.com,pass1,Account Active");
    assert.equal(lines[2], "b@gmx.com,pass2,Banned");
    await fs.unlink(tmpFile);
  });
});
