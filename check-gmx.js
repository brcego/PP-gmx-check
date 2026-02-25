import { promises as fs } from "node:fs";

// --- CSV Utilities ---

export async function readAccounts(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return data
      .split("\n")
      .slice(1) // skip header
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const parts = line.split(",");
        return {
          email: parts[0]?.trim() || "",
          password: parts[1]?.trim() || "",
          status: parts[2]?.trim() || "",
        };
      });
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`File not found: ${filePath}`);
      return [];
    }
    throw error;
  }
}

export async function writeAccounts(filePath, accounts) {
  const header = "email,password,status";
  const lines = accounts.map((a) => `${a.email},${a.password},${a.status}`);
  await fs.writeFile(filePath, [header, ...lines].join("\n"), "utf-8");
}
